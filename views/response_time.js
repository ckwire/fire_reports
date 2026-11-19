// ---------------------------------------------------------------------------
// Response Time Performance — alarm to first-unit arrival.
//   ?target=<minutes>   goal used for "% within target" (default 10)
//   ?category=<key>     limit to one call type (see kit CATEGORIES)
//   ?standby=1          include station standby / cover assignments (default: excluded)
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const MAX_VALID_SECONDS = 7200;   // longer than 2 h is a data/standby artefact, not a response

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report);
    const target = Math.min(60, Math.max(1, parseFloat(req.query.target) || 10));
    const categoryKey = K.CATEGORY_BY_KEY[req.query.category] ? req.query.category : '';
    const includeStandby = req.query.standby === '1';

    const rows = await K.query(report, 'dataQuery', [range.start, range.end]);
    const targetSec = target * 60;

    // --- Select calls -------------------------------------------------------
    const isStandby = r => /standby/i.test(r.unit || '') || String(r.incident_type) === '571';
    let calls = rows.map(r => ({ ...r, category: K.categoryOf(r), hour: K.hourOf(r.alarm_local), dow: K.dayNumOf(r.alarm_local) }));
    if (categoryKey) calls = calls.filter(r => r.category === categoryKey);
    const standbyCount = calls.filter(isStandby).length;
    if (!includeStandby) calls = calls.filter(r => !isStandby(r));

    const valid = calls.filter(r => r.tfa !== null && r.tfa > 0 && r.tfa <= MAX_VALID_SECONDS);
    const noTime = calls.filter(r => r.tfa === null).length;
    const outliers = calls.length - valid.length - noTime;
    const secs = valid.map(r => r.tfa);

    const within = list => list.length ? list.filter(r => r.tfa <= targetSec).length / list.length * 100 : null;
    const stats = list => ({
      n: list.length,
      p50: K.percentile(list.map(r => r.tfa), 50),
      p90: K.percentile(list.map(r => r.tfa), 90),
      within: within(list),
    });
    const overall = stats(valid);

    // --- Tiles ---------------------------------------------------------------
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Calls measured', value: K.fmtInt(valid.length), sub: [
        `of ${K.fmtInt(calls.length)} calls${includeStandby ? '' : ' (standby excluded)'}`,
        noTime + outliers > 0 ? `${noTime} had no arrival time${outliers ? `, ${outliers} over 2 h ignored` : ''}` : '' ] })}
      ${K.tile({ title: 'Median (50th)', value: K.fmtMin(overall.p50), sub: ['minutes : seconds, alarm to first arrival'] })}
      ${K.tile({ title: '90th percentile', value: K.fmtMin(overall.p90), accent: true, sub: ['9 in 10 calls were reached within this time'] })}
      ${K.tile({ title: `Within ${target} min`, value: K.fmtPct(overall.within), sub: [
        overall.within === null ? '' : (overall.within >= 90 ? '<span class="good">Meets a 90% goal</span>' : `<span class="bad">${(90 - overall.within).toFixed(1)} pts short of a 90% goal</span>`) ] })}
    </div>`;

    // --- Quarterly trend ------------------------------------------------------
    const quarters = K.quartersBetween(range.start, range.end);
    const byQuarter = new Map(quarters.map(q => [q.key, []]));
    valid.forEach(r => { const k = K.quarterKey(r.alarm_local); if (byQuarter.has(k)) byQuarter.get(k).push(r); });
    const qStats = quarters.map(q => stats(byQuarter.get(q.key)));
    const minutes = v => v === null ? null : v / 60;
    const trend = K.lineChart({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [
        { name: '90th percentile', values: qStats.map(s => minutes(s.p90)), color: '#1e3a5f', width: 2.6 },
        { name: 'Median', values: qStats.map(s => minutes(s.p50)), color: '#4a90d9', width: 2 },
      ],
      refLines: [{ value: target, label: `${target} min target`, color: '#c0392b' }],
      yFmt: v => `${Math.round(v)}m`, aria: 'Response time by quarter',
    });

    // --- Histogram ------------------------------------------------------------
    const BUCKET = 2 * 60, NB = 15;     // 2-minute buckets, last one is "30+"
    const counts = new Array(NB).fill(0);
    secs.forEach(s => { counts[Math.min(NB - 1, Math.floor(s / BUCKET))]++; });
    const hist = K.stackedBars({
      labels: counts.map((_, i) => i === NB - 1 ? '30+' : `${i * 2}`),
      series: [
        { name: 'Within target', color: '#1e3a5f', values: counts.map((c, i) => (i + 1) * 2 <= target ? c : 0) },
        { name: 'Over target',   color: '#d98e04', values: counts.map((c, i) => (i + 1) * 2 <= target ? 0 : c) },
      ],
      aria: 'Distribution of response times', height: 220,
    });

    // --- Breakdowns -------------------------------------------------------------
    const row = (label, list, dot = '') => {
      const s = stats(list);
      return `<tr><th scope="row">${dot}${esc(label)}</th><td class="num">${s.n}</td><td class="num strong">${K.fmtMin(s.p90)}</td><td class="num">${K.fmtMin(s.p50)}</td><td class="num">${K.fmtPct(s.within)}</td></tr>`;
    };
    const head = first => [first, { label: 'Calls', num: 1 }, { label: '90th', num: 1 }, { label: 'Median', num: 1 }, { label: `≤ ${target} min`, num: 1 }];

    const byCat = K.CATEGORIES
      .map(c => ({ c, list: valid.filter(r => r.category === c.key) }))
      .filter(x => x.list.length > 0)
      .map(x => row(x.c.label, x.list, `<i class="dot" style="background:${x.c.color}"></i>`));

    const slices = [
      ['Day (6am – 6pm)',    valid.filter(r => r.hour >= 6 && r.hour < 18)],
      ['Night (6pm – 6am)',  valid.filter(r => r.hour < 6 || r.hour >= 18)],
      ['Weekday',            valid.filter(r => r.dow <= 5)],
      ['Weekend',            valid.filter(r => r.dow >= 6)],
    ].map(([l, list]) => row(l, list));

    const unitType = r => /pov/i.test(r.unit || '') ? 'Personal vehicle (POV)' : /^\d+$/.test(String(r.unit || '').trim()) ? 'Apparatus' : 'Other / not recorded';
    const units = ['Apparatus', 'Personal vehicle (POV)', 'Other / not recorded']
      .map(t => [t, valid.filter(r => unitType(r) === t)]).filter(([, l]) => l.length).map(([l, list]) => row(l, list));

    // --- Slowest calls ------------------------------------------------------------
    const slow = [...valid].sort((a, b) => b.tfa - a.tfa).slice(0, 15).map(r => `<tr>
      <td>${esc(K.fmtDateTime(r.alarm_local))}</td>
      <td>${esc(String(r.type_desc || '—'))}</td>
      <td>${esc(String(r.address || '').trim() || '—')}</td>
      <td>${esc(String(r.unit || '—'))}</td>
      <td class="num strong">${K.fmtMin(r.tfa)}</td></tr>`);

    const body = valid.length === 0
      ? `<p class="empty-msg">No calls with an arrival time in this selection.</p>`
      : `${tiles}
  <div class="grid2">
    ${K.card('Quarterly trend', `${trend}${K.legend([{ label: '90th percentile', color: '#1e3a5f' }, { label: 'Median', color: '#4a90d9' }, { label: `${target} min target`, color: '#c0392b', dashed: true }])}`)}
    ${K.card('How long calls took', `${hist}${K.legend([{ label: `Within ${target} min`, color: '#1e3a5f' }, { label: 'Over target', color: '#d98e04' }])}`,
      { lead: 'Calls by minutes from alarm to first arrival (2-minute groups).' })}
  </div>
  <div class="grid2">
    ${K.card('By call type', K.table({ head: head('Type'), rows: byCat }))}
    ${K.card('By time and unit', K.table({ head: head('Group'), rows: [...slices, ...units] }))}
  </div>
  ${K.card('Slowest 15 calls', K.table({ head: ['Alarm', 'Type', 'Address', 'First unit', { label: 'Time', num: 1 }], rows: slow }),
    { lead: 'Worth a look for data errors, long travel, or low turnout.' })}
  <p class="note">Time is measured from the alarm to the first unit arriving on scene (turnout plus travel), as recorded on the incident. The 90th percentile is the standard fractile measure: the time within which 90% of calls were reached.
    ${includeStandby ? '' : `${standbyCount} station standby / cover assignments are excluded. `}Calls with no recorded arrival time cannot be measured. Personal-vehicle (POV) arrivals count as arrivals.</p>`;

    const filters = `
      ${K.numberInput('target', 'Target (min)', target, { min: 1, max: 60, step: 0.5, width: 84 })}
      ${K.categorySelect(categoryKey)}
      <div class="fg"><label>Standby calls</label><select name="standby">
        <option value="0"${includeStandby ? '' : ' selected'}>Exclude</option>
        <option value="1"${includeStandby ? ' selected' : ''}>Include</option></select></div>`;

    res.send(K.page({
      report, token: req.query.token || '', range, filters, body,
      subtitle: `Alarm to first arrival &mdash; ${esc(range.start)} to ${esc(range.end)}${categoryKey ? ` &mdash; ${esc(K.CATEGORY_BY_KEY[categoryKey].label)}` : ''}`,
    }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
