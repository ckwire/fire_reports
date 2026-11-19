// ---------------------------------------------------------------------------
// Who Responds Together — pairs and crews.
//   ?min=<n>   fewest shared calls for a pair to be listed (default 15)
//
// For each pair: shared calls, and "lift" = how much more often they are on
// the same call than chance would put them there, given how many calls each
// runs (lift 1.0 = no more than chance, 1.5 = 50% more often).
// ---------------------------------------------------------------------------
const createKit = require('./kit');

async function handle(req, res, report, ctx) {
  const K = createKit(ctx);
  const { esc } = K;

  try {
    const range = K.resolveRange(req, report, { defaultYearsBack: 1 });
    const minShared = Math.min(200, Math.max(2, parseInt(req.query.min, 10) || 15));
    const [incsAll, roster] = await Promise.all([
      K.incidentsWithResponders(report, range.start, range.end),
      K.query(report, 'rosterQuery'),
    ]);
    const incs = incsAll.filter(i => i.members.size > 0);
    const N = incs.length;
    const person = new Map(roster.map(m => [m.personnel_id, m]));
    const nm = p => K.shortName((person.get(p) || {}).name || `#${p}`);

    const calls = new Map(), crewSum = new Map(), small = new Map(), pairs = new Map();
    const key = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    incs.forEach(i => {
      const ms = [...i.members];
      ms.forEach(p => {
        calls.set(p, (calls.get(p) || 0) + 1);
        crewSum.set(p, (crewSum.get(p) || 0) + ms.length - 1);
        if (ms.length - 1 <= 2) small.set(p, (small.get(p) || 0) + 1);
      });
      for (let a = 0; a < ms.length; a++) for (let b = a + 1; b < ms.length; b++) {
        const k = key(ms[a], ms[b]); pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    });
    const lift = (a, b, t) => (calls.get(a) && calls.get(b)) ? t * N / (calls.get(a) * calls.get(b)) : null;
    const pairList = [...pairs.entries()].map(([k, t]) => {
      const [a, b] = k.split('|').map(Number);
      return { a, b, t, lift: lift(a, b, t), withLess: t / Math.min(calls.get(a), calls.get(b)) };
    });

    // --- Most frequent and strongest pairs --------------------------------------------------
    const pairRow = p => `<tr><th scope="row">${esc(nm(p.a))} &amp; ${esc(nm(p.b))}</th><td class="num strong">${p.t}</td>
      <td class="num">${K.fmtPct(p.withLess * 100, 0)}</td><td class="num ${p.lift >= 1.2 ? 'good' : p.lift < 0.9 ? 'dim' : ''}">${p.lift.toFixed(2)}×</td></tr>`;
    const pairHead = ['Pair', { label: 'Together', num: 1 }, { label: 'Of the less-active one’s calls', num: 1 }, { label: 'Lift', num: 1 }];
    const frequent = [...pairList].sort((x, y) => y.t - x.t).slice(0, 15).map(pairRow);
    const strongest = pairList.filter(p => p.t >= minShared).sort((x, y) => y.lift - x.lift).slice(0, 15).map(pairRow);

    // --- Matrix of the 14 most active members ---------------------------------------------------
    const topM = [...calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([p]) => p);
    const cellColor = l => l === null ? '#fff' : l >= 1.25 ? '#2a5080' : l >= 1.1 ? '#7ea6d1' : l >= 0.9 ? '#e6ecf3' : '#f3f5f8';
    const matrix = `<div class="tw"><table class="pm"><thead><tr><th></th>${topM.map(p => `<th><span>${esc(nm(p))}</span></th>`).join('')}</tr></thead><tbody>${
      topM.map(a => `<tr><th scope="row">${esc(nm(a))}</th>${topM.map(b => {
        if (a === b) return `<td class="pc self">${calls.get(a)}</td>`;
        const t = pairs.get(key(a, b)) || 0, l = lift(a, b, t);
        return `<td class="pc" style="background:${cellColor(l)};color:${l >= 1.25 ? '#fff' : '#333'}" title="${esc(nm(a))} & ${esc(nm(b))}: ${t} calls together, lift ${l === null ? '—' : l.toFixed(2)}">${t}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>`;

    // --- Crew size on each member's calls ---------------------------------------------------------
    const crewRows = [...calls.entries()].filter(([, c]) => c >= 20)
      .map(([p, c]) => ({ p, c, avg: crewSum.get(p) / c, small: (small.get(p) || 0) / c }))
      .sort((a, b) => b.small - a.small).slice(0, 12)
      .map(r => `<tr><th scope="row">${esc(nm(r.p))}${(person.get(r.p) || {}).active === false ? ' <span class="muted">(inactive)</span>' : ''}</th><td class="num">${r.c}</td><td class="num">${r.avg.toFixed(1)}</td><td class="num strong">${K.fmtPct(r.small * 100, 0)}</td></tr>`);

    // --- Mentor matches for current probationers (first 12 months) -----------------------------------
    const yearAgo = K.addMonths(K.localToday(), -12);
    const probies = roster.filter(m => m.active && m.start_date && m.start_date > yearAgo && calls.get(m.personnel_id));
    const mentorRows = probies.map(m => {
      const partners = pairList.filter(p => p.a === m.personnel_id || p.b === m.personnel_id)
        .map(p => ({ other: p.a === m.personnel_id ? p.b : p.a, t: p.t, lift: p.lift }))
        .filter(x => { const o = person.get(x.other); return o && o.active && !(o.start_date && o.start_date > yearAgo); })
        .sort((a, b) => b.t - a.t).slice(0, 3);
      return `<tr><th scope="row">${esc(K.shortName(m.name))}</th><td class="num">${calls.get(m.personnel_id)}</td>
        <td>${partners.map(x => `${esc(nm(x.other))} <span class="muted">(${x.t}, ${x.lift.toFixed(1)}×)</span>`).join('; ') || '<span class="muted">—</span>'}</td></tr>`;
    });

    const best = pairList.filter(p => p.t >= minShared).sort((x, y) => y.lift - x.lift)[0];
    const most = [...pairList].sort((x, y) => y.t - x.t)[0];
    const loneliest = [...calls.entries()].filter(([, c]) => c >= 20).map(([p, c]) => ({ p, s: (small.get(p) || 0) / c })).sort((a, b) => b.s - a.s)[0];
    const tiles = `<div class="tiles">
      ${K.tile({ title: 'Most frequent pair', value: most ? String(most.t) : '—', accent: true, sub: [most ? `${esc(nm(most.a))} &amp; ${esc(nm(most.b))}` : '', 'calls together'] })}
      ${K.tile({ title: 'Strongest partnership', value: best ? `${best.lift.toFixed(1)}×` : '—', sub: [best ? `${esc(nm(best.a))} &amp; ${esc(nm(best.b))}` : '', best ? `together on ${best.t} calls` : ''] })}
      ${K.tile({ title: 'Average crew', value: K.fmtNum(K.mean(incs.map(i => i.members.size))), sub: ['members per call'] })}
      ${K.tile({ title: 'Most often in a small crew', value: loneliest ? K.fmtPct(loneliest.s * 100, 0) : '—', sub: [loneliest ? `${esc(nm(loneliest.p))} — calls with ≤2 others` : ''] })}
    </div>`;

    const css = `
      table.pm { font-size: .72rem; width: auto; }
      table.pm thead th { height: 110px; vertical-align: bottom; padding: 4px 2px; white-space: nowrap; }
      table.pm thead th span { display: inline-block; writing-mode: vertical-rl; transform: rotate(180deg); }
      table.pm tbody th { white-space: nowrap; font-size: .74rem; padding: 3px 8px; }
      td.pc { text-align: center; min-width: 34px; padding: 4px 2px; border: 1px solid #fff; font-variant-numeric: tabular-nums; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      td.pc.self { background: #1e3a5f; color: #fff; font-weight: 700; }
      .sw-box { display:inline-block; width:14px; height:14px; border-radius:3px; vertical-align:middle; margin-right:5px; }`;

    const body = N === 0 ? '<p class="empty-msg">No calls with personnel in this range.</p>' : `${tiles}
  ${K.card('Most active members: calls together', `${matrix}
    <div class="legend" style="padding-top:10px"><span><i class="sw-box" style="background:#2a5080"></i>Together 25%+ more than chance</span><span><i class="sw-box" style="background:#7ea6d1"></i>10–25% more</span><span><i class="sw-box" style="background:#e6ecf3"></i>About chance</span><span><i class="sw-box" style="background:#f3f5f8;border:1px solid #ddd"></i>Less than chance</span><span>Diagonal = member’s total calls</span></div>`,
    { lead: 'Numbers are calls together. Shading shows whether that is more or less than you would expect from how busy each person is.' })}
  <div class="grid2">
    ${K.card('Most frequent pairs', K.table({ head: pairHead, rows: frequent }))}
    ${K.card(`Strongest partnerships (${minShared}+ calls together)`, K.table({ head: pairHead, rows: strongest }), { lead: 'Ranked by lift: pairs who turn up together far more than chance — usually neighbours, family, or habit.' })}
  </div>
  <div class="grid2">
    ${K.card('Mentor matches for probationers', probies.length ? K.table({ head: ['Probationer', { label: 'Calls', num: 1 }, 'Established members they run with most (calls, lift)'], rows: mentorRows }) : '<p class="lead" style="padding:4px 16px 14px">No members in their first 12 months.</p>',
      { lead: 'Natural mentors: experienced members who are already on calls with each new member.' })}
    ${K.card('Often in a small crew', K.table({ head: ['Member', { label: 'Calls', num: 1 }, { label: 'Avg others', num: 1 }, { label: '≤2 others', num: 1 }], rows: crewRows }),
      { lead: 'Members (20+ calls) whose calls most often have two or fewer other members on them.' })}
  </div>
  <p class="note">Based on members recorded on each incident (${K.fmtInt(N)} calls). "Lift" compares how often two people are on the same call with what chance would predict from each one's call count; it is most meaningful for pairs with plenty of shared calls. Being on the same call does not mean they rode together.</p>`;

    res.send(K.page({ report, token: req.query.token || '', range, body, css,
      filters: K.numberInput('min', 'Min shared calls', minShared, { min: 2, max: 200, width: 80 }),
      subtitle: `Pairs and crews &mdash; ${esc(range.start)} to ${esc(range.end)}` }));
  } catch (err) {
    K.fail(res, report, err);
  }
}

module.exports = { handle };
