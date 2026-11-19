// ---------------------------------------------------------------------------
// Training vs Call Mix — do we train for what we run?
//
// Calls are grouped with views/kit.js categories. Training is matched to the
// same categories by the `alignment` list in reports.js (patterns against
// class category and topic names). Training is measured in member-hours
// (class hours x members who attended) so it reflects training received,
// not just classes scheduled. A class that matches more than one category
// splits its hours between them.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const splitTopics = s => String(s || '').split(/,\s+(?=[A-Z0-9\/& ]+ - )/).map(t => t.trim()).filter(Boolean);

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 1 });
    const [incRows, classRows] = await Promise.all([
      K.query(report, 'incidentQuery', [range.start, range.end]),
      K.query(report, 'classQuery', [range.start, range.end]),
    ]);
    let attendance = [];
    if (classRows.length) attendance = await K.query(report, 'attendanceQuery', [classRows.map(c => c.id)]);
    const attendees = new Map();
    attendance.forEach(a => attendees.set(a.training_class_id, (attendees.get(a.training_class_id) || 0) + 1));

    const areas = report.alignment.map(a => ({ ...a, res: a.match.map(p => new RegExp(p, 'i')), color: K.CATEGORY_BY_KEY[a.category].color }));
    const areaKeys = new Set(areas.map(a => a.category));

    // --- Calls -------------------------------------------------------------------------------
    const incs = incRows.map(r => ({ ...r, category: K.categoryOf(r) }));
    const callCount = {};
    incs.forEach(i => { callCount[i.category] = (callCount[i.category] || 0) + 1; });
    const alignedCalls = incs.filter(i => areaKeys.has(i.category)).length;

    // --- Training ----------------------------------------------------------------------------
    const trainHours = {}, classHours = {};
    let generalMH = 0, totalMH = 0;
    const generalTopics = {};
    const quarters = K.quartersBetween(range.start, range.end);
    const qIdx = new Map(quarters.map((q, i) => [q.key, i]));
    const qTrain = areas.map(() => new Array(quarters.length).fill(0)), qTrainTot = new Array(quarters.length).fill(0);
    classRows.forEach(c => {
      const topics = splitTopics(c.topic_names);
      const hit = areas.filter(a => a.res.some(re => re.test(c.category_name) || topics.some(t => re.test(t))));
      const mh = (Number(c.duration_hours) || 0) * (attendees.get(c.id) || 0);
      totalMH += mh;
      const qi = qIdx.get(K.quarterKey(`${c.class_date} 00`));
      if (hit.length === 0) {
        generalMH += mh;
        (topics.length ? topics : [c.category_name || 'Uncategorized']).forEach(t => { generalTopics[t] = (generalTopics[t] || 0) + mh / Math.max(topics.length, 1); });
        return;
      }
      hit.forEach(a => {
        trainHours[a.category] = (trainHours[a.category] || 0) + mh / hit.length;
        classHours[a.category] = (classHours[a.category] || 0) + (Number(c.duration_hours) || 0) / hit.length;
        if (qi !== undefined) qTrain[areas.indexOf(a)][qi] += mh / hit.length;
      });
      if (qi !== undefined) qTrainTot[qi] += mh;
    });
    const alignedMH = totalMH - generalMH;

    // --- Comparison table --------------------------------------------------------------------
    const rows = areas.map(a => {
      const calls = callCount[a.category] || 0;
      const callPct = alignedCalls ? calls / alignedCalls * 100 : 0;
      const mh = trainHours[a.category] || 0;
      const trainPct = alignedMH ? mh / alignedMH * 100 : 0;
      return { a, calls, callPct, mh, trainPct, gap: trainPct - callPct, perCall: calls ? mh / calls : null, ch: classHours[a.category] || 0 };
    });
    const maxPct = Math.max(...rows.flatMap(r => [r.callPct, r.trainPct]), 1);
    const pairBars = rows.map(r => `<div class="pb">
      <div class="pb-l"><i class="dot" style="background:${r.a.color}"></i>${esc(r.a.label)}</div>
      <div class="pb-bars">
        <div class="pb-row"><span class="pb-k">Calls</span><span class="pb-t"><span style="width:${r.callPct / maxPct * 100}%;background:${r.a.color}"></span></span><b>${r.callPct.toFixed(0)}%</b></div>
        <div class="pb-row"><span class="pb-k">Training</span><span class="pb-t"><span style="width:${r.trainPct / maxPct * 100}%;background:${r.a.color};opacity:.45"></span></span><b>${r.trainPct.toFixed(0)}%</b></div>
      </div>
      <div class="pb-gap ${Math.abs(r.gap) < 5 ? 'muted' : r.gap < 0 ? 'bad' : 'good'}">${r.gap >= 0 ? '+' : '−'}${Math.abs(r.gap).toFixed(0)} pts</div>
    </div>`).join('');

    const tableRows = rows.map(r => `<tr><th scope="row"><i class="dot" style="background:${r.a.color}"></i>${esc(r.a.label)}</th>
      <td class="num">${r.calls}</td><td class="num strong">${K.fmtPct(r.callPct, 0)}</td>
      <td class="num">${K.fmtNum(r.ch)}</td><td class="num">${K.fmtInt(r.mh)}</td><td class="num strong">${K.fmtPct(r.trainPct, 0)}</td>
      <td class="num ${Math.abs(r.gap) < 5 ? '' : r.gap < 0 ? 'bad' : 'good'}">${r.gap >= 0 ? '+' : '−'}${Math.abs(r.gap).toFixed(0)}</td>
      <td class="num">${r.perCall === null ? '—' : K.fmtNum(r.perCall)}</td></tr>`);

    // --- Trend for each area: call share vs training share by quarter ------------------------
    const qCalls = areas.map(() => new Array(quarters.length).fill(0)), qCallsTot = new Array(quarters.length).fill(0);
    incs.forEach(i => {
      if (!areaKeys.has(i.category)) return;
      const qi = qIdx.get(K.quarterKey(i.alarm_local)); if (qi === undefined) return;
      qCalls[areas.findIndex(a => a.category === i.category)][qi]++; qCallsTot[qi]++;
    });
    const trendFor = idx => K.lineChart({
      labels: quarters.map(q => q.label), sublabels: quarters.map((q, i) => (q.q === 1 || i === 0) ? String(q.year) : ''),
      series: [
        { name: 'Share of calls', values: qCalls[idx].map((v, i) => qCallsTot[i] ? v / qCallsTot[i] * 100 : null), color: areas[idx].color },
        { name: 'Share of training', values: qTrain[idx].map((v, i) => qTrainTot[i] ? v / qTrainTot[i] * 100 : null), color: areas[idx].color, dashed: true },
      ], yMax: 100, yFmt: v => `${Math.round(v)}%`, height: 200, aria: `${areas[idx].label}: calls vs training by quarter`,
    });

    const general = Object.entries(generalTopics).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([t, mh]) => ({ label: esc(t), value: mh, display: `${K.fmtInt(mh)} h`, color: '#8a96a8' }));

    const worst = [...rows].sort((a, b) => a.gap - b.gap)[0];
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Emergency calls', value: K.fmtInt(alignedCalls), sub: [`${K.fmtPct(incs.length ? alignedCalls / incs.length * 100 : null, 0)} of all calls (excludes service, cancelled, false alarms)`] })}
      ${K.tile({ title: 'Call-specific training', value: `${K.fmtInt(alignedMH)} h`, sub: [`member-hours · ${K.fmtPct(totalMH ? alignedMH / totalMH * 100 : null, 0)} of all training`, `${K.fmtInt(generalMH)} h general (driver, officer, admin…)`] })}
      ${K.tile({ title: 'Biggest under-trained area', value: worst && worst.gap < -5 ? `${worst.gap.toFixed(0)} pts` : 'None', accent: true, sub: [worst && worst.gap < -5 ? `${esc(worst.a.label)}: ${worst.callPct.toFixed(0)}% of calls, ${worst.trainPct.toFixed(0)}% of training` : 'training broadly matches the call mix'] })}
      ${K.tile({ title: 'Training per call', value: alignedCalls ? `${K.fmtNum(alignedMH / alignedCalls)} h` : '—', sub: ['member-hours of call-specific training per emergency call'] })}
    </div>`;

    const css = `
      .pbwrap { padding: 4px 16px 14px; }
      .pb { display: grid; grid-template-columns: 190px 1fr 70px; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid #f0f2f5; }
      .pb-l { font-weight: 600; font-size: .86rem; }
      .pb-row { display: grid; grid-template-columns: 60px 1fr 42px; gap: 8px; align-items: center; font-size: .76rem; color: #666; margin: 2px 0; }
      .pb-t { background: #eef0f3; height: 12px; border-radius: 3px; overflow: hidden; }
      .pb-t span { display: block; height: 100%; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .pb-row b { text-align: right; color: #1a1a2e; font-variant-numeric: tabular-nums; }
      .pb-gap { text-align: right; font-weight: 700; font-size: .86rem; }
      .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 16px; }
      .grid4 .card { margin-bottom: 0; }`;

    const body = (incs.length === 0 && classRows.length === 0) ? '<p class="empty-msg">No calls or training in this range.</p>' : `${tiles}
  <div class="grid2">
    ${K.card('Share of calls vs share of training', `<div class="pbwrap">${pairBars}</div>`,
      { lead: 'Both shares are out of these emergency categories only. Gap = training share minus call share; red means we train on it less than we run it.' })}
    ${K.card('Training not tied to a call type', general.length ? K.hBars(general) : '<p class="lead">None.</p>', { lead: 'Member-hours of driver, officer, administrative and other general training.' })}
  </div>
  ${K.card('Detail', K.table({ head: ['Area', { label: 'Calls', num: 1 }, { label: '% of calls', num: 1 }, { label: 'Class hours', num: 1 }, { label: 'Member-hours', num: 1 }, { label: '% of training', num: 1 }, { label: 'Gap pts', num: 1 }, { label: 'Training h / call', num: 1 }], rows: tableRows }))}
  <div class="grid4">${areas.map((a, i) => K.card(esc(a.label), `${trendFor(i)}${K.legend([{ label: 'Calls', color: a.color }, { label: 'Training', color: a.color, dashed: true }])}`)).join('')}</div>
  <p class="note">Training is matched to call types by the patterns in <code>alignment</code> in reports.js (class category or topic names). Hours are member-hours: a 2-hour class with 10 members is 20 hours. A class covering two areas splits its hours between them.
    Equal shares are not necessarily the goal — fire and hazmat are high-risk and low-frequency, so they usually deserve more training than their share of calls. Use the gap to start the conversation.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, body, css,
      subtitle: `What we run vs what we train &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
