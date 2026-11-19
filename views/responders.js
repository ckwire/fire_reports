// ---------------------------------------------------------------------------
// Responders per Call — staffing depth by day/hour, over time, and the calls
// that fell below a minimum.
//   ?min=<n>         minimum responders considered adequate (default 4)
//   ?category=<key>  limit to one call type
//   ?cancelled=1     include calls cancelled en route / good intent (default: excluded)
// ---------------------------------------------------------------------------
const createKit = require('./kit');

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const min = Math.min(30, Math.max(1, parseInt(req.query.min, 10) || 4));
    const categoryKey = K.CATEGORY_BY_KEY[req.query.category] ? req.query.category : '';
    const includeCancelled = req.query.cancelled === '1';

    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);

    let calls = rows.map(r => ({
      ...r, responders: Number(r.responders),
      category: K.categoryOf(r), hour: K.hourOf(r.alarm_local), dow: K.dayNumOf(r.alarm_local),
    }));
    if (categoryKey) calls = calls.filter(r => r.category === categoryKey);
    else if (!includeCancelled) calls = calls.filter(r => r.category !== 'cancelled');

    // A call with no personnel on it is a records gap, not an empty response.
    const noRecord = calls.filter(r => r.responders === 0);
    const staffed  = calls.filter(r => r.responders > 0);
    const counts   = staffed.map(r => r.responders);
    const below    = staffed.filter(r => r.responders < min);
    const pctOk    = staffed.length ? (staffed.length - below.length) / staffed.length * 100 : null;

    const stats = list => ({
      n: list.length,
      avg: K.mean(list.map(r => r.responders)),
      med: K.median(list.map(r => r.responders)),
      ok: list.length ? list.filter(r => r.responders >= min).length / list.length * 100 : null,
    });
    const overall = stats(staffed);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Average responders', value: K.fmtNum(overall.avg), sub: [`median ${K.fmtNum(overall.med)} per call`, `${K.fmtInt(staffed.length)} calls with personnel recorded`] })}
      ${K.tile({ title: `Calls with ${min}+`, value: K.fmtPct(pctOk), accent: true, sub: [
        pctOk === null ? '' : `${K.fmtInt(staffed.length - below.length)} of ${K.fmtInt(staffed.length)} calls met the minimum`] })}
      ${K.tile({ title: `Below ${min}`, value: K.fmtInt(below.length), sub: [
        below.length ? `${K.fmtInt(below.filter(r => r.responders <= 2).length)} with only 1–2 responders` : ''] })}
      ${K.tile({ title: 'No personnel recorded', value: K.fmtInt(noRecord.length), sub: ['records gap, not counted above'] })}
    </div>`;

    // --- Day x hour heatmap ----------------------------------------------------
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const cell = Array.from({ length: 24 }, () => Array.from({ length: 7 }, () => []));
    staffed.forEach(r => cell[r.hour][r.dow - 1].push(r.responders));
    const avgs = cell.flat().filter(c => c.length).map(c => K.mean(c));
    const maxAvg = Math.max(...avgs, 1);
    const heatRows = cell.map((days, h) => {
      const tds = days.map(list => {
        if (list.length === 0) return `<td class="hm"></td>`;
        const a = K.mean(list);
        const low = a < min;
        const fg = a / maxAvg > 0.55 ? '#fff' : '#333';
        return `<td class="hm${low ? ' hm-low' : ''}" style="background:${K.heat(a / maxAvg)};color:${fg}" title="${list.length} call${list.length !== 1 ? 's' : ''}, average ${a.toFixed(1)} responders">${a.toFixed(1)}</td>`;
      }).join('');
      return `<tr><th scope="row" class="hl">${String(h).padStart(2, '0')}:00</th>${tds}</tr>`;
    }).join('');
    const heatmap = `<div class="tw"><table class="hmtbl"><thead><tr><th></th>${DAYS.map(d => `<th class="num">${d}</th>`).join('')}</tr></thead><tbody>${heatRows}</tbody></table></div>`;

    // --- Trend by quarter ----------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const byQ = new Map(quarters.map(q => [q.key, []]));
    staffed.forEach(r => { const k = K.quarterKey(r.alarm_local); if (byQ.has(k)) byQ.get(k).push(r); });
    const qs = quarters.map(q => stats(byQ.get(q.key)));
    const qLabels = { labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : '') };
    const trendAvg = K.lineChart({ ...qLabels,
      series: [{ name: 'Average responders', values: qs.map(s => s.n ? s.avg : null), color: '#1e3a5f' }],
      refLines: [{ value: min, label: `minimum ${min}`, color: '#c0392b' }], yFmt: v => String(+v.toFixed(1)), aria: 'Average responders per call by quarter' });
    const trendOk = K.lineChart({ ...qLabels,
      series: [{ name: `% of calls with ${min}+`, values: qs.map(s => s.n ? s.ok : null), color: '#1a8a7d' }],
      yMax: 100, yFmt: v => `${Math.round(v)}%`, aria: 'Share of calls meeting the minimum by quarter' });

    // --- Distribution -----------------------------------------------------------------
    const CAP = 15;
    const dist = new Array(CAP + 1).fill(0);
    counts.forEach(c => { dist[Math.min(CAP, c)]++; });
    const distLabels = dist.map((_, i) => i === CAP ? `${CAP}+` : String(i)).slice(1);
    const distChart = K.stackedBars({
      labels: distLabels,
      series: [
        { name: 'Below minimum', color: '#d98e04', values: dist.slice(1).map((c, i) => (i + 1) < min ? c : 0) },
        { name: 'Met minimum',   color: '#1e3a5f', values: dist.slice(1).map((c, i) => (i + 1) < min ? 0 : c) },
      ], aria: 'Calls by number of responders', height: 220,
    });

    // --- Breakdown table --------------------------------------------------------------
    const row = (label, list, dot = '') => {
      const s = stats(list);
      return `<tr><th scope="row">${dot}${esc(label)}</th><td class="num">${s.n}</td><td class="num strong">${K.fmtNum(s.avg)}</td><td class="num">${K.fmtNum(s.med)}</td><td class="num">${K.fmtPct(s.ok)}</td></tr>`;
    };
    const byCat = K.CATEGORIES
      .map(c => ({ c, list: staffed.filter(r => r.category === c.key) })).filter(x => x.list.length)
      .map(x => row(x.c.label, x.list, `<i class="dot" style="background:${x.c.color}"></i>`));
    const slices = [
      ['Day (6am – 6pm)',   staffed.filter(r => r.hour >= 6 && r.hour < 18)],
      ['Night (6pm – 6am)', staffed.filter(r => r.hour < 6 || r.hour >= 18)],
      ['Weekday',           staffed.filter(r => r.dow <= 5)],
      ['Weekend',           staffed.filter(r => r.dow >= 6)],
    ].map(([l, list]) => row(l, list));
    const head = first => [first, { label: 'Calls', num: 1 }, { label: 'Avg', num: 1 }, { label: 'Median', num: 1 }, { label: `${min}+`, num: 1 }];

    // --- Below-minimum list ---------------------------------------------------------------
    const belowRows = [...below].sort((a, b) => b.alarm_local.localeCompare(a.alarm_local)).slice(0, 60).map(r => `<tr>
      <td>${esc(K.fmtDateTime(r.alarm_local))}</td><td>${esc(String(r.type_desc || '—'))}</td>
      <td>${esc(String(r.address || '').trim() || '—')}</td><td class="num strong">${r.responders}</td></tr>`);
    const belowCard = below.length === 0 ? '' : `<section class="card"><h2>Calls below ${min} responders</h2>
      <p class="lead">Most recent ${Math.min(60, below.length)} of ${below.length}.</p>
      ${K.table({ head: ['Alarm', 'Type', 'Address', { label: 'Responders', num: 1 }], rows: belowRows.slice(0, 12) })}
      ${belowRows.length > 12 ? `<details class="more"><summary>Show the other ${belowRows.length - 12}</summary>${K.table({ head: ['Alarm', 'Type', 'Address', { label: 'Responders', num: 1 }], rows: belowRows.slice(12) })}</details>` : ''}
    </section>`;

    const css = `
      .hmtbl { font-size: .78rem; } .hmtbl thead th { padding: 6px 4px; text-align: center; }
      .hl { background: #f8f9fa; color: #555; font-size: .72rem; text-align: right !important; padding: 3px 10px !important; border-right: 2px solid #e2e5ea; }
      td.hm { width: 13%; text-align: center; padding: 4px 2px; font-weight: 600; border: 1px solid rgba(255,255,255,.5); font-variant-numeric: tabular-nums; }
      td.hm-low { box-shadow: inset 0 0 0 2px #c0392b; }
      @media print { td.hm { padding: 1px 2px; font-size: .6rem; } .hl { padding: 1px 6px !important; font-size: .58rem; } .hmtbl thead th { padding: 2px; } }`;

    const body = staffed.length === 0
      ? `<p class="empty-msg">No calls with personnel records in this selection.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card('Average responders by quarter', `${trendAvg}${K.legend([{ label: 'Average responders', color: '#1e3a5f' }, { label: `Minimum (${min})`, color: '#c0392b', dashed: true }])}`)}
    ${K.card(`Calls meeting the minimum (${min}+)`, trendOk)}
  </div>
  <div class="grid2">
    ${K.card('Average responders by day and hour', heatmap, { lead: `Darker = more responders. A red outline means the average was below ${min}. Blank = no calls.` })}
    <div>
      ${K.card('Calls by number of responders', `${distChart}${K.legend([{ label: 'Below minimum', color: '#d98e04', box: true }, { label: 'Met minimum', color: '#1e3a5f', box: true }])}`)}
      <div style="height:16px"></div>
      ${K.card('By call type and time', K.table({ head: head('Group'), rows: [...byCat, ...slices] }))}
    </div>
  </div>
  ${belowCard}
  <p class="note">Responders are the distinct members recorded on each incident report. ${includeCancelled || categoryKey ? '' : 'Calls cancelled en route are excluded. '}${noRecord.length} call${noRecord.length !== 1 ? 's' : ''} had no personnel recorded and are not counted.
    Times are ${esc(process.env.REPORT_TIMEZONE || 'UTC')}. Staffing shown here is who responded, not who was available.</p>`;

    const filters = `
      ${K.numberInput('min', 'Minimum', min, { min: 1, max: 30, width: 70 })}
      ${K.categorySelect(categoryKey)}
      <div class="fg"><label>Cancelled calls</label><select name="cancelled">
        <option value="0"${includeCancelled ? '' : ' selected'}>Exclude</option>
        <option value="1"${includeCancelled ? ' selected' : ''}>Include</option></select></div>`;

    res.send(K.page({
      report, token: req.query.token || '', range, filters, body, css,
      subtitle: `Members on each call &mdash; ${esc(range.start)} to ${esc(range.end)}${categoryKey ? ` &mdash; ${esc(K.CATEGORY_BY_KEY[categoryKey].label)}` : ''}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
