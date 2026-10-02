/* GeoMetric Beta — вход: e-mail + 5-значный код, QR-вход, первичная настройка профиля */
'use strict';
let qrState = { sock: null, timer: null, token: null };

function birthdayFields(b) {
  b = b || {}; const months = LANG === 'en' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] : ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const yNow = new Date().getFullYear();
  return `<div style="display:flex;gap:.5rem;max-width:22rem;width:100%" class="bd-fields">
    <div class="field" style="margin:0;flex:1"><select data-bd="d"><option value=""></option>${Array.from({ length: 31 }, (_, i) => `<option ${b.d === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select><label>${t('День')}</label></div>
    <div class="field" style="margin:0;flex:1.6"><select data-bd="m"><option value=""></option>${months.map((m, i) => `<option value="${i + 1}" ${b.m === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select><label>${t('Месяц')}</label></div>
    <div class="field" style="margin:0;flex:1.2"><select data-bd="y"><option value=""></option>${Array.from({ length: yNow - 1900 + 1 }, (_, i) => yNow - i).map(y => `<option ${b.y === y ? 'selected' : ''}>${y}</option>`).join('')}</select><label>${t('Год')}</label></div></div>`;
}
function readBirthday(root) {
  const g = k => $(`[data-bd=${k}]`, root).value; const d = +g('d'), m = +g('m'), y = +g('y');
  if (!d || !m) return null; return { d, m, y: y || null };
}

function showAuth() {
  stopQR(); document.body.classList.remove('chat-open');
  $('#root').innerHTML = `<div id="auth" class="auth"><div class="auth-card"><div class="auth-left" id="auth-step"></div><div class="auth-right" id="auth-qr"></div></div></div>`;
  applyTheme(); stepEmail(); renderQRSide();
}
function stepEmail(prefill = '') {
  const box = $('#auth-step');
  box.innerHTML = `<div class="logo">${LOGO}</div><h1>GeoMetric<span class="beta">BETA</span></h1><p class="sub">${t('Введите свою почту — мы отправим на неё 5-значный код подтверждения.')}</p>
  <div class="field" id="f-email"><input type="email" id="in-email" placeholder=" " autocomplete="email" autofocus value="${esc(prefill)}"><label>${t('Ваш e-mail')}</label><div class="hint bad hidden" id="email-err"></div></div>
  <button class="btn" id="btn-email">${t('Зарегистрироваться / Войти')}</button>
  <button class="auth-link" id="pw-login" style="margin:.7rem 0 0">${t('Войти с паролем')}</button>
  <p class="sub" style="font-size:.8rem;margin:1rem 0 0">${t('Нажимая кнопку, вы соглашаетесь с правилами GeoMetric Beta.')}</p>
  <div style="margin-top:auto;padding-top:1.5rem;display:flex;gap:.8rem;align-items:center;color:var(--text2);font-size:.9rem"><button class="auth-link" style="margin:0" id="lang-sw">${LANG === 'ru' ? 'English' : 'Русский'}</button></div>`;
  const inp = $('#in-email'), btn = $('#btn-email');
  const go = async () => {
    const email = inp.value.trim().toLowerCase(); const er = $('#email-err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#f-email').classList.add('err'); er.textContent = t('Введите корректный e-mail'); er.classList.remove('hidden'); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { const r = await api('POST', '/api/auth/request', { email }, { noAuthRedirect: true }); stepCode(email, r); }
    catch (e) { $('#f-email').classList.add('err'); er.textContent = errText(e); er.classList.remove('hidden'); btn.disabled = false; btn.textContent = t('Зарегистрироваться / Войти'); }
  };
  btn.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); $('#f-email').classList.remove('err'); $('#email-err').classList.add('hidden'); };
  $('#pw-login').onclick = () => stepPassword(inp.value.trim());
  $('#lang-sw').onclick = () => { setCfg({ lang: LANG === 'ru' ? 'en' : 'ru' }, { noSync: true }); LANG = CFG.lang; showAuth(); };
  setTimeout(() => inp.focus(), 100);
}
function stepCode(email, info) {
  const box = $('#auth-step');
  box.innerHTML = `<div class="logo sm">${ic('mail').replace('class="i ', 'style="width:50%;height:50%" class="i ')}</div><h1 style="font-size:1.6rem">${t('Проверьте почту')}</h1>
  <p class="sub">${t('Мы отправили 5-значный код на')} <b style="color:var(--text)">${esc(email)}</b></p>
  ${info.devCode ? `<div class="dev-banner">⚠️ ${t('Почта на сервере ещё не настроена (демо-режим). Ваш код:')} <b>${info.devCode}</b><br><small>${t('Чтобы письма реально уходили, добавьте ключ BREVO_API_KEY или RESEND_API_KEY в настройки Render (см. README).')}</small></div>` : ''}
  <div class="code-inputs" id="codes">${'<input inputmode="numeric" maxlength="1" autocomplete="one-time-code">'.repeat(5)}</div>
  <div id="code-err" class="hint bad" style="color:var(--danger);min-height:1.2rem;margin-bottom:.5rem"></div>
  <button class="btn" id="btn-code" disabled>${t('Подтвердить')}</button>
  <button class="auth-link" id="resend" disabled></button><button class="auth-link" id="back-email" style="margin-top:.4rem;color:var(--text2)">${t('Изменить e-mail')}</button>`;
  const ins = $$('#codes input'); ins[0].focus();
  const val = () => ins.map(i => i.value).join('');
  const submit = async () => {
    const code = val(); if (code.length < 5) return; const b = $('#btn-code'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('POST', '/api/auth/verify', { email, code }, { noAuthRedirect: true });
      S.token = r.token; localStorage.setItem('gm_token', r.token); S.me = r.user; mergeUsers([r.user]);
      if (r.isNew) stepProfile(r.user); else boot();
    } catch (e) {
      $('#codes').classList.add('bad'); $('#code-err').textContent = errText(e); setTimeout(() => $('#codes')?.classList.remove('bad'), 500);
      ins.forEach(i => i.value = ''); ins[0].focus(); b.disabled = true; b.textContent = t('Подтвердить');
    }
  };
  ins.forEach((inp, i) => {
    inp.oninput = () => { inp.value = inp.value.replace(/\D/g, '').slice(-1); if (inp.value && i < 4) ins[i + 1].focus(); $('#btn-code').disabled = val().length < 5; $('#code-err').textContent = ''; if (val().length === 5) submit(); };
    inp.onkeydown = e => { if (e.key === 'Backspace' && !inp.value && i > 0) { ins[i - 1].focus(); ins[i - 1].value = ''; } if (e.key === 'ArrowLeft' && i > 0) ins[i - 1].focus(); if (e.key === 'ArrowRight' && i < 4) ins[i + 1].focus(); if (e.key === 'Enter') submit(); };
    inp.onpaste = e => { e.preventDefault(); const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 5); d.split('').forEach((c, k) => ins[k].value = c); ins[Math.min(d.length, 4)].focus(); $('#btn-code').disabled = d.length < 5; if (d.length === 5) submit(); };
  });
  $('#btn-code').onclick = submit; $('#back-email').onclick = () => stepEmail(email);
  let left = 30; const rs = $('#resend'); const tick = () => { if (!rs.isConnected) return; if (left > 0) { rs.textContent = t('Отправить код повторно через {n} с', { n: left-- }); rs.disabled = true; rs.style.color = 'var(--text2)'; setTimeout(tick, 1000); } else { rs.textContent = t('Отправить код повторно'); rs.disabled = false; rs.style.color = ''; } }; tick();
  rs.onclick = async () => { rs.disabled = true; try { const r = await api('POST', '/api/auth/request', { email }, { noAuthRedirect: true }); toast(t('Код отправлен повторно')); stepCode(email, r); } catch (e) { toast(errText(e)); } };
}
function stepProfile(u) {
  stopQR(); $('#auth-qr').style.display = 'none';
  const box = $('#auth-step'); let avatar = '';
  box.innerHTML = `<h1 style="font-size:1.7rem;margin-top:0">${t('Ваш профиль')}</h1><p class="sub">${t('Добавьте фото и расскажите о себе. Всё это можно изменить позже в настройках.')}</p>
  <div class="av-pick" id="av-pick"><div id="av-prev">${userAv(u, '7rem')}</div><div class="cam">${ic('camera').replace('class="i', 'style="width:2rem;height:2rem" class="i')}</div></div>
  <div style="display:flex;gap:.6rem;width:100%;max-width:22rem"><div class="field" style="margin:0 0 1rem;flex:1"><input id="p-name" placeholder=" " maxlength="40" value="${esc(u.name)}"><label>${t('Имя')}</label></div><div class="field" style="margin:0 0 1rem;flex:1"><input id="p-last" placeholder=" " maxlength="40"><label>${t('Фамилия')}</label></div></div>
  <div class="field"><input id="p-user" placeholder=" " maxlength="32" autocapitalize="off"><label>${t('Имя пользователя (@username)')}</label><div class="hint" id="p-user-h">${t('Необязательно. Люди смогут найти вас по @username')}</div></div>
  <div class="field"><textarea id="p-bio" placeholder=" " maxlength="200" rows="2"></textarea><label>${t('О себе')}</label></div>
  <div style="text-align:left;width:100%;max-width:22rem;color:var(--text2);font-size:.85rem;margin:0 0 .3rem">${t('Дата рождения')} (${t('необязательно')})</div>${birthdayFields()}
  <button class="btn" id="p-save" style="margin-top:1.4rem">${t('Начать общение')}</button>`;
  $('#av-pick').onclick = async () => {
    const [f] = await pickFile('image/*'); if (!f) return; const blob = await cropAvatar(f); if (!blob) return;
    try { const up = await upload(blob, 'avatar.jpg'); avatar = up.url; $('#av-prev').innerHTML = avatarHTML({ name: u.name, avatar, color: u.color }, '7rem'); } catch (e) { toast(errText(e)); }
  };
  bindUsernameCheck($('#p-user'), $('#p-user-h'));
  $('#p-save').onclick = async () => {
    const b = $('#p-save'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const body = { name: $('#p-name').value.trim() || u.name, lastName: $('#p-last').value, bio: $('#p-bio').value, birthday: readBirthday(box) };
      if (avatar) body.avatar = avatar; const un = $('#p-user').value.trim(); if (un) body.username = un;
      const r = await api('PATCH', '/api/me', body); S.me = r.user; boot();
    } catch (e) { toast(errText(e)); b.disabled = false; b.textContent = t('Начать общение'); }
  };
}
function bindUsernameCheck(input, hint, chatId, cur) {
  const chk = debounce(async () => {
    const v = input.value.replace(/^@/, '').trim(); if (!v || v === cur) { hint.className = 'hint'; hint.textContent = ''; input.dataset.ok = '1'; return; }
    if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(v)) { hint.className = 'hint bad'; hint.textContent = t('Имя пользователя: 5–32 символа, a-z, 0-9 и _'); input.dataset.ok = ''; return; }
    try { const r = await api('GET', `/api/username/check?u=${encodeURIComponent(v)}${chatId ? '&chat=' + encodeURIComponent(chatId) : ''}`); hint.className = 'hint ' + (r.ok ? 'good' : 'bad'); hint.textContent = r.ok ? `@${v} ${t('свободно')}` : t('Это имя пользователя занято'); input.dataset.ok = r.ok ? '1' : ''; } catch (e) { }
  }, 350);
  input.addEventListener('input', chk);
}

/* ───────── QR (экран входа на компьютере) ───────── */
function renderQRSide() {
  const box = $('#auth-qr'); if (!box) return;
  box.innerHTML = `<h2 style="margin:.2rem 0 1rem;font-size:1.4rem">${t('Вход по QR-коду')}</h2>
  <div class="qr-box" id="qr-box"><div class="qr-over"><span class="spin"></span></div></div>
  <ol class="steps"><li>${t('Откройте GeoMetric на телефоне, где вы уже вошли')}</li><li>${t('Перейдите в <b>Настройки → Устройства</b>').replace(/<\/?b>/g, '')}</li><li>${t('Нажмите «Подключить устройство» и наведите камеру на этот код')}</li></ol>`;
  startQR();
}
function startQR() {
  stopQR();
  const sock = qrState.sock = io({ transports: ['websocket', 'polling'] });
  const make = () => sock.emit('qr:create', r => { if (!r) return; qrState.token = r.token; drawQR(`${location.origin}/?qr=${r.token}`); });
  sock.on('connect', () => { make(); clearInterval(qrState.timer); qrState.timer = setInterval(make, 28000); });
  sock.on('qr:scanned', d => {
    const b = $('#qr-box'); if (!b) return; clearInterval(qrState.timer);
    b.innerHTML = `<div class="qr-over">${userAv(d.user, '4.5rem')}<div><b>${esc(d.user.name)}</b></div><div style="font-size:.85rem;color:#555">${t('Подтвердите вход на телефоне')}</div><span class="spin" style="color:#3390ec"></span></div>`;
  });
  sock.on('qr:rejected', () => { toast(t('Вход отклонён')); startQR(); });
  sock.on('qr:approved', async d => { S.token = d.token; localStorage.setItem('gm_token', d.token); S.me = d.user; stopQR(); boot(); });
}
function stopQR() { clearInterval(qrState.timer); if (qrState.sock) { qrState.sock.disconnect(); qrState.sock = null; } }
function drawQR(text) {
  const box = $('#qr-box'); if (!box) return;
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(); let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) {
    // скруглённые «пиксели», кроме маркеров позиционирования
    path += `M${c},${r}h1v1h-1z`;
  }
  box.innerHTML = `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/><path d="${path}" fill="#111"/></svg><div class="qr-logo">${LOGO}</div>`;
}

/* ───────── подтверждение входа на телефоне (по ссылке ?qr=TOKEN) ───────── */
async function handleQRLink(token) {
  try {
    const r = await api('POST', '/api/qr/scan', { token });
    const m = modal({ title: t('Войти на новом устройстве?'), cls: '', closeBtn: false, dismiss: false, body: `<div style="text-align:center;padding:.5rem 0"><div class="logo sm" style="margin:0 auto 1rem">${ic('monitor').replace('class="i', 'style="width:50%;height:50%" class="i')}</div><div style="font-size:1.1rem;font-weight:600">${esc(r.device)}</div><div style="color:var(--text2);font-size:.9rem;margin-top:.2rem">IP: ${esc(r.ip || '—')}</div><p style="color:var(--text2);font-size:.9rem;margin-top:1rem">${t('Подтверждайте, только если вы сами открыли GeoMetric на этом устройстве.')}</p></div>`,
      buttons: [{ label: t('Отклонить'), cls: 'danger', onClick: async () => { await api('POST', '/api/qr/approve', { token, ok: false }).catch(() => { }); } }, { label: t('Подтвердить вход'), onClick: async () => { try { await api('POST', '/api/qr/approve', { token, ok: true }); toast(t('Устройство подключено')); if (window.refreshSessions) refreshSessions(); } catch (e) { toast(errText(e)); } } }] });
  } catch (e) { toast(errText(e)); }
}
function openQRScanner() {
  let stream, stop = false, raf;
  const body = el(`<div><p style="color:var(--text2);margin:0">${t('Наведите камеру на QR-код на экране компьютера.')}</p><div class="scanner"><video playsinline muted></video><div class="frame"></div><div class="line"></div></div><div class="field" style="max-width:none;margin:.5rem 0 0"><input id="qr-manual" placeholder=" "><label>${t('Или вставьте ссылку с QR-кода')}</label></div></div>`);
  const m = modal({ title: t('Подключить устройство'), body, onClose: () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(tr => tr.stop()); }, buttons: [{ label: t('Войти'), onClick: () => { const tk = parseQR($('#qr-manual', body).value); if (!tk) { toast(t('Некорректная ссылка')); return false; } setTimeout(() => handleQRLink(tk), 100); } }] });
  const parseQR = s => { try { return new URL(s).searchParams.get('qr'); } catch (e) { return /^[a-f0-9]{40}$/.test(s.trim()) ? s.trim() : null; } };
  const found = txt => { const pm = /\/u\/([A-Za-z]\w{4,31})\/?$/.exec(String(txt).split('?')[0]); if (pm && !stop) { stop = true; m.close(); resolveUsername(pm[1]); return; } const tk = parseQR(txt); if (!tk || stop) return; stop = true; m.close(); handleQRLink(tk); };
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const v = $('video', body); v.srcObject = stream; await v.play();
      const det = window.BarcodeDetector ? new BarcodeDetector({ formats: ['qr_code'] }) : null; const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      const loop = async () => {
        if (stop) return;
        if (v.videoWidth) {
          try {
            if (det) { const r = await det.detect(v); if (r[0]) return found(r[0].rawValue); }
            else { cv.width = v.videoWidth; cv.height = v.videoHeight; cx.drawImage(v, 0, 0); const d = cx.getImageData(0, 0, cv.width, cv.height); const c = jsQR(d.data, d.width, d.height); if (c) return found(c.data); }
          } catch (e) { }
        }
        raf = requestAnimationFrame(loop);
      }; loop();
    } catch (e) { $('.scanner', body).innerHTML = `<div style="color:#fff;padding:2rem;text-align:center">${t('Нет доступа к камере. Вставьте ссылку ниже или откройте QR камерой телефона.')}</div>`; }
  })();
}
