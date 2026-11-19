// ---------------------------------------------------------------------------
// Spike Trends — is a recent stretch unusual?
//   ?start / ?end   the focus window (default: last 90 days)
//   ?baseline=<n>   months before the focus window used as "normal" (default 12)
//   ?min=<n>        smallest count worth flagging (default 3)
//
// For every call category, specific type, road, address, time block and
// member, the focus count is compared with what the baseline rate predicts
// for a window that long. The signal is a variance-stabilised Poisson score,
//   z = 2 * (sqrt(observed) - sqrt(expected))
// which behaves sensibly for small counts: |z| >= 2 is notable, >= 3 strong.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const signal = (obs, exp) => 2 * (Math.sqrt(obs) - Math.sqrt(Math.max(exp, 0)));
const streetOf = a => a.replace(/^[0-9]+\s+/, '');
const normAddr = a => String(a || '').trim().toUpperCase().replace(/\s+/g, ' ');
const BLOCKS = [[0, 5, 'Overnight (midnight–6am)'], [6, 11, 'Morning (6am–noon)'], [12, 17, 'Afternoon (noon–6pm)'], [18, 23, 'Evening (6pm–midnight)']];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const today = K.localToday();
    // Focus window defaults to the last 90 days rather than the kit's year-based default.
    if (!K.isValidDate(req.query.start)) req.query.start = K.addDays(today, -89);
    const range = K.resolveRange(req, report);
    const baselineMonths = Math.min(36, Math.max(1, parseInt(req.query.baseline, 10) || 12));
    const minCount = Math.min(50, Math.max(1, parseInt(req.query.min, 10) || 3));

    let baseStart = K.addMonths(range.start, -baselineMonths);
    if (report.minDate && baseStart < report.minDate) baseStart = report.minDate;
    const baseEnd = K.addDays(range.start, -1);
    const focusDays = K.daysBetween(range.start, range.end);
    const baseDays = baseEnd >= baseStart ? K.daysBetween(baseStart, baseEnd) : 0;

    if (baseDays < 30) {
      return res.send(K.page({ report, token: req.query.token || '', range,
        filters: K.numberInput('baseline', 'Baseline (months)', baselineMonths, { min: 1, max: 36, width: 90 }),
        subtitle: 'Not enough history before this window',
        body: `<p class="empty-msg">The focus window needs at least a month of history before it (data starts ${esc(report.minDate)}). Pick a later start date.</p>` }));
    }

    const [all, roster] = await Promise.all([
      K.incidentsWithResponders(report, baseStart, range.end),
      K.query(report, 'rosterQuery'),
    ]);
    const focus = all.filter(i => i.date >= range.start);
    const base  = all.filter(i => i.date < range.start);
    const scale = focusDays / baseDays;

    // Generic comparison: keyFn returns a key (or array of keys) per incident.
    function compare(dimension, keyFn, { labelFn = k => k } = {}) {
      const fc = new Map(), bc = new Map();
      const add = (m, keys) => [].concat(keys).filter(k => k !== null && k !== undefined && k !== '').forEach(k => m.set(k, (m.get(k) || 0) + 1));
      focus.forEach(i => add(fc, keyFn(i)));
      base.forEach(i => add(bc, keyFn(i)));
      const keys = new Set([...fc.keys(), ...bc.keys()]);
      return [...keys].map(k => {
        const obs = fc.get(k) || 0, b = bc.get(k) || 0, exp = b * scale;
        return { dimension, key: k, label: labelFn(k), obs, base: b, exp, z: signal(obs, exp), ratio: exp > 0 ? obs / exp : null };
      });
    }

    // Specific type names changed when coding moved from NFIRS to NERIS
    // (2025–26), so compare them only among incidents coded the same way as
    // most of the focus window, over the part of the baseline that used it.
    const isNeris = i => !/^\d{3}$/.test(String(i.incident_type || '').trim());
    const focusNeris = focus.filter(isNeris).length >= focus.length / 2;
    const typeFocus = focus.filter(i => isNeris(i) === focusNeris);
    const typeBase = base.filter(i => isNeris(i) === focusNeris);
    const typeBaseDays = typeBase.length ? K.daysBetween(typeBase[0].date, baseEnd) : 0;
    const sameCoding = typeBaseDays >= 60;
    const compareTypes = () => {
      const fc = new Map(), bc = new Map();
      const keyOf = i => String(i.type_desc || '').trim();
      typeFocus.forEach(i => { const k = keyOf(i); if (k) fc.set(k, (fc.get(k) || 0) + 1); });
      typeBase.forEach(i => { const k = keyOf(i); if (k) bc.set(k, (bc.get(k) || 0) + 1); });
      const s = focusDays / typeBaseDays;
      return [...new Set([...fc.keys(), ...bc.keys()])].map(k => {
        const obs = fc.get(k) || 0, b = bc.get(k) || 0, exp = b * s;
        return { dimension: 'Specific call', key: k, label: k, obs, base: b, exp, z: signal(obs, exp), ratio: exp > 0 ? obs / exp : null };
      });
    };

    const dims = {
      category: compare('Call type', i => i.category, { labelFn: k => K.CATEGORY_BY_KEY[k].label }),
      type:     sameCoding ? compareTypes() : [],
      street:   compare('Road', i => i.address ? streetOf(normAddr(i.address)) : null),
      address:  compare('Address', i => i.address ? normAddr(i.address) : null),
      block:    compare('Time of day', i => BLOCKS.find(b => K.hourOf(i.alarm_local) >= b[0] && K.hourOf(i.alarm_local) <= b[1])[2]),
      dow:      compare('Day of week', i => DAYS[K.dayNumOf(i.alarm_local) - 1]),
    };

    // Members: compare their share of department calls, not raw counts, so a
    // busy month for everyone doesn't look like a personal spike. Members who
    // started during the baseline are measured from their start date.
    const nameOf = new Map(roster.map(m => [m.personnel_id, m]));
    const memberRows = [];
    roster.filter(m => m.active).forEach(m => {
      const from = m.start_date && m.start_date > baseStart ? m.start_date : baseStart;
      if (from >= range.start) return;                        // started inside the focus window
      const baseInc = base.filter(i => i.date >= from);
      if (baseInc.length < 20) return;                        // too little history to judge
      const b = baseInc.filter(i => i.members.has(m.personnel_id)).length;
      const obs = focus.filter(i => i.members.has(m.personnel_id)).length;
      const exp = b / baseInc.length * focus.length;
      memberRows.push({ dimension: 'Member', key: m.personnel_id, label: K.shortName(m.name), obs, base: b, exp, z: signal(obs, exp), ratio: exp > 0 ? obs / exp : null,
        focusPct: focus.length ? obs / focus.length * 100 : null, basePct: b / baseInc.length * 100 });
    });

    const total = { obs: focus.length, exp: base.length * scale };
    total.z = signal(total.obs, total.exp);

    const spikes = [...Object.values(dims).flat(), ...memberRows].filter(r => r.z >= 2 && r.obs >= minCount).sort((a, b) => b.z - a.z);
    const drops  = [...Object.values(dims).flat(), ...memberRows].filter(r => r.z <= -2 && r.exp >= minCount).sort((a, b) => a.z - b.z);

    // --- Presentation helpers -------------------------------------------------------------
    const strength = z => Math.abs(z) >= 3 ? 'Strong' : Math.abs(z) >= 2 ? 'Notable' : '';
    const change = r => r.exp > 0 ? `${r.obs >= r.exp ? '+' : '−'}${Math.abs((r.obs / r.exp - 1) * 100).toFixed(0)}%` : 'new';
    const zBar = z => {
      const w = Math.min(100, Math.abs(z) / 5 * 100);
      return `<span class="zb"><span class="${z >= 0 ? 'zup' : 'zdn'}" style="width:${w}%"></span></span> <span class="${z >= 0 ? 'bad' : 'good'}" style="font-weight:600">${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}</span>`;
    };
    const flagRow = r => `<tr><td class="dim">${esc(r.dimension)}</td><th scope="row" style="white-space:normal">${esc(String(r.label))}</th>
      <td class="num strong">${r.obs}</td><td class="num">${K.fmtNum(r.exp)}</td><td class="num">${change(r)}</td>
      <td style="white-space:nowrap" title="${strength(r.z)}">${zBar(r.z)}</td></tr>`;
    const flagHead = ['What', '', { label: 'Now', num: 1 }, { label: 'Expected', num: 1 }, { label: 'Change', num: 1 }, 'Signal'];
    const dimTable = (rows, n = 10, opts = {}) => {
      const shown = (opts.all ? rows.sort((a, b) => b.obs - a.obs) : rows.filter(r => r.obs >= minCount || r.exp >= minCount).sort((a, b) => b.z - a.z)).slice(0, n);
      return K.table({ head: ['', { label: 'Now', num: 1 }, { label: 'Expected', num: 1 }, { label: 'Change', num: 1 }, 'Signal'],
        rows: shown.map(r => `<tr><th scope="row" style="white-space:normal">${esc(String(r.label))}</th><td class="num strong">${r.obs}</td><td class="num">${K.fmtNum(r.exp)}</td><td class="num">${change(r)}</td><td style="white-space:nowrap">${zBar(r.z)}</td></tr>`) });
    };

    // --- Weekly chart -------------------------------------------------------------------------
    const weekStart = d => K.addDays(d, -((K.dayNumOf(`${d} 00`) + 6) % 7));   // Monday
    const weeks = [];
    for (let w = weekStart(baseStart); w <= range.end; w = K.addDays(w, 7)) weeks.push(w);
    const wIdx = new Map(weeks.map((w, i) => [w, i]));
    const wb = new Array(weeks.length).fill(0), wf = new Array(weeks.length).fill(0);
    all.forEach(i => { const k = wIdx.get(weekStart(i.date)); if (k === undefined) return; (i.date >= range.start ? wf : wb)[k]++; });
    const weekly = K.stackedBars({
      labels: weeks.map((w, i) => (i === 0 || w.slice(5, 7) !== weeks[i - 1].slice(5, 7)) ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+w.slice(5, 7) - 1] : ''),
      sublabels: weeks.map((w, i) => (i === 0 || w.slice(0, 4) !== weeks[i - 1].slice(0, 4)) ? w.slice(0, 4) : ''),
      series: [{ name: 'Baseline weeks', color: '#c3cad4', values: wb }, { name: 'Focus window', color: '#1e3a5f', values: wf }],
      totals: false, aria: 'Calls per week', height: 200, width: 1100, every: 1,
    });

    const perDay = n => (n).toFixed(2);
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls in this window', value: K.fmtInt(total.obs), accent: true, sub: [
        `${perDay(total.obs / focusDays)}/day vs ${perDay(base.length / baseDays)}/day normally`,
        `${change({ obs: total.obs, exp: total.exp })} vs expected ${K.fmtInt(total.exp)} ${strength(total.z) ? `— <span class="${total.z > 0 ? 'bad' : 'good'}">${strength(total.z).toLowerCase()} ${total.z > 0 ? 'spike' : 'drop'}</span>` : '— within normal range'}`] })}
      ${K.tile({ title: 'Spikes flagged', value: String(spikes.length), sub: [spikes[0] ? `biggest: ${esc(String(spikes[0].label))} (${spikes[0].obs} vs ${K.fmtNum(spikes[0].exp)} expected)` : 'nothing unusually high'] })}
      ${K.tile({ title: 'Drops flagged', value: String(drops.length), sub: [drops[0] ? `biggest: ${esc(String(drops[0].label))} (${drops[0].obs} vs ${K.fmtNum(drops[0].exp)} expected)` : 'nothing unusually low'] })}
      ${K.tile({ title: 'Compared with', value: `${baselineMonths} mo`, sub: [`${esc(K.fmtDate(baseStart))} – ${esc(K.fmtDate(baseEnd))}`, `${focusDays}-day window vs ${baseDays} days of baseline`] })}
    </div>`;

    const memberTable = K.table({
      head: ['Member', { label: 'Calls now', num: 1 }, { label: 'Share now', num: 1 }, { label: 'Usual share', num: 1 }, { label: 'Expected', num: 1 }, 'Signal'],
      rows: memberRows.filter(r => Math.abs(r.z) >= 1).sort((a, b) => b.z - a.z).map(r => `<tr><th scope="row">${esc(r.label)}</th>
        <td class="num strong">${r.obs}</td><td class="num">${K.fmtPct(r.focusPct)}</td><td class="num dim">${K.fmtPct(r.basePct)}</td><td class="num">${K.fmtNum(r.exp)}</td><td style="white-space:nowrap">${zBar(r.z)}</td></tr>`),
    });

    const css = `
      .zb { display: inline-block; width: 70px; height: 9px; background: #eef0f3; border-radius: 3px; vertical-align: middle; overflow: hidden; }
      .zb span { display: block; height: 100%; }
      .zup { background: #c0392b; } .zdn { background: #1a8a7d; }
      @media print { .zb span { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`;

    const body = `${tiles}
  ${K.card('Calls per week', `${weekly}${K.legend([{ label: 'Baseline', color: '#c3cad4', box: true }, { label: 'Focus window', color: '#1e3a5f', box: true }])}`)}
  <div class="grid2">
    ${K.card('Spikes', spikes.length ? K.table({ head: flagHead, rows: spikes.slice(0, 20).map(flagRow) }) : '<p class="lead" style="padding:4px 16px 14px">Nothing is running unusually high.</p>',
      { lead: `Higher than the baseline predicts, with at least ${minCount} calls.` })}
    ${K.card('Drops', drops.length ? K.table({ head: flagHead, rows: drops.slice(0, 20).map(flagRow) }) : '<p class="lead" style="padding:4px 16px 14px">Nothing is running unusually low.</p>',
      { lead: 'Lower than the baseline predicts.' })}
  </div>
  <div class="grid2">
    ${K.card('By call type', dimTable(dims.category, 10, { all: true }))}
    ${K.card('By time', dimTable([...dims.block, ...dims.dow], 11, { all: true }))}
  </div>
  <div class="grid2">
    ${K.card('Roads', dimTable(dims.street), { lead: 'Highest signal first.' })}
    ${K.card('Addresses', dimTable(dims.address), { lead: 'A repeat-caller or facility shows up here.' })}
  </div>
  ${sameCoding ? K.card('Specific calls', dimTable(dims.type, 12)) : ''}
  ${K.card('Members', memberRows.some(r => Math.abs(r.z) >= 1) ? memberTable : '<p class="lead" style="padding:4px 16px 14px">No member is far from their usual share of calls.</p>',
    { lead: 'Each member’s share of department calls in this window against their own usual share — so a busy month for everyone does not look like a personal spike. Members with a signal of ±1 or more are listed.' })}
  <p class="note"><strong>How to read the signal:</strong> the baseline rate (calls per day over the ${baselineMonths} months before the window) predicts how many calls of each kind to expect in a ${focusDays}-day window.
    The signal measures how far the actual count is from that, on a scale where ±2 is notable and ±3 is strong; with dozens of rows, an occasional ±2 can happen by chance, so look for strong signals or several related ones.
    ${sameCoding ? '' : 'Specific call names are not compared because the baseline uses older NFIRS names and the window uses NERIS names; call types (grouped) are comparable. '}
    Seasonal effects are not removed — a winter window compared with a mostly-summer baseline will show cold-weather calls as spikes. Addresses are matched as entered.</p>`;

    const filters = `
      ${K.numberInput('baseline', 'Baseline (months)', baselineMonths, { min: 1, max: 36, width: 90 })}
      ${K.numberInput('min', 'Min calls', minCount, { min: 1, max: 50, width: 70 })}`;

    res.send(K.page({
      report, token: req.query.token || '', range, filters, body, css,
      subtitle: `${esc(range.start)} to ${esc(range.end)} compared with the ${baselineMonths} months before`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
