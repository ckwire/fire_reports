// ---------------------------------------------------------------------------
// Depth of Bench — how many different people cover each time slot, and how
// much the department leans on its most active responders.
//   ?min=<n>   minimum responders for an adequately staffed call (default 4)
//   ?top=<n>   how many top responders the "without them" test removes (default 5)
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BLOCKS = [[0, 3], [4, 7], [8, 11], [12, 15], [16, 19], [20, 23]];
const blockLabel = b => { const f = h => h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`; return `${f(b[0])}–${f((b[1] + 1) % 24)}`; };

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 1 });
    const min = Math.min(30, Math.max(1, parseInt(req.query.min, 10) || 4));
    const topN = Math.min(15, Math.max(1, parseInt(req.query.top, 10) || 5));

    const [incs, roster] = await Promise.all([
      K.incidentsWithResponders(report, range.start, range.end),
      K.query(report, 'rosterQuery'),
    ]);
    const nameOf = new Map(roster.map(m => [m.personnel_id, m.name]));
    const staffed = incs.filter(i => i.members.size > 0);

    // --- Concentration ------------------------------------------------------------------
    const callsBy = new Map();
    staffed.forEach(i => i.members.forEach(p => callsBy.set(p, (callsBy.get(p) || 0) + 1)));
    const ranked = [...callsBy.entries()].sort((a, b) => b[1] - a[1]);
    const totalResponses = ranked.reduce((s, [, n]) => s + n, 0);
    // "Top N" are the most active CURRENT members — the people the department
    // depends on going forward.
    const activeIds = new Set(roster.filter(m => m.active).map(m => m.personnel_id));
    const topRanked = ranked.filter(([p]) => activeIds.has(p)).slice(0, topN);
    const topSet = new Set(topRanked.map(([p]) => p));
    const topShare = totalResponses ? topRanked.reduce((s, [, n]) => s + n, 0) / totalResponses * 100 : null;
    // how many members account for half of all responses
    let acc = 0, half = 0;
    for (const [, n] of ranked) { acc += n; half++; if (acc >= totalResponses / 2) break; }

    // --- Without the top N ---------------------------------------------------------------
    const metNow = staffed.filter(i => i.members.size >= min).length;
    const metWithout = staffed.filter(i => [...i.members].filter(p => !topSet.has(p)).length >= min).length;
    const lost = metNow - metWithout;
    const anyTop = staffed.filter(i => [...i.members].some(p => topSet.has(p))).length;

    // --- Distinct members per day x time block ---------------------------------------------
    const grid = BLOCKS.map(() => DAYS.map(() => ({ members: new Set(), calls: 0, sum: 0 })));
    staffed.forEach(i => {
      const h = K.hourOf(i.alarm_local), d = K.dayNumOf(i.alarm_local) - 1;
      const b = BLOCKS.findIndex(x => h >= x[0] && h <= x[1]);
      const c = grid[b][d];
      c.calls++; c.sum += i.members.size; i.members.forEach(p => c.members.add(p));
    });
    const maxDistinct = Math.max(...grid.flat().map(c => c.members.size), 1);
    const thin = grid.flat().map((c, k) => ({ c, b: Math.floor(k / 7), d: k % 7 })).filter(x => x.c.calls > 0).sort((a, b) => a.c.members.size - b.c.members.size)[0];
    const gridRows = grid.map((row, b) => `<tr><th scope="row" class="hl">${blockLabel(BLOCKS[b])}</th>${row.map(c => {
      if (!c.calls) return '<td class="hm"></td>';
      const n = c.members.size, t = n / maxDistinct, fg = t > 0.55 ? '#fff' : '#333';
      return `<td class="hm" style="background:${K.heat(t)};color:${fg}" title="${n} different members over ${c.calls} calls (avg ${(c.sum / c.calls).toFixed(1)} per call)">${n}<small>${(c.sum / c.calls).toFixed(1)}</small></td>`;
    }).join('')}</tr>`).join('');

    // --- Who carries the load (Pareto) -----------------------------------------------------
    let cum = 0;
    const paretoRows = ranked.slice(0, 25).map(([p, n], i) => {
      cum += n;
      const m = roster.find(r => r.personnel_id === p);
      return `<tr${topSet.has(p) ? ' style="background:#f7fbff"' : ''}><td class="num dim">${i + 1}</td>
        <th scope="row">${esc(K.shortName(nameOf.get(p) || `#${p}`))}${m && !m.active ? ' <span class="muted">(inactive)</span>' : ''}</th>
        <td class="num strong">${n}</td><td class="num">${K.fmtPct(n / staffed.length * 100, 0)}</td>
        <td class="num">${K.fmtPct(n / totalResponses * 100)}</td><td class="num dim">${K.fmtPct(cum / totalResponses * 100, 0)}</td></tr>`;
    });

    // --- Effect by time of day: share meeting the minimum with/without top N ----------------
    const byBlock = BLOCKS.map(b => {
      const list = staffed.filter(i => { const h = K.hourOf(i.alarm_local); return h >= b[0] && h <= b[1]; });
      const now = list.length ? list.filter(i => i.members.size >= min).length / list.length * 100 : null;
      const wo = list.length ? list.filter(i => [...i.members].filter(p => !topSet.has(p)).length >= min).length / list.length * 100 : null;
      return { label: blockLabel(b), n: list.length, now, wo };
    });
    const effectRows = byBlock.map(x => `<tr><th scope="row">${x.label}</th><td class="num">${x.n}</td><td class="num strong">${K.fmtPct(x.now, 0)}</td>
      <td class="num">${K.fmtPct(x.wo, 0)}</td><td class="num bad">${x.now === null ? '' : `−${(x.now - x.wo).toFixed(0)}`}</td></tr>`);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Members responding', value: String(ranked.length), sub: [`${half} of them cover half of all responses`] })}
      ${K.tile({ title: `Top ${topN} share`, value: K.fmtPct(topShare, 0), accent: true, sub: [`of all member responses`, `on ${K.fmtPct(staffed.length ? anyTop / staffed.length * 100 : null, 0)} of calls`] })}
      ${K.tile({ title: `Without the top ${topN}`, value: `−${K.fmtInt(lost)}`, sub: [`calls would have fallen below ${min}`, `${K.fmtPct(staffed.length ? metNow / staffed.length * 100 : null, 0)} → ${K.fmtPct(staffed.length ? metWithout / staffed.length * 100 : null, 0)} meeting the minimum`] })}
      ${K.tile({ title: 'Thinnest slot', value: thin ? String(thin.c.members.size) : '—', sub: [thin ? `different members, ${DAYS[thin.d]} ${blockLabel(BLOCKS[thin.b])}` : ''] })}
    </div>`;

    const css = `
      .hmtbl thead th { text-align: center; padding: 6px 4px; }
      .hl { background: #f8f9fa; color: #555; font-size: .72rem; text-align: right !important; border-right: 2px solid #e2e5ea; white-space: nowrap; }
      td.hm { text-align: center; font-weight: 700; padding: 6px 2px; border: 1px solid rgba(255,255,255,.5); font-variant-numeric: tabular-nums; width: 12%; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      td.hm small { display: block; font-weight: 400; font-size: .66rem; opacity: .8; }`;

    const body = staffed.length === 0 ? '<p class="empty-msg">No calls with personnel recorded in this range.</p>' : `${tiles}
  <div class="grid2">
    ${K.card('Different members per time slot', `<div class="tw"><table class="hmtbl"><thead><tr><th></th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${gridRows}</tbody></table></div>`,
      { lead: 'Big number = how many different people responded in that slot over the whole range; small number = average responders per call. Few different people means the slot depends on the same handful.' })}
    ${K.card(`Meeting the minimum (${min}+), with and without the top ${topN}`, K.table({
      head: ['Time', { label: 'Calls', num: 1 }, { label: 'Now', num: 1 }, { label: `Without top ${topN}`, num: 1 }, { label: 'Drop', num: 1 }], rows: effectRows }),
      { lead: `If the ${topN} most active responders were unavailable, this is the share of calls that would still have had ${min} or more members.` })}
  </div>
  ${K.card('Who carries the load', K.table({
    head: [{ label: '#', num: 1 }, 'Member', { label: 'Calls', num: 1 }, { label: '% of calls', num: 1 }, { label: '% of responses', num: 1 }, { label: 'Cumulative', num: 1 }], rows: paretoRows }),
    { lead: `Highlighted rows are the top ${topN} active members. Cumulative shows how quickly a few people add up to most of the work.` })}
  <p class="note">Counts use members recorded on each incident report (${K.fmtInt(staffed.length)} calls with personnel). "Without the top ${topN}" simply removes those members from every call they were on; in reality others might have stepped up, so treat it as the size of the dependency, not a forecast.
    Times are ${esc(process.env.REPORT_TIMEZONE || 'UTC')}.</p>`;

    const filters = `${K.numberInput('min', 'Minimum', min, { min: 1, max: 30, width: 70 })}${K.numberInput('top', 'Top N', topN, { min: 1, max: 15, width: 70 })}`;
    res.send(K.page({ report, token: req.query.token || '', range, filters, body, css,
      subtitle: `Coverage depth &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
