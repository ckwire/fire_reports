require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const reports = require('./reports');

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
app.get('/report/:name', securityHeaders, validateToken, validateDomain, async (req, res) => {
  const report = reports[req.params.name];

  if (!report) {
    return res.status(404).send(`Report "${req.params.name}" not found.`);
  }

  if (report.type === 'heatmap') {
    return handleHeatmap(req, res, report);
  }

  if (report.type === 'filtered-table') {
    return handleFilteredTable(req, res, report);
  }

  try {
    const result  = await pool.query(resolveQuery(report.query));
    const rows    = result.rows;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    res.send(buildReportHtml(report.title, columns, rows));
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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

function buildFilteredTableHtml(report, rows, { start, end, token }) {
  const deptTotal = rows.length > 0 ? parseInt(rows[0].dept_total) : 0;

  const tableRows = rows.map(row => {
    const count = parseInt(row.incident_count);
    const pct   = parseFloat(row.pct_of_dept);
    return `<tr data-name="${esc(row.public_name)}" data-count="${count}" data-pct="${pct}">
      <td class="name-cell">${esc(row.public_name)}</td>
      <td class="num-cell">${count}</td>
      <td class="pct-cell">
        <div class="bar-wrap">
          <div class="bar" style="width:${Math.min(pct, 100)}%"></div>
          <span class="pct-lbl">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(report.title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
  <h1>${esc(report.title)}</h1>
  <p class="sub">${esc(start)} to ${esc(end)} &mdash; ${deptTotal} total department incident${deptTotal !== 1 ? 's' : ''}</p>

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
          <th data-sort="pct">% of Dept Calls <span class="sort-icon"></span></th>
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
// HTML builder — pure server-side, no frontend framework needed
// ---------------------------------------------------------------------------
function buildReportHtml(title, columns, rows) {
  const headers = columns
    .map(c => `<th>${esc(c)}</th>`)
    .join('');

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
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      color: #1a1a2e;
      padding: 28px 20px;
    }
    h1 { font-size: 1.35rem; font-weight: 600; margin-bottom: 18px; }
    .wrap { overflow-x: auto; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    thead th {
      background: #1e3a5f;
      color: #fff;
      text-align: left;
      padding: 11px 16px;
      font-size: .8rem;
      text-transform: uppercase;
      letter-spacing: .05em;
      white-space: nowrap;
    }
    tbody td {
      padding: 9px 16px;
      font-size: .88rem;
      border-bottom: 1px solid #eef0f3;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #f7f9fc; }
    td.empty { text-align: center; color: #888; padding: 24px; }
    .meta { margin-top: 12px; font-size: .78rem; color: #888; }
  </style>
</head>
<body>
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
