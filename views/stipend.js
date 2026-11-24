// ---------------------------------------------------------------------------
// Work Performance Stipend
//
// One member's stipend review for a date range, laid out like the paper form:
//   1. Call response   2. Training   3. Special projects / extra duties
//   4. Meeting participation   5. Professional development & standards
// Each category is worth an equal share of the stipend (20% of five).
//
// The report SUGGESTS Yes / No for every category from the data, using the
// rules in reports.js (`rules`). The chief can flip any answer on screen and
// the stipend earned recalculates; the printed page shows the chosen answers.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const money = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;
  const rules = report.rules;
  const token = req.query.token || '';

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 0 });
    const roster = await K.query(report, 'rosterQuery');
    const m = roster.find(r => String(r.user_id) === String(req.query.member)) || null;

    // Optional "total available stipend" ($). Typed in, or a default from reports.js.
    const availRaw = req.query.available !== undefined ? parseFloat(String(req.query.available).replace(/[$,]/g, '')) : rules.available;
    const available = availRaw > 0 ? availRaw : null;

    const shares = rules.categories || 5;
    const floor = report.minDate || '0000-00-00';
    const clamp = d => d < floor ? floor : d;

    const quickCss = `
      .quick { display: flex; align-items: center; height: 34px; }
      .quick a { font-size: .8rem; color: #2a6db5; text-decoration: none; margin-right: 10px; white-space: nowrap; }
      .quick a:hover { text-decoration: underline; }`;
    const filters = filterHtml();
    if (!m) {
      return res.send(K.page({ report, token, range, filters, css: quickCss,
        subtitle: `Stipend review &mdash; ${esc(range.start)} to ${esc(range.end)}`,
        body: '<p class="empty-msg">Choose a member and a date range to prepare their stipend review.</p>' }));
    }

    const memberStart = m.start_date && m.start_date > range.start ? m.start_date : range.start;   // effective start of the review period

    // --- 1. Call response -------------------------------------------------------------------------------
    const windows = [
      { key: 'period', label: 'Review period', dates: `${K.fmtDate(range.start)} – ${K.fmtDate(range.end)}`, start: range.start },
      { key: 'six',    label: 'Last 6 months',  start: clamp(K.addDays(K.addMonths(range.end, -6), 1)) },
      { key: 'twelve', label: 'Last 12 months', start: clamp(K.addDays(K.addMonths(range.end, -12), 1)) },
    ];
    windows.forEach(w => { w.end = range.end; w.dates = w.dates || `${K.fmtDate(w.start)} – ${K.fmtDate(w.end)}`; });
    const fetchFrom = windows.reduce((a, w) => w.start < a ? w.start : a, range.start);

    const [incs, hoursRows] = await Promise.all([
      K.incidentsWithResponders(report, fetchFrom, range.end),
      K.query(report, 'hoursQuery', [fetchFrom, range.end, m.user_id]),
    ]);
    windows.forEach(w => {
      const from = m.start_date && m.start_date > w.start ? m.start_date : w.start;
      const to = m.end_date && m.end_date < w.end ? m.end_date : w.end;
      w.sinceStart = from > w.start;
      const calls = incs.filter(i => i.date >= from && i.date <= to);
      const mine = calls.filter(i => i.members.has(m.personnel_id));
      w.total = calls.length; w.n = mine.length;
      w.pct = calls.length ? mine.length / calls.length * 100 : null;
      w.hours = sum(hoursRows.filter(h => h.work_date >= w.start && h.work_date <= w.end), h => h.hours);
    });
    const basis = windows.find(w => w.key === rules.callResponse.basis) || windows[0];
    const c1 = basis.pct !== null && basis.pct >= rules.callResponse.minPct;

    // --- 2. Training ----------------------------------------------------------------------------------------
    const recentFrom = K.addDays(range.end, -(rules.professional.recentDays - 1));
    const classFrom = clamp(recentFrom < range.start ? recentFrom : range.start);
    const classRows = await K.query(report, 'classQuery', [classFrom, range.end]);
    const classIds = classRows.map(c => c.id);
    const [attRows, instRows] = classIds.length ? await Promise.all([
      K.query(report, 'attendanceQuery', [classIds]),
      K.query(report, 'instructorQuery', [classIds]),
    ]) : [[], []];
    const mine = new Set(attRows.filter(a => String(a.user_id) === String(m.user_id)).map(a => String(a.training_class_id)));
    const classes = classRows.map(c => ({ ...c, hours: +c.duration_hours || 0 }));
    const attended = classes.filter(c => mine.has(String(c.id)) && c.class_date >= range.start && c.class_date >= (m.start_date || '0000'));
    const inhouse = attended.filter(c => c.is_inhouse);
    const totalHours = sum(attended, c => c.hours), inhouseHours = sum(inhouse, c => c.hours);
    const inhousePct = totalHours > 0 ? inhouseHours / totalHours * 100 : null;          // in-house as a share of ALL the member's training (informational)
    // In-house attendance: hours attended ÷ in-house hours offered since the member started (this is what the requirement judges)
    const offerEnd = m.end_date && m.end_date < range.end ? m.end_date : range.end;
    const offered = classes.filter(c => c.is_inhouse && c.class_date >= memberStart && c.class_date <= offerEnd);
    const offeredHours = sum(offered, c => c.hours);
    const inhouseAttPct = offeredHours > 0 ? inhouseHours / offeredHours * 100 : null;
    const spanDays = K.daysBetween(memberStart, range.end);
    let years = spanDays / 365.25; if (Math.abs(years - 1) < 0.01) years = 1;
    const reqHours = rules.training.minHoursPerYear * years;
    const lead = classes.filter(c => c.class_date >= range.start && instRows.some(i =>
      String(i.training_class_id) === String(c.id) && String(i.personnel_id) === String(m.personnel_id) && rules.training.leadTypes.includes(i.instructor_type)));
    const c2 = totalHours >= reqHours && inhouseAttPct !== null && inhouseAttPct >= rules.training.minInhousePct;

    // --- Events: meeting participation (4) -------------------------------------------------------------
    // Special projects, committees and extra duties (3) are NOT taken from the activities log:
    // the chief enters those, so that section is a manual Yes / No plus a notes box.
    const evRows = (await K.query(report, 'eventQuery', [range.start, range.end, m.user_id]))
      .filter(e => (!m.start_date || e.event_date >= m.start_date) && (!m.end_date || e.event_date <= m.end_date));
    const meetRows = rules.meetings.rows.map(r => ({ ...r, re: new RegExp(r.match, 'i'), held: 0, came: 0, hours: 0, list: [] }));
    evRows.forEach(e => {
      const row = meetRows.find(r => r.re.test(e.name));
      if (!row) return;                                   // not a meeting: ignored
      const hrs = e.paid_hours > 0 ? e.paid_hours : e.duration;
      row.held++;
      if (e.attended) { row.came++; row.hours += hrs; }
      row.list.push(e);
    });
    const primary = meetRows.find(r => r.primary) || meetRows[0];
    const meetPct = primary.held ? primary.came / primary.held * 100 : null;
    const c4 = meetPct !== null && meetPct >= rules.meetings.minAttendPct;
    const c3 = false;                                     // chief decides (starts at No)

    // --- 5. Professional development & standards --------------------------------------------------------
    const offRes = rules.professional.officerTraining.map(p => new RegExp(p, 'i'));
    const isOfficerClass = c => offRes.some(re => re.test(c.name) || re.test(c.category_name));
    const officerClasses = attended.filter(isOfficerClass);
    const courseClasses = attended.filter(c => !c.is_inhouse && !isOfficerClass(c));
    const recentCall = incs.some(i => i.date >= recentFrom && i.members.has(m.personnel_id));
    const recentClass = classes.some(c => mine.has(String(c.id)) && c.class_date >= recentFrom);
    const standing = [
      { ok: !!m.active, label: 'Active member' },
      { ok: c1, label: `Call response requirement met (${K.fmtPct(basis.pct)} of ${rules.callResponse.minPct}%)` },
      { ok: c2, label: 'Training requirement met' },
      { ok: recentCall || recentClass, label: `Responded to a call or attended a class in the last ${rules.professional.recentDays} days` },
    ];
    const goodStanding = standing.every(s => s.ok);
    const c5 = goodStanding;

    // --- Categories (what the toggles control) ------------------------------------------------------------
    const cats = [
      { n: 1, name: 'Call response', on: c1 },
      { n: 2, name: 'Training participation', on: c2 },
      { n: 3, name: 'Special projects, committees or extra duties', on: c3 },
      { n: 4, name: 'Meeting participation', on: c4 },
      { n: 5, name: 'Professional development & standards', on: c5 },
    ];
    const metCount = cats.filter(c => c.on).length;
    const earnedShare = metCount / shares;
    const perCat = available ? available / shares : null;

    const yn = c => `<span class="yn" data-cat="${c.n}" data-sug="${c.on ? 1 : 0}"><button type="button" class="y${c.on ? ' on' : ''}">Yes</button><button type="button" class="n${c.on ? '' : ' on'}">No</button>${c.n === 3 ? '' : '<small class="chg">changed</small>'}</span>`;
    const sec = (c, req, inner, lead = '') => K.card(`<span class="sn">${c.n}</span> ${esc(c.name)}${req ? ` <span class="req">${req}</span>` : ''}${yn(c)}`, inner, { lead, cls: 'sec' });

    // --- Section bodies -------------------------------------------------------------------------------------
    const callBody = K.table({
      head: ['Period', 'Dates', { label: 'Call %', num: 1 }, { label: 'Calls', num: 1 }, { label: 'Hours', num: 1 }],
      rows: windows.map(w => `<tr${w === basis ? ' class="basis"' : ''}><th scope="row">${w.label}${w === basis ? ' <span class="tag">judged</span>' : ''}</th>
        <td class="dim">${w.dates}${w.sinceStart ? ' <span class="muted">(from start date)</span>' : ''}</td>
        <td class="num strong">${K.fmtPct(w.pct)}</td>
        <td class="num">${K.fmtInt(w.n)} <span class="muted">of ${K.fmtInt(w.total)}</span></td>
        <td class="num">${K.fmtNum(w.hours)}</td></tr>`),
    });

    const trainBody = `<div class="pad">
      ${K.hBars([{ label: 'Training hours', sub: `requires ${K.fmtNum(reqHours)} h`, value: totalHours, display: `${K.fmtNum(totalHours)} h`, color: totalHours >= reqHours ? '#1d6b3a' : '#d98e04' }], { max: Math.max(reqHours, totalHours, 1) })}
      ${K.hBars([{ label: 'In-house attendance', sub: `requires ${rules.training.minInhousePct}%+ of in-house offered`, value: inhouseAttPct || 0, display: K.fmtPct(inhouseAttPct, 0), color: inhouseAttPct !== null && inhouseAttPct >= rules.training.minInhousePct ? '#1d6b3a' : '#d98e04' }], { max: 100 })}
    </div>
    ${K.table({
      head: ['', { label: 'Hours', num: 1 }, { label: 'Classes', num: 1 }],
      rows: [
        `<tr><th scope="row">Total training attended</th><td class="num strong">${K.fmtNum(totalHours)}</td><td class="num">${attended.length}</td></tr>`,
        `<tr><th scope="row">In-house attended</th><td class="num strong">${K.fmtNum(inhouseHours)}</td><td class="num">${inhouse.length}</td></tr>`,
        `<tr><th scope="row">In-house offered</th><td class="num">${K.fmtNum(offeredHours)}</td><td class="num">${offered.length}</td></tr>`,
        `<tr class="basis"><th scope="row">In-house attendance <span class="tag">judged</span><br><small class="muted" style="font-weight:400">attended &divide; offered</small></th><td class="num strong">${K.fmtPct(inhouseAttPct)}</td><td class="num"></td></tr>`,
        `<tr><th scope="row">In-house share of total training<br><small class="muted" style="font-weight:400">in-house attended &divide; all training attended</small></th><td class="num">${K.fmtPct(inhousePct)}</td><td class="num"></td></tr>`,
        `<tr><th scope="row">Outside the department</th><td class="num">${K.fmtNum(totalHours - inhouseHours)}</td><td class="num">${attended.length - inhouse.length}</td></tr>`,
        `<tr><th scope="row">Times as lead instructor</th><td class="num"></td><td class="num strong">${lead.length}</td></tr>`,
      ],
    })}
    ${lead.length ? `<details class="more"><summary>Classes led (${lead.length})</summary>${listTable(lead.map(c => [c.class_date, c.name, c.hours]))}</details>` : ''}`;

    // Entered by the chief; not in the data. Printed with the report.
    const extraBody = '<textarea class="notes proj" rows="3" placeholder="Projects, committees or extra duties (entered by the chief)"></textarea>';

    const meetBody = K.table({
      head: ['Meeting', { label: 'Held', num: 1 }, { label: 'Attended', num: 1 }, { label: '%', num: 1 }, { label: 'Hours', num: 1 }],
      rows: meetRows.map(r => r.held
        ? `<tr${r.primary ? ' class="basis"' : ''}><th scope="row">${esc(r.label)}${r.primary ? ' <span class="tag">judged</span>' : ''}</th><td class="num">${r.held}</td><td class="num strong">${r.came}</td><td class="num">${K.fmtPct(r.came / r.held * 100, 0)}</td><td class="num">${K.fmtNum(r.hours)}</td></tr>`
        : `<tr><th scope="row">${esc(r.label)}</th><td colspan="4" class="muted">None recorded in the system</td></tr>`),
    });

    const stdBody = K.table({
      head: ['Item', 'Result'],
      rows: [
        `<tr><th scope="row">Attend officer training</th><td>${officerClasses.length ? `<b>${K.fmtNum(sum(officerClasses, c => c.hours))}</b> hours &middot; ${officerClasses.length} class${officerClasses.length === 1 ? '' : 'es'}` : '<span class="muted">None</span>'}</td></tr>`,
        `<tr><th scope="row">Course work or seminars</th><td>${courseClasses.length ? `<b>${K.fmtNum(sum(courseClasses, c => c.hours))}</b> hours &middot; ${courseClasses.length} class${courseClasses.length === 1 ? '' : 'es'}` : '<span class="muted">None</span>'}</td></tr>`,
        `<tr><th scope="row">Uphold department values</th><td class="muted">Chief to assess</td></tr>`,
        `<tr><th scope="row">Member in good standing<br><small class="muted" style="font-weight:400">suggested from the metrics</small></th><td><span class="${goodStanding ? 'good' : 'bad'}">${goodStanding ? 'Yes' : 'Not yet'}</span>
          <ul class="chk">${standing.map(s => `<li class="${s.ok ? 'ok' : 'no'}">${s.ok ? '✓' : '✗'} ${esc(s.label)}</li>`).join('')}</ul></td></tr>`,
        `<tr><th scope="row">Other</th><td class="muted">&mdash;</td></tr>`,
      ],
    }) + ((officerClasses.length || courseClasses.length) ? `<details class="more"><summary>Classes behind the hours</summary>${listTable([...officerClasses.map(c => [c.class_date, `${c.name} (officer)`, c.hours]), ...courseClasses.map(c => [c.class_date, `${c.name} (course / seminar)`, c.hours])])}</details>` : '');

    // --- Header, tiles, summary -------------------------------------------------------------------------------
    const yearLabel = range.start.slice(0, 4) === range.end.slice(0, 4) ? range.end.slice(0, 4) : `${range.start.slice(0, 4)}–${range.end.slice(0, 4)}`;
    const head = `<section class="card form-head"><dl>
      <div><dt>Name</dt><dd>${esc(m.name)}</dd></div>
      <div><dt>Job</dt><dd>${esc(m.rank || '—')}${m.active ? '' : ' <span class="tag tag-f">Former</span>'}</dd></div>
      <div><dt>Review period</dt><dd>${esc(K.fmtDate(range.start))} – ${esc(K.fmtDate(range.end))}</dd></div>
      <div><dt>Calendar year</dt><dd>${yearLabel}</dd></div>
      <div><dt>Date prepared</dt><dd>${esc(K.fmtDate(range.today))}</dd></div>
      <div><dt>Total available stipend</dt><dd>${available ? money(available) : '<span class="muted noprint-hint">enter above</span>'}</dd></div>
    </dl>
    <p class="lead" style="padding:8px 0 0">Each category contributes ${K.fmtNum(100 / shares)}% of the total stipend. Yes / No answers are suggested from the data (special projects start at No for the chief to set); use the toggles to change them.</p></section>`;

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Stipend earned', accent: true, value: `<span id="t-earned">${available ? money(available * earnedShare) : K.fmtPct(earnedShare * 100, 0)}</span>`, sub: [available ? `of ${money(available)} available` : 'enter the available amount to see dollars'] })}
      ${K.tile({ title: 'Categories met', value: `<span id="t-met">${metCount}</span> <small style="font-size:1rem;color:#777">/ ${shares}</small>`, sub: [`${K.fmtNum(100 / shares)}% each`] })}
      ${K.tile({ title: 'Call response', value: K.fmtPct(basis.pct), sub: [`${basis.label.toLowerCase()} &middot; needs ${rules.callResponse.minPct}%`] })}
      ${K.tile({ title: 'Training', value: `${K.fmtNum(totalHours)} h`, sub: [`${K.fmtPct(inhouseAttPct, 0)} of in-house attended (needs ${rules.training.minInhousePct}%)`, `needs ${K.fmtNum(reqHours)} h total`] })}
    </div>`;

    const summary = K.card('Total stipend earned', `
      <div class="tw"><table id="stipend" data-avail="${available || 0}" data-shares="${shares}">
        <thead><tr><th>Category</th><th class="num">Answer</th><th class="num">${available ? 'Amount' : 'Share'}</th></tr></thead>
        <tbody>${cats.map(c => `<tr data-row="${c.n}"><th scope="row">${c.n}. ${esc(c.name)}</th><td class="num stat ${c.on ? 'good' : 'bad'}">${c.on ? 'Yes' : 'No'}</td><td class="num amt">${c.on ? (perCat ? money(perCat) : K.fmtPct(100 / shares, 0)) : (perCat ? money(0) : '0%')}</td></tr>`).join('')}</tbody>
        <tfoot><tr class="total"><th scope="row">Total stipend earned</th><td class="num"></td><td class="num" id="t-total">${available ? money(available * earnedShare) : K.fmtPct(earnedShare * 100, 0)}</td></tr></tfoot>
      </table></div>`, { cls: 'sum' });

    const signoff = `<section class="card signoff"><h2>Notes &amp; sign-off</h2>
      <textarea class="notes" rows="3" placeholder="Notes (printed with the report)"></textarea>
      <div class="sig"><div><span>Member signature</span></div><div class="d"><span>Date</span></div></div>
      <div class="sig"><div><span>Fire Chief signature</span></div><div class="d"><span>Date</span></div></div></section>`;

    const body = `${head}${tiles}
      ${sec(cats[0], `${rules.callResponse.minPct}% response requirement`, callBody, 'Share of all department calls since the member started. Hours come from payroll time on incident responses.')}
      ${sec(cats[1], `${rules.training.minHoursPerYear} hours, attending at least ${rules.training.minInhousePct}% of in-house`, trainBody, years === 1 ? '' : `Requirement prorated to the review period (${K.fmtNum(years, 2)} years).`)}
      ${sec(cats[2], 'entered by the chief', extraBody, 'Not taken from the data (activities are not projects or committees). The chief records what applies and sets Yes or No.')}
      ${sec(cats[3], `at least ${rules.meetings.minAttendPct}% of ${esc(primary.label.toLowerCase())}s`, meetBody, 'From the events log. Meetings that are not recorded as events (for example Officers or Fire Board) show as none recorded.')}
      ${sec(cats[4], '', stdBody)}
      ${summary}${signoff}
      <p class="note"><strong>How this is worked out.</strong> Call response is the share of all department incidents (from the member's start date) that the member responded to, judged on the <em>${basis.label.toLowerCase()}</em>; the 6- and 12-month figures end on ${esc(K.fmtDate(range.end))}.
        Training counts the scheduled hours of every class attended; "in-house" is the department's in-house type, and in-house attendance is the in-house hours the member attended &divide; the in-house hours offered since they started (the share of total training is shown for reference only). Lead instructor counts classes where the member is listed as ${esc(rules.training.leadTypes.join(' / '))}.
        Meeting participation comes from the events log; special projects, committees and extra duties are not in the data, so the chief enters them and answers Yes / No (it starts at No). The rules, thresholds and which events count as which meeting are in <code>rules</code> under <code>stipend_review</code> in reports.js.
        "Good standing" is only a suggestion built from the metrics above, and "Uphold department values" is left for the chief. The Yes / No toggles are not saved: they reset when the page is reloaded.</p>`;

    const css = `${quickCss}
      .form-head dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 18px; padding: 14px 16px 4px; }
      .form-head dt { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #777; }
      .form-head dd { font-size: .95rem; font-weight: 600; color: #1e3a5f; margin-top: 2px; }
      .form-head .lead { padding-left: 16px; padding-right: 16px; padding-bottom: 12px; }
      .sec h2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; }
      .sec .sn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: #1e3a5f; color: #fff; font-size: .75rem; }
      .sec .req { font-size: .74rem; font-weight: 400; color: #777; }
      .yn { margin-left: auto; display: inline-flex; align-items: center; gap: 0; }
      .yn button { height: 26px; padding: 0 14px; font-size: .75rem; font-weight: 700; background: #fff; color: #667; border: 1px solid #c5d0de; border-radius: 0; align-self: auto; cursor: pointer; }
      .yn button.y { border-radius: 5px 0 0 5px; } .yn button.n { border-radius: 0 5px 5px 0; border-left: none; }
      .yn button.y.on { background: #1d6b3a; border-color: #1d6b3a; color: #fff; }
      .yn button.n.on { background: #a4372a; border-color: #a4372a; color: #fff; }
      .yn .chg { display: none; margin-left: 8px; font-size: .68rem; color: #9a6a00; font-style: italic; }
      .yn.differs .chg { display: inline; }
      tr.basis > * { background: #f4f8fd; }
      .subtotal { padding: 6px 16px 12px; font-size: .82rem; color: #444; }
      .chk { list-style: none; margin-top: 4px; font-size: .78rem; }
      .chk .ok { color: #1d6b3a; } .chk .no { color: #a4372a; font-weight: 600; }
      .tag-f { background: #eceef1; color: #666; }
      .mini td, .mini th { font-size: .8rem; }
      .sum table { max-width: 640px; }
      .signoff { padding-bottom: 40px; }
      .notes { display: block; width: calc(100% - 32px); margin: 4px 16px 10px; border: 1px solid #d1d5db; border-radius: 5px; padding: 8px 10px; font: inherit; font-size: .85rem; resize: vertical; }
      .sig { display: grid; grid-template-columns: 1fr 190px; gap: 30px; padding: 16px 16px 0; }
      .sig > div { border-bottom: 1px solid #444; height: 22px; position: relative; }
      .sig span { position: absolute; top: 24px; left: 0; font-size: .7rem; color: #666; }
      @media print {
        .yn button:not(.on) { display: none; }
        .yn button { height: auto; padding: 0 10px; font-size: .62rem; border-radius: 9px !important; border: none !important; border-left: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .yn .chg { display: none !important; }
        .form-head dl { padding: 6px 10px 2px; gap: 4px 12px; } .form-head dd { font-size: .74rem; } .form-head dt { font-size: .56rem; }
        .sec h2 { padding-bottom: 3px; } .sec .sn { width: 15px; height: 15px; font-size: .6rem; } .sec .req { font-size: .6rem; }
        .hb { padding: 1px 0; font-size: .68rem; } .hbars { padding: 2px 10px 4px; }
        .chk { font-size: .6rem; margin-top: 1px; }
        .subtotal { font-size: .66rem; padding: 3px 10px 6px; }
        .notes { border: 1px solid #aaa; font-size: .66rem; margin: 2px 10px 6px; width: calc(100% - 20px); }
        .sig { padding: 10px 10px 0; } .sig span { font-size: .56rem; top: 20px; }
        .sig > div { height: 14px; } .signoff { padding-bottom: 30px; }
        .tiles { grid-template-columns: repeat(4, 1fr); }
        .tile-value { font-size: 1.15rem; }
        .noprint-hint { display: none; }
        details.more[open] { display: block; }
        tr.basis > * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }`;

    const script = `
      (function () {
        var tbl = document.getElementById('stipend'); if (!tbl) return;
        var avail = parseFloat(tbl.getAttribute('data-avail')) || 0;
        var shares = parseInt(tbl.getAttribute('data-shares'), 10) || 5;
        function money(v) { return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
        function update() {
          var yes = 0;
          document.querySelectorAll('.yn').forEach(function (g) {
            var on = g.querySelector('.y').classList.contains('on');
            var cat = g.getAttribute('data-cat');
            if (on) yes++;
            g.classList.toggle('differs', (on ? '1' : '0') !== g.getAttribute('data-sug'));
            var row = tbl.querySelector('[data-row="' + cat + '"]');
            var st = row.querySelector('.stat'); st.textContent = on ? 'Yes' : 'No'; st.className = 'num stat ' + (on ? 'good' : 'bad');
            row.querySelector('.amt').textContent = avail ? money(on ? avail / shares : 0) : (on ? Math.round(100 / shares) + '%' : '0%');
          });
          var total = avail ? money(avail * yes / shares) : Math.round(yes / shares * 100) + '%';
          document.getElementById('t-total').textContent = total;
          document.getElementById('t-earned').textContent = total;
          document.getElementById('t-met').textContent = yes;
        }
        document.querySelectorAll('.yn button').forEach(function (b) {
          b.addEventListener('click', function () {
            var g = b.parentNode;
            g.querySelector('.y').classList.toggle('on', b.classList.contains('y'));
            g.querySelector('.n').classList.toggle('on', b.classList.contains('n'));
            update();
          });
        });
        update();
      })();`;

    res.send(K.page({
      report, token, range, filters, body, css, script,
      subtitle: `${esc(m.name)} &mdash; ${esc(range.start)} to ${esc(range.end)}`,
    }));

    // Small date / name / hours table used by the detail lists.
    function listTable(rows) {
      return K.table({
        head: ['Date', 'Event / class', { label: 'Hours', num: 1 }], cls: 'mini',
        rows: rows.map(([d, n, h]) => `<tr><td class="dim" style="white-space:nowrap">${esc(K.fmtDate(d))}</td><td style="white-space:normal">${esc(n)}</td><td class="num">${K.fmtNum(h)}</td></tr>`),
      });
    }

    function filterHtml() {
      const mem = m ? `&member=${encodeURIComponent(m.user_id)}` : '';
      const av = available ? `&available=${available}` : '';
      const tok = encodeURIComponent(token);
      const y = +range.today.slice(0, 4);
      const lim = clamp;
      const link = (label, s, e) => `<a href="?token=${tok}&start=${lim(s)}&end=${e}${mem}${av}">${label}</a>`;
      const opts = [['', 'Select a member…'],
        ...roster.filter(r => r.active).map(r => [r.user_id, r.name]),
        ...roster.filter(r => !r.active && (!r.end_date || r.end_date >= floor)).map(r => [r.user_id, `${r.name} (former)`])];
      return `
        ${K.select('member', 'Member', opts, m ? m.user_id : '')}
        ${K.numberInput('available', 'Total available stipend ($)', available || '', { min: 0, max: 10000000, step: 'any', width: 130 })}
        <div class="fg"><label>Quick range</label><div class="quick">
          ${link('This year', `${y}-01-01`, range.today)}
          ${link('Last year', `${y - 1}-01-01`, `${y - 1}-12-31`)}
          ${link('Last 12 months', K.addDays(K.addMonths(range.today, -12), 1), range.today)}
          ${link('Last 6 months', K.addDays(K.addMonths(range.today, -6), 1), range.today)}
        </div></div>`;
    }
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
