// ---------------------------------------------------------------------------
// Call Calendar — one square per day, one row of weeks per year.
// Uses all years (daily incident counts are consistent back to 2019).
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const dowOf = s => (new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7;     // 0 = Mon

// US holidays most likely to affect call volume
function holidays(y) {
  const nth = (m, wd, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7); };
  const last = (m, wd) => { const d = new Date(Date.UTC(y, m + 1, 0)); return iso(y, m, d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)); };
  return new Map([
    [iso(y, 0, 1), "New Year's Day"], [nth(0, 1, 3), 'MLK Day'], [nth(1, 1, 3), "Presidents' Day"],
    [last(4, 1), 'Memorial Day'], [iso(y, 6, 4), 'Independence Day'], [nth(8, 1, 1), 'Labor Day'],
    [iso(y, 9, 31), 'Halloween'], [nth(10, 4, 4), 'Thanksgiving'], [iso(y, 11, 24), 'Christmas Eve'],
    [iso(y, 11, 25), 'Christmas Day'], [iso(y, 11, 31), "New Year's Eve"],
  ]);
}

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 2 });
    const rows = await K.query(report, 'dailyQuery', [range.start, range.end]);
    const byDay = new Map(rows.map(r => [r.d, { n: r.n, types: r.types || '' }]));

    // every day in range
    const days = [];
    for (let d = range.start; d <= range.end; d = K.addDays(d, 1)) days.push(d);
    const counts = days.map(d => (byDay.get(d) || { n: 0 }).n);
    const total = counts.reduce((a, b) => a + b, 0);
    const cap = Math.max(K.percentile(counts, 98) || 1, 1);
    const colorOf = n => n === 0 ? '#ebedf0' : K.heat(0.15 + 0.85 * Math.min(n / cap, 1));

    const hol = new Map();
    for (let y = +range.start.slice(0, 4); y <= +range.end.slice(0, 4); y++) holidays(y).forEach((v, k) => hol.set(k, v));

    // --- One SVG per year ---------------------------------------------------------------------
    const C = 14, G = 3, L = 30, T = 16;
    const yearSvg = y => {
      const jan1 = `${y}-01-01`, dec31 = `${y}-12-31`;
      const off = dowOf(jan1);
      const weeks = Math.ceil((K.daysBetween(jan1, dec31) + off) / 7);
      let cells = '', months = '';
      for (let d = jan1; d <= dec31; d = K.addDays(d, 1)) {
        const idx = K.daysBetween(jan1, d) - 1 + off;
        const x = L + Math.floor(idx / 7) * (C + G), yy = T + (idx % 7) * (C + G);
        if (d.slice(8) === '01') months += `<text x="${x}" y="${T - 5}" class="ml">${MN[+d.slice(5, 7) - 1]}</text>`;
        if (d < range.start || d > range.end) { cells += `<rect x="${x}" y="${yy}" width="${C}" height="${C}" rx="2" fill="#f6f7f9"/>`; continue; }
        const e = byDay.get(d) || { n: 0, types: '' };
        const h = hol.get(d);
        const tip = `${DOW[dowOf(d)]} ${K.fmtDate(d)}${h ? ` — ${h}` : ''}: ${e.n} call${e.n !== 1 ? 's' : ''}${e.types ? `\n${e.types.length > 200 ? e.types.slice(0, 200) + '…' : e.types}` : ''}`;
        cells += `<rect x="${x}" y="${yy}" width="${C}" height="${C}" rx="2" fill="${colorOf(e.n)}"${h ? ' stroke="#c0392b" stroke-width="1.6"' : ''}><title>${esc(tip)}</title></rect>`;
      }
      const W = L + weeks * (C + G) + 4, H = T + 7 * (C + G);
      const dl = [0, 2, 4].map(i => `<text x="${L - 6}" y="${T + i * (C + G) + C - 3}" class="ml" text-anchor="end">${DOW[i]}</text>`).join('');
      const yTotal = days.filter(d => d.startsWith(String(y))).reduce((s, d) => s + (byDay.get(d) || { n: 0 }).n, 0);
      return `<div class="yr"><div class="yr-h"><b>${y}</b> <span>${K.fmtInt(yTotal)} calls</span></div>
        <div class="tw"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="cal">${months}${dl}${cells}</svg></div></div>`;
    };
    const years = [];
    for (let y = +range.end.slice(0, 4); y >= +range.start.slice(0, 4); y--) years.push(y);

    // --- Stats ------------------------------------------------------------------------------------
    const busiest = days.map((d, i) => ({ d, n: counts[i] })).sort((a, b) => b.n - a.n || b.d.localeCompare(a.d));
    const perDay = total / days.length;
    const holDays = days.filter(d => hol.has(d)), normDays = days.filter(d => !hol.has(d));
    const avg = list => list.length ? list.reduce((s, d) => s + (byDay.get(d) || { n: 0 }).n, 0) / list.length : null;
    const quiet = counts.filter(n => n === 0).length;

    const topRows = busiest.slice(0, 12).map(b => `<tr><td style="white-space:nowrap">${DOW[dowOf(b.d)]} ${esc(K.fmtDate(b.d))}${hol.has(b.d) ? ` <span class="tag" style="background:#f8e3e0;color:#8a2a1e">${esc(hol.get(b.d))}</span>` : ''}</td>
      <td class="num strong">${b.n}</td><td style="white-space:normal;font-size:.76rem">${esc(((byDay.get(b.d) || {}).types || '').slice(0, 160))}</td></tr>`);

    const dowAvg = DOW.map((_, i) => avg(days.filter(d => dowOf(d) === i)));
    const dowBars = K.hBars(DOW.map((d, i) => ({ label: d, value: dowAvg[i] || 0, display: (dowAvg[i] || 0).toFixed(2), color: '#1e3a5f' })));

    const monthCells = MN.map((m, mi) => {
      const cells = years.slice().reverse().map(y => {
        const list = days.filter(d => d.startsWith(`${y}-${String(mi + 1).padStart(2, '0')}`));
        const a = avg(list);
        return a === null ? '<td class="num dim">—</td>' : `<td class="num" style="background:${colorOf(a)};color:${a / cap > 0.55 ? '#fff' : '#333'}">${a.toFixed(2)}</td>`;
      }).join('');
      return `<tr><th scope="row">${m}</th>${cells}</tr>`;
    });

    const holRows = [...new Set([...hol.values()])].map(name => {
      const list = holDays.filter(d => hol.get(d) === name);
      if (!list.length) return null;
      const a = avg(list);
      return { name, a, n: list.length };
    }).filter(Boolean).sort((x, y) => y.a - x.a).map(h => `<tr><th scope="row">${esc(h.name)}</th><td class="num">${h.n}</td><td class="num strong">${h.a.toFixed(2)}</td>
      <td class="num ${h.a > perDay ? 'bad' : 'good'}">${h.a >= perDay ? '+' : '−'}${Math.abs((h.a / perDay - 1) * 100).toFixed(0)}%</td></tr>`);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls per day', value: perDay.toFixed(2), accent: true, sub: [`${K.fmtInt(total)} calls over ${K.fmtInt(days.length)} days`] })}
      ${K.tile({ title: 'Busiest day', value: busiest[0] ? String(busiest[0].n) : '—', sub: [busiest[0] ? `${DOW[dowOf(busiest[0].d)]} ${esc(K.fmtDate(busiest[0].d))}` : ''] })}
      ${K.tile({ title: 'Days with no calls', value: K.fmtInt(quiet), sub: [`${K.fmtPct(quiet / days.length * 100, 0)} of days`] })}
      ${K.tile({ title: 'Holidays vs other days', value: avg(holDays) === null ? '—' : `${avg(holDays) >= avg(normDays) ? '+' : '−'}${Math.abs((avg(holDays) / avg(normDays) - 1) * 100).toFixed(0)}%`, sub: [`${(avg(holDays) || 0).toFixed(2)} vs ${(avg(normDays) || 0).toFixed(2)} calls per day`] })}
    </div>`;

    const legend = `<div class="legend"><span>Fewer</span>${[0, 0.25, 0.5, 0.75, 1].map(f => `<i style="display:inline-block;width:14px;height:14px;border-radius:2px;background:${f === 0 ? '#ebedf0' : K.heat(0.15 + 0.85 * f)}"></i>`).join('')}<span>More (${Math.round(cap)}+)</span>
      <span style="margin-left:14px"><i style="display:inline-block;width:12px;height:12px;border:2px solid #c0392b;border-radius:2px;vertical-align:middle"></i> Holiday</span></div>`;

    const css = `
      .yr { padding: 4px 16px 10px; } .yr-h { font-size: .85rem; margin-bottom: 4px; } .yr-h span { color: #888; margin-left: 6px; }
      .cal .ml { font-size: 9px; fill: #888; }
      .cal rect { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

    const body = `${tiles}
  <section class="card"><h2>Every day</h2><p class="lead">Hover a square for the date, count and call types.</p>${years.map(yearSvg).join('')}${legend}</section>
  <div class="grid2">
    ${K.card('Busiest days', K.table({ head: ['Day', { label: 'Calls', num: 1 }, 'What came in'], rows: topRows }))}
    <div>
      ${K.card('Average calls by weekday', dowBars)}
      <div style="height:16px"></div>
      ${K.card('Holidays', holRows.length ? K.table({ head: ['Holiday', { label: 'Days', num: 1 }, { label: 'Calls / day', num: 1 }, { label: 'vs normal', num: 1 }], rows: holRows }) : '<p class="lead">None in range.</p>', { lead: `Compared with ${perDay.toFixed(2)} calls on an average day.` })}
    </div>
  </div>
  ${K.card('Average calls per day, by month', K.table({ head: ['Month', ...years.slice().reverse().map(y => ({ label: String(y), num: 1 }))], rows: monthCells }), { lead: 'Seasonal rhythm year over year.' })}
  <p class="note">Counts are incident reports by local date (${esc(process.env.REPORT_TIMEZONE || 'UTC')}). Colour scale tops out at the 98th-percentile day so one extreme storm doesn't wash out the rest. Holidays are U.S. federal holidays plus Halloween, Christmas Eve and New Year's Eve.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, body, css,
      subtitle: `${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
