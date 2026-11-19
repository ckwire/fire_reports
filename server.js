require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const reports = require('./reports');
const nav     = require('./nav');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// PostgreSQL connection pool — credentials come from .env
// ---------------------------------------------------------------------------
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Replaces {{DB_NAME}} and {{TIMEZONE}} in SQL strings with values from .env
function resolveQuery(sql) {
  return sql
    .replace(/\{\{DB_NAME\}\}/g,  process.env.DB_NAME        || '')
    .replace(/\{\{TIMEZONE\}\}/g, process.env.REPORT_TIMEZONE || 'UTC');
}

// Handed to the report modules in views/ (they build on views/kit.js)
const viewContext = { pool, resolveQuery, esc, topbar, isValidDate };

// ---------------------------------------------------------------------------
// Allowed domains — read once at startup from .env
// ---------------------------------------------------------------------------
const allowedDomains = process.env.ALLOWED_DOMAINS
  ? process.env.ALLOWED_DOMAINS.split(',').map(d => d.trim().replace(/\/$/, '').toLowerCase())
  : [];

// ---------------------------------------------------------------------------
// Middleware: validate the ?token= query param
// ---------------------------------------------------------------------------
function validateToken(req, res, next) {
  const provided = req.query.token || '';
  const expected = process.env.REPORT_TOKEN || '';

  if (!expected) {
    console.error('REPORT_TOKEN is not set in .env');
    return res.status(500).send('Server misconfiguration.');
  }

  // Pad to equal length before timing-safe compare to avoid length leaks
  const a = Buffer.alloc(64);
  const b = Buffer.alloc(64);
  Buffer.from(provided).copy(a);
  Buffer.from(expected).copy(b);

  if (!crypto.timingSafeEqual(a, b) || provided.length !== expected.length) {
    return res.status(401).send('Access denied: invalid or missing token.');
  }

  next();
}

// ---------------------------------------------------------------------------
// Middleware: restrict to allowed embedding domains
// Only enforced when ALLOWED_DOMAINS is set in .env.
// Checks the Origin and Referer headers sent by the browser.
// ---------------------------------------------------------------------------
function validateDomain(req, res, next) {
  if (allowedDomains.length === 0) {
    return next();
  }

  const origin  = (req.headers['origin']  || '').toLowerCase();
  const referer = (req.headers['referer'] || '').toLowerCase();

  // Direct browser navigation sends no origin/referer — allow it.
  if (!origin && !referer) {
    return next();
  }

  // Same-origin requests (e.g. filter form submits) carry a Referer pointing
  // back at this server. Always allow those — they aren't cross-origin embeds.
  const host = (req.headers['host'] || '').toLowerCase();
  if (host && (origin.includes(host) || referer.includes(host))) {
    return next();
  }

  const isAllowed = allowedDomains.some(
    domain => origin.startsWith(domain) || referer.startsWith(domain)
  );

  if (!isAllowed) {
    return res.status(403).send('Access denied: requests from this origin are not permitted.');
  }

  next();
}

// ---------------------------------------------------------------------------
// Middleware: set security headers
// frame-ancestors controls which domains may embed this page in an <iframe>.
// ---------------------------------------------------------------------------
function securityHeaders(_req, res, next) {
  // Build the frame-ancestors directive from ALLOWED_DOMAINS
  const frameAncestors = allowedDomains.length > 0
    ? `'self' ${allowedDomains.join(' ')}`
    : `'self'`;

  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  // X-Frame-Options is the older equivalent; CSP takes precedence in modern browsers
  res.setHeader('X-Frame-Options', allowedDomains.length > 0 ? 'ALLOWALL' : 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

// ---------------------------------------------------------------------------
// Report route — /report/:name?token=...
// Report names and queries are defined in reports.js
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Home / landing page
// ---------------------------------------------------------------------------
app.get('/', securityHeaders, validateToken, validateDomain, (req, res) => {
  res.send(buildHomeHtml(req.query.token || ''));
});

// ---------------------------------------------------------------------------
// Report route — /report/:name?token=...
// ---------------------------------------------------------------------------
app.get('/report/:name', securityHeaders, validateToken, validateDomain, async (req, res) => {
  const report = reports[req.params.name];

  if (!report) {
    return res.status(404).send(`Report "${req.params.name}" not found.`);
  }

  // Reports built as modules in views/ (type: 'view', view: '<file>')
  if (report.type === 'view') {
    try {
      return await require(`./views/${report.view}`).handle(req, res, report, viewContext);
    } catch (err) {
      console.error(`View "${report.view}" failed:`, err.message);
      return res.status(500).send('Error loading report. Check server logs.');
    }
  }

  if (report.type === 'heatmap') {
    return handleHeatmap(req, res, report);
  }

  if (report.type === 'filtered-table') {
    return handleFilteredTable(req, res, report);
  }

  if (report.type === 'matrix') {
    return handleMatrix(req, res, report);
  }

  if (report.type === 'member-activity') {
    return handleMemberActivity(req, res, report);
  }

  if (report.type === 'member-scorecard') {
    return handleMemberScorecard(req, res, report);
  }

  if (report.type === 'projection') {
    return handleProjection(req, res, report);
  }

  try {
    const result  = await pool.query(resolveQuery(report.query));
    const rows    = result.rows;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    res.send(buildReportHtml(report.title, columns, rows, req.query.token || ''));
  } catch (err) {
    console.error(`Database error for report "${req.params.name}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
});

// ---------------------------------------------------------------------------
// Heatmap report handler
// ---------------------------------------------------------------------------
async function handleHeatmap(req, res, report) {
  const today        = new Date();
  const defaultStart = `${today.getFullYear()}-01-01`;
  const defaultEnd   = today.toISOString().split('T')[0];

  const start = isValidDate(req.query.start) ? req.query.start : defaultStart;
  const end   = isValidDate(req.query.end)   ? req.query.end   : defaultEnd;

  let personnelId = null;
  if (req.query.personnel_id) {
    personnelId = parseInt(req.query.personnel_id, 10);
    if (isNaN(personnelId)) return res.status(400).send('Invalid personnel_id.');
  }

  try {
    const queries = [
      pool.query(resolveQuery(report.personnelQuery)),
      pool.query(resolveQuery(report.dataQuery), [start, end, personnelId]),
    ];

    // When viewing a specific person, also fetch dept totals so cells can
    // show person/dept context (e.g. "2/5" = responded to 2 of 5 dept calls)
    if (personnelId !== null) {
      queries.push(pool.query(resolveQuery(report.dataQuery), [start, end, null]));
    }

    const [personnelResult, dataResult, deptResult] = await Promise.all(queries);

    res.send(buildHeatmapHtml(report, personnelResult.rows, dataResult.rows, {
      start, end, personnelId, token: req.query.token || '',
      deptRows: deptResult ? deptResult.rows : null,
    }));
  } catch (err) {
    console.error(`Heatmap error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

function isValidDate(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// ---------------------------------------------------------------------------
// Heatmap HTML builder
// ---------------------------------------------------------------------------
function buildHeatmapHtml(report, personnel, dataRows, { start, end, personnelId, token, deptRows }) {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Build 24-hour × 7-day matrix (rows = hours 0–23, cols = Mon–Sun)
  function toMatrix(rows) {
    const m = Array.from({ length: 24 }, () => new Array(7).fill(0));
    rows.forEach(r => { m[parseInt(r.hour)][parseInt(r.day_num) - 1] = parseInt(r.count); });
    return m;
  }

  const matrix     = toMatrix(dataRows);
  const deptMatrix = deptRows ? toMatrix(deptRows) : null;

  const rowTotals  = matrix.map(row => row.reduce((a, b) => a + b, 0));
  const colTotals  = Array(7).fill(0);
  matrix.forEach(row => row.forEach((v, d) => { colTotals[d] += v; }));
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);
  const maxCount   = Math.max(...matrix.flat(), 1);

  // Dept totals (only present when a person is selected)
  let deptRowTotals, deptColTotals, deptGrandTotal;
  if (deptMatrix) {
    deptRowTotals  = deptMatrix.map(row => row.reduce((a, b) => a + b, 0));
    deptColTotals  = Array(7).fill(0);
    deptMatrix.forEach(row => row.forEach((v, d) => { deptColTotals[d] += v; }));
    deptGrandTotal = deptRowTotals.reduce((a, b) => a + b, 0);
  }

  const selectedPerson = personnelId
    ? personnel.find(p => parseInt(p.personnel_id) === personnelId)
    : null;

  const subtitle = selectedPerson
    ? `${esc(selectedPerson.public_name)} &mdash; ${esc(start)} to ${esc(end)}`
    : `Department Total &mdash; ${esc(start)} to ${esc(end)}`;

  const personnelOptions = personnel.map(p => {
    const id  = parseInt(p.personnel_id);
    const sel = id === personnelId ? ' selected' : '';
    return `<option value="${id}"${sel}>${esc(p.public_name)}</option>`;
  }).join('');

  // Format a cell value: when dept context exists, show "person/dept"
  // Empty when dept had no calls (not meaningful to show 0/0)
  function cellDisplay(count, deptCount) {
    if (deptMatrix === null) return count > 0 ? String(count) : '';
    if (deptCount === 0)     return '';
    if (count === 0)         return `<span class="dc missed">0/${deptCount}</span>`;
    return `${count}<span class="dc">/${deptCount}</span>`;
  }

  function cellTitle(count, deptCount) {
    if (deptMatrix === null) return `${count} incident${count !== 1 ? 's' : ''}`;
    if (deptCount === 0)     return 'No department calls';
    return `${count} of ${deptCount} department call${deptCount !== 1 ? 's' : ''}`;
  }

  function totalDisplay(personVal, deptVal) {
    if (deptMatrix === null) return personVal || '';
    if (!deptVal)            return '';
    return deptVal ? `${personVal}<span class="dc">/${deptVal}</span>` : '';
  }

  const heatRows = matrix.map((row, h) => {
    const hourLabel = `${String(h).padStart(2, '0')}:00`;
    const cells = row.map((count, d) => {
      const dc   = deptMatrix ? deptMatrix[h][d] : null;
      const bg   = heatColor(count, maxCount);
      const fg   = textColor(count, maxCount);
      return `<td class="hc" style="background:${bg};color:${fg}" title="${cellTitle(count, dc)}">${cellDisplay(count, dc)}</td>`;
    }).join('');
    const rowTotal = totalDisplay(rowTotals[h], deptRowTotals ? deptRowTotals[h] : null);
    return `<tr><th class="hl">${hourLabel}</th>${cells}<td class="rt">${rowTotal}</td></tr>`;
  }).join('');

  const colTotalCells = colTotals.map((t, d) => {
    const dt = deptColTotals ? deptColTotals[d] : null;
    return `<td class="ct">${totalDisplay(t, dt)}</td>`;
  }).join('');

  const grandTotalDisplay = deptMatrix
    ? `${grandTotal}<span class="dc gt-frac">/${deptGrandTotal}</span>`
    : grandTotal;

  // Color legend gradient stops
  const legendStops = [0, 0.25, 0.5, 0.75, 1]
    .map(t => `<span class="ls" style="background:${heatColor(Math.round(t * maxCount), maxCount)}"></span>`)
    .join('');

  const deptNote = deptMatrix
    ? `<p class="dept-note no-print">Cells show <strong>responses / dept calls</strong>. Blank = no dept calls that hour.</p>`
    : '';

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 14px; }
    .dept-note { font-size: .78rem; color: #666; margin-bottom: 14px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input, .fg select {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    .fg select { min-width: 180px; }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print {
      background: #4a5568; margin-left: auto;
    }
    .btn-print:hover { background: #2d3748; }

    /* Heatmap table */
    .hw { overflow-x: auto; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    table.hm { border-collapse: collapse; background: #fff; font-size: .8rem; }
    table.hm th, table.hm td { padding: 0; }
    .dh {
      background: #1e3a5f; color: #fff; padding: 8px 10px;
      text-align: center; font-size: .75rem;
      text-transform: uppercase; letter-spacing: .05em; min-width: 62px;
    }
    .corner { background: #1e3a5f; min-width: 52px; }
    .th { background: #1e3a5f; color: #aab8c9; padding: 8px 10px; text-align: center; font-size: .73rem; }
    .hl {
      background: #f8f9fa; color: #555; font-weight: 600;
      padding: 5px 10px; text-align: right; font-size: .75rem;
      white-space: nowrap; border-right: 2px solid #e2e5ea;
    }
    .hc {
      width: 62px; height: 30px; text-align: center; line-height: 1.2;
      font-size: .78rem; font-weight: 600;
      border: 1px solid rgba(255,255,255,.4); cursor: default;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .dc { font-size: .65rem; font-weight: 400; opacity: .75; }
    .dc.missed { font-size: .7rem; color: #999; opacity: 1; font-weight: 500; }
    .gt-frac { font-size: .72rem; }
    .rt, .ct {
      background: #f0f2f5; color: #333; font-weight: 700;
      text-align: center; padding: 5px 10px;
      font-size: .78rem; border-left: 2px solid #e2e5ea;
    }
    tfoot .hl { border-top: 2px solid #c0c8d4; background: #e9ecef; }
    tfoot .ct { border-top: 2px solid #c0c8d4; background: #e9ecef; }
    .gt {
      background: #1e3a5f; color: #fff; font-weight: 700;
      text-align: center; padding: 5px 10px; font-size: .82rem;
      border-left: 2px solid #fff; border-top: 2px solid #c0c8d4;
    }

    /* Legend */
    .legend { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: .78rem; color: #666; }
    .ls { display: inline-block; width: 28px; height: 14px; border-radius: 2px; }
    .meta { margin-top: 8px; font-size: .75rem; color: #999; }

    /* Print — fits 24 hour rows on one portrait page */
    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .hw  { overflow: visible; box-shadow: none; border-radius: 0; }
      table.hm { width: 100%; table-layout: fixed; }
      .corner  { min-width: 0; }
      .dh { padding: 4px 2px; font-size: .62rem; min-width: 0; letter-spacing: 0; }
      .th { padding: 4px 2px; font-size: .62rem; }
      .hl { padding: 2px 5px; font-size: .62rem; }
      .hc { width: auto; height: auto; font-size: .62rem; padding: 2px 1px; }
      .dc { font-size: .52rem; }
      .rt, .ct { padding: 2px 4px; font-size: .62rem; }
      .gt  { padding: 2px 4px; font-size: .67rem; }
      .meta { font-size: .62rem; margin-top: 4px; }
    }
    @page { size: portrait; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${subtitle}</p>
  ${deptNote}

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>From</label>
      <input type="date" name="start" value="${esc(start)}">
    </div>
    <div class="fg">
      <label>To</label>
      <input type="date" name="end" value="${esc(end)}">
    </div>
    <div class="fg">
      <label>Personnel</label>
      <select name="personnel_id">
        <option value="">Department Total</option>
        ${personnelOptions}
      </select>
    </div>
    <button type="submit">Apply</button>
    <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  <div class="hw">
    <table class="hm">
      <thead>
        <tr>
          <th class="corner"></th>
          ${DAYS.map(d => `<th class="dh">${d}</th>`).join('')}
          <th class="th">Total</th>
        </tr>
      </thead>
      <tbody>${heatRows}</tbody>
      <tfoot>
        <tr>
          <th class="hl">Total</th>
          ${colTotalCells}
          <td class="gt">${grandTotalDisplay}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="legend no-print">
    <span>Low</span>${legendStops}<span>High (${maxCount})</span>
  </div>
  <p class="meta">${grandTotal} incident${grandTotal !== 1 ? 's' : ''} in period &mdash; generated ${new Date().toLocaleString()}</p>
</body>
</html>`;
}

// Warm gradient: near-white → dark red (fire-themed)
function heatColor(count, maxCount) {
  if (count === 0 || maxCount === 0) return '#f0f2f5';
  const t = Math.min(count / maxCount, 1);
  const r = Math.round(255 - t * 128);   // 255 → 127
  const g = Math.round(240 - t * 240);   // 240 → 0
  const b = Math.round(220 - t * 220);   // 220 → 0
  return `rgb(${r},${g},${b})`;
}

function textColor(count, maxCount) {
  return maxCount > 0 && (count / maxCount) > 0.55 ? '#fff' : '#333';
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Filtered-table report handler
// ---------------------------------------------------------------------------
async function handleFilteredTable(req, res, report) {
  const today        = new Date();
  const defaultStart = `${today.getFullYear()}-01-01`;
  const defaultEnd   = today.toISOString().split('T')[0];

  const start = isValidDate(req.query.start) ? req.query.start : defaultStart;
  const end   = isValidDate(req.query.end)   ? req.query.end   : defaultEnd;

  try {
    const result = await pool.query(resolveQuery(report.dataQuery), [start, end]);
    res.send(buildFilteredTableHtml(report, result.rows, {
      start, end, token: req.query.token || '',
    }));
  } catch (err) {
    console.error(`Filtered table error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

// ---------------------------------------------------------------------------
// Matrix report handler
// ---------------------------------------------------------------------------
async function handleMatrix(req, res, report) {
  const today        = new Date();
  const defaultStart = `${today.getFullYear()}-01-01`;
  const defaultEnd   = today.toISOString().split('T')[0];

  const start = isValidDate(req.query.start) ? req.query.start : defaultStart;
  const end   = isValidDate(req.query.end)   ? req.query.end   : defaultEnd;

  try {
    const [classResult, rosterResult] = await Promise.all([
      pool.query(resolveQuery(report.classQuery),  [start, end]),
      pool.query(resolveQuery(report.rosterQuery)),
    ]);

    const classes = classResult.rows;
    const roster  = rosterResult.rows;   // [{ user_id, personnel_full_name }]

    let attendance = [];
    if (classes.length > 0) {
      const classIds = classes.map(c => c.id);
      const attResult = await pool.query(resolveQuery(report.attendanceQuery), [classIds]);
      attendance = attResult.rows;
    }

    res.send(buildMatrixHtml(report, classes, roster, attendance, {
      start, end, token: req.query.token || '',
    }));
  } catch (err) {
    console.error(`Matrix error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

// ---------------------------------------------------------------------------
// Member activity report handler — one member, incidents + training,
// drill-down Year → Quarter → individual call/class.
// ---------------------------------------------------------------------------
async function handleMemberActivity(req, res, report) {
  const today        = new Date();
  const defaultStart = `${today.getFullYear() - 2}-01-01`;
  const defaultEnd   = today.toISOString().split('T')[0];

  const start = isValidDate(req.query.start) ? req.query.start : defaultStart;
  const end   = isValidDate(req.query.end)   ? req.query.end   : defaultEnd;

  let personnelId = null;
  if (req.query.personnel_id) {
    personnelId = parseInt(req.query.personnel_id, 10);
    if (isNaN(personnelId)) return res.status(400).send('Invalid personnel_id.');
  }

  try {
    const personnelResult = await pool.query(resolveQuery(report.personnelQuery));

    let incidents = [], training = [], deptIncidents = [], deptTraining = [];
    let memberStart = start;
    if (personnelId !== null) {
      const selected = personnelResult.rows.find(p => parseInt(p.personnel_id, 10) === personnelId);
      // ISO date strings compare correctly as text
      if (selected && selected.personnel_start && selected.personnel_start > start) {
        memberStart = selected.personnel_start;
      }

      const [incResult, trResult, dIncResult, dTrResult] = await Promise.all([
        pool.query(resolveQuery(report.incidentQuery), [start, end, personnelId]),
        pool.query(resolveQuery(report.trainingQuery), [start, end, personnelId]),
        pool.query(resolveQuery(report.deptIncidentQuery), [memberStart, end]),
        pool.query(resolveQuery(report.deptTrainingQuery), [memberStart, end]),
      ]);
      incidents     = incResult.rows;
      training      = trResult.rows;
      deptIncidents = dIncResult.rows;
      deptTraining  = dTrResult.rows;
    }

    res.send(buildMemberActivityHtml(report, personnelResult.rows, incidents, training, {
      start, end, personnelId, token: req.query.token || '',
      deptIncidents, deptTraining, memberStart,
    }));
  } catch (err) {
    console.error(`Member activity error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

// Groups items (each with a `date` string beginning YYYY-MM-DD) into
// Year → Quarter → items and renders nested <details> elements. Every quarter
// in the date range is listed, including empty ones, so gaps are visible.
// deptItems are the department-wide items for the same periods (denominators).
// summarize(list, deptList) returns the HTML shown on each header line;
// renderItem(item) returns the HTML for one expanded row.
function buildPeriodTree(items, deptItems, start, end, { summarize, renderItem, yearsOpen = true }) {
  const byQuarter = new Map();   // "2024-3" -> items
  const deptByQuarter = new Map();
  const keys = new Set();

  const startYM = parseInt(start.slice(0, 4), 10) * 12 + parseInt(start.slice(5, 7), 10);
  const endYM   = parseInt(end.slice(0, 4), 10)   * 12 + parseInt(end.slice(5, 7), 10);
  for (let y = parseInt(start.slice(0, 4), 10); y <= parseInt(end.slice(0, 4), 10); y++) {
    for (let q = 1; q <= 4; q++) {
      if (y * 12 + q * 3 >= startYM && y * 12 + (q - 1) * 3 + 1 <= endYM) keys.add(`${y}-${q}`);
    }
  }

  // Timezone conversion can nudge an item just outside the range — keep it.
  items.forEach(it => {
    const key = `${it.date.slice(0, 4)}-${Math.ceil(parseInt(it.date.slice(5, 7), 10) / 3)}`;
    keys.add(key);
    if (!byQuarter.has(key)) byQuarter.set(key, []);
    byQuarter.get(key).push(it);
  });

  // Department items only count toward periods already being shown.
  deptItems.forEach(it => {
    const key = `${it.date.slice(0, 4)}-${Math.ceil(parseInt(it.date.slice(5, 7), 10) / 3)}`;
    if (!keys.has(key)) return;
    if (!deptByQuarter.has(key)) deptByQuarter.set(key, []);
    deptByQuarter.get(key).push(it);
  });

  const years = new Map();   // 2024 -> [q, q, ...]
  [...keys]
    .map(k => k.split('-').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .forEach(([y, q]) => {
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(q);
    });

  return [...years.entries()].map(([y, quarters]) => {
    const yearItems = quarters.flatMap(q => byQuarter.get(`${y}-${q}`) || []);
    const yearDept  = quarters.flatMap(q => deptByQuarter.get(`${y}-${q}`) || []);

    const qHtml = quarters.map(q => {
      const list = byQuarter.get(`${y}-${q}`) || [];
      const dept = deptByQuarter.get(`${y}-${q}`) || [];
      if (list.length === 0) {
        return `<div class="pd-empty"><span class="pl">Q${q}</span><span class="ps zero">${summarize(list, dept)}</span></div>`;
      }
      return `<details class="pd pd-q">
        <summary><span class="pl">Q${q}</span><span class="ps">${summarize(list, dept)}</span></summary>
        <div class="items">${list.map(renderItem).join('')}</div>
      </details>`;
    }).join('');

    // data-print-open: whether this year is expanded (showing its quarters) when printed
    return `<details class="pd pd-y"${yearsOpen ? ' open data-print-open="1"' : ''}>
      <summary><span class="pl">${y}</span><span class="ps">${summarize(yearItems, yearDept)}</span></summary>
      <div class="quarters">${qHtml}</div>
    </details>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Member activity HTML builder
// ---------------------------------------------------------------------------
function buildMemberActivityHtml(report, personnel, incidents, training, {
  start, end, personnelId, token, deptIncidents = [], deptTraining = [], memberStart = start,
}) {
  const selected = personnelId !== null
    ? personnel.find(p => parseInt(p.personnel_id, 10) === personnelId)
    : null;

  const fmtNum  = n => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
  const plural  = (n, word, pl = `${word}s`) => `${n} ${n === 1 ? word : pl}`;
  const fmtDate = s => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

  const optionFor = p => {
    const id = parseInt(p.personnel_id, 10);
    return `<option value="${id}"${id === personnelId ? ' selected' : ''}>${esc(String(p.personnel_full_name || ''))}</option>`;
  };
  const personnelOptions =
    `<optgroup label="Active">${personnel.filter(p => p.personnel_is_active).map(optionFor).join('')}</optgroup>` +
    `<optgroup label="Inactive">${personnel.filter(p => !p.personnel_is_active).map(optionFor).join('')}</optgroup>`;

  // member / dept as a percentage; blank when the department had nothing
  const pct = (n, d) => d > 0 ? `${(n / d * 100).toFixed(1)}%` : '';
  const pctHtml = (n, d) => d > 0 ? `<span class="pct">${pct(n, d)}</span>` : '';

  // --- Incidents ---
  const incItems     = incidents.map(r => ({ ...r, date: r.alarm_local }));
  // Drop incidents that the UTC→local conversion pushed outside the range so
  // the header total always equals the sum of the periods shown.
  const deptIncItems = deptIncidents
    .map(r => ({ ...r, date: r.alarm_local }))
    .filter(r => r.date.slice(0, 10) >= memberStart && r.date.slice(0, 10) <= end);
  const incSummary = (list, dept) => dept.length === 0 && list.length === 0
    ? 'None'
    : `${list.length}<span class="of">/${dept.length}</span> ${pctHtml(list.length, dept.length)}`;
  const incTree = buildPeriodTree(incItems, deptIncItems, start, end, {
    summarize: incSummary,
    yearsOpen: false,   // incidents: yearly totals only until a year is expanded
    renderItem: r => `<div class="it">
      <span class="it-date">${esc(fmtDate(r.date))} <span class="it-time">${esc(r.date.slice(11, 16))}</span></span>
      <span class="it-main">${esc(String(r.incident_type || 'Incident'))}${r.address ? `<span class="it-sub">${esc(String(r.address))}</span>` : ''}</span>
      <span class="it-ref">${esc(String(r.incident_number || ''))}</span>
    </div>`,
  });

  // --- Training ---
  const trItems = training.map(r => ({ ...r, date: r.class_date, hours: parseFloat(r.duration_hours) || 0 }));
  const sumHours = list => list.reduce((a, r) => a + r.hours, 0);
  const deptTrItems = deptTraining.map(r => ({ ...r, date: r.class_date, hours: parseFloat(r.duration_hours) || 0 }));
  // Shows everything the member attended, then in-house hours against the
  // department's in-house hours — the percentage is based on in-house only.
  const trSummary = (list, dept) => {
    if (dept.length === 0 && list.length === 0) return 'None';
    const ihHours = sumHours(list.filter(r => r.is_inhouse));
    const deptHours = sumHours(dept);
    return `${plural(list.length, 'class', 'classes')} <span class="dot">&middot;</span> ${fmtNum(sumHours(list))} hrs ` +
      `<span class="dot">&middot;</span> <span class="of">In-house</span> ${fmtNum(ihHours)}<span class="of">/${fmtNum(deptHours)}</span> ${pctHtml(ihHours, deptHours)}`;
  };
  const trTree = buildPeriodTree(trItems, deptTrItems, start, end, {
    summarize: trSummary,
    renderItem: r => `<div class="it">
      <span class="it-date">${esc(fmtDate(r.date))}</span>
      <span class="it-main">${esc(String(r.name || 'Training'))}${r.category_name ? `<span class="it-sub">${esc(String(r.category_name))}</span>` : ''}</span>
      <span class="it-ref">${r.is_inhouse ? '<span class="tag">In-house</span> ' : ''}${fmtNum(r.hours)} hrs</span>
    </div>`,
  });

  const subtitle = selected
    ? `${esc(String(selected.personnel_full_name))} &mdash; ${esc(start)} to ${esc(end)}`
    : 'Select a member to view their incidents and training';

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input, .fg select {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    .fg select { min-width: 220px; }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }
    .btn-light { background: #fff; color: #1e3a5f; border: 1px solid #c5d0de; padding: 0 12px; }
    .btn-light:hover { background: #eef4fb; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 14px; }

    /* Category cards */
    .cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 18px; align-items: start; }
    .cat { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); overflow: hidden; }
    .cat-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
      background: #1e3a5f; color: #fff; padding: 12px 16px;
    }
    .cat-head h2 { font-size: .95rem; font-weight: 600; }
    .cat-total { font-size: .85rem; font-weight: 600; color: #cfe0f1; }
    .cat-body { padding: 6px 0; }
    .empty-msg {
      background: #fff; border-radius: 8px; padding: 32px;
      text-align: center; color: #888; font-size: .9rem;
    }

    /* Drill-down rows */
    details.pd > summary, .pd-empty {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 9px 16px; cursor: pointer; list-style: none; user-select: none;
      border-bottom: 1px solid #eef0f3;
    }
    details.pd > summary::-webkit-details-marker { display: none; }
    details.pd > summary::before {
      content: '\\25B8'; color: #7a9bbf; font-size: .8rem; margin-right: 8px; transition: transform .12s;
    }
    details.pd[open] > summary::before { transform: rotate(90deg); }
    details.pd > summary:hover { background: #f7f9fc; }
    .pl { font-weight: 600; flex: 1; }
    .ps { font-size: .85rem; font-weight: 600; font-variant-numeric: tabular-nums; color: #1e3a5f; }
    .ps.zero { color: #aaa; font-weight: 400; }
    .dot { color: #aab8c9; margin: 0 3px; }
    .of  { font-weight: 400; color: #8a9bb0; }
    .pct {
      display: inline-block; min-width: 46px; text-align: right;
      font-weight: 700; color: #1e3a5f; margin-left: 4px;
    }
    .cat-total .of  { color: #9fb6cf; }
    .cat-total .pct { color: #fff; }
    .note { font-size: .78rem; color: #777; margin: -8px 0 14px; font-style: italic; }

    .pd-y > summary { background: #f4f6f9; }
    .pd-y > summary .pl { font-size: .95rem; }
    .pd-q > summary, .pd-empty { padding-left: 34px; font-size: .88rem; }
    .pd-q > summary .pl, .pd-empty .pl { font-weight: 500; }
    .pd-empty { cursor: default; color: #888; }

    .items { background: #fbfcfd; }
    .it {
      display: grid; grid-template-columns: 118px 1fr auto; gap: 12px; align-items: start;
      padding: 7px 16px 7px 56px; border-bottom: 1px solid #eef0f3; font-size: .82rem;
    }
    .it:last-child { border-bottom: 1px solid #e2e5ea; }
    .it-date { color: #555; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .it-time { color: #999; margin-left: 4px; }
    .it-main { font-weight: 500; }
    .it-sub  { display: block; font-weight: 400; color: #888; font-size: .76rem; margin-top: 1px; }
    .it-ref  { color: #555; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
    .tag {
      font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
      color: #2a6db5; background: #eef4fb; padding: 1px 7px; border-radius: 9px; margin-right: 4px;
    }
    .meta { margin-top: 12px; font-size: .75rem; color: #999; }

    @media (max-width: 560px) {
      .cats { grid-template-columns: 1fr; }
      .it { grid-template-columns: 1fr auto; padding-left: 40px; }
      .it-date { grid-column: 1 / -1; }
    }

    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .cats { display: block; }
      .cat { box-shadow: none; border: 1px solid #ccc; margin-bottom: 12px; }
      .cat-head { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .it { font-size: .7rem; padding-top: 3px; padding-bottom: 3px; }
      .meta { font-size: .62rem; }
    }
    @page { size: portrait; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${subtitle}</p>

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>Member</label>
      <select name="personnel_id" required>
        <option value="">Select a member…</option>
        ${personnelOptions}
      </select>
    </div>
    <div class="fg">
      <label>From</label>
      <input type="date" name="start" value="${esc(start)}">
    </div>
    <div class="fg">
      <label>To</label>
      <input type="date" name="end" value="${esc(end)}">
    </div>
    <button type="submit">Apply</button>
    <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  ${!selected
    ? `<p class="empty-msg">Choose a member and date range, then press Apply.</p>`
    : `<p class="note">Figures read <strong>member/department</strong> with the member&rsquo;s share. Percentages are tenure-adjusted${memberStart > start ? ` &mdash; department totals count from ${esc(memberStart)}, when this member started` : ''}. Training % is in-house hours attended &divide; department in-house class hours; other courses are listed but not counted in the percentage.</p>
  <div class="toolbar no-print">
    <button type="button" class="btn-light" id="expand-all">Expand all</button>
    <button type="button" class="btn-light" id="collapse-all">Collapse all</button>
  </div>

  <div class="cats">
    <section class="cat">
      <div class="cat-head">
        <h2>Incidents</h2>
        <span class="cat-total">${incSummary(incItems, deptIncItems)} incidents</span>
      </div>
      <div class="cat-body">${incTree}</div>
    </section>

    <section class="cat">
      <div class="cat-head">
        <h2>Training</h2>
        <span class="cat-total">${trSummary(trItems, deptTrItems)}</span>
      </div>
      <div class="cat-body">${trTree}</div>
    </section>
  </div>
  <p class="meta">Quarters are calendar quarters; incident times shown in ${esc(process.env.REPORT_TIMEZONE || 'UTC')} &mdash; generated ${new Date().toLocaleString()}</p>`
  }

  <script>
    (function () {
      var all = function () { return document.querySelectorAll('details.pd'); };
      var setAll = function (open) { all().forEach(function (d) { d.open = open; }); };
      var ex = document.getElementById('expand-all');
      var co = document.getElementById('collapse-all');
      if (ex) ex.addEventListener('click', function () { setAll(true); });
      if (co) co.addEventListener('click', function () { setAll(false); });

      // Print in the default layout (incidents by year, training by year and
      // quarter, no individual items), then restore what the user had open.
      var saved = [];
      window.addEventListener('beforeprint', function () {
        saved = Array.prototype.map.call(all(), function (d) { return d.open; });
        all().forEach(function (d) { d.open = d.dataset.printOpen === '1'; });
      });
      window.addEventListener('afterprint', function () {
        all().forEach(function (d, i) { d.open = saved[i]; });
      });
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Member scorecard report handler — one member vs. their peers.
// ---------------------------------------------------------------------------
async function handleMemberScorecard(req, res, report) {
  const today        = new Date();
  const defaultStart = `${today.getFullYear() - 2}-01-01`;
  const defaultEnd   = today.toISOString().split('T')[0];

  const start = isValidDate(req.query.start) ? req.query.start : defaultStart;
  const end   = isValidDate(req.query.end)   ? req.query.end   : defaultEnd;

  let personnelId = null;
  if (req.query.personnel_id) {
    personnelId = parseInt(req.query.personnel_id, 10);
    if (isNaN(personnelId)) return res.status(400).send('Invalid personnel_id.');
  }

  try {
    const rosterResult = await pool.query(resolveQuery(report.rosterQuery));
    const roster = rosterResult.rows;

    let score = null;
    if (personnelId !== null && roster.some(p => parseInt(p.personnel_id, 10) === personnelId)) {
      const [incResult, respResult, classResult] = await Promise.all([
        pool.query(resolveQuery(report.incidentQuery), [start, end]),
        pool.query(resolveQuery(report.responseQuery), [start, end]),
        pool.query(resolveQuery(report.classQuery),    [start, end]),
      ]);

      let attendance = [];
      if (classResult.rows.length > 0) {
        const attResult = await pool.query(
          resolveQuery(report.attendanceQuery), [classResult.rows.map(c => c.id)]
        );
        attendance = attResult.rows;
      }

      score = computeScorecard(roster, {
        incidents: incResult.rows, responses: respResult.rows,
        classes: classResult.rows, attendance,
      }, start, end, personnelId);
    }

    res.send(buildMemberScorecardHtml(report, roster, score, {
      start, end, personnelId, token: req.query.token || '',
    }));
  } catch (err) {
    console.error(`Member scorecard error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

// Works out, for the selected member and for every active member (the peers),
// incident response and in-house training per calendar quarter. Everything is
// tenure-adjusted: a member is only measured against incidents and classes
// that happened on or after their start date.
function computeScorecard(roster, data, start, end, personnelId) {
  const qKey = d => `${d.slice(0, 4)}-${Math.ceil(parseInt(d.slice(5, 7), 10) / 3)}`;

  const startYM = parseInt(start.slice(0, 4), 10) * 12 + parseInt(start.slice(5, 7), 10);
  const endYM   = parseInt(end.slice(0, 4), 10)   * 12 + parseInt(end.slice(5, 7), 10);
  const quarters = [];
  for (let y = parseInt(start.slice(0, 4), 10); y <= parseInt(end.slice(0, 4), 10); y++) {
    for (let q = 1; q <= 4; q++) {
      if (y * 12 + q * 3 >= startYM && y * 12 + (q - 1) * 3 + 1 <= endYM) quarters.push({ key: `${y}-${q}`, y, q });
    }
  }
  const qIndex = new Map(quarters.map((q, i) => [q.key, i]));

  // Local dates; drop anything the UTC→local conversion pushed outside the range.
  const incidents = data.incidents
    .map(r => ({ id: r.id, date: r.alarm_local.slice(0, 10) }))
    .filter(r => r.date >= start && r.date <= end);
  const classes = data.classes.map(r => ({
    id: r.id, date: r.class_date, hours: parseFloat(r.duration_hours) || 0,
  }));

  const group = (rows, keyField, valField) => {
    const m = new Map();
    rows.forEach(r => {
      if (!m.has(r[keyField])) m.set(r[keyField], new Set());
      m.get(r[keyField]).add(r[valField]);
    });
    return m;
  };
  const responseSets   = group(data.responses,  'personnel_id', 'incident_report_id');
  const attendanceSets = group(data.attendance, 'user_id',      'training_class_id');

  const measure = member => {
    const memberStart = member.personnel_start && member.personnel_start > start ? member.personnel_start : start;
    const inc = quarters.map(() => ({ n: 0, d: 0 }));
    const tr  = quarters.map(() => ({ n: 0, d: 0 }));

    const responded = responseSets.get(member.personnel_id) || new Set();
    incidents.forEach(i => {
      if (i.date < memberStart) return;
      const cell = inc[qIndex.get(qKey(i.date))];
      if (!cell) return;
      cell.d++;
      if (responded.has(i.id)) cell.n++;
    });

    const attended = attendanceSets.get(member.user_id) || new Set();
    classes.forEach(c => {
      if (c.date < memberStart) return;
      const cell = tr[qIndex.get(qKey(c.date))];
      if (!cell) return;
      cell.d += c.hours;
      if (attended.has(c.id)) cell.n += c.hours;
    });

    const sum = cells => cells.reduce((a, c) => ({ n: a.n + c.n, d: a.d + c.d }), { n: 0, d: 0 });
    return { memberStart, inc, tr, incTotal: sum(inc), trTotal: sum(tr) };
  };

  const pct    = c => c.d > 0 ? c.n / c.d * 100 : null;
  const median = vals => {
    const v = vals.filter(x => x !== null).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };

  const selected = roster.find(p => parseInt(p.personnel_id, 10) === personnelId);
  const mine = measure(selected);

  // Peers = active members other than the selected one (who is compared, not averaged in).
  const peers = roster
    .filter(p => p.personnel_is_active && parseInt(p.personnel_id, 10) !== personnelId)
    .map(measure);

  const peerMedian = (pick, i) => median(peers.map(p => pct(pick(p)[i])));
  const rankOf = (value, peerValues) => {
    const others = peerValues.filter(v => v !== null);
    return value === null ? null : { rank: 1 + others.filter(v => v > value).length, of: others.length + 1 };
  };

  const incPeerTotals = peers.map(p => pct(p.incTotal));
  const trPeerTotals  = peers.map(p => pct(p.trTotal));

  return {
    selected, quarters, memberStart: mine.memberStart, peerCount: peers.length,
    inc: {
      cells: mine.inc, total: mine.incTotal,
      peerByQuarter: quarters.map((_, i) => peerMedian(p => p.inc, i)),
      peerTotal: median(incPeerTotals),
      rank: rankOf(pct(mine.incTotal), incPeerTotals),
    },
    tr: {
      cells: mine.tr, total: mine.trTotal,
      peerByQuarter: quarters.map((_, i) => peerMedian(p => p.tr, i)),
      peerTotal: median(trPeerTotals),
      rank: rankOf(pct(mine.trTotal), trPeerTotals),
    },
    pct,
  };
}

// Inline-SVG line chart: member (solid) vs peer median (dashed), by quarter.
// values arrays may contain null (no data that quarter) — the line breaks there.
function buildTrendSvg(quarters, memberVals, peerVals, label) {
  const W = 480, H = 230, L = 40, R = 14, T = 14, B = 44;
  const all = [...memberVals, ...peerVals].filter(v => v !== null);
  const top = Math.min(100, Math.max(20, Math.ceil((Math.max(...all, 0) + 5) / 20) * 20));
  const x = i => quarters.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (quarters.length - 1);
  const y = v => T + (1 - v / top) * (H - T - B);

  const grid = [0, 1, 2, 3, 4].map(k => {
    const v = top * k / 4;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>` +
           `<text x="${L - 6}" y="${y(v) + 3.5}" class="ytick" text-anchor="end">${Math.round(v)}%</text>`;
  }).join('');

  const xLabels = quarters.map((q, i) => {
    const year = (q.q === 1 || i === 0) ? `<tspan x="${x(i)}" dy="12" class="xyear">${q.y}</tspan>` : '';
    return `<text x="${x(i)}" y="${H - B + 16}" class="xtick" text-anchor="middle">Q${q.q}${year}</text>`;
  }).join('');

  // Break the polyline wherever a value is missing
  const path = vals => {
    let d = '', pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const dots = (vals, cls, who) => vals.map((v, i) => v === null ? '' :
    `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${cls === 'm' ? 3.6 : 2.6}" class="dot-${cls}"><title>${who} &mdash; Q${quarters[i].q} ${quarters[i].y}: ${v.toFixed(1)}%</title></circle>`
  ).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" class="chart">
    ${grid}
    <path d="${path(peerVals)}" class="line-p"/>
    <path d="${path(memberVals)}" class="line-m"/>
    ${dots(peerVals, 'p', 'Peer median')}
    ${dots(memberVals, 'm', 'Member')}
    ${xLabels}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Member scorecard HTML builder
// ---------------------------------------------------------------------------
function buildMemberScorecardHtml(report, roster, score, { start, end, personnelId, token }) {
  const fmtNum = n => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
  const fmtPct = v => v === null ? '&mdash;' : `${v.toFixed(1)}%`;

  const optionFor = p => {
    const id = parseInt(p.personnel_id, 10);
    return `<option value="${id}"${id === personnelId ? ' selected' : ''}>${esc(String(p.personnel_full_name || ''))}</option>`;
  };
  const personnelOptions =
    `<optgroup label="Active">${roster.filter(p => p.personnel_is_active).map(optionFor).join('')}</optgroup>` +
    `<optgroup label="Inactive">${roster.filter(p => !p.personnel_is_active).map(optionFor).join('')}</optgroup>`;

  let body;
  if (!score) {
    body = `<p class="empty-msg">Choose a member and date range, then press Apply.</p>`;
  } else {
    const { pct, quarters } = score;
    const incPct = pct(score.inc.total);
    const trPct  = pct(score.tr.total);

    // One headline tile: big percentage, the raw fraction, delta vs peer median, rank.
    const tile = (title, m, unit) => {
      const value = pct(m.total);
      let delta = '<span class="delta flat">No peer data</span>';
      if (value !== null && m.peerTotal !== null) {
        const diff = value - m.peerTotal;
        const cls  = Math.abs(diff) < 0.05 ? 'flat' : diff > 0 ? 'up' : 'down';
        const sign = Math.abs(diff) < 0.05 ? '' : diff > 0 ? '&#9650; +' : '&#9660; &minus;';
        delta = `<span class="delta ${cls}">${sign}${Math.abs(diff).toFixed(1)} pts</span> vs peer median ${fmtPct(m.peerTotal)}`;
      }
      const rank = m.rank
        ? `Ranks <strong>#${m.rank.rank}</strong> of ${m.rank.of}${score.selected.personnel_is_active ? ' active members' : ' (compared with active members)'}`
        : '';
      return `<div class="tile">
        <div class="tile-title">${title}</div>
        <div class="tile-value">${fmtPct(value)}</div>
        <div class="tile-frac">${unit(m.total)}</div>
        <div class="tile-delta">${delta}</div>
        <div class="tile-rank">${rank}</div>
      </div>`;
    };

    const incUnit = t => `${fmtNum(t.n)} of ${fmtNum(t.d)} department incidents`;
    const trUnit  = t => `${fmtNum(t.n)} of ${fmtNum(t.d)} in-house class hours`;

    const incChart = buildTrendSvg(quarters, score.inc.cells.map(pct), score.inc.peerByQuarter, 'Incident response percentage by quarter');
    const trChart  = buildTrendSvg(quarters, score.tr.cells.map(pct),  score.tr.peerByQuarter,  'In-house training percentage by quarter');

    const legend = `<div class="legend"><span><i class="sw sw-m"></i>${esc(String(score.selected.personnel_full_name))}</span><span><i class="sw sw-p"></i>Peer median</span></div>`;

    const rows = quarters.map((q, i) => {
      const ic = score.inc.cells[i], tc = score.tr.cells[i];
      return `<tr>
        <th scope="row">Q${q.q} ${q.y}</th>
        <td class="num">${fmtNum(ic.n)}<span class="of">/${fmtNum(ic.d)}</span></td>
        <td class="num strong">${fmtPct(pct(ic))}</td>
        <td class="num peer">${fmtPct(score.inc.peerByQuarter[i])}</td>
        <td class="num">${fmtNum(tc.n)}<span class="of">/${fmtNum(tc.d)}</span></td>
        <td class="num strong">${fmtPct(pct(tc))}</td>
        <td class="num peer">${fmtPct(score.tr.peerByQuarter[i])}</td>
      </tr>`;
    }).join('');

    const totalRow = `<tr class="total">
      <th scope="row">Total</th>
      <td class="num">${fmtNum(score.inc.total.n)}<span class="of">/${fmtNum(score.inc.total.d)}</span></td>
      <td class="num strong">${fmtPct(incPct)}</td>
      <td class="num peer">${fmtPct(score.inc.peerTotal)}</td>
      <td class="num">${fmtNum(score.tr.total.n)}<span class="of">/${fmtNum(score.tr.total.d)}</span></td>
      <td class="num strong">${fmtPct(trPct)}</td>
      <td class="num peer">${fmtPct(score.tr.peerTotal)}</td>
    </tr>`;

    const tenure = score.memberStart > start
      ? ` Measured from ${esc(score.memberStart)}, when this member started.` : '';

    body = `
  <div class="tiles">
    ${tile('Incident response', score.inc, incUnit)}
    ${tile('In-house training', score.tr, trUnit)}
  </div>

  <div class="charts">
    <section class="card">
      <h2>Incident response by quarter</h2>
      ${incChart}
    </section>
    <section class="card">
      <h2>In-house training by quarter</h2>
      ${trChart}
    </section>
  </div>
  ${legend}

  <section class="card table-card">
    <h2>Quarter detail</h2>
    <div class="tw">
      <table>
        <thead>
          <tr>
            <th rowspan="2"></th>
            <th colspan="3" class="grp">Incidents</th>
            <th colspan="3" class="grp">In-house training (hrs)</th>
          </tr>
          <tr>
            <th class="num">Member</th><th class="num">%</th><th class="num">Peer med.</th>
            <th class="num">Member</th><th class="num">%</th><th class="num">Peer med.</th>
          </tr>
        </thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>
  </section>

  <p class="note">Percentages are the member&rsquo;s share of everything that happened while they were on the department (tenure-adjusted).${tenure}
    Peer median is the middle value across the ${score.peerCount} other active member${score.peerCount !== 1 ? 's' : ''}, each measured the same way.
    Training counts in-house classes only. Quarters and incident times use ${esc(process.env.REPORT_TIMEZONE || 'UTC')}.</p>
  <p class="meta">Generated ${new Date().toLocaleString()}</p>`;
  }

  const subtitle = score
    ? `${esc(String(score.selected.personnel_full_name))} &mdash; ${esc(start)} to ${esc(end)}`
    : 'Select a member to compare their incident response and training with their peers';

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input, .fg select {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    .fg select { min-width: 220px; }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }
    .empty-msg {
      background: #fff; border-radius: 8px; padding: 32px;
      text-align: center; color: #888; font-size: .9rem;
    }

    /* Headline tiles */
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 16px; }
    .tile {
      background: #fff; border-radius: 8px; padding: 16px 20px;
      box-shadow: 0 1px 4px rgba(0,0,0,.12); border-left: 4px solid #1e3a5f;
    }
    .tile-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #666; }
    .tile-value { font-size: 2.4rem; font-weight: 700; color: #1e3a5f; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .tile-frac  { font-size: .8rem; color: #777; margin-bottom: 8px; }
    .tile-delta { font-size: .85rem; color: #444; }
    .tile-rank  { font-size: .82rem; color: #666; margin-top: 3px; min-height: 1.1em; }
    .delta { font-weight: 700; }
    .delta.up   { color: #1d6b3a; }
    .delta.down { color: #a4372a; }
    .delta.flat { color: #777; }

    /* Charts */
    .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .card { background: #fff; border-radius: 8px; padding: 14px 16px 10px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    .card h2 { font-size: .85rem; font-weight: 600; color: #1e3a5f; margin-bottom: 6px; }
    .chart { width: 100%; height: auto; display: block; }
    .chart .grid  { stroke: #e6e9ee; stroke-width: 1; }
    .chart .ytick, .chart .xtick { font-size: 10px; fill: #777; }
    .chart .xyear { fill: #999; }
    .chart .line-m { fill: none; stroke: #1e3a5f; stroke-width: 2.5; stroke-linejoin: round; }
    .chart .line-p { fill: none; stroke: #8a96a8; stroke-width: 2; stroke-dasharray: 5 4; }
    .chart .dot-m { fill: #1e3a5f; }
    .chart .dot-p { fill: #fff; stroke: #8a96a8; stroke-width: 1.5; }
    .legend { display: flex; flex-wrap: wrap; gap: 18px; font-size: .78rem; color: #555; margin: 8px 2px 16px; }
    .sw { display: inline-block; width: 22px; height: 0; border-top: 3px solid; vertical-align: middle; margin-right: 6px; }
    .sw-m { border-color: #1e3a5f; }
    .sw-p { border-top: 3px dashed #8a96a8; }

    /* Quarter table */
    .table-card { padding: 14px 0 0; overflow: hidden; }
    .table-card h2 { padding: 0 16px; margin-bottom: 8px; }
    .tw { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    thead th {
      background: #1e3a5f; color: #fff; padding: 7px 12px; font-size: .72rem;
      text-transform: uppercase; letter-spacing: .04em; font-weight: 600; white-space: nowrap;
    }
    thead th.grp { text-align: center; border-left: 1px solid rgba(255,255,255,.25); }
    thead tr + tr th { background: #2a5080; text-transform: none; letter-spacing: 0; font-size: .72rem; }
    tbody th { text-align: left; font-weight: 600; padding: 7px 12px; white-space: nowrap; }
    tbody td, tbody th { border-bottom: 1px solid #eef0f3; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding: 7px 12px; }
    td.strong { font-weight: 700; color: #1e3a5f; }
    td.peer   { color: #7b8797; }
    .of { color: #9aa5b4; font-weight: 400; }
    tbody tr:hover td, tbody tr:hover th { background: #f7f9fc; }
    tr.total th, tr.total td { background: #eef0f3; font-weight: 700; border-top: 2px solid #c0c8d4; border-bottom: none; }
    tr.total td.peer { color: #55606f; }

    .note { font-size: .76rem; color: #777; margin-top: 14px; line-height: 1.5; max-width: 860px; }
    .meta { margin-top: 6px; font-size: .72rem; color: #999; }

    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .tiles  { grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
      .charts { grid-template-columns: 1fr 1fr; gap: 8px; }
      .tile, .card { box-shadow: none; border: 1px solid #d5d9df; break-inside: avoid; }
      .tile { padding: 8px 12px; }
      .tile-value { font-size: 1.7rem; }
      .card { padding: 8px 10px 4px; }
      table { font-size: .72rem; }
      td.num, th.num, tbody th { padding: 3px 8px; }
      thead th, .tile, tr.total th, tr.total td, .chart * {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
      .legend { margin: 4px 2px 8px; }
      .note { font-size: .62rem; margin-top: 8px; }
    }
    @page { size: portrait; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${subtitle}</p>

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>Member</label>
      <select name="personnel_id" required>
        <option value="">Select a member…</option>
        ${personnelOptions}
      </select>
    </div>
    <div class="fg">
      <label>From</label>
      <input type="date" name="start" value="${esc(start)}">
    </div>
    <div class="fg">
      <label>To</label>
      <input type="date" name="end" value="${esc(end)}">
    </div>
    <button type="submit">Apply</button>
    <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  ${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Incident projection report handler
// ?as_of=YYYY-MM-DD (default: yesterday, the last complete day)
// ?years=3|5|7|all  (how many prior years to learn from, default 5)
// ---------------------------------------------------------------------------
async function handleProjection(req, res, report) {
  const tz = process.env.REPORT_TIMEZONE || 'UTC';
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });   // YYYY-MM-DD
  const yesterday  = new Date(`${todayLocal}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const defaultAsOf = yesterday.toISOString().slice(0, 10);

  let asOf = isValidDate(req.query.as_of) ? req.query.as_of : defaultAsOf;
  if (asOf > todayLocal) asOf = todayLocal;

  const yearsParam = ['3', '5', '7', 'all'].includes(req.query.years) ? req.query.years : '5';
  const asOfYear   = parseInt(asOf.slice(0, 4), 10);
  const firstYear  = yearsParam === 'all' ? asOfYear - 50 : asOfYear - parseInt(yearsParam, 10);

  try {
    const result = await pool.query(resolveQuery(report.dailyQuery), [`${firstYear}-01-01`, `${asOfYear}-12-31`]);
    const proj = computeProjection(result.rows, asOf, firstYear, todayLocal);
    res.send(buildProjectionHtml(report, proj, { asOf, yearsParam, token: req.query.token || '' }));
  } catch (err) {
    console.error(`Projection error for "${report.title}":`, err.message);
    res.status(500).send('Error loading report data. Check server logs.');
  }
}

// Day-of-year index on a leap-year calendar (0 = Jan 1, 365 = Dec 31) so the
// same calendar date lines up across every year.
const CUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
function dayIndex(mmdd) {
  return CUM_DAYS[parseInt(mmdd.slice(0, 2), 10) - 1] + parseInt(mmdd.slice(3, 5), 10) - 1;
}

function computeProjection(rows, asOf, firstYear, todayLocal) {
  const asOfYear = parseInt(asOf.slice(0, 4), 10);
  const cutIdx   = dayIndex(asOf.slice(5));

  // year -> 366 daily counts
  const daily = new Map();
  rows.forEach(r => {
    const y = parseInt(r.local_date.slice(0, 4), 10);
    if (y < firstYear || y > asOfYear) return;
    if (!daily.has(y)) daily.set(y, new Array(366).fill(0));
    daily.get(y)[dayIndex(r.local_date.slice(5))] += r.n;
  });

  const yearStats = y => {
    const d = daily.get(y) || new Array(366).fill(0);
    const cum = [];
    d.reduce((a, n, i) => (cum[i] = a + n), 0);
    const months = CUM_DAYS.map((s, m) => d.slice(s, m < 11 ? CUM_DAYS[m + 1] : 366).reduce((a, b) => a + b, 0));
    return { year: y, cum, total: cum[365], ytd: cum[cutIdx], months };
  };

  // History = complete prior years that have data
  const history = [...daily.keys()]
    .filter(y => y < asOfYear)
    .sort((a, b) => a - b)
    .map(yearStats)
    .filter(h => h.total > 0)
    .map(h => ({
      ...h,
      share:     h.ytd / h.total,           // fraction of the year done by this date
      remaining: h.total - h.ytd,
    }));

  const current = yearStats(asOfYear);
  const ytd = current.ytd;

  // Actual year-end is known only when back-testing a finished year
  const yearComplete = `${asOfYear}-12-31` < todayLocal;
  const actual = yearComplete ? current.total : null;

  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const daysInYear  = (asOfYear % 4 === 0 && asOfYear % 100 !== 0) || asOfYear % 400 === 0 ? 366 : 365;
  const daysElapsed = Math.round((Date.UTC(asOfYear, parseInt(asOf.slice(5, 7), 10) - 1, parseInt(asOf.slice(8, 10), 10)) - Date.UTC(asOfYear, 0, 1)) / 864e5) + 1;

  const usable  = history.filter(h => h.share > 0);
  const implied = usable.map(h => ytd / h.share);
  const last    = history[history.length - 1] || null;

  const methods = [];
  let headline = null, low = null, high = null;

  if (usable.length > 0 && ytd > 0) {
    headline = ytd / mean(usable.map(h => h.share));
    low  = Math.min(...implied);
    high = Math.max(...implied);
    methods.push({
      key: 'seasonal', name: 'Seasonal share (headline)', value: headline,
      how: `By this date past years averaged ${(mean(usable.map(h => h.share)) * 100).toFixed(1)}% of their annual volume. Year-to-date ÷ that share.`,
    });
  }
  if (daysElapsed > 0) {
    methods.push({
      key: 'runrate', name: 'Straight run rate', value: ytd / daysElapsed * daysInYear,
      how: `${(ytd / daysElapsed).toFixed(2)} calls/day so far × ${daysInYear} days. Ignores seasonality.`,
    });
  }
  if (history.length > 0) {
    const avgRemaining = mean(history.map(h => h.remaining));
    methods.push({
      key: 'remainder', name: 'YTD + average remainder', value: ytd + avgRemaining,
      how: `Year-to-date plus the ${Math.round(avgRemaining)} calls past years averaged after this date. Assumes the rest of the year is typical.`,
    });
  }
  if (last && last.ytd > 0) {
    methods.push({
      key: 'lastyear', name: `${last.year} pace`, value: ytd * last.total / last.ytd,
      how: `Assumes the rest of the year runs ${((ytd / last.ytd - 1) * 100).toFixed(1)}% ${ytd >= last.ytd ? 'ahead of' : 'behind'} ${last.year}, as it has so far.`,
    });
  }
  if (history.length >= 3) {
    // Least-squares line through past annual totals
    const xs = history.map(h => h.year), ys = history.map(h => h.total);
    const mx = mean(xs), my = mean(ys);
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    methods.push({
      key: 'trend', name: 'Long-term trend line', value: my + slope * (asOfYear - mx),
      how: `Line through ${xs[0]}–${xs[xs.length - 1]} totals (${slope >= 0 ? '+' : ''}${slope.toFixed(1)}/yr). Ignores this year's actual pace.`,
    });
  }

  return {
    asOf, asOfYear, cutIdx, daysElapsed, daysInYear, history, current, ytd,
    headline, low, high, actual, methods, last,
    lastSameDate: last ? last.ytd : null,
  };
}

// Cumulative incidents by day of year: past years (grey), this year (navy),
// projection range (shaded cone) out to Dec 31.
function buildCumulativeSvg(p) {
  const W = 820, H = 340, L = 46, R = 72, T = 14, B = 30;
  const tops = [p.ytd, p.high || 0, p.actual || 0, ...p.history.map(h => h.total)];
  const step = Math.max(...tops) > 400 ? 100 : 50;
  const top  = Math.max(step, Math.ceil(Math.max(...tops) * 1.04 / step) * step);
  const x = i => L + i / 365 * (W - L - R);
  const y = v => T + (1 - v / top) * (H - T - B);

  const ticks = [];
  for (let v = 0; v <= top; v += step) {
    ticks.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>` +
               `<text x="${L - 6}" y="${y(v) + 3.5}" class="tick" text-anchor="end">${v}</text>`);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthTicks = CUM_DAYS.map((s, m) =>
    `<line x1="${x(s)}" x2="${x(s)}" y1="${H - B}" y2="${H - B + 4}" class="axis"/>` +
    `<text x="${x(s + 15)}" y="${H - B + 16}" class="tick" text-anchor="middle">${MONTHS[m]}</text>`
  ).join('');

  const line = (cum, upTo) => cum.slice(0, upTo + 1)
    .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  // End-of-line labels on the right, nudged apart so they don't overlap
  const labels = p.history.map((h, i) => ({
    v: h.total, text: `${h.year}  ${h.total}`, cls: i === p.history.length - 1 ? 'lbl-last' : 'lbl-hist',
  }));
  if (p.headline !== null) labels.push({ v: p.headline, text: `Proj ${Math.round(p.headline)}`, cls: 'lbl-proj' });
  if (p.actual !== null)   labels.push({ v: p.actual,   text: `Actual ${p.actual}`, cls: 'lbl-actual' });
  labels.sort((a, b) => b.v - a.v);
  let prevY = -Infinity;
  const labelSvg = labels.map(l => {
    const ly = Math.max(y(l.v) + 3.5, prevY + 11);
    prevY = ly;
    return `<text x="${W - R + 6}" y="${ly.toFixed(1)}" class="${l.cls}">${esc(l.text)}</text>`;
  }).join('');

  const histLines = p.history.map((h, i) =>
    `<path d="${line(h.cum, 365)}" class="${i === p.history.length - 1 ? 'ln-last' : 'ln-hist'}"><title>${h.year}: ${h.total} incidents</title></path>`
  ).join('');

  const cx = x(p.cutIdx), cy = y(p.ytd);
  const cone = p.headline === null ? '' : `
    <polygon points="${cx},${cy} ${x(365)},${y(p.high)} ${x(365)},${y(p.low)}" class="cone"/>
    <line x1="${cx}" y1="${cy}" x2="${x(365)}" y2="${y(p.headline)}" class="ln-proj"/>`;

  const actualRest = p.actual === null ? '' :
    `<path d="${p.current.cum.slice(p.cutIdx).map((v, i) => `${i ? 'L' : 'M'}${x(p.cutIdx + i).toFixed(1)},${y(v).toFixed(1)}`).join('')}" class="ln-actual"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Cumulative incidents by day of year">
    ${ticks.join('')}
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>
    ${monthTicks}
    <line x1="${cx}" x2="${cx}" y1="${T}" y2="${H - B}" class="today"/>
    ${histLines}
    ${cone}
    ${actualRest}
    <path d="${line(p.current.cum, p.cutIdx)}" class="ln-cur"/>
    <circle cx="${cx}" cy="${cy}" r="4" class="pt-cur"><title>${p.asOfYear} through ${p.asOf}: ${p.ytd}</title></circle>
    ${labelSvg}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Incident projection HTML builder
// ---------------------------------------------------------------------------
function buildProjectionHtml(report, p, { asOf, yearsParam, token }) {
  const r0   = v => Math.round(v).toLocaleString('en-US');
  const sdt  = new Date(`${asOf}T00:00:00Z`);
  const dateLabel = sdt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const pctChange = (a, b) => {
    if (!(b > 0)) return '&mdash;';
    const d = (a / b - 1) * 100;
    if (Math.abs(d) < 0.05) return '0.0%';
    return `${d > 0 ? '+' : '&minus;'}${Math.abs(d).toFixed(1)}%`;
  };

  const yearOptions = [['3', 'Last 3 years'], ['5', 'Last 5 years'], ['7', 'Last 7 years'], ['all', 'All years']]
    .map(([v, l]) => `<option value="${v}"${v === yearsParam ? ' selected' : ''}>${l}</option>`).join('');

  const remainingDays = p.daysInYear - p.daysElapsed;
  const lastTotal = p.last ? p.last.total : null;

  // --- Tiles ---
  const projTile = p.headline === null
    ? `<div class="tile tile-main"><div class="tile-title">Projected ${p.asOfYear} total</div><div class="tile-value">&mdash;</div><div class="tile-sub">Not enough history to project.</div></div>`
    : `<div class="tile tile-main">
        <div class="tile-title">Projected ${p.asOfYear} total</div>
        <div class="tile-value">${r0(p.headline)}</div>
        <div class="tile-sub">Range ${r0(p.low)} &ndash; ${r0(p.high)} <span class="muted">(based on how each past year finished)</span></div>
        ${lastTotal ? `<div class="tile-sub">${pctChange(p.headline, lastTotal)} vs ${p.last.year} (${r0(lastTotal)})</div>` : ''}
        ${p.actual !== null ? `<div class="tile-actual">Actual year-end: <strong>${r0(p.actual)}</strong> &mdash; projection was ${pctChange(p.headline, p.actual)} off</div>` : ''}
      </div>`;

  const ytdTile = `<div class="tile">
      <div class="tile-title">Year to date</div>
      <div class="tile-value">${r0(p.ytd)}</div>
      <div class="tile-sub">Through ${esc(dateLabel)} &middot; day ${p.daysElapsed} of ${p.daysInYear} &middot; ${(p.ytd / Math.max(p.daysElapsed, 1)).toFixed(2)}/day</div>
      ${p.lastSameDate !== null ? `<div class="tile-sub">${pctChange(p.ytd, p.lastSameDate)} vs ${p.last.year} at this date (${r0(p.lastSameDate)})</div>` : ''}
    </div>`;

  const restTile = p.headline === null ? '' : `<div class="tile">
      <div class="tile-title">Still to come</div>
      <div class="tile-value">~${r0(p.headline - p.ytd)}</div>
      <div class="tile-sub">over the remaining ${remainingDays} day${remainingDays !== 1 ? 's' : ''}${remainingDays > 0 ? ` &middot; ~${((p.headline - p.ytd) / remainingDays).toFixed(2)}/day` : ''}</div>
      <div class="tile-sub">Range ${r0(p.low - p.ytd)} &ndash; ${r0(p.high - p.ytd)}</div>
    </div>`;

  // --- Methods table ---
  const methodRows = p.methods.map(m => `<tr${m.key === 'seasonal' ? ' class="hl"' : ''}>
      <th scope="row">${esc(m.name)}</th>
      <td class="num strong">${r0(m.value)}</td>
      <td class="num">${lastTotal ? pctChange(m.value, lastTotal) : '&mdash;'}</td>
      ${p.actual !== null ? `<td class="num">${pctChange(m.value, p.actual)}</td>` : ''}
      <td class="how">${esc(m.how)}</td>
    </tr>`).join('');

  // --- History table ---
  const histRows = p.history.map(h => `<tr>
      <th scope="row">${h.year}</th>
      <td class="num">${r0(h.ytd)}</td>
      <td class="num">${r0(h.remaining)}</td>
      <td class="num strong">${r0(h.total)}</td>
      <td class="num">${(h.share * 100).toFixed(1)}%</td>
      <td class="num">${h.share > 0 && p.ytd > 0 ? r0(p.ytd / h.share) : '&mdash;'}</td>
    </tr>`).join('');
  const curRow = `<tr class="cur">
      <th scope="row">${p.asOfYear}</th>
      <td class="num strong">${r0(p.ytd)}</td>
      <td class="num">${p.actual !== null ? r0(p.actual - p.ytd) : p.headline !== null ? `~${r0(p.headline - p.ytd)}` : '&mdash;'}</td>
      <td class="num strong">${p.actual !== null ? r0(p.actual) : p.headline !== null ? `~${r0(p.headline)}` : '&mdash;'}</td>
      <td class="num">${p.actual !== null && p.actual > 0 ? `${(p.ytd / p.actual * 100).toFixed(1)}%` : '&mdash;'}</td>
      <td class="num"></td>
    </tr>`;

  // --- Monthly table ---
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cutMonth = parseInt(asOf.slice(5, 7), 10) - 1;
  const curMonths = p.current.cum.length ? CUM_DAYS.map((s, m) => {
    if (m > cutMonth) return null;
    const endIdx = m < cutMonth ? (m < 11 ? CUM_DAYS[m + 1] - 1 : 365) : p.cutIdx;
    return p.current.cum[endIdx] - (s > 0 ? p.current.cum[s - 1] : 0);
  }) : [];
  const monthAvg = m => p.history.length ? p.history.reduce((a, h) => a + h.months[m], 0) / p.history.length : null;
  const monthRows = MONTHS.map((name, m) => `<tr>
      <th scope="row">${name}</th>
      ${p.history.map(h => `<td class="num">${h.months[m]}</td>`).join('')}
      <td class="num avg">${monthAvg(m) !== null ? monthAvg(m).toFixed(0) : ''}</td>
      <td class="num strong">${curMonths[m] === null ? '' : `${curMonths[m]}${m === cutMonth && p.cutIdx < (m < 11 ? CUM_DAYS[m + 1] - 1 : 365) ? '<span class="partial">*</span>' : ''}`}</td>
    </tr>`).join('');
  const monthTotalRow = `<tr class="total">
      <th scope="row">Total</th>
      ${p.history.map(h => `<td class="num">${h.total}</td>`).join('')}
      <td class="num avg">${p.history.length ? (p.history.reduce((a, h) => a + h.total, 0) / p.history.length).toFixed(0) : ''}</td>
      <td class="num strong">${p.ytd}</td>
    </tr>`;

  const early = p.daysElapsed < 60
    ? `<p class="warn">It&rsquo;s early in the year &mdash; with only ${p.daysElapsed} days of data, expect the projection to move a lot.</p>` : '';

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input, .fg select {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }
    .hint { font-size: .75rem; color: #888; align-self: center; }

    /* Tiles */
    .tiles { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .tile {
      background: #fff; border-radius: 8px; padding: 16px 20px;
      box-shadow: 0 1px 4px rgba(0,0,0,.12); border-left: 4px solid #8a96a8;
    }
    .tile-main { border-left-color: #1e3a5f; }
    .tile-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #666; }
    .tile-value { font-size: 2.4rem; font-weight: 700; color: #1e3a5f; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .tile-sub   { font-size: .82rem; color: #555; margin-top: 3px; }
    .tile-actual { font-size: .82rem; margin-top: 8px; padding: 6px 8px; background: #fdf1ef; border-radius: 4px; color: #7a2b20; }
    .muted { color: #999; }
    .warn { background: #fff8e6; border: 1px solid #f0d9a0; color: #7a5a10; border-radius: 6px; padding: 8px 12px; font-size: .82rem; margin-bottom: 16px; }

    /* Cards */
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); margin-bottom: 16px; overflow: hidden; }
    .card h2 { font-size: .88rem; font-weight: 600; color: #1e3a5f; padding: 14px 16px 6px; }
    .card .lead { font-size: .78rem; color: #777; padding: 0 16px 8px; }
    .chart-wrap { padding: 4px 12px 8px; }
    .chart { width: 100%; height: auto; display: block; }
    .chart .grid { stroke: #e6e9ee; }
    .chart .axis { stroke: #b8c0cc; }
    .chart .tick { font-size: 10px; fill: #777; }
    .chart .today { stroke: #c0c8d4; stroke-dasharray: 2 3; }
    .chart .ln-hist { fill: none; stroke: #c3cad4; stroke-width: 1.3; }
    .chart .ln-last { fill: none; stroke: #7f8b9c; stroke-width: 1.8; }
    .chart .ln-cur  { fill: none; stroke: #1e3a5f; stroke-width: 3; stroke-linejoin: round; }
    .chart .ln-proj { stroke: #1e3a5f; stroke-width: 2; stroke-dasharray: 6 4; }
    .chart .ln-actual { fill: none; stroke: #c0392b; stroke-width: 1.8; stroke-dasharray: 2 3; }
    .chart .cone { fill: #1e3a5f; fill-opacity: .12; }
    .chart .pt-cur { fill: #1e3a5f; stroke: #fff; stroke-width: 1.5; }
    .chart .lbl-hist { font-size: 10px; fill: #9aa5b4; }
    .chart .lbl-last { font-size: 10px; fill: #5f6b7c; font-weight: 600; }
    .chart .lbl-proj { font-size: 10.5px; fill: #1e3a5f; font-weight: 700; }
    .chart .lbl-actual { font-size: 10.5px; fill: #c0392b; font-weight: 700; }
    .legend { display: flex; flex-wrap: wrap; gap: 18px; font-size: .76rem; color: #555; padding: 0 16px 12px; }
    .sw { display: inline-block; width: 22px; height: 0; border-top: 3px solid; vertical-align: middle; margin-right: 6px; }
    .sw-cur  { border-color: #1e3a5f; }
    .sw-proj { border-top: 2px dashed #1e3a5f; }
    .sw-cone { height: 10px; border: none; background: rgba(30,58,95,.15); }
    .sw-last { border-color: #7f8b9c; border-top-width: 2px; }
    .sw-hist { border-color: #c3cad4; border-top-width: 2px; }
    .sw-act  { border-top: 2px dotted #c0392b; }

    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .two .card { margin-bottom: 0; }

    /* Tables */
    .tw { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: .84rem; }
    thead th {
      background: #1e3a5f; color: #fff; padding: 7px 12px; font-size: .7rem;
      text-transform: uppercase; letter-spacing: .04em; font-weight: 600; text-align: left; white-space: nowrap;
    }
    thead th.num { text-align: right; }
    tbody th { text-align: left; font-weight: 600; padding: 6px 12px; white-space: nowrap; }
    tbody td { padding: 6px 12px; }
    tbody tr > * { border-bottom: 1px solid #eef0f3; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.strong { font-weight: 700; color: #1e3a5f; }
    td.avg { color: #7b8797; font-style: italic; }
    td.how { font-size: .76rem; color: #666; }
    tr.hl > * { background: #eef4fb; }
    tr.cur > * { background: #eef4fb; border-top: 2px solid #c0c8d4; }
    tr.total > * { background: #eef0f3; font-weight: 700; border-top: 2px solid #c0c8d4; }
    .partial { color: #c0392b; margin-left: 1px; }

    .note { font-size: .76rem; color: #777; line-height: 1.5; margin-top: 14px; max-width: 900px; }
    .meta { margin-top: 6px; font-size: .72rem; color: #999; }

    @media (max-width: 900px) {
      .tiles, .two { grid-template-columns: 1fr; }
    }

    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .tiles { grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; margin-bottom: 8px; }
      .tile, .card { box-shadow: none; border: 1px solid #d5d9df; break-inside: avoid; }
      .tile { padding: 8px 12px; }
      .tile-value { font-size: 1.6rem; }
      .tile-sub, .tile-actual { font-size: .68rem; }
      .card { margin-bottom: 8px; }
      .card h2 { padding: 8px 10px 4px; font-size: .78rem; }
      .card .lead { display: none; }
      .legend { font-size: .64rem; padding-bottom: 4px; }
      .chart-wrap { padding: 0 8px; }
      .chart { height: 7.2cm; }
      table { font-size: .64rem; }
      tbody th, tbody td, thead th { padding: 1px 8px; }
      td.how { font-size: .6rem; }
      .two { grid-template-columns: 1fr 1fr; gap: 8px; }
      .note { font-size: .6rem; margin-top: 6px; }
      thead th, tr.hl > *, tr.cur > *, tr.total > *, .tile-actual, .chart * {
        -webkit-print-color-adjust: exact; print-color-adjust: exact;
      }
    }
    @page { size: portrait; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${p.asOfYear} year-end estimate as of ${esc(asOf)} &mdash; learning from ${p.history.length} prior year${p.history.length !== 1 ? 's' : ''}${p.history.length ? ` (${p.history[0].year}&ndash;${p.history[p.history.length - 1].year})` : ''}</p>

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>As of</label>
      <input type="date" name="as_of" value="${esc(asOf)}">
    </div>
    <div class="fg">
      <label>Compare with</label>
      <select name="years">${yearOptions}</select>
    </div>
    <button type="submit">Apply</button>
    <span class="hint">Tip: pick a date in a past year to see how well the projection would have done.</span>
    <button type="button" class="btn-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  ${early}

  <div class="tiles">
    ${projTile}
    ${ytdTile}
    ${restTile}
  </div>

  <section class="card">
    <h2>Running total by day of year</h2>
    <p class="lead">Each line is one year&rsquo;s cumulative incident count. The shaded cone is the projection range from today to Dec 31.</p>
    <div class="chart-wrap">${buildCumulativeSvg(p)}</div>
    <div class="legend">
      <span><i class="sw sw-cur"></i>${p.asOfYear}</span>
      <span><i class="sw sw-proj"></i>Projection</span>
      <span><i class="sw sw-cone"></i>Projection range</span>
      ${p.last ? `<span><i class="sw sw-last"></i>${p.last.year}</span>` : ''}
      <span><i class="sw sw-hist"></i>Earlier years</span>
      ${p.actual !== null ? `<span><i class="sw sw-act"></i>${p.asOfYear} actual</span>` : ''}
    </div>
  </section>

  <section class="card">
    <h2>Projection methods</h2>
    <p class="lead">Different ways to estimate the same number. When they agree, the estimate is solid; when they spread out, lean on the range.</p>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Method</th><th class="num">Projection</th><th class="num">vs ${p.last ? p.last.year : 'last yr'}</th>
          ${p.actual !== null ? '<th class="num">vs actual</th>' : ''}
          <th>How it works</th>
        </tr></thead>
        <tbody>${methodRows}</tbody>
      </table>
    </div>
  </section>

  <div class="two">
    <section class="card">
      <h2>Past years at this date</h2>
      <div class="tw">
        <table>
          <thead><tr>
            <th>Year</th><th class="num">By ${esc(dateLabel)}</th><th class="num">After</th>
            <th class="num">Full year</th><th class="num">% done</th><th class="num">Implies</th>
          </tr></thead>
          <tbody>${histRows}${curRow}</tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2>Incidents by month</h2>
      <div class="tw">
        <table>
          <thead><tr>
            <th></th>${p.history.map(h => `<th class="num">${h.year}</th>`).join('')}<th class="num">Avg</th><th class="num">${p.asOfYear}</th>
          </tr></thead>
          <tbody>${monthRows}${monthTotalRow}</tbody>
        </table>
      </div>
    </section>
  </div>

  <p class="note">
    <strong>How the headline works:</strong> for each past year, we look at what share of its annual total had already happened by ${esc(dateLabel)}.
    Dividing this year&rsquo;s year-to-date count by the average share gives the projection; doing it with each year&rsquo;s share individually gives the range.
    This accounts for seasonality (busy and slow months) and for this year being busier or quieter than usual.
    Counts are incident reports by local date (${esc(process.env.REPORT_TIMEZONE || 'UTC')}); the default as-of date is yesterday so a partial day isn&rsquo;t counted.
    ${curMonths.length ? '<span class="partial">*</span> partial month.' : ''}
  </p>
  <p class="meta">Generated ${new Date().toLocaleString()}</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Matrix HTML builder
// ---------------------------------------------------------------------------
function buildMatrixHtml(report, classes, roster, attendance, { start, end, token }) {
  // Fast O(1) lookup keyed on integer IDs — avoids name-format mismatches.
  const attended = new Set(attendance.map(a => `${a.training_class_id}:${a.user_id}`));

  const fmtDate = d => {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
  };

  const classHeaders = classes.map(c =>
    `<th class="col-head"><span class="ch-name">${esc(c.name)}</span><span class="ch-date">${fmtDate(c.class_date)}</span></th>`
  ).join('');

  const colTotals = classes.map(c =>
    roster.filter(({ user_id }) => attended.has(`${c.id}:${user_id}`)).length
  );
  const grandTotal   = colTotals.reduce((a, b) => a + b, 0);
  const colTotalCells = colTotals.map(t => `<td class="total-cell">${t}</td>`).join('');

  const dataRows = roster.map(({ user_id, personnel_full_name }) => {
    let rowTotal = 0;
    const cells = classes.map(c => {
      if (attended.has(`${c.id}:${user_id}`)) { rowTotal++; return `<td class="att-yes">X</td>`; }
      return `<td class="att-no"></td>`;
    }).join('');
    return `<tr><td class="name-cell sticky-col">${esc(personnel_full_name)}</td>${cells}<td class="total-cell">${rowTotal}</td></tr>`;
  }).join('');

  const subtitle = `In-house trainings &mdash; ${esc(start)} to ${esc(end)} &mdash; ${classes.length} class${classes.length !== 1 ? 'es' : ''}, ${roster.length} firefighter${roster.length !== 1 ? 's' : ''}`;

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }

    /* Matrix table — border-separate so sticky first column works */
    .mw { overflow-x: auto; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    table.mx { border-collapse: separate; border-spacing: 0; background: #fff; }

    /* Sticky name column */
    .sticky-col { position: sticky; left: 0; z-index: 1; background: #fff; }
    thead .sticky-col { z-index: 2; background: #1e3a5f; }

    /* Name column header */
    .name-head {
      background: #1e3a5f; color: #fff;
      padding: 10px 16px; text-align: left;
      font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
      vertical-align: bottom; white-space: nowrap; min-width: 180px;
      border-right: 2px solid rgba(255,255,255,.2);
    }

    /* Rotated class column headers — writing-mode makes the th rotate;
       display:block on the inner spans creates two side-by-side "columns"
       in the vertical writing mode, which appear as two stacked lines
       after the 180deg rotation. */
    .col-head {
      background: #1e3a5f;
      writing-mode: vertical-lr;
      transform: rotate(180deg);
      white-space: nowrap;
      padding: 10px 6px;
      border-left: 1px solid rgba(255,255,255,.12);
      height: 150px; min-width: 34px;
      vertical-align: top;
    }
    .ch-name {
      display: block;
      color: #fff; font-size: .72rem; font-weight: 600;
    }
    .ch-date {
      display: block;
      color: #91adc9; font-size: .62rem; font-weight: 400;
      margin-left: 4px;
    }

    /* Data cells */
    .name-cell {
      padding: 5px 16px; font-size: .82rem; font-weight: 500;
      white-space: nowrap; border-right: 2px solid #e2e5ea;
      border-bottom: 1px solid #eef0f3;
    }
    tbody tr:hover .name-cell { background: #f7f9fc; }
    .att-yes {
      text-align: center; vertical-align: middle;
      font-size: .8rem; font-weight: 700; color: #276221;
      background: #c6efce; border-bottom: 1px solid #eef0f3;
      border-left: 1px solid #eef0f3; padding: 3px;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .att-no { border-bottom: 1px solid #eef0f3; border-left: 1px solid #eef0f3; }
    /* Totals column header */
    .total-head {
      background: #1e3a5f; color: #fff;
      padding: 10px 12px; font-size: .72rem; font-weight: 700;
      border-left: 2px solid rgba(255,255,255,.3);
      vertical-align: bottom; text-align: center; white-space: nowrap;
    }
    /* Totals cells — right column (row totals) and bottom row (col totals) */
    .total-cell {
      text-align: center; font-weight: 700; font-size: .82rem;
      background: #eef0f3; color: #333;
      border-left: 2px solid #d0d4da;
      border-bottom: 1px solid #eef0f3;
      padding: 5px 10px;
    }
    /* Footer row */
    .total-label {
      font-size: .82rem; font-weight: 700;
      padding: 5px 16px; background: #e9ecef;
      border-right: 2px solid #e2e5ea;
      border-top: 2px solid #c0c8d4;
    }
    tfoot .total-cell {
      background: #e9ecef; border-top: 2px solid #c0c8d4;
    }
    .grand-total {
      background: #1e3a5f; color: #fff;
      text-align: center; font-weight: 700; font-size: .88rem;
      padding: 5px 10px;
      border-left: 2px solid rgba(255,255,255,.3);
      border-top: 2px solid #c0c8d4;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .empty-msg {
      background: #fff; border-radius: 8px; padding: 32px;
      text-align: center; color: #888; font-size: .9rem;
    }
    .meta { margin-top: 12px; font-size: .75rem; color: #999; }

    /* Print — landscape to accommodate many columns */
    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .9rem; margin-bottom: 1px; }
      .sub { font-size: .65rem; margin-bottom: 6px; }
      .mw  { overflow: visible; box-shadow: none; border-radius: 0; }
      table.mx { width: 100%; }
      .name-head   { font-size: .62rem; min-width: 0; padding: 6px 8px; }
      .name-cell   { font-size: .62rem; padding: 3px 8px; }
      .col-head    { padding: 6px 4px; height: 100px; min-width: 22px; }
      .ch-name     { font-size: .58rem; }
      .ch-date     { font-size: .52rem; margin-left: 3px; }
      .att-yes     { font-size: .62rem; }
      .total-head  { font-size: .62rem; padding: 6px 6px; }
      .total-cell  { font-size: .62rem; padding: 3px 6px; }
      .total-label { font-size: .62rem; padding: 3px 8px; }
      .grand-total { font-size: .65rem; padding: 3px 6px; }
      .meta { font-size: .62rem; margin-top: 4px; }
    }
    @page { size: landscape; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${subtitle}</p>

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>From</label>
      <input type="date" name="start" value="${esc(start)}">
    </div>
    <div class="fg">
      <label>To</label>
      <input type="date" name="end" value="${esc(end)}">
    </div>
    <button type="submit">Apply</button>
    <button type="button" class="btn-print no-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  ${classes.length === 0
    ? `<p class="empty-msg">No in-house training classes found for this date range.</p>`
    : `<div class="mw">
    <table class="mx">
      <thead>
        <tr>
          <th class="name-head sticky-col">Firefighter</th>
          ${classHeaders}
          <th class="total-head">Total</th>
        </tr>
      </thead>
      <tbody>${dataRows}</tbody>
      <tfoot>
        <tr>
          <td class="total-label sticky-col">Total</td>
          ${colTotalCells}
          <td class="grand-total">${grandTotal}</td>
        </tr>
      </tfoot>
    </table>
  </div>
  <p class="meta">${attendance.length} attendance record${attendance.length !== 1 ? 's' : ''} &mdash; generated ${new Date().toLocaleString()}</p>`
  }
</body>
</html>`;
}

function buildFilteredTableHtml(report, rows, { start, end, token }) {
  const deptTotal = rows.length > 0 ? parseInt(rows[0].dept_total) : 0;

  const tableRows = rows.map(row => {
    const count = parseInt(row.incident_count);
    const pct   = parseFloat(row.pct_of_dept);
    const hrs    = parseFloat(row.training_hours  || 0);
    const inhrs  = parseFloat(row.inhouse_hours   || 0);
    const inpct  = parseFloat(row.pct_of_inhouse  || 0);
    const fmt    = n => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
    return `<tr data-name="${esc(row.public_name)}" data-count="${count}" data-pct="${pct}" data-hours="${hrs}" data-inhours="${inhrs}" data-inpct="${inpct}">
      <td class="name-cell">${esc(row.public_name)}</td>
      <td class="num-cell">${count}</td>
      <td class="pct-cell">
        <div class="bar-wrap">
          <div class="bar" style="width:${Math.min(pct, 100)}%"></div>
          <span class="pct-lbl">${pct}%</span>
        </div>
      </td>
      <td class="num-cell">${fmt(hrs)}</td>
      <td class="num-cell">${fmt(inhrs)}</td>
      <td class="pct-cell">
        <div class="bar-wrap">
          <div class="bar" style="width:${Math.min(inpct, 100)}%"></div>
          <span class="pct-lbl">${inpct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  const tb = topbar(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 22px 18px;
    }
    h1   { font-size: 1.3rem; font-weight: 600; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 18px; }

    /* Filters */
    .filters {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px;
      background: #fff; border-radius: 8px; padding: 14px 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,.1); margin-bottom: 20px;
    }
    .fg { display: flex; flex-direction: column; gap: 4px; }
    .fg label { font-size: .75rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .04em; }
    .fg input {
      border: 1px solid #d1d5db; border-radius: 5px;
      padding: 6px 10px; font-size: .87rem; background: #fff; height: 34px;
    }
    button {
      height: 34px; padding: 0 18px; background: #1e3a5f; color: #fff;
      border: none; border-radius: 5px; font-size: .87rem;
      cursor: pointer; align-self: flex-end;
    }
    button:hover { background: #2a5080; }
    .btn-print { background: #4a5568; margin-left: auto; }
    .btn-print:hover { background: #2d3748; }

    /* Table */
    .tw { border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: .88rem; }
    thead th {
      background: #1e3a5f; color: #fff; padding: 10px 14px;
      text-align: left; font-size: .78rem;
      text-transform: uppercase; letter-spacing: .05em;
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    thead th:hover { background: #2a5080; }
    thead th.num-h { text-align: right; }
    .sub { font-size: .85rem; color: #555; margin: 4px 0 6px; }
    .tenure-note { font-size: .78rem; color: #777; margin-bottom: 18px; font-style: italic; }
    .sort-icon { opacity: .5; margin-left: 4px; font-size: .7rem; }
    th.asc  .sort-icon::after { content: '▲'; opacity: 1; }
    th.desc .sort-icon::after { content: '▼'; opacity: 1; }
    th:not(.asc):not(.desc) .sort-icon::after { content: '↕'; }
    tbody td { padding: 8px 14px; border-bottom: 1px solid #eef0f3; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f7f9fc; }
    .name-cell { font-weight: 500; }
    .num-cell  { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
    .pct-cell  { min-width: 180px; }
    .bar-wrap  { display: flex; align-items: center; gap: 8px; }
    .bar       { height: 10px; background: #1e3a5f; border-radius: 2px; min-width: 2px; }
    .pct-lbl   { font-size: .82rem; font-weight: 600; white-space: nowrap;
                 font-variant-numeric: tabular-nums; min-width: 44px; }
    .meta { margin-top: 12px; font-size: .75rem; color: #999; }

    /* Print */
    @media print {
      .no-print { display: none !important; }
      body { background: #fff; padding: 0; }
      h1   { font-size: .95rem; margin-bottom: 1px; }
      .sub { font-size: .68rem; margin-bottom: 6px; }
      .tw  { box-shadow: none; border-radius: 0; }
      table { font-size: .78rem; }
      thead th { padding: 5px 8px; font-size: .65rem; }
      tbody td { padding: 4px 8px; }
      .bar { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .meta { font-size: .65rem; margin-top: 6px; }
    }
    @page { size: portrait; margin: 0.7cm; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(report.title)}</h1>
  <p class="sub">${esc(start)} to ${esc(end)} &mdash; ${deptTotal} total department incident${deptTotal !== 1 ? 's' : ''}</p>
  <p class="tenure-note no-print">Percentages are tenure-adjusted &mdash; new members are compared against calls and training available after their department start date.</p>

  <form class="filters no-print" method="GET" action="">
    <input type="hidden" name="token" value="${esc(token)}">
    <div class="fg">
      <label>From</label>
      <input type="date" name="start" value="${esc(start)}">
    </div>
    <div class="fg">
      <label>To</label>
      <input type="date" name="end" value="${esc(end)}">
    </div>
    <button type="submit">Apply</button>
    <button type="button" class="btn-print no-print" onclick="window.print()">Print / Save PDF</button>
  </form>

  <div class="tw">
    <table id="ptbl">
      <thead>
        <tr>
          <th data-sort="name">Personnel <span class="sort-icon"></span></th>
          <th data-sort="count" class="num-h">Incidents <span class="sort-icon"></span></th>
          <th data-sort="pct">% of Avail. Calls <span class="sort-icon"></span></th>
          <th data-sort="hours" class="num-h">Training Hrs <span class="sort-icon"></span></th>
          <th data-sort="inhours" class="num-h">In-House Hrs <span class="sort-icon"></span></th>
          <th data-sort="inpct">% of Avail. In-House <span class="sort-icon"></span></th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  <p class="meta">${rows.length} personnel &mdash; generated ${new Date().toLocaleString()}</p>

  <script>
    document.querySelectorAll('#ptbl thead th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col    = th.dataset.sort;
        const tbody  = document.querySelector('#ptbl tbody');
        const sorted = [...tbody.querySelectorAll('tr')];
        const isAsc  = th.classList.contains('asc');

        document.querySelectorAll('#ptbl thead th').forEach(h => h.classList.remove('asc', 'desc'));
        th.classList.add(isAsc ? 'desc' : 'asc');

        sorted.sort((a, b) => {
          const av = a.dataset[col], bv = b.dataset[col];
          const an = parseFloat(av),  bn = parseFloat(bv);
          const cmp = isNaN(an) ? av.localeCompare(bv) : an - bn;
          return isAsc ? -cmp : cmp;
        });
        sorted.forEach(r => tbody.appendChild(r));
      });
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Home page builder
// ---------------------------------------------------------------------------
// Shared top nav bar rendered on every report page.
// Uses negative margins to break out of the body's padding and span full width.
function topbar(token, bodyPadding = '22px 18px') {
  const deptName  = process.env.DEPT_NAME || 'Fire Department';
  const [py, px]  = bodyPadding.split(' ');
  return {
    css: `
    .topbar {
      display: flex; align-items: center; gap: 12px;
      background: #1e3a5f; padding: 9px ${px};
      margin: -${py} -${px} ${py};
      font-size: .82rem;
    }
    .tb-back { color: #b8cfe0; text-decoration: none; white-space: nowrap; }
    .tb-back:hover { color: #fff; }
    .tb-sep  { color: rgba(255,255,255,.2); }
    .tb-dept { color: rgba(255,255,255,.6); font-size: .78rem; }
    @media print { .topbar { display: none; } }`,
    html: `<div class="topbar">
      <a class="tb-back" href="../?token=${esc(token)}">&#8592; All Reports</a>
      <span class="tb-sep">/</span>
      <span class="tb-dept">${esc(deptName)}</span>
    </div>`,
  };
}

function buildHomeHtml(token) {
  const deptName = process.env.DEPT_NAME || 'Fire Department';

  // Group reports by category
  const grouped = {};
  nav.forEach(cat => { grouped[cat.id] = []; });
  Object.entries(reports).forEach(([key, report]) => {
    const catId = (report.category || '').toLowerCase();
    if (grouped[catId]) grouped[catId].push({ key, ...report });
  });

  // Sidebar nav
  const sidebarNav = nav.map(cat => {
    const links = (grouped[cat.id] || []).map(r =>
      `<a class="nav-link" href="report/${esc(r.key)}?token=${esc(token)}">${esc(r.title)}</a>`
    ).join('');
    return `<div class="nav-section">
      <div class="nav-cat-label">${esc(cat.label)}</div>
      ${links}
    </div>`;
  }).join('');

  // Main content sections
  const typeLabel = { heatmap: 'Heatmap', 'filtered-table': 'Filtered Table', matrix: 'Matrix', 'member-activity': 'Drill-down', 'member-scorecard': 'Scorecard', projection: 'Projection', table: 'Table' };
  const sections = nav.map(cat => {
    const catReports = grouped[cat.id] || [];
    if (!catReports.length) return '';
    const cards = catReports.map(r => `
      <a class="report-card" href="report/${esc(r.key)}?token=${esc(token)}">
        <div class="card-top">
          <span class="card-title">${esc(r.title)}</span>
          <span class="card-badge">${r.badge || typeLabel[r.type] || 'Table'}</span>
        </div>
        <p class="card-desc">${esc(r.description || '')}</p>
        <span class="card-cta">View Report &rarr;</span>
      </a>`).join('');
    return `<section class="cat-section">
      <div class="cat-header">
        <h2 class="cat-title">${esc(cat.label)}</h2>
        <p class="cat-desc">${esc(cat.description)}</p>
      </div>
      <div class="cards">${cards}</div>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(deptName)} &mdash; Reports</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      display: flex; min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e;
    }

    /* ── Sidebar ── */
    .sidebar {
      width: 232px; flex-shrink: 0; background: #1e3a5f;
      display: flex; flex-direction: column;
      position: sticky; top: 0; height: 100vh; overflow-y: auto;
    }
    .sidebar-top {
      display: flex; align-items: center; gap: 11px;
      padding: 18px 14px; border-bottom: 1px solid rgba(255,255,255,.1);
    }
    .dept-badge {
      width: 36px; height: 36px; border-radius: 8px;
      background: #c0392b; color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: .95rem; flex-shrink: 0;
    }
    .dept-name { color: #fff; font-weight: 600; font-size: .88rem; line-height: 1.25; }
    .dept-sub  { color: #7a9bbf; font-size: .7rem; margin-top: 2px; }

    .sidebar-nav { padding: 10px 0 20px; }
    .nav-section  { margin-top: 6px; }
    .nav-cat-label {
      color: #7a9bbf; font-size: .63rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .1em;
      padding: 10px 14px 4px;
    }
    .nav-link {
      display: block; text-decoration: none;
      color: #b8cfe0; font-size: .83rem;
      padding: 7px 14px 7px 22px;
      border-left: 2px solid transparent;
    }
    .nav-link:hover {
      color: #fff; background: rgba(255,255,255,.07);
      border-left-color: #4a90d9;
    }

    /* ── Main ── */
    .main { flex: 1; padding: 36px 40px; overflow-y: auto; }

    .page-header { margin-bottom: 36px; }
    .page-header h1 { font-size: 1.55rem; font-weight: 600; }
    .page-header p  { color: #666; margin-top: 6px; font-size: .9rem; }

    .cat-section  { margin-bottom: 44px; }
    .cat-header   { margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #e2e5ea; }
    .cat-title    { font-size: 1.05rem; font-weight: 600; color: #1e3a5f; }
    .cat-desc     { font-size: .8rem; color: #777; margin-top: 3px; }

    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 14px; }

    .report-card {
      display: flex; flex-direction: column;
      background: #fff; border-radius: 8px; padding: 18px 20px;
      text-decoration: none; color: inherit;
      border: 1px solid #e4e7eb;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
      transition: box-shadow .15s, border-color .15s, transform .15s;
    }
    .report-card:hover {
      box-shadow: 0 4px 14px rgba(0,0,0,.11);
      border-color: #4a90d9; transform: translateY(-2px);
    }
    .card-top {
      display: flex; align-items: flex-start;
      justify-content: space-between; gap: 8px; margin-bottom: 8px;
    }
    .card-title { font-weight: 600; font-size: .93rem; }
    .card-badge {
      font-size: .62rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .04em; white-space: nowrap; flex-shrink: 0;
      color: #2a6db5; background: #eef4fb;
      padding: 2px 8px; border-radius: 10px;
    }
    .card-desc { font-size: .82rem; color: #666; line-height: 1.5; flex: 1; }
    .card-cta  { font-size: .78rem; color: #4a90d9; font-weight: 600; margin-top: 14px; }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="sidebar-top">
      <div class="dept-badge">FR</div>
      <div>
        <div class="dept-name">${esc(deptName)}</div>
        <div class="dept-sub">Reports Dashboard</div>
      </div>
    </div>
    <div class="sidebar-nav">${sidebarNav}</div>
  </nav>

  <main class="main">
    <header class="page-header">
      <h1>Reports Dashboard</h1>
      <p>Select a report from the menu or choose a category below.</p>
    </header>
    ${sections}
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTML builder — pure server-side, no frontend framework needed
// ---------------------------------------------------------------------------
function buildReportHtml(title, columns, rows, token = '') {
  const tb = topbar(token, '28px 20px');
  const headers = columns.map(c => `<th>${esc(c)}</th>`).join('');
  const body = rows.length > 0
    ? rows.map(row =>
        `<tr>${columns.map(c => `<td>${esc(String(row[c] ?? ''))}</td>`).join('')}</tr>`
      ).join('')
    : `<tr><td colspan="${columns.length}" class="empty">No data returned.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    ${tb.css}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5; color: #1a1a2e; padding: 28px 20px;
    }
    h1 { font-size: 1.35rem; font-weight: 600; margin-bottom: 18px; }
    .wrap { overflow-x: auto; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    thead th {
      background: #1e3a5f; color: #fff; text-align: left;
      padding: 11px 16px; font-size: .8rem;
      text-transform: uppercase; letter-spacing: .05em; white-space: nowrap;
    }
    tbody td { padding: 9px 16px; font-size: .88rem; border-bottom: 1px solid #eef0f3; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f7f9fc; }
    td.empty { text-align: center; color: #888; padding: 24px; }
    .meta { margin-top: 12px; font-size: .78rem; color: #888; }
  </style>
</head>
<body>
  ${tb.html}
  <h1>${esc(title)}</h1>
  <div class="wrap">
    <table>
      <thead><tr>${headers}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <p class="meta">${rows.length} row${rows.length !== 1 ? 's' : ''} &mdash; generated ${new Date().toLocaleString()}</p>
</body>
</html>`;
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Home:   http://localhost:${PORT}/?token=<YOUR_TOKEN>`);
  Object.keys(reports).forEach(name =>
    console.log(`Report: http://localhost:${PORT}/report/${name}?token=<YOUR_TOKEN>`)
  );
  console.log(`Report timezone: ${process.env.REPORT_TIMEZONE || 'UTC (REPORT_TIMEZONE not set in .env)'}`);
  if (allowedDomains.length > 0) {
    console.log(`Allowed domains: ${allowedDomains.join(', ')}`);
  } else {
    console.log('Domain restriction: disabled (set ALLOWED_DOMAINS in .env to enable)');
  }
});
