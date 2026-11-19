// ---------------------------------------------------------------------------
// Incident Mix Trends — what kinds of calls make up the volume, and which are
// driving growth.
//   ?by=year|quarter   period to group by (default year)
//
// No date floor: NFIRS incident types are consistent back to 2019. From 2025
// incidents are coded in NERIS instead; views/kit.js maps both onto the same
// categories so the trend stays continuous.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 5 });
    const by = req.query.by === 'quarter' ? 'quarter' : 'year';
    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);

    // --- Periods ----------------------------------------------------------------------
    const y0 = +range.start.slice(0, 4), y1 = +range.end.slice(0, 4);
    let periods;
    if (by === 'year') {
      periods = [];
      for (let y = y0; y <= y1; y++) periods.push({ key: String(y), label: String(y), sub: '', from: `${y}-01-01`, to: `${y}-12-31` });
    } else {
      const lastDay = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
      const firstDay = { 1: '01-01', 2: '04-01', 3: '07-01', 4: '10-01' };
      periods = K.quartersBetween(range.start, range.end).map((q, i, arr) => ({
        key: q.key, label: q.label, sub: (q.q === 1 || i === 0) ? String(q.year) : '',
        from: `${q.year}-${firstDay[q.q]}`, to: `${q.year}-${lastDay[q.q]}`,
      }));
    }
    // A period is partial if the chosen range cuts it off at either end.
    periods.forEach(p => { p.partial = p.from < range.start || p.to > range.end; });
    const pIdx = new Map(periods.map((p, i) => [p.key, i]));
    const keyOf = s => by === 'year' ? s.slice(0, 4) : K.quarterKey(s);

    // --- Tally --------------------------------------------------------------------------
    const cat = {};                                   // category -> counts per period
    K.CATEGORIES.forEach(c => { cat[c.key] = new Array(periods.length).fill(0); });
    const types = new Map();                           // type_desc -> {total, per[]}
    const totals = new Array(periods.length).fill(0);
    rows.forEach(r => {
      const i = pIdx.get(keyOf(r.alarm_local)); if (i === undefined) return;
      cat[K.categoryOf(r)][i]++;
      totals[i]++;
      const t = String(r.type_desc || '').trim();
      if (t) {
        if (!types.has(t)) types.set(t, { name: t, total: 0, per: new Array(periods.length).fill(0), cat: K.categoryOf(r) });
        const e = types.get(t); e.total++; e.per[i]++;
      }
    });
    const grand = totals.reduce((a, b) => a + b, 0);
    const used = K.CATEGORIES.filter(c => cat[c.key].some(v => v > 0));

    // --- Tiles --------------------------------------------------------------------------
    const complete = periods.map((p, i) => i).filter(i => !periods[i].partial);
    const first = complete[0], last = complete[complete.length - 1];
    const haveTrend = complete.length >= 2 && totals[first] > 0;
    const totalChange = haveTrend ? totals[last] - totals[first] : null;
    const topCat = used.map(c => ({ c, n: cat[c.key].reduce((a, b) => a + b, 0) })).sort((a, b) => b.n - a.n)[0];
    // largest contributor to growth between first and last complete period
    const drivers = haveTrend
      ? used.map(c => ({ c, d: cat[c.key][last] - cat[c.key][first], a: cat[c.key][first], b: cat[c.key][last] })).sort((a, b) => b.d - a.d)
      : [];

    const periodWord = by === 'year' ? 'year' : 'quarter';
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Incidents in range', value: K.fmtInt(grand), sub: [`${periods.length} ${periodWord}${periods.length !== 1 ? 's' : ''}`] })}
      ${K.tile({ title: 'Largest category', value: topCat ? K.fmtPct(topCat.n / grand * 100, 0) : '—', accent: true, sub: [topCat ? esc(topCat.c.label) : ''] })}
      ${haveTrend ? K.tile({ title: `${esc(periods[first].label)} → ${esc(periods[last].label)}`, value: `${totalChange >= 0 ? '+' : '−'}${K.fmtInt(Math.abs(totalChange))}`,
        sub: [`${K.fmtInt(totals[first])} → ${K.fmtInt(totals[last])} incidents (${totalChange >= 0 ? '+' : '−'}${Math.abs(totalChange / totals[first] * 100).toFixed(1)}%)`] }) : ''}
      ${haveTrend && drivers[0] && drivers[0].d > 0 ? K.tile({ title: 'Biggest growth driver', value: `+${drivers[0].d}`, sub: [esc(drivers[0].c.label), `${drivers[0].a} → ${drivers[0].b}`] }) : ''}
    </div>`;

    // --- Charts ---------------------------------------------------------------------------
    const labels = { labels: periods.map(p => p.label), sublabels: periods.map(p => p.sub) };
    const stack = K.stackedBars({
      ...labels, partial: periods.map(p => p.partial),
      series: used.map(c => ({ name: c.label, color: c.color, values: cat[c.key] })),
      aria: 'Incidents by category', height: 270,
    });
    const shareSeries = used
      .filter(c => cat[c.key].reduce((a, b) => a + b, 0) / Math.max(grand, 1) >= 0.03)
      .map(c => ({ name: c.label, color: c.color, values: cat[c.key].map((v, i) => totals[i] ? v / totals[i] * 100 : null), width: 2.2 }));
    const share = K.lineChart({ ...labels, series: shareSeries, yFmt: v => `${Math.round(v)}%`, aria: 'Share of incidents by category' });

    // --- Table: category x period -------------------------------------------------------------
    const head = ['Category', ...periods.map(p => ({ label: `${esc(p.label)}${p.sub && by === 'quarter' ? ` '${p.sub.slice(2)}` : ''}${p.partial ? '*' : ''}`, num: 1 })), { label: 'Total', num: 1 }, { label: 'Share', num: 1 }];
    const catRows = used.map(c => {
      const t = cat[c.key].reduce((a, b) => a + b, 0);
      return `<tr><th scope="row"><i class="dot" style="background:${c.color}"></i>${esc(c.label)}</th>
        ${cat[c.key].map(v => `<td class="num">${v}</td>`).join('')}
        <td class="num strong">${t}</td><td class="num">${K.fmtPct(t / grand * 100)}</td></tr>`;
    });
    catRows.push(`<tr class="total"><th scope="row">All incidents</th>${totals.map(v => `<td class="num">${v}</td>`).join('')}<td class="num">${grand}</td><td class="num">100%</td></tr>`);

    // --- Growth drivers table --------------------------------------------------------------------
    const driverCard = !haveTrend ? '' : K.card(`What changed: ${esc(periods[first].label)} → ${esc(periods[last].label)}`,
      K.table({
        head: ['Category', { label: esc(periods[first].label), num: 1 }, { label: esc(periods[last].label), num: 1 }, { label: 'Change', num: 1 }, { label: '% change', num: 1 }, { label: 'Share of growth', num: 1 }],
        rows: drivers.map(d => `<tr><th scope="row"><i class="dot" style="background:${d.c.color}"></i>${esc(d.c.label)}</th>
          <td class="num">${d.a}</td><td class="num">${d.b}</td>
          <td class="num strong">${d.d >= 0 ? '+' : '−'}${Math.abs(d.d)}</td>
          <td class="num">${d.a ? `${d.d >= 0 ? '+' : '−'}${Math.abs(d.d / d.a * 100).toFixed(0)}%` : '—'}</td>
          <td class="num">${totalChange && totalChange !== 0 ? K.fmtPct(d.d / totalChange * 100, 0) : '—'}</td></tr>`),
      }),
      { lead: `Compares the first and last complete ${periodWord} in the range${periods.some(p => p.partial) ? ' (partial periods are left out)' : ''}. Share of growth is each category's change as a share of the overall change.` });

    // --- Top specific call types ----------------------------------------------------------------------
    const topTypes = [...types.values()].sort((a, b) => b.total - a.total).slice(0, 12);
    const typeCard = K.card('Most common specific call types', K.table({
      head: ['Call type', ...periods.map(p => ({ label: `${esc(p.label)}${p.sub && by === 'quarter' ? ` '${p.sub.slice(2)}` : ''}${p.partial ? '*' : ''}`, num: 1 })), { label: 'Total', num: 1 }],
      rows: topTypes.map(t => `<tr><th scope="row" style="white-space:normal"><i class="dot" style="background:${K.CATEGORY_BY_KEY[t.cat].color}"></i>${esc(t.name)}</th>${t.per.map(v => `<td class="num">${v}</td>`).join('')}<td class="num strong">${t.total}</td></tr>`),
    }), { lead: 'The wording differs between the older NFIRS descriptions and the newer NERIS names, so the same kind of call can appear on two lines.' });

    const body = grand === 0
      ? `<p class="empty-msg">No incidents in this range.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card(`Incidents by category, per ${periodWord}`, `${stack}${K.legend(used.map(c => ({ label: c.label, color: c.color, box: true })))}`)}
    ${K.card('Share of incidents', `${share}${K.legend(shareSeries.map(s => ({ label: s.name, color: s.color })))}`, { lead: 'Categories with at least 3% of calls.' })}
  </div>
  ${K.card('Counts by category', K.table({ head, rows: catRows }))}
  ${driverCard}
  ${typeCard}
  <p class="note">Categories group NFIRS incident-type codes (used through 2025) and NERIS incident groups (used from 2025) into one common set so the trend is continuous. The mapping is approximate where the two schemes differ (for example, NERIS files vehicle crashes under Medical or Hazardous, so they are matched by name),
    so look for a step change at the 2025&ndash;2026 switchover before reading too much into one year.${periods.some(p => p.partial) ? '* partial period (range starts or ends inside it). ' : ''}Dates are local (${esc(process.env.REPORT_TIMEZONE || 'UTC')}).</p>`;

    const filters = K.select('by', 'Group by', [['year', 'Year'], ['quarter', 'Quarter']], by);

    res.send(K.page({
      report, token: req.query.token || '', range, filters, body,
      subtitle: `Call types over time &mdash; ${esc(range.start)} to ${esc(range.end)}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
