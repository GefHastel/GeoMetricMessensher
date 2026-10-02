/* GeoMetric Beta — QR/ссылки профиля, боты, жалобы, устройства, пароль, консоль владельца */
'use strict';

/* ───────── недостающие иконки (lucide) ───────── */
Object.assign(window.ICONS, {
  'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  'upload': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  'bot': '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  'headphones': '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  'list': '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  'link': ICONS['link'] || '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
});

/* ───────── английские переводы новых строк ───────── */
Object.assign(window.EN, {
  'Аккаунт заблокирован': 'Account banned', 'Пароль: минимум 6 символов': 'Password: at least 6 characters', 'Неверная почта или пароль': 'Wrong e-mail or password', 'Некорректный архив': 'Invalid archive', 'Не найдено': 'Not found',
  'Подтверждённый аккаунт': 'Verified account', 'Модератор GeoMetric': 'GeoMetric moderator', 'Подтверждённый канал': 'Verified channel',
  'QR-код и ссылка': 'QR code & link', 'QR-код профиля': 'Profile QR code', 'QR-код': 'QR code', 'Скопировать ссылку': 'Copy link', 'Поделиться': 'Share', 'Скачать PNG': 'Download PNG', 'Ссылка скопирована': 'Link copied',
  'Наведите камеру на QR-код — откроется профиль или чат.': 'Point the camera at a QR code — the profile or chat will open.',
  'Пожаловаться': 'Report', 'Жалоба отправлена модераторам': 'Report sent to moderators', 'Причина': 'Reason', 'Спам': 'Spam', 'Оскорбления': 'Abuse', 'Насилие': 'Violence', 'Мошенничество': 'Fraud', 'Неприемлемый контент': 'Inappropriate content', 'Другое': 'Other', 'Комментарий (необязательно)': 'Comment (optional)', 'Отправить': 'Send',
  'Запустить': 'Start', 'бот': 'bot', 'Меню': 'Menu', 'Команды бота': 'Bot commands',
  'Звук и видео': 'Sound & video', 'Микрофон': 'Microphone', 'Камера': 'Camera', 'Динамики': 'Speakers', 'По умолчанию': 'Default', 'Не найдено устройств': 'No devices found', 'Разрешить доступ к микрофону и камере': 'Allow microphone and camera access',
  'Уровень микрофона': 'Microphone level', 'Проверить динамики': 'Test speakers', 'Эхоподавление': 'Echo cancellation', 'Шумоподавление': 'Noise suppression', 'Автоусиление микрофона': 'Auto gain control', 'Камера выключена или недоступна': 'Camera is off or unavailable',
  'Выбор динамиков не поддерживается этим браузером': 'Speaker selection is not supported by this browser', 'Микрофон, камера и динамики для звонков, голосовых и кружков': 'Microphone, camera and speakers for calls, voice notes and circles', 'Нет доступа к устройствам': 'No access to devices',
  'Пароль': 'Password', 'Пароль для входа': 'Sign-in password', 'Не задан': 'Not set', 'Задан': 'Set', 'Новый пароль': 'New password', 'Повторите пароль': 'Repeat password', 'Текущий пароль': 'Current password', 'Пароли не совпадают': 'Passwords do not match', 'Пароль сохранён': 'Password saved', 'Пароль удалён': 'Password removed', 'Сохранить пароль': 'Save password', 'Удалить пароль': 'Remove password', 'Сменить пароль': 'Change password',
  'Пароль — дополнительный способ входа: e-mail + пароль, без ожидания письма. Код из почты по-прежнему работает, и забытый пароль всегда можно заменить, войдя по коду.': 'A password is an extra way to sign in: e-mail + password, no waiting for an email. The e-mail code still works, and a forgotten password can always be replaced by signing in with a code.',
  'Войти с паролем': 'Sign in with password', 'Войти': 'Sign in', 'Забыли пароль? Войти по коду': 'Forgot password? Sign in with a code', 'Вход по паролю': 'Password sign-in', 'Назад': 'Back',
  'Консоль владельца': 'Owner console', 'Выполнить': 'Run', 'Команда (help — список)': 'Command (help for the list)', 'Скачать ZIP': 'Download ZIP', 'Импорт ZIP': 'Import ZIP', 'Архив сохранён': 'Archive saved', 'Данные импортированы. Перезагрузка…': 'Data imported. Reloading…',
  'Архив со всеми пользователями, чатами и файлами.': 'Archive with all users, chats and files.', 'Импорт ЗАМЕНИТ все данные на сервере данными из архива. Продолжить?': 'Import will REPLACE all server data with the archive contents. Continue?',
  'Консоль подключена к серверу. Введите help.': 'Console connected. Type help.',
  'Данные': 'Data', 'Бот': 'Bot', 'Ссылка на профиль': 'Profile link', 'Сканировать QR-код': 'Scan QR code', 'Профили, чаты и вход на устройстве': 'Profiles, chats and device sign-in', 'Скачать архив': 'Download archive', 'Подключить устройство': 'Connect device', 'Подтвердите': 'Confirm', 'Профиль пользователя': 'User profile', 'Имя пользователя не найдено': 'User not found',
});
const L_ = (...a) => a;

/* ───────── ссылки профиля и QR ───────── */
const userLink = u => u.username ? `${location.origin}/u/${u.username}` : `${location.origin}/?uid=${u.id}`;
const chatLink = c => c.username ? `${location.origin}/u/${c.username}` : (c.invite ? `${location.origin}/?invite=${c.invite}` : '');

function qrSvg(text, { fg = '#12151c', bg = '#fff', round = false } = {}) {
  const q = qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount();
  const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  let dots = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.isDark(r, c) || (round && inFinder(r, c))) continue;
    dots += round ? `<circle cx="${c + .5}" cy="${r + .5}" r=".47"/>` : `M${c},${r}h1v1h-1z`;
  }
  let fnd = '';
  if (round) for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) fnd += `<rect x="${fx + .5}" y="${fy + .5}" width="6" height="6" rx="1.7" fill="none" stroke="${fg}" stroke-width="1"/><rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx=".9" fill="${fg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n + 4}" height="${n + 4}" viewBox="-2 -2 ${n + 4} ${n + 4}"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="${bg}"/>${round ? `<g fill="${fg}">${dots}</g>` : `<path fill="${fg}" shape-rendering="crispEdges" d="${dots}"/>`}${fnd}</svg>`;
}
function svgToPng(svg, size = 1024) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(img, 0, 0, size, size); URL.revokeObjectURL(url); c.toBlob(b => b ? res(b) : rej(), 'image/png'); };
    img.onerror = rej; img.src = url;
  });
}
function showQR({ title, name, sub, link, av }) {
  const svg = qrSvg(link);
  const body = el(`<div class="qr-card"><div class="qc-top">${av || ''}<div class="qc-nm">${esc(name)}</div>${sub ? `<div class="qc-sub">${esc(sub)}</div>` : ''}</div><div class="qc-qr">${svg}<div class="qc-logo">${LOGO}</div></div><div class="qc-link">${esc(link.replace(/^https?:\/\//, ''))}</div></div>`);
  const m = modal({
    title: title || t('QR-код'), body, cls: 'qr-modal', buttons: [
      { label: t('Скопировать ссылку'), onClick: () => { copyText(link); return false; } },
      { label: t('Скачать PNG'), onClick: async () => { try { const b = await svgToPng(qrSvg(link), 1024); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'geometric-qr.png'; a.click(); } catch (e) { toast(t('Что-то пошло не так')); } return false; } },
      navigator.share ? { label: t('Поделиться'), onClick: () => { navigator.share({ title: name, url: link }).catch(() => { }); return false; } } : null,
    ].filter(Boolean)
  });
  return m;
}
const showUserQR = u => showQR({ title: t('QR-код профиля'), name: fullName(u), sub: u.username ? '@' + u.username : '', link: userLink(u), av: userAv(u, '4.5rem') });
const showChatQR = c => { const link = chatLink(c); if (!link) return toast(t('Что-то пошло не так')); showQR({ title: t('QR-код'), name: c.title, sub: c.username ? '@' + c.username : '', link, av: chatAv(c, '4.5rem') }); };

/* ───────── боты: приветствие, inline-кнопки, команды ───────── */
function botIntroHTML(c) {
  const u = U(c.peer) || {};
  return `<div class="bot-intro">${userAv(u, '5.5rem')}<div class="bi-nm">${esc(fullName(u))}${verifiedBadge(u)}</div><div class="bi-sub">${t('бот')}${u.username ? ' · @' + esc(u.username) : ''}</div>${u.botDesc ? `<div class="bi-desc">${fmt(u.botDesc)}</div>` : ''}<button class="btn" id="bot-start">${t('Запустить')}</button></div>`;
}
document.addEventListener('click', e => {
  if (e.target.closest('#bot-start') && S.active) api('POST', `/api/chats/${encodeURIComponent(S.active)}/messages`, { text: '/start' }).catch(er => toast(errText(er)));
});
async function kbClick(id, btn) {
  const m = findMsgLocal(id); if (!m || !m.markup) return; const [ri, bi] = btn.dataset.kb.split(':').map(Number); const b = (m.markup[ri] || [])[bi]; if (!b) return;
  if (b.url) { window.open(b.url, '_blank', 'noopener,noreferrer'); return; }
  btn.classList.add('busy');
  try { await api('POST', `/api/messages/${id}/callback`, { data: b.data }); } catch (e) { toast(errText(e)); } finally { btn.classList.remove('busy'); }
}
function peerBot() { const c = S.chats[S.active]; const u = c && c.type === 'private' ? U(c.peer) : null; return u && u.bot ? u : null; }
function closeCmdPop() { $('#cmd-pop')?.remove(); }
function showCmdPop(filter) {
  closeCmdPop(); const b = peerBot(); if (!b || !(b.commands || []).length) return;
  const list = b.commands.filter(c => !filter || c.cmd.startsWith(filter)); if (!list.length) return;
  const p = el(`<div class="cmd-pop" id="cmd-pop">${list.map(c => `<button data-c="${esc(c.cmd)}"><b>/${esc(c.cmd)}</b><span>${esc(c.desc || '')}</span></button>`).join('')}</div>`);
  $$('button', p).forEach(bt => bt.onmousedown = ev => { ev.preventDefault(); const inp = $('#inp'); inp.value = '/' + bt.dataset.c; closeCmdPop(); $('#send-btn')?.click(); });
  $('#comp-wrap').appendChild(p);
}
document.addEventListener('input', e => {
  if (e.target.id !== 'inp') return; const v = e.target.value;
  if (/^\/[a-z0-9_]*$/i.test(v) && peerBot()) showCmdPop(v.slice(1).toLowerCase()); else closeCmdPop();
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#cmd-pop') && !e.target.closest('.bot-menu')) closeCmdPop(); });
function botComposerExtras() {
  const b = peerBot(), row_ = $('#comp-row'); if (!row_ || $('.bot-menu', row_)) return;
  if (!b || !(b.commands || []).length) return;
  const bt = el(`<button class="btn-icon bot-menu" title="${t('Команды бота')}">${ic('list')}</button>`); bt.onclick = () => { if ($('#cmd-pop')) closeCmdPop(); else showCmdPop(''); };
  row_.insertBefore(bt, row_.firstChild);
}
{ const _rc = renderComposer; renderComposer = function () { _rc.apply(this, arguments); closeCmdPop(); botComposerExtras(); }; }

/* ───────── жалобы ───────── */
function reportDialog(target) {
  const reasons = [['spam', t('Спам')], ['abuse', t('Оскорбления')], ['violence', t('Насилие')], ['fraud', t('Мошенничество')], ['porn', t('Неприемлемый контент')], ['other', t('Другое')]];
  const body = el(`<div>${reasons.map(([k, l], i) => `<label class="check"><input type="radio" name="rr" value="${k}" ${i === 0 ? 'checked' : ''} style="display:none"><span class="box round">${ic('check')}</span><span>${l}</span></label>`).join('')}<div class="field" style="max-width:none;margin:.6rem 0 0"><textarea id="rr-t" placeholder=" " rows="2" maxlength="500"></textarea><label>${t('Комментарий (необязательно)')}</label></div></div>`);
  const sync = () => $$('.box', body).forEach(b => { const on = $('input', b.parentNode).checked; b.style.cssText = on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''; });
  $$('input[name=rr]', body).forEach(i => i.onchange = sync); sync();
  modal({
    title: t('Пожаловаться'), body, buttons: [{ label: t('Отмена') }, {
      label: t('Отправить'), cls: 'danger', onClick: async () => {
        try { await api('POST', '/api/reports', { ...target, reason: $('input[name=rr]:checked', body).value, text: $('#rr-t', body).value }); toast(t('Жалоба отправлена модераторам')); } catch (e) { toast(errText(e)); return false; }
      }
    }]
  });
}

/* ───────── звук и видео ───────── */
function openAV() {
  let stream = null, raf = 0, actx_ = null, sinkAudio = null;
  const stop = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(tr => tr.stop()); stream = null; try { actx_?.close(); } catch (e) { } actx_ = null; };
  pushPanel(t('Звук и видео'), (body, pn) => {
    if (pn.inited) return; pn.inited = true; body.innerHTML = '';
    const mk = (label, id) => `<div class="field sel" style="max-width:none;margin:.2rem 0 .8rem"><select id="${id}"></select><label>${label}</label></div>`;
    body.innerHTML = `<div class="av-note">${t('Микрофон, камера и динамики для звонков, голосовых и кружков')}</div>
    <div class="sec"><div class="sec-title">${t('Камера')}</div><div style="padding:0 1.1rem 1rem"><div class="av-prev"><video id="av-v" autoplay muted playsinline></video><div class="av-off" id="av-off">${ic('video-off')}<span>${t('Камера выключена или недоступна')}</span></div></div>${mk(t('Камера'), 'av-cam')}</div></div>
    <div class="sec"><div class="sec-title">${t('Микрофон')}</div><div style="padding:0 1.1rem 1rem">${mk(t('Микрофон'), 'av-mic')}<div class="meter-lbl">${t('Уровень микрофона')}</div><div class="meter"><i id="av-lvl"></i></div></div></div>
    <div class="sec"><div class="sec-title">${t('Динамики')}</div><div style="padding:0 1.1rem 1rem" id="av-spk-box">${mk(t('Динамики'), 'av-spk')}<button class="btn flat" id="av-test" style="margin-top:-.2rem">${ic('volume-2')} ${t('Проверить динамики')}</button></div></div>
    <div class="sec" id="av-sw"></div><div style="padding:0 1.1rem 1rem" id="av-perm"></div>`;
    const sw = $('#av-sw', body);
    sw.appendChild(switchRow(t('Эхоподавление'), CFG.echo !== false, v => { setCfg({ echo: v }); start(); }));
    sw.appendChild(switchRow(t('Шумоподавление'), CFG.noise !== false, v => { setCfg({ noise: v }); start(); }));
    sw.appendChild(switchRow(t('Автоусиление микрофона'), CFG.agc !== false, v => { setCfg({ agc: v }); start(); }));
    const fill = (sel, devs, cur, kind) => {
      sel.innerHTML = `<option value="">${t('По умолчанию')}</option>` + devs.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || `${kind} ${i + 1}`)}</option>`).join('');
      if (cur && !devs.some(d => d.deviceId === cur)) sel.value = '';
    };
    const enumerate = async () => {
      let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { }
      fill($('#av-cam', body), devs.filter(d => d.kind === 'videoinput'), CFG.camId, 'Camera');
      fill($('#av-mic', body), devs.filter(d => d.kind === 'audioinput'), CFG.micId, 'Microphone');
      fill($('#av-spk', body), devs.filter(d => d.kind === 'audiooutput'), CFG.spkId, 'Speaker');
      const noLabels = devs.length && devs.every(d => !d.label); const pm = $('#av-perm', body);
      pm.innerHTML = noLabels ? `<button class="btn" id="av-allow">${t('Разрешить доступ к микрофону и камере')}</button>` : '';
      if (noLabels) $('#av-allow', body).onclick = () => start();
    };
    if (!(HTMLMediaElement.prototype.setSinkId)) $('#av-spk-box', body).innerHTML = `<div style="color:var(--text2);font-size:.9rem">${t('Выбор динамиков не поддерживается этим браузером')}</div>`;
    const meter = () => {
      if (!stream || !stream.getAudioTracks().length) return;
      try {
        actx_ = new (window.AudioContext || window.webkitAudioContext)(); const src = actx_.createMediaStreamSource(new MediaStream(stream.getAudioTracks())); const an = actx_.createAnalyser(); an.fftSize = 512; src.connect(an);
        const buf = new Uint8Array(an.fftSize); const bar = $('#av-lvl', body); let sm = 0;
        const loop = () => { if (!bar.isConnected) return; an.getByteTimeDomainData(buf); let mx = 0; for (const v of buf) mx = Math.max(mx, Math.abs(v - 128)); sm = Math.max(mx / 128, sm * .85); bar.style.width = Math.min(100, sm * 140) + '%'; raf = requestAnimationFrame(loop); };
        loop();
      } catch (e) { }
    };
    const start = async () => {
      stop(); const v = $('#av-v', body), off = $('#av-off', body);
      const tryGet = async c => { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { return null; } };
      stream = await tryGet({ audio: audioC(), video: videoC({ width: { ideal: 640 } }) }) || await tryGet({ audio: audioC() }) || await tryGet({ video: videoC() });
      if (!pn.el.isConnected) { stop(); return; }
      if (!stream) toast(t('Нет доступа к устройствам'));
      v.srcObject = stream && stream.getVideoTracks().length ? stream : null; off.style.display = v.srcObject ? 'none' : 'flex'; if (v.srcObject) v.play().catch(() => { });
      meter(); enumerate();
    };
    $('#av-cam', body).onchange = e => { setCfg({ camId: e.target.value }); start(); };
    $('#av-mic', body).onchange = e => { setCfg({ micId: e.target.value }); start(); };
    $('#av-spk', body).onchange = e => { setCfg({ spkId: e.target.value }); };
    $('#av-test', body)?.addEventListener('click', async () => {
      try {
        const c = new (window.AudioContext || window.webkitAudioContext)(); const dst = c.createMediaStreamDestination(); let t0 = c.currentTime;
        [523, 659, 784, 1047].forEach(f => { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.25, t0 + .02); g.gain.exponentialRampToValueAtTime(.0001, t0 + .28); o.connect(g).connect(dst); o.start(t0); o.stop(t0 + .3); t0 += .22; });
        sinkAudio = sinkAudio || new Audio(); sinkAudio.srcObject = dst.stream; applySink(sinkAudio); await sinkAudio.play(); setTimeout(() => c.close(), 1500);
      } catch (e) { toast(t('Нет доступа к устройствам')); }
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', enumerate);
    enumerate(); start();
  }, { static: true, onClose: stop });
}

/* ───────── пароль ───────── */
function openPassword() {
  pushPanel(t('Пароль'), (body, pn) => {
    const me = S.me; body.innerHTML = '';
    const f = (id, label) => `<div class="field" style="max-width:none;margin:.2rem 0 .7rem"><input id="${id}" type="password" placeholder=" " autocomplete="${id === 'pw-cur' ? 'current-password' : 'new-password'}"><label>${label}</label></div>`;
    const box = el(`<div style="padding:1rem 1.1rem 1.5rem"><p style="margin:0 0 1rem;color:var(--text2);font-size:.92rem;line-height:1.4">${t('Пароль — дополнительный способ входа: e-mail + пароль, без ожидания письма. Код из почты по-прежнему работает, и забытый пароль всегда можно заменить, войдя по коду.')}</p>${me.hasPassword ? f('pw-cur', t('Текущий пароль')) : ''}${f('pw-new', t('Новый пароль'))}${f('pw-rep', t('Повторите пароль'))}<button class="btn" id="pw-save" style="width:100%">${me.hasPassword ? t('Сменить пароль') : t('Сохранить пароль')}</button>${me.hasPassword ? `<button class="btn flat danger" id="pw-del" style="width:100%;margin-top:.6rem">${t('Удалить пароль')}</button>` : ''}</div>`);
    body.appendChild(box);
    const done = async msg => { try { const r = await api('GET', '/api/me'); S.me = r.user; S.users[S.me.id] = S.me; } catch (e) { } toast(msg); closeTopPanel(); refreshPanels(); };
    $('#pw-save', box).onclick = async () => {
      const a = $('#pw-new', box).value, b = $('#pw-rep', box).value;
      if (a.length < 6) return toast(errText({ error: 'weak_password' })); if (a !== b) return toast(t('Пароли не совпадают'));
      try { await api('PUT', '/api/me/password', { password: a, current: $('#pw-cur', box)?.value || '' }); done(t('Пароль сохранён')); } catch (e) { toast(errText(e)); }
    };
    $('#pw-del', box)?.addEventListener('click', async () => { try { await api('DELETE', '/api/me/password', { current: $('#pw-cur', box).value }); done(t('Пароль удалён')); } catch (e) { toast(errText(e)); } });
  });
}
function stepPassword(prefill = '') {
  const box = $('#auth-step');
  box.innerHTML = `<div class="logo sm">${ic('key-round').replace('class="i ', 'style="width:50%;height:50%" class="i ')}</div><h1 style="font-size:1.6rem">${t('Вход по паролю')}</h1>
  <div class="field" id="pf-email"><input type="email" id="pw-email" placeholder=" " autocomplete="email" value="${esc(prefill)}"><label>${t('Ваш e-mail')}</label></div>
  <div class="field" id="pf-pw"><input type="password" id="pw-pw" placeholder=" " autocomplete="current-password"><label>${t('Пароль')}</label><div class="hint bad hidden" id="pw-err"></div></div>
  <button class="btn" id="pw-go">${t('Войти')}</button><button class="auth-link" id="pw-forgot">${t('Забыли пароль? Войти по коду')}</button><button class="auth-link" id="pw-back" style="color:var(--text2);margin-top:.2rem">${t('Назад')}</button>`;
  const go = async () => {
    const email = $('#pw-email').value.trim().toLowerCase(), password = $('#pw-pw').value; const b = $('#pw-go'), er = $('#pw-err');
    if (!email || !password) return; b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try { const r = await api('POST', '/api/auth/login', { email, password, device: '' }, { noAuthRedirect: true }); S.token = r.token; localStorage.setItem('gm_token', r.token); S.me = r.user; mergeUsers([r.user]); boot(); }
    catch (e) { $('#pf-pw').classList.add('err'); er.textContent = errText(e); er.classList.remove('hidden'); b.disabled = false; b.textContent = t('Войти'); }
  };
  $('#pw-go').onclick = go; $('#pw-pw').onkeydown = e => { if (e.key === 'Enter') go(); $('#pf-pw').classList.remove('err'); $('#pw-err').classList.add('hidden'); };
  $('#pw-back').onclick = () => stepEmail($('#pw-email').value);
  $('#pw-forgot').onclick = () => { const v = $('#pw-email').value; stepEmail(v); if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())) $('#btn-email').click(); };
  setTimeout(() => ($('#pw-email').value ? $('#pw-pw') : $('#pw-email')).focus(), 80);
}

/* ───────── консоль владельца ───────── */
function openConsole() {
  pushPanel(t('Консоль владельца'), (body, pn) => {
    if (pn.inited) return; pn.inited = true; body.innerHTML = '';
    const hist = []; let hi = 0;
    const wrap = el(`<div class="con"><div class="con-btns"><button class="btn flat" id="cn-exp">${ic('download')} ${t('Скачать ZIP')}</button><button class="btn flat" id="cn-imp">${ic('upload')} ${t('Импорт ZIP')}</button></div><div class="con-out" id="cn-out"></div><div class="con-in"><span>geo&gt;</span><input id="cn-in" placeholder="${t('Команда (help — список)')}" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn-icon" id="cn-go">${ic('send')}</button></div></div>`);
    body.appendChild(wrap); const out = $('#cn-out', wrap), inp = $('#cn-in', wrap);
    const print = (txt, cls = '') => { const d = document.createElement('div'); d.className = 'ln ' + cls; d.textContent = txt; out.appendChild(d); out.scrollTop = out.scrollHeight; };
    print(t('Консоль подключена к серверу. Введите help.'), 'dim');
    const run = async () => {
      const line = inp.value.trim(); if (!line) return; hist.push(line); hi = hist.length; inp.value = ''; print('geo> ' + line, 'cmd');
      try { const r = await api('POST', '/api/admin/console', { cmd: line }); print(r.out || '✓'); if (/^\/?(verify|unverify|geo|ungeo|ban|unban|owner|unowner)\b/.test(line)) { try { const b = await api('GET', '/api/bootstrap'); mergeUsers(b.users); renderChatList(); } catch (e) { } } } catch (e) { print('⚠ ' + errText(e), 'err'); }
    };
    $('#cn-go', wrap).onclick = run;
    inp.onkeydown = e => { if (e.key === 'Enter') run(); else if (e.key === 'ArrowUp' && hist.length) { hi = Math.max(0, hi - 1); inp.value = hist[hi]; e.preventDefault(); } else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; e.preventDefault(); } };
    $('#cn-exp', wrap).onclick = async () => {
      try {
        const r = await fetch('/api/admin/export', { headers: { Authorization: 'Bearer ' + S.token } }); if (!r.ok) throw { error: 'forbidden' };
        const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'geometric-backup.zip'; document.body.appendChild(a); a.click(); a.remove(); print(t('Архив сохранён') + ': ' + a.download + ' (' + Math.round(b.size / 1024) + ' KB)');
      } catch (e) { print('⚠ ' + errText(e), 'err'); }
    };
    $('#cn-imp', wrap).onclick = async () => {
      const [f] = await pickFile('.zip,application/zip'); if (!f) return; if (!(await confirmBox(t('Импорт ЗАМЕНИТ все данные на сервере данными из архива. Продолжить?'), { ok: t('Импорт ZIP'), danger: true }))) return;
      try { const r = await fetch('/api/admin/import', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/zip' }, body: f }); const j = await r.json(); if (!r.ok) throw j; print(t('Данные импортированы. Перезагрузка…') + ' ' + JSON.stringify(j)); setTimeout(() => location.reload(), 1200); } catch (e) { print('⚠ ' + errText(e), 'err'); }
    };
    setTimeout(() => inp.focus(), 100);
  }, { static: true });
}

/* ───────── ссылки вида /u/username и ?uid= ───────── */
function handleProfilePath() {
  const m = /^\/u\/([A-Za-z][\w]{4,31})\/?$/.exec(location.pathname); const uid = new URLSearchParams(location.search).get('uid');
  if (m) { resolveUsername(m[1]); history.replaceState(null, '', '/'); return true; }
  if (uid) { openUserProfile(+uid); history.replaceState(null, '', '/'); return true; }
  return false;
}
