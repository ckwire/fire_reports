// ---------------------------------------------------------------------------
// Response Time Map — the district shaded by time to first arrival.
//   ?cell=<km>       grid size: 0.5, 1 (default) or 2 km squares
//   ?min=<n>         fewest timed calls for a square to be shaded (default 3)
//   ?metric=p90|median
//   ?category=<key>  limit to one call type
//
// Calls are binned into a lat/lon grid. Each square is coloured by its 90th
// percentile (or median) alarm-to-arrival time. Uses Leaflet + OpenStreetMap
// in the viewer's browser, like the Hot Spots report.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MAX_VALID = 7200;
// green -> amber -> red across the district's own range (lo..hi seconds), so
// the map shows relative weak spots rather than saturating at one colour.
const colorFor = (val, lo, hi) => {
  const t = hi > lo ? Math.max(0, Math.min(1, (val - lo) / (hi - lo))) : 0.5;
  const stops = [[26, 150, 65], [253, 174, 97], [215, 48, 39]];
  const [a, b, f] = t < 0.5 ? [stops[0], stops[1], t * 2] : [stops[1], stops[2], (t - 0.5) * 2];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`;
};

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const cellKm = ['0.5', '1', '2'].includes(req.query.cell) ? parseFloat(req.query.cell) : 1;
    const minCalls = Math.min(50, Math.max(1, parseInt(req.query.min, 10) || 3));
    const metric = req.query.metric === 'median' ? 'median' : 'p90';
    const categoryKey = K.CATEGORY_BY_KEY[req.query.category] ? req.query.category : '';
    const target = Math.min(60, Math.max(1, parseFloat(req.query.target) || 10));

    const rows = await K.query(report, 'incidentQuery', [range.start, range.end]);
    let calls = rows.map(r => ({ ...r, category: K.categoryOf(r) }))
      .filter(r => r.lat !== null && r.lon !== null && r.tfa !== null && r.tfa > 0 && r.tfa <= MAX_VALID)
      .filter(r => !/standby/i.test(r.unit || '') && String(r.incident_type) !== '571');
    if (categoryKey) calls = calls.filter(r => r.category === categoryKey);

    // Robust centre (median) so far-off mutual-aid calls do not skew the grid origin
    const midLat = K.median(calls.map(c => c.lat)) || 0;
    const dLat = cellKm / 111.32;
    const dLon = cellKm / (111.32 * Math.cos(midLat * Math.PI / 180));
    const cells = new Map();
    calls.forEach(c => {
      const gy = Math.floor(c.lat / dLat), gx = Math.floor(c.lon / dLon);
      const k = `${gy}:${gx}`;
      if (!cells.has(k)) cells.set(k, { gy, gx, list: [] });
      cells.get(k).list.push(c);
    });
    const streetOf = a => String(a || '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/^[0-9]+\s+/, '');
    const shaded = [...cells.values()].filter(c => c.list.length >= minCalls).map(c => {
      const t = c.list.map(x => x.tfa);
      const val = metric === 'p90' ? K.percentile(t, 90) : K.median(t);
      const roads = {};
      c.list.forEach(x => { const s = streetOf(x.address); if (s) roads[s] = (roads[s] || 0) + 1; });
      const topRoads = Object.entries(roads).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
      return {
        ...c, n: c.list.length, val, med: K.median(t), p90: K.percentile(t, 90),
        within: c.list.filter(x => x.tfa <= target * 60).length / c.list.length * 100,
        bounds: [[c.gy * dLat, c.gx * dLon], [(c.gy + 1) * dLat, (c.gx + 1) * dLon]],
        roads: topRoads,
      };
    });
    const sparse = [...cells.values()].filter(c => c.list.length < minCalls).reduce((s, c) => s + c.list.length, 0);

    const lo = K.percentile(shaded.map(c => c.val), 10), hi = K.percentile(shaded.map(c => c.val), 90);
    const mapData = shaded.map(c => ({
      b: c.bounds, color: colorFor(c.val, lo, hi),
      html: `<strong>${K.fmtMin(c.val)}</strong> ${metric === 'p90' ? '90th percentile' : 'median'}<br>${c.n} calls · median ${K.fmtMin(c.med)} · ${Math.round(c.within)}% within ${target} min<br><small>${esc(c.roads.join(', '))}</small>`,
    }));
    const json = JSON.stringify(mapData).replace(/</g, '\\u003c');

    const slow = [...shaded].sort((a, b) => b.val - a.val).slice(0, 12).map(c => `<tr>
      <th scope="row" style="white-space:normal">${esc(c.roads.join(', ') || '—')}</th><td class="num">${c.n}</td>
      <td class="num strong">${K.fmtMin(c.p90)}</td><td class="num">${K.fmtMin(c.med)}</td><td class="num">${K.fmtPct(c.within, 0)}</td></tr>`);
    const fast = [...shaded].sort((a, b) => a.val - b.val).slice(0, 6).map(c => `<tr>
      <th scope="row" style="white-space:normal">${esc(c.roads.join(', ') || '—')}</th><td class="num">${c.n}</td>
      <td class="num strong">${K.fmtMin(c.p90)}</td><td class="num">${K.fmtMin(c.med)}</td><td class="num">${K.fmtPct(c.within, 0)}</td></tr>`);
    const head = ['Area (main roads)', { label: 'Calls', num: 1 }, { label: '90th', num: 1 }, { label: 'Median', num: 1 }, { label: `≤ ${target} min`, num: 1 }];

    const overallP90 = K.percentile(calls.map(c => c.tfa), 90);
    const slowCells = shaded.filter(c => c.p90 > overallP90 * 1.2);
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls mapped', value: K.fmtInt(calls.length), sub: [`${shaded.length} squares with ${minCalls}+ calls`, sparse ? `${sparse} calls in sparser squares not shaded` : ''] })}
      ${K.tile({ title: 'District 90th percentile', value: K.fmtMin(overallP90), accent: true, sub: [`median ${K.fmtMin(K.median(calls.map(c => c.tfa)))}`] })}
      ${K.tile({ title: 'Slowest area', value: shaded.length ? K.fmtMin(Math.max(...shaded.map(c => c.p90))) : '—', sub: [shaded.length ? esc([...shaded].sort((a, b) => b.p90 - a.p90)[0].roads.slice(0, 2).join(', ')) : ''] })}
      ${K.tile({ title: 'Areas 20%+ slower', value: String(slowCells.length), sub: [`${slowCells.reduce((s, c) => s + c.n, 0)} calls in them`] })}
    </div>`;

    const legendStops = shaded.length ? [0, 0.25, 0.5, 0.75, 1].map(f => { const v = lo + (hi - lo) * f;
      return `<span><i style="display:inline-block;width:22px;height:12px;border-radius:2px;vertical-align:middle;margin-right:4px;background:${colorFor(v, lo, hi)}"></i>${f === 0 ? '≤ ' : f === 1 ? '≥ ' : ''}${K.fmtMin(v)}</span>`; }).join('') : '';

    const body = calls.length === 0 ? '<p class="empty-msg">No calls with both coordinates and an arrival time in this selection.</p>' : `${tiles}
  <section class="card"><h2>${metric === 'p90' ? '90th percentile' : 'Median'} time to first arrival, by ${cellKm} km square</h2>
    <p class="lead">Squares with at least ${minCalls} timed calls. Colour is relative to the district: green = the fastest areas, red = the slowest. Click a square for details.</p>
    <div id="map"><p class="empty-msg">Loading map&hellip; (needs internet access to load map tiles)</p></div>
    <div class="legend" style="padding-top:8px">${legendStops}</div>
  </section>
  <div class="grid2">
    ${K.card('Slowest areas', K.table({ head, rows: slow }), { lead: 'Ranked by the selected measure.' })}
    ${K.card('Fastest areas', K.table({ head, rows: fast }))}
  </div>
  <p class="note">Each call is placed by its recorded coordinates; time is alarm to first unit on scene, excluding standby / cover assignments and times over 2 hours. A square's 90th percentile with only a handful of calls is noisy &mdash; raise "Min calls" or use larger squares for a steadier picture.
    Distance from the station is the usual driver of slow areas; road layout, water and volunteer home locations matter too. Map tiles &copy; OpenStreetMap contributors.</p>`;

    const head2 = `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>`;
    const script = `
      (function () {
        var cells = ${json};
        var el = document.getElementById('map');
        if (!window.L || !el || !cells.length) return;
        el.innerHTML = '';
        var map = L.map('map', { scrollWheelZoom: false });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
        var layers = cells.map(function (c) {
          return L.rectangle(c.b, { color: '#fff', weight: 1, fillColor: c.color, fillOpacity: 0.62 }).bindPopup(c.html).addTo(map);
        });
        map.fitBounds(L.featureGroup(layers).getBounds().pad(0.05));
      })();`;
    const css = `#map { height: 500px; background: #e8ecf1; } #map .empty-msg { background: none; } @media print { #map { height: 10cm; } .leaflet-control-zoom { display: none; } }`;

    const filters = `
      ${K.select('metric', 'Measure', [['p90', '90th percentile'], ['median', 'Median']], metric)}
      ${K.select('cell', 'Square size', [['0.5', '½ km'], ['1', '1 km'], ['2', '2 km']], String(cellKm))}
      ${K.numberInput('min', 'Min calls', minCalls, { min: 1, max: 50, width: 70 })}
      ${K.numberInput('target', 'Target (min)', target, { min: 1, max: 60, step: 0.5, width: 84 })}
      ${K.categorySelect(categoryKey)}`;

    res.send(K.page({ report, token: req.query.token || '', range, filters, body, css, head: head2, script,
      subtitle: `Alarm to first arrival by area &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
