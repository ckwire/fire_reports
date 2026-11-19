// ---------------------------------------------------------------------------
// Recognition & Milestones — as of today.
//   ?ahead=<days>   how far ahead to look for anniversaries / milestones (default 90)
//
// Call counts come from personnel records on incidents, which begin in 2024,
// so "career" call totals here are calls since 2024.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const CALL_MILESTONES = [100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000];
const SERVICE_MILESTONES = new Set([1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const today = K.localToday();
    const ahead = Math.min(365, Math.max(14, parseInt(req.query.ahead, 10) || 90));
    const floor = report.minDate;

    const [incs, roster, classRows] = await Promise.all([
      K.incidentsWithResponders(report, floor, today),
      K.query(report, 'rosterQuery'),
      K.query(report, 'classQuery', [floor, today]),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);
    const classById = new Map(classRows.map(c => [c.id, c]));
    const active = roster.filter(m => m.active);

    // --- Periods ---------------------------------------------------------------------------
    const monthStart = `${today.slice(0, 7)}-01`;
    const q = Math.ceil(+today.slice(5, 7) / 3);
    const quarterStart = `${today.slice(0, 4)}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const prevMonthStart = K.addMonths(monthStart, -1);

    const callsIn = (pid, from, to) => incs.filter(i => i.date >= from && i.date <= to && i.members.has(pid)).length;
    const hoursIn = (uid, from, to) => attendance.filter(a => a.user_id === uid).reduce((s, a) => {
      const c = classById.get(a.training_class_id);
      return c && c.class_date >= from && c.class_date <= to ? s + (Number(c.duration_hours) || 0) : s;
    }, 0);

    // --- Service anniversaries ------------------------------------------------------------------
    const horizon = K.addDays(today, ahead);
    const annivs = active.filter(m => m.start_date && m.start_date <= today).map(m => {
      let next = `${today.slice(0, 4)}${m.start_date.slice(4)}`;
      if (next < today) next = `${+today.slice(0, 4) + 1}${m.start_date.slice(4)}`;
      const years = +next.slice(0, 4) - +m.start_date.slice(0, 4);
      return { m, next, years, milestone: SERVICE_MILESTONES.has(years) };
    }).filter(a => a.next <= horizon && a.years > 0).sort((a, b) => a.next.localeCompare(b.next));
    const annivRows = annivs.map(a => `<tr${a.milestone ? ' style="background:#fff8e6"' : ''}>
      <td class="num">${esc(MN[+a.next.slice(5, 7) - 1])} ${+a.next.slice(8, 10)}</td>
      <th scope="row">${esc(K.shortName(a.m.name))}</th><td class="num strong">${a.years} yr${a.years !== 1 ? 's' : ''}</td>
      <td>${a.milestone ? '<span class="tag" style="background:#ffe9a8;color:#7a5a10">Milestone</span>' : ''}</td>
      <td class="num dim">${K.daysBetween(today, a.next) - 1} d</td></tr>`);

    // --- Years of service ---------------------------------------------------------------------------
    const tenure = active.filter(m => m.start_date && m.start_date <= today).map(m => ({ m, yrs: (K.daysBetween(m.start_date, today) - 1) / 365.25 }))
      .sort((a, b) => b.yrs - a.yrs);
    const tenureRows = tenure.slice(0, 10).map(t => `<tr><th scope="row">${esc(K.shortName(t.m.name))}</th><td class="num">${esc(K.fmtDate(t.m.start_date))}</td><td class="num strong">${t.yrs.toFixed(1)}</td></tr>`);

    // --- Call milestones -----------------------------------------------------------------------------
    // pace = calls per day over the last 180 days; projects when the next milestone lands
    const paceFrom = K.addDays(today, -179);
    const callMiles = active.map(m => {
      const total = callsIn(m.personnel_id, floor, today);
      const next = CALL_MILESTONES.find(x => x > total);
      const pace = callsIn(m.personnel_id, paceFrom, today) / 180;
      const eta = next && pace > 0 ? Math.ceil((next - total) / pace) : null;
      return { m, total, next, pace, eta };
    }).filter(x => x.next && x.eta !== null && x.eta <= ahead).sort((a, b) => a.eta - b.eta);
    const reached = active.map(m => {
      const before = callsIn(m.personnel_id, floor, K.addDays(today, -ahead));
      const now = callsIn(m.personnel_id, floor, today);
      const hit = CALL_MILESTONES.filter(x => x > before && x <= now).pop();
      return hit ? { m, hit, now } : null;
    }).filter(Boolean).sort((a, b) => b.hit - a.hit);
    const mileRows = callMiles.map(x => `<tr><th scope="row">${esc(K.shortName(x.m.name))}</th><td class="num">${x.total}</td><td class="num strong">${x.next}</td>
      <td class="num">${x.next - x.total} to go</td><td class="num dim">~${x.eta} d</td></tr>`);
    const reachedRows = reached.map(x => `<tr><th scope="row">${esc(K.shortName(x.m.name))}</th><td class="num strong">${x.hit}</td><td class="num dim">${x.now} now</td></tr>`);

    // --- Leaders ---------------------------------------------------------------------------------------
    const leaders = (from, to, label) => {
      const calls = active.map(m => ({ m, n: callsIn(m.personnel_id, from, to) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
      const hrs = active.map(m => ({ m, n: hoursIn(m.user_id, from, to) })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5);
      const deptCalls = incs.filter(i => i.date >= from && i.date <= to).length;
      const list = (arr, fmt) => arr.length ? `<ol class="lb">${arr.map((x, i) => `<li><span class="medal m${i}">${i + 1}</span>${esc(K.shortName(x.m.name))}<b>${fmt(x.n)}</b></li>`).join('')}</ol>` : '<p class="lead">—</p>';
      return `<section class="card"><h2>${label}</h2><p class="lead">${esc(K.fmtDate(from))} – ${esc(K.fmtDate(to))} · ${deptCalls} department calls</p>
        <div class="lbwrap"><div><h3>Calls</h3>${list(calls, n => `${n} <small>(${deptCalls ? Math.round(n / deptCalls * 100) : 0}%)</small>`)}</div><div><h3>Training hours</h3>${list(hrs, n => K.fmtNum(n))}</div></div></section>`;
    };

    // --- Most improved: share of calls this quarter vs last quarter ------------------------------------------
    const lastQStart = K.addMonths(quarterStart, -3), lastQEnd = K.addDays(quarterStart, -1);
    const qCalls = incs.filter(i => i.date >= quarterStart).length, lqCalls = incs.filter(i => i.date >= lastQStart && i.date <= lastQEnd).length;
    const improved = active.filter(m => !m.start_date || m.start_date < lastQStart).map(m => {
      const now = qCalls ? callsIn(m.personnel_id, quarterStart, today) / qCalls : 0;
      const before = lqCalls ? callsIn(m.personnel_id, lastQStart, lastQEnd) / lqCalls : 0;
      return { m, now, before, d: now - before };
    }).filter(x => x.d > 0.03).sort((a, b) => b.d - a.d).slice(0, 5);
    const improvedRows = improved.map(x => `<tr><th scope="row">${esc(K.shortName(x.m.name))}</th><td class="num dim">${Math.round(x.before * 100)}%</td><td class="num strong">${Math.round(x.now * 100)}%</td><td class="num good">+${Math.round(x.d * 100)} pts</td></tr>`);

    const css = `
      .lbwrap { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 0 16px 14px; }
      .lbwrap h3 { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #888; margin-bottom: 4px; }
      ol.lb { list-style: none; }
      ol.lb li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid #f0f2f5; font-size: .84rem; }
      ol.lb li b { margin-left: auto; font-variant-numeric: tabular-nums; } ol.lb li small { color: #999; font-weight: 400; }
      .medal { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: .68rem; font-weight: 700; background: #eef0f3; color: #555; flex-shrink: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .m0 { background: #e8c547; color: #4a3b00; } .m1 { background: #c9d0da; color: #333; } .m2 { background: #d9a066; color: #4a2a00; }
      .grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 16px; margin-bottom: 16px; }
      .grid3 .card { margin-bottom: 0; }`;

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Anniversaries ahead', value: String(annivs.length), accent: true, sub: [`next ${ahead} days`, annivs.filter(a => a.milestone).length ? `${annivs.filter(a => a.milestone).length} milestone year${annivs.filter(a => a.milestone).length !== 1 ? 's' : ''}` : ''] })}
      ${K.tile({ title: 'Call milestones ahead', value: String(callMiles.length), sub: [callMiles[0] ? `${esc(K.shortName(callMiles[0].m.name))} → ${callMiles[0].next} in ~${callMiles[0].eta} d` : ''] })}
      ${K.tile({ title: `Milestones reached`, value: String(reached.length), sub: [`in the last ${ahead} days`] })}
      ${K.tile({ title: 'Longest serving', value: tenure[0] ? `${Math.floor(tenure[0].yrs)} yrs` : '—', sub: [tenure[0] ? esc(K.shortName(tenure[0].m.name)) : ''] })}
    </div>`;

    const body = `${tiles}
  <div class="grid3">
    ${leaders(monthStart, today, `This month (${MN[+today.slice(5, 7) - 1]})`)}
    ${leaders(quarterStart, today, `This quarter (Q${q})`)}
    ${leaders(yearStart, today, `This year (${today.slice(0, 4)})`)}
  </div>
  <div class="grid2">
    ${K.card(`Service anniversaries — next ${ahead} days`, annivRows.length ? K.table({ head: [{ label: 'Date', num: 1 }, 'Member', { label: 'Years', num: 1 }, '', { label: 'In', num: 1 }], rows: annivRows }) : '<p class="lead" style="padding:4px 16px 14px">None in this window.</p>',
      { lead: '1, 5, 10, 15… years are highlighted.' })}
    ${K.card('Call milestones coming up', mileRows.length ? K.table({ head: ['Member', { label: 'Calls', num: 1 }, { label: 'Next', num: 1 }, { label: '', num: 1 }, { label: 'At current pace', num: 1 }], rows: mileRows }) : '<p class="lead" style="padding:4px 16px 14px">No one is due in this window.</p>',
      { lead: `Calls since ${floor.slice(0, 4)}; the estimate uses each member’s pace over the last 180 days.` })}
  </div>
  <div class="grid2">
    ${K.card(`Milestones reached in the last ${ahead} days`, reachedRows.length ? K.table({ head: ['Member', { label: 'Milestone', num: 1 }, { label: '', num: 1 }], rows: reachedRows }) : '<p class="lead" style="padding:4px 16px 14px">None in this window.</p>')}
    ${K.card('Most improved this quarter', improvedRows.length ? K.table({ head: ['Member', { label: 'Last qtr', num: 1 }, { label: 'This qtr', num: 1 }, { label: 'Change', num: 1 }], rows: improvedRows }) : '<p class="lead" style="padding:4px 16px 14px">No big jumps yet this quarter.</p>',
      { lead: 'Biggest increase in share of department calls compared with last quarter.' })}
  </div>
  ${K.card('Longest serving active members', K.table({ head: ['Member', { label: 'Started', num: 1 }, { label: 'Years', num: 1 }], rows: tenureRows }))}
  <p class="note">Call counts are calls a member was recorded on since ${esc(floor)} (when personnel records on incidents begin), so long-serving members' true career totals are higher. Service years are from the start date in the personnel record. Leaders include active members only.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range: null, rangeControls: false, body, css,
      filters: K.select('ahead', 'Look ahead', [[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days'], [365, '1 year']], ahead),
      subtitle: `As of ${esc(K.fmtDate(today))}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
