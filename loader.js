// Carga la app. Si los datos vienen cifrados (window.NFL_ENC), pide la contraseña y los descifra en el navegador.
(function () {
  // app instalable (PWA): service worker + boton "Instalar app"
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    window.__installEvt = e;
    const b = document.getElementById('installBtn');
    if (b) b.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    const b = document.getElementById('installBtn');
    if (b) b.hidden = true;
  });

  // los datos se piden con ?t= para no recibir una version vieja guardada en cache
  const ds = document.createElement('script');
  ds.src = 'data/nfl_data.js?t=' + Date.now();
  ds.onload = ds.onerror = init;
  document.body.appendChild(ds);

  function init() {
  function startApp() {
    const s = document.createElement('script');
    s.src = 'app.js?v=' + encodeURIComponent((window.NFL_DATA && window.NFL_DATA.generated) || '');
    document.body.appendChild(s);
  }
  const ENC = window.NFL_ENC;
  if (!ENC || window.NFL_DATA) return startApp();

  const KEY = 'nfl_pass';
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decrypt(pass) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({name: 'PBKDF2', salt: b64(ENC.salt), iterations: ENC.iter, hash: 'SHA-256'},
      base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: b64(ENC.iv)}, key, b64(ENC.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function tryPass(pass, remember) {
    try {
      window.NFL_DATA = await decrypt(pass);
    } catch (e) {
      return false;
    }
    try { remember ? localStorage.setItem(KEY, pass) : sessionStorage.setItem(KEY, pass); } catch (e) {}
    document.getElementById('lock')?.remove();
    startApp();
    return true;
  }

  function showLock() {
    const box = document.createElement('div');
    box.id = 'lock';
    box.innerHTML = `
      <form class="lock-card">
        <svg viewBox="0 0 54 62" width="54" height="62" aria-hidden="true"><path d="M27 2 L52 8 V30 C52 46 40 56 27 60 C14 56 2 46 2 30 V8 Z" fill="#fff"/><path d="M27 6 L48 11 V30 C48 43 38 52 27 56 C16 52 6 43 6 30 V11 Z" fill="#013369"/><path d="M6 18 H48 V24 H6 Z" fill="#D50A0A"/><rect x="19" y="32" width="16" height="13" rx="2" fill="#fff"/><path d="M22 32 V28 a5 5 0 0 1 10 0 V32" stroke="#fff" stroke-width="2.5" fill="none"/></svg>
        <h2>NFL <span>PREDICTOR</span></h2>
        <p>Acceso privado. Escribe la contraseña.</p>
        <input type="password" id="lockPass" placeholder="Contraseña" autocomplete="current-password" autofocus>
        <label class="lock-rem"><input type="checkbox" id="lockRem" checked> Recordarme en este dispositivo</label>
        <button type="submit">Entrar</button>
        <div class="lock-err" id="lockErr"></div>
      </form>`;
    document.body.appendChild(box);
    box.querySelector('form').onsubmit = async ev => {
      ev.preventDefault();
      const btn = box.querySelector('button');
      btn.disabled = true; btn.textContent = 'Verificando...';
      const ok = await tryPass(document.getElementById('lockPass').value, document.getElementById('lockRem').checked);
      if (!ok) {
        document.getElementById('lockErr').textContent = 'Contraseña incorrecta';
        btn.disabled = false; btn.textContent = 'Entrar';
        document.getElementById('lockPass').select();
      }
    };
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch (e) {}
  if (saved) {
    tryPass(saved, true).then(ok => {
      if (!ok) { try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {} showLock(); }
    });
  } else showLock();
  }
})();
