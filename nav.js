// ---------------------------------------------------------------------------
// Navigation categories — controls the sidebar order and labels on the
// home page. Each `id` matches the `category` field in reports.js.
// Add a new object here to create a new category section.
// ---------------------------------------------------------------------------
module.exports = [

  {
    id: 'trends',
    label: 'Trends & Summaries',
    description: 'Year-end summaries, projections, unusual spikes and long-term patterns.',
  },

  {
    id: 'incidents',
    label: 'Incidents',
    description: 'Incident response patterns and call volume trends.',
  },

  {
    id: 'personnel',
    label: 'Personnel',
    description: 'Individual and department-wide personnel response metrics.',
  },

];
