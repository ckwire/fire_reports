// ---------------------------------------------------------------------------
// Weather & Calls — call types by temperature, wind and condition, plus the
// weather on surge days.
//   ?surge=<n>   calls in a day that counts as a surge day (default 5)
//
// Weather is recorded on each incident (2024+), so the data shows the weather
// when calls happened, not on quiet days. That supports "what kinds of calls
// come with cold / wind" (mix and surge days) but not "how many more calls per
// cold day" — that would need weather for every day.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MS_TO_MPH = 2.23694;
const TEMP_BANDS = [[-99, 20, 'Below 20°F'], [20, 32, '20–32°F (freezing)'], [32, 50, '32–50°F'], [50, 70, '50–70°F'], [70, 85, '70–85°F'], [85, 999, '85°F and up']];
const WIND_BANDS = [[0, 10, 'Calm–breezy (under 10 mph)'], [10, 20, 'Windy (10–20 mph)'], [20, 30, 'Strong (20–30 mph)'], [30, 999, 'Very strong (30+ mph)']];

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const surge = Math.min(30, Math.max(2, parseInt(req.query.surge, 10) || 5));
    const labels = report.weatherCodeLabels || {};
    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);

    const calls = rows.map(r => ({ ...r, category: K.categoryOf(r), date: r.alarm_local.slice(0, 10),
      mph: r.wind_ms === null ? null : r.wind_ms * MS_TO_MPH }));
    const withW = calls.filter(c => c.temp_f !== null);
    const overall = {};
    withW.forEach(c => { overall[c.category] = (overall[c.category] || 0) + 1; });
    const typeOverall = {};
    withW.forEach(c => { const t = String(c.type_desc || '').trim(); if (t) typeOverall[t] = (typeOverall[t] || 0) + 1; });

    // Band analysis: count, share, mix, and what is over-represented (lift)
    const bandStats = (list, bands, valueOf) => bands.map(([lo, hi, label]) => {
      const inBand = list.filter(c => { const v = valueOf(c); return v !== null && v >= lo && v < hi; });
      const mix = {};
      inBand.forEach(c => { mix[c.category] = (mix[c.category] || 0) + 1; });
      const types = {};
      inBand.forEach(c => { const t = String(c.type_desc || '').trim(); if (t) types[t] = (types[t] || 0) + 1; });
      const lifts = Object.entries(types).filter(([, n]) => n >= 4)
        .map(([t, n]) => ({ t, n, lift: (n / inBand.length) / (typeOverall[t] / list.length) }))
        .filter(x => x.lift >= 1.5).sort((a, b) => b.lift - a.lift).slice(0, 2);
      return { label, n: inBand.length, mix, lifts };
    }).filter(b => b.n > 0);

    const temp = bandStats(withW, TEMP_BANDS, c => c.temp_f);
    const wind = bandStats(withW.filter(c => c.mph !== null), WIND_BANDS, c => c.mph);

    const mixChart = bands => K.stackedBars({
      labels: bands.map(b => b.label.split(' (')[0].replace('Calm–breezy', 'Calm').replace('Very strong', '30+ mph')),
      series: K.CATEGORIES.filter(c => bands.some(b => b.mix[c.key])).map(c => ({ name: c.label, color: c.color, values: bands.map(b => b.n ? (b.mix[c.key] || 0) / b.n * 100 : 0) })),
      yFmt: v => `${Math.round(v)}%`, totals: false, aria: 'Call mix by band', height: 220, yMax: 100,
    });
    const bandRows = bands => bands.map(b => {
      const top = K.CATEGORIES.map(c => ({ c, share: (b.mix[c.key] || 0) / b.n, base: (overall[c.key] || 0) / withW.length }))
        .filter(x => x.share > 0 && x.base > 0 && (b.mix[x.c.key] || 0) >= 3).map(x => ({ ...x, lift: x.share / x.base })).sort((a, z) => z.lift - a.lift)[0];
      return `<tr><th scope="row">${esc(b.label)}</th><td class="num strong">${b.n}</td><td class="num">${K.fmtPct(b.n / withW.length * 100, 0)}</td>
        <td>${top && top.lift >= 1.2 ? `<i class="dot" style="background:${top.c.color}"></i>${esc(top.c.label)} <span class="muted">${top.lift.toFixed(1)}×</span>` : '<span class="muted">—</span>'}</td>
        <td style="white-space:normal;font-size:.78rem">${b.lifts.map(l => `${esc(l.t)} <span class="muted">(${l.n}, ${l.lift.toFixed(1)}×)</span>`).join('; ') || '<span class="muted">—</span>'}</td></tr>`;
    });
    const bandHead = ['Conditions', { label: 'Calls', num: 1 }, { label: 'Share', num: 1 }, 'Call type over-represented', 'Specific calls more common than usual'];

    // --- Condition codes ---------------------------------------------------------------------------
    const codes = {};
    withW.forEach(c => { const k = c.wcode || '—'; if (!codes[k]) codes[k] = []; codes[k].push(c); });
    const codeRows = Object.entries(codes).sort((a, b) => b[1].length - a[1].length).map(([k, list]) => {
      const top = Object.entries(list.reduce((m, c) => { const t = String(c.type_desc || '').trim(); if (t) m[t] = (m[t] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join('; ');
      return `<tr><th scope="row">${labels[k] ? esc(labels[k]) : `Code ${esc(k)}`}</th><td class="num">${list.length}</td>
        <td class="num">${K.fmtNum(K.mean(list.map(c => c.temp_f)))}°F</td><td class="num">${K.fmtNum(K.mean(list.filter(c => c.mph !== null).map(c => c.mph)))} mph</td>
        <td style="white-space:normal;font-size:.78rem">${esc(top)}</td></tr>`;
    });

    // --- Surge days -------------------------------------------------------------------------------------
    const byDay = new Map();
    calls.forEach(c => { if (!byDay.has(c.date)) byDay.set(c.date, []); byDay.get(c.date).push(c); });
    const dayCount = byDay.size ? [...byDay.values()].map(l => l.length) : [];
    const days = K.daysBetween(range.start, range.end);
    const surgeDays = [...byDay.entries()].filter(([, l]) => l.length >= surge).sort((a, b) => b[1].length - a[1].length || b[0].localeCompare(a[0]));
    const surgeRows = surgeDays.slice(0, 20).map(([d, l]) => {
      const t = l.filter(c => c.temp_f !== null);
      const types = Object.entries(l.reduce((m, c) => { m[c.category] = (m[c.category] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, n]) => `<i class="dot" style="background:${K.CATEGORY_BY_KEY[k].color}"></i>${esc(K.CATEGORY_BY_KEY[k].label)} ${n}`).join(' &nbsp; ');
      const cs = [...new Set(l.map(c => c.wcode).filter(Boolean))].map(k => labels[k] || k).join(', ');
      return `<tr><td style="white-space:nowrap">${esc(K.fmtDate(d))}</td><td class="num strong">${l.length}</td>
        <td class="num">${t.length ? `${Math.round(Math.min(...t.map(c => c.temp_f)))}–${Math.round(Math.max(...t.map(c => c.temp_f)))}°F` : '—'}</td>
        <td class="num">${t.some(c => c.mph !== null) ? `${Math.round(Math.max(...t.filter(c => c.mph !== null).map(c => c.mph)))} mph` : '—'}</td>
        <td class="dim">${esc(cs)}</td><td style="white-space:normal;font-size:.78rem">${types}</td></tr>`;
    });
    const surgeWind = surgeDays.flatMap(([, l]) => l).filter(c => c.mph !== null);
    const normalWind = calls.filter(c => c.mph !== null && !surgeDays.some(([d]) => d === c.date));

    const freezing = withW.filter(c => c.temp_f < 32).length;
    const windy = withW.filter(c => c.mph !== null && c.mph >= 20).length;
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls with weather', value: K.fmtInt(withW.length), sub: [`of ${K.fmtInt(calls.length)} calls`] })}
      ${K.tile({ title: 'Below freezing', value: K.fmtPct(withW.length ? freezing / withW.length * 100 : null, 0), sub: [`${freezing} calls under 32°F`] })}
      ${K.tile({ title: 'Wind 20+ mph', value: K.fmtInt(windy), sub: [`${K.fmtPct(withW.length ? windy / withW.length * 100 : null, 0)} of calls`] })}
      ${K.tile({ title: `Surge days (${surge}+ calls)`, value: String(surgeDays.length), accent: true, sub: [
        surgeWind.length && normalWind.length ? `peak wind avg ${Math.round(K.mean(surgeWind.map(c => c.mph)))} mph vs ${Math.round(K.mean(normalWind.map(c => c.mph)))} on other days` : '',
        `${K.fmtPct(surgeDays.length / days * 100, 1)} of days`] })}
    </div>`;

    const legend = K.legend(K.CATEGORIES.filter(c => overall[c.key]).map(c => ({ label: c.label, color: c.color, box: true })));
    const body = withW.length === 0 ? '<p class="empty-msg">No weather recorded on calls in this range.</p>' : `${tiles}
  <div class="grid2">
    ${K.card('Call mix by temperature', `${mixChart(temp)}${legend}`, { lead: 'Each bar is 100% of the calls in that temperature band.' })}
    ${K.card('Call mix by wind', `${mixChart(wind)}${legend}`, { lead: 'Each bar is 100% of the calls in that wind band.' })}
  </div>
  ${K.card('By temperature', K.table({ head: bandHead, rows: bandRowsSafe(bandRows, temp) }), { lead: '“×” = how many times more common than across all calls.' })}
  ${K.card('By wind', K.table({ head: bandHead, rows: bandRowsSafe(bandRows, wind) }))}
  <div class="grid2">
    ${K.card(`Surge days (${surge}+ calls)`, surgeRows.length ? K.table({ head: ['Day', { label: 'Calls', num: 1 }, { label: 'Temp', num: 1 }, { label: 'Peak wind', num: 1 }, 'Conditions', 'Main call types'], rows: surgeRows }) : '<p class="lead" style="padding:4px 16px 14px">No surge days in this range.</p>')}
    ${K.card('By weather condition code', K.table({ head: ['Condition', { label: 'Calls', num: 1 }, { label: 'Avg temp', num: 1 }, { label: 'Avg wind', num: 1 }, 'Most common calls'], rows: codeRows }),
      { lead: Object.keys(labels).length ? '' : 'The database stores conditions as numeric codes without names. Add names in <code>weatherCodeLabels</code> in reports.js once you know them (e.g. from the incident form).' })}
  </div>
  <p class="note">Weather is the conditions recorded on each incident, so this shows the weather <em>when calls happened</em>. It tells you which calls come with cold, heat or wind and what surge days look like, but not how many extra calls a cold or windy day brings — that would need the weather for quiet days too.
    Wind is stored in metres per second and shown in mph. ${days} days in range; ${withW.length} of ${calls.length} calls have weather recorded.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, body,
      filters: K.numberInput('surge', 'Surge day (calls)', surge, { min: 2, max: 30, width: 90 }),
      subtitle: `Conditions on calls &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

// small guard so an empty band list renders an empty table instead of failing
const bandRowsSafe = (fn, bands) => bands.length ? fn(bands) : [];

module.exports = { handle };
