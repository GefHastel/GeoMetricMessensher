/* GeoMetric Beta — ядро: состояние, API, сокеты, настройки, утилиты UI */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24">${(window.ICONS || {})[n] || ''}</svg>`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const LOGO = `<svg viewBox="0 0 64 64" fill="none"><path d="M50 14 12 29.5l10.5 4.3L26 46l6.5-7.5L44 47z" fill="#fff"/><path d="M22.5 33.8 44 20 28 38.5" stroke="rgba(80,90,200,.45)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/* ───────── i18n ───────── */
let LANG = 'ru';
const t = (s, v) => { let r = LANG === 'en' && window.EN && EN[s] != null ? EN[s] : s; if (v) for (const k in v) r = r.split('{' + k + '}').join(v[k]); return r; };
const pl = (n, a, b, c) => {
  if (LANG === 'en') { const [one, many] = (EN[a] || a).split('|'); return n === 1 ? one : (many || one); }
  const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c);
};

/* ───────── state ───────── */
const S = {
  token: localStorage.getItem('gm_token') || '', me: null, users: {}, chats: {}, sid: null, active: null, folder: 'all', typing: {}, mailMode: 'dev',
  cm: null, // current messages {chatId,list,hasBefore,hasAfter}
  socket: null, call: null, drafts: JSON.parse(localStorage.getItem('gm_drafts') || '{}'), selMode: false, sel: new Set(), pendingN: 0,
};
const DEF = { lang: '', theme: 'auto', accent: '', bubble: 'classic', wall: 'default', wallImg: '', doodles: true, wallAnim: true, fs: 16, radius: 12, time24: true, sendEnter: true, anim: true, sound: true, vol: 60, desktop: true, preview: true, bigEmoji: true, autoplay: true, quick: '👍', sbw: 420, contactsJoined: true, micId: '', camId: '', spkId: '', echo: true, noise: true, agc: true };
let CFG = { ...DEF, ...JSON.parse(localStorage.getItem('gm_cfg') || '{}') };
if (!CFG.lang) CFG.lang = (navigator.language || 'ru').startsWith('ru') ? 'ru' : 'en';
LANG = CFG.lang;
const saveCfgRemote = debounce(() => { if (S.token) api('PUT', '/api/me/settings', CFG).catch(() => { }); }, 1500);
function setCfg(patch, opts = {}) {
  Object.assign(CFG, patch); localStorage.setItem('gm_cfg', JSON.stringify(CFG));
  if (!opts.noSync) saveCfgRemote();
  applyTheme();
}

/* ───────── API / socket ───────── */
async function api(method, url, body, opts = {}) {
  const r = await fetch(url, { method, headers: { ...(body !== undefined && !(body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : (body instanceof Blob ? body : JSON.stringify(body)) });
  let j = {}; try { j = await r.json(); } catch (e) { }
  if (r.status === 401 && S.token && !opts.noAuthRedirect) { forceLogout(); throw { error: 'unauthorized' }; }
  if (!r.ok) throw { ...j, error: j.error || 'error', status: r.status };
  return j;
}
function upload(blob, name, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('POST', '/api/upload?name=' + encodeURIComponent(name || 'file'));
    x.setRequestHeader('Authorization', 'Bearer ' + S.token); x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    if (onProgress) x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { try { const j = JSON.parse(x.responseText); x.status < 300 ? res(j) : rej(j); } catch (e) { rej({ error: 'upload' }); } };
    x.onerror = () => rej({ error: 'network' }); x.send(blob);
  });
}
const ERR = { bad_email: 'Некорректный e-mail', too_many: 'Слишком много попыток. Подождите немного', wait: 'Подождите 30 секунд перед повторной отправкой', mail_failed: 'Не удалось отправить письмо. Проверьте настройки почты на сервере', expired: 'Код истёк. Запросите новый', wrong_code: 'Неверный код', username_taken: 'Это имя пользователя занято', bad_username: 'Имя пользователя: 5–32 символа, a-z, 0-9 и _', blocked: 'Вы не можете писать этому пользователю', forbidden: 'Нет прав на это действие', network: 'Ошибка сети', qr_expired: 'QR-код устарел', name_required: 'Введите имя', privacy: 'Настройки приватности пользователя запрещают звонок', busy: 'Пользователь занят', offline: 'Пользователь не в сети', unavailable: 'Звонок недоступен', already: 'Вы уже в звонке', banned: 'Аккаунт заблокирован', weak_password: 'Пароль: минимум 6 символов', wrong_password: 'Неверная почта или пароль', bad_archive: 'Некорректный архив', not_found: 'Не найдено' };
const errText = e => e?.error === 'banned' ? t('Аккаунт заблокирован') + (e.reason ? ': ' + e.reason : '') : t(ERR[e?.error] || 'Что-то пошло не так');
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  const s = S.socket = io({ auth: { token: S.token }, transports: ['websocket', 'polling'] });
  s.on('connect', () => { if (S.booted) { refreshAll(); } });
  s.on('msg:new', onMsgNew); s.on('msg:edit', onMsgEdit); s.on('msg:delete', onMsgDelete); s.on('msg:react', onMsgReact);
  s.on('chat:update', d => { mergeUsers(d.users); upsertChat(d.chat); }); s.on('chat:read', onChatRead); s.on('chat:left', d => { delete S.chats[d.chatId]; if (S.active === d.chatId) closeChat(); renderChatList(); });
  s.on('chat:cleared', d => { const c = S.chats[d.chatId]; if (d.hide) { delete S.chats[d.chatId]; if (S.active === d.chatId) closeChat(); } else if (c) { c.last = null; c.unread = 0; if (S.active === d.chatId) openChat(d.chatId, { force: true }); } renderChatList(); });
  s.on('typing', onTyping); s.on('presence', d => { mergeUsers([d.user]); onPresence(d.user); });
  s.on('me:update', d => { S.me = d.user; S.users[S.me.id] = S.me; renderChatList(); if (window.refreshPanels) refreshPanels(); });
  s.on('settings:sync', d => { if (d.from !== S.sid) { CFG = { ...DEF, ...d.settings }; localStorage.setItem('gm_cfg', JSON.stringify(CFG)); LANG = CFG.lang; applyTheme(); } });
  s.on('session:revoked', () => forceLogout(true));
  s.on('cb:answer', d => { if (!d || !d.text) return; if (d.alert) modal({ title: '', body: `<p style="margin:0;white-space:pre-wrap">${esc(d.text)}</p>`, closeBtn: false, buttons: [{ label: t('ОК') }] }); else toast(d.text); });
  s.on('call:incoming', onCallIncoming); s.on('call:accepted', onCallAccepted); s.on('call:signal', onCallSignal); s.on('call:ended', onCallEnded);
}
function forceLogout(revoked) {
  localStorage.removeItem('gm_token'); S.token = ''; S.booted = false; if (S.socket) S.socket.disconnect();
  if (revoked) toast(t('Сеанс завершён на другом устройстве'));
  location.hash = ''; location.reload();
}

/* ───────── users / chats helpers ───────── */
function mergeUsers(list) { (list || []).forEach(u => { if (u) S.users[u.id] = { ...(S.users[u.id] || {}), ...u }; }); }
const U = id => S.users[id];
async function ensureUsers(ids) {
  const need = [...new Set(ids)].filter(i => i && !S.users[i]); if (!need.length) return;
  try { const r = await api('POST', '/api/users/batch', { ids: need }); mergeUsers(r.users); } catch (e) { }
}
const fullName = u => u ? (u.deleted ? t('Удалённый аккаунт') : [u.name, u.lastName].filter(Boolean).join(' ')) : t('Пользователь');
const initials = s => { const w = String(s || '?').trim().split(/\s+/); return Array.from((w[0] || '?'))[0] + (w[1] ? Array.from(w[1])[0] : ''); };
function hashN(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function chatTitle(c) { if (c.type === 'saved') return t('Избранное'); if (c.type === 'private') return fullName(U(c.peer)); return c.title; }
function avatarHTML(o, size, opts = {}) {
  // o: {name, avatar, color, type?, online?, deleted?}
  const st = size ? `style="--s:${size}"` : '';
  if (o.type === 'saved') return `<div class="avatar saved" ${st}>${ic('bookmark')}</div>`;
  const col = o.color != null ? o.color : hashN(o.name || '') % 8;
  const img = o.avatar ? `<div class="av-img" style="background-image:url('${esc(o.avatar)}')"></div>` : '';
  return `<div class="avatar av${col}${o.deleted ? ' deleted' : ''}" ${st}>${o.avatar ? '' : esc(initials(o.name))}${img}${opts.dot && o.online ? '<span class="dot"></span>' : ''}</div>`;
}
const userAv = (u, size, opts) => u ? avatarHTML({ name: fullName(u), avatar: u.avatar, color: u.color, online: u.online, deleted: u.deleted }, size, opts) : avatarHTML({ name: '?' }, size);
function chatAv(c, size, opts) {
  if (c.type === 'saved') return avatarHTML({ type: 'saved' }, size);
  if (c.type === 'private') return userAv(U(c.peer), size, opts);
  return avatarHTML({ name: c.title, avatar: c.avatar, color: hashN(c.id) % 8 }, size);
}
const CHECK_SVG = `<svg class="verified" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const verifiedBadge = u => !u ? '' : (u.verified ? `<span class="vchk" title="${t('Подтверждённый аккаунт')}">${CHECK_SVG}</span>` : '') + (u.geo ? `<span class="tag tag-geo" title="${t('Модератор GeoMetric')}">[GEO]</span>` : '');
const chatBadge = c => c && c.verified && c.type !== 'private' && c.type !== 'saved' ? `<span class="tag tag-ver" title="${t('Подтверждённый канал')}">[VER]</span>` : '';
function statusText(u) {
  if (!u) return ''; if (u.bot) return t('бот');
  if (u.online) return t('в сети');
  if (u.lastSeenHidden || !u.lastSeen) return t('был(а) недавно');
  const d = new Date(u.lastSeen), n = new Date(), diff = (n - d) / 1000;
  if (diff < 60) return t('был(а) только что'); if (diff < 3600) { const m = Math.floor(diff / 60); return t('был(а) {n} мин. назад', { n: m }); }
  if (sameDay(d, n)) return t('был(а) сегодня в {t}', { t: fmtTime(d) });
  const y = new Date(n); y.setDate(y.getDate() - 1); if (sameDay(d, y)) return t('был(а) вчера в {t}', { t: fmtTime(d) });
  return t('был(а) {d}', { d: d.toLocaleDateString(LANG === 'en' ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' }) });
}

/* ───────── formatting ───────── */
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const locale = () => LANG === 'en' ? 'en-US' : 'ru-RU';
const fmtTime = ts => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: !CFG.time24 });
function fmtListTime(ts) {
  const d = new Date(ts), n = new Date();
  if (sameDay(d, n)) return fmtTime(ts);
  if ((n - d) < 6 * 864e5) return d.toLocaleDateString(locale(), { weekday: 'short' });
  return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function dayLabel(ts) {
  const d = new Date(ts), n = new Date(); if (sameDay(d, n)) return t('Сегодня');
  const y = new Date(n); y.setDate(y.getDate() - 1); if (sameDay(d, y)) return t('Вчера');
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
}
const fmtDur = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const EMO_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*){1,3}$/u;
function fmt(text) {
  let s = esc(text); const stash = []; const keep = h => `\u0000${stash.push(h) - 1}\u0000`;
  s = s.replace(/```([\s\S]+?)```/g, (m, c) => keep(`<pre>${c.replace(/^\n/, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));
  s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, u => keep(`<a href="${u.replace(/&amp;/g, '&')}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  s = s.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>').replace(/__(.+?)__/gs, '<i>$1</i>').replace(/~~(.+?)~~/gs, '<s>$1</s>').replace(/\|\|(.+?)\|\|/gs, '<span class="spoiler">$1</span>');
  s = s.replace(/(^|[\s(])@([a-zA-Z][\w]{4,31})/g, '$1<span class="mention" data-u="$2">@$2</span>').replace(/(^|[\s(])(#[\wа-яА-ЯёЁ]{2,})/g, '$1<span class="mention">$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[i]);
}
const plain = s => String(s || '').replace(/```|\*\*|__|~~|\|\||`/g, '');

/* ───────── theme / wallpaper ───────── */
const WALLS = {
  default: null,
  sky: 'linear-gradient(135deg,#a1c4fd,#c2e9fb,#a1c4fd)', sunset: 'linear-gradient(135deg,#ffecd2,#fcb69f,#ffdde1)', purple: 'linear-gradient(135deg,#a18cd1,#fbc2eb,#a18cd1)',
  mint: 'linear-gradient(135deg,#84fab0,#8fd3f4,#84fab0)', ocean: 'linear-gradient(135deg,#0f2027,#2c5364,#203a43)', forest: 'linear-gradient(135deg,#134e5e,#71b280,#134e5e)',
  rose: 'linear-gradient(135deg,#ee9ca7,#ffdde1,#ee9ca7)', night: 'linear-gradient(135deg,#232526,#414345,#232526)', aurora: 'linear-gradient(135deg,#00c6fb,#005bea,#7b2ff7,#00c6fb)', sand: '#e6dccb', ink: '#101418',
};
const ACCENTS = ['#3390ec', '#8774e1', '#e53935', '#f57c00', '#fbc02d', '#43a047', '#00acc1', '#d81b60', '#5e35b1', '#6d4c41'];
const PROFILE_COLORS = [['#ff885e', '#ff516a'], ['#ffcd6a', '#ffa85c'], ['#82b1ff', '#665fff'], ['#a0de7e', '#54cb68'], ['#53edd6', '#28c9b7'], ['#72d5fd', '#2a9ef1'], ['#e0a2f3', '#d669ed'], ['#ff8fb2', '#f2587c']];
const pcBg = c => `linear-gradient(160deg,${PROFILE_COLORS[c % 8][0]},${PROFILE_COLORS[c % 8][1]})`;
function doodleSVG(color) {
  const names = ['send', 'heart', 'star', 'smile', 'camera', 'map-pin', 'phone', 'sparkles', 'bell', 'bookmark', 'mic', 'zap', 'globe', 'message-circle', 'image', 'link', 'sun', 'moon', 'paperclip', 'clock'];
  let g = '', i = 0, seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) { const n = names[i++ % names.length]; const px = x * 60 + (y % 2 ? 30 : 0) + rnd() * 14, py = y * 60 + rnd() * 14, r = Math.floor(rnd() * 360); g += `<g transform="translate(${px} ${py}) rotate(${r} 12 12) scale(.95)">${ICONS[n] || ''}</g>`; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${g}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function isDarkSys() { return matchMedia('(prefers-color-scheme: dark)').matches; }
function applyTheme() {
  const r = document.documentElement; let th = CFG.theme === 'auto' ? (isDarkSys() ? 'dark' : 'light') : CFG.theme;
  r.dataset.theme = th; r.style.setProperty('--fs', CFG.fs + 'px'); r.style.setProperty('--bubble-r', (CFG.radius / 16 * 1.0) + 'rem'); r.style.setProperty('--radius', Math.min(CFG.radius, 16) + 'px');
  document.body.classList.toggle('no-anim', !CFG.anim);
  const defAcc = { light: '#3390ec', dark: '#8774e1', night: '#5eb5f7' }[th];
  const acc = CFG.accent || defAcc; r.style.setProperty('--accent', acc); r.style.setProperty('--accent-d', `color-mix(in srgb, ${acc} 85%, #000)`);
  if (CFG.bubble === 'accent') r.style.setProperty('--out', th === 'light' ? `color-mix(in srgb, ${acc} 16%, #fff)` : `color-mix(in srgb, ${acc} 75%, #000)`), r.style.setProperty('--out-text', th === 'light' ? '#000' : '#fff'), r.style.setProperty('--meta-out', th === 'light' ? acc : 'rgba(255,255,255,.7)');
  else ['--out', '--out-text', '--meta-out'].forEach(k => r.style.removeProperty(k));
  const w = $('.wallpaper'); const darkW = th !== 'light';
  r.style.setProperty('--doodle', CFG.doodles ? doodleSVG(darkW ? '#fff' : '#3c5a32') : 'none');
  let bg = null;
  if (CFG.wall === 'custom' && CFG.wallImg) bg = `url('${CFG.wallImg}')`;
  else if (CFG.wall === 'default') bg = th === 'light' ? 'linear-gradient(135deg,#dbddbb,#6ba587,#d5d88d,#88b884)' : null; else bg = WALLS[CFG.wall];
  if (bg) r.style.setProperty('--wall', bg); else r.style.removeProperty('--wall');
  if (w) w.classList.toggle('anim', !!CFG.wallAnim && /gradient/.test(bg || '') && CFG.anim);
  document.querySelector('meta[name=theme-color]').content = acc;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => CFG.theme === 'auto' && applyTheme());

/* ───────── UI utils: toast, modal, menu ───────── */
function toast(msg, ms = 2800) { const e = el(`<div class="toast">${esc(msg)}</div>`); $('#toasts').appendChild(e); setTimeout(() => { e.style.opacity = 0; e.style.transition = '.3s'; setTimeout(() => e.remove(), 300); }, ms); }
function modal(o) {
  const back = el(`<div class="modal-back"><div class="modal ${o.cls || ''}"><div class="modal-head">${o.title ? `<span class="grow">${o.title}</span>` : ''}${o.closeBtn !== false ? `<button class="btn-icon" data-x>${ic('x')}</button>` : ''}</div><div class="modal-body"></div><div class="modal-foot"></div></div></div>`);
  const body = $('.modal-body', back), foot = $('.modal-foot', back);
  if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
  const api_ = { el: back, body, close() { back.remove(); document.removeEventListener('keydown', onKey); o.onClose && o.onClose(); } };
  (o.buttons || []).forEach(b => { const bt = el(`<button class="btn flat ${b.cls || ''}">${b.label}</button>`); bt.onclick = async () => { if (b.onClick) { const r = await b.onClick(api_, bt); if (r === false) return; } api_.close(); }; foot.appendChild(bt); b.el = bt; });
  if (!(o.buttons || []).length) foot.remove();
  const onKey = e => { if (e.key === 'Escape' && back.parentNode && [...$$('.modal-back')].pop() === back) api_.close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', e => { if (e.target === back && o.dismiss !== false) api_.close(); });
  $('[data-x]', back)?.addEventListener('click', () => api_.close());
  document.body.appendChild(back); return api_;
}
const confirmBox = (text, { ok = t('ОК'), danger = false, title = '', extra = '' } = {}) => new Promise(res => {
  let done = false; const m = modal({ title, body: `<p>${text}</p>${extra}`, closeBtn: false, onClose: () => { if (!done) res(false); }, buttons: [{ label: t('Отмена'), onClick: () => { done = true; res(false); } }, { label: ok, cls: danger ? 'danger' : '', onClick: () => { done = true; res({ extra: m.body }); } }] });
});
const promptBox = (title, { value = '', ph = '', ok = t('ОК'), multiline = false, max = 100 } = {}) => new Promise(res => {
  let done = false; const m = modal({ title, closeBtn: false, body: `<div class="field" style="max-width:none;margin:.5rem 0"><${multiline ? 'textarea' : 'input'} placeholder=" " maxlength="${max}">${multiline ? esc(value) : ''}</${multiline ? 'textarea' : 'input'}><label>${esc(ph)}</label></div>`, onClose: () => { if (!done) res(null); }, buttons: [{ label: t('Отмена'), onClick: () => { done = true; res(null); } }, { label: ok, onClick: () => { done = true; res($('input,textarea', m.body).value); } }] });
  const i = $('input,textarea', m.body); if (!multiline) i.value = value; setTimeout(() => i.focus(), 50);
  i.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) { done = true; res(i.value); m.close(); } });
});
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function popMenu(items, pos, opts = {}) {
  closeMenu();
  const m = el(`<div class="ctx">${opts.top || ''}<div class="menu">${items.filter(Boolean).map((it, i) => it.sep ? '<div class="menu-sep"></div>' : `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? ic(it.icon) : ''}<span>${esc(it.label)}</span>${it.right || ''}</button>`).join('')}</div></div>`);
  const list = items.filter(Boolean);
  $$('.menu-item', m).forEach(b => b.onclick = e => { e.stopPropagation(); closeMenu(); list[+b.dataset.i].onClick && list[+b.dataset.i].onClick(e); });
  document.body.appendChild(m); openMenu = m;
  let x = pos.x, y = pos.y; if (pos.el) { const r = pos.el.getBoundingClientRect(); x = pos.right ? r.right : r.left; y = r.bottom + 4; }
  const w = m.offsetWidth, h = m.offsetHeight;
  if (pos.right && pos.el) x -= w; if (x + w > innerWidth - 8) x = innerWidth - w - 8; if (y + h > innerHeight - 8) y = Math.max(8, (pos.el ? pos.el.getBoundingClientRect().top - h - 4 : innerHeight - h - 8)); if (x < 8) x = 8; if (y < 8) y = 8;
  m.style.left = x + 'px'; m.style.top = y + 'px'; m.style.setProperty('--ox', `${pos.right ? 'right' : 'left'} ${y > innerHeight / 2 ? 'bottom' : 'top'}`);
  return m;
}
document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('[data-menu-keep]')) closeMenu(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); if (e.key === 'Escape') document.querySelector('.menu-drawer-back')?.click(); });
window.addEventListener('blur', closeMenu); window.addEventListener('resize', closeMenu);
function switchRow(label, checked, onChange, sub) {
  const r = el(`<label class="row-item"><span class="grow"><span class="t">${esc(label)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</span><span class="switch"><input type="checkbox" ${checked ? 'checked' : ''}><span></span></span></label>`);
  $('input', r).onchange = e => onChange(e.target.checked); return r;
}

/* ───────── sounds & notifications ───────── */
let actx = null;
const audioCtx = () => (actx = actx || new (window.AudioContext || window.webkitAudioContext)());
function tone(freqs, dur = .12, type = 'sine', vol = 1, gap = 0) {
  if (!CFG.sound && !tone.force) return; try {
    const c = audioCtx(); if (c.state === 'suspended') c.resume(); let t0 = c.currentTime;
    freqs.forEach((f, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.25 * vol * CFG.vol / 100, t0 + .01); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur); o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + dur + .02); t0 += dur + gap; });
  } catch (e) { }
}
const sndMsg = () => tone([880, 1175], .1, 'sine', 1, .02);
const sndSend = () => tone([660], .06, 'sine', .6);
let ringTimer = null;
function startRing(out) { stopRing(); const f = () => out ? tone([440, 480], .4, 'sine', .6, .05) : tone([784, 988, 784, 988], .16, 'triangle', .9, .04); tone.force = true; f(); ringTimer = setInterval(f, out ? 3000 : 1800); tone.force = false; }
function stopRing() { clearInterval(ringTimer); ringTimer = null; }
function notify(title, body, chatId, icon) {
  if (!CFG.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus() && !document.hidden) return;
  try { const n = new Notification(title, { body: CFG.preview ? body : t('Новое сообщение'), icon: icon || undefined, tag: 'gm' + chatId }); n.onclick = () => { window.focus(); openChat(chatId); n.close(); }; } catch (e) { }
}
const isMuted = c => c.me && c.me.muted && (c.me.muted === true || c.me.muted > Date.now());

/* title badge */
function updateTitle() { const n = Object.values(S.chats).filter(c => !c.me.archived || !isMuted(c)).reduce((a, c) => a + (isMuted(c) ? 0 : c.unread), 0); document.title = (n ? `(${n}) ` : '') + 'GeoMetric Beta'; }

/* misc utils */
function copyText(s) { navigator.clipboard?.writeText(s).then(() => toast(t('Скопировано')), () => toast(t('Не удалось скопировать'))); }
function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
const audioC = (x = {}) => ({ ...(CFG.micId ? { deviceId: { ideal: CFG.micId } } : {}), echoCancellation: CFG.echo !== false, noiseSuppression: CFG.noise !== false, autoGainControl: CFG.agc !== false, ...x });
const videoC = (x = {}) => ({ ...(CFG.camId ? { deviceId: { ideal: CFG.camId } } : {}), ...x });
function applySink(mediaEl) { if (CFG.spkId && mediaEl && mediaEl.setSinkId) mediaEl.setSinkId(CFG.spkId).catch(() => { }); }
function pickFile(accept, multiple) {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept || '*/*'; i.multiple = !!multiple;
    i.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px'; document.body.appendChild(i);
    let fin = false; const done = v => { if (fin) return; fin = true; setTimeout(() => i.remove(), 0); res(v); };
    i.addEventListener('change', () => done([...i.files])); i.addEventListener('cancel', () => done([]));
    i.click();
  });
}
async function compressImage(file, max = 1600, q = .85) {
  if (!/^image\/(jpeg|png|webp)/.test(file.type) || file.size < 150 * 1024 && /png|webp/.test(file.type)) { const im = await loadImage(URL.createObjectURL(file)).catch(() => null); return { blob: file, w: im?.width || 0, h: im?.height || 0 }; }
  const im = await loadImage(URL.createObjectURL(file)); let { width: w, height: h } = im; const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, file.type === 'image/png' ? 'image/png' : 'image/jpeg', q));
  return { blob: blob.size < file.size || k < 1 ? blob : file, w: c.width, h: c.height };
}
function videoMeta(file) { return new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, duration: v.duration }); v.onerror = () => res({}); v.src = URL.createObjectURL(file); }); }
const EMOJI = {
  '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖',
  '👋': '👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 👀 👅 👄 🧠 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷',
  '🐶': '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🐘 🦒 🐪 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🌸 🌼 🌻 🌹 🌷 🍁 🍂',
  '🍔': '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶 🥒 🥦 🍄 🥜 🍞 🥐 🥖 🧀 🥚 🍳 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍣 🍱 🍤 🍙 🍚 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍮 ☕ 🍵 🥤 🍺 🍻 🥂 🍷 🍸 🍹 🍾',
  '⚽': '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ ⛸ 🎣 🎿 🛷 🏆 🥇 🥈 🥉 🎮 🎯 🎲 🧩 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🚗 🚕 🚌 🏎 🚓 🚑 🚒 🚜 🏍 🚲 ✈️ 🚀 🛸 🚁 ⛵ 🚢 🏠 🏰 🗼 🗽 ⛰ 🌋 🏖 🏝',
  '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☸️ ✡️ 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⭐ 🌟 ✨ ⚡ 🔥 💥 ☀️ 🌤 ⛅ 🌈 ☁️ ❄️ ☃️ 💧 🌊 🎉 🎊 🎁 🎈 💯 ✅ ❌ ❓ ❗ 💤 🔔 🔒 🔑 💡 📌 📎 ✏️ 📚 💻 📱 📷 💰 💎',
};
const STICKERS = ['😍', '😂', '🥳', '😎', '🤩', '😭', '😡', '🥺', '🤯', '🤝', '👍', '👎', '🙏', '💪', '🔥', '💯', '❤️', '💔', '🎉', '🎁', '🍕', '☕', '🌈', '🚀', '🐱', '🐶', '🦄', '🐼', '👻', '💩', '🤖', '🙈', '😴', '🤔', '😱', '🥰', '🤗', '😏', '🫡', '🤌'];
const REACTIONS = ['👍', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '😢', '🎉', '🤩', '🙏', '👌', '😍', '💯', '🤣', '👎', '💩', '🤮'];
