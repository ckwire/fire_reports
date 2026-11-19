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
│   └── *.js       - one file per report (response_time, spikes, annual, …)
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
| **Trends & Summaries** | | | |
| Annual Report | `annual_report` | Summary | 2019 (some figures 2024) |
| Spike Trends | `spike_trends` | Alerts | 2024 |
| Call Calendar | `call_calendar` | Calendar | 2019 |
| Incident Projection | `incident_projection` | Projection | 2019 |
| Incident Mix Trends | `incident_mix` | Trends | 2019 |
| Weather & Calls | `weather_calls` | Analysis | 2024 |
| **Incidents** | | | |
| Response by Day & Hour | `response_by_day_hour` | Heatmap | 2019 (member filter 2024) |
| Response Time Map | `response_time_map` | Map | 2024 |
| Response Time Performance | `response_time` | Performance | 2024 |
| Responders per Call | `responders_per_call` | Staffing | 2024 |
| Simultaneous Calls | `simultaneous_calls` | Staffing | 2024 |
| Hot Spots | `hot_spots` | Map | 2024 |
| Mutual Aid Balance | `mutual_aid` | Balance | 2024 |
| **Personnel** | | | |
| Engagement Early Warning | `engagement_watch` | Alerts | 2024 |
| Depth of Bench | `depth_of_bench` | Staffing | 2024 |
| Officer & Driver Coverage | `officer_driver_coverage` | Staffing | 2024 |
| Who Responds Together | `crew_pairs` | People | 2024 |
| Member Hours Contributed | `member_hours` | Payroll | 2024 |
| Recognition & Milestones | `recognition` | People | 2024 |
| Training vs Call Mix | `training_vs_mix` | Alignment | 2024 |
| Training Matrix (v1) | `training_matrix` | Attendance matrix | 2025 |
| Training Matrix (v2) | `training_matrix_v2` | Matrix | 2025 |
| Training Coverage by Topic | `training_coverage` | Compliance | 2024 |
| Probationary Progress | `probationary_metrics` | Progress | 2024 |
| Response by Personnel | `response_by_personnel` | Filtered table | 2024 |
| Member Activity | `member_activity` | Drill-down | 2024 |
| Member Scorecard | `member_scorecard` | Scorecard | 2024 |

### Why some reports start in 2024

Incidents imported from the previous system (2019–2023) lack data that newer reports depend on: **personnel on each call, map coordinates, station and unit, neighbouring-department names, and training topics**, and their **arrival times are measured differently** (median about 7 minutes versus about 12 from 2024 on, so the two can't be compared). Reports that need those fields set `minDate` in `reports.js`; the date pickers stop at that date, the server enforces it, and the page says why. Reports that only need the incident count and type (Incident Mix, Projection, Response by Day & Hour) use all years.

### Available Filters

| Parameter | Description |
|---|---|
| `start` | Start date `YYYY-MM-DD`. Defaults vary by report: usually Jan 1 of the current year or a few years back. Spike Trends defaults to the last 90 days and Training Matrix (v2) to the last 12 months. Reports with a data floor never go earlier than it. |
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

### Annual Report

One printable page per year (`year`, default the last complete year; the current year shows year-to-date against the same dates last year): calls and change vs the prior year, calls by month and type, response times, members per call, overlapping calls, mutual aid, members joined/left, training and member hours, and top responders. Figures needing 2024+ data show "n/a" for earlier years.

### Spike Trends

Is a recent stretch unusual? The date range is the **focus window** (default: last 90 days); it is compared with the `baseline` months before it (default 12). For every call type, specific call, road, address, time of day, day of week and member, the report computes how many calls the baseline rate predicts for a window that long and scores the difference (variance-stabilised Poisson score: ±2 notable, ±3 strong). Members are compared on their *share* of department calls, so a busy month for everyone isn't a personal spike. Specific call names are compared only within the same coding scheme (NFIRS vs NERIS). Seasonality is not removed.

### Call Calendar

One square per day for each year in range (all years available), with holidays outlined; busiest days with what came in, average calls by weekday, holiday vs normal days, and calls per day by month across years.

### Weather & Calls

Call mix by temperature and wind band, the specific calls that are over-represented in each band, surge days (`surge` calls or more) with their weather, and calls by weather condition code. Weather is recorded per incident (2024+), so this shows conditions *when calls happened*; it can't measure extra calls per cold day. Wind is stored in m/s and shown in mph. Condition codes have no names in the database: add them to `weatherCodeLabels` in `reports.js`.

### Response by Day & Hour

A day-of-week × hour-of-day heatmap of incident counts for a date range, by local time (`REPORT_TIMEZONE`), with row and column totals. Choose a member (`personnel_id`) to see only the calls they responded to; each cell then shows their count against the department total for that slot. The department view works for all years. The member filter needs personnel records, which begin in 2024.

### Response Time Map

The district divided into squares (`cell` ½, 1 or 2 km) and coloured by 90th-percentile (or median) time to first arrival, relative to the district (green = fastest areas, red = slowest), with the slowest and fastest areas listed by their main roads. `min` sets the fewest timed calls a square needs. Uses Leaflet + OpenStreetMap like Hot Spots.

### Engagement Early Warning

Each active member's share of department calls over the last `days` (30/60/90/180) compared with their own norm over the `baseline` months before. A binomial z-score separates real drops from normal variation. **Alert** = signal −3 or lower, under 40% of their usual rate, or no calls and no training for 60+ days; **Watch** = signal −2 or under 60% of usual. Shows 12-month sparklines, in-house training share, training hours per 30 days, and days since last call / class. Members are compared only with themselves.

### Depth of Bench

How many *different* members responded in each day × 4-hour slot, how concentrated the work is (how many members cover half of all responses; the top `top` active members' share), and what share of calls would still have met `min` responders without those top members — overall and by time of day.

### Officer & Driver Coverage

Share of calls with an officer and with a qualified driver on them, by day × time, quarter and call type; who signs as officer in charge; and calls with neither. Officer and driver ranks are set in `RANKS` in `reports.js` (`officersCountAsDrivers` too). Ranks are **current** ranks — rank history in the system only begins in mid-2026.

### Who Responds Together

Calls-together matrix for the 14 most active members, the most frequent pairs, the strongest partnerships by *lift* (how much more often a pair shares calls than chance predicts; `min` = fewest shared calls), members most often in small crews, and natural mentor matches for members in their first 12 months.

### Member Hours Contributed

Hours from the payroll time records (incidents, training, activities & events) by member and month, with **estimated pay** = hours × the member's pay rate in effect on that date (`v_personnel_pay_rate`, latest rate carried forward past the last period) plus stipends. It does not re-apply payroll rules, so it won't match a payroll run to the dollar.

### Recognition & Milestones

Top responders and trainers this month, quarter and year; service anniversaries in the next `ahead` days (milestone years highlighted); call-count milestones coming up (at each member's recent pace) and recently reached; most improved this quarter; longest serving. Call counts are since 2024.

### Training vs Call Mix

Share of emergency calls by type compared with share of call-specific training (member-hours) for the same type, with the gap, a quarterly trend for each, and the general training not tied to a call type. Call types are paired with training by the `alignment` patterns in `reports.js`.

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

### Training Matrix (v1)

The original yes/no grid: active members down the side and every in-house class (type 47174) in the date range across the top (default: Jan 1 to today). An **X** marks attendance, with totals per member and per class. It's simple and prints landscape. In-house classes begin in 2025, so earlier ranges are empty. See v2 for rates, make-ups and status.

### Training Matrix (v2)

In-house training attendance (type 47174, which began January 2025), one column per **training night**: every in-house class held on the same date is grouped, so two classes in one night count once and attending either counts. Defaults to the last 12 months, with quick links for this year, last year and all.

- **Expected, not just present:** a member is expected only at nights after their start date (and before they left), and only at classes meant for their rank. Officer Development is officers-only, so others show *n/a* there and earn extra credit if they attend. Rates are attended / expected.
- **Make-ups:** a class whose name matches "make up" credits the member's most recent missed night within 30 days (both cells show **M**).
- **Extras:** weekend classes (EMS Blitz, live burns, certifications) add credit and hours but are never counted as a miss.
- **Per member:** came / expected, rate, last 6 nights with a ▲/▼ when it differs from earlier by 15+ points, extras, hours, last attended, and a status band (Engaged 75%+, Regular, Occasional, Rare).
- **Department:** attendance per night with a 4-night average trend, members by band, and a follow-up list of active members who missed 3+ nights in a row.
- **Grid layout:**
  - Rows are grouped by status by default (`group=none` gives one list), each with a group average.
  - A coloured stripe on each name shows that member's status, and lines separate the months.
  - Each rate has a small bar.
  - Hovering a square highlights its member and night.
- Sort by name, rate, last 6 or hours (within each group), and optionally include former members (shown in their own group).

All of these rules (`audiences`, `makeUp`, `weekendIsExtra`, `extras`, `followUpMisses`, `bands`) live in `rules` under `training_matrix_v2` in `reports.js`. Hours are each class's scheduled length because the per-member hours field is often blank or 0. It prints landscape on 2 pages (matrix on page 1). Training Matrix (v1) is unchanged.

### Training Coverage by Topic

Hours by category and topic, who has been reached, gaps by focus area, a member × focus-area matrix, and a record-completeness check (classes missing a duration, category, topic or attendees). **Focus areas and any ISO / policy hour targets are configured in `reports.js` (`focusAreas`)**: each has a label, match patterns (regex against the class category and topic names) and `annualHours`. Targets ship blank, so the report shows coverage only until you set them; targets are prorated to the date range and to a new member's start date. Edit that list as your training records and audit requirements evolve.

### Probationary Progress

How new members ramp up. "Probationary" is defined as the first N months after the start date (`months`, default 12) because the personnel rank field is not used consistently. For each member who started in 2024 or later (including those who have left): response % and in-house training % over their window, compared with established active members over the **same calendar dates**, plus month-by-month ramp charts. Members who left are shown for comparison.

### Response by Personnel

One row per active member for a date range:
- **Incidents:** calls responded to, and their share of the department calls since the member started (tenure-adjusted).
- **Training:** total hours and in-house hours, with in-house hours as a share of all in-house class hours offered since the member started.

Personnel are recorded on incidents only from 2024, so earlier ranges show no responses.

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
