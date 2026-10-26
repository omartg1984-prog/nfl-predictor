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

const MODEL_NAMES = {ppp:'Puntos por jugada (tu fórmula)', srs:'SRS ajustado por rival', elo:'Elo', pyth:'Pitagórico', vegas:'Las Vegas (moneyline)'};
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
  const vm = (man.h || 0) - (man.a || 0);   // al modelo de Vegas solo se le suman tus ajustes manuales
  const models = p.models.map(m => ({...m, margin: m.margin + (m.key === 'vegas' ? vm : dm),
    hs: m.hs != null ? m.hs + dh : null, as: m.as != null ? m.as + da : null}));
  models.forEach(m => { m.prob_home = Phi(m.margin / SIG); m.pick = m.margin >= 0 ? H : A; });
  let margin, total;
  if (model === 'cons') { margin = p.margin + dm; total = p.total + dt; }
  else { const m = models.find(x => x.key === model) || models.find(x => x.key === 'elo');
    margin = m.margin; total = m.hs != null ? m.hs + m.as : p.total + dt; }
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
  if (g.market) refs.push(`Las Vegas (moneyline): ${A} <b>${fmtML(g.market.ml_a)}</b> · ${H} <b>${fmtML(g.market.ml_h)}</b> → ${H} ${Math.round(g.market.p_h * 100)}%`);
  else if (g.odds) refs.push(`Las Vegas: <b>${esc(g.odds)}</b>`);
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
      ${(u => u && u.sc >= 35 ? `<div class="adj" style="color:#b71c1c">🚨 Alerta de sorpresa ${u.sc}/100: ${esc(u.dogN)} (Vegas le da ${pc(u.pv)}, nuestros modelos ${pc(u.pm)}). Detalles en la pestaña Las Vegas.</div>` : '')(upsetInfo(g))}
      ${!g.final ? [A, H].map(ab => { const L = D.teams[ab]?.luck?.last; if (!L) return '';
          const tx = {luck_win: `ganó con suerte su último partido vs ${L.vs} (${L.score}); fue superado en yardas`, unlucky_loss: `perdió su último partido jugando mejor vs ${L.vs} (${L.score})`, blown_out: `fue dominado en su último partido por ${L.vs} (${L.score})`}[L.type];
          return tx ? `<div class="adj" style="color:var(--navy)">📊 ${ab} ${tx}.</div>` : ''; }).join('') : ''}
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
        <img src="${esc(t.logo)}" alt="" crossorigin="anonymous"><span>${esc(t.short || t.name)}${(u => u && u.dog === t.abbr && u.sc >= 35 ? ` <b title="Alerta de sorpresa ${u.sc}/100">🚨</b>` : '')(upsetInfo(g))}</span><em>${sc}${g.final ? '' : ' pron.'}</em></button>`;
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
const MODEL_COLORS = {cons: '#D50A0A', ppp: '#013369', srs: '#11845b', elo: '#d98c00', pyth: '#7a4fb5', vegas: '#8d6e63'};
const legend = items => `<div style="display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;margin:4px 0 8px">${items.map(([n, c, w]) => `<span style="display:inline-flex;align-items:center;gap:6px"><i style="display:inline-block;width:18px;height:${w > 2 ? 4 : 3}px;border-radius:2px;background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;

const mN = (s, k) => (s.models_n ? s.models_n[k] : s.n) || 0;   // partidos evaluados por modelo
function fmtML(o){ return o == null ? '—' : (o > 0 ? '+' : '') + o; }

function accCharts(wk){
  if (!wk.length) return '';
  const labels = wk.map(w => w.label.replace('Semana ', 'S'));
  const weekly = [{name: 'Consenso', color: MODEL_COLORS.cons, w: 3.5, label: true, data: wk.map(w => 100 * w.summary.correct / w.summary.n)}]
    .concat(Object.keys(MODEL_NAMES).map(k => ({name: MODEL_NAMES[k], color: MODEL_COLORS[k], w: 2, data: wk.map(w => mN(w.summary, k) ? 100 * w.summary.models[k] / mN(w.summary, k) : null)})));
  // acumulado de la temporada
  const cum = (getC, getN = w => w.summary.n) => { let c = 0, n = 0; return wk.map(w => { c += getC(w); n += getN(w); return n ? 100 * c / n : null; }); };
  const cumul = [{name: 'Consenso', color: MODEL_COLORS.cons, w: 3.5, label: true, data: cum(w => w.summary.correct)}]
    .concat(Object.keys(MODEL_NAMES).map(k => ({name: MODEL_NAMES[k], color: MODEL_COLORS[k], w: 2, data: cum(w => w.summary.models[k] || 0, w => mN(w.summary, k))})));
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
  const models = Object.entries(s.models).filter(([k]) => mN(s, k)).sort((a,b) => b[1]/mN(s,b[0]) - a[1]/mN(s,a[0]));
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
      ${models.map(([k,v]) => `<div class="hbar"><span>${MODEL_NAMES[k]}</span><div class="track"><i style="width:${100*v/mN(s,k)}%"></i></div><b>${pct(v, mN(s,k))}</b></div>`).join('')}
    </div>
    <div class="card"><h3>Jornada por jornada</h3><div class="tscroll"><table class="st">
      <tr><th>Jornada</th><th>Aciertos</th><th>%</th>${Object.keys(MODEL_NAMES).map(k=>`<th>${MODEL_NAMES[k].split(' (')[0]}</th>`).join('')}<th>Error margen</th></tr>
      ${wk.map(w => `<tr><td>${esc(w.label)}</td><td>${w.summary.correct}/${w.summary.n}</td><td>${pct(w.summary.correct,w.summary.n)}</td>
        ${Object.keys(MODEL_NAMES).map(k=>`<td>${mN(w.summary,k) ? w.summary.models[k] + '/' + mN(w.summary,k) : '—'}</td>`).join('')}<td>${fx(w.summary.mae)}</td></tr>`).join('')}
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

// ---------- boton Actualizar ----------
// Con llave de GitHub guardada (solo en tu dispositivo): pide a GitHub que corra la actualizacion.
// Sin llave: solo recarga los datos mas recientes publicados.
const GH = {owner: 'omartg1984-prog', repo: 'nfl-predictor', wf: 'actualizar.yml'};
const TOKEN_KEY = 'gh_update_token';
const getToken = () => store.get(TOKEN_KEY);
const updBtn = $('#updBtn');
updBtn.hidden = false;
updBtn.onclick = () => getToken() ? runUpdate() : showUpdHelp();

function modal(html){
  document.getElementById('updModal')?.remove();
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'updModal';
  m.innerHTML = `<div class="modal-card">${html}</div>`;
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.body.appendChild(m);
  return m;
}

function showUpdHelp(){
  const m = modal(`<h3>Actualizar</h3>
    <p><b>¿Solo quieres ver lo más reciente?</b> Recarga la página con los últimos datos publicados.</p>
    <div class="modal-row" style="justify-content:flex-start;margin-top:4px"><button class="pri" data-reload>🔄 Recargar datos</button></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
    <p><b>¿Eres el administrador?</b> Para que este botón le pida a GitHub descargar estadísticas nuevas, guarda una llave de acceso <i>solo una vez en este dispositivo</i>:</p>
    <ol>
      <li>Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">crear llave en GitHub</a>.</li>
      <li>Nombre: <i>NFL Predictor</i>. Expiración: la que prefieras.</li>
      <li><i>Repository access</i> → <b>Only select repositories</b> → <b>${GH.repo}</b>.</li>
      <li><i>Permissions</i> → <b>Actions: Read and write</b>. Nada más.</li>
      <li><b>Generate token</b>, cópiala y pégala aquí:</li>
    </ol>
    <input type="password" id="tokIn" placeholder="github_pat_..." autocomplete="off">
    <div class="modal-row"><button data-close>Cancelar</button><button class="pri" data-save>Guardar y actualizar</button></div>
    <p class="hint">La llave se guarda solo en este navegador; no se publica ni la ven tus amigos. Solo permite correr la actualización de este repositorio.</p>`);
  m.querySelector('[data-reload]').onclick = () => location.reload();
  m.querySelector('[data-close]').onclick = () => m.remove();
  m.querySelector('[data-save]').onclick = () => {
    const t = m.querySelector('#tokIn').value.trim();
    if (!t) return;
    store.set(TOKEN_KEY, t);
    runUpdate();
  };
}

async function runUpdate(){
  const steps = ['Pedir la actualización a GitHub', 'Descargar estadísticas y recalcular (≈1 min)', 'Publicar la página (≈1 min)', 'Recargar'];
  const m = modal(`<h3>Actualizando…</h3><ul class="steps">${steps.map(s => `<li>${s}</li>`).join('')}</ul>
    <p class="hint" id="updMsg">Puedes cerrar esta ventana; la actualización sigue en GitHub.</p>
    <div class="modal-row"><button data-forget style="margin-right:auto">Olvidar llave</button><button data-close>Cerrar</button></div>`);
  m.querySelector('[data-close]').onclick = () => m.remove();
  m.querySelector('[data-forget]').onclick = () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} m.remove(); };
  const li = [...m.querySelectorAll('.steps li')];
  const set = (i, c) => { li[i].className = c; };
  const msg = t => { const e = m.querySelector('#updMsg'); if (e) e.textContent = t; };
  const api = (path, opt = {}) => fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}${path}`, {...opt,
    headers: {'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + getToken(), 'X-GitHub-Api-Version': '2022-11-28'}});
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now() - 5000;
  const dataNow = () => fetch('data/nfl_data.js?t=' + Date.now()).then(r => r.text()).catch(() => '');
  const before = location.protocol === 'file:' ? '' : await dataNow();
  try {
    set(0, 'run');
    const r = await api(`/actions/workflows/${GH.wf}/dispatches`, {method: 'POST', body: JSON.stringify({ref: 'main'})});
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      set(0, 'bad');
      msg('GitHub rechazó la llave (vencida o sin permiso "Actions: Read and write"). Toca "Olvidar llave" y vuelve a crearla.');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    set(0, 'ok'); set(1, 'run');
    let run = null;
    for (let i = 0; i < 90; i++) {   // hasta ~6 min
      await sleep(4000);
      const j = await (await api(`/actions/workflows/${GH.wf}/runs?event=workflow_dispatch&per_page=1`)).json();
      run = (j.workflow_runs || []).find(x => new Date(x.created_at).getTime() >= t0);
      if (run && run.status === 'completed') break;
    }
    if (!run || run.conclusion !== 'success') {
      set(1, 'bad');
      msg('La actualización no terminó bien. Revisa la pestaña Actions en GitHub.');
      return;
    }
    set(1, 'ok'); set(2, 'run');
    if (location.protocol === 'file:') {
      set(2, 'ok');
      msg('La página web ya se actualizó. Esta copia está en tu computadora: para actualizarla usa "Actualizar ahora.bat".');
      return;
    }
    for (let i = 0; i < 60; i++) {   // esperar a que GitHub Pages publique (hasta ~4 min)
      if ((await dataNow()) !== before) break;
      await sleep(4000);
    }
    set(2, 'ok'); set(3, 'run');
    await sleep(800);
    location.reload();
  } catch (e) {
    msg('No se pudo conectar con GitHub (' + e.message + '). Revisa tu internet e inténtalo de nuevo.');
    li.forEach(x => { if (x.className === 'run') x.className = 'bad'; });
  }
}

// ---------- Las Vegas (moneyline, % del publico, sorpresas) ----------
const vgSel = $('#vgWeek');
let vgKey = D.current_key;
vgSel.innerHTML = D.weeks.map(w => `<option value="${w.key}">${esc(w.label)}</option>`).join('');
vgSel.value = vgKey;
vgSel.onchange = () => { vgKey = +vgSel.value; renderVegas(); };

function american(o){ o = +o; return o > 0 ? 100 / (o + 100) : -o / (-o + 100); }
function surprise(pw){   // pw = probabilidad que Vegas le daba al ganador
  const s = Math.round((1 - pw) * 100);
  if (pw < 0.25) return {s, cls: 's-boom', t: '💥 Batacazo'};
  if (pw < 0.40) return {s, cls: 's-sur', t: '😮 Sorpresa'};
  if (pw < 0.50) return {s, cls: 's-mild', t: 'Ligera sorpresa'};
  if (pw < 0.75) return {s, cls: 's-exp', t: 'Resultado esperado'};
  return {s, cls: 's-sure', t: '✔ Muy esperado'};
}
function marketRes(g){
  const m = g.market; if (!m || !g.final || g.hs === g.as) return null;
  const homeWon = g.hs > g.as, pw = homeWon ? m.p_h : 1 - m.p_h;
  const side = (h, a) => h == null || a == null || h === a ? null : (h > a) === homeWon;
  return {homeWon, pw, sur: surprise(pw), fav: pw > 0.5,
    pub: side(m.tickets_h, m.tickets_a), money: side(m.money_h, m.money_a)};
}
function vgBar(label, a, h, ac, hc){
  if (a == null || h == null) return '';
  return `<div class="vg-bl"><span><b>${a}%</b></span><span>${label}</span><span><b>${h}%</b></span></div>
    <div class="vg-bar"><i style="width:${a}%;background:${ac}"></i><i style="width:${h}%;background:${hc}"></i></div>`;
}
function vgCard(g){
  const m = g.market, H = g.home.abbr, A = g.away.abbr, T = D.teams, [hc, ac] = barColors(g);
  const when = fmtDate(new Date(g.date), {weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
  if (!m) return `<article class="game"><div class="ghead"><span>${when}</span></div><div class="vg-ins" style="padding-bottom:14px">${esc(g.away.name)} @ ${esc(g.home.name)}: todavía no hay momios publicados.</div></article>`;
  const ph = Math.round(m.p_h * 100), pa = 100 - ph;
  const team = (side, ml, open, p) => {
    const t = g[side];
    return `<div class="vg-team ${p > 50 ? 'fav' : ''}"><img src="${esc(t.logo)}" alt="" loading="lazy">
      <div class="tname">${esc(t.name)}<small>${p > 50 ? 'Favorito' : 'No favorito'} · ${p}% de ganar</small></div>
      <div class="ml">${fmtML(ml)}${open != null && open !== ml ? `<small>abrió ${fmtML(open)}</small>` : ''}</div></div>`;
  };
  const ins = [];
  const name = ab => T[ab]?.short || ab;
  for (const [ab, mo, ti] of [[H, m.money_h, m.tickets_h], [A, m.money_a, m.tickets_a]])
    if (mo != null && ti != null && mo - ti >= 10) ins.push(`💰 Dinero fuerte en <b>${name(ab)}</b>: ${mo}% del dinero con solo ${ti}% de las apuestas (apostadores grandes).`);
  for (const [ab, ti] of [[H, m.tickets_h], [A, m.tickets_a]])
    if (ti != null && ti >= 75) ins.push(`👥 El público está muy cargado a <b>${name(ab)}</b> (${ti}% de las apuestas).`);
  if (m.open_h != null && m.open_a != null) {
    const ih = american(m.open_h), ia = american(m.open_a), po = ih / (ih + ia), d = m.p_h - po;
    if (Math.abs(d) >= 0.04) {
      const to = d > 0 ? H : A, pubSide = (m.tickets_h ?? 50) >= (m.tickets_a ?? 50) ? H : A;
      ins.push(`📈 La línea se movió hacia <b>${name(to)}</b> (de ${Math.round((d > 0 ? po : 1 - po) * 100)}% a ${Math.round((d > 0 ? m.p_h : 1 - m.p_h) * 100)}%)` +
        (to !== pubSide ? ' — <b>en contra del público</b>, señal de dinero profesional.' : '.'));
    }
  }
  const v = view(g), mp = v.prob_home, diff = mp - m.p_h;
  if (model !== 'vegas' && Math.abs(diff) >= 0.07) {
    const ab = diff > 0 ? H : A;
    ins.push(`🎯 Nuestro modelo ve a <b>${name(ab)}</b> con ${Math.round((diff > 0 ? mp : 1 - mp) * 100)}% vs ${Math.round((diff > 0 ? m.p_h : 1 - m.p_h) * 100)}% de Vegas.`);
  }
  const r = marketRes(g);
  let res = '';
  if (r) {
    const w = r.homeWon ? g.home : g.away;
    res = `<div class="vg-res"><span class="sbadge ${r.sur.cls}">${r.sur.t}</span> Ganó <b>${esc(w.short || w.name)}</b> ${Math.max(g.hs, g.as)}-${Math.min(g.hs, g.as)}.
      Vegas le daba ${Math.round(r.pw * 100)}% · sorpresa ${r.sur.s}/100.
      ${r.pub != null ? `<br>El público ${r.pub ? 'acertó ✓' : 'falló ✗'}${r.money != null ? ` · el dinero ${r.money ? 'acertó ✓' : 'falló ✗'}` : ''}` : ''}</div>`;
  } else if (g.final) res = `<div class="vg-res">Empate ${g.hs}-${g.as}.</div>`;
  return `<article class="game">
    <div class="ghead"><span>${g.final ? 'Final' : g.state === 'in' ? '<span class="live">● EN VIVO</span>' : when}</span><span>${esc(g.tv || '')}</span></div>
    ${team('away', m.ml_a, m.open_a, pa)}${team('home', m.ml_h, m.open_h, ph)}
    <div class="vg-bars">
      ${vgBar('Probabilidad según Vegas', pa, ph, ac, hc)}
      ${vgBar('% de apuestas (gente)', m.tickets_a, m.tickets_h, ac, hc)}
      ${vgBar('% del dinero', m.money_a, m.money_h, ac, hc)}
    </div>
    ${ins.length ? `<div class="vg-ins">${ins.map(x => `<div>${x}</div>`).join('')}</div>` : ''}
    ${res || '<div style="height:14px"></div>'}
  </article>`;
}
function vgStats(games){
  const rs = games.map(marketRes).filter(Boolean);
  const cnt = (f) => { const x = rs.filter(r => r[f] != null); return [x.filter(r => r[f]).length, x.length]; };
  return {rs, fav: cnt('fav'), pub: cnt('pub'), money: cnt('money')};
}
function renderVegas(){
  const w = D.weeks.find(x => x.key === vgKey);
  const st = vgStats(w.games);
  const big = w.games.filter(g => marketRes(g)).sort((a, b) => marketRes(a).pw - marketRes(b).pw)[0];
  const tile = (v, l, r) => `<div class="tile ${r ? 'r' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('#vgTiles').innerHTML = st.rs.length ? [
    tile(`${st.fav[0]}/${st.fav[1]}`, 'Favoritos de Vegas que ganaron', true),
    tile(`${st.pub[0]}/${st.pub[1]}`, 'El público (más apuestas) acertó'),
    tile(`${st.money[0]}/${st.money[1]}`, 'El dinero (más $) acertó'),
    big ? tile(`${esc(big.hs > big.as ? big.home.abbr : big.away.abbr)} ${Math.round(marketRes(big).pw * 100)}%`, 'Mayor sorpresa de la jornada (prob. que le daba Vegas)') : ''
  ].join('') : '';
  $('#vgAlerts').innerHTML = upsetCard(w);
  $('#vgGames').innerHTML = [...w.games].sort((a, b) => new Date(a.date) - new Date(b.date)).map(vgCard).join('');
  const all = D.weeks.flatMap(x => x.games.map(g => ({g, w: x})));
  const ss = vgStats(all.map(x => x.g));
  const top = all.filter(x => marketRes(x.g)).sort((a, b) => marketRes(a.g).pw - marketRes(b.g).pw).slice(0, 10);
  $('#vgPubMoney').innerHTML = pubMoneyCard();
  $('#vgSeason').innerHTML = `<h3>Temporada: las 10 mayores sorpresas</h3>
    <p style="margin:0 0 10px">Favoritos de Vegas: <b>${ss.fav[0]} de ${ss.fav[1]}</b> (${pct(ss.fav[0], ss.fav[1])}) ·
      El público acertó <b>${pct(ss.pub[0], ss.pub[1])}</b> · El dinero acertó <b>${pct(ss.money[0], ss.money[1])}</b></p>
    <div class="tscroll"><table class="st"><tr><th>Jornada</th><th>Ganador</th><th>Perdedor</th><th>Marcador</th><th>Momio ganador</th><th>Vegas le daba</th><th>Sorpresa</th></tr>
    ${top.map(({g, w}) => { const r = marketRes(g), W = r.homeWon ? g.home : g.away, L = r.homeWon ? g.away : g.home;
      return `<tr><td>${esc(w.label)}</td><td class="tm"><img src="${esc(W.logo)}" alt="">${esc(W.short || W.name)}</td><td>${esc(L.short || L.name)}</td>
        <td>${Math.max(g.hs, g.as)}-${Math.min(g.hs, g.as)}</td><td>${fmtML(r.homeWon ? g.market.ml_h : g.market.ml_a)}</td>
        <td>${Math.round(r.pw * 100)}%</td><td><span class="sbadge ${r.sur.cls}">${r.sur.s}</span></td></tr>`; }).join('')}
    </table></div>`;
}
// ---------- Alerta de sorpresa: no favoritos de Vegas con señales a su favor ----------
function pc(x){ return Math.round(x * 100) + "%"; }
function upsetInfo(g){
  const m = g.market; if (!m) return null;
  const H = g.home.abbr, A = g.away.abbr, dogHome = m.p_h < 0.5;
  const dog = dogHome ? H : A, fav = dogHome ? A : H;
  const dogN = D.teams[dog]?.short || dog, favN = D.teams[fav]?.short || fav;
  const pv = dogHome ? m.p_h : 1 - m.p_h;            // prob. de Vegas para el no favorito
  if (pv < 0.12 || pv > 0.49) return null;           // ni partidos parejos ni batacazos imposibles
  const v = view(g), ms = v.models.filter(x => x.key !== 'vegas');
  const tw = ms.reduce((s, x) => s + x.weight, 0) || 1;
  const pmH = Phi(ms.reduce((s, x) => s + x.weight * x.margin, 0) / tw / SIG);
  const pm = dogHome ? pmH : 1 - pmH;                 // prob. de nuestros modelos (sin Vegas)
  const why = []; let sc = 0;
  // 1) nuestros modelos ven al no favorito mejor que Vegas (hasta 30)
  const val = pm - pv;
  if (val > 0) {
    sc += Math.min(1, val / 0.15) * 30;
    if (val >= 0.04) why.push(`🎯 Nuestros modelos le dan <b>${pc(pm)}</b> de ganar; Vegas solo ${pc(pv)}.`);
  }
  // 2) cuantos de nuestros modelos lo eligen (hasta 22)
  const nDog = ms.filter(x => x.pick === dog).length;
  sc += [0, 5, 12, 18, 22][Math.min(4, nDog)];
  if (nDog) why.push(`🧮 ${nDog} de ${ms.length} modelos lo eligen como ganador.`);
  // 3) dinero profesional: mas % de dinero que de apuestas (hasta 15)
  const tD = dogHome ? m.tickets_h : m.tickets_a, mD = dogHome ? m.money_h : m.money_a;
  if (tD != null && mD != null && mD - tD >= 5) {
    sc += Math.min(1, (mD - tD) / 20) * 15;
    why.push(`💰 Tiene ${mD}% del dinero con solo ${tD}% de las apuestas: apostadores grandes con ${dogN}.`);
  }
  // 4) publico muy cargado al favorito (hasta 8)
  const tF = tD != null ? 100 - tD : null;
  if (tF != null && tF >= 75) {
    sc += tF >= 85 ? 8 : 5;
    why.push(`👥 ${tF}% del público va con ${favN}.`);
  }
  // 5) la linea se movio hacia el no favorito, sobre todo si el publico va con el favorito (hasta 15)
  if (m.open_h != null && m.open_a != null) {
    const ih = american(m.open_h), ia = american(m.open_a), poH = ih / (ih + ia), po = dogHome ? poH : 1 - poH;
    if (pv - po >= 0.03) {
      const contra = tF != null && tF > 50;
      sc += 10 + (contra ? 5 : 0);
      why.push(`📈 La línea se movió hacia ${dogN} (de ${pc(po)} a ${pc(pv)})${contra ? ', <b>aunque el público va con el favorito</b>' : ''}.`);
    }
  }
  // 6) factores situacionales a su favor: descanso, QB del rival, division, viaje (hasta 10)
  if (useAuto) {
    const a = g.pred.adj, net = dogHome ? a.home - a.away : a.away - a.home;
    if (net >= 0.5) {
      sc += Math.min(1, net / 3) * 10;
      const ns = a.notes.filter(n => !/Viento|lluvia|Lluvia|Frio/.test(n)).map(n => n.replace(/:.*$/, ''));
      why.push(`⚙️ Ajustes a su favor (+${fx(net)} pts)${ns.length ? ': ' + ns.join('; ') : ''}.`);
    }
  }
  sc = Math.round(Math.min(100, sc));
  const won = g.final && g.hs !== g.as ? ((g.hs > g.as) === dogHome) : null;
  return {g, dog, fav, dogN, favN, dogHome, pv, pm, est: (pv + pm) / 2, sc, why, won,
    ml: dogHome ? m.ml_h : m.ml_a, level: sc >= 55 ? 'Alta' : sc >= 35 ? 'Media' : 'Baja'};
}
function upsetBadge(u){
  const cls = u.level === 'Alta' ? 's-boom' : u.level === 'Media' ? 's-sur' : 's-sure';
  return `<span class="sbadge ${cls}">🚨 ${u.sc}</span>`;
}
function upsetCard(w){
  const us = w.games.map(upsetInfo).filter(u => u && u.sc >= 35).sort((a, b) => b.sc - a.sc);
  const all = D.weeks.flatMap(x => x.games.map(upsetInfo)).filter(u => u && u.won != null);
  const rec = lvl => { const x = all.filter(u => u.level === lvl); return x.length ? `${x.filter(u => u.won).length} de ${x.length} (${pct(x.filter(u => u.won).length, x.length)}; Vegas esperaba ${pc(x.reduce((s, u) => s + u.pv, 0) / x.length)})` : 'sin casos'; };
  return `<div class="card"><h3>🚨 Alertas de sorpresa</h3>
    <p style="margin:0 0 8px">No favoritos de Vegas con señales a su favor: nuestros modelos, dinero profesional, movimiento de línea y factores del partido. Entre más alto el número (0–100), más señales coinciden.</p>
    ${us.length ? us.map(u => `<div class="ua">
        <div class="ua-h">${upsetBadge(u)}<img src="${esc(D.teams[u.dog]?.logo)}" alt=""><b>${esc(u.dogN)}</b> <span class="ml-s">${fmtML(u.ml)}</span>
          <span class="muted">${u.dogHome ? 'vs' : '@'} ${esc(u.favN)}</span><span class="spacer"></span>
          <span class="muted">Vegas ${pc(u.pv)} · modelos ${pc(u.pm)}</span>
          ${u.won === true ? '<b class="ok">✓ ¡Dio la sorpresa!</b>' : u.won === false ? '<b class="no">✗ Ganó el favorito</b>' : ''}</div>
        <ul>${u.why.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')
      : '<p class="hint">No hay no favoritos con suficientes señales en esta jornada.</p>'}
    <p class="hint">Historial de la temporada: alertas <b>altas</b> (55+) ganaron ${rec('Alta')} · <b>medias</b> (35–54) ganaron ${rec('Media')}.
      Ojo: aun con alerta alta lo normal es que gane el favorito; úsala para decidir en partidos dudosos o para asignarles pocos puntos de confianza, no como apuesta segura.</p></div>`;
}

// ---------- ¿Quien acierta mas: la gente (apuestas) o el dinero? ----------
function pubMoneyCard(){
  const MS = D.market_stats; if (!MS) return '';
  const yrs = Object.keys(MS).sort();
  const tot = {};
  yrs.forEach(y => Object.entries(MS[y]).forEach(([k, v]) => tot[k] = (tot[k] || 0) + v));
  const P = (a, b) => b ? Math.round(100 * a / b) : null;
  const cell = (a, b, best) => b ? `<td class="${best ? 'hi' : ''}">${P(a, b)}% <small style="color:var(--muted)">(${a}/${b})</small></td>` : '<td>—</td>';
  const row = (lab, s, bold) => {
    const pp = P(s.pub, s.pub_n), pm = P(s.money, s.money_n);
    return `<tr${bold ? ' style="font-weight:700"' : ''}><td>${lab}</td><td>${s.n}</td>${cell(s.fav, s.n)}${cell(s.pub, s.pub_n, pp > pm)}${cell(s.money, s.money_n, pm > pp)}
      ${cell(s.dis_money, s.dis_n)}${s.sharp_n ? `<td>${P(s.sharp, s.sharp_n)}% <small style="color:var(--muted)">vs ${P(s.sharp_exp, s.sharp_n)}% esperado</small></td>` : '<td>—</td>'}
      ${s.heavy_n ? `<td>${P(s.heavy, s.heavy_n)}% <small style="color:var(--muted)">vs ${P(s.heavy_exp, s.heavy_n)}% esperado</small></td>` : '<td>—</td>'}</tr>`;
  };
  const pp = P(tot.pub, tot.pub_n), pm = P(tot.money, tot.money_n), dm = P(tot.dis_money, tot.dis_n);
  const sh = P(tot.sharp, tot.sharp_n), she = P(tot.sharp_exp, tot.sharp_n);
  const winner = pp === pm ? 'empatan' : pp > pm ? `<b>gana la gente</b> (las apuestas): ${pp}% contra ${pm}% del dinero` : `<b>gana el dinero</b>: ${pm}% contra ${pp}% de la gente`;
  // grafica acumulada de la temporada actual
  const wk = D.weeks.filter(w => w.games.some(g => marketRes(g)));
  let chart = '';
  if (wk.length) {
    const acc = f => { let c = 0, n = 0; return wk.map(w => { w.games.map(marketRes).filter(r => r && r[f] != null).forEach(r => { n++; c += r[f] ? 1 : 0; }); return n ? 100 * c / n : null; }); };
    const series = [
      {name: 'La gente (más apuestas)', color: '#013369', w: 3, label: true, data: acc('pub')},
      {name: 'El dinero (más $)', color: '#11845b', w: 3, label: true, data: acc('money')},
      {name: 'Favorito de Vegas', color: '#D50A0A', w: 2, dash: '6 4', data: acc('fav')}];
    chart = `<h3 style="margin-top:18px">Temporada ${D.season}: acumulado jornada por jornada</h3>
      ${legend(series.map(s => [s.name, s.color, s.w]))}
      ${lineChart(wk.map(w => w.label.replace('Semana ', 'S')), series, {min: 25, max: 100, refs: [{v: 50, t: 'Volado 50%', c: '#9aa3b2'}]})}`;
  }
  return `<div class="card"><h3>¿Quién acierta más: la gente o el dinero?</h3>
    <p style="margin:0 0 6px">En ${yrs.length} temporadas (${tot.n} partidos) eligiendo siempre al equipo con más apuestas contra el equipo con más dinero, ${winner}.</p>
    <ul style="margin:0 0 10px;padding-left:20px;font-size:14px;line-height:1.6">
      <li><b>Cuando no coinciden</b> (la gente con un equipo y el dinero con el otro) ganó el lado del dinero ${tot.dis_money} de ${tot.dis_n} veces (${dm}%), así que ${dm < 50 ? 'la gente acertó más' : 'el dinero acertó más'}.</li>
      <li>¿Por qué? En moneyline la gente casi siempre va con el <b>favorito</b>, que gana la mayoría de las veces. El dinero grande suele ir al <b>no favorito</b> buscando un pago alto.</li>
      <li><b>Dinero fuerte</b> (10+ puntos más de dinero que de apuestas): ese equipo ganó ${sh}% contra ${she}% que esperaba Vegas. ${sh - she >= 2 ? 'Le gana un poco a lo esperado: sirve como pista para sorpresas, no para elegir ganadores.' : 'Más o menos lo esperado.'}</li>
    </ul>
    <div class="tscroll"><table class="st">
      <tr><th>Temporada</th><th>Partidos</th><th>Favorito Vegas</th><th>La gente</th><th>El dinero</th><th>Dinero cuando no coinciden</th><th>Dinero fuerte</th><th>Público 75%+</th></tr>
      ${yrs.map(y => row(y + (+y === D.season ? ' (en curso)' : ''), MS[y])).join('')}
      ${row('Total', tot, true)}
    </table></div>
    <p class="hint">"La gente" = el equipo con más % de apuestas (boletos). "El dinero" = el equipo con más % del dinero apostado. Datos de consenso de Action Network, momio de cierre.</p>
    ${chart}</div>`;
}

renderVegas();

// ---------- Analisis: por que paso lo que paso y lecciones para la proxima jornada ----------
const anSel = $('#anWeek');
const anWeeks = D.weeks.filter(w => w.games.some(g => g.analysis));
let anKey = (anWeeks.filter(w => w.games.every(g => g.final)).pop() || anWeeks[anWeeks.length - 1] || {}).key;
anSel.innerHTML = anWeeks.map(w => `<option value="${w.key}">${esc(w.label)}</option>`).join('');
if (anKey) anSel.value = anKey;
anSel.onchange = () => { anKey = +anSel.value; renderAnalysis(); };

const VK = {earned: ['Merecida', 's-exp'], luck: ['Con suerte', 's-boom'], coin: ['Moneda al aire', 's-mild'], even: ['Pareja', 's-sure'], tie: ['Empate', 's-sure']};
const tName = ab => D.teams[ab]?.short || ab;
function mmss(s){ return s == null ? '—' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function frac(x){ return x && x[1] ? `${x[0]}/${x[1]}` : '—'; }

// por que fallo (o acerto) nuestro pick
function missReason(g){
  const an = g.analysis, v = view(g);
  if (!an || !v.result || v.result.tie) return null;
  if (v.result.correct) return {ok: true};
  const our = v.pick;
  if (an.vk === 'luck') return {ok: false, cat: 'suerte', t: `${tName(our)} jugó mejor (más yardas) pero perdió: ${an.verdict.split(':')[1] || ''}`};
  if (an.vk === 'coin' || an.vk === 'even') return {ok: false, cat: 'moneda', t: `Partido parejo que se fue para el otro lado (${an.verdict.split(':')[0]}).`};
  return {ok: false, cat: 'error', t: `${tName(an.win)} fue claramente mejor: ${an.factors[0] ? an.factors[0].t : an.verdict}.`};
}

function lessonsHtml(){
  const cur = D.weeks.find(w => w.key === D.current_key);
  const nextOf = ab => { const g = cur && cur.games.find(x => !x.final && (x.home.abbr === ab || x.away.abbr === ab));
    return g ? `Próximo: ${g.home.abbr === ab ? 'vs' : '@'} ${tName(g.home.abbr === ab ? g.away.abbr : g.home.abbr)}` : ''; };
  const items = [];
  Object.entries(D.teams).forEach(([ab, t]) => {
    const L = t.luck; if (!L) return;
    if (L.last) {
      const nx = nextOf(ab);
      if (L.last.type === 'luck_win') items.push({o: 1, h: `⚠️ <b>${tName(ab)}</b> ganó con suerte vs ${tName(L.last.vs)} (${L.last.score}): fue superado en yardas. Ojo, el público y Vegas suelen sobrevalorar al que viene de ganar. ${nx}`});
      if (L.last.type === 'unlucky_loss') items.push({o: 0, h: `💡 <b>${tName(ab)}</b> perdió jugando mejor vs ${tName(L.last.vs)} (${L.last.score}). Puede estar subvalorado esta semana. ${nx}`});
      if (L.last.type === 'blown_out') items.push({o: 2, h: `📉 <b>${tName(ab)}</b> fue dominado de verdad por ${tName(L.last.vs)} (${L.last.score}): su derrota no fue mala suerte. ${nx}`});
    }
    if (L.luck_wins >= 1.5) items.push({o: 3, h: `🍀 <b>${tName(ab)}</b> tiene ${L.wins} victorias pero por puntos merecía ~${L.exp_wins} (cerrados ${L.close}). Su récord es mejor que su juego.`});
    if (L.luck_wins <= -1.5) items.push({o: 4, h: `🔧 <b>${tName(ab)}</b> tiene ${L.wins} victorias pero merecía ~${L.exp_wins} (cerrados ${L.close}). Juega mejor de lo que dice su récord.`});
  });
  items.sort((a, b) => a.o - b.o);
  return `<div class="card"><h3>📚 Lecciones para la próxima jornada</h3>
    ${items.length ? `<ul style="padding-left:20px;line-height:1.7;font-size:14px;margin:0">${items.map(i => `<li>${i.h}</li>`).join('')}</ul>` : '<p class="hint">Sin señales destacadas.</p>'}
    <p class="hint">Cómo se usa: las victorias con suerte (turnovers, zona roja, partidos cerrados) casi no se repiten, mientras que dominar en yardas sí. Por eso el modelo SRS ya mezcla 50% marcador y 50% yardas, que en las temporadas 2024–2025 predijo mejor. Estas notas también aparecen en las tarjetas de Predicciones.</p></div>`;
}

function anCard(g){
  const an = g.analysis; if (!an) return '';
  const H = g.home.abbr, A = g.away.abbr, S = an.stats, [vt, vc] = VK[an.vk] || ['', 's-sure'];
  const mr = missReason(g), mres = marketRes(g);
  const row = (lab, f, better) => { const a = f(S[A]), h = f(S[H]);
    return `<tr><td>${lab}</td><td>${a}</td><td>${h}</td></tr>`; };
  const pctx = x => x && x[1] ? Math.round(100 * x[0] / x[1]) + '%' : '—';
  return `<article class="game">
    <div class="ghead"><span><b>${tName(A)} ${g.as} @ ${tName(H)} ${g.hs}</b></span><span class="sbadge ${vc}">${vt}</span></div>
    <div class="vg-ins" style="margin-top:6px"><b>${esc(an.verdict)}</b></div>
    <table class="mt" style="margin:6px 14px 0;width:calc(100% - 28px)">
      <tr><th></th><th>${A}</th><th>${H}</th></tr>
      ${row('Yardas', x => x.yds ?? '—')}${row('Yardas por jugada', x => x.ypp ?? '—')}${row('Turnovers (perdidos)', x => x.to ?? '—')}
      ${row('3ª oportunidad', x => `${frac(x.third)} (${pctx(x.third)})`)}${row('Zona roja (TD)', x => frac(x.red))}
      ${row('Castigos (yds)', x => x.pen ? x.pen[1] : '—')}${row('Capturas recibidas', x => x.sacked ? x.sacked[0] : '—')}${row('Posesión', x => mmss(x.top))}
    </table>
    ${an.factors.length ? `<div class="vg-ins"><b>Factores clave:</b>${an.factors.map(f => `<div>• ${esc(f.t)}</div>`).join('')}</div>` : ''}
    <div class="vg-res">${mr ? (mr.ok ? `✓ Nuestro pick (${tName(view(g).pick)}) acertó.` : `✗ Fallamos con ${tName(view(g).pick)}: ${esc(mr.t)}`) : ''}
      ${mres ? `<br>Vegas le daba ${Math.round(mres.pw * 100)}% al ganador · <span class="sbadge ${mres.sur.cls}" style="font-size:11px">${mres.sur.t}</span>` : ''}</div>
  </article>`;
}

function luckTable(){
  const rows = Object.entries(D.teams).filter(([, t]) => t.luck).sort((a, b) => b[1].luck.luck_wins - a[1].luck.luck_wins);
  return `<div class="card"><h3>🍀 ¿Quién ha tenido suerte en la temporada?</h3>
    <div class="tscroll"><table class="st"><tr><th>Equipo</th><th>Récord</th><th>Victorias merecidas</th><th>Suerte (+/−)</th><th>Cerrados (≤7)</th><th>Dif. balones</th><th>Margen real/PJ</th><th>Margen por yardas/PJ</th></tr>
    ${rows.map(([ab, t]) => { const L = t.luck;
      return `<tr><td class="tm"><img src="${esc(t.logo)}" alt="">${esc(t.name)}</td><td>${esc(t.record)}</td><td>${fx(L.exp_wins)}</td>
        <td class="${L.luck_wins >= 1 ? 'lo' : L.luck_wins <= -1 ? 'hi' : ''}">${L.luck_wins > 0 ? '+' : ''}${fx(L.luck_wins)}</td><td>${L.close}</td>
        <td>${L.to_margin > 0 ? '+' : ''}${L.to_margin ?? '—'}</td><td>${fx(L.real_pg)}</td><td>${fx(L.perf_pg)}</td></tr>`; }).join('')}
    </table></div>
    <p class="hint"><b>Suerte</b> = victorias reales − victorias que merecía por puntos anotados y permitidos (Pitagórico). Rojo = récord inflado (puede bajar), verde = récord por debajo de su nivel (puede subir). La diferencia de balones y los partidos cerrados tienden a emparejarse con el tiempo.</p></div>`;
}

function renderAnalysis(){
  const w = D.weeks.find(x => x.key === anKey);
  if (!w) { $('#anBody').innerHTML = '<div class="empty">Todavía no hay partidos terminados.</div>'; return; }
  const gs = w.games.filter(g => g.analysis && g.hs !== g.as);
  const toWin = gs.filter(g => { const S = g.analysis.stats, W = S[g.analysis.win], L = S[g.analysis.lose]; return (W.to ?? 0) < (L.to ?? 0); }).length;
  const toDec = gs.filter(g => { const S = g.analysis.stats; return (S[g.analysis.win].to ?? 0) !== (S[g.analysis.lose].to ?? 0); }).length;
  const ydWin = gs.filter(g => { const S = g.analysis.stats; return (S[g.analysis.win].yds ?? 0) > (S[g.analysis.lose].yds ?? 0); }).length;
  const luckN = gs.filter(g => g.analysis.vk === 'luck').length, coinN = gs.filter(g => g.analysis.vk === 'coin').length;
  const ms = gs.map(missReason).filter(Boolean), ok = ms.filter(m => m.ok).length;
  const cat = c => ms.filter(m => m.cat === c).length;
  const tile = (v, l, r) => `<div class="tile ${r ? 'r' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('#anBody').innerHTML = `
    <div class="tiles">
      ${tile(`${ok}/${ms.length}`, 'Aciertos de nuestro modelo', true)}
      ${tile(`${toWin}/${toDec}`, 'Ganó el que cometió menos turnovers')}
      ${tile(`${ydWin}/${gs.length}`, 'Ganó el que tuvo más yardas')}
      ${tile(luckN, 'Victorias con suerte (superado en yardas)')}
      ${tile(coinN, 'Partidos de moneda al aire')}
    </div>
    <div class="card"><h3>¿Por qué fallamos?</h3>
      <p style="margin:0 0 8px">De ${ms.length - ok} fallos: <b>${cat('suerte')}</b> por mala suerte (nuestro equipo jugó mejor), <b>${cat('moneda')}</b> en partidos parejos y <b>${cat('error')}</b> en que el rival fue claramente mejor (ahí el modelo sí se equivocó).</p>
      <ul style="padding-left:20px;line-height:1.6;font-size:13.5px;margin:0">${gs.map(g => ({g, m: missReason(g)})).filter(x => x.m && !x.m.ok)
        .map(({g, m}) => `<li><b>${tName(g.away.abbr)} ${g.as} @ ${tName(g.home.abbr)} ${g.hs}</b>: ${esc(m.t)}</li>`).join('') || '<li>¡Ninguno!</li>'}</ul>
      <p class="hint">Fallar por mala suerte o en partidos parejos es normal y no indica que el modelo esté mal. Si muchos fallos son "el rival fue claramente mejor", conviene revisar ajustes (lesiones, QB, etc.).</p></div>
    ${lessonsHtml()}
    <h3 style="font-family:var(--head);color:var(--navy);margin:20px 0 10px">Partido por partido</h3>
    <div class="grid">${[...w.games].filter(g => g.analysis).sort((a, b) => new Date(a.date) - new Date(b.date)).map(anCard).join('')}</div>
    <div style="margin-top:18px">${luckTable()}</div>`;
}
renderAnalysis();
