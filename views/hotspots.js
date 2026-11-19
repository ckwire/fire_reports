// ---------------------------------------------------------------------------
// Hot Spots — where calls repeat: a map plus ranked addresses and roads.
//   ?category=<key>   limit to one call type (e.g. Medical / EMS for lift assists)
//   ?min=<n>          minimum calls for an address to appear in the table (default 3)
//
// The map uses Leaflet + OpenStreetMap tiles loaded from public CDNs in the
// viewer's browser; if they are blocked the tables still work.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const categoryKey = K.CATEGORY_BY_KEY[req.query.category] ? req.query.category : '';
    const minCalls = Math.min(50, Math.max(1, parseInt(req.query.min, 10) || 3));

    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);
    let calls = rows.map(r => ({
      ...r, category: K.categoryOf(r),
      lat: r.latitude === null ? null : Number(r.latitude),
      lon: r.longitude === null ? null : Number(r.longitude),
    }));
    if (categoryKey) calls = calls.filter(r => r.category === categoryKey);

    const withAddress = calls.filter(r => r.address);

    // Group helper: key -> { n, cats, types, coords, first, last }
    const group = (list, keyOf) => {
      const m = new Map();
      list.forEach(r => {
        const k = keyOf(r); if (!k) return;
        if (!m.has(k)) m.set(k, { key: k, n: 0, cats: {}, types: {}, lats: [], lons: [], first: r.alarm_local, last: r.alarm_local, addresses: new Set() });
        const g = m.get(k);
        g.n++;
        g.cats[r.category] = (g.cats[r.category] || 0) + 1;
        const t = String(r.type_desc || '').trim(); if (t) g.types[t] = (g.types[t] || 0) + 1;
        if (r.lat !== null && r.lon !== null && !isNaN(r.lat) && !isNaN(r.lon)) { g.lats.push(r.lat); g.lons.push(r.lon); }
        if (r.alarm_local < g.first) g.first = r.alarm_local;
        if (r.alarm_local > g.last)  g.last  = r.alarm_local;
        if (r.address) g.addresses.add(r.address);
      });
      return [...m.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
    };
    const topKey = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
    const topTypes = (g, n = 2) => Object.entries(g.types).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t, c]) => `${t} (${c})`).join('; ');

    const addresses = group(withAddress, r => r.address);
    const streets   = group(withAddress, r => r.street);
    const repeat    = addresses.filter(a => a.n >= minCalls);
    const repeatCalls = repeat.reduce((s, a) => s + a.n, 0);
    const top10Calls = addresses.slice(0, 10).reduce((s, a) => s + a.n, 0);

    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls mapped', value: K.fmtInt(withAddress.length), sub: [`${K.fmtInt(addresses.length)} distinct addresses`, calls.length - withAddress.length ? `${calls.length - withAddress.length} with no address` : ''] })}
      ${K.tile({ title: `Addresses with ${minCalls}+ calls`, value: K.fmtInt(repeat.length), accent: true, sub: [`${K.fmtPct(withAddress.length ? repeatCalls / withAddress.length * 100 : null)} of all calls`] })}
      ${K.tile({ title: 'Top 10 addresses', value: K.fmtPct(withAddress.length ? top10Calls / withAddress.length * 100 : null), sub: [`${K.fmtInt(top10Calls)} calls`] })}
      ${K.tile({ title: 'Busiest address', value: addresses[0] ? String(addresses[0].n) : '—', sub: [addresses[0] ? esc(addresses[0].key) : ''] })}
    </div>`;

    // --- Map data ----------------------------------------------------------------
    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const points = addresses.filter(a => a.lats.length).map(a => {
      const dom = topKey(a.cats)[0];
      return {
        lat: mean(a.lats), lon: mean(a.lons), n: a.n, color: K.CATEGORY_BY_KEY[dom].color,
        html: `<strong>${esc(a.key)}</strong><br>${a.n} call${a.n !== 1 ? 's' : ''}<br><small>${esc(topTypes(a, 3))}<br>Last: ${esc(K.fmtDate(a.last))}</small>`,
      };
    });
    const pointsJson = JSON.stringify(points).replace(/</g, '\\u003c');

    const mapCard = points.length === 0
      ? ''
      : `<section class="card"><h2>Call map</h2>
        <p class="lead">One circle per address; bigger = more calls. Colour is the most common call type there. Click a circle for details.</p>
        <div id="map"><p class="empty-msg" id="map-fallback">Loading map&hellip; (needs internet access to load map tiles)</p></div>
        ${K.legend(K.CATEGORIES.filter(c => points.some(p => p.color === c.color)).map(c => ({ label: c.label, color: c.color, box: true })))}
      </section>`;

    // --- Tables ---------------------------------------------------------------------
    const catDot = g => { const c = K.CATEGORY_BY_KEY[topKey(g.cats)[0]]; return `<i class="dot" style="background:${c.color}" title="${esc(c.label)}"></i>`; };
    const addrRows = (repeat.length ? repeat : addresses).slice(0, 30).map((a, i) => `<tr>
      <td class="num dim">${i + 1}</td><td>${catDot(a)}${esc(a.key)}</td><td class="num strong">${a.n}</td>
      <td class="num">${K.fmtPct(a.n / withAddress.length * 100)}</td>
      <td>${esc(topTypes(a))}</td><td class="num">${esc(K.fmtDate(a.last))}</td></tr>`);
    const streetRows = streets.slice(0, 20).map((s, i) => `<tr>
      <td class="num dim">${i + 1}</td><td>${catDot(s)}${esc(s.key)}</td><td class="num strong">${s.n}</td>
      <td class="num">${s.addresses.size}</td><td class="num">${K.fmtPct(s.n / withAddress.length * 100)}</td></tr>`);

    const body = withAddress.length === 0
      ? `<p class="empty-msg">No calls with an address in this selection.</p>`
      : `${tiles}
  ${mapCard}
  <div class="grid2" style="grid-template-columns: 1.5fr 1fr">
    ${K.card(repeat.length ? `Addresses with ${minCalls}+ calls` : 'Busiest addresses',
      K.table({ head: [{ label: '#', num: 1 }, 'Address', { label: 'Calls', num: 1 }, { label: '% of all', num: 1 }, 'Most common', { label: 'Last', num: 1 }], rows: addrRows }),
      { lead: repeat.length ? `Top ${Math.min(30, repeat.length)} of ${repeat.length}.` : `No address reached ${minCalls} calls; showing the busiest.` })}
    ${K.card('Busiest roads', K.table({ head: [{ label: '#', num: 1 }, 'Road', { label: 'Calls', num: 1 }, { label: 'Addresses', num: 1 }, { label: '%', num: 1 }], rows: streetRows }),
      { lead: 'House numbers dropped, so every call on a road counts together.' })}
  </div>
  <p class="note">Addresses are matched as entered (trimmed, upper-cased), so the same place written two ways counts separately; the road table is more forgiving. Call types use the same grouping as the Incident Mix report.
    ${calls.length - withAddress.length ? `${calls.length - withAddress.length} calls have no address. ` : ''}Map circles are placed at the average recorded coordinates for each address. Map tiles &copy; OpenStreetMap contributors.</p>`;

    const head = points.length ? `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>` : '';

    const script = points.length ? `
      (function () {
        var pts = ${pointsJson};
        var el = document.getElementById('map');
        if (!window.L || !el) return;
        el.innerHTML = '';
        var map = L.map('map', { scrollWheelZoom: false });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        var group = [];
        pts.forEach(function (p) {
          var m = L.circleMarker([p.lat, p.lon], {
            radius: Math.min(26, 4 + 3 * Math.sqrt(p.n)), color: '#fff', weight: 1,
            fillColor: p.color, fillOpacity: 0.7
          }).bindPopup(p.html).addTo(map);
          group.push(m);
        });
        // Fit to the dense core (3rd–97th percentile) so a few far-away aid calls
        // don't stretch the starting view; the rest are still there to zoom out to.
        var q = function (arr, p) { var s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
        var lats = pts.map(function (p) { return p.lat; }), lons = pts.map(function (p) { return p.lon; });
        if (pts.length > 20) {
          map.fitBounds([[q(lats, 0.03), q(lons, 0.03)], [q(lats, 0.97), q(lons, 0.97)]], { padding: [20, 20] });
        } else {
          map.fitBounds(L.featureGroup(group).getBounds().pad(0.08));
        }
      })();` : '';

    const css = `
      #map { height: 460px; background: #e8ecf1; margin: 0 0 4px; }
      #map .empty-msg { background: none; box-shadow: none; }
      @media print { #map { height: 9cm; } .leaflet-control-zoom { display: none; } }`;

    const filters = `
      ${K.categorySelect(categoryKey)}
      ${K.numberInput('min', 'Min calls', minCalls, { min: 1, max: 50, width: 70 })}`;

    res.send(K.page({
      report, token: req.query.token || '', range, filters, body, css, head, script,
      subtitle: `Repeat call locations &mdash; ${esc(range.start)} to ${esc(range.end)}${categoryKey ? ` &mdash; ${esc(K.CATEGORY_BY_KEY[categoryKey].label)}` : ''}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
