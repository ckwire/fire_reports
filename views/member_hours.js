// ---------------------------------------------------------------------------
// Member Hours Contributed — time on incidents, training and other activities,
// from the payroll time records, with estimated pay.
//
// Pay estimate = hours x the member's pay rate in effect on that date
// (v_personnel_pay_rate), plus any stipend on the time entry. If a date falls
// after the member's last rate period, the latest rate is carried forward; if
// no rate exists at all, the rate on the time entry is used, else the hours are
// counted as unpriced. Payroll rules (minimums, rounding, caps) are whatever
// the time entries already reflect — this is an estimate, not a payroll run.
// ---------------------------------------------------------------------------
const createKit = require('./kit');

const KINDS = [
  { key: 'incident_reports', label: 'Incidents',          color: '#c0392b' },
  { key: 'training',         label: 'Training',           color: '#1e3a5f' },
  { key: 'activities',       label: 'Activities & events', color: '#1a8a7d' },
];
const money = n => n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 0 });
    const [rows, rates, roster] = await Promise.all([
      K.query(report, 'payrollQuery', [range.start, range.end]),
      K.query(report, 'rateQuery'),
      K.query(report, 'rosterQuery'),
    ]);

    const periodsBy = new Map();
    rates.forEach(r => { if (!periodsBy.has(r.user_id)) periodsBy.set(r.user_id, []); periodsBy.get(r.user_id).push(r); });
    let carried = 0, unpriced = 0;
    const rateFor = (uid, date, rowRate) => {
      const ps = periodsBy.get(uid) || [];
      const hit = ps.find(p => p.start_date <= date && (!p.end_date || p.end_date >= date));
      if (hit) return hit.pay_rate;
      const before = ps.filter(p => p.start_date <= date).pop();
      if (before) { carried++; return before.pay_rate; }
      if (rowRate > 0) return rowRate;
      return null;
    };

    const byUser = new Map(roster.map(m => [m.user_id, m]));
    const members = new Map();
    const months = new Map();
    let unpricedHours = 0;
    rows.forEach(r => {
      const kind = KINDS.find(k => k.key === r.kind) ? r.kind : 'activities';
      const hours = Number(r.hours) || 0;
      const rate = rateFor(r.user_id, r.work_date, Number(r.row_rate) || 0);
      const pay = rate === null ? null : hours * rate + (Number(r.stipend) || 0);
      if (rate === null) { unpriced++; unpricedHours += hours; }
      if (!members.has(r.user_id)) members.set(r.user_id, { uid: r.user_id, name: (byUser.get(r.user_id) || {}).name || r.public_name, active: (byUser.get(r.user_id) || {}).active, hours: {}, pay: 0, total: 0, entries: 0 });
      const m = members.get(r.user_id);
      m.hours[kind] = (m.hours[kind] || 0) + hours; m.total += hours; m.entries++;
      if (pay !== null) m.pay += pay;
      const mk = r.work_date.slice(0, 7);
      if (!months.has(mk)) months.set(mk, {});
      months.get(mk)[kind] = (months.get(mk)[kind] || 0) + hours;
    });

    const list = [...members.values()].sort((a, b) => b.total - a.total);
    const totalHours = list.reduce((s, m) => s + m.total, 0);
    const totalPay = list.reduce((s, m) => s + m.pay, 0);
    const kindTotal = k => list.reduce((s, m) => s + (m.hours[k] || 0), 0);

    // months in range, in order
    const monthKeys = [];
    for (let d = `${range.start.slice(0, 7)}-01`; d <= range.end; d = K.addMonths(d, 1)) monthKeys.push(d.slice(0, 7));
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const chart = K.stackedBars({
      labels: monthKeys.map(k => MN[+k.slice(5, 7) - 1]),
      sublabels: monthKeys.map((k, i) => (i === 0 || k.endsWith('-01')) ? k.slice(0, 4) : ''),
      series: KINDS.map(k => ({ name: k.label, color: k.color, values: monthKeys.map(mk => (months.get(mk) || {})[k.key] || 0) })),
      aria: 'Member hours by month', width: 1100, height: 240, every: monthKeys.length > 24 ? 2 : 1,
    });

    const tableRows = list.map(m => `<tr>
      <th scope="row">${esc(K.shortName(m.name))}${m.active === false ? ' <span class="muted">(inactive)</span>' : ''}</th>
      ${KINDS.map(k => `<td class="num">${K.fmtNum(m.hours[k.key] || 0)}</td>`).join('')}
      <td class="num strong">${K.fmtNum(m.total)}</td><td class="num">${K.fmtPct(totalHours ? m.total / totalHours * 100 : null)}</td>
      <td class="num">${money(m.pay)}</td></tr>`);
    tableRows.push(`<tr class="total"><th scope="row">All members</th>${KINDS.map(k => `<td class="num">${K.fmtNum(kindTotal(k.key))}</td>`).join('')}
      <td class="num">${K.fmtNum(totalHours)}</td><td class="num">100%</td><td class="num">${money(totalPay)}</td></tr>`);

    const days = K.daysBetween(range.start, range.end);
    const activeWithHours = list.filter(m => m.active !== false);
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Hours contributed', value: K.fmtInt(totalHours), accent: true, sub: [KINDS.map(k => `${k.label.split(' ')[0]} ${K.fmtInt(kindTotal(k.key))}`).join(' · ')] })}
      ${K.tile({ title: 'Estimated pay', value: money(totalPay), sub: [totalHours ? `avg ${money(totalPay / Math.max(totalHours - unpricedHours, 1))}/hour` : '', unpricedHours ? `${K.fmtNum(unpricedHours)} h had no pay rate` : ''] })}
      ${K.tile({ title: 'Avg per active member', value: `${K.fmtNum(activeWithHours.length ? activeWithHours.reduce((s, m) => s + m.total, 0) / activeWithHours.length : null)} h`, sub: [`${activeWithHours.length} active members with hours`, days < 365 ? `over ${days} days` : ''] })}
      ${K.tile({ title: 'On incidents', value: kindTotal('incident_reports') && totalHours ? K.fmtPct(kindTotal('incident_reports') / totalHours * 100, 0) : '—', sub: ['of all hours were on incidents'] })}
    </div>`;

    const body = list.length === 0 ? '<p class="empty-msg">No payroll time entries in this range.</p>' : `${tiles}
  ${K.card('Hours by month', `${chart}${K.legend(KINDS.map(k => ({ label: k.label, color: k.color, box: true })))}`)}
  ${K.card('By member', K.table({ head: ['Member', ...KINDS.map(k => ({ label: k.label, num: 1 })), { label: 'Total h', num: 1 }, { label: 'Share', num: 1 }, { label: 'Est. pay', num: 1 }], rows: tableRows }),
    { lead: 'Hours are the payable time on each time entry (already rounded by the payroll system).' })}
  <p class="note"><strong>About the pay estimate:</strong> hours × the member’s pay rate in effect on that date, plus any stipend recorded. ${carried ? `${carried} entries fell after a member’s last rate period and used their latest rate. ` : ''}${unpriced ? `${unpriced} entries (${K.fmtNum(unpricedHours)} h) had no rate and are not priced. ` : ''}
    It does not apply payroll rules that are not already reflected in the time entries, so it will not match a payroll run to the dollar. Activities include meetings, events and details recorded outside incidents and training.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, body,
      subtitle: `Time and estimated pay &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
