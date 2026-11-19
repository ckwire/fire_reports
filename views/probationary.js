// ---------------------------------------------------------------------------
// Probationary Progress — how new members ramp up.
//   ?months=<n>   length of the probationary window (default 12)
//
// "Probationary" is not a reliable field in the data (only two former members
// carry that rank), so it is defined by start date: a member is probationary
// for their first N months. The cohort is everyone who started on or after the
// data floor (2024-01-01), including members who have since left, so current
// recruits can be read against how earlier ones progressed.
//
// For each member, over their own window:
//   response %  = calls they were on / department calls since they started
//   baseline    = median of the same measure for established active members
//                 over the SAME calendar dates
//   in-house %  = in-house class hours attended / in-house hours held
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const addMonths = (s, k) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1 + k, +s.slice(8, 10))).toISOString().slice(0, 10);
const prevDay = s => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const minDate = (...ds) => ds.filter(Boolean).reduce((a, b) => (a < b ? a : b));
// whole months from start to date (0 until the first month is complete)
const monthsBetween = (start, date) => { let k = 0; while (addMonths(start, k + 1) <= date) k++; return k; };

const shortName = full => {
  const [last, first] = String(full || '').split(',').map(s => s.trim());
  return first ? `${last}, ${first}` : last;
};

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const today = K.localToday();
    const floor = report.minDate;
    const months = Math.min(24, Math.max(3, parseInt(req.query.months, 10) || 12));

    const [roster, incidents, responses, classRows] = await Promise.all([
      K.query(report, 'rosterQuery'),
      K.query(report, 'incidentQuery', [floor, today]),
      K.query(report, 'responseQuery', [floor, today]),
      K.query(report, 'classQuery', [floor, today]),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);

    // --- Lookups --------------------------------------------------------------------------
    const incs = incidents.map(r => ({ id: r.id, date: r.alarm_local.slice(0, 10) })).sort((a, b) => a.date.localeCompare(b.date));
    const classes = classRows.map(c => ({ id: c.id, date: c.class_date, hours: parseFloat(c.duration_hours) || 0, inhouse: !!c.is_inhouse }));
    const setsBy = (rows, k, v) => { const m = new Map(); rows.forEach(r => { if (!m.has(r[k])) m.set(r[k], new Set()); m.get(r[k]).add(r[v]); }); return m; };
    const respondedBy = setsBy(responses, 'personnel_id', 'incident_report_id');
    const attendedBy  = setsBy(attendance, 'user_id', 'training_class_id');

    // Last day each member appears on an incident (used when a departed member has no end date)
    const lastSeen = new Map();
    const dateOf = new Map(incs.map(i => [i.id, i.date]));
    respondedBy.forEach((set, pid) => { let m = null; set.forEach(id => { const d = dateOf.get(id); if (d && (!m || d > m)) m = d; }); if (m) lastSeen.set(pid, m); });

    // Counts over an inclusive date window for one member
    const measure = (m, from, to) => {
      const resp = respondedBy.get(m.personnel_id) || new Set();
      let incD = 0, incN = 0;
      for (const i of incs) { if (i.date < from) continue; if (i.date > to) break; incD++; if (resp.has(i.id)) incN++; }
      const att = attendedBy.get(m.user_id) || new Set();
      let ihD = 0, ihN = 0, totN = 0;
      classes.forEach(c => {
        if (c.date < from || c.date > to) return;
        if (c.inhouse) { ihD += c.hours; if (att.has(c.id)) ihN += c.hours; }
        if (att.has(c.id)) totN += c.hours;
      });
      return { incN, incD, ihN, ihD, totN };
    };
    const pct = (n, d) => d > 0 ? n / d * 100 : null;

    // --- Who is who ---------------------------------------------------------------------------
    const people = roster.map(m => {
      const start = m.personnel_start;
      let left = null;
      if (m.personnel_end && m.personnel_end <= today) left = m.personnel_end;
      else if (!m.personnel_is_active) left = m.personnel_end || lastSeen.get(m.personnel_id) || start;
      return { ...m, start, left };
    });
    const established = people.filter(m => m.personnel_is_active && !m.left);
    const cohort = people.filter(m => m.start && m.start >= floor).sort((a, b) => b.start.localeCompare(a.start) || a.personnel_full_name.localeCompare(b.personnel_full_name));

    const recruits = cohort.map(m => {
      const windowEnd = minDate(prevDay(addMonths(m.start, months)), m.left || today, today);
      const finished = !m.left && addMonths(m.start, months) <= today;
      const current  = !m.left && !finished;
      const own = measure(m, m.start, windowEnd);

      // Established members over the same calendar window (the fair yardstick)
      const peers = established.filter(p => p.personnel_id !== m.personnel_id && (!p.start || p.start < m.start));
      const peerRes = peers.map(p => { const x = measure(p, m.start, windowEnd); return { r: pct(x.incN, x.incD), t: pct(x.ihN, x.ihD) }; });
      const peerResp = K.median(peerRes.map(x => x.r));
      const peerIn   = K.median(peerRes.map(x => x.t));

      // Month-by-month ramp (only months that have fully elapsed within the window)
      const ramp = [];
      for (let k = 1; k <= months; k++) {
        const end = prevDay(addMonths(m.start, k));
        if (end > windowEnd) { ramp.push({ resp: null, hrs: null, inhouse: null }); continue; }
        const x = measure(m, m.start, end);
        ramp.push({ resp: pct(x.incN, x.incD), hrs: x.totN, inhouse: pct(x.ihN, x.ihD) });
      }
      const monthsServed = monthsBetween(m.start, windowEnd);
      return { ...m, windowEnd, finished, current, own, peerResp, peerIn, ramp, monthsServed, peerCount: peers.length };
    });

    const current = recruits.filter(r => r.current);
    const left    = recruits.filter(r => r.left);
    const active  = recruits.filter(r => !r.left);

    // --- Tiles ----------------------------------------------------------------------------------
    const avg = list => { const v = list.filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const curResp = avg(current.map(r => pct(r.own.incN, r.own.incD)));
    const curPeer = avg(current.map(r => r.peerResp));
    const curIn   = avg(current.map(r => pct(r.own.ihN, r.own.ihD)));
    const curInPeer = avg(current.map(r => r.peerIn));
    const diffTxt = (a, b) => a === null || b === null ? '' : `<span class="${a - b >= 0 ? 'good' : 'bad'}">${a - b >= 0 ? '▲ +' : '▼ −'}${Math.abs(a - b).toFixed(1)} pts</span> vs established ${K.fmtPct(b)}`;
    const leftMonths = left.map(r => monthsBetween(r.start, r.left));

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'In probation now', value: String(current.length), sub: [current.length
        ? (current[0].start === current[current.length - 1].start
          ? `started ${esc(K.fmtDate(current[0].start))}`
          : `started ${esc(K.fmtDate(current[current.length - 1].start))} – ${esc(K.fmtDate(current[0].start))}`)
        : 'no one in their first ' + months + ' months'] })}
      ${K.tile({ title: 'Avg response %', value: K.fmtPct(curResp), accent: true, sub: [diffTxt(curResp, curPeer), 'current probationers, since each started'] })}
      ${K.tile({ title: 'Avg in-house training %', value: K.fmtPct(curIn), sub: [diffTxt(curIn, curInPeer)] })}
      ${K.tile({ title: `Recruits since ${floor.slice(0, 4)}`, value: String(recruits.length), sub: [`${active.length} still active, ${left.length} left`, left.length ? `left after a median ${K.fmtNum(K.median(leftMonths))} months` : ''] })}
    </div>`;

    // --- Charts -----------------------------------------------------------------------------------
    const PALETTE = ['#1e3a5f', '#c0392b', '#1a8a7d', '#d98e04', '#7b5ea7', '#4a90d9', '#b5a642', '#e07b9a'];
    const colorOf = new Map(current.map((r, i) => [r.personnel_id, PALETTE[i % PALETTE.length]]));
    const seriesFor = pick => {
      const others = recruits.filter(r => !r.current).map(r => ({
        name: `${shortName(r.personnel_full_name)}${r.left ? ' (left)' : ' (completed)'}`, color: '#c3cad4', width: 1.6, dots: false,
        values: r.ramp.map(pick),
      }));
      const cur = current.map(r => ({ name: shortName(r.personnel_full_name), color: colorOf.get(r.personnel_id), width: 2.8, values: r.ramp.map(pick) }));
      return [...others, ...cur];
    };
    const xs = { labels: Array.from({ length: months }, (_, i) => String(i + 1)) };
    const estOverall = (() => {
      const vals = established.map(p => { const x = measure(p, floor, today); return pct(x.incN, x.incD); });
      return K.median(vals);
    })();

    const respChart = K.lineChart({ ...xs, series: seriesFor(x => x.resp), yFmt: v => `${Math.round(v)}%`, yMax: 100,
      refLines: estOverall === null ? [] : [{ value: estOverall, label: `established median ${estOverall.toFixed(0)}%`, color: '#8a96a8' }], aria: 'Cumulative response percentage by month of service' });
    const hrsChart = K.lineChart({ ...xs, series: seriesFor(x => x.hrs), yFmt: v => String(Math.round(v)), aria: 'Cumulative training hours by month of service' });

    const legend = K.legend([
      ...current.map(r => ({ label: shortName(r.personnel_full_name), color: colorOf.get(r.personnel_id) })),
      ...(recruits.some(r => !r.current) ? [{ label: 'Earlier recruits', color: '#c3cad4' }] : []),
    ]);

    // --- Table -----------------------------------------------------------------------------------------
    const status = r => r.left ? `<span class="tag" style="background:#f8e3e0;color:#8a2a1e">Left ${esc(K.fmtDate(r.left))}</span>`
      : r.finished ? '<span class="tag" style="background:#e6f4f1;color:#1a6b60">Completed</span>'
      : `<span class="tag">Month ${monthsBetween(r.start, today) + 1} of ${months}</span>`;
    const dc = (a, b) => a === null || b === null ? '<span class="muted">—</span>' : `<span class="${a - b >= 0 ? 'good' : 'bad'}">${a - b >= 0 ? '+' : '−'}${Math.abs(a - b).toFixed(1)}</span>`;
    const rows = recruits.map(r => {
      const rp = pct(r.own.incN, r.own.incD), ip = pct(r.own.ihN, r.own.ihD);
      return `<tr${r.current ? ' style="background:#f7fbff"' : ''}>
        <th scope="row" style="white-space:normal">${r.current ? `<i class="dot" style="background:${colorOf.get(r.personnel_id)}"></i>` : '<i class="dot" style="background:#c3cad4"></i>'}${esc(shortName(r.personnel_full_name))}</th>
        <td class="num">${esc(K.fmtDate(r.start))}</td><td>${status(r)}</td>
        <td class="num">${r.own.incN}<span class="muted">/${r.own.incD}</span></td>
        <td class="num strong">${K.fmtPct(rp)}</td><td class="num dim">${K.fmtPct(r.peerResp)}</td><td class="num">${dc(rp, r.peerResp)}</td>
        <td class="num">${K.fmtNum(r.own.ihN)}<span class="muted">/${K.fmtNum(r.own.ihD)}</span></td>
        <td class="num strong">${K.fmtPct(ip)}</td><td class="num dim">${K.fmtPct(r.peerIn)}</td>
        <td class="num">${K.fmtNum(r.own.totN)}</td></tr>`;
    });

    const body = recruits.length === 0
      ? `<p class="empty-msg">No members have started since ${esc(floor)}.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card('Response % by month of service', `${respChart}${legend}`, { lead: 'Cumulative share of department calls the member was on, measured after each completed month.' })}
    ${K.card('Training hours by month of service', `${hrsChart}${legend}`, { lead: 'Cumulative training hours attended (all classes).' })}
  </div>
  ${K.card(`First ${months} months, member by member`, K.table({
    head: ['Member', { label: 'Started', num: 1 }, 'Status', { label: 'Calls', num: 1 }, { label: 'Resp %', num: 1 }, { label: 'Estab.', num: 1 }, { label: 'Δ pts', num: 1 },
      { label: 'In-house hrs', num: 1 }, { label: 'In-house %', num: 1 }, { label: 'Estab.', num: 1 }, { label: 'All hrs', num: 1 }],
    rows,
  }), { lead: '“Estab.” is the median for established active members over the same dates. Calls and hours are each member’s own first-window totals, out of what the department held in that time.' })}
  <p class="note">Members are measured from their start date, and only for as long as they were on the department, up to ${months} months. Established members are active members who started earlier and have not left.
    Response % is the share of all department incidents the member was recorded on; in-house % is in-house class hours attended out of those held. Members whose status is inactive with no end date are measured to their last recorded call.
    “Probationary” is defined here as the first ${months} months because the personnel rank field is not used consistently. The cohort starts ${esc(floor)}, when personnel records on incidents begin.</p>`;

    const filters = K.numberInput('months', 'Window (months)', months, { min: 3, max: 24, width: 90 });

    res.send(K.page({
      report, token: req.query.token || '', range: { min: floor, clamped: false }, rangeControls: false, filters, body,
      subtitle: `First ${months} months of service &mdash; members who started ${esc(floor)} or later`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
