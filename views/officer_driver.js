// ---------------------------------------------------------------------------
// Officer & Driver Coverage — share of calls with an officer and with a
// qualified driver among the responders.
//
// Who counts as an officer / driver is configured in reports.js (`ranks`) and
// matched against each member's CURRENT rank: rank history in the system only
// begins in mid-2026, so earlier promotions are not back-dated.
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
    const categoryKey = K.CATEGORY_BY_KEY[req.query.category] ? req.query.category : '';
    const cfg = report.ranks;
    const matchAny = (rank, list) => list.some(p => new RegExp(p, 'i').test(rank || ''));

    const [incsAll, roster, oicRows] = await Promise.all([
      K.incidentsWithResponders(report, range.start, range.end),
      K.query(report, 'rosterQuery'),
      K.query(report, 'oicQuery', [range.start, range.end]),
    ]);
    const oicOf = new Map(oicRows.map(r => [r.incident_id, r.oic]));
    const isOfficer = new Set(roster.filter(m => matchAny(m.rank, cfg.officer)).map(m => m.personnel_id));
    const isDriver  = new Set(roster.filter(m => matchAny(m.rank, cfg.driver) || (cfg.officersCountAsDrivers && matchAny(m.rank, cfg.officer))).map(m => m.personnel_id));
    const officerNames = roster.filter(m => isOfficer.has(m.personnel_id));

    let incs = incsAll.filter(i => i.members.size > 0 && i.category !== 'cancelled');
    if (categoryKey) incs = incs.filter(i => i.category === categoryKey);
    incs.forEach(i => {
      i.off = [...i.members].some(p => isOfficer.has(p));
      i.drv = [...i.members].some(p => isDriver.has(p));
      i.drivers = [...i.members].filter(p => isDriver.has(p)).length;
    });

    const share = (list, f) => list.length ? list.filter(f).length / list.length * 100 : null;
    const n = incs.length;

    // --- Heatmaps (officer % and driver %) by day x time block -------------------------------
    const heatmap = flag => {
      const rows = BLOCKS.map(b => `<tr><th scope="row" class="hl">${blockLabel(b)}</th>${DAYS.map((_, d) => {
        const list = incs.filter(i => { const h = K.hourOf(i.alarm_local); return h >= b[0] && h <= b[1] && K.dayNumOf(i.alarm_local) - 1 === d; });
        if (!list.length) return '<td class="hm"></td>';
        const p = share(list, flag);
        const bg = p >= 90 ? '#c6efce' : p >= 70 ? '#fff2b3' : '#f8d3cf';
        return `<td class="hm" style="background:${bg}" title="${list.filter(flag).length} of ${list.length} calls">${Math.round(p)}%</td>`;
      }).join('')}</tr>`).join('');
      return `<div class="tw"><table class="hmtbl"><thead><tr><th></th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    };

    // --- Trend by quarter ----------------------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const qList = quarters.map(q => incs.filter(i => K.quarterKey(i.alarm_local) === q.key));
    const trend = K.lineChart({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [
        { name: 'Officer on call', values: qList.map(l => l.length ? share(l, i => i.off) : null), color: '#1e3a5f' },
        { name: 'Driver on call',  values: qList.map(l => l.length ? share(l, i => i.drv) : null), color: '#d98e04' },
        { name: 'Both',            values: qList.map(l => l.length ? share(l, i => i.off && i.drv) : null), color: '#1a8a7d', dashed: true },
      ], yMax: 100, yFmt: v => `${Math.round(v)}%`, aria: 'Officer and driver coverage by quarter',
    });

    // --- By call type ------------------------------------------------------------------------------
    const catRows = K.CATEGORIES.map(c => ({ c, list: incs.filter(i => i.category === c.key) })).filter(x => x.list.length).map(x =>
      `<tr><th scope="row"><i class="dot" style="background:${x.c.color}"></i>${esc(x.c.label)}</th><td class="num">${x.list.length}</td>
        <td class="num strong">${K.fmtPct(share(x.list, i => i.off), 0)}</td><td class="num strong">${K.fmtPct(share(x.list, i => i.drv), 0)}</td><td class="num">${K.fmtPct(share(x.list, i => i.off && i.drv), 0)}</td></tr>`);

    // --- Officer in charge (as written on the report) ------------------------------------------------
    const oicCount = new Map();
    incs.forEach(i => { const o = oicOf.get(i.id); if (o) oicCount.set(o, (oicCount.get(o) || 0) + 1); });
    const officerNameSet = new Set(officerNames.map(m => String(m.name).split(',')[0].trim().toLowerCase()));
    const oicRowsHtml = [...oicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, c]) => {
      const last = String(name).split(/[ ,]/).filter(Boolean);
      const ranked = last.some(w => officerNameSet.has(w.toLowerCase()));
      return `<tr><th scope="row">${esc(name)}${ranked ? ' <span class="tag">Officer rank</span>' : ''}</th><td class="num strong">${c}</td><td class="num">${K.fmtPct(c / n * 100, 0)}</td></tr>`;
    });

    // --- Calls with neither ---------------------------------------------------------------------------
    const neither = incs.filter(i => !i.off && !i.drv).sort((a, b) => b.alarm_local.localeCompare(a.alarm_local));
    const neitherRows = neither.slice(0, 40).map(i => `<tr><td style="white-space:nowrap">${esc(K.fmtDateTime(i.alarm_local))}</td><td>${esc(String(i.type_desc || '—'))}</td><td>${esc(String(i.address || '').trim() || '—')}</td><td class="num">${i.members.size}</td></tr>`);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Officer on call', value: K.fmtPct(share(incs, i => i.off), 0), accent: true, sub: [`${officerNames.filter(m => m.active).length} active officers: ${esc(officerNames.filter(m => m.active).map(m => K.shortName(m.name)).join(', '))}`] })}
      ${K.tile({ title: 'Driver on call', value: K.fmtPct(share(incs, i => i.drv), 0), sub: [`${roster.filter(m => m.active && isDriver.has(m.personnel_id)).length} active drivers`, `avg ${K.fmtNum(K.mean(incs.map(i => i.drivers)))} drivers per call`] })}
      ${K.tile({ title: 'Both', value: K.fmtPct(share(incs, i => i.off && i.drv), 0), sub: ['officer and driver on the same call'] })}
      ${K.tile({ title: 'Neither', value: K.fmtInt(neither.length), sub: [`${K.fmtPct(share(incs, i => !i.off && !i.drv))} of ${K.fmtInt(n)} calls`] })}
    </div>`;

    const css = `
      .hmtbl thead th { text-align: center; padding: 6px 4px; }
      .hl { background: #f8f9fa; color: #555; font-size: .72rem; text-align: right !important; border-right: 2px solid #e2e5ea; white-space: nowrap; }
      td.hm { text-align: center; font-weight: 700; padding: 6px 2px; border: 1px solid #fff; width: 12%; font-variant-numeric: tabular-nums; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

    const body = n === 0 ? '<p class="empty-msg">No calls with personnel in this selection.</p>' : `${tiles}
  <div class="grid2">
    ${K.card('Officer on call, by day and time', heatmap(i => i.off), { lead: 'Green 90%+, yellow 70–89%, red under 70%.' })}
    ${K.card('Driver on call, by day and time', heatmap(i => i.drv), { lead: 'Green 90%+, yellow 70–89%, red under 70%.' })}
  </div>
  <div class="grid2">
    ${K.card('By quarter', `${trend}${K.legend([{ label: 'Officer', color: '#1e3a5f' }, { label: 'Driver', color: '#d98e04' }, { label: 'Both', color: '#1a8a7d', dashed: true }])}`)}
    ${K.card('By call type', K.table({ head: ['Type', { label: 'Calls', num: 1 }, { label: 'Officer', num: 1 }, { label: 'Driver', num: 1 }, { label: 'Both', num: 1 }], rows: catRows }))}
  </div>
  <div class="grid2">
    ${K.card('Officer in charge (as written on the report)', K.table({ head: ['Name', { label: 'Calls', num: 1 }, { label: '% of calls', num: 1 }], rows: oicRowsHtml }),
      { lead: 'Who signed as officer in charge. Members without an officer rank who often run calls are informal leaders worth knowing about.' })}
    <section class="card"><h2>Calls with neither an officer nor a driver</h2>
      ${K.table({ head: ['Alarm', 'Type', 'Address', { label: 'Members', num: 1 }], rows: neitherRows.slice(0, 10) })}
      ${neitherRows.length > 10 ? `<details class="more"><summary>Show ${neitherRows.length - 10} more${neither.length > 40 ? ` (of ${neither.length})` : ''}</summary>${K.table({ head: ['Alarm', 'Type', 'Address', { label: 'Members', num: 1 }], rows: neitherRows.slice(10) })}</details>` : ''}
    </section>
  </div>
  <p class="note"><strong>Who counts:</strong> officers are ranks matching ${esc(cfg.officer.join(', '))}; drivers are ranks matching ${esc(cfg.driver.join(', '))}${cfg.officersCountAsDrivers ? ' plus all officers' : ' (officers are not counted as drivers)'} &mdash; change <code>RANKS</code> in reports.js.
    Ranks are each member's <em>current</em> rank, because rank history only starts in mid-2026; someone promoted recently is counted at their new rank for older calls too.
    Calls cancelled en route are excluded. Coverage means the person was recorded on the call; a driver on scene by personal vehicle still counts.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, filters: K.categorySelect(categoryKey), body, css,
      subtitle: `Officers and drivers on calls &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
