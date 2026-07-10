// ---------------------------------------------------------------------------
// Report registry — add a new entry here to create a new report page.
// Each key becomes the URL slug: /report/<key>?token=...
//
// type: 'table'          (default) — runs `query`, plain data table
// type: 'heatmap'                  — day-of-week × hour heatmap with filters
// type: 'filtered-table'           — date-filtered table; `dataQuery` receives
//                                    $1=start, $2=end
// ---------------------------------------------------------------------------
module.exports = {

  probationary_metrics: {
    title: 'Probationary Metrics',
    query: `
      -- TODO: replace with real query
      SELECT 'placeholder' AS metric, 0 AS value
    `,
  },

  response_by_day_hour: {
    title: 'Response by Day & Hour',
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
        EXTRACT(ISODOW FROM (ir.alarm_at AT TIME ZONE '{{TIMEZONE}}'))::int AS day_num,
        EXTRACT(HOUR  FROM (ir.alarm_at AT TIME ZONE '{{TIMEZONE}}'))::int  AS hour,
        COUNT(DISTINCT ir.id)::int                                          AS count
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
        AND ($3::integer IS NULL OR irp.personnel_id = $3::integer)
      GROUP BY
        EXTRACT(ISODOW FROM (ir.alarm_at AT TIME ZONE '{{TIMEZONE}}')),
        EXTRACT(HOUR  FROM (ir.alarm_at AT TIME ZONE '{{TIMEZONE}}'))
      ORDER BY 1, 2
    `,
  },

  response_by_personnel: {
    title: 'Response by Personnel',
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
      )
      SELECT
        irp.public_name,
        COUNT(DISTINCT ir.id)::int                                          AS incident_count,
        ROUND(COUNT(DISTINCT ir.id)::numeric / NULLIF(d.total, 0) * 100, 1) AS pct_of_dept,
        d.total::int                                                        AS dept_total
      FROM {{DB_NAME}}.app.f_incident_report ir
      INNER JOIN {{DB_NAME}}.app.v_incident_report_personnel irp
          ON irp.incident_report_id = ir.id
      CROSS JOIN dept d
      WHERE ir.alarm_at >= $1::date
        AND ir.alarm_at <  ($2::date + interval '1 day')
      GROUP BY irp.personnel_id, irp.public_name, d.total
      ORDER BY incident_count DESC, irp.public_name
    `
  },

};
