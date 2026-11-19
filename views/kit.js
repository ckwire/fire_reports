// ---------------------------------------------------------------------------
// Shared building blocks for the report modules in views/.
//
//   const K = require('./kit')(ctx);
//
// ctx comes from server.js: { pool, resolveQuery, esc, topbar, isValidDate }.
// Pure helpers (stats, category mapping) are also exported on the factory
// itself, so they can be used without a ctx.
// ---------------------------------------------------------------------------

// ── Incident categories ─────────────────────────────────────────────────────
// One set of buckets that works for both coding schemes so trends stay
// continuous: NFIRS incident-type codes (through 2025) and NERIS group /
// subgroup (from 2025). NFIRS wins when a code is present.
const CATEGORIES = [
  { key: 'medical',   label: 'Medical / EMS',          color: '#4a90d9' },
  { key: 'rescue',    label: 'Rescue & vehicle crashes', color: '#d98e04' },
  { key: 'fire',      label: 'Fire',                   color: '#c0392b' },
  { key: 'hazard',    label: 'Hazardous conditions',   color: '#7b5ea7' },
  { key: 'service',   label: 'Service & weather',      color: '#1a8a7d' },
  { key: 'cancelled', label: 'Cancelled / good intent', color: '#8a96a8' },
  { key: 'false',     label: 'False alarms',           color: '#b5a642' },
  { key: 'other',     label: 'Other / uncoded',        color: '#c9d0da' },
];
const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function categoryOf(row) {
  const code = String(row.incident_type || '').trim();
  if (/^\d{3}$/.test(code)) {
    const n = parseInt(code, 10);
    if (n >= 100 && n < 200) return 'fire';
    if (n === 300 || n === 311 || n === 320 || n === 321) return 'medical';
    if (n >= 300 && n < 400) return 'rescue';          // crashes (322–324), extrication, other rescue
    if (n >= 400 && n < 500) return 'hazard';
    if ((n >= 500 && n < 600) || (n >= 800 && n < 900)) return 'service';
    if (n >= 600 && n < 700) return 'cancelled';
    if (n >= 700 && n < 800) return 'false';
    return 'other';
  }
  // NERIS files crashes under Medical (injury) or Hazardous (no injury); NFIRS
  // keeps them with rescue. Go by name so crashes stay in one place over time.
  if (/motor vehicle collision|extrication|entrap/i.test(row.type_desc || '')) return 'rescue';
  const group = row.neris_group || '', sub = row.neris_subgroup || '';
  if (group === 'Medical') return 'medical';
  if (group === 'Fire') return 'fire';
  if (group === 'Rescue') return 'rescue';
  if (group === 'Hazardous Situation') return 'hazard';
  if (group === 'Public Service') return sub === 'Alarms (Non Medical)' ? 'false' : 'service';
  if (group === 'No Emergency') return sub === 'False Alarm' ? 'false' : 'cancelled';
  return 'other';
}

// ── Stats ───────────────────────────────────────────────────────────────────
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

// Linear-interpolated percentile, p in 0..100. Input need not be sorted.
function percentile(values, p) {
  const v = values.filter(x => x !== null && x !== undefined && !isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
const median = values => percentile(values, 50);

// ── Local-time helpers (all timestamps arrive as 'YYYY-MM-DD HH24:MI:SS') ───
const hourOf     = s => parseInt(s.slice(11, 13), 10);
const dayNumOf   = s => { const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).getUTCDay(); return d === 0 ? 7 : d; }; // 1=Mon..7=Sun
const quarterOf  = s => Math.ceil(parseInt(s.slice(5, 7), 10) / 3);
const quarterKey = s => `${s.slice(0, 4)}-Q${quarterOf(s)}`;

function quartersBetween(start, end) {
  const out = [];
  const y0 = +start.slice(0, 4), y1 = +end.slice(0, 4);
  const startYM = y0 * 12 + +start.slice(5, 7), endYM = y1 * 12 + +end.slice(5, 7);
  for (let y = y0; y <= y1; y++) {
    for (let q = 1; q <= 4; q++) {
      if (y * 12 + q * 3 >= startYM && y * 12 + (q - 1) * 3 + 1 <= endYM) out.push({ key: `${y}-Q${q}`, label: `Q${q}`, year: y, q });
    }
  }
  return out;
}

// Date-string arithmetic (YYYY-MM-DD, calendar days, no time zones involved)
const toUTC = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(toUTC(s) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000) + 1;   // inclusive
const addMonths = (s, k) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1 + k, +s.slice(8, 10))).toISOString().slice(0, 10);

// "Clark, Joshua Daniel" -> "Clark, J."
const shortName = full => {
  const [last, first] = String(full || '').split(',').map(s => s.trim());
  return first ? `${last}, ${first[0]}.` : (last || '');
};

const fmtInt = n => n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US');
const fmtNum = (n, d = 1) => n === null || n === undefined ? '—' : (Math.abs(n % 1) < 1e-9 ? String(Math.round(n)) : n.toFixed(d));
const fmtPct = (n, d = 1) => n === null || n === undefined ? '—' : `${n.toFixed(d)}%`;
// 725 -> "12:05"
const fmtMin = sec => {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = s => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
const fmtDateTime = s => `${fmtDate(s)} ${s.slice(11, 16)}`;

module.exports = function createKit(ctx) {
  const { pool, resolveQuery, esc, topbar, isValidDate } = ctx;

  // Today's date in the report timezone, as YYYY-MM-DD.
  const localToday = () =>
    new Date().toLocaleDateString('en-CA', { timeZone: process.env.REPORT_TIMEZONE || 'UTC' });

  // Resolve ?start / ?end, apply the report's minDate floor, and report
  // whether the floor changed what the user asked for.
  function resolveRange(req, report, { defaultYearsBack = 2 } = {}) {
    const today = localToday();
    const min = report.minDate || null;
    const year = parseInt(today.slice(0, 4), 10);
    let start = isValidDate(req.query.start) ? req.query.start : `${year - defaultYearsBack}-01-01`;
    let end   = isValidDate(req.query.end)   ? req.query.end   : today;
    let clamped = false;
    if (min && start < min) { start = min; clamped = true; }
    if (end < start) end = start;
    return { start, end, min, today, clamped };
  }

  async function query(report, key, params = []) {
    const result = await pool.query(resolveQuery(report[key]), params);
    return result.rows;
  }

  // ── HTML pieces ───────────────────────────────────────────────────────────
  const tile = ({ title, value, sub = [], accent = false }) => `<div class="tile${accent ? ' tile-main' : ''}">
      <div class="tile-title">${title}</div>
      <div class="tile-value">${value}</div>
      ${sub.filter(Boolean).map(s => `<div class="tile-sub">${s}</div>`).join('')}
    </div>`;

  const card = (title, inner, { lead = '', cls = '' } = {}) =>
    `<section class="card ${cls}"><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}${inner}</section>`;

  const table = ({ head, rows, cls = '' }) => `<div class="tw"><table class="${cls}">
      <thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${h.label ?? h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>`;

  const rangeFilters = ({ start, end, min }) => `
    <div class="fg"><label>From</label><input type="date" name="start" value="${esc(start)}"${min ? ` min="${esc(min)}"` : ''}></div>
    <div class="fg"><label>To</label><input type="date" name="end" value="${esc(end)}"${min ? ` min="${esc(min)}"` : ''}></div>`;

  const select = (name, label, options, current) => `
    <div class="fg"><label>${label}</label><select name="${name}">${options.map(([v, l]) =>
      `<option value="${esc(String(v))}"${String(v) === String(current) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;

  const numberInput = (name, label, value, { min = 0, max = 999, step = 1, width = 80 } = {}) => `
    <div class="fg"><label>${label}</label><input type="number" name="${name}" value="${esc(String(value))}" min="${min}" max="${max}" step="${step}" style="width:${width}px"></div>`;

  const categorySelect = current => select('category', 'Call type',
    [['', 'All calls'], ...CATEGORIES.map(c => [c.key, c.label])], current);

  const legend = items => `<div class="legend">${items.map(i =>
    `<span><i class="sw" style="${i.dashed ? `border-top:3px dashed ${i.color}` : `border-color:${i.color}`}${i.box ? `;height:10px;border:none;background:${i.color}` : ''}"></i>${esc(i.label)}</span>`).join('')}</div>`;

  // ── Charts (inline SVG) ───────────────────────────────────────────────────
  function niceTop(maxVal, steps = 4) {
    if (!(maxVal > 0)) return steps;
    const raw = maxVal / steps;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return nice * mag * steps;
  }

  // series: [{ name, values (null = gap), color, dashed, width, dots }]
  // refLines: [{ value, label, color }]
  function lineChart({ labels, sublabels = [], series, yFmt = v => String(Math.round(v)), yMax = null, refLines = [], height = 230, aria = 'Chart', width = 560, every: everyOpt = null }) {
    const W = width, H = height, L = 46, R = 16, T = 12, B = sublabels.length ? 46 : 32;
    const vals = series.flatMap(s => s.values).concat(refLines.map(r => r.value)).filter(v => v !== null && v !== undefined);
    const top = yMax || niceTop(Math.max(...vals, 0) * 1.05);
    const x = i => labels.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (labels.length - 1);
    const y = v => T + (1 - v / top) * (H - T - B);

    const grid = [0, 1, 2, 3, 4].map(k => {
      const v = top * k / 4;
      return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>` +
             `<text x="${L - 6}" y="${y(v) + 3.5}" class="tick" text-anchor="end">${esc(yFmt(v))}</text>`;
    }).join('');

    const every = everyOpt || (labels.length > 14 ? Math.ceil(labels.length / 14) : 1);
    const xl = labels.map((l, i) => {
      if (i % every !== 0) return '';
      const sub = sublabels[i] ? `<tspan x="${x(i)}" dy="12" class="xsub">${esc(sublabels[i])}</tspan>` : '';
      return `<text x="${x(i)}" y="${H - B + 15}" class="tick" text-anchor="middle">${esc(l)}${sub}</text>`;
    }).join('');

    const path = vals2 => {
      let d = '', pen = false;
      vals2.forEach((v, i) => {
        if (v === null || v === undefined) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        pen = true;
      });
      return d.trim();
    };

    const refs = refLines.map(r => `<line x1="${L}" x2="${W - R}" y1="${y(r.value)}" y2="${y(r.value)}" stroke="${r.color || '#c0392b'}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
      `<text x="${L + 4}" y="${y(r.value) + 12}" class="tick" text-anchor="start" fill="${r.color || '#c0392b'}">${esc(r.label)}</text>`).join('');

    const lines = series.map(s =>
      `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.4}" stroke-linejoin="round"${s.dashed ? ' stroke-dasharray="5 4"' : ''}><title>${esc(s.name)}</title></path>` +
      (s.dots === false ? '' : s.values.map((v, i) => v === null || v === undefined ? '' :
        `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${s.width && s.width < 2 ? 2 : 3}" fill="${s.dashed ? '#fff' : s.color}" stroke="${s.color}" stroke-width="1.4"><title>${esc(s.name)} — ${esc(labels[i])}${sublabels[i] ? ' ' + esc(sublabels[i]) : ''}: ${esc(yFmt(v))}</title></circle>`).join(''))
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(aria)}">${grid}${refs}${lines}${xl}</svg>`;
  }

  // Vertical stacked bars. series: [{ name, color, values }]; partial[i] fades a bar.
  function stackedBars({ labels, sublabels = [], series, partial = [], yFmt = v => String(Math.round(v)), height = 250, aria = 'Chart', totals = true, width = 560, every: everyOpt = null, yMax = null }) {
    const W = width, H = height, L = 46, R = 12, T = 16, B = sublabels.length ? 46 : 32;
    const sums = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const top = yMax || niceTop(Math.max(...sums, 0) * 1.08);
    const slot = (W - L - R) / labels.length;
    const bw = Math.min(46, slot * 0.7);
    const y = v => T + (1 - v / top) * (H - T - B);

    const grid = [0, 1, 2, 3, 4].map(k => {
      const v = top * k / 4;
      return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>` +
             `<text x="${L - 6}" y="${y(v) + 3.5}" class="tick" text-anchor="end">${esc(yFmt(v))}</text>`;
    }).join('');

    const every = everyOpt || (labels.length > 14 ? Math.ceil(labels.length / 14) : 1);
    const bars = labels.map((lab, i) => {
      const cx = L + slot * i + slot / 2;
      let acc = 0;
      const segs = series.map(s => {
        const v = s.values[i] || 0;
        if (v <= 0) return '';
        const y0 = y(acc), y1 = y(acc + v);
        acc += v;
        return `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(y0 - y1, 0).toFixed(1)}" fill="${s.color}"${partial[i] ? ' fill-opacity=".55"' : ''}><title>${esc(s.name)} — ${esc(lab)}${sublabels[i] ? ' ' + esc(sublabels[i]) : ''}: ${esc(yFmt(v))}</title></rect>`;
      }).join('');
      const total = totals && sums[i] > 0 ? `<text x="${cx.toFixed(1)}" y="${(y(sums[i]) - 4).toFixed(1)}" class="tick" text-anchor="middle" font-weight="600">${esc(yFmt(sums[i]))}${partial[i] ? '*' : ''}</text>` : '';
      const xl = i % every === 0
        ? `<text x="${cx.toFixed(1)}" y="${H - B + 15}" class="tick" text-anchor="middle">${esc(lab)}${sublabels[i] ? `<tspan x="${cx.toFixed(1)}" dy="12" class="xsub">${esc(sublabels[i])}</tspan>` : ''}</text>` : '';
      return segs + total + xl;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(aria)}">${grid}${bars}</svg>`;
  }

  // Horizontal bar rows (HTML). rows: [{ label, value, display, color, sub }]
  function hBars(rows, { max = null } = {}) {
    const top = max || Math.max(...rows.map(r => r.value), 1);
    return `<div class="hbars">${rows.map(r => `<div class="hb">
      <span class="hb-l">${r.label}${r.sub ? `<small>${r.sub}</small>` : ''}</span>
      <span class="hb-t"><span class="hb-b" style="width:${Math.max(0, r.value / top * 100).toFixed(1)}%;background:${r.color || '#1e3a5f'}"></span></span>
      <span class="hb-v">${r.display ?? fmtInt(r.value)}</span>
    </div>`).join('')}</div>`;
  }

  // Tiny inline trend line; null values break the line.
  function sparkline(values, { width = 110, height = 24, color = '#1e3a5f', max = null } = {}) {
    const v = values.filter(x => x !== null && x !== undefined);
    if (v.length === 0) return '';
    const top = max || Math.max(...v, 1);
    const x = i => values.length === 1 ? width / 2 : 2 + i * (width - 4) / (values.length - 1);
    const y = val => height - 2 - (val / top) * (height - 4);
    let d = '', pen = false;
    values.forEach((val, i) => {
      if (val === null || val === undefined) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)} `; pen = true;
    });
    const lastI = values.map((val, i) => val === null || val === undefined ? -1 : i).filter(i => i >= 0).pop();
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="vertical-align:middle"><path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.6"/>` +
      `<circle cx="${x(lastI).toFixed(1)}" cy="${y(values[lastI]).toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
  }

  // Incidents + who responded, joined: [{...incident, members: Set(personnel_id)}]
  async function incidentsWithResponders(report, start, end) {
    const [incs, resp] = await Promise.all([
      query(report, 'incidentQuery', [start, end]),
      query(report, 'responseQuery', [start, end]),
    ]);
    const byInc = new Map();
    resp.forEach(r => { if (!byInc.has(r.incident_id)) byInc.set(r.incident_id, new Set()); byInc.get(r.incident_id).add(r.personnel_id); });
    return incs.map(i => ({ ...i, date: i.alarm_local.slice(0, 10), category: categoryOf(i), members: byInc.get(i.id) || new Set() }))
      .sort((a, b) => a.alarm_local.localeCompare(b.alarm_local));
  }

  // Heat colour: near-white -> navy. t in 0..1
  const heat = t => {
    const c = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(238 - c * 208)},${Math.round(243 - c * 185)},${Math.round(250 - c * 155)})`;
  };

  // ── Page shell ────────────────────────────────────────────────────────────
  const CSS = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #1a1a2e; padding: 22px 18px; }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    .filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px; }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input, .fg select { border: 1px solid #d1d5db; border-radius: 5px; padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px; }
    .fg select { min-width: 150px; }
    button { height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff; border: none; border-radius: 5px; font-size: .87rem; cursor: pointer; align-self: flex-end; }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }
    .btn-light { background: #fff; color: #1e3a5f; border: 1px solid #c5d0de; padding: 0 12px; }
    .btn-light:hover { background: #eef4fb; }

    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-bottom: 16px; }
    .tile { background: #fff; border-radius: 8px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(0,0,0,.12); border-left: 4px solid #8a96a8; }
    .tile-main { border-left-color: #1e3a5f; }
    .tile-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #666; }
    .tile-value { font-size: 2rem; font-weight: 700; color: #1e3a5f; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .tile-sub   { font-size: .8rem; color: #555; margin-top: 2px; }
    .good { color: #1d6b3a; font-weight: 700; } .bad { color: #a4372a; font-weight: 700; } .muted { color: #999; }

    .notice { background: #fff8e6; border: 1px solid #f0d9a0; color: #7a5a10; border-radius: 6px; padding: 8px 12px; font-size: .82rem; margin-bottom: 14px; }
    .empty-msg { background: #fff; border-radius: 8px; padding: 32px; text-align: center; color: #888; font-size: .9rem; }

    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; margin-bottom: 16px; align-items: start; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); margin-bottom: 16px; overflow: hidden; }
    .grid2 .card { margin-bottom: 0; }
    .card h2 { font-size: .88rem; font-weight: 600; color: #1e3a5f; padding: 14px 16px 6px; }
    .card .lead { font-size: .78rem; color: #777; padding: 0 16px 8px; }
    .card .pad { padding: 4px 14px 12px; }

    .chart { width: 100%; height: auto; display: block; padding: 0 8px 4px; }
    .chart .grid { stroke: #e6e9ee; }
    .chart .tick { font-size: 10px; fill: #777; }
    .chart .xsub { fill: #999; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .75rem; color: #555; padding: 0 16px 12px; }
    .sw { display: inline-block; width: 20px; height: 0; border-top: 3px solid; vertical-align: middle; margin-right: 6px; }

    .tw { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .83rem; }
    thead th { background: #1e3a5f; color: #fff; padding: 7px 12px; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; text-align: left; white-space: nowrap; }
    thead th.num { text-align: right; }
    tbody th { text-align: left; font-weight: 600; padding: 6px 12px; white-space: nowrap; }
    tbody td { padding: 6px 12px; }
    tbody tr > * { border-bottom: 1px solid #eef0f3; }
    tbody tr:hover > * { background: #f7f9fc; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.strong { font-weight: 700; color: #1e3a5f; }
    td.dim { color: #7b8797; }
    tr.total > * { background: #eef0f3 !important; font-weight: 700; border-top: 2px solid #c0c8d4; }
    .tag { display: inline-block; font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 7px; border-radius: 9px; background: #eef4fb; color: #2a6db5; margin-left: 4px; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: baseline; }

    .hbars { padding: 4px 16px 12px; }
    .hb { display: grid; grid-template-columns: minmax(120px, 34%) 1fr 64px; gap: 10px; align-items: center; padding: 3px 0; font-size: .82rem; }
    .hb-l small { display: block; color: #999; font-size: .72rem; }
    .hb-t { background: #eef0f3; border-radius: 3px; height: 12px; overflow: hidden; }
    .hb-b { display: block; height: 100%; border-radius: 3px; }
    .hb-v { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }

    details.more > summary { cursor: pointer; padding: 8px 16px; font-size: .8rem; color: #2a6db5; list-style: none; border-top: 1px solid #eef0f3; }
    details.more > summary::-webkit-details-marker { display: none; }
    details.more > summary::before { content: '\\25B8  '; }
    details.more[open] > summary::before { content: '\\25BE  '; }

    .note { font-size: .76rem; color: #777; line-height: 1.5; margin-top: 14px; max-width: 920px; }
    .meta { margin-top: 6px; font-size: .72rem; color: #999; }

    @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1 { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .tiles { gap: 8px; margin-bottom: 8px; }
      .tile { padding: 8px 12px; box-shadow: none; border: 1px solid #d5d9df; }
      .tile-value { font-size: 1.5rem; }
      .tile-sub { font-size: .66rem; }
      .card { box-shadow: none; border: 1px solid #d5d9df; margin-bottom: 8px; break-inside: avoid; }
      .grid2 { grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
      .card h2 { padding: 8px 10px 3px; font-size: .78rem; }
      .card .lead { display: none; }
      table { font-size: .66rem; }
      tbody th, tbody td, thead th { padding: 2px 7px; }
      .note { font-size: .6rem; margin-top: 6px; }
      details.more:not([open]) { display: none; }
      thead th, tr.total > *, .tile, .hb-b, .chart * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @page { size: portrait; margin: 0.7cm; }`;

  // Everything a report needs to produce a complete page.
  //   filters : extra filter controls (HTML) placed after the date range
  //   range   : result of resolveRange — adds the floor notice
  function page({ report, subtitle, token, range = null, filters = '', body, head = '', css = '', script = '', rangeControls = true }) {
    const tb = topbar(token);
    const notice = range && range.clamped && report.minDateNote
      ? `<p class="notice no-print">Earlier dates are not available: ${esc(report.minDateNote)} The range was adjusted to start ${esc(range.min)}.</p>`
      : (range && range.min && report.minDateNote
        ? `<p class="notice no-print" style="background:#eef4fb;border-color:#cfe0f1;color:#2a4a6e">Data for this report starts ${esc(range.min)}. ${esc(report.minDateNote)}</p>` : '');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  ${head}
  <style>
    ${tb.css}
    ${CSS}
    ${css}
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${subtitle}</p>
  ${notice}
  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    ${rangeControls && range ? rangeFilters(range) : ''}
    ${filters}
    <button type="submit">Apply</button>
    <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
  </form>
  ${body}
  <p class="meta">Generated ${new Date().toLocaleString()}</p>
  ${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
  }

  // Standard failure path so every view reports errors the same way.
  const fail = (res, report, err) => {
    console.error(`Error in "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  };

  return {
    ...ctx,
    CATEGORIES, CATEGORY_BY_KEY, categoryOf,
    mean, percentile, median,
    hourOf, dayNumOf, quarterOf, quarterKey, quartersBetween,
    fmtInt, fmtNum, fmtPct, fmtMin, fmtDate, fmtDateTime,
    localToday, resolveRange, query,
    tile, card, table, rangeFilters, select, numberInput, categorySelect, legend,
    lineChart, stackedBars, hBars, heat, niceTop, sparkline,
    incidentsWithResponders,
    addDays, daysBetween, addMonths, shortName,
    page, fail,
  };
};

Object.assign(module.exports, {
  CATEGORIES, CATEGORY_BY_KEY, categoryOf, mean, percentile, median,
  hourOf, dayNumOf, quarterOf, quarterKey, quartersBetween,
  addDays, daysBetween, addMonths, shortName,
});
