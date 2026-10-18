const D = window.NFL_DATA;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
const fx = (v, d = 1) => v == null ? '—' : Number(v).toFixed(d);
const store = {get(k){try{return localStorage.getItem(k)}catch{return null}}, set(k,v){try{localStorage.setItem(k,v)}catch{}}};

if (!D) {
  document.querySelector('main').innerHTML = '<div class="empty"><h2>No hay datos todavía</h2>Ejecuta <b>Actualizar ahora.bat</b> y recarga la página.</div>';
  throw new Error('sin datos');
}

const MODEL_NAMES = {ppp:'Puntos por jugada (tu fórmula)', srs:'SRS ajustado por rival', elo:'Elo', pyth:'Pitagórico'};
const dt = new Date(D.generated);
const fmtDate = (d, o) => d.toLocaleString('es-MX', o);
$('#season').textContent = D.season;
$('#upd').innerHTML = `Última actualización: <b>${fmtDate(dt,{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</b><br>Se actualiza cuando tú lo pides`;
document.querySelectorAll('.p-hfa').forEach(e => e.textContent = D.params.hfa);
document.querySelectorAll('.p-sigma').forEach(e => e.textContent = D.params.sigma);
document.querySelectorAll('.p-prior').forEach(e => e.textContent = D.params.prior_games);

// ---------- tabs ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  store.set('tab', b.dataset.tab);
});
const savedTab = store.get('tab');
if (savedTab) document.querySelector(`nav button[data-tab="${savedTab}"]`)?.click();

// ---------- colors ----------
function hex2rgb(h){h=(h||'777777').replace('#','');return [0,2,4].map(i=>parseInt(h.substr(i,2),16))}
function dist(a,b){const x=hex2rgb(a),y=hex2rgb(b);return Math.hypot(x[0]-y[0],x[1]-y[1],x[2]-y[2])}
function barColors(g){
  const T = D.teams; let h = T[g.home.abbr]?.color || '013369', a = T[g.away.abbr]?.color || 'D50A0A';
  if (dist(h, a) < 90) a = T[g.away.abbr]?.alt || 'A5ACAF';
  const light = c => { const [r, g2, b] = hex2rgb(c); return (0.299*r + 0.587*g2 + 0.114*b) > 215; };
  if (dist(h, a) < 90 || light(a)) a = 'A5ACAF';
  if (light(h)) h = '013369';
  return ['#' + h, '#' + a];
}

// ---------- predictions ----------
let curKey = Number(store.get('week')) || D.current_key;
if (!D.weeks.some(w => w.key === curKey)) curKey = D.current_key;
let onlyHigh = false;
let useAuto = store.get('autoAdj') !== '0';
let model = store.get('model') || 'cons';
$('#model').value = model;
$('#sort').value = store.get('sort') || 'pts';
const SIG = D.params.sigma;

function Phi(x){ // CDF normal estandar
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function getMan(id){ try { return JSON.parse(store.get('adj_' + id)) || {h:0, a:0}; } catch { return {h:0, a:0}; } }
function setMan(id, v){ store.set('adj_' + id, JSON.stringify(v)); }

// Calcula la prediccion mostrada segun el modelo elegido + ajustes
function view(g){
  const p = g.pred, man = getMan(g.id), H = g.home.abbr, A = g.away.abbr;
  const dh = (man.h || 0) - (useAuto ? 0 : p.adj.home), da = (man.a || 0) - (useAuto ? 0 : p.adj.away);
  const dm = dh - da, dt = dh + da;
  const models = p.models.map(m => ({...m, margin: m.margin + dm,
    hs: m.hs != null ? m.hs + dh : null, as: m.as != null ? m.as + da : null}));
  models.forEach(m => { m.prob_home = Phi(m.margin / SIG); m.pick = m.margin >= 0 ? H : A; });
  let margin, total;
  if (model === 'cons') { margin = p.margin + dm; total = p.total + dt; }
  else { const m = models.find(x => x.key === model); margin = m.margin; total = m.hs != null ? m.hs + m.as : p.total + dt; }
  const prob_home = Phi(margin / SIG), pick = margin >= 0 ? H : A;
  const agree = models.filter(m => m.pick === pick).length / models.length;
  const mean = models.reduce((s, m) => s + m.margin, 0) / models.length;
  const spread = Math.sqrt(models.reduce((s, m) => s + (m.margin - mean) ** 2, 0) / models.length);
  let cert = 100 * (0.45 * Math.min(1, Math.abs(margin) / 10) + 0.35 * agree + 0.20 * Math.min(1, p.sample / 8)) - Math.min(10, spread);
  cert = Math.max(1, Math.min(99, Math.round(cert)));
  const level = cert >= 70 ? 'Alta' : cert >= 50 ? 'Media' : 'Baja';
  const pPick = m => pick === H ? m.prob_home : 1 - m.prob_home;
  const score = model === 'cons' ? models.reduce((s, m) => s + pPick(m), 0) / models.length : Math.max(prob_home, 1 - prob_home);
  let result = null;
  if (g.final) {
    const real = g.hs - g.as;
    result = real === 0 ? {tie: true} : {correct: (real > 0 ? H : A) === pick, err: Math.abs(margin - real)};
  }
  return {margin, total, hs: (total + margin) / 2, as: (total - margin) / 2, prob_home, pick, cert, level,
          score, models, man, result, manual: !!(man.h || man.a)};
}

// Asigna 16, 15, 14... de mayor a menor confianza
function weekViews(w){
  const vs = w.games.map(g => ({g, v: view(g)}));
  [...vs].sort((a, b) => b.v.score - a.v.score || Math.abs(b.v.margin) - Math.abs(a.v.margin))
    .forEach((x, i) => x.v.pts = Math.max(1, 16 - i));
  return vs;
}
function weekSummary(vs){
  const done = vs.filter(x => x.v.result && !x.v.result.tie);
  if (!done.length) return null;
  return {n: done.length, correct: done.filter(x => x.v.result.correct).length,
    mae: done.reduce((s, x) => s + x.v.result.err, 0) / done.length,
    pts: done.filter(x => x.v.result.correct).reduce((s, x) => s + x.v.pts, 0),
    ptsMax: done.reduce((s, x) => s + x.v.pts, 0)};
}

function renderWeeks(){
  $('#weeks').innerHTML = D.weeks.map(w =>
    `<button class="chip ${w.key===curKey?'on':''}" data-k="${w.key}">${esc(w.label)}${w.key===D.current_key?'<span class="dot" title="Jornada actual"></span>':''}</button>`).join('');
  document.querySelectorAll('.chip').forEach(c => c.onclick = () => {curKey = pkKey = +c.dataset.k; store.set('week', curKey); renderWeek();});
  document.querySelector('.chip.on')?.scrollIntoView({inline:'center', block:'nearest'});
}

const ST_ES = {Out:'Fuera', Doubtful:'Dudoso', Questionable:'En duda'};
function injuryHtml(g){
  const ex = g.extra; if (!ex || !ex.injuries) return '';
  return ['away','home'].map(s => {
    const ab = g[s].abbr, list = (ex.injuries[ab] || []);
    const qs = ex.qb_start?.[ab], ql = ex.qb?.[ab];
    const qbTxt = qs ? ` (QB probable: ${esc(qs)}${ql && ql !== qs ? `, en lugar de ${esc(ql)}` : ''})` : '';
    if (!list.length) return `<div class="injl"><b>${ab}</b>${qbTxt}: sin lesionados reportados</div>`;
    return `<div class="injl"><b>${ab}</b>${qbTxt}: ` +
      list.map(p => `${esc(p.name)} <small>${esc(p.pos||'')}</small> <span class="st-${p.status}">${ST_ES[p.status]||p.status}</span>`).join(' · ') + '</div>';
  }).join('');
}
function weatherHtml(g){
  if (g.indoor) return '🏟️ Estadio techado: el clima no influye';
  const w = g.extra?.weather; if (!w) return '';
  const parts = [];
  if (w.temp != null) parts.push(`🌡️ ${Math.round((w.temp - 32) / 1.8)}°C`);
  if (w.gust != null) parts.push(`💨 ráfagas ${Math.round(w.gust * 1.609)} km/h`);
  if (w.precip != null) parts.push(`🌧️ ${w.precip}% lluvia`);
  return parts.join(' · ');
}

function gameCard({g, v}){
  const p = g.pred, T = D.teams, [hc, ac] = barColors(g);
  const fin = g.final, st = g.state, H = g.home.abbr, A = g.away.abbr;
  const when = fmtDate(new Date(g.date), {weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
  const status = fin ? 'Final' : st === 'in' ? `<span class="live">● EN VIVO ${esc(g.detail)}</span>` : when;
  const realWinner = fin ? (g.hs > g.as ? 'home' : g.hs < g.as ? 'away' : null) : null;
  const row = (side) => {
    const t = g[side], isH = side === 'home';
    const pts = isH ? v.hs : v.as, rec = isH ? p.rec_home : p.rec_away;
    return `<div class="team ${fin && realWinner && realWinner!==side ? 'loser':''}">
      <img src="${esc(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="tname">${esc(t.name)}<small>${isH ? (g.neutral ? 'Sede neutral' : 'Local') : 'Visitante'} · ${esc(rec)} antes del partido</small></div>
      <div class="ppts ${v.pick===t.abbr?'win':''}" title="Puntos pronosticados">${Math.round(pts)}</div>
      <div class="real">${fin ? `<b>${isH ? g.hs : g.as}</b><br>real` : ''}</div>
    </div>`;
  };
  const ph = Math.round(v.prob_home * 100);
  let res = '';
  if (v.result) res = v.result.tie ? `<div class="res tie">Empate ${g.hs}-${g.as}</div>`
    : `<div class="res ${v.result.correct?'ok':'no'}">${v.result.correct ? `✓ Acertó · +${v.pts} pts` : `✗ Falló · 0 de ${v.pts} pts`} · error en el margen: ${fx(v.result.err)}</div>`;
  const ex = g.extra || {};
  const notes = useAuto ? p.adj.notes : [];
  const refs = [];
  if (g.odds) refs.push(`Las Vegas: <b>${esc(g.odds)}</b>${g.ou ? ` · O/U ${esc(g.ou)}` : ''}`);
  if (ex.fpi_home != null) refs.push(`ESPN FPI: ${ex.fpi_home >= ex.fpi_away ? H + ' ' + fx(ex.fpi_home,0) : A + ' ' + fx(ex.fpi_away,0)}%`);
  const wx = weatherHtml(g);
  const models = v.models.map(m => `<tr ${m.key===model?'style="background:#eef3fb;font-weight:600"':''}><td>${esc(MODEL_NAMES[m.key])}</td>
      <td>${m.hs!=null ? `${A} ${fx(m.as)} – ${fx(m.hs)} ${H}` : '—'}</td>
      <td>${esc(m.pick)} por ${fx(Math.abs(m.margin))}</td><td>${Math.round(Math.max(m.prob_home,1-m.prob_home)*100)}%</td>
      <td>${Math.round(m.weight*100)}%</td></tr>`).join('');
  const ip = p.inputs;
  return `<article class="game">
    <div class="ghead"><div class="gl"><span>${status}</span><span>${esc(g.tv || '')}</span></div>
      <span class="cpts" title="Puntos de confianza: 16 = el más seguro de la jornada">${v.pts}<small>PTS</small></span></div>
    ${row('away')}${row('home')}
    <div class="bar"><span style="width:${100-ph}%;background:${ac}"></span><span style="width:${ph}%;background:${hc}"></span></div>
    <div class="barlbl"><span>${A} ${100-ph}%</span><span>Probabilidad de ganar</span><span>${ph}% ${H}</span></div>
    <div class="verdict">
      <span>Pronóstico: <b>${esc(T[v.pick]?.short || v.pick)}</b> por ${fx(Math.abs(v.margin))} · Total ${fx(v.total)}${v.manual ? '<span class="adjflag">ajuste manual</span>' : ''}</span>
      <span class="spacer"></span>
      <span class="badge ${v.level}" title="Índice de certidumbre ${v.cert}/100">${v.level} ${v.cert} <span class="meter"><i style="width:${v.cert}%"></i></span></span>
    </div>
    ${res}
    <div class="info">
      ${notes.map(n => `<div class="adj">${esc(n)}</div>`).join('')}
      ${v.manual ? `<div class="man">✎ Tu ajuste: ${A} ${v.man.a>0?'+':''}${v.man.a||0}, ${H} ${v.man.h>0?'+':''}${v.man.h||0}</div>` : ''}
      ${wx ? `<div>${wx}</div>` : ''}
      ${refs.length ? `<div>${refs.join(' · ')}</div>` : ''}
    </div>
    <details><summary>Ver modelos, lesiones y ajustes</summary>
      <table class="mt"><tr><th>Modelo</th><th>Marcador</th><th>Ganador</th><th>Prob.</th><th>Peso</th></tr>${models}</table>
      ${ex.injuries ? `<div class="formula"><b>Reporte de lesiones</b> <small>(actualizado ${fmtDate(new Date(ex.fetched),{weekday:'short',hour:'numeric',minute:'2-digit'})})</small>${injuryHtml(g)}</div>` : ''}
      ${!fin ? `<div class="formula"><b>Ajuste manual</b> (puntos a sumar o restar; p. ej. −5 si juega el QB suplente)
        <div class="manual" data-id="${g.id}">
          <label>${A} <input type="number" step="0.5" data-s="a" value="${v.man.a||0}"></label>
          <label>${H} <input type="number" step="0.5" data-s="h" value="${v.man.h||0}"></label>
          <button data-reset>Quitar</button>
        </div></div>` : ''}
      <div class="formula">
        <b>Tu fórmula (puntos por jugada):</b><br>
        ${H}: (<code>${fx(ip.home.off_ppp,3)} × ${fx(ip.home.plays_pg)}</code> + <code>${fx(ip.away.def_ppp,3)} × ${fx(ip.away.opp_plays_pg)}</code>) / 2
          = (${fx(ip.h_off)} + ${fx(ip.a_def)}) / 2 = <b>${fx((ip.h_off+ip.a_def)/2)}</b><br>
        ${A}: (<code>${fx(ip.away.off_ppp,3)} × ${fx(ip.away.plays_pg)}</code> + <code>${fx(ip.home.def_ppp,3)} × ${fx(ip.home.opp_plays_pg)}</code>) / 2
          = (${fx(ip.a_off)} + ${fx(ip.h_def)}) / 2 = <b>${fx((ip.a_off+ip.h_def)/2)}</b><br>
        ${ip.hfa ? `+ ${ip.hfa} pts de ventaja de local repartidos entre ambos marcadores.` : 'Sede neutral: sin ventaja de local.'}
        ${g.venue ? `<br>Estadio: ${esc(g.venue)}` : ''}
      </div>
    </details>
  </article>`;
}

function renderWeek(){
  renderWeeks();
  const w = D.weeks.find(x => x.key === curKey);
  $('#wtitle').textContent = w.label;
  $('#wmeta').textContent = (w.stats_through
    ? `Predicción basada en estadísticas hasta ${w.stats_through}`
    : `Inicio de temporada: predicción basada en Elo de temporadas anteriores`) + ` · ${w.games.length} partidos · Modelo: ${$('#model').selectedOptions[0].text}`;
  let vs = weekViews(w);
  const s = weekSummary(vs);
  const b = $('#wbanner');
  if (s) {
    b.hidden = false;
    b.innerHTML = `<div><b>${s.correct}/${s.n}</b>Ganadores acertados (${pct(s.correct,s.n)})</div>
      <div><b>${s.pts}/${s.ptsMax}</b>Puntos de confianza obtenidos</div>
      <div><b>${fx(s.mae)}</b>Error prom. en margen (pts)</div>`;
  } else b.hidden = true;
  $('#bye').textContent = w.bye.length ? 'Descansan: ' + w.bye.map(t => D.teams[t]?.short || t).join(', ') : '';
  if (onlyHigh) vs = vs.filter(x => x.v.level === 'Alta');
  const sort = $('#sort').value;
  if (sort === 'pts') vs.sort((a,b) => b.v.pts - a.v.pts);
  if (sort === 'cert') vs.sort((a,b) => b.v.cert - a.v.cert);
  $('#games').innerHTML = vs.length ? vs.map(gameCard).join('') : '<div class="empty">No hay partidos con certidumbre alta esta jornada.</div>';
  document.querySelectorAll('.manual').forEach(box => {
    const id = box.dataset.id;
    box.querySelectorAll('input').forEach(inp => inp.onchange = () => {
      const m = getMan(id); m[inp.dataset.s] = parseFloat(inp.value) || 0; setMan(id, m); rerender(id); });
    box.querySelector('[data-reset]').onclick = () => { setMan(id, {h:0, a:0}); rerender(id); };
  });
  if (typeof renderAcc === 'function' && accReady) { renderAcc(); renderPicks(); }
}
function rerender(openId){ renderWeek(); const el = document.querySelector(`.manual[data-id="${openId}"]`); if (el) el.closest('details').open = true; }
$('#sort').onchange = () => { store.set('sort', $('#sort').value); renderWeek(); };
$('#model').onchange = () => { model = $('#model').value; store.set('model', model); renderWeek(); };
const autoBtn = $('#autoAdj');
const paintAuto = () => { autoBtn.classList.toggle('on', useAuto); autoBtn.textContent = 'Ajustes lesiones/clima: ' + (useAuto ? 'Sí' : 'No'); };
paintAuto();
autoBtn.onclick = () => { useAuto = !useAuto; store.set('autoAdj', useAuto ? '1' : '0'); paintAuto(); renderWeek(); };
$('#onlyHigh').onclick = e => {onlyHigh = !onlyHigh; e.target.classList.toggle('on', onlyHigh); renderWeek();};
let accReady = false;
renderWeek();

// ---------- pick'em (estilo CBS) ----------
let pkKey = curKey;
const pkSel = $('#pkWeek');
pkSel.innerHTML = D.weeks.map(w => `<option value="${w.key}">${esc(w.label)}</option>`).join('');
pkSel.onchange = () => { pkKey = +pkSel.value; renderPicks(); };
const getOvr = id => store.get('pick_' + id);
const setOvr = (id, v) => { try { v ? localStorage.setItem('pick_' + id, v) : localStorage.removeItem('pick_' + id); } catch {} };

function picksData(){
  const w = D.weeks.find(x => x.key === pkKey);
  const vs = weekViews(w).sort((a, b) => new Date(a.g.date) - new Date(b.g.date));
  const rows = vs.map(({g, v}) => {
    const o = getOvr(g.id), valid = o === g.home.abbr || o === g.away.abbr;
    const pick = valid ? o : v.pick;
    let res = null;
    if (g.final && g.hs !== g.as) res = (g.hs > g.as ? g.home.abbr : g.away.abbr) === pick;
    return {g, v, pick, ovr: valid && o !== v.pick, res};
  });
  const last = rows[rows.length - 1];
  const done = rows.filter(r => r.res !== null);
  return {w, rows, tb: last ? {g: last.g, total: Math.round(last.v.total)} : null,
    score: done.length ? {pts: done.filter(r => r.res).reduce((s, r) => s + r.v.pts, 0),
      max: done.reduce((s, r) => s + r.v.pts, 0), ok: done.filter(r => r.res).length, n: done.length} : null};
}

function renderPicks(){
  pkSel.value = pkKey;
  $('#pkModel').textContent = 'Modelo: ' + $('#model').selectedOptions[0].text + (useAuto ? '' : ' (sin ajustes lesiones/clima)');
  const {w, rows, tb, score} = picksData();
  let html = `<div class="pk-head"><div><small>NFL ${D.season} · Pick'em con confianza</small><h3>MIS PICKS · ${esc(w.label).toUpperCase()}</h3></div>
    <div class="sc">${score ? `${score.pts} / ${score.max} pts<br><small>${score.ok} de ${score.n} acertados</small>` : `<small>${rows.length} partidos</small>`}</div></div>`;
  [...rows].sort((a, b) => b.v.pts - a.v.pts).forEach(({g, v, pick, ovr, res}) => {
    const d = fmtDate(new Date(g.date), {weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
    html += `<div class="pk-day">${esc(d)}${g.tv ? ' · ' + esc(g.tv) : ''}</div>`;
    const btn = side => {
      const t = g[side], sel = pick === t.abbr;
      const cls = ['pk-team', sel ? 'sel' : '', sel && res === true ? 'ok' : '', sel && res === false ? 'no' : '', sel && ovr ? 'ovr' : ''].join(' ');
      const sc = g.final ? (side === 'home' ? g.hs : g.as) : Math.round(side === 'home' ? v.hs : v.as);
      return `<button class="${cls}" data-id="${g.id}" data-t="${t.abbr}" ${g.final ? 'disabled' : ''}>
        <img src="${esc(t.logo)}" alt="" crossorigin="anonymous"><span>${esc(t.short || t.name)}</span><em>${sc}${g.final ? '' : ' pron.'}</em></button>`;
    };
    const ph = Math.round(v.prob_home * 100), pa = 100 - ph, [hc, ac] = barColors(g);
    html += `<div class="pk-row">${btn('away')}<div class="pk-at">@</div>${btn('home')}<div class="pk-pts ${res === false ? 'lost' : ''}">${v.pts}</div>
      <div class="pk-prob">
        <span class="${pa > ph ? 'fav' : ''}">${pa}%</span>
        <div class="pk-bar"><i style="width:${pa}%;background:${ac}"></i><i style="width:${ph}%;background:${hc}"></i><b style="left:50%"></b></div>
        <span class="${ph > pa ? 'fav' : ''}">${ph}%</span>
      </div></div>`;
  });
  if (tb) html += `<div class="pk-tb"><span>Desempate · puntos totales ${esc(tb.g.away.abbr)} @ ${esc(tb.g.home.abbr)}</span><b>${tb.g.final ? `${tb.total} <small style="font-size:13px">(real ${tb.g.hs + tb.g.as})</small>` : tb.total}</b></div>`;
  $('#pkSheet').innerHTML = html;
  document.querySelectorAll('.pk-team:not([disabled])').forEach(b => b.onclick = () => {
    const g = D.weeks.find(x => x.key === pkKey).games.find(x => x.id === b.dataset.id);
    setOvr(g.id, b.dataset.t === view(g).pick ? null : b.dataset.t);
    renderPicks();
  });
}

function picksText(){
  const {w, rows, tb, score} = picksData();
  const L = [`🏈 *MIS PICKS NFL ${D.season} · ${w.label}*`, `_Modelo: ${$('#model').selectedOptions[0].text}_`, '━━━━━━━━━━━━━━'];
  [...rows].sort((a, b) => b.v.pts - a.v.pts).forEach(({g, v, pick, res}) => {
    const opp = pick === g.home.abbr ? g.away : g.home, me = D.teams[pick];
    const mark = res === true ? ' ✅' : res === false ? ' ❌' : '';
    L.push(`*${v.pts}* · ${me?.short || pick} ${pick === g.home.abbr ? 'vs' : '@'} ${opp.abbr}${mark}`);
  });
  L.push('━━━━━━━━━━━━━━');
  if (tb) L.push(`🔢 Desempate (${tb.g.away.abbr} @ ${tb.g.home.abbr}): ${tb.total} pts totales`);
  if (score) L.push(`🏆 ${score.pts}/${score.max} pts · ${score.ok} de ${score.n} acertados`);
  return L.join('\n');
}

$('#pkWa').onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(picksText()), '_blank');
$('#pkCopy').onclick = async () => {
  const b = $('#pkCopy');
  try { await navigator.clipboard.writeText(picksText()); b.textContent = '¡Copiado!'; }
  catch { prompt('Copia tus picks:', picksText()); }
  setTimeout(() => b.textContent = 'Copiar texto', 1800);
};
function loadH2C(){
  return window.html2canvas ? Promise.resolve() : new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = ok; s.onerror = bad; document.head.appendChild(s);
  });
}
$('#pkImg').onclick = async () => {
  const b = $('#pkImg'); b.textContent = 'Generando...';
  try {
    await loadH2C();
    const canvas = await html2canvas($('#pkSheet'), {scale: 2, useCORS: true, backgroundColor: '#ffffff'});
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const name = `picks-${D.weeks.find(x => x.key === pkKey).label.replace(/\s+/g, '-').toLowerCase()}.png`;
    const file = new File([blob], name, {type: 'image/png'});
    if (navigator.canShare && navigator.canShare({files: [file]})) {
      await navigator.share({files: [file], title: 'Mis picks NFL', text: picksText()});
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    }
  } catch (e) { alert('No se pudo generar la imagen (¿sin internet?). Usa "Enviar por WhatsApp" o "Copiar texto".'); }
  b.textContent = 'Descargar imagen';
};
renderPicks();

// ---------- teams table ----------
const COLS = [
  ['name','Equipo',null],['record','Récord',null],
  ['off_ppp_raw','PPP Of.',3,1],['def_ppp_raw','PPP Def.',3,-1],
  ['plays_pg_raw','Jugadas/PJ',1,0],['opp_plays_pg_raw','Jug. rival/PJ',1,0],
  ['ppg','Pts/PJ',1,1],['papg','Pts perm./PJ',1,-1],
  ['ypp_off','Yds/jugada Of.',2,1],['ypp_def','Yds/jugada Def.',2,-1],
  ['to_margin','Dif. balones',0,1],['srs','SRS',1,1],['elo','Elo',0,1],['pyth','Pitag. %',0,1],
];
let tSort = ['elo', -1];
function renderTeams(){
  const rows = Object.entries(D.teams).map(([k, t]) => ({k, ...t, pyth: t.pyth*100}));
  const [c, dir] = tSort;
  rows.sort((a,b) => {const x=a[c], y=b[c]; if (typeof x === 'string') return dir*x.localeCompare(y); return dir*((x??-1e9)-(y??-1e9));});
  const ranks = {};
  COLS.forEach(([key,,,good]) => { if (!good) return;
    const sorted = rows.filter(r => r[key]!=null).map(r => r[key]).sort((a,b) => good*(b-a));
    ranks[key] = {top: sorted[4], bot: sorted[sorted.length-5]}; });
  const cls = (key, v, good) => { if (!good || v==null || !ranks[key]) return '';
    const r = ranks[key]; return good*(v - r.top) >= 0 ? 'hi' : good*(v - r.bot) <= 0 ? 'lo' : ''; };
  $('#tteams').innerHTML = '<tr>' + COLS.map(([k,l]) => `<th data-k="${k}" class="${k===c?'sorted':''}">${l}${k===c?(dir>0?' ▲':' ▼'):''}</th>`).join('') + '</tr>' +
    rows.map(r => '<tr>' + COLS.map(([k,,d,good]) => k==='name'
      ? `<td class="tm"><img src="${esc(r.logo)}" alt="" loading="lazy">${esc(r.name)}</td>`
      : `<td class="${cls(k, r[k], good)}">${d==null ? esc(r[k]) : (k==='to_margin' && r[k]>0 ? '+' : '') + fx(r[k], d)}</td>`).join('') + '</tr>').join('');
  document.querySelectorAll('#tteams th').forEach(th => th.onclick = () => {
    const k = th.dataset.k; tSort = [k, tSort[0]===k ? -tSort[1] : (typeof rows[0][k]==='string' ? 1 : -1)]; renderTeams(); });
}
renderTeams();

// ---------- accuracy ----------
// Grafica de lineas en SVG (sin librerias)
function lineChart(labels, series, {min = 0, max = 100, refs = [], suffix = '%'} = {}){
  const W = 760, Hh = 270, L = 44, R = 92, T = 16, B = 34, iw = W - L - R, ih = Hh - T - B;
  const x = i => L + (labels.length === 1 ? iw / 2 : i * iw / (labels.length - 1));
  const y = v => T + ih - (v - min) / (max - min) * ih;
  let s = `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto;display:block" role="img">`;
  for (let v = min; v <= max; v += 25) s += `<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6eaf1"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="#5b6678">${v}${suffix}</text>`;
  refs.forEach(r => s += `<line x1="${L}" x2="${W-R}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.c}" stroke-dasharray="5 4" stroke-width="1.5"/><text x="${W-R+6}" y="${y(r.v)+4}" text-anchor="start" font-size="10.5" fill="${r.c}" font-weight="600">${r.t}</text>`);
  labels.forEach((l, i) => s += `<text x="${x(i)}" y="${Hh-12}" text-anchor="middle" font-size="11.5" fill="#5b6678">${esc(l)}</text>`);
  series.forEach(se => {
    const pts = se.data.map((v, i) => v == null ? null : [x(i), y(v), v, i]).filter(Boolean);
    s += `<polyline fill="none" stroke="${se.color}" stroke-width="${se.w || 2}" stroke-linejoin="round" stroke-linecap="round" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}"/>`;
    pts.forEach(p => s += `<circle cx="${p[0]}" cy="${p[1]}" r="${se.w > 2 ? 5 : 3.5}" fill="${se.color}" stroke="#fff" stroke-width="1.5"><title>${esc(se.name)} · ${esc(labels[p[3]])}: ${Math.round(p[2])}${suffix}</title></circle>`);
    if (se.label && pts.length) { const p = pts[pts.length - 1]; s += `<text x="${p[0] - 8}" y="${p[1] - 10}" text-anchor="end" font-size="12" font-weight="700" fill="${se.color}">${Math.round(p[2])}${suffix}</text>`; }
  });
  return s + '</svg>';
}
const MODEL_COLORS = {cons: '#D50A0A', ppp: '#013369', srs: '#11845b', elo: '#d98c00', pyth: '#7a4fb5'};
const legend = items => `<div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;margin:4px 0 8px">${items.map(([n, c, w]) => `<span style="display:inline-flex;align-items:center;gap:6px"><i style="display:inline-block;width:18px;height:${w > 2 ? 4 : 3}px;border-radius:2px;background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;

function accCharts(wk){
  if (!wk.length) return '';
  const labels = wk.map(w => w.label.replace('Semana ', 'S'));
  const weekly = [{name: 'Consenso', color: MODEL_COLORS.cons, w: 3.5, label: true, data: wk.map(w => 100 * w.summary.correct / w.summary.n)}]
    .concat(Object.keys(MODEL_NAMES).map(k => ({name: MODEL_NAMES[k], color: MODEL_COLORS[k], w: 2, data: wk.map(w => 100 * w.summary.models[k] / w.summary.n)})));
  // acumulado de la temporada
  const cum = (getC) => { let c = 0, n = 0; return wk.map(w => { c += getC(w); n += w.summary.n; return 100 * c / n; }); };
  const cumul = [{name: 'Consenso', color: MODEL_COLORS.cons, w: 3.5, label: true, data: cum(w => w.summary.correct)}]
    .concat(Object.keys(MODEL_NAMES).map(k => ({name: MODEL_NAMES[k], color: MODEL_COLORS[k], w: 2, data: cum(w => w.summary.models[k])})));
  const leg = legend([['Consenso', MODEL_COLORS.cons, 4], ...Object.keys(MODEL_NAMES).map(k => [MODEL_NAMES[k], MODEL_COLORS[k], 2])]);
  const refs = [{v: 50, t: 'Volado 50%', c: '#9aa3b2'}, {v: 65, t: 'Experto ~65%', c: '#11845b'}];
  return `<div class="card"><h3>Aciertos por jornada</h3>${leg}${lineChart(labels, weekly, {refs})}
      <p class="hint">Porcentaje de ganadores acertados cada semana. Pasa el mouse sobre los puntos para ver el valor.</p></div>
    <div class="card"><h3>Acumulado de la temporada</h3>${leg}${lineChart(labels, cumul, {min: 25, max: 100, refs})}
      <p class="hint">Cómo va el porcentaje total de la temporada después de cada jornada. Entre más jornadas, más estable se vuelve.</p></div>`;
}

function renderAcc(){
  const s = D.season_summary;
  if (!s) { $('#tab-acc').innerHTML = '<div class="empty">Aún no hay partidos terminados para medir la precisión.</div>'; return; }
  const models = Object.entries(s.models).sort((a,b) => b[1]-a[1]);
  const best = models[0][1];
  const lv = D.by_level;
  const wk = D.weeks.filter(w => w.summary);
  const cp = {};
  wk.forEach(w => cp[w.key] = weekSummary(weekViews(w)));
  const cpT = Object.values(cp).filter(Boolean).reduce((a, x) => ({pts: a.pts + x.pts, max: a.max + x.ptsMax, c: a.c + x.correct, n: a.n + x.n}), {pts:0, max:0, c:0, n:0});
  $('#tab-acc').innerHTML = `
    <div class="tiles">
      <div class="tile r"><div class="v">${pct(s.correct, s.n)}</div><div class="l">Ganadores acertados en la temporada (${s.correct} de ${s.n})</div></div>
      <div class="tile"><div class="v">${fx(s.mae)}</div><div class="l">Error promedio del margen (puntos)</div></div>
      <div class="tile"><div class="v">${fx(s.mae_total)}</div><div class="l">Error promedio del total de puntos</div></div>
      ${s.vegas_n ? `<div class="tile"><div class="v">${pct(s.vegas_correct, s.vegas_n)}</div><div class="l">Favorito de Las Vegas (${s.vegas_n} partidos con línea)</div></div>` : ''}
    </div>
    ${accCharts(wk)}
    <div class="card"><h3>Puntos de confianza (16 → 1)</h3>
      <p style="margin:0 0 10px">Con el modelo <b>${esc($('#model').selectedOptions[0].text)}</b>${useAuto ? '' : ' sin ajustes de lesiones/clima'}, en total ganaste <b>${cpT.pts}</b> de <b>${cpT.max}</b> puntos posibles (${pct(cpT.pts, cpT.max)}), con ${cpT.c} de ${cpT.n} ganadores acertados.</p>
      ${wk.map(w => cp[w.key] ? `<div class="hbar"><span>${esc(w.label)} · ${cp[w.key].correct}/${cp[w.key].n}</span><div class="track"><i style="width:${100*cp[w.key].pts/cp[w.key].ptsMax}%"></i></div><b>${cp[w.key].pts}/${cp[w.key].ptsMax}</b></div>` : '').join('')}
      <p class="hint">Cambia el modelo en la pestaña Predicciones para comparar cuál te habría dado más puntos.</p>
    </div>
    <div class="card"><h3>¿La certidumbre sirve?</h3>
      ${['Alta','Media','Baja'].map(l => lv[l] ? `<div class="hbar"><span><span class="badge ${l}">${l}</span> &nbsp;${lv[l].n} partidos</span>
        <div class="track"><i style="width:${100*lv[l].correct/lv[l].n}%"></i></div><b>${pct(lv[l].correct, lv[l].n)}</b></div>` : '').join('')}
      <p class="hint">Si el sistema funciona, los pronósticos de certidumbre alta deben acertar más que los de baja.</p>
    </div>
    <div class="card"><h3>Precisión por modelo</h3>
      <div class="hbar best"><span><b>Consenso (predicción final)</b></span><div class="track"><i style="width:${100*s.correct/s.n}%"></i></div><b>${pct(s.correct, s.n)}</b></div>
      ${models.map(([k,v]) => `<div class="hbar"><span>${MODEL_NAMES[k]}</span><div class="track"><i style="width:${100*v/s.n}%"></i></div><b>${pct(v, s.n)}</b></div>`).join('')}
    </div>
    <div class="card"><h3>Jornada por jornada</h3><div class="tscroll"><table class="st">
      <tr><th>Jornada</th><th>Aciertos</th><th>%</th>${Object.keys(MODEL_NAMES).map(k=>`<th>${MODEL_NAMES[k].split(' (')[0]}</th>`).join('')}<th>Error margen</th></tr>
      ${wk.map(w => `<tr><td>${esc(w.label)}</td><td>${w.summary.correct}/${w.summary.n}</td><td>${pct(w.summary.correct,w.summary.n)}</td>
        ${Object.keys(MODEL_NAMES).map(k=>`<td>${w.summary.models[k]}/${w.summary.n}</td>`).join('')}<td>${fx(w.summary.mae)}</td></tr>`).join('')}
    </table></div>
    <p class="hint">Referencia: los mejores modelos públicos aciertan alrededor de 63–68% de los ganadores en una temporada completa.</p></div>`;
}
renderAcc(); accReady = true;

// ---------- how-to example ----------
(function(){
  const w = D.weeks.find(x => x.key === D.current_key); const g = w?.games[0]; if (!g) return;
  const ip = g.pred.inputs, H = g.home.abbr, A = g.away.abbr;
  $('#howExample').innerHTML = `<b>Ejemplo con ${esc(g.away.name)} @ ${esc(g.home.name)}:</b><br>
   ${H}: (${fx(ip.home.off_ppp,3)} × ${fx(ip.home.plays_pg)} + ${fx(ip.away.def_ppp,3)} × ${fx(ip.away.opp_plays_pg)}) / 2 = <b>${fx((ip.h_off+ip.a_def)/2)} pts</b><br>
   ${A}: (${fx(ip.away.off_ppp,3)} × ${fx(ip.away.plays_pg)} + ${fx(ip.home.def_ppp,3)} × ${fx(ip.home.opp_plays_pg)}) / 2 = <b>${fx((ip.a_off+ip.h_def)/2)} pts</b>`;
})();
