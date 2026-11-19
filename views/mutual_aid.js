// ---------------------------------------------------------------------------
// Mutual Aid Balance — aid given to and received from neighbouring departments.
//
// Direction is taken from the fields the incident reports actually fill in:
//   Given    = aid_department_name set  (the department we were aiding; these
//              incidents sit outside our district on the map)
//   Received = aid_received_names       (departments that came to our calls)
// aid_type 3 = mutual aid given, 4 = automatic aid given; it is blank from
// 2026, so those calls show as "type not recorded".
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const AID_TYPE = { 3: 'Mutual aid', 4: 'Automatic aid' };

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 2 });
    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);

    // --- One event per (incident, department, direction) ---------------------------------
    const events = [];
    rows.forEach(r => {
      const base = { id: r.id, date: r.alarm_local, address: r.address, type_desc: r.type_desc, category: K.categoryOf(r) };
      if (r.aid_department_name) {
        events.push({ ...base, dir: 'given', dept: r.aid_department_name.trim(),
          kind: AID_TYPE[r.aid_type] || 'Type not recorded', both: !!r.aid_received_names });
      }
      if (r.aid_received_names) {
        const seen = new Set();
        r.aid_received_names.split(/,\s*/).map(s => s.trim()).filter(Boolean).forEach(d => {
          if (seen.has(d)) return; seen.add(d);
          events.push({ ...base, dir: 'received', dept: d, kind: 'Aid received', both: !!r.aid_department_name });
        });
      }
    });

    const given    = events.filter(e => e.dir === 'given');
    const received = events.filter(e => e.dir === 'received');
    const givenCalls    = new Set(given.map(e => e.id)).size;
    const receivedCalls = new Set(received.map(e => e.id)).size;
    const net = givenCalls - receivedCalls;

    // --- By department ---------------------------------------------------------------------
    const depts = new Map();
    events.forEach(e => {
      if (!depts.has(e.dept)) depts.set(e.dept, { name: e.dept, given: 0, received: 0, last: e.date });
      const d = depts.get(e.dept);
      d[e.dir]++;
      if (e.date > d.last) d.last = e.date;
    });
    const deptList = [...depts.values()].sort((a, b) => (b.given + b.received) - (a.given + a.received));
    const maxSide = Math.max(...deptList.flatMap(d => [d.given, d.received]), 1);
    const short = n => n.replace(/\s+(Township\s+)?Fire Department$/i, m => /Township/i.test(m) ? ' Twp' : '').replace(/ Fire Department$/i, '');
    const deptRows = deptList.map(d => {
      const n = d.given - d.received;
      return `<tr>
        <th scope="row" style="white-space:normal">${esc(short(d.name))}</th>
        <td class="num">${d.given}</td><td class="num">${d.received}</td>
        <td class="num strong ${n > 0 ? '' : n < 0 ? '' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}</td>
        <td class="dvcell"><span class="dv"><span class="dv-l"><b style="width:${d.received / maxSide * 100}%"></b></span><span class="dv-r"><b style="width:${d.given / maxSide * 100}%"></b></span></span></td>
        <td class="num dim">${esc(K.fmtDate(d.last))}</td></tr>`;
    });

    // --- Over time ----------------------------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const qIdx = new Map(quarters.map((q, i) => [q.key, i]));
    const qGiven = new Array(quarters.length).fill(0), qRecv = new Array(quarters.length).fill(0);
    const seenG = new Set(), seenR = new Set();
    events.forEach(e => {
      const i = qIdx.get(K.quarterKey(e.date)); if (i === undefined) return;
      if (e.dir === 'given' && !seenG.has(e.id)) { seenG.add(e.id); qGiven[i]++; }
      if (e.dir === 'received' && !seenR.has(e.id)) { seenR.add(e.id); qRecv[i]++; }
    });
    const trend = K.lineChart({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [
        { name: 'Aid given (calls)', values: qGiven, color: '#1e3a5f' },
        { name: 'Aid received (calls)', values: qRecv, color: '#1a8a7d' },
      ], aria: 'Aid given and received by quarter',
    });

    // --- By year ---------------------------------------------------------------------------------
    const years = [...new Set(events.map(e => e.date.slice(0, 4)))].sort();
    const yearRows = years.map(y => {
      const g = new Set(given.filter(e => e.date.startsWith(y)).map(e => e.id)).size;
      const r = new Set(received.filter(e => e.date.startsWith(y)).map(e => e.id)).size;
      return `<tr><th scope="row">${y}</th><td class="num">${g}</td><td class="num">${r}</td><td class="num strong">${g - r > 0 ? '+' : g - r < 0 ? '−' : ''}${Math.abs(g - r)}</td></tr>`;
    });

    // --- Kind of aid given ----------------------------------------------------------------------------
    const kinds = {};
    given.forEach(e => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
    const kindRows = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><th scope="row">${esc(k)}</th><td class="num">${n}</td></tr>`);

    // --- Call types ----------------------------------------------------------------------------------
    const catRow = c => {
      const g = new Set(given.filter(e => e.category === c.key).map(e => e.id)).size;
      const r = new Set(received.filter(e => e.category === c.key).map(e => e.id)).size;
      return g || r ? `<tr><th scope="row"><i class="dot" style="background:${c.color}"></i>${esc(c.label)}</th><td class="num">${g}</td><td class="num">${r}</td></tr>` : '';
    };

    // --- Recent list --------------------------------------------------------------------------------------
    const recent = [...events].sort((a, b) => b.date.localeCompare(a.date));
    const recentRow = e => `<tr><td style="white-space:nowrap">${esc(K.fmtDateTime(e.date))}</td>
      <td><span class="tag" style="${e.dir === 'given' ? '' : 'background:#e6f4f1;color:#1a6b60'}">${e.dir === 'given' ? 'Given' : 'Received'}</span></td>
      <td>${esc(short(e.dept))}${e.both ? ' <span class="muted" title="Both aid fields set on this call">*</span>' : ''}</td>
      <td>${esc(String(e.type_desc || '—'))}</td><td>${esc(String(e.address || '').trim() || '—')}</td></tr>`;
    const recentHead = ['When', 'Direction', 'Department', 'Call', 'Address'];

    const css = `
      .dvcell { width: 34%; min-width: 160px; }
      .dv { display: grid; grid-template-columns: 1fr 1fr; height: 12px; }
      .dv-l, .dv-r { display: flex; background: #f3f5f8; }
      .dv-l { justify-content: flex-end; border-right: 2px solid #c0c8d4; }
      .dv b { display: block; height: 100%; }
      .dv-l b { background: #1a8a7d; border-radius: 3px 0 0 3px; }
      .dv-r b { background: #1e3a5f; border-radius: 0 3px 3px 0; }
      @media print { .dv { height: 9px; } .dv b { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`;

    const body = events.length === 0
      ? `<p class="empty-msg">No mutual aid recorded in this range.</p>`
      : `<div class="tiles">
      ${K.tile({ title: 'Aid given', value: K.fmtInt(givenCalls), sub: ['calls where we aided another department'] })}
      ${K.tile({ title: 'Aid received', value: K.fmtInt(receivedCalls), sub: [`calls where others aided us (${received.length} department responses)`] })}
      ${K.tile({ title: 'Net balance', value: `${net > 0 ? '+' : net < 0 ? '−' : ''}${Math.abs(net)}`, accent: true, sub: [net > 0 ? 'we give more than we receive' : net < 0 ? 'we receive more than we give' : 'evenly balanced'] })}
      ${K.tile({ title: 'Departments', value: String(deptList.length), sub: [deptList[0] ? `most active: ${esc(short(deptList[0].name))}` : ''] })}
    </div>
  <div class="grid2">
    ${K.card('Aid by quarter', `${trend}${K.legend([{ label: 'Given', color: '#1e3a5f' }, { label: 'Received', color: '#1a8a7d' }])}`)}
    ${K.card('By department', K.table({ head: ['Department', { label: 'Given', num: 1 }, { label: 'Received', num: 1 }, { label: 'Net', num: 1 }, 'Received ◂ ▸ Given', { label: 'Last', num: 1 }], rows: deptRows }),
      { lead: 'Net = given minus received. Positive means we help them more than they help us.' })}
  </div>
  <div class="grid2">
    ${K.card('By year', K.table({ head: ['Year', { label: 'Given', num: 1 }, { label: 'Received', num: 1 }, { label: 'Net', num: 1 }], rows: yearRows }))}
    <div>
      ${K.card('Kind of aid given', K.table({ head: ['Kind', { label: 'Calls', num: 1 }], rows: kindRows }))}
      <div style="height:16px"></div>
      ${K.card('By call type', K.table({ head: ['Type', { label: 'Given', num: 1 }, { label: 'Received', num: 1 }], rows: K.CATEGORIES.map(catRow).filter(Boolean) }))}
    </div>
  </div>
  <section class="card"><h2>Aid calls</h2>
    ${K.table({ head: recentHead, rows: recent.slice(0, 15).map(recentRow) })}
    ${recent.length > 15 ? `<details class="more"><summary>Show the other ${recent.length - 15}</summary>${K.table({ head: recentHead, rows: recent.slice(15).map(recentRow) })}</details>` : ''}
  </section>
  <p class="note">Counts are calls, so a call where three departments came to help counts once as "received" and three times in the department list. Direction comes from the incident's aid fields:
    a department named on the call is aid <em>given</em>, and departments listed as responding are aid <em>received</em>. <span class="muted">*</span> marks the few calls where both fields are filled in and the direction is ambiguous; those count both ways.
    "Kind of aid" (mutual vs automatic) is only recorded through 2025.</p>`;

    res.send(K.page({
      report, token: req.query.token || '', range, body, css,
      subtitle: `Aid given and received &mdash; ${esc(range.start)} to ${esc(range.end)}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
