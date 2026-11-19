// ---------------------------------------------------------------------------
// Engagement Early Warning — members drifting below their own norm.
//   ?days=<n>       recent window, ending today (default 90)
//   ?baseline=<n>   months before that used as the member's norm (default 12)
//
// Each active member's recent share of department calls is compared with
// their own share over the baseline. The signal is a binomial z-score:
//   z = (recent% - usual%) / sqrt(usual% * (1 - usual%) / recent calls)
// so a drop only counts as meaningful when it is bigger than normal
// month-to-month wobble. Training (in-house share and hours) and how long since
// the last call / class are shown alongside.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const today = K.localToday();
    const days = Math.min(365, Math.max(14, parseInt(req.query.days, 10) || 90));
    const baselineMonths = Math.min(36, Math.max(3, parseInt(req.query.baseline, 10) || 12));
    const recentStart = K.addDays(today, -(days - 1));
    let baseStart = K.addMonths(recentStart, -baselineMonths);
    if (baseStart < report.minDate) baseStart = report.minDate;
    const baseEnd = K.addDays(recentStart, -1);

    const [incs, roster, classRows] = await Promise.all([
      K.incidentsWithResponders(report, baseStart, today),
      K.query(report, 'rosterQuery'),
      K.query(report, 'classQuery', [baseStart, today]),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);
    const attendedBy = new Map();
    attendance.forEach(a => { if (!attendedBy.has(a.user_id)) attendedBy.set(a.user_id, new Set()); attendedBy.get(a.user_id).add(a.training_class_id); });
    const classes = classRows.map(c => ({ ...c, hours: Number(c.duration_hours) || 0 }));

    // last 12 months, for sparklines
    const months = [];
    for (let k = 11; k >= 0; k--) { const s = K.addMonths(`${today.slice(0, 7)}-01`, -k); months.push({ from: s, to: K.addDays(K.addMonths(s, 1), -1) }); }

    const share = (pid, from, to) => {
      let d = 0, n = 0;
      incs.forEach(i => { if (i.date < from || i.date > to) return; d++; if (i.members.has(pid)) n++; });
      return { n, d, p: d ? n / d : null };
    };
    const training = (uid, from, to) => {
      const att = attendedBy.get(uid) || new Set();
      let ihHeld = 0, ihAtt = 0, hrs = 0, last = null;
      classes.forEach(c => {
        if (c.class_date < from || c.class_date > to) return;
        if (c.is_inhouse) { ihHeld += c.hours; if (att.has(c.id)) ihAtt += c.hours; }
        if (att.has(c.id)) { hrs += c.hours; if (!last || c.class_date > last) last = c.class_date; }
      });
      return { ihHeld, ihAtt, ihP: ihHeld ? ihAtt / ihHeld : null, hrs, last };
    };

    const rows = roster.filter(m => m.active).map(m => {
      const from = m.start_date && m.start_date > baseStart ? m.start_date : baseStart;
      const tooNew = K.daysBetween(from, baseEnd) < 60;
      const recent = share(m.personnel_id, recentStart, today);
      const usual  = tooNew ? null : share(m.personnel_id, from, baseEnd);
      let z = null;
      if (usual && usual.p !== null && recent.d > 0) {
        const p0 = Math.min(Math.max(usual.p, 0.01), 0.99);
        z = (recent.p - usual.p) / Math.sqrt(p0 * (1 - p0) / recent.d);
      }
      const tRecent = training(m.user_id, recentStart, today);
      const tUsual  = tooNew ? null : training(m.user_id, from, baseEnd);
      const hrsPer30 = (t, f, to) => t.hrs / K.daysBetween(f, to) * 30;

      let lastCall = null;
      incs.forEach(i => { if (i.members.has(m.personnel_id) && (!lastCall || i.date > lastCall)) lastCall = i.date; });
      const sinceCall = lastCall ? K.daysBetween(lastCall, today) - 1 : null;
      const lastClass = training(m.user_id, baseStart, today).last;
      const sinceClass = lastClass ? K.daysBetween(lastClass, today) - 1 : null;

      // Status: big statistical drop, or a sharp relative fall from a real
      // baseline, or nothing at all lately.
      let status = 'steady';
      const rel = usual && usual.p ? recent.p / usual.p : null;
      if (tooNew) status = 'new';
      else if ((z !== null && z <= -3) || (usual.p >= 0.1 && rel !== null && rel <= 0.4) || ((sinceCall === null || sinceCall > 60) && (sinceClass === null || sinceClass > 60))) status = 'alert';
      else if ((z !== null && z <= -2) || (usual.p >= 0.1 && rel !== null && rel <= 0.6)) status = 'watch';
      else if (z !== null && z >= 2) status = 'up';

      const spark = months.map(mo => { if (mo.to < from) return null; const s = share(m.personnel_id, mo.from < from ? from : mo.from, mo.to > today ? today : mo.to); return s.p === null ? null : s.p * 100; });

      return { m, recent, usual, z, status, tRecent, tUsual, sinceCall, sinceClass, spark,
        hrsNow: hrsPer30(tRecent, recentStart, today), hrsUsual: tUsual ? hrsPer30(tUsual, from, baseEnd) : null };
    });

    const ORDER = { alert: 0, watch: 1, new: 2, steady: 3, up: 4 };
    rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.z ?? 0) - (b.z ?? 0));
    const TAG = {
      alert:  '<span class="tag" style="background:#f8d3cf;color:#8a2a1e">Alert</span>',
      watch:  '<span class="tag" style="background:#ffe9a8;color:#7a5a10">Watch</span>',
      steady: '<span class="tag" style="background:#eef0f3;color:#555">Steady</span>',
      up:     '<span class="tag" style="background:#c6efce;color:#1d6b3a">Up</span>',
      new:    '<span class="tag">New</span>',
    };
    const count = s => rows.filter(r => r.status === s).length;
    const pctTxt = p => p === null || p === undefined ? '—' : `${(p * 100).toFixed(0)}%`;
    const pts = (a, b) => {
      if (a === null || b === null || a === undefined || b === undefined) return '';
      const d = Math.round((a - b) * 100);
      return d === 0 ? '<span class="muted">0</span>' : `<span class="${d > 0 ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`;
    };
    const ago = d => d === null ? '<span class="muted">none</span>' : d === 0 ? 'today' : `${d} d`;

    const tableRows = rows.map(r => `<tr>
      <th scope="row">${esc(K.shortName(r.m.name))}</th><td>${TAG[r.status]}</td>
      <td class="num strong">${pctTxt(r.recent.p)}</td><td class="num dim">${r.usual ? pctTxt(r.usual.p) : '—'}</td><td class="num">${r.usual ? pts(r.recent.p, r.usual.p) : ''}</td>
      <td class="num">${r.z === null ? '—' : `${r.z >= 0 ? '+' : '−'}${Math.abs(r.z).toFixed(1)}`}</td>
      <td>${K.sparkline(r.spark, { max: Math.max(60, ...r.spark.filter(v => v !== null)), color: r.status === 'alert' ? '#c0392b' : r.status === 'watch' ? '#d98e04' : '#1e3a5f' })}</td>
      <td class="num">${pctTxt(r.tRecent.ihP)}</td><td class="num dim">${r.tUsual ? pctTxt(r.tUsual.ihP) : '—'}</td>
      <td class="num">${K.fmtNum(r.hrsNow)}</td><td class="num dim">${r.hrsUsual === null ? '—' : K.fmtNum(r.hrsUsual)}</td>
      <td class="num">${ago(r.sinceCall)}</td><td class="num">${ago(r.sinceClass)}</td></tr>`);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Alert', value: String(count('alert')), accent: true, sub: ['sharp drop, or no calls or training in 60+ days'] })}
      ${K.tile({ title: 'Watch', value: String(count('watch')), sub: ['noticeably below their usual level'] })}
      ${K.tile({ title: 'Steady', value: String(count('steady')), sub: [`${count('up')} trending up`] })}
      ${K.tile({ title: 'Recent window', value: `${days} d`, sub: [`${esc(K.fmtDate(recentStart))} – ${esc(K.fmtDate(today))}`, `vs ${baselineMonths} months before`] })}
    </div>`;

    const body = `${tiles}
  ${K.card('Members', K.table({
    head: ['Member', 'Status', { label: 'Resp now', num: 1 }, { label: 'Usual', num: 1 }, { label: 'Δ pts', num: 1 }, { label: 'Signal', num: 1 }, '12-month trend',
      { label: 'In-house now', num: 1 }, { label: 'Usual', num: 1 }, { label: 'Hrs / 30 d', num: 1 }, { label: 'Usual', num: 1 }, { label: 'Last call', num: 1 }, { label: 'Last class', num: 1 }],
    rows: tableRows,
  }), { lead: '“Resp” is the share of department calls the member was on. The 12-month trend shows that share month by month. Signal below −2 is a real drop rather than normal variation.' })}
  <p class="note"><strong>How members are flagged:</strong> <em>Alert</em> — the drop in their share of calls is very unlikely to be chance (signal −3 or lower), or they are down to less than 40% of their usual rate, or they have had no calls and no training for 60+ days.
    <em>Watch</em> — signal −2 or lower, or below 60% of their usual rate. <em>New</em> — fewer than 60 days of history before the recent window. Members are compared only with themselves, so a member who has always run fewer calls is not flagged for that.
    Time off, injury or known leave will show up here too; this is a prompt for a conversation, not a judgement.</p>`;

    const filters = `
      ${K.select('days', 'Recent window', [[30, 'Last 30 days'], [60, 'Last 60 days'], [90, 'Last 90 days'], [180, 'Last 180 days']], days)}
      ${K.numberInput('baseline', 'Baseline (months)', baselineMonths, { min: 3, max: 36, width: 90 })}`;

    res.send(K.page({
      report, token: req.query.token || '', range: { min: report.minDate, clamped: false }, rangeControls: false, filters, body,
      subtitle: `Last ${days} days compared with each member's own ${baselineMonths}-month norm &mdash; as of ${esc(today)}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
