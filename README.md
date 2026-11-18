# Fire Reports

A lightweight Node.js + Express web app that serves protected, embeddable PostgreSQL report pages. Reports are secured by a URL token, optionally restricted to specific embedding domains, and designed to print cleanly as PDFs.

## Project Structure

```
fire_reports/
├── server.js      - Express server: routing, middleware, HTML builders
├── reports.js     - Report registry: add new reports here
├── nav.js         - Home page navigation categories
├── .env           - Your secrets (gitignored)
├── .env.example   - Config template
└── package.json
```

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your database credentials and token

# 3. Generate a token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Run
npm start          # production
npm run dev        # development (auto-restarts)
```

## Configuration (.env)

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (default: 3000) |
| `REPORT_TOKEN` | Secret token required in every report URL |
| `REPORT_TIMEZONE` | Timezone for report display, e.g. `America/Detroit` (default: UTC) |
| `DEPT_NAME` | Department name shown on the home page and report headers |
| `ALLOWED_DOMAINS` | Comma-separated domains allowed to embed reports (blank = allow all) |
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default: 5432) |
| `DB_NAME` | Database name — also used as `{{DB_NAME}}` in SQL queries |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `DB_SSL` | Set `true` for SSL connections (e.g. cloud-hosted databases) |

## Report URLs

```
https://your-server.com/report/<name>?token=<REPORT_TOKEN>
```

| Report | Slug | Type |
|---|---|---|
| Probationary Metrics | `probationary_metrics` | Plain table |
| Response by Day & Hour | `response_by_day_hour` | Heatmap |
| Training Matrix | `training_matrix` | Attendance matrix |
| Response by Personnel | `response_by_personnel` | Filtered table |
| Member Activity | `member_activity` | Drill-down |

### Available Filters

| Parameter | Description |
|---|---|
| `start` | Start date `YYYY-MM-DD` (default: Jan 1 of current year; Member Activity defaults to Jan 1 two years ago) |
| `end` | End date `YYYY-MM-DD` (default: today) |
| `personnel_id` | Heatmap: filter to one person, blank = department total. Member Activity: the member to report on (required) |

### Member Activity

Shows one member's incidents and training for a date range. Each category is totaled by year, then by calendar quarter, and each quarter expands to list the individual calls or classes.

- Every figure reads `member/department` with the member's percentage share. Incidents compare against all department incidents; training percentage is hours attended ÷ department class hours.
- Percentages are tenure-adjusted: department totals count only from the member's start date (or the report start date, whichever is later).
- Quarters and incident times use `REPORT_TIMEZONE`.
- Printing or saving to PDF collapses the report to the year level.
- Both active and inactive members appear in the dropdown.

## Adding a New Report

Edit `reports.js`. The object key becomes the URL slug.

**Plain table** (no filters):
```js
my_report: {
  title: 'My Report',
  query: `SELECT col1, col2 FROM {{DB_NAME}}.app.my_table`,
},
```

**Date-filtered table:**
```js
my_report: {
  title: 'My Report',
  type: 'filtered-table',
  dataQuery: `
    SELECT name, COUNT(*) AS total
    FROM {{DB_NAME}}.app.my_table
    WHERE created_at >= $1::date
      AND created_at < ($2::date + interval '1 day')
    GROUP BY name ORDER BY total DESC
  `,
},
```

> `{{DB_NAME}}` in any SQL string is replaced at runtime with `DB_NAME` from `.env`.

## Embedding

```html
<iframe
  src="https://your-server.com/report/response_by_day_hour?token=TOKEN"
  width="100%" height="700" frameborder="0">
</iframe>
```

Set `ALLOWED_DOMAINS` in `.env` to lock embedding to specific sites. The server enforces this via `Origin`/`Referer` header checks and a `Content-Security-Policy: frame-ancestors` header.

## Security

- Token validated with `crypto.timingSafeEqual` to prevent timing attacks
- `.env` is gitignored — never committed
- All rendered values are HTML-escaped (XSS protection)
- All user inputs use parameterized queries (`$1`, `$2`) — no SQL injection risk
- Use HTTPS in production to protect the token in transit
