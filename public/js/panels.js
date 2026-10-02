/* GeoMetric Beta — меню, настройки, профиль, информация о чате, группы, контакты */
'use strict';
const panels = [];
function pushPanel(title, render, opts = {}) {
  const p = el(`<div class="panel"><div class="panel-head"><button class="btn-icon" data-back>${ic('arrow-left')}</button><div class="grow">${esc(title)}</div><span data-actions style="display:flex"></span></div><div class="panel-body"></div></div>`);
  const obj = { el: p, render, body: $('.panel-body', p), title, opts }; panels.push(obj);
  $('[data-back]', p).onclick = closeTopPanel; $('#sidebar').appendChild(p);
  if (opts.actions) { const a = $('[data-actions]', p); opts.actions.forEach(x => { const b = el(`<button class="btn-icon" title="${esc(x.title || '')}">${ic(x.icon)}</button>`); b.onclick = x.onClick; a.appendChild(b); }); }
  render(obj.body, obj); return obj;
}
function closeTopPanel() { const p = panels.pop(); if (!p) return; p.el.classList.add('out'); setTimeout(() => p.el.remove(), 200); p.opts.onClose && p.opts.onClose(); }
function closeAllPanels() { while (panels.length) closeTopPanel(); }
function refreshPanels() { panels.forEach(p => { if (!p.opts.static) { const st = p.body.scrollTop; p.render(p.body, p); p.body.scrollTop = st; } }); updateInfoIfOpen(); }
const row = (icon, title, sub, onClick, o = {}) => { const r = el(`<button class="row-item ${o.danger ? 'danger' : ''}">${icon ? ic(icon) : ''}<span class="grow"><span class="t">${esc(title)}</span>${sub != null && sub !== '' ? `<span class="s">${esc(sub)}</span>` : ''}</span>${o.right || ''}</button>`); r.onclick = onClick; return r; };
const sec = (title, ...children) => { const s = el(`<div class="sec">${title ? `<div class="sec-title">${esc(title)}</div>` : ''}</div>`); children.filter(Boolean).forEach(c => s.appendChild(typeof c === 'string' ? el(c) : c)); return s; };
const note = txt => el(`<div class="sec-note">${txt}</div>`);

/* ───────── drawer ───────── */
function openDrawer() {
  const me = S.me; const back = el('<div class="menu-drawer-back"></div>');
  const d = el(`<div class="drawer"><div class="drawer-head"><button class="btn-icon theme-btn" id="dr-theme" title="${t('Тема')}">${ic(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun')}</button>${userAv(me, '4.2rem')}<div class="nm">${esc(fullName(me))}${me.emoji ? ' ' + esc(me.emoji) : ''}</div><div class="em">${me.username ? '@' + esc(me.username) : esc(me.email)}</div></div>
  <button class="menu-item" data-a="profile">${ic('user-round')}<span>${t('Мой профиль')}</span></button><button class="menu-item" data-a="group">${ic('users')}<span>${t('Новая группа')}</span></button><button class="menu-item" data-a="channel">${ic('megaphone')}<span>${t('Новый канал')}</span></button><button class="menu-item" data-a="contacts">${ic('contact')}<span>${t('Контакты')}</span></button><button class="menu-item" data-a="calls">${ic('phone')}<span>${t('Звонки')}</span></button><button class="menu-item" data-a="saved">${ic('bookmark')}<span>${t('Избранное')}</span></button><button class="menu-item" data-a="settings">${ic('settings')}<span>${t('Настройки')}</span></button><button class="menu-item" data-a="devices">${ic('qr-code')}<span>${t('Подключить устройство')}</span></button>
  <div class="ver">GeoMetric Beta · v1.0</div></div>`);
  document.body.append(back, d);
  const close = () => { back.remove(); d.remove(); };
  back.onclick = close;
  $('#dr-theme', d).onclick = () => { const th = document.documentElement.dataset.theme; setCfg({ theme: th === 'light' ? 'dark' : 'light' }); close(); };
  $$('.menu-item', d).forEach(b => b.onclick = () => { close(); ({ profile: () => openSettings(), group: () => newGroupWizard('group'), channel: () => newGroupWizard('channel'), contacts: openContacts, calls: openCallsList, saved: () => openChat(`p:${S.me.id}:${S.me.id}`), settings: openSettings, devices: openDevices })[b.dataset.a](); });
}

/* ───────── settings ───────── */
function profileCardHTML(u, withActions) {
  return `<div class="profile-card"><div class="pc-bg" style="background:${pcBg(u.color)}"></div><div class="pc-pat" style="background-image:${doodleSVG('#fff')}"></div>${userAv(u, '7rem')}<div class="nm">${esc(fullName(u))}${verifiedBadge(u)}${u.emoji ? ' ' + esc(u.emoji) : ''}</div><div class="st">${u.id === S.me.id ? esc(u.email) : esc(statusText(u))}</div>${u.username ? `<div class="st">@${esc(u.username)}</div>` : ''}${u.bio ? `<div class="st" style="margin-top:.4rem;max-width:20rem;margin-inline:auto">${esc(u.bio)}</div>` : ''}${u.birthday ? `<div class="bday-pill">🎂 ${esc(fmtBirthday(u.birthday))}</div>` : ''}</div>`;
}
function fmtBirthday(b, short) {
  const months = LANG === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] : ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  let s = `${b.d} ${months[b.m - 1]}${b.y ? ' ' + b.y : ''}`;
  if (b.y) { const n = new Date(); let age = n.getFullYear() - b.y; if (n.getMonth() + 1 < b.m || (n.getMonth() + 1 === b.m && n.getDate() < b.d)) age--; s += ` (${age} ${pl(age, 'год', 'года', 'лет')})`; }
  const n = new Date(); if (n.getDate() === b.d && n.getMonth() + 1 === b.m) s += ' 🎉 ' + t('сегодня!');
  return s;
}
function openSettings() {
  pushPanel(t('Настройки'), (body) => {
    const me = S.me; body.innerHTML = profileCardHTML(me);
    const pc = $('.profile-card', body); pc.insertAdjacentHTML('beforeend', `<div class="pc-actions"><button id="pc-edit">${ic('pen-line')}<span>${t('Изменить')}</span></button><button id="pc-theme">${ic('palette')}<span>${t('Оформление')}</span></button><button id="pc-qr">${ic('qr-code')}<span>QR</span></button><button id="pc-out">${ic('log-out')}<span>${t('Выйти')}</span></button></div>`);
    $('#pc-edit', pc).onclick = openEditProfile; $('#pc-theme', pc).onclick = openAppearance; $('#pc-qr', pc).onclick = () => showUserQR(me); $('#pc-out', pc).onclick = logoutDialog; $('.avatar', pc).style.cursor = 'pointer'; $('.avatar', pc).onclick = () => me.avatar ? viewAvatar(me.avatar) : openEditProfile();
    body.appendChild(sec('', row('pen-line', t('Редактировать профиль'), t('Имя, фото, О себе, дата рождения'), openEditProfile), row('bell', t('Уведомления и звуки'), '', openNotifSettings), row('lock', t('Конфиденциальность'), '', openPrivacy), row('palette', t('Оформление чатов'), t('Тема, цвета, обои, размер текста'), openAppearance), row('database', t('Данные и память'), '', openData), row('laptop', t('Устройства'), t('Подключить по QR-коду, активные сеансы'), openDevices), row('headphones', t('Звук и видео'), t('Микрофон, камера и динамики для звонков, голосовых и кружков'), openAV), row('scan-line', t('Сканировать QR-код'), t('Профили, чаты и вход на устройстве'), openQRScanner), row('languages', t('Язык'), LANG === 'ru' ? 'Русский' : 'English', openLanguage)));
    if (S.me.isOwner) body.appendChild(sec('', row('terminal', t('Консоль владельца'), 'verify, geo, ban, export…', openConsole)));
    body.appendChild(sec('', row('info', t('О GeoMetric Beta'), '', openAbout), row('log-out', t('Выйти из аккаунта'), '', logoutDialog, { danger: true })));
  });
}
async function logoutDialog() { if (!(await confirmBox(t('Выйти из аккаунта на этом устройстве?'), { ok: t('Выйти'), danger: true }))) return; try { await api('POST', '/api/auth/logout'); } catch (e) { } forceLogout(); }
function viewAvatar(url) { const v = el(`<div class="viewer"><div class="vtop"><div class="grow"></div><button class="btn-icon" data-x>${ic('x')}</button></div><img src="${esc(url)}" style="border-radius:50%;max-width:min(80vmin,500px);max-height:80vmin;object-fit:cover;aspect-ratio:1"></div>`); v.onclick = () => v.remove(); document.body.appendChild(v); }

function openEditProfile() {
  pushPanel(t('Редактировать профиль'), (body, pn) => {
    if (pn.inited) return; pn.inited = true; const me = S.me; const st = { avatar: me.avatar, color: me.color, emoji: me.emoji || '' };
    body.innerHTML = `<div style="padding:1.2rem 1.1rem .5rem;display:flex;flex-direction:column;align-items:center"><div class="av-pick" id="ep-av"><div id="ep-av-prev">${userAv(me, '7rem')}</div><div class="cam">${ic('camera').replace('class="i', 'style="width:2rem;height:2rem" class="i')}</div></div>
    <div style="display:flex;gap:.6rem;width:100%"><div class="field" style="max-width:none;flex:1"><input id="ep-name" placeholder=" " maxlength="40" value="${esc(me.name)}"><label>${t('Имя')}</label></div><div class="field" style="max-width:none;flex:1"><input id="ep-last" placeholder=" " maxlength="40" value="${esc(me.lastName || '')}"><label>${t('Фамилия')}</label></div></div>
    <div class="field" style="max-width:none"><textarea id="ep-bio" placeholder=" " maxlength="200" rows="3">${esc(me.bio || '')}</textarea><label>${t('О себе')}</label><div class="hint"><span id="bio-n">${(me.bio || '').length}</span>/200 · ${t('Несколько слов о себе. Видно всем в вашем профиле')}</div></div></div>
    <div class="sec"><div class="sec-title">${t('Имя пользователя')}</div><div style="padding:0 1.1rem 1rem"><div class="field" style="max-width:none;margin-bottom:0"><input id="ep-user" placeholder=" " maxlength="32" autocapitalize="off" value="${esc(me.username || '')}"><label>@username</label><div class="hint" id="ep-user-h">${t('Люди смогут найти вас по @username. a–z, 0–9 и _, минимум 5 символов.')}</div></div></div></div>
    <div class="sec"><div class="sec-title">${t('Дата рождения')}</div><div style="padding:0 1.1rem 1rem">${birthdayFields(me.birthday)}<div class="hint" style="font-size:.8rem;color:var(--text2);margin-top:.5rem">${t('Кто видит дату рождения — настраивается в «Конфиденциальность».')}</div></div></div>
    <div class="sec"><div class="sec-title">${t('Цвет профиля')}</div><div class="color-grid" id="ep-colors">${PROFILE_COLORS.map((c, i) => `<div class="color-dot ${i === st.color ? 'sel' : ''}" data-c="${i}" style="background:${pcBg(i)}"></div>`).join('')}</div></div>
    <div class="sec"><div class="sec-title">${t('Эмодзи-статус')}</div><div class="emoji-grid" id="ep-emo"><button data-e="" class="${!st.emoji ? 'sel' : ''}" style="font-size:1rem">${t('нет')}</button>${['⭐', '🔥', '💎', '🚀', '🎮', '🎧', '🌈', '☕', '🐱', '🦊', '🌙', '❤️', '👑', '⚡', '🎯', '🍀', '💻', '🎨', '🏆', '🌍'].map(e => `<button data-e="${e}" class="${st.emoji === e ? 'sel' : ''}">${e}</button>`).join('')}</div></div>
    <div style="padding:1rem 1.1rem 2rem"><button class="btn" id="ep-save" style="width:100%">${t('Сохранить')}</button></div>`;
    $('#ep-av', body).onclick = async () => { const [f] = await pickFile('image/*'); if (!f) return; const blob = await cropAvatar(f); if (!blob) return; try { const up = await upload(blob, 'avatar.jpg'); st.avatar = up.url; $('#ep-av-prev', body).innerHTML = avatarHTML({ name: me.name, avatar: st.avatar, color: st.color }, '7rem'); toast(t('Фото загружено — нажмите «Сохранить»')); } catch (e) { toast(errText(e)); } };
    if (st.avatar) { const rm = el(`<button class="btn flat danger" style="margin-top:-1rem">${t('Удалить фото')}</button>`); rm.onclick = () => { st.avatar = ''; $('#ep-av-prev', body).innerHTML = avatarHTML({ name: me.name, color: st.color }, '7rem'); }; $('.av-pick', body).after(rm); }
    $('#ep-bio', body).oninput = e => $('#bio-n', body).textContent = e.target.value.length;
    bindUsernameCheck($('#ep-user', body), $('#ep-user-h', body), null, me.username);
    $$('#ep-colors .color-dot', body).forEach(d => d.onclick = () => { st.color = +d.dataset.c; $$('#ep-colors .color-dot', body).forEach(x => x.classList.toggle('sel', x === d)); if (!st.avatar) $('#ep-av-prev', body).innerHTML = avatarHTML({ name: me.name, color: st.color }, '7rem'); });
    $$('#ep-emo button', body).forEach(b => b.onclick = () => { st.emoji = b.dataset.e; $$('#ep-emo button', body).forEach(x => x.classList.toggle('sel', x === b)); });
    $('#ep-save', body).onclick = async () => {
      const b = $('#ep-save', body); const un = $('#ep-user', body).value.trim().replace(/^@/, ''); if (un && $('#ep-user', body).dataset.ok === '' && un !== me.username) return toast(t('Проверьте имя пользователя'));
      b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try { const r = await api('PATCH', '/api/me', { name: $('#ep-name', body).value, lastName: $('#ep-last', body).value, bio: $('#ep-bio', body).value, username: un, birthday: readBirthday(body), color: st.color, emoji: st.emoji, avatar: st.avatar }); S.me = r.user; S.users[S.me.id] = S.me; toast(t('Профиль сохранён')); closeTopPanel(); refreshPanels(); renderChatList(); }
      catch (e) { toast(errText(e)); b.disabled = false; b.textContent = t('Сохранить'); }
    };
  }, { static: true });
}
function cropAvatar(file) {
  return new Promise(async res => {
    const url = URL.createObjectURL(file); let img; try { img = await loadImage(url); } catch (e) { toast(t('Не удалось открыть изображение')); return res(null); }
    const body = el(`<div><div class="crop-wrap" id="cr"><canvas width="480" height="480"></canvas><div class="mask"></div></div><div class="range" style="padding:.3rem 0"><input type="range" id="cr-z" min="1" max="4" step="0.01" value="1"></div></div>`);
    const cv = $('canvas', body), cx = cv.getContext('2d'); const S_ = 480; const base = Math.max(S_ / img.width, S_ / img.height); let z = 1, ox = 0, oy = 0;
    const clampO = () => { const w = img.width * base * z, h = img.height * base * z; ox = Math.min(Math.max(ox, -(w - S_) / 2), (w - S_) / 2); oy = Math.min(Math.max(oy, -(h - S_) / 2), (h - S_) / 2); };
    const draw = (c = cx, s = S_) => { const k = s / S_; const w = img.width * base * z * k, h = img.height * base * z * k; c.fillStyle = '#000'; c.fillRect(0, 0, s, s); c.drawImage(img, (s - w) / 2 + ox * k, (s - h) / 2 + oy * k, w, h); };
    draw(); let drag = null; const cr = $('#cr', body);
    cr.onpointerdown = e => { drag = { x: e.clientX, y: e.clientY, ox, oy }; cr.setPointerCapture(e.pointerId); };
    cr.onpointermove = e => { if (!drag) return; const k = S_ / cr.clientWidth; ox = drag.ox + (e.clientX - drag.x) * k; oy = drag.oy + (e.clientY - drag.y) * k; clampO(); draw(); };
    cr.onpointerup = () => drag = null; cr.onwheel = e => { e.preventDefault(); z = Math.min(4, Math.max(1, z - e.deltaY / 500)); $('#cr-z', body).value = z; clampO(); draw(); };
    $('#cr-z', body).oninput = e => { z = +e.target.value; clampO(); draw(); };
    let done = false; modal({ title: t('Выберите область'), body, onClose: () => { if (!done) res(null); }, buttons: [{ label: t('Отмена') }, { label: t('Готово'), onClick: () => { const o = document.createElement('canvas'); o.width = o.height = 512; draw(o.getContext('2d'), 512); done = true; o.toBlob(b => res(b), 'image/jpeg', .9); } }] });
  });
}

function openNotifSettings() {
  pushPanel(t('Уведомления и звуки'), body => {
    body.innerHTML = '';
    const perm = 'Notification' in window ? Notification.permission : 'denied';
    body.appendChild(sec(t('Уведомления'), switchRow(t('Уведомления на рабочем столе'), CFG.desktop && perm === 'granted', async v => { if (v && 'Notification' in window && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { toast(t('Разрешите уведомления в настройках браузера')); setCfg({ desktop: false }); return refreshPanels(); } } setCfg({ desktop: v }); }, perm === 'denied' ? t('Заблокированы в браузере') : t('Показывать, когда вкладка не активна')), switchRow(t('Показывать текст сообщения'), CFG.preview, v => setCfg({ preview: v }))));
    const vol = el(`<div class="range"><div class="top"><span>${t('Громкость')}</span><b id="vol-n">${CFG.vol}%</b></div><input type="range" min="0" max="100" value="${CFG.vol}"></div>`);
    $('input', vol).oninput = e => { $('#vol-n', vol).textContent = e.target.value + '%'; CFG.vol = +e.target.value; }; $('input', vol).onchange = e => { setCfg({ vol: +e.target.value }); sndMsg(); };
    body.appendChild(sec(t('Звуки'), switchRow(t('Звуки сообщений'), CFG.sound, v => setCfg({ sound: v })), vol, row('bell', t('Проверить звук'), '', () => { tone.force = true; sndMsg(); setTimeout(() => tone.force = false, 400); })));
  });
}
const PRIV_OPTS = { everyone: t('Все'), contacts: t('Мои контакты'), nobody: t('Никто') };
function privRow(key, title) {
  const cur = (S.me.privacy || {})[key] || 'everyone';
  return row('', title, PRIV_OPTS[cur], () => {
    const m = modal({ title, body: ['everyone', 'contacts', 'nobody'].map(k => `<label class="check"><input type="radio" name="pv" value="${k}" ${k === cur ? 'checked' : ''} style="display:none"><span class="box round">${ic('check')}</span><span>${PRIV_OPTS[k]}</span></label>`).join(''), buttons: [{ label: t('Отмена') }, { label: t('Сохранить'), onClick: async () => { const v = $('input[name=pv]:checked', m.body).value; const r = await api('PATCH', '/api/me', { privacy: { [key]: v } }); S.me = r.user; refreshPanels(); } }] });
    $$('input[name=pv]', m.body).forEach(i => i.onchange = () => $$('.box', m.body).forEach(b => { const on = $('input', b.parentNode).checked; b.style.cssText = on ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''; })); $$('input[name=pv]', m.body).find(i => i.checked).onchange();
  });
}
function openPrivacy() {
  pushPanel(t('Конфиденциальность'), body => {
    body.innerHTML = '';
    body.appendChild(sec(t('Кто видит мои данные'), privRow('lastSeen', t('Время захода (был в сети)')), privRow('photo', t('Фото профиля')), privRow('birthday', t('Дата рождения'))));
    body.appendChild(sec(t('Взаимодействие'), privRow('calls', t('Кто может мне звонить')), privRow('invites', t('Кто может добавлять в группы'))));
    body.appendChild(sec(t('Безопасность'), row('key-round', t('Пароль для входа'), S.me.hasPassword ? t('Задан') : t('Не задан'), openPassword), row('ban', t('Заблокированные пользователи'), `${(S.me.blocked || []).length}`, openBlocked), row('laptop', t('Активные сеансы'), '', openDevices)));
    body.appendChild(sec('', row('trash-2', t('Удалить аккаунт'), t('Аккаунт и профиль будут удалены безвозвратно'), async () => { const r = await confirmBox(t('Удалить аккаунт безвозвратно? Это действие нельзя отменить.'), { ok: t('Удалить аккаунт'), danger: true }); if (!r) return; await api('DELETE', '/api/me'); forceLogout(); }, { danger: true })));
  });
}
async function openBlocked() {
  pushPanel(t('Заблокированные'), async body => {
    await ensureUsers(S.me.blocked || []); body.innerHTML = '';
    if (!(S.me.blocked || []).length) { body.innerHTML = `<div class="empty-list">${t('Список пуст')}</div>`; return; }
    S.me.blocked.forEach(id => { const u = U(id); const r = el(`<div class="member">${userAv(u, '3rem')}<div style="flex:1"><div class="mn">${esc(fullName(u))}</div><div class="ms">${u.username ? '@' + esc(u.username) : ''}</div></div><button class="btn flat">${t('Разблокировать')}</button></div>`); $('button', r).onclick = async () => { const j = await api('POST', `/api/users/${id}/block`, { block: false }); mergeUsers([j.user]); S.me.blocked = S.me.blocked.filter(x => x !== id); refreshPanels(); renderComposer(); }; body.appendChild(r); });
  });
}

function openAppearance() {
  pushPanel(t('Оформление чатов'), body => {
    body.innerHTML = '';
    const th = CFG.theme;
    const cards = el(`<div class="theme-cards">${[['auto', t('Авто'), 'linear-gradient(90deg,#fff 50%,#212121 50%)'], ['light', t('Светлая'), '#fff'], ['dark', t('Тёмная'), '#212121'], ['night', t('Ночная'), '#17212b']].map(([k, l, bg]) => `<div class="theme-card ${th === k ? 'sel' : ''}" data-k="${k}"><div class="pv" style="background:${bg}"><i style="background:${k === 'light' ? '#eee' : '#8884'}"></i><i class="r" style="background:var(--accent)"></i></div>${l}</div>`).join('')}</div>`);
    $$('.theme-card', cards).forEach(c => c.onclick = () => { setCfg({ theme: c.dataset.k }); refreshPanels(); });
    body.appendChild(sec(t('Тема'), cards));
    const accs = el(`<div class="color-grid">${ACCENTS.map(c => `<div class="color-dot ${(CFG.accent || '') === c ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('')}<label class="color-dot ${CFG.accent && !ACCENTS.includes(CFG.accent) ? 'sel' : ''}" style="background:conic-gradient(red,yellow,lime,aqua,blue,magenta,red);display:block"><input type="color" style="opacity:0;width:100%;height:100%;cursor:pointer" value="${CFG.accent || '#3390ec'}"></label><div class="color-dot" data-c="" style="background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--text2)">${t('авто')}</div></div>`);
    $$('.color-dot[data-c]', accs).forEach(d => d.onclick = () => { setCfg({ accent: d.dataset.c }); refreshPanels(); }); $('input[type=color]', accs).oninput = e => setCfg({ accent: e.target.value }); $('input[type=color]', accs).onchange = () => refreshPanels();
    body.appendChild(sec(t('Цвет акцента'), accs));
    const seg = (opts, cur, fn) => { const s = el(`<div class="seg">${opts.map(([k, l]) => `<button data-k="${k}" class="${cur === k ? 'on' : ''}">${l}</button>`).join('')}</div>`); $$('button', s).forEach(b => b.onclick = () => { fn(b.dataset.k); $$('button', s).forEach(x => x.classList.toggle('on', x === b)); }); return s; };
    body.appendChild(sec(t('Цвет исходящих сообщений'), seg([['classic', t('Классический')], ['accent', t('По цвету акцента')]], CFG.bubble, k => setCfg({ bubble: k }))));
    const walls = el(`<div class="wall-grid">${Object.keys(WALLS).map(k => `<div class="wall ${CFG.wall === k ? 'sel' : ''}" data-k="${k}" style="background:${k === 'default' ? 'linear-gradient(135deg,#dbddbb,#6ba587,#d5d88d,#88b884)' : WALLS[k]}"></div>`).join('')}<div class="wall ${CFG.wall === 'custom' ? 'sel' : ''}" data-k="custom" style="background:var(--bg2) ${CFG.wallImg ? `url('${CFG.wallImg}') center/cover` : ''};display:flex;align-items:center;justify-content:center;color:var(--text2)">${ic('image-plus')}</div></div>`);
    $$('.wall', walls).forEach(w => w.onclick = async () => { if (w.dataset.k === 'custom') { const [f] = await pickFile('image/*'); if (!f) return; const { blob } = await compressImage(f, 1920, .82); try { const up = await upload(blob, 'wall.jpg'); setCfg({ wall: 'custom', wallImg: up.url }); } catch (e) { return toast(errText(e)); } } else setCfg({ wall: w.dataset.k }); refreshPanels(); });
    body.appendChild(sec(t('Обои чата'), walls, switchRow(t('Узор из значков на фоне'), CFG.doodles, v => setCfg({ doodles: v })), switchRow(t('Анимированный фон'), CFG.wallAnim, v => setCfg({ wallAnim: v }))));
    const rng = (label, key, min, max, unit, fmtv) => { const r = el(`<div class="range"><div class="top"><span>${label}</span><b>${CFG[key]}${unit}</b></div><input type="range" min="${min}" max="${max}" value="${CFG[key]}"></div>`); $('input', r).oninput = e => { $('b', r).textContent = e.target.value + unit; setCfg({ [key]: +e.target.value }, { noSync: true }); }; $('input', r).onchange = e => setCfg({ [key]: +e.target.value }); return r; };
    body.appendChild(sec(t('Размеры'), rng(t('Размер текста'), 'fs', 12, 22, 'px'), rng(t('Скругление сообщений'), 'radius', 2, 20, 'px')));
    const quick = el(`<div class="emoji-grid">${['👍', '❤️', '🔥', '😁', '🎉', '😢', '🤔'].map(e => `<button data-e="${e}" class="${CFG.quick === e ? 'sel' : ''}">${e}</button>`).join('')}</div>`);
    $$('button', quick).forEach(b => b.onclick = () => { setCfg({ quick: b.dataset.e }); $$('button', quick).forEach(x => x.classList.toggle('sel', x === b)); });
    body.appendChild(sec(t('Быстрая реакция (двойной клик)'), quick));
    body.appendChild(sec(t('Поведение'), seg([['24', '24 ' + t('ч')], ['12', '12 ' + t('ч')]], CFG.time24 ? '24' : '12', k => setCfg({ time24: k === '24' })), el(`<div style="height:.4rem"></div>`), seg([['enter', 'Enter'], ['ctrl', 'Ctrl+Enter']], CFG.sendEnter ? 'enter' : 'ctrl', k => setCfg({ sendEnter: k === 'enter' })), note(t('Отправка сообщений: Enter — отправить, Shift+Enter — перенос строки.')), switchRow(t('Анимации интерфейса'), CFG.anim, v => setCfg({ anim: v })), switchRow(t('Крупные эмодзи'), CFG.bigEmoji, v => { setCfg({ bigEmoji: v }); S.cm && renderMessages(true); }), switchRow(t('Автовоспроизведение кружков'), CFG.autoplay, v => setCfg({ autoplay: v }))));
    body.appendChild(sec('', row('rotate-ccw', t('Сбросить оформление'), '', () => { setCfg({ theme: 'auto', accent: '', bubble: 'classic', wall: 'default', wallImg: '', doodles: true, wallAnim: true, fs: 16, radius: 12 }); refreshPanels(); })));
  }, { static: false });
}
function openData() {
  pushPanel(t('Данные и память'), body => {
    body.innerHTML = ''; const used = (JSON.stringify(localStorage).length / 1024).toFixed(1);
    body.appendChild(sec('', el(`<div class="sec-note">${t('Локально хранится: {n} КБ (настройки, черновики).', { n: used })}</div>`), row('trash-2', t('Удалить все черновики'), '', () => { S.drafts = {}; localStorage.setItem('gm_drafts', '{}'); renderChatList(); toast(t('Черновики удалены')); }), row('refresh-cw', t('Перезагрузить приложение'), '', () => location.reload()), row('check-check', t('Отметить все чаты прочитанными'), '', async () => { for (const c of Object.values(S.chats)) if (c.unread) await api('POST', `/api/chats/${c.id}/read`, { upTo: c.lastId }); toast(t('Готово')); })));
  });
}
async function openLanguage() {
  pushPanel(t('Язык'), body => {
    body.innerHTML = ''; [['ru', 'Русский'], ['en', 'English']].forEach(([k, l]) => { body.appendChild(row('', l, '', () => { setCfg({ lang: k }); LANG = k; location.reload(); }, { right: LANG === k ? `<span style="color:var(--accent)">${ic('check')}</span>` : '' })); });
  });
}
function openAbout() {
  pushPanel(t('О GeoMetric Beta'), body => {
    body.innerHTML = `<div style="text-align:center;padding:2rem 1rem 1rem"><div class="logo sm" style="margin:0 auto 1rem">${LOGO}</div><h2 style="margin:.2rem">GeoMetric <span class="beta">BETA</span></h2><div style="color:var(--text2)">v1.0 · ${t('мессенджер в реальном времени')}</div></div>`;
    body.appendChild(sec(t('Горячие клавиши'), el(`<div style="padding:.2rem 1.1rem 1rem;color:var(--text2);font-size:.92rem;line-height:1.9"><b>Enter</b> — ${t('отправить')} · <b>Shift+Enter</b> — ${t('новая строка')}<br><b>Ctrl+K</b> — ${t('поиск')} · <b>Esc</b> — ${t('закрыть/отмена')}<br><b>↑</b> — ${t('изменить последнее сообщение')}<br><b>Ctrl+B / I</b> — ${t('жирный / курсив')} · <b>Ctrl+Shift+X</b> — ${t('зачёркнутый')}<br><b>Ctrl+Shift+M</b> — ${t('моноширинный')} · <b>Ctrl+Shift+P</b> — ${t('спойлер')}<br>${t('Двойной клик по сообщению — быстрая реакция')}</div>`)));
    body.appendChild(sec(t('Форматирование'), el(`<div style="padding:.2rem 1.1rem 1rem;color:var(--text2);font-size:.92rem;line-height:1.9">**${t('жирный')}** · __${t('курсив')}__ · ~~${t('зачёркнутый')}~~ · \`${t('код')}\` · ||${t('спойлер')}||</div>`)));
  });
}

/* devices / QR */
async function openDevices() {
  pushPanel(t('Устройства'), async body => {
    body.innerHTML = `<div class="empty-list"><span class="spin"></span></div>`;
    try {
      const r = await api('GET', '/api/sessions'); body.innerHTML = '';
      const scan = el(`<div style="padding:1.2rem 1rem;text-align:center"><div class="logo sm" style="margin:0 auto .8rem;width:6rem;height:6rem">${ic('qr-code').replace('class="i', 'style="width:55%;height:55%" class="i')}</div><div style="color:var(--text2);margin-bottom:.8rem;font-size:.92rem">${t('Откройте GeoMetric Beta в браузере на компьютере, отсканируйте QR-код камерой — и вы войдёте без пароля.')}</div><button class="btn" id="dv-scan">${t('Подключить устройство')}</button></div>`);
      $('#dv-scan', scan).onclick = openQRScanner; body.appendChild(sec('', scan));
      const cur = r.sessions.find(s => s.current), others = r.sessions.filter(s => !s.current);
      const item = s => { const e = el(`<div class="sess"><div class="si">${ic(s.mobile ? 'smartphone' : 'monitor')}</div><div class="grow"><div class="d">${esc(s.device)}${s.current ? ` <span style="color:var(--accent);font-size:.8rem">· ${t('это устройство')}</span>` : ''}</div><div class="s">${esc(s.ip || '')} · ${s.current || s.online ? `<span style="color:var(--green)">${t('онлайн')}</span>` : esc(statusText({ lastSeen: s.active, online: false }))}</div></div>${s.current ? '' : `<button class="btn-icon" style="color:var(--danger)" title="${t('Завершить')}">${ic('x')}</button>`}</div>`); $('button', e)?.addEventListener('click', async () => { if (await confirmBox(t('Завершить сеанс на устройстве «{d}»?', { d: esc(s.device) }), { ok: t('Завершить'), danger: true })) { await api('DELETE', '/api/sessions/' + s.sid); refreshSessions(); } }); return e; };
      if (cur) body.appendChild(sec(t('Текущий сеанс'), item(cur)));
      if (others.length) { const o = sec(t('Активные сеансы'), ...others.map(item)); const kill = row('log-out', t('Завершить все другие сеансы'), '', async () => { if (await confirmBox(t('Завершить все остальные сеансы?'), { ok: t('Завершить'), danger: true })) { await api('DELETE', '/api/sessions'); refreshSessions(); } }, { danger: true }); o.appendChild(kill); body.appendChild(o); }
    } catch (e) { body.innerHTML = `<div class="empty-list">${errText(e)}</div>`; }
  });
}
function refreshSessions() { const p = panels.find(x => x.title === t('Устройства')); if (p) p.render(p.body, p); }

/* contacts, calls list */
async function openContacts() {
  pushPanel(t('Контакты'), async (body, pn) => {
    if (!pn.inited) { pn.inited = true; body.innerHTML = `<div style="padding:.5rem .8rem"><div class="search-box"><input id="ct-q" placeholder="${t('Поиск по имени или @username')}">${ic('search')}</div></div><div id="ct-list"></div>`; $('#ct-q', body).oninput = debounce(() => draw(), 250); }
    const draw = async () => {
      const q = $('#ct-q', body).value.trim().toLowerCase().replace(/^@/, ''); const box = $('#ct-list', body); await ensureUsers(S.me.contacts || []);
      const own = (S.me.contacts || []).map(U).filter(u => u && (!q || fullName(u).toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q)));
      let html = own.length ? `<div class="sect-title">${t('Мои контакты')}</div>` + own.map(u => userRow(u)).join('') : '';
      let found = []; if (q.length >= 2) { try { const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); mergeUsers(r.users); found = r.users.filter(u => !(S.me.contacts || []).includes(u.id)); } catch (e) { } }
      if (found.length) html += `<div class="sect-title">${t('Глобальный поиск')}</div>` + found.map(userRow).join('');
      if (!html) html = `<div class="empty-list">${q ? t('Ничего не найдено') : t('Контактов пока нет.<br>Найдите людей по @username и добавьте в контакты.')}</div>`;
      box.innerHTML = html; $$('.member', box).forEach(n => n.onclick = () => { closeAllPanels(); openPrivate(+n.dataset.u); });
    };
    const userRow = u => `<div class="member" data-u="${u.id}">${userAv(u, '3rem', { dot: true })}<div><div class="mn">${esc(fullName(u))}${verifiedBadge(u)}</div><div class="ms">${esc(statusText(u))}${u.username ? ' · @' + esc(u.username) : ''}</div></div></div>`;
    draw();
  }, { static: true, actions: [{ icon: 'user-plus', title: t('Добавить по @username'), onClick: async () => { const un = await promptBox(t('Добавить контакт'), { ph: '@username', ok: t('Найти') }); if (!un) return; try { const r = await api('GET', '/api/resolve/' + un.replace(/^@/, '')); if (r.type !== 'user') return toast(t('Пользователь не найден')); await api('POST', '/api/contacts/' + r.user.id); S.me.contacts = [...new Set([...(S.me.contacts || []), r.user.id])]; mergeUsers([r.user]); toast(t('Контакт добавлен')); closeTopPanel(); openContacts(); } catch (e) { toast(t('Пользователь не найден')); } } }] });
}
function openCallsList() {
  pushPanel(t('Звонки'), async body => {
    body.innerHTML = '<div class="empty-list"><span class="spin"></span></div>';
    const calls = []; for (const c of Object.values(S.chats)) if (c.type === 'private' && c.last && c.last.type === 'call') calls.push({ c, m: c.last });
    calls.sort((a, b) => b.m.ts - a.m.ts); body.innerHTML = calls.length ? '' : `<div class="empty-list">${t('Здесь появится история звонков')}</div>`;
    calls.forEach(({ c, m }) => { const u = U(c.peer); const miss = m.call.status === 'missed' && m.from !== S.me.id; const r = el(`<div class="member">${userAv(u, '3rem')}<div style="flex:1"><div class="mn" style="${miss ? 'color:var(--danger)' : ''}">${esc(fullName(u))}</div><div class="ms">${esc(callText(m))} · ${fmtListTime(m.ts)}</div></div><button class="btn-icon" style="color:var(--accent)">${ic(m.call.video ? 'video' : 'phone')}</button></div>`); $('button', r).onclick = e => { e.stopPropagation(); startCall(c.peer, !!m.call.video); }; r.onclick = () => { closeAllPanels(); openChat(c.id); }; body.appendChild(r); });
    body.appendChild(note(t('Показан последний звонок с каждым собеседником.')));
  }, { static: true });
}

/* ───────── new group / channel ───────── */
async function newGroupWizard(type) {
  const isCh = type === 'channel'; const sel = new Set(); let step = 1; const st = { avatar: '' };
  await ensureUsers([...(S.me.contacts || []), ...Object.values(S.chats).filter(c => c.type === 'private' && c.peer !== 1).map(c => c.peer)]);
  const cands = () => [...new Set([...(S.me.contacts || []), ...Object.values(S.chats).filter(c => c.type === 'private').map(c => c.peer)])].filter(id => id !== S.me.id && id !== 1).map(U).filter(Boolean);
  pushPanel(isCh ? t('Новый канал') : t('Новая группа'), (body, pn) => {
    if (step === 1) {
      body.innerHTML = `<div style="padding:.5rem .8rem"><div class="search-box"><input id="gw-q" placeholder="${t('Добавить участников')}">${ic('search')}</div></div><div class="chip-list" id="gw-chips"></div><div id="gw-list"></div><div style="padding:1rem"><button class="btn" id="gw-next" style="width:100%">${t('Далее')}</button></div>`;
      const draw = async () => {
        const q = $('#gw-q', body).value.trim().toLowerCase(); let list = cands().filter(u => !q || fullName(u).toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q));
        if (q.length >= 2) { try { const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); mergeUsers(r.users); r.users.forEach(u => { if (!list.some(x => x.id === u.id)) list.push(u); }); } catch (e) { } }
        $('#gw-list', body).innerHTML = list.map(u => `<div class="member" data-u="${u.id}">${userAv(u, '3rem')}<div style="flex:1"><div class="mn">${esc(fullName(u))}</div><div class="ms">${esc(statusText(u))}</div></div><span class="check" style="padding:0"><span class="box round" style="${sel.has(u.id) ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''}">${ic('check')}</span></span></div>`).join('') || `<div class="empty-list">${t('Никого не найдено')}</div>`;
        $$('#gw-list .member', body).forEach(n => n.onclick = () => { const id = +n.dataset.u; sel.has(id) ? sel.delete(id) : sel.add(id); draw(); });
        $('#gw-chips', body).innerHTML = [...sel].map(id => `<span class="chip" data-u="${id}">${userAv(U(id), '1.7rem')}${esc(U(id)?.name || '')} ✕</span>`).join(''); $$('.chip', body).forEach(c => c.onclick = () => { sel.delete(+c.dataset.u); draw(); });
      };
      draw(); $('#gw-q', body).oninput = debounce(draw, 250);
      $('#gw-next', body).onclick = () => { if (!sel.size && !isCh) return toast(t('Выберите хотя бы одного участника')); step = 2; pn.render(body, pn); };
    } else {
      body.innerHTML = `<div style="padding:1.2rem 1.1rem;display:flex;flex-direction:column;align-items:center"><div class="av-pick" id="gw-av"><div id="gw-av-prev">${avatarHTML({ name: '?', color: 2 }, '7rem')}</div><div class="cam">${ic('camera').replace('class="i', 'style="width:2rem;height:2rem" class="i')}</div></div>
      <div class="field" style="max-width:none"><input id="gw-title" placeholder=" " maxlength="64"><label>${isCh ? t('Название канала') : t('Название группы')}</label></div>
      <div class="field" style="max-width:none"><textarea id="gw-about" placeholder=" " rows="2" maxlength="255"></textarea><label>${t('Описание (необязательно)')}</label></div>
      <div class="field" style="max-width:none"><input id="gw-user" placeholder=" " maxlength="32" autocapitalize="off"><label>${t('Публичная ссылка @username (необязательно)')}</label><div class="hint" id="gw-user-h">${t('Публичные чаты можно найти через поиск')}</div></div>
      <div style="color:var(--text2);font-size:.9rem;align-self:flex-start">${sel.size} ${pl(sel.size, 'участник', 'участника', 'участников')}</div><button class="btn" id="gw-create" style="width:100%;margin-top:1rem">${t('Создать')}</button></div>`;
      $('#gw-av', body).onclick = async () => { const [f] = await pickFile('image/*'); if (!f) return; const b = await cropAvatar(f); if (!b) return; const up = await upload(b, 'a.jpg'); st.avatar = up.url; $('#gw-av-prev', body).innerHTML = avatarHTML({ name: 'x', avatar: up.url }, '7rem'); };
      bindUsernameCheck($('#gw-user', body), $('#gw-user-h', body));
      $('#gw-title', body).oninput = e => { if (!st.avatar) $('#gw-av-prev', body).innerHTML = avatarHTML({ name: e.target.value || '?', color: 2 }, '7rem'); };
      $('#gw-create', body).onclick = async () => {
        const title = $('#gw-title', body).value.trim(); if (!title) return toast(t('Введите название')); const b = $('#gw-create', body); b.disabled = true;
        try { const r = await api('POST', '/api/chats', { type, title, about: $('#gw-about', body).value, avatar: st.avatar, username: $('#gw-user', body).value.trim().replace(/^@/, ''), members: [...sel] }); upsertChat(r.chat); closeAllPanels(); openChat(r.chat.id); }
        catch (e) { toast(errText(e)); b.disabled = false; }
      };
    }
  }, { static: true });
}

/* ───────── info panel (right) ───────── */
S.info = null;
function toggleInfo() { if (document.body.classList.contains('info-open')) closeInfo(); else { const c = S.chats[S.active]; if (c) openInfo(c.type === 'private' || c.type === 'saved' ? { type: 'user', id: c.peer } : { type: 'chat', id: c.id }); } }
function closeInfo() { document.body.classList.remove('info-open'); S.info = null; }
function updateInfoIfOpen() { if (S.info && document.body.classList.contains('info-open')) renderInfo(); }
async function openUserProfile(uid, user) {
  if (user) mergeUsers([user]); if (!U(uid)) await ensureUsers([uid]);
  openInfo({ type: 'user', id: uid });
}
function openInfo(target) { S.info = { ...target, tab: S.info && S.info.id === target.id ? S.info.tab : null }; document.body.classList.add('info-open'); renderInfo(); }
async function renderInfo() {
  const box = $('#info'); const inf = S.info; if (!inf) return;
  const inner = el(`<div class="info-inner"><div class="info-head"><button class="btn-icon" id="inf-x">${ic('x')}</button><div class="grow">${inf.type === 'user' ? t('Профиль') : t('Информация')}</div><button class="btn-icon hidden" id="inf-edit">${ic('pencil')}</button><button class="btn-icon" id="inf-more" data-menu-keep>${ic('ellipsis-vertical')}</button></div><div class="info-body scroll" id="inf-body"></div></div>`);
  box.innerHTML = ''; box.appendChild(inner); $('#inf-x', inner).onclick = closeInfo;
  const body = $('#inf-body', inner);
  let chat = inf.type === 'chat' ? S.chats[inf.id] : Object.values(S.chats).find(c => (c.type === 'private' || c.type === 'saved') && c.peer === inf.id && (inf.id !== S.me.id || c.type === 'saved'));
  if (inf.type === 'user') {
    const u = U(inf.id); if (!u) return; const me = u.id === S.me.id;
    body.innerHTML = `<div class="info-top"><div class="pc-bg" style="position:absolute;inset:0;background:${pcBg(u.color)}"></div><div class="pc-pat" style="position:absolute;inset:0;opacity:.18;background-size:70px;background-image:${doodleSVG('#fff')}"></div><div style="position:relative">${userAv(u, '8rem', { dot: true })}<div class="nm">${esc(fullName(u))}${verifiedBadge(u)}${u.emoji ? ' ' + esc(u.emoji) : ''}</div><div class="st">${me ? t('это вы') : esc(statusText(u))}</div></div></div>`;
    $('.avatar', body).onclick = () => u.avatar && viewAvatar(u.avatar);
    const acts = []; if (!me && !u.bot && !u.deleted) acts.push(['phone', t('Звонок'), () => startCall(u.id, false)], ['video', t('Видео'), () => startCall(u.id, true)]);
    if (!chat && !me) acts.unshift(['message-circle', t('Написать'), () => openPrivate(u.id)]);
    if (me) acts.push(['pen-line', t('Изменить'), () => openEditProfile()]);
    if (!u.deleted) acts.push(['qr-code', 'QR', () => showUserQR(u)]);
    if (chat && !me) acts.push([isMuted(chat) ? 'bell' : 'bell-off', isMuted(chat) ? t('Включить') : t('Выкл. звук'), () => chatState(chat, { muted: !isMuted(chat) })]);
    if (acts.length) { $('.info-top > div:last-child', body).insertAdjacentHTML('beforeend', `<div class="pc-actions">${acts.map((a, i) => `<button data-i="${i}">${ic(a[0])}<span>${a[1]}</span></button>`).join('')}</div>`); $$('.pc-actions button', body).forEach(b => b.onclick = () => acts[+b.dataset.i][2]()); }
    const lines = el('<div class="sec"></div>');
    if (u.bio) lines.appendChild(el(`<div class="info-line noh">${ic('info')}<div><div class="v">${fmt(u.bio)}</div><div class="l">${t('О себе')}</div></div></div>`));
    if (u.username) { const l = el(`<div class="info-line">${ic('at-sign')}<div><div class="v">@${esc(u.username)}</div><div class="l">${t('Имя пользователя')}</div></div></div>`); l.onclick = () => copyText('@' + u.username); lines.appendChild(l); }
    if (u.bot && u.botDesc) lines.appendChild(el(`<div class="info-line noh">${ic('bot')}<div><div class="v">${fmt(u.botDesc)}</div><div class="l">${t('Бот')}</div></div></div>`));
    if (!u.deleted && (u.username || me)) { const l = el(`<div class="info-line">${ic('link')}<div><div class="v" style="word-break:break-all">${esc(userLink(u).replace(/^https?:\/\//, ''))}</div><div class="l">${t('Ссылка на профиль')}</div></div></div>`); l.onclick = () => copyText(userLink(u)); lines.appendChild(l); }
    if (u.birthday) lines.appendChild(el(`<div class="info-line noh">${ic('cake-slice')}<div><div class="v">${esc(fmtBirthday(u.birthday))}</div><div class="l">${t('День рождения')}</div></div></div>`));
    if (me && u.email) lines.appendChild(el(`<div class="info-line noh">${ic('mail')}<div><div class="v">${esc(u.email)}</div><div class="l">E-mail</div></div></div>`));
    if (chat && !me) { const sw = el(`<label class="info-sw">${ic('bell')}<span class="grow">${t('Уведомления')}</span><span class="switch"><input type="checkbox" ${!isMuted(chat) ? 'checked' : ''}><span></span></span></label>`); $('input', sw).onchange = e => chatState(chat, { muted: !e.target.checked }); lines.appendChild(sw); }
    body.appendChild(lines);
    if (!me && !u.bot && !u.deleted) { const o = el('<div class="sec"></div>'); o.appendChild(row(u.isContact ? 'user-round' : 'user-plus', u.isContact ? t('Удалить из контактов') : t('Добавить в контакты'), '', async () => { if (u.isContact) { await api('DELETE', '/api/contacts/' + u.id); u.isContact = false; S.me.contacts = (S.me.contacts || []).filter(x => x !== u.id); } else { await api('POST', '/api/contacts/' + u.id); u.isContact = true; S.me.contacts = [...(S.me.contacts || []), u.id]; } renderInfo(); })); o.appendChild(row('ban', u.blockedByMe ? t('Разблокировать') : t('Заблокировать'), '', () => toggleBlock(u), { danger: true })); body.appendChild(o); }
    if (!me && !u.deleted && !u.system) { const o2 = el('<div class="sec"></div>'); o2.appendChild(row('flag', t('Пожаловаться'), '', () => reportDialog({ kind: 'user', target: u.id }), { danger: true })); body.appendChild(o2); }
    $('#inf-more', inner).classList.add('hidden');
  } else {
    const c = chat; if (!c) return closeInfo(); const admin = c.me.role !== 'member';
    body.innerHTML = `<div class="info-top" style="background:${pcBg(hashN(c.id) % 8)}"><div class="pc-pat" style="position:absolute;inset:0;opacity:.18;background-size:70px;background-image:${doodleSVG('#fff')}"></div><div style="position:relative">${chatAv(c, '8rem')}<div class="nm">${chatBadge(c)}${esc(c.title)}</div><div class="st">${c.count} ${c.type === 'channel' ? pl(c.count, 'подписчик', 'подписчика', 'подписчиков') : pl(c.count, 'участник', 'участника', 'участников')}</div></div></div>`;
    $('.avatar', body).onclick = () => c.avatar && viewAvatar(c.avatar);
    const lines = el('<div class="sec"></div>');
    if (c.about) lines.appendChild(el(`<div class="info-line noh">${ic('info')}<div><div class="v">${fmt(c.about)}</div><div class="l">${t('Описание')}</div></div></div>`));
    if (c.username) { const l = el(`<div class="info-line">${ic('link')}<div><div class="v">@${esc(c.username)}</div><div class="l">${t('Публичная ссылка')}</div></div></div>`); l.onclick = () => copyText(chatLink(c)); lines.appendChild(l); }
    if (chatLink(c)) { const l = el(`<div class="info-line">${ic('qr-code')}<div><div class="v">${t('QR-код и ссылка')}</div><div class="l">${esc(chatLink(c).replace(/^https?:\/\//, ''))}</div></div></div>`); l.onclick = () => showChatQR(c); lines.appendChild(l); }
    if (c.invite) { const l = el(`<div class="info-line">${ic('link')}<div><div class="v" style="word-break:break-all">${location.origin}/?invite=${c.invite}</div><div class="l">${t('Ссылка-приглашение (нажмите, чтобы скопировать)')}</div></div></div>`); l.onclick = () => copyText(`${location.origin}/?invite=${c.invite}`); lines.appendChild(l); }
    const sw = el(`<label class="info-sw">${ic('bell')}<span class="grow">${t('Уведомления')}</span><span class="switch"><input type="checkbox" ${!isMuted(c) ? 'checked' : ''}><span></span></span></label>`); $('input', sw).onchange = e => chatState(c, { muted: !e.target.checked }); lines.appendChild(sw);
    body.appendChild(lines);
    if (admin) { const e = $('#inf-edit', inner); e.classList.remove('hidden'); e.onclick = () => groupEditDialog(c); }
    $('#inf-more', inner).onclick = () => popMenu([admin && { icon: 'pencil', label: t('Изменить'), onClick: () => groupEditDialog(c) }, { icon: 'flag', danger: true, label: t('Пожаловаться'), onClick: () => reportDialog({ kind: 'chat', target: c.id }) }, { icon: 'trash-2', danger: true, label: t('Покинуть'), onClick: () => deleteChatDialog(c) }], { el: $('#inf-more', inner), right: true });
  }
  /* tabs */
  const hasShared = chat && inf.type !== 'x'; if (!hasShared && inf.type === 'user') return;
  const isGroup = inf.type === 'chat' && chat.type === 'group'; const tabs = [...(isGroup || (inf.type === 'chat' && chat.type === 'channel' && chat.me.role !== 'member') ? [['members', t('Участники')]] : []), ['media', t('Медиа')], ['files', t('Файлы')], ['voice', t('Голос')], ['links', t('Ссылки')]];
  if (!inf.tab || !tabs.some(x => x[0] === inf.tab)) inf.tab = tabs[0][0];
  const tabsEl = el(`<div class="tabs">${tabs.map(([k, l]) => `<button data-k="${k}" class="${inf.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`); body.appendChild(tabsEl);
  const content = el('<div id="inf-tab"></div>'); body.appendChild(content);
  $$('button', tabsEl).forEach(b => b.onclick = () => { inf.tab = b.dataset.k; $$('button', tabsEl).forEach(x => x.classList.toggle('on', x === b)); loadTab(chat, content); });
  loadTab(chat, content);
}
async function loadTab(chat, box) {
  const tab = S.info.tab; box.innerHTML = '<div class="empty-list"><span class="spin"></span></div>';
  try {
    if (tab === 'members') {
      const r = await api('GET', `/api/chats/${encodeURIComponent(chat.id)}/members`); mergeUsers(r.users); if (S.info?.tab !== tab) return; box.innerHTML = '';
      if (chat.type === 'group' || chat.me.role !== 'member') { const add = el(`<button class="row-item" style="color:var(--accent)">${ic('user-plus').replace('class="i', 'style="color:var(--accent)" class="i')}<span class="grow">${t('Добавить участников')}</span></button>`); add.onclick = () => addMembersDialog(chat, r.members.map(m => m.id)); box.appendChild(add); }
      r.members.sort((a, b) => ({ owner: 0, admin: 1, member: 2 }[a.role] - { owner: 0, admin: 1, member: 2 }[b.role]));
      r.members.forEach(m => { const u = U(m.id); const n = el(`<div class="member" data-u="${m.id}">${userAv(u, '3rem', { dot: true })}<div style="min-width:0"><div class="mn">${esc(fullName(u))}${m.id === S.me.id ? ' (' + t('вы') + ')' : ''}</div><div class="ms">${esc(statusText(u))}</div></div>${m.role !== 'member' ? `<span class="role">${m.role === 'owner' ? t('владелец') : t('админ')}</span>` : ''}</div>`); n.onclick = () => openUserProfile(m.id); n.oncontextmenu = e => { e.preventDefault(); memberMenu(chat, m, e); }; bindLongPress(n, e => memberMenu(chat, m, e)); box.appendChild(n); });
      return;
    }
    const r = await api('GET', `/api/chats/${encodeURIComponent(chat.id)}/shared?type=${tab}`); if (S.info?.tab !== tab) return; await ensureUsers(r.messages.map(m => m.from));
    if (!r.messages.length) { box.innerHTML = `<div class="empty-list">${t('Здесь пока пусто')}</div>`; return; }
    if (tab === 'media') { box.innerHTML = `<div class="media-grid">${r.messages.map(m => `<div class="mi" data-id="${m.id}" style="${m.type === 'photo' ? `background-image:url('${esc(m.media.url)}')` : ''}">${m.type === 'video' ? `<video src="${esc(m.media.url)}#t=0.1" preload="metadata" muted></video><span class="dur">${fmtDur(m.media.duration)}</span>` : ''}</div>`).join('')}</div>`; $$('.mi', box).forEach(n => n.onclick = async () => { const id = +n.dataset.id; if (S.cm?.list.some(x => x.id === id)) openViewer(id); else { await openChat(chat.id, { around: id, force: true, noFocus: true }); openViewer(id); } }); }
    else if (tab === 'files') { box.innerHTML = ''; r.messages.forEach(m => { const a = el(`<a class="member" href="${esc(m.media.url)}?dl=1" download="${esc(m.media.name)}" style="color:inherit;text-decoration:none"><div class="avatar av5" style="--s:3rem">${ic('file-text')}</div><div style="min-width:0"><div class="mn" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.media.name)}</div><div class="ms">${fmtSize(m.media.size)} · ${fmtListTime(m.ts)}</div></div></a>`); box.appendChild(a); }); }
    else if (tab === 'voice') { box.innerHTML = ''; r.messages.forEach(m => { const a = el(`<div class="member"><div class="avatar av3" style="--s:3rem">${ic(m.type === 'circle' ? 'video' : 'mic')}</div><div><div class="mn">${esc(fullName(U(m.from)))}</div><div class="ms">${fmtDur(m.media.duration)} · ${fmtListTime(m.ts)}</div></div></div>`); a.onclick = () => openChat(chat.id, { around: m.id, force: true, noFocus: true }); box.appendChild(a); }); }
    else { box.innerHTML = ''; r.messages.forEach(m => { const urls = (m.text.match(/https?:\/\/[^\s]+/g) || []); const a = el(`<div class="link-row">${urls.map(u => `<a class="u" href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join('<br>')}<div style="color:var(--text2);font-size:.82rem;margin-top:.2rem">${esc(plain(m.text).slice(0, 80))}</div></div>`); box.appendChild(a); }); }
  } catch (e) { box.innerHTML = `<div class="empty-list">${errText(e)}</div>`; }
}
function memberMenu(chat, m, e) {
  if (m.id === S.me.id) return; const owner = chat.me.role === 'owner', admin = chat.me.role !== 'member';
  popMenu([{ icon: 'user', label: t('Профиль'), onClick: () => openUserProfile(m.id) }, { icon: 'message-circle', label: t('Написать'), onClick: () => openPrivate(m.id) }, owner && m.role !== 'owner' && { icon: 'badge-check', label: m.role === 'admin' ? t('Снять права админа') : t('Сделать админом'), onClick: async () => { await api('POST', `/api/chats/${encodeURIComponent(chat.id)}/admins`, { userId: m.id, admin: m.role !== 'admin' }); loadTab(chat, $('#inf-tab')); } }, admin && m.role !== 'owner' && !(m.role === 'admin' && !owner) && { icon: 'user-round', danger: true, label: t('Удалить из группы'), onClick: async () => { if (await confirmBox(t('Удалить {n} из группы?', { n: esc(fullName(U(m.id))) }), { ok: t('Удалить'), danger: true })) { await api('DELETE', `/api/chats/${encodeURIComponent(chat.id)}/members/${m.id}`); loadTab(chat, $('#inf-tab')); } } }], { x: e.clientX, y: e.clientY });
}
async function addMembersDialog(chat, existing) {
  await ensureUsers([...(S.me.contacts || []), ...Object.values(S.chats).filter(c => c.type === 'private').map(c => c.peer)]); const sel = new Set();
  const list = [...new Set([...(S.me.contacts || []), ...Object.values(S.chats).filter(c => c.type === 'private').map(c => c.peer)])].filter(id => id !== 1 && id !== S.me.id && !existing.includes(id)).map(U).filter(Boolean);
  const body = el(`<div style="margin:0 -1.25rem">${list.map(u => `<div class="member" data-u="${u.id}">${userAv(u, '2.8rem')}<div class="mn" style="flex:1">${esc(fullName(u))}</div><span class="check" style="padding:0"><span class="box round">${ic('check')}</span></span></div>`).join('') || `<div class="empty-list">${t('Нет доступных контактов. Поделитесь ссылкой-приглашением.')}</div>`}</div>`);
  $$('.member', body).forEach(n => n.onclick = () => { const id = +n.dataset.u; sel.has(id) ? sel.delete(id) : sel.add(id); const b = $('.box', n); b.style.cssText = sel.has(id) ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''; });
  modal({ title: t('Добавить участников'), body, buttons: [{ label: t('Отмена') }, { label: t('Добавить'), onClick: async () => { try { const r = await api('POST', `/api/chats/${encodeURIComponent(chat.id)}/members`, { userIds: [...sel] }); toast(t('Добавлено: {n}', { n: r.added.length })); loadTab(chat, $('#inf-tab')); } catch (e) { toast(errText(e)); } } }] });
}
function groupEditDialog(c) {
  const st = { avatar: c.avatar };
  const body = el(`<div style="display:flex;flex-direction:column;align-items:center"><div class="av-pick" id="ge-av"><div id="ge-prev">${chatAv(c, '7rem')}</div><div class="cam">${ic('camera').replace('class="i', 'style="width:2rem;height:2rem" class="i')}</div></div>
  <div class="field" style="max-width:none"><input id="ge-t" placeholder=" " maxlength="64" value="${esc(c.title)}"><label>${t('Название')}</label></div><div class="field" style="max-width:none"><textarea id="ge-a" placeholder=" " rows="2" maxlength="255">${esc(c.about || '')}</textarea><label>${t('Описание')}</label></div>
  <div class="field" style="max-width:none"><input id="ge-u" placeholder=" " maxlength="32" value="${esc(c.username || '')}" autocapitalize="off"><label>@username</label><div class="hint" id="ge-uh"></div></div>
  ${c.invite ? `<button class="btn flat" id="ge-reset" style="align-self:flex-start;padding-left:0">${ic('refresh-cw')} ${t('Сбросить ссылку-приглашение')}</button>` : ''}
  ${c.me.role === 'owner' ? `<button class="btn flat danger" id="ge-del" style="align-self:flex-start;padding-left:0">${ic('trash-2')} ${t('Удалить для всех')}</button>` : ''}</div>`);
  $('#ge-av', body).onclick = async () => { const [f] = await pickFile('image/*'); if (!f) return; const b = await cropAvatar(f); if (!b) return; const up = await upload(b, 'a.jpg'); st.avatar = up.url; $('#ge-prev', body).innerHTML = avatarHTML({ name: c.title, avatar: up.url }, '7rem'); };
  bindUsernameCheck($('#ge-u', body), $('#ge-uh', body), c.id, c.username);
  $('#ge-reset', body)?.addEventListener('click', async () => { await api('POST', `/api/chats/${encodeURIComponent(c.id)}/invite/reset`); toast(t('Ссылка обновлена')); });
  const m = modal({ title: t('Изменить'), body, buttons: [{ label: t('Отмена') }, { label: t('Сохранить'), onClick: async () => { try { const r = await api('PATCH', `/api/chats/${encodeURIComponent(c.id)}`, { title: $('#ge-t', body).value, about: $('#ge-a', body).value, avatar: st.avatar, username: $('#ge-u', body).value.trim().replace(/^@/, '') }); upsertChat(r.chat); } catch (e) { toast(errText(e)); return false; } } }] });
  $('#ge-del', body)?.addEventListener('click', async () => { if (await confirmBox(t('Удалить «{n}» для всех участников? Это нельзя отменить.', { n: esc(c.title) }), { ok: t('Удалить'), danger: true })) { await api('DELETE', `/api/chats/${encodeURIComponent(c.id)}?destroy=1`); m.close(); } });
}
