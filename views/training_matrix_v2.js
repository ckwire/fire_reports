// ---------------------------------------------------------------------------
// Training Matrix (v2)
//
// In-house training attendance, judged fairly:
//   * Columns are training NIGHTS (all classes on one date), so two classes on
//     the same night count once and attending either one counts.
//   * A member is only "expected" at nights while they were a member, and only
//     at classes meant for their rank (e.g. Officer Development -> officers).
//   * A make-up class credits the member's most recent missed night.
//   * Weekend classes (EMS Blitz, live burns, certifications) are extras:
//     credit when attended, never counted as a miss.
// Rules live in reports.js (`rules`) so they can be tuned without code changes.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BANDS = [
  { key: 'engaged',    label: 'Engaged',    color: '#1d6b3a' },
  { key: 'regular',    label: 'Regular',    color: '#4a90d9' },
  { key: 'occasional', label: 'Occasional', color: '#d98e04' },
  { key: 'rare',       label: 'Rare',       color: '#a4372a' },
];
// Cell look per status: [css class, symbol, tooltip word]
const CELL = {
  yes:        ['c-yes',  '✓', 'Attended'],
  made:       ['c-made', 'M', 'Missed, made up later'],
  miss:       ['c-miss', '',  'Missed'],
  extra:      ['c-xtra', '+', 'Attended (extra)'],
  mkup:       ['c-xtra', 'M', 'Make-up class attended'],
  na:         ['c-na',   '',  'Not expected'],
  blank:      ['c-blank', '', 'Did not attend (optional)'],
};

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;
  const rules = report.rules || {};
  const re = p => new RegExp(p, 'i');

  try {
    // --- Range: default is the last 12 months -------------------------------------------------
    const range = K.resolveRange(req, report, { defaultYearsBack: 0 });
    if (!ctx.isValidDate(req.query.start)) {
      const s = K.addDays(K.addMonths(range.today, -12), 1);
      range.start = range.min && s < range.min ? range.min : s;
    }
    const sort = ['name', 'pct', 'recent', 'hours'].includes(req.query.sort) ? req.query.sort : 'name';
    const showFormer = req.query.former === '1';
    const groupBy = req.query.group === 'none' ? 'none' : 'status';

    const [classRows, roster] = await Promise.all([
      K.query(report, 'classQuery', [range.start, range.end]),
      K.query(report, 'rosterQuery'),
    ]);
    const attendance = classRows.length ? await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]) : [];

    // --- Classify classes and group into nights ----------------------------------------------
    const makeUpRe = rules.makeUp ? re(rules.makeUp.match) : null;
    const extraRes = (rules.extras || []).map(re);
    const audiences = (rules.audiences || []).map(a => ({ ...a, re: re(a.match), rankRes: (a.ranks || []).map(re) }));

    const classes = classRows.map(c => {
      const weekend = K.dayNumOf(c.class_date) >= 6;
      const makeup = !!(makeUpRe && makeUpRe.test(c.name));
      const extra = !makeup && ((rules.weekendIsExtra && weekend) || extraRes.some(r => r.test(c.name)));
      return { ...c, hours: +c.hours || 0, makeup, extra, audience: audiences.find(a => a.re.test(c.name)) || null };
    });
    const classById = new Map(classes.map(c => [c.id, c]));

    const sessions = [];
    classes.forEach(c => {
      let s = sessions[sessions.length - 1];
      if (!s || s.date !== c.class_date) { s = { date: c.class_date, classes: [] }; sessions.push(s); }
      s.classes.push(c);
    });
    sessions.forEach(s => {
      s.required = s.classes.filter(c => !c.makeup && !c.extra);
      s.kind = s.required.length ? 'night' : (s.classes.every(c => c.makeup) ? 'makeup' : 'extra');
      const main = s.required.find(c => !c.audience) || s.required[0] || s.classes[0];
      s.label = main.name;
      s.more = s.classes.length - 1;
      s.hours = s.required.filter(c => !c.audience).reduce((a, c) => a + c.hours, 0);   // open-to-all hours
    });
    const nights = sessions.filter(s => s.kind === 'night');

    // --- Who attended what ---------------------------------------------------------------------
    const attendedBy = new Map();   // user_id -> Set(class id)
    attendance.forEach(a => {
      if (!attendedBy.has(a.user_id)) attendedBy.set(a.user_id, new Set());
      attendedBy.get(a.user_id).add(a.training_class_id);
    });

    // --- Members in scope ----------------------------------------------------------------------
    const lastAttend = uid => {
      let last = null;
      (attendedBy.get(uid) || new Set()).forEach(id => { const c = classById.get(id); if (c && (!last || c.class_date > last)) last = c.class_date; });
      return last;
    };
    const members = roster.filter(m => {
      if (m.start_date && m.start_date > range.end) return false;
      if (m.active) return true;
      if (!showFormer) return false;
      return (m.end_date && m.end_date >= range.start) || attendedBy.has(m.user_id);
    }).map(m => {
      const last = lastAttend(m.user_id);
      // Former members without an end date are treated as members through their last class.
      const until = m.active ? null : (m.end_date || last || range.start);
      return { ...m, last, until, attended: attendedBy.get(m.user_id) || new Set() };
    });

    // --- Status per member per session ---------------------------------------------------------
    const rankOk = (m, aud) => !aud || aud.rankRes.some(r => r.test(m.rank));
    members.forEach(m => {
      const isMember = d => (!m.start_date || d >= m.start_date) && (!m.until || d <= m.until);
      m.cells = sessions.map(s => {
        const came = s.classes.some(c => m.attended.has(c.id));
        if (!isMember(s.date)) return came ? 'extra' : 'na';
        if (s.kind === 'night') {
          if (!s.required.some(c => rankOk(m, c.audience))) return came ? 'extra' : 'na';
          return came ? 'yes' : 'miss';
        }
        if (s.kind === 'makeup') return came ? 'mkup' : 'blank';
        return came ? 'extra' : 'blank';
      });
      // Make-ups credit the most recent missed night within the window.
      const within = rules.makeUp ? rules.makeUp.withinDays : 0;
      sessions.forEach((s, i) => {
        if (s.kind !== 'makeup' || m.cells[i] !== 'mkup') return;
        for (let j = i - 1; j >= 0; j--) {
          if (K.daysBetween(sessions[j].date, s.date) - 1 > within) break;
          if (m.cells[j] === 'miss') { m.cells[j] = 'made'; m.cells[i] = 'mkup'; return; }
        }
        m.cells[i] = 'extra';   // nothing to make up: still credit as an extra
      });

      const expectedIdx = m.cells.map((c, i) => (c === 'yes' || c === 'miss' || c === 'made') ? i : -1).filter(i => i >= 0);
      const got = idx => idx.filter(i => m.cells[i] !== 'miss').length;
      m.expected = expectedIdx.length;
      m.came = got(expectedIdx);
      m.pct = m.expected ? m.came / m.expected * 100 : null;
      const recent = expectedIdx.slice(-6), prior = expectedIdx.slice(0, -6);
      m.recentPct = recent.length ? got(recent) / recent.length * 100 : null;
      m.priorPct = prior.length >= 3 ? got(prior) / prior.length * 100 : null;
      m.extras = m.cells.filter(c => c === 'extra' || c === 'mkup').length;
      m.hours = [...m.attended].reduce((a, id) => a + ((classById.get(id) || {}).hours || 0), 0);
      let streak = 0;
      for (let k = expectedIdx.length - 1; k >= 0 && m.cells[expectedIdx[k]] === 'miss'; k--) streak++;
      m.streak = streak;
      const b = rules.bands || { engaged: 75, regular: 50, low: 25 };
      m.band = m.pct === null ? null : m.pct >= b.engaged ? 'engaged' : m.pct >= b.regular ? 'regular' : m.pct >= b.low ? 'occasional' : 'rare';
      m.isNew = !!(m.start_date && m.start_date > range.start);
    });

    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const desc = f => (a, b) => (f(b) ?? -1) - (f(a) ?? -1) || byName(a, b);
    members.sort(sort === 'pct' ? desc(m => m.pct) : sort === 'recent' ? desc(m => m.recentPct) : sort === 'hours' ? desc(m => m.hours) : byName);

    // --- Per-session totals --------------------------------------------------------------------
    sessions.forEach((s, i) => {
      s.came = members.filter(m => ['yes', 'made', 'extra', 'mkup'].includes(m.cells[i])).length;
      s.expected = members.filter(m => ['yes', 'made', 'miss'].includes(m.cells[i])).length;
      s.onTime = members.filter(m => m.cells[i] === 'yes').length;
      s.pct = s.kind === 'night' && s.expected ? (s.onTime + members.filter(m => m.cells[i] === 'made').length) / s.expected * 100 : null;
    });

    if (sessions.length === 0) {
      return res.send(K.page({ report, token: req.query.token || '', range, filters: filterHtml(), body: '<p class="empty-msg">No in-house training classes in this range.</p>',
        subtitle: `In-house training &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
    }

    // --- Tiles ---------------------------------------------------------------------------------
    const scored = members.filter(m => m.expected > 0);
    const totExp = scored.reduce((a, m) => a + m.expected, 0), totCame = scored.reduce((a, m) => a + m.came, 0);
    const overall = totExp ? totCame / totExp * 100 : null;
    const engaged = scored.filter(m => m.band === 'engaged').length;
    const follow = members.filter(m => m.active && m.streak >= (rules.followUpMisses || 3)).sort((a, b) => b.streak - a.streak || byName(a, b));
    const neverCame = scored.filter(m => m.came === 0 && m.extras === 0);
    const avgCrew = nights.length ? nights.reduce((a, s) => a + s.came, 0) / nights.length : null;
    const recentNights = nights.slice(-6), earlierNights = nights.slice(0, -6);
    const avgPct = list => { const v = list.map(s => s.pct).filter(x => x !== null); return v.length ? K.mean(v) : null; };
    const recentAvg = avgPct(recentNights), earlierAvg = avgPct(earlierNights);
    const extraCount = sessions.length - nights.length;

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Training nights', value: String(nights.length), sub: [`${K.fmtNum(nights.reduce((a, s) => a + s.hours, 0))} hours offered`, extraCount ? `+ ${extraCount} extra / make-up session${extraCount === 1 ? '' : 's'}` : ''] })}
      ${K.tile({ title: 'Attendance rate', value: K.fmtPct(overall, 0), accent: true, sub: [`${totCame} of ${totExp} expected attendances`, avgCrew !== null ? `${K.fmtNum(avgCrew)} members per night on average` : ''] })}
      ${K.tile({ title: 'Last 6 nights', value: K.fmtPct(recentAvg, 0), sub: [earlierAvg !== null && recentAvg !== null ? `${recentAvg >= earlierAvg ? '▲' : '▼'} ${Math.abs(Math.round(recentAvg - earlierAvg))} pts vs ${K.fmtPct(earlierAvg, 0)} earlier in range` : 'average attendance per night'] })}
      ${K.tile({ title: `Engaged (${(rules.bands || {}).engaged || 75}%+)`, value: `${engaged}<small style="font-size:1rem;color:#777"> / ${scored.length}</small>`, sub: [`${follow.length} need a follow-up`, neverCame.length ? `${neverCame.length} attended none` : ''] })}
    </div>`;

    // --- Matrix --------------------------------------------------------------------------------
    const md = d => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
    const months = [];
    sessions.forEach(s => {
      const key = s.date.slice(0, 7);
      if (!months.length || months[months.length - 1].key !== key) months.push({ key, n: 0 });
      months[months.length - 1].n++;
    });
    // Month bands; the year is shown on the first month and on January when there is room.
    const monthRow = months.map((mo, i) => `<th class="mo${i ? ' ms' : ''}" colspan="${mo.n}">${MONTHS[+mo.key.slice(5, 7) - 1]}${mo.n >= 2 && (i === 0 || mo.key.endsWith('-01')) ? ` ’${mo.key.slice(2, 4)}` : ''}</th>`).join('');
    const short = (t, n) => t.length > n ? t.slice(0, n - 1) + '…' : t;
    const sessTitle = s => s.classes.map(c => `${c.name} (${K.fmtNum(c.hours)} h${c.audience ? ', ' + c.audience.label : ''}${c.makeup ? ', make-up' : ''}${c.extra ? ', extra' : ''})`).join('\n');
    const sessHead = sessions.map((s, i) => `<th class="sh sh-${s.kind}${i > 0 && s.date.slice(0, 7) !== sessions[i - 1].date.slice(0, 7) ? ' ms' : ''}" data-c="${i}" title="${esc(K.fmtDate(s.date) + '\n' + sessTitle(s))}"><span class="sh-d">${md(s.date)}</span><span class="sh-n">${esc(short((s.kind === 'makeup' ? 'Make-up: ' : s.kind === 'extra' ? 'Extra: ' : '') + s.label, 20))}${s.more ? ` +${s.more}` : ''}</span></th>`).join('');

    const bandOf = k => BANDS.find(b => b.key === k);
    const cut = rules.bands || { engaged: 75, regular: 50, low: 25 };
    const bandRange = { engaged: `${cut.engaged}%+`, regular: `${cut.regular}–${cut.engaged - 1}%`, occasional: `${cut.low}–${cut.regular - 1}%`, rare: `under ${cut.low}%` };
    const followN = rules.followUpMisses || 3;
    // First column of each month gets a separator line.
    const monthStart = sessions.map((s, i) => i > 0 && s.date.slice(0, 7) !== sessions[i - 1].date.slice(0, 7));
    const colCls = i => `${monthStart[i] ? ' ms' : ''}${sessions[i].kind !== 'night' ? ' opt' : ''}`;
    const nCols = sessions.length + 7;

    const trend = m => {
      if (m.recentPct === null || m.priorPct === null) return '';
      const d = m.recentPct - m.priorPct;
      if (Math.abs(d) < 15) return '';
      return d > 0 ? ' <span class="up" title="Last 6 nights vs earlier">▲</span>' : ' <span class="down" title="Last 6 nights vs earlier">▼</span>';
    };
    const rateBar = (pct, color) => pct === null ? '<span class="muted">—</span>'
      : `<span class="rb"><span class="rb-t"><i style="width:${Math.max(2, pct).toFixed(0)}%;background:${color}"></i></span><b>${Math.round(pct)}%</b></span>`;

    const rowHtml = m => {
      const band = bandOf(m.band);
      const color = band ? band.color : '#c0c8d4';
      const cells = m.cells.map((c, i) => {
        const [cls, sym, word] = CELL[c];
        return `<td class="cell ${cls}${colCls(i)}" data-c="${i}" title="${esc(`${m.name} — ${K.fmtDate(sessions[i].date)} ${sessions[i].label}: ${word}`)}"><i>${sym}</i></td>`;
      }).join('');
      const flag = m.streak >= followN && m.active ? ` <span class="flag" title="Missed the last ${m.streak} nights in a row">${m.streak} missed</span>` : '';
      return `<tr>
        <th scope="row" class="mname" style="border-left-color:${color}">${esc(m.name)}${m.isNew ? '<span class="tag">New</span>' : ''}${!m.active ? '<span class="tag tag-f">Former</span>' : ''}</th>
        ${cells}
        <td class="sm num first">${m.expected ? `${m.came}<span class="muted">/${m.expected}</span>` : '—'}</td>
        <td class="sm">${rateBar(m.pct, color)}</td>
        <td class="sm num">${m.recentPct === null ? '—' : Math.round(m.recentPct) + '%'}${trend(m)}</td>
        <td class="sm num">${m.extras || ''}</td>
        <td class="sm num">${K.fmtNum(m.hours)}</td>
        <td class="sm num dim">${m.last ? md(m.last) : '—'}</td>
        <td class="sm">${band ? `<span class="band" style="background:${band.color}">${band.label}</span>` : ''}${flag}</td>
      </tr>`;
    };

    // Group rows by status (default) or list them in one block.
    let groups;
    if (groupBy === 'status') {
      const current = members.filter(m => m.active);
      groups = [
        ...BANDS.map(bd => ({ label: bd.label, sub: bandRange[bd.key], color: bd.color, list: current.filter(m => m.band === bd.key) })),
        { label: 'No expected nights', sub: 'joined after the last night', color: '#c0c8d4', list: current.filter(m => m.band === null) },
        { label: 'Former members', sub: 'no longer active', color: '#8a96a8', list: members.filter(m => !m.active) },
      ].filter(g => g.list.length);
    } else {
      groups = [{ label: null, list: members }];
    }
    const rows = groups.map(g => {
      const avg = K.mean(g.list.filter(m => m.pct !== null).map(m => m.pct));
      const head = g.label ? `<tr class="grp"><th class="mname" style="border-left-color:${g.color}"><span class="gdot" style="background:${g.color}"></span>${esc(g.label)} <span class="gsub">${esc(g.sub)} · ${g.list.length} member${g.list.length === 1 ? '' : 's'}${avg !== null ? ` · avg ${Math.round(avg)}%` : ''}</span></th><td colspan="${nCols}"></td></tr>` : '';
      return head + g.list.map(rowHtml).join('');
    }).join('');

    const foot = `
      <tr class="total"><th scope="row" class="mname">Attended</th>${sessions.map((s, i) => `<td class="num${colCls(i)}" data-c="${i}">${s.came}</td>`).join('')}<td class="num first">${totCame}<span class="muted">/${totExp}</span></td><td class="sm">${rateBar(overall, '#1e3a5f')}</td><td colspan="5"></td></tr>
      <tr class="total"><th scope="row" class="mname">% of expected</th>${sessions.map((s, i) => `<td class="num pct${colCls(i)}" data-c="${i}">${s.pct === null ? '' : `<i style="background:${K.heat(s.pct / 100 * 0.75)};${s.pct >= 60 ? 'color:#fff' : ''}">${Math.round(s.pct)}</i>`}</td>`).join('')}<td colspan="7"></td></tr>`;

    const matrix = `<section class="card"><h2>Attendance by training night</h2>
      <p class="lead">Hover any square to highlight its member and night; hover a column heading for the classes held. Columns group every class held on the same date. Lighter columns are optional extra or make-up sessions.</p>
      <div class="mw"><table class="mx" id="mx">
        <thead>
          <tr><th class="mname corner" rowspan="2">Member</th>${monthRow}
            <th class="sm-h first" rowspan="2">Came</th><th class="sm-h" rowspan="2">Rate</th><th class="sm-h" rowspan="2">Last 6</th><th class="sm-h" rowspan="2">Extras</th><th class="sm-h" rowspan="2">Hours</th><th class="sm-h" rowspan="2">Last</th><th class="sm-h" rowspan="2" style="text-align:left">Status</th></tr>
          <tr>${sessHead}</tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>${foot}</tfoot>
      </table></div>
      <div class="legend mlegend">
        <span><span class="lgc c-yes"><i>✓</i></span>Attended</span>
        <span><span class="lgc c-made"><i>M</i></span>Missed, made up later</span>
        <span><span class="lgc c-miss"><i></i></span>Missed</span>
        <span><span class="lgc c-xtra"><i>+</i></span>Extra / optional attended</span>
        <span><span class="lgc c-na"><i></i></span>Not expected (before start, or not their rank)</span>
        <span><span class="up">▲</span><span class="down">▼</span> last 6 nights vs earlier (15+ pts)</span>
      </div>
    </section>`;
    const script = `
      (function () {
        var t = document.getElementById('mx'); if (!t) return;
        var on = null;
        function set(c) {
          if (on !== null) t.querySelectorAll('[data-c="' + on + '"]').forEach(function (e) { e.classList.remove('hc'); });
          on = c;
          if (c !== null) t.querySelectorAll('[data-c="' + c + '"]').forEach(function (e) { e.classList.add('hc'); });
        }
        t.addEventListener('mouseover', function (e) { var td = e.target.closest('[data-c]'); set(td ? td.getAttribute('data-c') : null); });
        t.addEventListener('mouseleave', function () { set(null); });
      })();`;

    // --- Charts and follow-ups ------------------------------------------------------------------
    const roll = nights.map((_, i) => {
      const w = nights.slice(Math.max(0, i - 3), i + 1).map(s => s.pct).filter(v => v !== null);
      return i >= 2 && w.length ? K.mean(w) : null;
    });
    const trendChart = nights.length >= 2 ? K.lineChart({
      labels: nights.map(s => md(s.date)),
      sublabels: nights.map((s, i) => (i === 0 || s.date.slice(0, 4) !== nights[i - 1].date.slice(0, 4)) ? s.date.slice(0, 4) : ''),
      series: [
        { name: 'Attendance', color: '#8a96a8', values: nights.map(s => s.pct), width: 1.5 },
        { name: '4-night average', color: '#1e3a5f', values: roll, dots: false, width: 2.6 },
      ],
      yMax: 100, yFmt: v => `${Math.round(v)}%`, aria: 'Attendance rate per training night',
    }) + K.legend([{ label: 'Each night (% of expected members)', color: '#8a96a8' }, { label: '4-night average', color: '#1e3a5f' }]) : '<p class="lead">Not enough nights to chart.</p>';

    const bandBars = K.hBars(BANDS.map(bd => {
      const list = scored.filter(m => m.band === bd.key);
      return { label: bd.label, sub: bandRange[bd.key], value: list.length, color: bd.color, display: `${list.length}` };
    }), { max: Math.max(scored.length, 1) });

    const followRows = follow.map(m => `<tr><th scope="row">${esc(m.name)}</th>
      <td class="num bad">${m.streak}</td><td class="num dim">${m.last ? esc(K.fmtDate(m.last)) : 'none in range'}</td>
      <td class="num">${m.pct === null ? '—' : Math.round(m.pct) + '%'}</td></tr>`);
    const followCard = K.card(`Follow up: missed ${rules.followUpMisses || 3}+ nights in a row`,
      followRows.length ? K.table({ head: ['Member', { label: 'In a row', num: 1 }, { label: 'Last attended', num: 1 }, { label: 'Rate', num: 1 }], rows: followRows })
        : '<p class="lead"><span class="good">No active member has missed that many in a row.</span></p>',
      { lead: 'Active members whose most recent expected nights were all missed.' });

    const nightRows = nights.slice().reverse().slice(0, 8).map(s => `<tr><td class="dim">${esc(K.fmtDate(s.date))}</td><td style="white-space:normal">${esc(s.classes.filter(c => !c.makeup && !c.extra).map(c => c.name).join(' + '))}</td>
      <td class="num">${s.came}</td><td class="num strong">${s.pct === null ? '—' : Math.round(s.pct) + '%'}</td></tr>`);

    const body = `${tiles}
  ${matrix}
  <div class="grid2">
    ${K.card('Attendance trend', trendChart, { lead: 'Share of expected members at each training night. Is the program gaining or losing people?' })}
    ${K.card('Members by attendance rate', bandBars, { lead: `Active members${showFormer ? ' and former members' : ''} with at least one expected night.` })}
  </div>
  <div class="grid2">
    ${followCard}
    ${K.card('Most recent nights', K.table({ head: ['Date', 'Classes', { label: 'Came', num: 1 }, { label: 'Rate', num: 1 }], rows: nightRows }))}
  </div>
  <p class="note"><strong>How attendance is counted.</strong> Each column is a training night: every in-house class (type 47174) held that date, so attending any class that night counts once.
    A member is expected only at nights after their start date (and before they left), and only at classes meant for their rank${audiences.length ? ` (${esc(audiences.map(a => `"${a.match.replace(/^\^/, '')}" — ${a.label.toLowerCase()}`).join('; '))})` : ''}.
    A make-up class credits the member's most recent missed night within ${rules.makeUp ? rules.makeUp.withinDays : 0} days.
    ${rules.weekendIsExtra ? 'Weekend classes are extras: they add credit and hours, but missing one is not counted against anyone. ' : ''}
    Hours are each attended class's scheduled length (the per-member hours field is often blank or 0). Ranks are current ranks.
    These rules are in <code>rules</code> under <code>training_matrix_v2</code> in reports.js.</p>`;

    const css = `
      .mw { overflow-x: auto; padding: 0 0 2px; }
      table.mx { border-collapse: separate; border-spacing: 0; width: 100%; font-size: .8rem; }
      .mx th, .mx td { border-bottom: 1px solid #f0f2f5; }
      .mx thead th { padding: 4px 3px; text-transform: none; letter-spacing: 0; border-bottom: none; }

      /* Name column: sticky, with a status-coloured stripe */
      .mx .mname { position: sticky; left: 0; z-index: 1; background: #fff; text-align: left; white-space: nowrap; padding: 2px 12px 2px 10px; border-right: 1px solid #e2e5ea; border-left: 4px solid transparent; font-weight: 600; font-size: .8rem; }
      .mx thead .mname { background: #1e3a5f; z-index: 3; vertical-align: bottom; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; border-left-color: #1e3a5f; }
      .mx tfoot .mname { border-left-color: #c0c8d4; }

      /* Headers */
      .mx th.mo { text-align: center; font-size: .68rem; font-weight: 700; background: #16304f; border-left: 1px solid transparent; }
      .mx th.ms { border-left: 2px solid #5f7fa3 !important; }
      .mx th.sh { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; overflow: hidden; height: 150px; max-height: 150px; vertical-align: bottom; text-align: left; padding: 8px 0; font-weight: 600; }
      .mx th.sh.ms { border-left: none !important; border-right: 2px solid #5f7fa3; }   /* rotated: right edge is the visual left */
      .mx th.sh-extra, .mx th.sh-makeup { background: #5a7a9e; }
      .mx th.sh.hc { background: #2f6fb0; }
      .sh-n { font-size: .7rem; } .sh-d { display: inline-block; font-size: .64rem; color: #b9cbe0; font-weight: 700; margin-bottom: 6px; }
      .mx th.sh.hc .sh-d { color: #fff; }
      .mx th.sm-h { vertical-align: bottom; font-size: .64rem; padding: 6px 8px; text-align: right; text-transform: uppercase; letter-spacing: .04em; }
      .mx td.sm { padding: 2px 8px; white-space: nowrap; }
      .mx .first { border-left: 2px solid #c0c8d4 !important; }
      .mx td.sm, .mx th.sm-h, .mx tbody .mname, .mx thead .mname { width: 1%; }   /* hug content; night columns take the spare width */

      /* Attendance squares */
      .mx td.cell { text-align: center; padding: 3px 1px; min-width: 26px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .mx td.ms { border-left: 2px solid #dfe4ea; }
      .mx td.opt { background: #f7f9fb; }
      .cell i, .lgc i { display: inline-block; width: 20px; height: 20px; border-radius: 4px; line-height: 20px; font-style: normal; font-weight: 700; font-size: .72rem; vertical-align: middle; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .c-yes i  { background: #2f8a4e; color: #fff; }
      .c-made i { background: #f2c14e; color: #5c4208; }
      .c-miss i { border: 1.5px solid #e4a39a; background: #fdf3f1; }
      .c-xtra i { background: #4a90d9; color: #fff; }
      .c-na i   { width: 6px; height: 6px; border-radius: 50%; background: #d3d8df; }
      .c-blank i { width: 0; }

      /* Row + column highlight */
      .mx tbody tr:not(.grp):hover > td, .mx tbody tr:not(.grp):hover > th { background: #eef4fb; }
      .mx td.hc { background: #eef4fb; }

      /* Group header rows */
      .mx tr.grp > * { background: #f4f6f9; border-bottom: 1px solid #e2e5ea; border-top: 10px solid #fff; padding: 5px 10px 4px; }
      .mx tr.grp:first-child > * { border-top: none; }
      .mx tr.grp th { font-size: .78rem; font-weight: 700; color: #1e3a5f; text-transform: uppercase; letter-spacing: .04em; }
      .gdot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }
      .gsub { font-weight: 400; color: #7b8797; text-transform: none; letter-spacing: 0; font-size: .74rem; margin-left: 6px; }

      /* Rate bar */
      .rb { display: inline-flex; align-items: center; gap: 6px; }
      .rb-t { display: inline-block; width: 46px; height: 7px; background: #e9edf2; border-radius: 4px; overflow: hidden; }
      .rb-t i { display: block; height: 100%; border-radius: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .rb b { min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; color: #1e3a5f; }

      /* Footer */
      .mx tfoot tr.total > * { background: #f4f6f9 !important; font-weight: 600; }
      .mx tfoot td.num { text-align: center; padding: 3px 1px; font-size: .72rem; }
      .mx tfoot td.first { text-align: right; padding: 3px 8px; }
      .mx tfoot td.pct i { display: inline-block; min-width: 22px; padding: 2px 0; border-radius: 4px; font-style: normal; font-size: .66rem; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .mx tfoot td.hc { background: #dde9f6 !important; }

      .band { display: inline-block; color: #fff; font-size: .64rem; font-weight: 700; padding: 1px 8px; border-radius: 9px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .flag { display: inline-block; font-size: .62rem; font-weight: 700; color: #a4372a; background: #fbe6e3; border-radius: 9px; padding: 1px 7px; margin-left: 3px; }
      .tag-f { background: #eceef1; color: #666; }
      .up { color: #1d6b3a; font-size: .7rem; } .down { color: #a4372a; font-size: .7rem; }
      .mlegend { padding-top: 12px; align-items: center; }
      .lgc { display: inline-block; margin-right: 6px; vertical-align: middle; }
      .lgc i { width: 16px; height: 16px; line-height: 16px; font-size: .62rem; }
      .quick a { font-size: .8rem; color: #2a6db5; text-decoration: none; margin-right: 10px; white-space: nowrap; }
      .quick a:hover { text-decoration: underline; }
      .quick { display: flex; align-items: center; height: 34px; }
      @media print {
        .mx { font-size: .58rem; line-height: 1.1; }
        .mx .mname { padding: 0 5px; font-size: .6rem; }
        .mx tbody th, .mx tbody td, .mx tfoot th, .mx tfoot td { padding-top: 0; padding-bottom: 0; font-size: .56rem; }
        .mx tfoot th { font-size: .58rem !important; }
        .tile-sub { font-size: .56rem; } .tiles { margin-bottom: 6px; }
        .tag { font-size: .48rem; padding: 0 4px; }
        .tile { padding: 5px 10px; } .tile-value { font-size: 1.2rem; } .tile-title { font-size: .58rem; }
        .mlegend { padding-top: 4px; padding-bottom: 6px; font-size: .58rem; }
        .lgc i { width: 11px; height: 11px; line-height: 11px; font-size: .48rem; }
        .card h2 { padding: 5px 10px 3px; }
        .mx th.sh { height: 100px; padding: 3px 0; }
        .sh-n { font-size: .52rem; } .sh-d { font-size: .5rem; margin-bottom: 3px; }
        .mx td.cell { min-width: 14px; padding: 1px 0; }
        .cell i { width: 11px; height: 11px; line-height: 11px; font-size: .48rem; border-radius: 2px; }
        .c-miss i { border-width: 1px; }
        .c-na i { width: 4px; height: 4px; }
        .mx tr.grp > * { padding: 1px 6px; border-top-width: 3px; font-size: .56rem !important; }
        .gsub { font-size: .52rem; }
        .mx td.sm { padding: 0 4px; } .mx th.sm-h { font-size: .5rem; padding: 2px 3px; }
        .rb-t { width: 26px; height: 5px; } .rb b { min-width: 0; }
        .mx tfoot td.num { font-size: .52rem; padding: 0 1px; }
        .mx tfoot td.pct i { font-size: .48rem; min-width: 14px; padding: 0; }
        .band, .flag { font-size: .5rem; padding: 0 4px; }
        .mx thead th, .mx th.mo { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .mx tbody tr:hover > * { background: inherit; }
      }
      @page { size: landscape; margin: 0.6cm; }`;

    res.send(K.page({
      report, token: req.query.token || '', range, filters: filterHtml(), body, css, script,
      subtitle: `In-house training &mdash; ${esc(range.start)} to ${esc(range.end)} &mdash; ${nights.length} training night${nights.length === 1 ? '' : 's'}, ${members.length} member${members.length === 1 ? '' : 's'}`,
    }));

    function filterHtml() {
      const tok = encodeURIComponent(req.query.token || '');
      const extra = `${sort !== 'name' ? `&sort=${sort}` : ''}${showFormer ? '&former=1' : ''}${groupBy === 'none' ? '&group=none' : ''}`;
      const y = +range.today.slice(0, 4);
      const link = (label, s, e) => `<a href="?token=${tok}&start=${s}&end=${e}${extra}">${label}</a>`;
      const floor = d => range.min && d < range.min ? range.min : d;
      return `
        ${K.select('group', 'Group by', [['status', 'Status'], ['none', 'None']], groupBy)}
        ${K.select('sort', 'Sort by', [['name', 'Name'], ['pct', 'Attendance rate'], ['recent', 'Last 6 nights'], ['hours', 'Hours']], sort)}
        ${K.select('former', 'Members', [['', 'Active only'], ['1', 'Include former']], showFormer ? '1' : '')}
        <div class="fg"><label>Quick range</label><div class="quick">
          ${link('Last 12 months', floor(K.addDays(K.addMonths(range.today, -12), 1)), range.today)}
          ${link('This year', floor(`${y}-01-01`), range.today)}
          ${link('Last year', floor(`${y - 1}-01-01`), `${y - 1}-12-31`)}
          ${link('All', range.min || `${y - 1}-01-01`, range.today)}
        </div></div>`;
    }
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
