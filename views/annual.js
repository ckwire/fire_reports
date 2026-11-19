// ---------------------------------------------------------------------------
// Annual Report — one printable page for a calendar year, compared with the
// year before. ?year=<yyyy> (default: the last complete year).
//
// Figures that depend on data recorded only from 2024 (response times,
// responders, mutual aid, member hours) show "n/a" for earlier years.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const RELIABLE_YEAR = 2024;
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const today = K.localToday();
    const thisYear = +today.slice(0, 4);
    const year = Math.min(thisYear, Math.max(2019, parseInt(req.query.year, 10) || thisYear - 1));
    const start = `${year}-01-01`;
    const end = year === thisYear ? today : `${year}-12-31`;
    const pStart = `${year - 1}-01-01`;
    const pEnd = year === thisYear ? `${year - 1}${today.slice(4)}` : `${year - 1}-12-31`;   // same span last year
    const ytd = year === thisYear;
    const reliable = year >= RELIABLE_YEAR;

    const [incs, prev, roster, classRows, aid, hours] = await Promise.all([
      K.incidentsWithResponders(report, start, end),
      K.query(report, 'incidentQuery', [pStart, pEnd]),
      K.query(report, 'rosterQuery'),
      K.query(report, 'classQuery', [start, end]),
      K.query(report, 'aidQuery', [start, end]),
      K.query(report, 'hoursQuery', [start, end]),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);

    const n = incs.length, pn = prev.length;
    const chg = (a, b) => b ? `${a >= b ? '+' : '−'}${Math.abs((a / b - 1) * 100).toFixed(0)}%` : '';
    const days = K.daysBetween(start, end);

    // --- Calls by month, this year vs last ----------------------------------------------------
    const monthly = list => { const m = new Array(12).fill(0); list.forEach(i => { m[+i.alarm_local.slice(5, 7) - 1]++; }); return m; };
    const mNow = monthly(incs), mPrev = monthly(prev);
    const lastMonth = ytd ? +today.slice(5, 7) : 12;
    const monthChart = K.lineChart({
      labels: MN, series: [
        { name: String(year - 1), values: mPrev.map((v, i) => i < lastMonth ? v : null), color: '#c3cad4', width: 2 },
        { name: String(year), values: mNow.map((v, i) => i < lastMonth ? v : null), color: '#1e3a5f', width: 2.6 },
      ], height: 190, aria: 'Calls by month',
    });
    const busiestMonth = mNow.indexOf(Math.max(...mNow));

    // --- Mix --------------------------------------------------------------------------------------
    const cnt = (list, key) => list.filter(i => (i.category || K.categoryOf(i)) === key).length;
    const mixRows = K.CATEGORIES.map(c => ({ c, a: cnt(incs, c.key), b: cnt(prev, c.key) })).filter(x => x.a || x.b).sort((x, y) => y.a - x.a)
      .map(x => ({ label: `<i class="dot" style="background:${x.c.color}"></i>${esc(x.c.label)}`, value: x.a, color: x.c.color,
        display: `${x.a} <small class="muted">${chg(x.a, x.b)}</small>` }));

    // --- Operations ----------------------------------------------------------------------------------
    const tfa = incs.filter(i => i.tfa !== null && i.tfa > 0 && i.tfa <= 7200 && !/standby/i.test(i.unit || '') && String(i.incident_type) !== '571').map(i => i.tfa);
    const staffed = incs.filter(i => i.members.size > 0 && i.category !== 'cancelled');
    // overlaps
    const win = aid.filter(r => r.t0 !== null && r.t1 !== null).map(r => ({ t0: Number(r.t0), t1: Math.min(Math.max(Number(r.t1), Number(r.t0) + 60), Number(r.t0) + 8 * 3600) })).sort((a, b) => a.t0 - b.t0);
    let overlapped = 0;
    win.forEach((c, i) => { for (let j = i - 1; j >= 0 && win[j].t0 > c.t0 - 8 * 3600; j--) if (win[j].t1 > c.t0) { overlapped++; break; } });
    const given = aid.filter(r => r.given).length;
    const received = aid.filter(r => r.received).length;
    const NA = '<span class="muted">n/a</span>';
    const opsRows = [
      ['Median time to first arrival', reliable ? K.fmtMin(K.median(tfa)) : NA],
      ['90th percentile time to first arrival', reliable ? K.fmtMin(K.percentile(tfa, 90)) : NA],
      ['Calls reached within 10 minutes', reliable && tfa.length ? K.fmtPct(tfa.filter(t => t <= 600).length / tfa.length * 100, 0) : NA],
      ['Average members per call', reliable && staffed.length ? K.fmtNum(K.mean(staffed.map(i => i.members.size))) : NA],
      ['Calls with 4+ members', reliable && staffed.length ? K.fmtPct(staffed.filter(i => i.members.size >= 4).length / staffed.length * 100, 0) : NA],
      ['Calls arriving during another call', win.length ? K.fmtPct(overlapped / win.length * 100, 1) : NA],
      ['Mutual aid given / received (calls)', reliable ? `${given} / ${received}` : NA],
    ].map(([l, v]) => `<tr><th scope="row">${l}</th><td class="num strong">${v}</td></tr>`);

    // --- People & training ------------------------------------------------------------------------------
    const activeAtEnd = roster.filter(m => m.start_date && m.start_date <= end && (!m.end_date || m.end_date > end) && (m.active || (m.end_date && m.end_date > end)));
    const joined = roster.filter(m => m.start_date && m.start_date >= start && m.start_date <= end);
    const left = roster.filter(m => m.end_date && m.end_date >= start && m.end_date <= end);
    const classHours = classRows.reduce((s, c) => s + (Number(c.duration_hours) || 0), 0);
    const attendees = new Map();
    attendance.forEach(a => attendees.set(a.training_class_id, (attendees.get(a.training_class_id) || 0) + 1));
    const memberTrainHours = classRows.reduce((s, c) => s + (Number(c.duration_hours) || 0) * (attendees.get(c.id) || 0), 0);
    const hrs = Object.fromEntries(hours.map(h => [h.kind, Number(h.hours) || 0]));
    const totalHrs = Object.values(hrs).reduce((a, b) => a + b, 0);
    const peopleRows = [
      ['Members at year end', String(activeAtEnd.length)],
      ['Joined / left', `${joined.length} / ${left.length}`],
      ['Training classes held', `${classRows.length} <small class="muted">(${K.fmtNum(classHours)} class hours)</small>`],
      ['Training received', `${K.fmtInt(memberTrainHours)} member-hours`],
      ['Total member hours', reliable && totalHrs ? `${K.fmtInt(totalHrs)} <small class="muted">(incidents ${K.fmtInt(hrs.incident_reports || 0)})</small>` : NA],
    ].map(([l, v]) => `<tr><th scope="row">${l}</th><td class="num strong">${v}</td></tr>`);

    // --- Top responders ------------------------------------------------------------------------------------
    const callsBy = new Map();
    incs.forEach(i => i.members.forEach(p => callsBy.set(p, (callsBy.get(p) || 0) + 1)));
    const nameOf = new Map(roster.map(m => [m.personnel_id, m.name]));
    const top = [...callsBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([p, c], i) => `<li><span>${i + 1}.</span> ${esc(K.shortName(nameOf.get(p) || ''))} <b>${c}</b> <small class="muted">(${Math.round(c / n * 100)}%)</small></li>`).join('');

    // busiest day
    const perDay = new Map();
    incs.forEach(i => perDay.set(i.date, (perDay.get(i.date) || 0) + 1));
    const bd = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];

    const tiles = `<div class="tiles t5">
      ${K.tile({ title: ytd ? 'Calls year to date' : 'Total calls', value: K.fmtInt(n), accent: true, sub: [`${chg(n, pn)} vs ${year - 1}${ytd ? ' (same dates)' : ''} (${K.fmtInt(pn)})`] })}
      ${K.tile({ title: 'Calls per day', value: (n / days).toFixed(2), sub: [bd ? `busiest: ${esc(K.fmtDate(bd[0]))} (${bd[1]})` : ''] })}
      ${K.tile({ title: 'Busiest month', value: MN[busiestMonth], sub: [`${mNow[busiestMonth]} calls`] })}
      ${K.tile({ title: '90th pct arrival', value: reliable ? K.fmtMin(K.percentile(tfa, 90)) : 'n/a', sub: [reliable ? `median ${K.fmtMin(K.median(tfa))}` : 'measured differently before 2024'] })}
      ${K.tile({ title: 'Members per call', value: reliable && staffed.length ? K.fmtNum(K.mean(staffed.map(i => i.members.size))) : 'n/a', sub: [reliable ? `${activeAtEnd.length} members at year end` : 'not recorded before 2024'] })}
    </div>`;

    const yearOptions = [];
    for (let y = thisYear; y >= 2019; y--) yearOptions.push([y, y === thisYear ? `${y} (year to date)` : String(y)]);

    const css = `
      .t5 { grid-template-columns: repeat(5, 1fr); }
      .rp-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid #1e3a5f; padding-bottom: 6px; margin-bottom: 14px; }
      .rp-head h2 { font-size: 1.25rem; color: #1e3a5f; } .rp-head span { color: #777; font-size: .85rem; }
      ol.top { list-style: none; padding: 2px 16px 12px; } ol.top li { display: flex; gap: 6px; padding: 3px 0; font-size: .84rem; border-bottom: 1px solid #f0f2f5; } ol.top li b { margin-left: auto; }
      ol.top li span { color: #999; width: 16px; }
      @media (max-width: 900px) { .t5 { grid-template-columns: repeat(2, 1fr); } }
      @media print {
        .t5 { grid-template-columns: repeat(5, 1fr); }
        .rp-head h2 { font-size: 1rem; } .tile-value { font-size: 1.25rem; }
        .hbars { padding: 2px 10px 6px; } .hb { font-size: .66rem; padding: 1px 0; }
        ol.top li { font-size: .66rem; padding: 1px 0; }
        h1, .sub, .topbar { display: none !important; }
      }`;

    const body = `
  <div class="rp-head"><h2>${esc(process.env.DEPT_NAME || 'Fire Department')} &mdash; ${year} ${ytd ? 'Year to Date' : 'Annual Report'}</h2><span>${esc(K.fmtDate(start))} – ${esc(K.fmtDate(end))}</span></div>
  ${tiles}
  <div class="grid2">
    ${K.card('Calls by month', `${monthChart}${K.legend([{ label: String(year), color: '#1e3a5f' }, { label: String(year - 1), color: '#c3cad4' }])}`)}
    ${K.card('Calls by type', K.hBars(mixRows), { lead: `Change vs ${year - 1} in grey.` })}
  </div>
  <div class="grid2">
    ${K.card('Operations', K.table({ head: ['Measure', { label: String(year), num: 1 }], rows: opsRows }))}
    <div>
      ${K.card('People & training', K.table({ head: ['Measure', { label: String(year), num: 1 }], rows: peopleRows }))}
      <div style="height:12px"></div>
      ${K.card('Top responders', reliable && top ? `<ol class="top">${top}</ol>` : '<p class="lead" style="padding:4px 16px 12px">Not recorded before 2024.</p>')}
    </div>
  </div>
  <p class="note">Calls are incident reports by local date. Arrival time is alarm to first unit on scene (standby excluded). Members per call excludes calls cancelled en route.
    ${reliable ? '' : 'Response times, staffing, mutual aid and member hours were not recorded in comparable form before 2024 and show n/a. '}${ytd ? `Year-to-date figures are compared with the same dates in ${year - 1}. ` : ''}Details behind each figure are in the individual reports.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range: null, rangeControls: false, body, css,
      filters: K.select('year', 'Year', yearOptions, year),
      subtitle: `${year}${ytd ? ' year to date' : ''}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
