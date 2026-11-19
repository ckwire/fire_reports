// ---------------------------------------------------------------------------
// Simultaneous Calls — how often a new call arrives while another is active.
//
// A call is "active" from its alarm until the last unit clears (or alarm +
// recorded duration when no clear time exists). Calls whose active windows
// touch are grouped into an "episode"; its peak is the most calls active at
// once. The service-level question this answers: how often is the department
// splitting its resources, and do second calls get slower responses?
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MAX_ACTIVE_SECONDS = 8 * 3600;      // cap runaway durations (bad clear times)
const MAX_VALID_TFA      = 7200;

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);

    // --- Build call windows -------------------------------------------------------
    let noEnd = 0;
    const all = [];
    rows.forEach(r => {
      const t0 = Number(r.t0);
      let t1 = r.t1 === null ? null : Number(r.t1);
      if (t1 === null || isNaN(t1) || t1 < t0) { if (r.t0 !== null) noEnd++; return; }
      t1 = Math.min(Math.max(t1, t0 + 60), t0 + MAX_ACTIVE_SECONDS);     // at least a minute, at most 8 h
      const date = r.alarm_local.slice(0, 10);
      all.push({
        ...r, t0, t1, tfa: r.tfa === null ? null : Number(r.tfa), category: K.categoryOf(r),
        inRange: date >= range.start && date <= range.end,
        hour: K.hourOf(r.alarm_local),
      });
    });
    all.sort((a, b) => a.t0 - b.t0);

    // --- Sweep: level at each call's start + episodes -----------------------------
    const episodes = [];
    let cur = null;
    all.forEach((c, i) => {
      // how many earlier calls are still active when this one starts
      let active = 0;
      for (let j = i - 1; j >= 0 && all[j].t0 > c.t0 - MAX_ACTIVE_SECONDS; j--) if (all[j].t1 > c.t0) active++;
      c.level = 1 + active;

      if (cur && c.t0 < cur.end) { cur.calls.push(c); cur.end = Math.max(cur.end, c.t1); }
      else { cur = { calls: [c], start: c.t0, end: c.t1 }; episodes.push(cur); }
    });

    episodes.forEach(e => {
      e.peak = Math.max(...e.calls.map(c => c.level));
      e.size = e.calls.length;
      // minutes with two or more calls active (sweep the episode's own window)
      const ev = [];
      e.calls.forEach(c => { ev.push([c.t0, 1], [c.t1, -1]); });
      ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let n = 0, last = ev[0][0], multi = 0;
      ev.forEach(([t, d]) => { if (n >= 2) multi += t - last; n += d; last = t; });
      e.multiSeconds = multi;
      e.inRange = e.calls[0].inRange;
      e.calls.forEach(c => { c.episode = e; c.involved = e.size > 1; });
    });

    const scope = all.filter(c => c.inRange);
    const later = scope.filter(c => c.level >= 2);           // arrived while another was active
    const involved = scope.filter(c => c.involved);
    const multiEps = episodes.filter(e => e.size > 1 && e.inRange);
    const peakEp = multiEps.reduce((b, e) => (!b || e.peak > b.peak || (e.peak === b.peak && e.multiSeconds > b.multiSeconds)) ? e : b, null);
    const multiHours = multiEps.reduce((a, e) => a + e.multiSeconds, 0) / 3600;
    const pct = (n, d) => d ? n / d * 100 : null;

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls analyzed', value: K.fmtInt(scope.length), sub: [noEnd ? `${noEnd} skipped (no clear time or duration)` : ''] })}
      ${K.tile({ title: 'Arrived during another call', value: K.fmtPct(pct(later.length, scope.length)), accent: true, sub: [`${K.fmtInt(later.length)} of ${K.fmtInt(scope.length)} calls`, `${K.fmtInt(involved.length)} calls were part of an overlap`] })}
      ${K.tile({ title: 'Most at once', value: peakEp ? String(peakEp.peak) : '—', sub: [peakEp ? `${esc(K.fmtDateTime(peakEp.calls[0].alarm_local))}` : ''] })}
      ${K.tile({ title: 'Time with 2+ active', value: `${K.fmtNum(multiHours)} h`, sub: [`${K.fmtInt(multiEps.length)} overlapping episodes`] })}
    </div>`;

    // --- By quarter --------------------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const qIdx = new Map(quarters.map((q, i) => [q.key, i]));
    const two = new Array(quarters.length).fill(0), threePlus = new Array(quarters.length).fill(0), qTotal = new Array(quarters.length).fill(0);
    scope.forEach(c => {
      const i = qIdx.get(K.quarterKey(c.alarm_local)); if (i === undefined) return;
      qTotal[i]++;
      if (c.level === 2) two[i]++; else if (c.level >= 3) threePlus[i]++;
    });
    const qChart = K.stackedBars({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [{ name: 'Arrived with 1 other active', color: '#d98e04', values: two }, { name: 'Arrived with 2+ others active', color: '#c0392b', values: threePlus }],
      aria: 'Calls that arrived during another call, by quarter',
    });
    const qPctLine = K.lineChart({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [{ name: '% of calls arriving during another', values: qTotal.map((t, i) => t ? (two[i] + threePlus[i]) / t * 100 : null), color: '#1e3a5f' }],
      yFmt: v => `${Math.round(v)}%`, aria: 'Share of calls arriving during another, by quarter',
    });

    // --- By hour ---------------------------------------------------------------------------
    const hourTotal = new Array(24).fill(0), hourLater = new Array(24).fill(0);
    scope.forEach(c => { hourTotal[c.hour]++; if (c.level >= 2) hourLater[c.hour]++; });
    const hourChart = K.stackedBars({
      labels: hourTotal.map((_, h) => String(h)),
      series: [{ name: 'Arrived during another call', color: '#d98e04', values: hourLater }],
      aria: 'Calls that arrived during another, by hour', height: 210, totals: false,
    });

    // --- Does a second call get a slower response? ------------------------------------------
    const tfaOK = list => list.filter(c => c.tfa !== null && c.tfa > 0 && c.tfa <= MAX_VALID_TFA).map(c => c.tfa);
    const idle = scope.filter(c => c.level === 1), busy = later;
    const impactRow = (label, list) => {
      const t = tfaOK(list);
      return `<tr><th scope="row">${label}</th><td class="num">${K.fmtInt(list.length)}</td><td class="num">${K.fmtInt(t.length)}</td><td class="num strong">${K.fmtMin(K.median(t))}</td><td class="num">${K.fmtMin(K.percentile(t, 90))}</td></tr>`;
    };
    const impact = K.table({
      head: ['Call arrived…', { label: 'Calls', num: 1 }, { label: 'Timed', num: 1 }, { label: 'Median', num: 1 }, { label: '90th', num: 1 }],
      rows: [impactRow('with nothing else active', idle), impactRow('during another call', busy)],
    });
    const mIdle = K.median(tfaOK(idle)), mBusy = K.median(tfaOK(busy));
    const impactNote = mIdle && mBusy
      ? `Median first-arrival time is ${Math.abs(Math.round((mBusy - mIdle) / 60 * 10) / 10)} min ${mBusy >= mIdle ? 'slower' : 'faster'} when a call arrives during another. Overlaps often happen in storms and busy stretches when members are already out, so this is not a like-for-like comparison.` : '';

    // --- Biggest episodes ---------------------------------------------------------------------
    const top = [...multiEps].sort((a, b) => b.peak - a.peak || b.multiSeconds - a.multiSeconds).slice(0, 15).map(e => {
      const types = e.calls.slice(0, 3).map(c => String(c.type_desc || 'Call')).join('; ') + (e.calls.length > 3 ? `; +${e.calls.length - 3} more` : '');
      return `<tr><td style="white-space:nowrap">${esc(K.fmtDateTime(e.calls[0].alarm_local))}</td>
        <td class="num strong">${e.peak}</td><td class="num">${e.size}</td>
        <td class="num">${Math.round(e.multiSeconds / 60)} min</td>
        <td>${esc(types)}</td></tr>`;
    });

    const body = scope.length === 0
      ? `<p class="empty-msg">No calls with timing information in this range.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card('Calls arriving during another call, by quarter', `${qChart}${K.legend([{ label: '1 other active', color: '#d98e04', box: true }, { label: '2+ others active', color: '#c0392b', box: true }])}`)}
    ${K.card('Share of calls arriving during another', qPctLine)}
  </div>
  <div class="grid2">
    ${K.card('By hour of day', hourChart, { lead: 'When overlapping calls come in (local time).' })}
    ${K.card('Do second calls get slower responses?', `${impact}${impactNote ? `<p class="lead" style="padding-top:8px">${impactNote}</p>` : ''}`)}
  </div>
  ${K.card('Biggest overlaps', K.table({ head: ['Started', { label: 'Peak at once', num: 1 }, { label: 'Calls', num: 1 }, { label: 'Time with 2+', num: 1 }, 'What came in'], rows: top }),
    { lead: 'Ranked by most calls active at the same time, then by how long they overlapped.' })}
  <p class="note">A call counts as active from its alarm until the last unit clears (or alarm plus recorded duration when there is no clear time); active time is capped at 8 hours to guard against bad clear times.
    "Arrived during another call" means at least one earlier call was still active when it came in. Calls chained together across time are grouped into one overlapping episode.
    Overlaps involving the first and last day of the range are measured using the adjoining days. Times are ${esc(process.env.REPORT_TIMEZONE || 'UTC')}.</p>`;

    res.send(K.page({
      report, token: req.query.token || '', range, body,
      subtitle: `Overlapping calls &mdash; ${esc(range.start)} to ${esc(range.end)}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
