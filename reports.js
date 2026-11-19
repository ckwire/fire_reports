// ---------------------------------------------------------------------------
// Report registry — add a new entry here to create a new report page.
// Each key becomes the URL slug: /report/<key>?token=...
//
// type: 'table'          (default) — runs `query`, plain data table
// type: 'heatmap'                  — day-of-week × hour heatmap with filters
// type: 'filtered-table'           — date-filtered table; `dataQuery` receives
//                                    $1=start, $2=end
//
// type: 'view'                     — report built by a module in views/ (set
//                                    `view` to the file name); `badge` is the
//                                    label on its home page card
//
// minDate / minDateNote (views only): earliest date the report allows. The
//           date pickers and the server both enforce it. Used where older
//           (imported 2019–2023) incidents lack the fields a report needs.
//
// category: matches an `id` in nav.js — controls which sidebar section the
//           report appears under on the home page
// description: short sentence shown on the home page report card
// ---------------------------------------------------------------------------

// Shared SQL fragments for the views/ reports. {{TIMEZONE}} / {{DB_NAME}} are
// substituted by the server. Dates are compared as LOCAL dates.
const LOCAL_TS   = `to_char((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD HH24:MI:SS')`;
const LOCAL_DATE = `((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}')::date`;
// Fields the server uses to bucket an incident into a category (views/kit.js).
// NFIRS code through 2025, NERIS group/subgroup from 2025 onward.
const CAT_FIELDS = `
        ir.incident_type,
        ir.neris_primary_incident_group_name    AS neris_group,
        ir.neris_primary_incident_subgroup_name AS neris_subgroup,
        COALESCE(NULLIF(ir.actual_incident_type_description, ''), ir.neris_primary_incident_type_name) AS type_desc`;

// Imported 2019–2023 incidents lack personnel records, coordinates, station /
// unit, aid-department names and training topics, and their arrival times are
// measured differently, so reports that depend on those start here.
const RELIABLE_FROM = '2024-01-01';
const RELIABLE_NOTE = 'Incidents before 2024 were imported without personnel, location, unit and aid details, and their arrival times are measured differently, so this report starts in 2024.';

module.exports = {

  probationary_metrics: {
    title: 'Probationary Progress',
    category: 'personnel',
    description: 'How new members ramp up: response and training month by month since their start date, against established members.',
    type: 'view', view: 'probationary', badge: 'Progress',
    minDate: RELIABLE_FROM,
    minDateNote: 'Personnel response records begin in 2024; members who started earlier are not included.',

    // Members who started on/after the data floor (earlier starters have no
    // personnel records for their first months). user_id keys training
    // attendance; personnel_id keys incident response.
    rosterQuery: `
      SELECT id AS user_id, personnel_id, personnel_full_name, personnel_is_active, personnel_status_code,
             to_char(personnel_start_date, 'YYYY-MM-DD')          AS personnel_start,
             to_char(personnel_end_of_service_date, 'YYYY-MM-DD') AS personnel_end
      FROM {{DB_NAME}}.app.v_personnel
      WHERE personnel_start_date IS NOT NULL
        AND personnel_start_date < '2030-01-01'
      ORDER BY personnel_start_date, personnel_full_name
    `,

    // $1 = first date  $2 = last date — every department incident (denominator)
    incidentQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,

    responseQuery: `
      SELECT DISTINCT irp.personnel_id, irp.incident_report_id
      FROM {{DB_NAME}}.app.v_incident_report_personnel irp
      INNER JOIN {{DB_NAME}}.app.f_incident_report ir ON ir.id = irp.incident_report_id
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,

    // All classes (in-house flagged) so total and in-house hours can be shown.
    classQuery: `
      SELECT tc.id, to_char(tc.start_date, 'YYYY-MM-DD') AS class_date,
             COALESCE(tc.duration_hours, 0) AS duration_hours,
             (47174 = ANY(tc.training_type_ids)) AS is_inhouse
      FROM {{DB_NAME}}.app.v_training_class tc
      WHERE tc.start_date BETWEEN $1::date AND $2::date
    `,

    attendanceQuery: `
      SELECT DISTINCT user_id, training_class_id
      FROM {{DB_NAME}}.app.v_training_class_attendee
      WHERE training_class_id = ANY($1::integer[])
    `,
  },

  response_time: {
    title: 'Response Time Performance',
    category: 'incidents',
    description: 'Time from alarm to first arrival: median, 90th percentile, share within your target, quarterly trend, and the slowest calls.',
    type: 'view', view: 'response_time', badge: 'Performance',
    minDate: RELIABLE_FROM, minDateNote: RELIABLE_NOTE,

    // $1 = start  $2 = end (local dates)
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local,
             ir.time_to_first_arrival_in_seconds::int AS tfa,
             ir.first_arriving_unit_name         AS unit,
             ir.address,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,
  },

  responders_per_call: {
    title: 'Responders per Call',
    category: 'incidents',
    description: 'How many members respond to each call — by day and hour, over time, and which calls fell below your minimum.',
    type: 'view', view: 'responders', badge: 'Staffing',
    minDate: RELIABLE_FROM, minDateNote: RELIABLE_NOTE,

    // $1 = start  $2 = end
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local, ir.address,
             COALESCE(r.responders, 0)::int AS responders,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      LEFT JOIN (
        SELECT incident_report_id, COUNT(DISTINCT personnel_id) AS responders
        FROM {{DB_NAME}}.app.v_incident_report_personnel
        GROUP BY incident_report_id
      ) r ON r.incident_report_id = ir.id
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,
  },

  simultaneous_calls: {
    title: 'Simultaneous Calls',
    category: 'incidents',
    description: 'How often a new call comes in while another is still active — by quarter and hour, peak overlaps, and whether second calls get slower responses.',
    type: 'view', view: 'simultaneous', badge: 'Staffing',
    minDate: RELIABLE_FROM, minDateNote: RELIABLE_NOTE,

    // $1 = start  $2 = end. Pulled a day either side so calls that overlap
    // the edges of the range are still seen; the server trims the results.
    // t0 / t1 are epoch seconds (alarm and last unit cleared).
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local, ir.address,
             EXTRACT(EPOCH FROM ir.alarm_at)::float8 AS t0,
             EXTRACT(EPOCH FROM COALESCE(
               ir.last_unit_cleared_datetime,
               ir.alarm_at + (ir.total_call_duration_in_seconds * interval '1 second')
             ))::float8 AS t1,
             ir.time_to_first_arrival_in_seconds::int AS tfa,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN ($1::date - 1) AND ($2::date + 1)
    `,
  },

  hot_spots: {
    title: 'Hot Spots',
    category: 'incidents',
    description: 'Map and ranking of the addresses and roads that generate the most calls — useful for pre-plans, lift-assist patterns, and community risk reduction.',
    type: 'view', view: 'hotspots', badge: 'Map',
    minDate: RELIABLE_FROM, minDateNote: RELIABLE_NOTE,

    // $1 = start  $2 = end. address is upper-cased with spacing collapsed;
    // street drops a leading house number so "8900 GULL RD" and "GULL RD" group.
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local,
             NULLIF(upper(regexp_replace(trim(ir.address), '\\s+', ' ', 'g')), '') AS address,
             NULLIF(regexp_replace(upper(regexp_replace(trim(ir.address), '\\s+', ' ', 'g')), '^[0-9]+\\s+', ''), '') AS street,
             ir.latitude, ir.longitude,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,
  },

  incident_mix: {
    title: 'Incident Mix Trends',
    category: 'incidents',
    description: 'EMS, fire, service, false alarms and other call types by year or quarter — which kinds of calls are driving the growth in volume.',
    type: 'view', view: 'mix', badge: 'Trends',
    // No floor: NFIRS incident types are consistent back to 2019.

    // $1 = start  $2 = end
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
    `,
  },

  mutual_aid: {
    title: 'Mutual Aid Balance',
    category: 'incidents',
    description: 'Aid given to and received from neighboring departments, by department, over time, with the net balance.',
    type: 'view', view: 'mutual_aid', badge: 'Balance',
    minDate: RELIABLE_FROM,
    minDateNote: 'Neighboring-department names were not recorded on incidents before 2024.',

    // $1 = start  $2 = end.
    // Given    = aid_department_name set (the department we were aiding);
    // Received = aid_received_names (departments that came to our calls).
    // aid_type 3 = mutual aid given, 4 = automatic aid given (blank from 2026).
    dataQuery: `
      SELECT ir.id, ${LOCAL_TS} AS alarm_local, ir.address,
             ir.aid_type,
             NULLIF(ir.aid_department_name, '') AS aid_department_name,
             NULLIF(ir.aid_received_names, '')  AS aid_received_names,
             ${CAT_FIELDS}
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ${LOCAL_DATE} BETWEEN $1::date AND $2::date
        AND (NULLIF(ir.aid_department_name, '') IS NOT NULL
          OR NULLIF(ir.aid_received_names, '')  IS NOT NULL)
    `,
  },

  training_coverage: {
    title: 'Training Coverage by Topic',
    category: 'personnel',
    description: 'Hours by training topic, who has been reached, and a member-by-focus-area matrix that shows gaps — built to grow into ISO and compliance tracking.',
    type: 'view', view: 'training_coverage', badge: 'Compliance',
    minDate: RELIABLE_FROM,
    minDateNote: 'Training categories and topics were not recorded before 2024.',

    // Focus areas are the columns of the member matrix. Each matches a class
    // when ANY listed pattern (case-insensitive regex) matches that class's
    // category name or one of its topics ("CATEGORY - Topic").
    //   annualHours: hours a member should log per year in this area, or null
    //   to simply flag "none". The report prorates it to the date range.
    //
    // *** The targets are PLACEHOLDERS (null = coverage only). Set them from
    // *** your ISO / policy schedule when you are ready to audit against them.
    focusAreas: [
      { key: 'fire',     label: 'Firefighting',     match: ['OPERATIONS - Firefighting', '^FIRE$'], annualHours: null },
      { key: 'driver',   label: 'Driver / Operator', match: ['^DRIVER', 'Driver/Operator'],          annualHours: null },
      { key: 'officer',  label: 'Officer',           match: ['^OFFICER'],                            annualHours: null },
      { key: 'ems',      label: 'EMS / Medical',     match: ['^EMS', 'OPERATIONS - Medical', 'EMS CME'], annualHours: null },
      { key: 'hazmat',   label: 'HazMat',            match: ['HAZMAT'],                              annualHours: null },
      { key: 'rescue',   label: 'Rescue',            match: ['Vehicle Rescue', 'Water and Ice Rescue', 'Extrication'], annualHours: null },
      { key: 'ics',      label: 'ICS / Command',     match: ['^ICS'],                                annualHours: null },
      { key: 'osha',     label: 'OSHA / Mandated',   match: ['OSHA'],                                annualHours: null },
      { key: 'crr',      label: 'Pre-plan / CRR',    match: ['^CRR'],                                annualHours: null },
    ],

    // $1 = start  $2 = end
    classQuery: `
      SELECT tc.id, tc.name, to_char(tc.start_date, 'YYYY-MM-DD') AS class_date,
             COALESCE(tc.category_name, '') AS category_name,
             COALESCE(tc.topic_names, '')   AS topic_names,
             COALESCE(tc.duration_hours, 0) AS duration_hours,
             (47174 = ANY(tc.training_type_ids)) AS is_inhouse
      FROM {{DB_NAME}}.app.v_training_class tc
      WHERE tc.start_date BETWEEN $1::date AND $2::date
      ORDER BY tc.start_date, tc.name
    `,

    attendanceQuery: `
      SELECT DISTINCT user_id, training_class_id
      FROM {{DB_NAME}}.app.v_training_class_attendee
      WHERE training_class_id = ANY($1::integer[])
    `,

    // Active members only.
    rosterQuery: `
      SELECT id AS user_id, personnel_id, personnel_full_name,
             to_char(personnel_start_date, 'YYYY-MM-DD') AS personnel_start
      FROM {{DB_NAME}}.app.v_personnel
      WHERE personnel_is_active = true
      ORDER BY personnel_full_name
    `,
  },

  response_by_day_hour: {
    title: 'Response by Day & Hour',
    category: 'incidents',
    description: 'Heatmap of incident frequency by day of week and hour of day, with personnel and date filters.',
    type: 'heatmap',

    // Populates the personnel filter dropdown.
    personnelQuery: `
      SELECT DISTINCT irp.personnel_id, irp.public_name
      FROM {{DB_NAME}}.app.v_incident_report_personnel irp
      ORDER BY irp.public_name
    `,

    // $1 = start date (inclusive)
    // $2 = end date   (inclusive — server adds +1 day for the < comparison)
    // $3 = personnel_id integer, or NULL for department total
    //
    // Uses COUNT(DISTINCT ir.id) so multi-personnel incidents count once
    // for the department total view.
    dataQuery: `
      SELECT
        EXTRACT(ISODOW FROM ((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}'))::int AS day_num,
        EXTRACT(HOUR  FROM ((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}'))::int  AS hour,
        COUNT(DISTINCT ir.id)::int                                                               AS count
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
        AND ($3::integer IS NULL OR irp.personnel_id = $3::integer)
      GROUP BY
        EXTRACT(ISODOW FROM ((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}')),
        EXTRACT(HOUR  FROM ((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}'))
      ORDER BY 1, 2
    `,
  },

  incident_projection: {
    title: 'Incident Projection',
    category: 'incidents',
    description: 'Projects this year\'s total incident volume from where we are now and how past years finished, with a range, cross-check methods, and a cumulative chart.',
    type: 'projection',

    // $1 = first date  $2 = last date. Daily incident counts by local date
    // (REPORT_TIMEZONE). The raw filter is padded a day each side; the server
    // trims to exact local dates.
    dailyQuery: `
      SELECT to_char((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD') AS local_date,
             COUNT(*)::int AS n
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ir.alarm_at >= ($1::date - interval '1 day')
        AND ir.alarm_at <  ($2::date + interval '2 day')
      GROUP BY 1
    `,
  },

  training_matrix: {
    title: 'Training Matrix',
    category: 'personnel',
    description: 'Yes/no attendance matrix for in-house training classes — spot who is engaging with the new training format.',
    type: 'matrix',

    // $1 = start date (inclusive)  $2 = end date (inclusive)
    classQuery: `
      SELECT id, name, start_date::date AS class_date
      FROM {{DB_NAME}}.app.v_training_class
      WHERE start_date >= $1::date
        AND start_date <= $2::date
        AND 47174 = ANY(training_type_ids)
      ORDER BY start_date, name
    `,

    // Active members only — pulled from v_personnel so firefighters with
    // zero in-house attendances still appear as (empty) rows in the matrix.
    rosterQuery: `
      SELECT id AS user_id, personnel_full_name
      FROM {{DB_NAME}}.app.v_personnel
      WHERE personnel_is_active = true
      ORDER BY personnel_full_name
    `,

    // $1 = integer[] of class IDs returned by classQuery.
    // Matches on user_id (integer) so name-format differences don't break lookups.
    attendanceQuery: `
      SELECT DISTINCT user_id, training_class_id
      FROM {{DB_NAME}}.app.v_training_class_attendee
      WHERE training_class_id = ANY($1::integer[])
    `,
  },

  member_activity: {
    title: 'Member Activity',
    category: 'personnel',
    description: 'One member\'s incidents and training over a date range, totaled by year and quarter with every call and class expandable.',
    type: 'member-activity',

    // Populates the member dropdown. Active members first.
    personnelQuery: `
      SELECT personnel_id, personnel_full_name, personnel_is_active,
             to_char(personnel_start_date, 'YYYY-MM-DD') AS personnel_start
      FROM {{DB_NAME}}.app.v_personnel
      ORDER BY personnel_is_active DESC, personnel_full_name
    `,

    // Department denominators for the percentages. $1 = the member's effective
    // start (later of their department start date and the report start),
    // $2 = end date — so new members are compared only against activity that
    // happened after they joined, matching Response by Personnel.
    deptIncidentQuery: `
      SELECT ir.id,
             to_char((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD HH24:MI') AS alarm_local
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
    `,

    // In-house classes only (type 47174): those are open to everyone, so they
    // make a fair denominator. Specialty courses only some members take
    // would skew the percentage.
    deptTrainingQuery: `
      SELECT tc.id,
             to_char(tc.start_date, 'YYYY-MM-DD') AS class_date,
             COALESCE(tc.duration_hours, 0)       AS duration_hours
      FROM {{DB_NAME}}.app.v_training_class tc
      WHERE tc.start_date >= $1::date
        AND tc.start_date <= $2::date
        AND 47174 = ANY(tc.training_type_ids)
    `,

    // $1 = start date (inclusive)  $2 = end date (inclusive)  $3 = personnel_id
    // alarm_local is the alarm time converted to REPORT_TIMEZONE, as text, so
    // the server can group by local year/quarter without Date conversions.
    incidentQuery: `
      SELECT DISTINCT
        ir.id,
        to_char((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD HH24:MI') AS alarm_local,
        ir.incident_number,
        COALESCE(ir.neris_primary_incident_type_name, ir.actual_incident_type_description) AS incident_type,
        ir.address
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      WHERE irp.personnel_id = $3::integer
        AND ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
      ORDER BY alarm_local, ir.id
    `,

    // $1 = start date (inclusive)  $2 = end date (inclusive)  $3 = personnel_id
    // Attendees are keyed on v_personnel.id (user_id), not personnel_id.
    trainingQuery: `
      SELECT DISTINCT
        tc.id,
        to_char(tc.start_date, 'YYYY-MM-DD')                AS class_date,
        tc.name,
        tc.category_name,
        COALESCE(tc.duration_hours, 0)                      AS duration_hours,
        (47174 = ANY(tc.training_type_ids))                 AS is_inhouse
      FROM {{DB_NAME}}.app.v_personnel p
      INNER JOIN {{DB_NAME}}.app.v_training_class_attendee tca
          ON tca.user_id = p.id
      INNER JOIN {{DB_NAME}}.app.v_training_class tc
          ON tc.id = tca.training_class_id
      WHERE p.personnel_id = $3::integer
        AND tc.start_date >= $1::date
        AND tc.start_date <= $2::date
      ORDER BY class_date, tc.name, tc.id
    `,
  },

  member_scorecard: {
    title: 'Member Scorecard',
    category: 'personnel',
    description: 'One member\'s incident response and in-house training compared with their peers — headline percentages, rank, and a quarterly trend against the department median.',
    type: 'member-scorecard',

    // Every member, active or not. user_id (v_personnel.id) keys training
    // attendance; personnel_id keys incident response.
    rosterQuery: `
      SELECT id AS user_id, personnel_id, personnel_full_name, personnel_is_active,
             to_char(personnel_start_date, 'YYYY-MM-DD') AS personnel_start
      FROM {{DB_NAME}}.app.v_personnel
      ORDER BY personnel_is_active DESC, personnel_full_name
    `,

    // $1 = start date (inclusive)  $2 = end date (inclusive)
    // All department incidents in the range (the denominator), with the alarm
    // time converted to REPORT_TIMEZONE as text.
    incidentQuery: `
      SELECT ir.id,
             to_char((ir.alarm_at AT TIME ZONE 'UTC') AT TIME ZONE '{{TIMEZONE}}', 'YYYY-MM-DD HH24:MI') AS alarm_local
      FROM {{DB_NAME}}.app.f_incident_report ir
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
    `,

    // $1 = start  $2 = end — which incidents each member responded to.
    responseQuery: `
      SELECT DISTINCT irp.personnel_id, irp.incident_report_id
      FROM {{DB_NAME}}.app.v_incident_report_personnel irp
      INNER JOIN {{DB_NAME}}.app.f_incident_report ir
          ON ir.id = irp.incident_report_id
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
    `,

    // $1 = start  $2 = end — in-house classes only (type 47174): open to
    // everyone, so they make a fair denominator.
    classQuery: `
      SELECT tc.id,
             to_char(tc.start_date, 'YYYY-MM-DD') AS class_date,
             COALESCE(tc.duration_hours, 0)       AS duration_hours
      FROM {{DB_NAME}}.app.v_training_class tc
      WHERE tc.start_date >= $1::date
        AND tc.start_date <= $2::date
        AND 47174 = ANY(tc.training_type_ids)
    `,

    // $1 = integer[] of class IDs returned by classQuery.
    attendanceQuery: `
      SELECT DISTINCT user_id, training_class_id
      FROM {{DB_NAME}}.app.v_training_class_attendee
      WHERE training_class_id = ANY($1::integer[])
    `,
  },

  response_by_personnel: {
    title: 'Response by Personnel',
    category: 'personnel',
    description: 'Incident response counts and percentage of department calls per member over a date range.',
    type: 'filtered-table',

    // $1 = start date (inclusive)
    // $2 = end date   (inclusive — server adds +1 day for the < comparison)
    //
    // dept_total comes from a CTE so the percentage is accurate even for
    // incidents that had no responding personnel recorded.
    dataQuery: `
      WITH dept AS (
        SELECT COUNT(DISTINCT ir.id) AS total
        FROM {{DB_NAME}}.app.f_incident_report ir
        WHERE ir.alarm_at >= $1::date
          AND ir.alarm_at <  ($2::date + interval '1 day')
      ),
      training AS (
        -- Training hours per member, filtered from each member's effective start
        -- (the later of their department start date and the report start date).
        SELECT
          p.personnel_id,
          GREATEST(p.personnel_start_date::date, $1::date)                                     AS member_start,
          COALESCE(SUM(tc.duration_hours), 0)                                                  AS training_hours,
          COALESCE(SUM(tc.duration_hours) FILTER (WHERE 47174 = ANY(tc.training_type_ids)), 0) AS inhouse_hours
        FROM {{DB_NAME}}.app.v_personnel p
        LEFT JOIN {{DB_NAME}}.app.v_training_class_attendee tca
            ON tca.user_id = p.id
        LEFT JOIN {{DB_NAME}}.app.v_training_class tc
            ON tc.id = tca.training_class_id
           AND tc.start_date >= GREATEST(p.personnel_start_date::date, $1::date)
           AND tc.start_date <= $2::date
        GROUP BY p.personnel_id, p.personnel_start_date
      )
      SELECT
        irp.public_name,
        COUNT(DISTINCT ir.id)::int                                                             AS incident_count,
        avail_inc.cnt::int                                                                     AS available_incidents,
        ROUND(COUNT(DISTINCT ir.id)::numeric / NULLIF(avail_inc.cnt, 0) * 100, 1)             AS pct_of_dept,
        d.total::int                                                                           AS dept_total,
        COALESCE(t.training_hours, 0)                                                         AS training_hours,
        COALESCE(t.inhouse_hours,  0)                                                         AS inhouse_hours,
        avail_ih.hrs                                                                           AS inhouse_avail_hours,
        ROUND(COALESCE(t.inhouse_hours, 0) / NULLIF(avail_ih.hrs, 0) * 100, 1)               AS pct_of_inhouse
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      INNER JOIN {{DB_NAME}}.app.v_personnel p
          ON p.personnel_id = irp.personnel_id AND p.personnel_is_active = true
      CROSS JOIN dept d
      LEFT JOIN training t ON t.personnel_id = irp.personnel_id
      CROSS JOIN LATERAL (
        SELECT COUNT(DISTINCT ir2.id) AS cnt
        FROM {{DB_NAME}}.app.f_incident_report ir2
        WHERE ir2.alarm_at >= COALESCE(t.member_start, $1::date)
          AND ir2.alarm_at <  ($2::date + interval '1 day')
      ) avail_inc
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(tc2.duration_hours), 0) AS hrs
        FROM {{DB_NAME}}.app.v_training_class tc2
        WHERE tc2.start_date >= COALESCE(t.member_start, $1::date)
          AND tc2.start_date <= $2::date
          AND 47174 = ANY(tc2.training_type_ids)
      ) avail_ih
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
      GROUP BY irp.personnel_id, irp.public_name, d.total, t.training_hours, t.inhouse_hours, avail_inc.cnt, avail_ih.hrs
      ORDER BY incident_count DESC, irp.public_name
    `
  },

};
