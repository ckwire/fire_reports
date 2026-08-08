// ---------------------------------------------------------------------------
// Report registry — add a new entry here to create a new report page.
// Each key becomes the URL slug: /report/<key>?token=...
//
// type: 'table'          (default) — runs `query`, plain data table
// type: 'heatmap'                  — day-of-week × hour heatmap with filters
// type: 'filtered-table'           — date-filtered table; `dataQuery` receives
//                                    $1=start, $2=end
//
// category: matches an `id` in nav.js — controls which sidebar section the
//           report appears under on the home page
// description: short sentence shown on the home page report card
// ---------------------------------------------------------------------------
module.exports = {

  probationary_metrics: {
    title: 'Probationary Metrics',
    category: 'personnel',
    description: 'Track activity and progress for probationary members.',
    query: `
      -- TODO: replace with real query
      SELECT 'placeholder' AS metric, 0 AS value
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
      inhouse_avail AS (
        -- Total hours of in-house classes offered in the range — the denominator
        -- for each member's in-house attendance percentage.
        SELECT COALESCE(SUM(duration_hours), 0) AS total_hours
        FROM {{DB_NAME}}.app.v_training_class
        WHERE start_date >= $1::date
          AND start_date <= $2::date
          AND 47174 = ANY(training_type_ids)
      ),
      training AS (
        SELECT
          p.personnel_id,
          COALESCE(SUM(tc.duration_hours), 0)                                              AS training_hours,
          COALESCE(SUM(tc.duration_hours) FILTER (WHERE 47174 = ANY(tc.training_type_ids)), 0) AS inhouse_hours
        FROM {{DB_NAME}}.app.v_personnel p
        LEFT JOIN {{DB_NAME}}.app.v_training_class_attendee tca
            ON tca.user_id = p.id
        LEFT JOIN {{DB_NAME}}.app.v_training_class tc
            ON tc.id = tca.training_class_id
           AND tc.start_date >= $1::date
           AND tc.start_date <= $2::date
        GROUP BY p.personnel_id
      )
      SELECT
        irp.public_name,
        COUNT(DISTINCT ir.id)::int                                          AS incident_count,
        ROUND(COUNT(DISTINCT ir.id)::numeric / NULLIF(d.total, 0) * 100, 1) AS pct_of_dept,
        d.total::int                                                        AS dept_total,
        COALESCE(t.training_hours, 0)                                      AS training_hours,
        COALESCE(t.inhouse_hours,  0)                                      AS inhouse_hours
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      CROSS JOIN dept d
      LEFT JOIN training t ON t.personnel_id = irp.personnel_id
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
      GROUP BY irp.personnel_id, irp.public_name, d.total, t.training_hours, t.inhouse_hours
      ORDER BY incident_count DESC, irp.public_name
    `
  },

};
