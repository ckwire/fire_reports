# Fire Reports

A lightweight Node.js + Express web app that serves protected, embeddable PostgreSQL report pages. Reports are secured by a URL token, optionally restricted to specific embedding domains, and designed to print cleanly as PDFs.

## Project Structure

```
fire_reports/
├── server.js      - Express server: routing, middleware, HTML builders
├── reports.js     - Report registry: add new reports here
├── nav.js         - Home page navigation categories
├── views/         - One module per newer report (see "Adding a View Report")
│   ├── kit.js     - Shared page shell, styles, charts, stats, incident categories
│   └── *.js       - response_time, responders, simultaneous, hotspots, mix,
│                    mutual_aid, training_coverage, probationary
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

| Report | Slug | Type | Data from |
|---|---|---|---|
| Response by Day & Hour | `response_by_day_hour` | Heatmap | 2019 |
| Incident Projection | `incident_projection` | Projection | 2019 |
| Incident Mix Trends | `incident_mix` | Trends | 2019 |
| Response Time Performance | `response_time` | Performance | 2024 |
| Responders per Call | `responders_per_call` | Staffing | 2024 |
| Simultaneous Calls | `simultaneous_calls` | Staffing | 2024 |
| Hot Spots | `hot_spots` | Map | 2024 |
| Mutual Aid Balance | `mutual_aid` | Balance | 2024 |
| Training Matrix | `training_matrix` | Attendance matrix | 2018 |
| Training Coverage by Topic | `training_coverage` | Compliance | 2024 |
| Probationary Progress | `probationary_metrics` | Progress | 2024 |
| Response by Personnel | `response_by_personnel` | Filtered table | 2019 |
| Member Activity | `member_activity` | Drill-down | 2024 |
| Member Scorecard | `member_scorecard` | Scorecard | 2024 |

### Why some reports start in 2024

Incidents imported from the previous system (2019–2023) lack data that newer reports depend on: **personnel on each call, map coordinates, station and unit, neighbouring-department names, and training topics**, and their **arrival times are measured differently** (median about 7 minutes versus about 12 from 2024 on, so the two can't be compared). Reports that need those fields set `minDate` in `reports.js`; the date pickers stop at that date, the server enforces it, and the page says why. Reports that only need the incident count and type (Incident Mix, Projection, Response by Day & Hour) use all years.

### Available Filters

| Parameter | Description |
|---|---|
| `start` | Start date `YYYY-MM-DD` (default: Jan 1 of current year; Member Activity defaults to Jan 1 two years ago) |
| `end` | End date `YYYY-MM-DD` (default: today) |
| `personnel_id` | Heatmap: filter to one person, blank = department total. Member Activity / Member Scorecard: the member to report on (required) |

Incident Projection uses its own filters:

| Parameter | Description |
|---|---|
| `as_of` | Project from this date `YYYY-MM-DD` (default: yesterday, the last complete day). A date in a past year back-tests the projection against that year's actual total. |
| `years` | Prior years to learn from: `3`, `5` (default), `7`, or `all` |

### Incident Projection

Estimates the year-end incident total from where the year stands now and how past years finished.

- **Headline (seasonal share):** for each past year, the share of its annual total that had happened by the as-of date. Year-to-date ÷ the average share = projection. Using each year's share individually gives the range. This accounts for seasonality and for the current year running hot or cold.
- **Cross-checks:** straight run rate, YTD + average remainder, last year's pace, and a long-term trend line through past totals. When these agree the estimate is solid; when they spread, lean on the range.
- **Chart:** cumulative incidents by day of year for each year, with the projection cone out to Dec 31.
- **Tables:** past years at the same date (share done, what each implies) and incidents by month.
- **Back-testing:** choose an as-of date in a finished year to compare each method with the actual result. (As of Nov 16, 2025 the headline projected 628; the actual was 624.)
- Counts use local dates (`REPORT_TIMEZONE`). Prints on one page.

### Response Time Performance

Alarm to first-unit arrival: median, **90th percentile** (the standard fractile measure) and the share of calls within a target you set (`target`, minutes; default 10). Shows a quarterly trend, a distribution chart, breakdowns by call type, day/night, weekday/weekend and first-arriving unit type (apparatus vs personal vehicle), and the 15 slowest calls to check for data errors. Station standby / cover assignments are excluded unless `standby=1`. Filter by `category`.

### Responders per Call

Distinct members recorded on each incident. Shows average and median responders, the share of calls meeting a minimum you set (`min`, default 4), a day × hour heatmap of average responders, trends by quarter, a distribution, and the calls that fell below the minimum. Calls cancelled en route are excluded unless `cancelled=1`. This is who responded, not who was available.

### Simultaneous Calls

How often a call arrives while another is still active (from alarm until the last unit clears; capped at 8 hours). Shows the share of overlapping calls by quarter and by hour, the biggest overlap episodes, and whether second calls get slower first-arrival times. Calls with no clear time or duration are skipped and counted.

### Hot Spots

Where calls repeat. A map (Leaflet + OpenStreetMap, loaded from public CDNs in the viewer's browser, so the map needs internet access; the tables work without it) with one circle per address, plus ranked addresses and roads. Filter by `category` (e.g. Medical for lift-assist patterns) and `min` (calls needed to appear in the address table).

### Incident Mix Trends

Call types by year or quarter (`by=quarter`): a stacked chart, share over time, counts by category, a "what changed" table that attributes growth to categories, and the most common specific call types. Incidents are bucketed into common categories (Medical, Rescue & crashes, Fire, Hazardous, Service & weather, Cancelled / good intent, False alarms, Other) from NFIRS codes (through 2025) and NERIS groups (2025 on); see `categoryOf` in `views/kit.js`. Crashes are matched by name because NERIS files them under Medical or Hazardous. Watch for a step change at the 2025–2026 switch.

### Mutual Aid Balance

Aid given vs received, by neighbouring department, over time, with the net balance. Direction comes from the incident fields: a department named on the call (`aid_department_name`) is aid **given**; departments in `aid_received_names` are aid **received**. A few calls have both and count both ways. Mutual vs automatic aid is only recorded through 2025.

### Training Coverage by Topic

Hours by category and topic, who has been reached, gaps by focus area, a member × focus-area matrix, and a record-completeness check (classes missing a duration, category, topic or attendees). **Focus areas and any ISO / policy hour targets are configured in `reports.js` (`focusAreas`)**: each has a label, match patterns (regex against the class category and topic names) and `annualHours`. Targets ship blank, so the report shows coverage only until you set them; targets are prorated to the date range and to a new member's start date. Edit that list as your training records and audit requirements evolve.

### Probationary Progress

How new members ramp up. "Probationary" is defined as the first N months after the start date (`months`, default 12) because the personnel rank field is not used consistently. For each member who started in 2024 or later (including those who have left): response % and in-house training % over their window, compared with established active members over the **same calendar dates**, plus month-by-month ramp charts. Members who left are shown for comparison.

### Member Activity

Shows one member's incidents and training for a date range. Each category is totaled by year, then by calendar quarter, and each quarter expands to list the individual calls or classes.

- Every figure reads `member/department` with the member's percentage share. Incidents compare against all department incidents; training percentage is the member's in-house hours ÷ all department in-house class hours. Only in-house classes (type 47174) count toward the percentage, since specialty courses not everyone takes would skew it; the member's other training is still listed and totaled.
- Percentages are tenure-adjusted: department totals count only from the member's start date (or the report start date, whichever is later).
- Quarters and incident times use `REPORT_TIMEZONE`.
- Default view: Incidents show yearly totals, collapsed (expand a year for its quarters, a quarter for its calls). Training shows each year with its quarters beneath it; classes stay collapsed until you expand a quarter.
- Printing or saving to PDF uses that default layout, which keeps the report to roughly one page. Use Expand all / Collapse all to change the on-screen view.
- Both active and inactive members appear in the dropdown.

### Member Scorecard

Answers "how is this member doing?" rather than listing every call. A raw percentage is hard to judge on its own, so everything is shown next to the peer group:

- **Headline tiles** for incident response and in-house training: the member's percentage, the raw fraction, the difference from the peer median, and the member's rank among active members.
- **Quarterly trend charts** for both metrics, member vs. peer median.
- **Quarter detail table** with the numbers behind the charts.
- Fits on one printed page.

How it is calculated:
- Incident response % = incidents the member responded to ÷ all department incidents. Training % = in-house hours attended ÷ all in-house class hours (type 47174).
- Both are tenure-adjusted: a member is measured only against activity on or after their start date.
- The peer median is the middle value across the other active members, each measured the same way. Inactive members can still be selected; they are compared against active members.
- Use Member Activity when you need the individual calls and classes behind the numbers.

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

> `{{DB_NAME}}` in any SQL string is replaced at runtime with `DB_NAME` from `.env`; `{{TIMEZONE}}` with `REPORT_TIMEZONE`.

## Adding a View Report

For anything beyond a table, write a module in `views/` and register it:

```js
// reports.js
my_view: {
  title: 'My View', category: 'incidents', description: '…',
  type: 'view', view: 'my_view', badge: 'Analysis',
  minDate: '2024-01-01',          // optional data floor
  minDateNote: 'Why it starts then.',
  dataQuery: `SELECT … WHERE … BETWEEN $1::date AND $2::date`,
},
```

```js
// views/my_view.js
const createKit = require('./kit');
async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  try {
    const range = K.resolveRange(req, report);              // applies minDate
    const rows  = await K.query(report, 'dataQuery', [range.start, range.end]);
    res.send(K.page({ report, token: req.query.token || '', range,
      subtitle: '…', body: K.tile({ title: 'Rows', value: rows.length }) }));
  } catch (err) { K.fail(res, report, err); }
}
module.exports = { handle };
```

`views/kit.js` provides the page shell (filters, print styles, floor notice), tiles, cards, tables, line / stacked-bar SVG charts, bar lists, percentile and median helpers, and `categoryOf` for bucketing incidents. Query timestamps as local text (`to_char(… AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD HH24:MI:SS')`) and cast `bigint` columns (`::int`) so they arrive as numbers.

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
