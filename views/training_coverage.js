// ---------------------------------------------------------------------------
// Training Coverage by Topic
//
// Hours by topic and category, who has been reached, and a member x focus-area
// matrix that makes gaps obvious. The focus areas (matrix columns) and their
// optional annual hour targets live in reports.js (`focusAreas`) so they can
// be changed as training records and ISO requirements evolve — no code change.
//
// A "topic" is one entry of a class's topic_names ("CATEGORY - Topic"); a
// class can carry several, and counts toward each.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.max(0, Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / DAY_MS)) + 1;

// "OPERATIONS - Firefighting, EDUCATION - Fire Certifications" -> 2 topics.
// Topic names may contain commas ("Marine, Water and Ice Rescue"), so only split
// where the next piece starts with an UPPER-CASE "CATEGORY - ".
const splitTopics = s => String(s || '').split(/,\s+(?=[A-Z0-9\/& ]+ - )/).map(t => t.trim()).filter(Boolean);

// "Clark, Joshua Daniel" -> "Clark, J." so members who share a surname stay distinct
const shortName = full => {
  const [last, first] = String(full || '').split(',').map(s => s.trim());
  return first ? `${last}, ${first[0]}.` : last;
};

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 0 });
    const rangeDays = daysBetween(range.start, range.end);

    const [classRows, roster] = await Promise.all([
      K.query(report, 'classQuery', [range.start, range.end]),
      K.query(report, 'rosterQuery'),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);

    const classes = classRows.map(c => ({
      ...c, hours: parseFloat(c.duration_hours) || 0,
      topics: splitTopics(c.topic_names), category: String(c.category_name || '').trim(),
    }));
    const byId = new Map(classes.map(c => [c.id, c]));

    // class -> attendee user ids, user -> class ids
    const attendeesOf = new Map(), classesOf = new Map();
    attendance.forEach(a => {
      if (!attendeesOf.has(a.training_class_id)) attendeesOf.set(a.training_class_id, new Set());
      attendeesOf.get(a.training_class_id).add(a.user_id);
      if (!classesOf.has(a.user_id)) classesOf.set(a.user_id, new Set());
      classesOf.get(a.user_id).add(a.training_class_id);
    });
    const rosterIds = new Set(roster.map(m => m.user_id));

    // --- Topic summary ------------------------------------------------------------------------
    const topicMap = new Map();
    classes.forEach(c => {
      const names = c.topics.length ? c.topics : [c.category ? `${c.category} (no topic)` : '(no topic or category)'];
      names.forEach(t => {
        if (!topicMap.has(t)) topicMap.set(t, { name: t, classes: 0, hours: 0, members: new Set(), memberHours: 0, last: c.class_date });
        const e = topicMap.get(t);
        e.classes++; e.hours += c.hours;
        if (c.class_date > e.last) e.last = c.class_date;
        (attendeesOf.get(c.id) || new Set()).forEach(u => { if (rosterIds.has(u)) { e.members.add(u); e.memberHours += c.hours; } });
      });
    });
    const topics = [...topicMap.values()].sort((a, b) => b.hours - a.hours);

    // --- Focus areas & matrix --------------------------------------------------------------------
    const areas = (report.focusAreas || []).map(a => ({ ...a, res: a.match.map(p => new RegExp(p, 'i')) }));
    const matches = (area, c) => area.res.some(re => re.test(c.category) || c.topics.some(t => re.test(t)));
    areas.forEach(a => { a.classIds = new Set(classes.filter(c => matches(a, c)).map(c => c.id)); });

    const hoursIn = (userId, ids) => {
      let h = 0;
      (classesOf.get(userId) || new Set()).forEach(cid => { if (!ids || ids.has(cid)) h += (byId.get(cid) || { hours: 0 }).hours; });
      return h;
    };
    const inhouseIds = new Set(classes.filter(c => c.is_inhouse).map(c => c.id));

    const members = roster.map(m => {
      const startsInRange = m.personnel_start && m.personnel_start > range.start;
      const days = startsInRange ? daysBetween(m.personnel_start, range.end) : rangeDays;
      const cells = areas.map(a => {
        const hours = hoursIn(m.user_id, a.classIds);
        const target = a.annualHours ? a.annualHours * days / 365 : null;
        const status = hours <= 0 ? 'none' : (target && hours < target ? 'part' : 'ok');
        return { hours, target, status };
      });
      return { ...m, startsInRange, cells, total: hoursIn(m.user_id, null), inhouse: hoursIn(m.user_id, inhouseIds) };
    });

    const STATUS_BG = { ok: '#c6efce', part: '#ffe9a8', none: '#f8d3cf' };
    const matrixRows = members.map(m => `<tr>
      <th scope="row" class="mname">${esc(String(m.personnel_full_name || ''))}${m.startsInRange ? '<span class="tag">New</span>' : ''}</th>
      ${m.cells.map(c => `<td class="mc" style="background:${STATUS_BG[c.status]}" title="${K.fmtNum(c.hours)} hrs${c.target ? ` of ${K.fmtNum(c.target)} target` : ''}">${c.hours > 0 ? K.fmtNum(c.hours) : '–'}</td>`).join('')}
      <td class="num strong">${K.fmtNum(m.total)}</td><td class="num">${K.fmtNum(m.inhouse)}</td></tr>`).join('');

    const coverage = areas.map((a, i) => {
      const ok = members.filter(m => m.cells[i].status === 'ok').length;
      return members.length ? ok / members.length * 100 : null;
    });
    const coverRow = `<tr class="total"><th scope="row">Members covered</th>${coverage.map(v => `<td class="num">${v === null ? '—' : Math.round(v) + '%'}</td>`).join('')}<td></td><td></td></tr>`;
    const hoursRow = `<tr class="total"><th scope="row">Class hours held</th>${areas.map(a => `<td class="num">${K.fmtNum(classes.filter(c => a.classIds.has(c.id)).reduce((s, c) => s + c.hours, 0))}</td>`).join('')}<td class="num">${K.fmtNum(classes.reduce((s, c) => s + c.hours, 0))}</td><td class="num">${K.fmtNum(classes.filter(c => c.is_inhouse).reduce((s, c) => s + c.hours, 0))}</td></tr>`;

    const anyTarget = areas.some(a => a.annualHours);

    // --- Gaps list ------------------------------------------------------------------------------------
    const gapRows = areas.map((a, i) => {
      const missing = members.filter(m => m.cells[i].status === 'none');
      const classesHeld = a.classIds.size;
      return { a, missing, classesHeld };
    }).filter(g => g.classesHeld > 0 || g.missing.length === members.length)
      .map(g => `<tr><th scope="row" style="white-space:normal">${esc(g.a.label)}</th>
        <td class="num">${g.classesHeld}</td>
        <td class="num ${g.missing.length ? 'bad' : 'good'}">${g.missing.length}</td>
        <td style="white-space:normal">${g.missing.length ? esc(g.missing.map(m => shortName(m.personnel_full_name)).join('; ')) : '<span class="good">Everyone covered</span>'}</td></tr>`);

    // --- Hours by quarter and category ---------------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const qIdx = new Map(quarters.map((q, i) => [q.key, i]));
    const catHours = new Map();
    classes.forEach(c => {
      const name = c.category || 'Uncategorized';
      if (!catHours.has(name)) catHours.set(name, new Array(quarters.length).fill(0));
      const i = qIdx.get(K.quarterKey(c.class_date)); if (i !== undefined) catHours.get(name)[i] += c.hours;
    });
    const PALETTE = ['#1e3a5f', '#4a90d9', '#c0392b', '#d98e04', '#1a8a7d', '#7b5ea7', '#b5a642', '#8a96a8', '#c9d0da'];
    const catList = [...catHours.entries()].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
    const stack = K.stackedBars({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: catList.map(([name, vals], i) => ({ name, color: PALETTE[i % PALETTE.length], values: vals })),
      yFmt: v => String(Math.round(v)), aria: 'Class hours by quarter and category',
    });

    // --- Record completeness (audit readiness) ------------------------------------------------------------
    const complete = [
      ['Has a duration (hours)',   c => c.hours > 0],
      ['Has a category',           c => !!c.category],
      ['Has at least one topic',   c => c.topics.length > 0],
      ['Has attendees recorded',   c => (attendeesOf.get(c.id) || new Set()).size > 0],
    ];
    const compRows = complete.map(([label, test]) => {
      const n = classes.filter(test).length;
      const pct = classes.length ? n / classes.length * 100 : null;
      return `<tr><th scope="row">${label}</th><td class="num">${n} / ${classes.length}</td><td class="num ${pct === 100 ? 'good' : 'bad'}">${K.fmtPct(pct, 0)}</td></tr>`;
    });
    const incomplete = classes.filter(c => complete.some(([, t]) => !t(c)))
      .sort((a, b) => b.class_date.localeCompare(a.class_date)).slice(0, 12)
      .map(c => `<tr><td style="white-space:nowrap">${esc(K.fmtDate(c.class_date))}</td><td style="white-space:normal">${esc(c.name)}</td>
        <td>${complete.filter(([, t]) => !t(c)).map(([l]) => esc(l.replace(/^Has (a |at least one )?/, 'no ').replace(/ \(hours\)/, ''))).join(', ')}</td></tr>`);

    // --- Tiles ---------------------------------------------------------------------------------------------------
    const totalHours = classes.reduce((s, c) => s + c.hours, 0);
    const memberHours = members.reduce((s, m) => s + m.total, 0);
    const reached = members.filter(m => m.total > 0).length;
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Classes held', value: K.fmtInt(classes.length), sub: [`${K.fmtNum(totalHours)} class hours`, `${classes.filter(c => c.is_inhouse).length} in-house`] })}
      ${K.tile({ title: 'Avg hours per member', value: K.fmtNum(members.length ? memberHours / members.length : null), accent: true, sub: [`${members.length} active members`, rangeDays < 365 ? `over ${rangeDays} days` : ''] })}
      ${K.tile({ title: 'Members with any training', value: K.fmtPct(members.length ? reached / members.length * 100 : null, 0), sub: [`${reached} of ${members.length}`] })}
      ${K.tile({ title: 'Topics covered', value: String(topics.length), sub: [`${areas.filter(a => a.classIds.size).length} of ${areas.length} focus areas had a class`] })}
    </div>`;

    // --- Assemble -----------------------------------------------------------------------------------------------------
    const topicRows = topics.map(t => `<tr><th scope="row" style="white-space:normal">${esc(t.name)}</th>
      <td class="num">${t.classes}</td><td class="num strong">${K.fmtNum(t.hours)}</td>
      <td class="num">${t.members.size} <span class="muted">/ ${roster.length}</span></td>
      <td class="num">${K.fmtPct(roster.length ? t.members.size / roster.length * 100 : null, 0)}</td>
      <td class="num">${t.members.size ? K.fmtNum(t.memberHours / t.members.size) : '—'}</td>
      <td class="num dim">${esc(K.fmtDate(t.last))}</td></tr>`);

    const css = `
      .mname { white-space: nowrap; background: #fff; position: sticky; left: 0; }
      td.mc { text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; min-width: 62px; border-left: 1px solid #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .mx thead th { white-space: normal; text-align: center; vertical-align: bottom; line-height: 1.2; }
      .mx thead th:first-child { text-align: left; }
      .mx .total th, .mx .total td { position: static; }
      .sw-box { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: middle; margin-right: 5px; }
      @media print { td.mc { min-width: 0; padding: 1px 3px; } .mname { padding: 1px 6px; } }`;

    const matrixCard = K.card('Member × focus area (hours attended)', `
      <div class="tw"><table class="mx"><thead><tr><th>Member</th>${areas.map(a => `<th>${esc(a.label)}${a.annualHours ? `<br><small style="font-weight:400">${a.annualHours} h/yr</small>` : ''}</th>`).join('')}<th>All training</th><th>In-house</th></tr></thead>
      <tbody>${matrixRows}${coverRow}${hoursRow}</tbody></table></div>
      <div class="legend" style="padding-top:10px">
        <span><i class="sw-box" style="background:${STATUS_BG.ok}"></i>${anyTarget ? 'Met target / has hours' : 'Has hours'}</span>
        ${anyTarget ? `<span><i class="sw-box" style="background:${STATUS_BG.part}"></i>Some hours, below target</span>` : ''}
        <span><i class="sw-box" style="background:${STATUS_BG.none}"></i>None in this range</span></div>`,
      { lead: anyTarget ? 'Targets are annual hours, prorated to the date range (and to a new member’s start date).' : 'No hour targets are set yet, so this shows coverage only. Set <code>annualHours</code> on a focus area in reports.js to audit against a requirement.' });

    const body = classes.length === 0
      ? `<p class="empty-msg">No training classes in this range.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card('Class hours by quarter', `${stack}${K.legend(catList.map(([n], i) => ({ label: n, color: PALETTE[i % PALETTE.length], box: true })))}`)}
    ${K.card('Gaps by focus area', K.table({ head: ['Focus area', { label: 'Classes', num: 1 }, { label: 'Missing', num: 1 }, 'Members with no hours'], rows: gapRows }),
      { lead: 'Active members with zero hours in each area for this range.' })}
  </div>
  ${matrixCard}
  ${K.card('Topics', K.table({ head: ['Topic', { label: 'Classes', num: 1 }, { label: 'Hours', num: 1 }, { label: 'Members reached', num: 1 }, { label: '% of roster', num: 1 }, { label: 'Avg hrs / member', num: 1 }, { label: 'Last held', num: 1 }], rows: topicRows }),
    { lead: 'A class with several topics counts toward each, so topic hours add up to more than total class hours.' })}
  <div class="grid2">
    ${K.card('Record completeness', `${K.table({ head: ['Check', { label: 'Classes', num: 1 }, { label: '%', num: 1 }], rows: compRows })}`,
      { lead: 'What an auditor would look for on each class record.' })}
    ${incomplete.length ? K.card('Classes to tidy up', K.table({ head: ['Date', 'Class', 'Missing'], rows: incomplete }), { lead: `Most recent ${incomplete.length} with a gap.` }) : K.card('Classes to tidy up', '<p class="lead" style="padding:8px 16px 16px"><span class="good">Every class record is complete.</span></p>')}
  </div>
  <p class="note">Hours are the class's scheduled duration for each member who attended; the roster is active members only. Focus areas match a class by its category or topic names (see <code>focusAreas</code> in reports.js, where the match patterns and any ISO or policy hour targets are set).
    This report starts in 2024 because earlier training records have no categories or topics. Targets shipped with the report are blank until set.</p>`;

    res.send(K.page({
      report, token: req.query.token || '', range, body, css,
      subtitle: `Training by topic &mdash; ${esc(range.start)} to ${esc(range.end)}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
