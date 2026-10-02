/* GeoMetric Beta — оболочка приложения, список чатов, сокет-события, просмотр сообщений */
'use strict';
const NAME_COLORS = ['#e17076', '#e8a45b', '#a695e7', '#6bc153', '#42b8bd', '#5aa3e0', '#ee7aae', '#d4596a'];

function buildApp() {
  $('#root').innerHTML = `<div id="app">
  <aside id="sidebar">
    <div class="sb-head"><button class="btn-icon" id="btn-menu" title="${t('Меню')}">${ic('menu')}</button>
      <div class="search-box"><input id="search" placeholder="${t('Поиск')}" autocomplete="off">${ic('search')}</div>
      <button class="btn-icon hidden" id="search-x">${ic('x')}</button></div>
    <div class="folders" id="folders"></div>
    <div class="chatlist scroll" id="chatlist"></div>
    <div class="fab" id="fab"><button id="fab-btn" title="${t('Новое сообщение')}">${ic('pencil')}</button></div>
    <div id="resizer"></div>
  </aside>
  <main id="main"><div class="wallpaper"></div><div id="main-body"></div></main>
  <aside id="info"></aside></div>`;
  $('#sidebar').style.width = CFG.sbw + 'px'; applyTheme();
  $('#btn-menu').onclick = openDrawer;
  $('#fab-btn').onclick = e => popMenu([{ icon: 'megaphone', label: t('Новый канал'), onClick: () => newGroupWizard('channel') }, { icon: 'users', label: t('Новая группа'), onClick: () => newGroupWizard('group') }, { icon: 'user', label: t('Новый чат'), onClick: openContacts }], { el: $('#fab-btn'), right: true });
  const si = $('#search'); si.oninput = () => { S.query = si.value.trim(); $('#search-x').classList.toggle('hidden', !si.value); doSearch(); };
  $('#search-x').onclick = () => { si.value = ''; S.query = ''; $('#search-x').classList.add('hidden'); renderChatList(); };
  si.onkeydown = e => { if (e.key === 'Escape') $('#search-x').click(); };
  initResizer(); renderFolders(); renderChatList(); showEmptyMain();
  document.addEventListener('keydown', globalKeys);
}
function initResizer() {
  const r = $('#resizer'); let drag = false;
  r.onmousedown = e => { drag = true; e.preventDefault(); document.body.style.userSelect = 'none'; };
  document.addEventListener('mousemove', e => { if (!drag) return; const w = Math.max(300, Math.min(e.clientX, innerWidth * .4)); $('#sidebar').style.width = w + 'px'; CFG.sbw = w; });
  document.addEventListener('mouseup', () => { if (drag) { drag = false; document.body.style.userSelect = ''; setCfg({ sbw: CFG.sbw }); } });
}
function globalKeys(e) {
  if (e.key === 'Escape' && !$('.modal-back') && !$('.viewer') && !openMenu) { if (S.selMode) return exitSelect(); if (S.reply || S.edit) return cancelReplyEdit(); if ($('.panel')) return closeTopPanel(); if (document.body.classList.contains('info-open')) return closeInfo(); if (S.active && !document.activeElement?.matches('input,textarea')) closeChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#search')?.focus(); }
}
function showEmptyMain() {
  $('#main-body').innerHTML = `<div class="main-empty" style="position:absolute;inset:0;z-index:1"><div class="logo sm" style="margin:0;box-shadow:0 10px 30px rgba(0,0,0,.25)">${LOGO}</div><span>${t('Выберите чат, чтобы начать общение')}</span></div>`;
}

/* ───────── chat list ───────── */
function sortedChats() {
  return Object.values(S.chats).filter(c => !c.me.left && !c.me.hidden).sort((a, b) => (b.me.pinned ? 1 : 0) - (a.me.pinned ? 1 : 0) || (b.me.pinned - a.me.pinned) || chatTs(b) - chatTs(a));
}
const chatTs = c => c.last ? c.last.ts : c.created || 0;
function folderFilter(c) {
  switch (S.folder) {
    case 'personal': return (c.type === 'private' || c.type === 'saved') && !c.me.archived;
    case 'groups': return c.type === 'group' && !c.me.archived;
    case 'channels': return c.type === 'channel' && !c.me.archived;
    case 'unread': return !c.me.archived && (c.unread > 0 || c.me.markedUnread);
    case 'archived': return c.me.archived;
    default: return !c.me.archived;
  }
}
function renderFolders() {
  const all = Object.values(S.chats), cnt = f => all.filter(c => !c.me.archived && !isMuted(c) && (f === 'all' || (f === 'personal' ? ['private', 'saved'].includes(c.type) : f === 'groups' ? c.type === 'group' : c.type === 'channel')) ).reduce((a, c) => a + (c.unread > 0 ? 1 : 0), 0);
  const F = [['all', t('Все')], ['personal', t('Личные')], ['groups', t('Группы')], ['channels', t('Каналы')], ['unread', t('Непрочитанные')]];
  if (all.some(c => c.me.archived) || S.folder === 'archived') F.push(['archived', t('Архив')]);
  const box = $('#folders'); if (!box) return;
  box.innerHTML = F.map(([k, l]) => { const n = k === 'unread' || k === 'archived' ? 0 : cnt(k); return `<button class="folder ${S.folder === k ? 'active' : ''}" data-f="${k}">${l}${n ? `<span class="cnt">${n}</span>` : ''}</button>`; }).join('');
  $$('.folder', box).forEach(b => b.onclick = () => { S.folder = b.dataset.f; renderFolders(); renderChatList(); });
}
function previewText(m, chat) {
  if (!m) return '';
  switch (m.type) {
    case 'photo': return '🖼 ' + (m.text ? plain(m.text) : t('Фото'));
    case 'video': return '🎬 ' + (m.text ? plain(m.text) : t('Видео'));
    case 'voice': return '🎤 ' + t('Голосовое сообщение') + ' ' + fmtDur(m.media?.duration);
    case 'circle': return '📹 ' + t('Видеосообщение');
    case 'file': return '📎 ' + (m.media?.name || t('Файл'));
    case 'sticker': return (m.sticker || '') + ' ' + t('Стикер');
    case 'location': return '📍 ' + t('Геопозиция');
    case 'poll': return '📊 ' + (m.poll?.q || t('Опрос'));
    case 'call': return callText(m);
    case 'service': return serviceText(m, true);
    default: return plain(m.text).replace(/\s+/g, ' ');
  }
}
function callText(m) {
  const mine = m.from === S.me.id, st = m.call.status, v = m.call.video;
  if (st === 'missed') return mine ? t('Отменённый звонок') : t('Пропущенный звонок');
  if (st === 'declined') return mine ? t('Отклонённый звонок') : t('Отклонённый звонок');
  return (mine ? (v ? t('Исходящий видеозвонок') : t('Исходящий звонок')) : (v ? t('Входящий видеозвонок') : t('Входящий звонок')));
}
function serviceText(m, short) {
  const s = m.service || {}, who = id => id === S.me.id ? t('Вы') : fullName(U(id)); const a = who(m.from), c = S.chats[m.chatId];
  switch (s.action) {
    case 'create': return s.type === 'channel' ? t('Канал создан') : t('{a} создал(а) группу', { a });
    case 'add': return s.user === m.from ? t('{a} вступил(а) в группу', { a }) : t('{a} добавил(а) {b}', { a, b: who(s.user) });
    case 'remove': return t('{a} удалил(а) {b}', { a, b: who(s.user) });
    case 'leave': return t('{a} покинул(а) группу', { a: who(s.user) });
    case 'join': return t('{a} присоединился(лась)', { a });
    case 'title': return t('{a} изменил(а) название на «{n}»', { a, n: s.title });
    case 'avatar': return t('{a} изменил(а) фото', { a });
    case 'pin': return t('{a} закрепил(а) сообщение', { a });
  }
  return '';
}
function chatItemHTML(c) {
  const last = c.last, mine = last && last.from === S.me.id; const typ = typingText(c.id, true);
  let pv = '', pre = '';
  const draft = S.drafts[c.id];
  if (typ) pv = `<span class="typing">${typ}</span>`;
  else if (draft && S.active !== c.id) pv = `<span class="you" style="color:var(--danger)">${t('Черновик')}:</span> ${esc(draft.slice(0, 80))}`;
  else if (last) {
    if (last.type !== 'service' && last.type !== 'call') { if (mine && c.type !== 'saved') pre = `<span class="you">${t('Вы')}: </span>`; else if (c.type === 'group' && !mine) pre = `<span class="you">${esc(U(last.from)?.name || '')}: </span>`; }
    pv = pre + esc(previewText(last, c));
  } else pv = c.type === 'saved' ? t('Сохраняйте здесь заметки и файлы') : '';
  const check = mine && c.type !== 'saved' && last.type !== 'service' ? ic(last.id <= c.peerRead ? 'check-check' : 'check') : '';
  const unread = c.unread > 0 ? `<span class="badge ${isMuted(c) ? 'muted' : ''}">${c.unread > 99 ? '99+' : c.unread}</span>` : (c.me.markedUnread ? '<span class="badge"></span>' : '');
  const pin = c.me.pinned && !unread ? `<span class="badge pin">${ic('pin')}</span>` : '';
  const icon = c.type === 'channel' ? ic('megaphone') : c.type === 'group' ? ic('users') : '';
  return `<div class="chat ${S.active === c.id ? 'active' : ''}" data-id="${esc(c.id)}">${chatAv(c, '3.375rem', { dot: true })}<div class="chat-body"><div class="row"><div class="chat-name">${icon}${chatBadge(c)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(chatTitle(c))}</span>${c.type === 'private' ? verifiedBadge(U(c.peer)) : ''}${isMuted(c) ? ic('bell-off') : ''}</div><div class="chat-time">${check}${last ? fmtListTime(last.ts) : ''}</div></div><div class="row"><div class="chat-last">${pv}</div><div class="badges">${unread}${pin}</div></div></div></div>`;
}
function renderChatList() {
  const box = $('#chatlist'); if (!box) return; renderFolders(); updateTitle();
  if (S.query) return renderSearchResults();
  const list = sortedChats().filter(folderFilter);
  let html = '';
  if (S.folder === 'all') { const arch = Object.values(S.chats).filter(c => c.me.archived); if (arch.length) { const un = arch.filter(c => c.unread > 0 && !isMuted(c)).length; html += `<div class="archive-row" id="arch-row"><div class="ico">${ic('archive')}</div><div style="flex:1"><b>${t('Архив')}</b><div style="color:var(--text2);font-size:.9rem">${arch.length} ${pl(arch.length, 'чат', 'чата', 'чатов')}</div></div>${un ? `<span class="badge muted">${un}</span>` : ''}</div>`; } }
  html += list.map(chatItemHTML).join('');
  if (!list.length) html += `<div class="empty-list">${S.folder === 'all' ? t('У вас пока нет чатов.<br>Нажмите ✎ внизу, чтобы начать общение.') : t('В этой папке пока ничего нет')}</div>`;
  const st = box.scrollTop; box.innerHTML = html; box.scrollTop = st;
  $$('.chat', box).forEach(n => { n.onclick = () => openChat(n.dataset.id); n.oncontextmenu = e => { e.preventDefault(); chatMenu(S.chats[n.dataset.id], e); }; bindLongPress(n, e => chatMenu(S.chats[n.dataset.id], e)); });
  $('#arch-row')?.addEventListener('click', () => { S.folder = 'archived'; renderChatList(); });
}
function bindLongPress(node, fn) {
  let tm, sx, sy;
  node.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; tm = setTimeout(() => { tm = null; fn({ clientX: sx, clientY: sy, preventDefault() { } }); }, 480); }, { passive: true });
  node.addEventListener('touchmove', e => { if (tm && (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8)) { clearTimeout(tm); tm = null; } }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev => node.addEventListener(ev, () => { clearTimeout(tm); }));
}
function chatMenu(c, e) {
  popMenu([
    { icon: c.me.pinned ? 'pin-off' : 'pin', label: c.me.pinned ? t('Открепить') : t('Закрепить'), onClick: () => chatState(c, { pinned: !c.me.pinned }) },
    { icon: isMuted(c) ? 'bell' : 'bell-off', label: isMuted(c) ? t('Включить уведомления') : t('Выключить уведомления'), onClick: () => chatState(c, { muted: !isMuted(c) }) },
    { icon: 'archive', label: c.me.archived ? t('Вернуть из архива') : t('В архив'), onClick: () => chatState(c, { archived: !c.me.archived }) },
    { icon: 'check-check', label: c.unread ? t('Прочитано') : t('Отметить непрочитанным'), onClick: () => c.unread ? api('POST', `/api/chats/${c.id}/read`, { upTo: c.lastId }) : api('POST', `/api/chats/${c.id}/unread`) },
    { sep: 1 },
    { icon: 'trash-2', danger: true, label: c.type === 'private' || c.type === 'saved' ? t('Удалить чат') : t('Покинуть'), onClick: () => deleteChatDialog(c) }
  ], { x: e.clientX, y: e.clientY });
}
async function chatState(c, patch) { try { const r = await api('PATCH', `/api/chats/${c.id}/me`, patch); upsertChat(r.chat); if (patch.archived !== undefined) toast(patch.archived ? t('Чат отправлен в архив') : t('Чат возвращён из архива')); } catch (e) { toast(errText(e)); } }
async function deleteChatDialog(c) {
  const priv = c.type === 'private';
  const r = await confirmBox(c.type === 'private' || c.type === 'saved' ? t('Удалить этот чат? История будет очищена.') : t('Покинуть «{n}»?', { n: esc(c.title) }), { ok: c.type === 'private' || c.type === 'saved' ? t('Удалить') : t('Покинуть'), danger: true, extra: priv ? `<label class="check"><input type="checkbox" id="del-both"><span class="box">${ic('check')}</span><span>${t('Также удалить у {n}', { n: esc(U(c.peer)?.name || '') })}</span></label>` : (c.me.role === 'owner' ? `<label class="check"><input type="checkbox" id="del-all"><span class="box">${ic('check')}</span><span>${t('Удалить для всех участников')}</span></label>` : '') });
  if (!r) return;
  const both = $('#del-both', r.extra)?.checked, all = $('#del-all', r.extra)?.checked;
  try { await api('DELETE', `/api/chats/${c.id}?${both ? 'both=1' : ''}${all ? 'destroy=1' : ''}`); delete S.chats[c.id]; if (S.active === c.id) closeChat(); renderChatList(); } catch (e) { toast(errText(e)); }
}
/* поиск */
const doSearch = debounce(async () => {
  const q = S.query; if (!q) return renderChatList(); S.sr = S.sr || {}; renderSearchResults();
  try { const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); if (q !== S.query) return; mergeUsers(r.users); mergeUsers(r.mUsers); S.sr = r; renderSearchResults(); } catch (e) { }
}, 250);
function renderSearchResults() {
  const box = $('#chatlist'); const q = S.query.toLowerCase().replace(/^@/, ''); const r = S.sr || {};
  const local = Object.values(S.chats).filter(c => chatTitle(c).toLowerCase().includes(q) || (c.type === 'private' && (U(c.peer)?.username || '').toLowerCase().includes(q)));
  let html = '';
  if (local.length) html += `<div class="sect-title">${t('Чаты')}</div>` + local.map(chatItemHTML).join('');
  const localPeers = new Set(local.map(c => c.peer));
  const users = (r.users || []).filter(u => !localPeers.has(u.id));
  if (users.length) html += `<div class="sect-title">${t('Люди')}</div>` + users.map(u => `<div class="chat" data-u="${u.id}">${userAv(u, '3.375rem', { dot: true })}<div class="chat-body"><div class="chat-name">${esc(fullName(u))}${verifiedBadge(u)}</div><div class="chat-last">${u.username ? '@' + esc(u.username) + ' · ' : ''}${esc(statusText(u))}</div></div></div>`).join('');
  const chats = (r.chats || []).filter(c => !S.chats[c.id]);
  if (chats.length) html += `<div class="sect-title">${t('Публичные группы и каналы')}</div>` + chats.map(c => `<div class="chat" data-pub="${esc(c.id)}">${avatarHTML({ name: c.title, avatar: c.avatar, color: hashN(c.id) % 8 }, '3.375rem')}<div class="chat-body"><div class="chat-name">${chatBadge(c)}${esc(c.title)}</div><div class="chat-last">@${esc(c.username)} · ${c.count} ${pl(c.count, 'участник', 'участника', 'участников')}</div></div></div>`).join('');
  if ((r.messages || []).length) html += `<div class="sect-title">${t('Сообщения')}</div>` + r.messages.map(m => { const c = S.chats[m.chatId]; if (!c) return ''; const txt = plain(m.text); const i = txt.toLowerCase().indexOf(q); const sn = i > 30 ? '…' + txt.slice(i - 20) : txt; return `<div class="chat" data-m="${m.id}" data-c="${esc(m.chatId)}">${chatAv(c, '3.375rem')}<div class="chat-body"><div class="row"><div class="chat-name">${esc(chatTitle(c))}</div><div class="chat-time">${fmtListTime(m.ts)}</div></div><div class="chat-last">${esc(U(m.from)?.name || '')}: ${esc(sn)}</div></div></div>`; }).join('');
  if (!html) html = `<div class="empty-list">${r.users ? t('Ничего не найдено') : '<span class="spin"></span>'}</div>`;
  box.innerHTML = html;
  $$('.chat[data-id]', box).forEach(n => n.onclick = () => { clearSearch(); openChat(n.dataset.id); });
  $$('.chat[data-u]', box).forEach(n => n.onclick = async () => { clearSearch(); await openPrivate(+n.dataset.u); });
  $$('.chat[data-m]', box).forEach(n => n.onclick = () => { openChat(n.dataset.c, { around: +n.dataset.m }); });
  $$('.chat[data-pub]', box).forEach(n => n.onclick = () => joinPublicDialog(r.chats.find(c => c.id === n.dataset.pub)));
}
function clearSearch() { const si = $('#search'); if (si) si.value = ''; S.query = ''; $('#search-x')?.classList.add('hidden'); renderChatList(); }
async function openPrivate(uid) {
  try { const r = await api('POST', '/api/chats/private', { userId: uid }); mergeUsers(r.users); upsertChat(r.chat); openChat(r.chat.id); } catch (e) { toast(errText(e)); }
}
function joinPublicDialog(c) {
  const m = modal({ title: esc(c.title), body: `<div style="text-align:center">${avatarHTML({ name: c.title, avatar: c.avatar, color: hashN(c.id) % 8 }, '6rem').replace('class="avatar', 'style="margin:0 auto 1rem" class="avatar')}<div style="color:var(--text2)">${c.count} ${pl(c.count, 'участник', 'участника', 'участников')}</div><p>${esc(c.about || '')}</p></div>`, buttons: [{ label: t('Отмена') }, { label: c.type === 'channel' ? t('Подписаться') : t('Вступить'), onClick: async () => { try { const r = await api('POST', `/api/chats/${c.id}/join`); upsertChat(r.chat); clearSearch(); openChat(c.id); } catch (e) { toast(errText(e)); } } }] });
}
async function handleInvite(code) {
  try { const r = await api('GET', '/api/join/' + code); const c = r.chat; if (c.joined) return openChat(c.id);
    modal({ title: esc(c.title), body: `<div style="text-align:center">${avatarHTML({ name: c.title, avatar: c.avatar, color: hashN(c.id) % 8 }, '6rem').replace('class="avatar', 'style="margin:0 auto 1rem" class="avatar')}<div style="color:var(--text2)">${c.count} ${pl(c.count, 'участник', 'участника', 'участников')}</div><p>${esc(c.about || '')}</p></div>`, buttons: [{ label: t('Отмена') }, { label: t('Вступить'), onClick: async () => { try { const j = await api('POST', '/api/join/' + code); upsertChat(j.chat); openChat(j.chat.id); } catch (e) { toast(errText(e)); } } }] });
  } catch (e) { toast(t('Ссылка-приглашение недействительна')); }
}

/* ───────── socket handlers ───────── */
function upsertChat(c) {
  if (!c) return; if (c.me.left) { delete S.chats[c.id]; if (S.active === c.id) closeChat(); renderChatList(); return; }
  const old = S.chats[c.id]; if (old && old.me.markedUnread && c.unread === 0) c.me.markedUnread = old.me.markedUnread;
  S.chats[c.id] = c;
  if (c.peer && !U(c.peer)) ensureUsers([c.peer]).then(renderChatList);
  if (S.active === c.id) { renderHead(); renderPins(); if (!old || old.canPost !== c.canPost || old.type !== c.type) renderComposer(); updateInfoIfOpen(); }
  renderChatList();
}
function onMsgNew(d) {
  mergeUsers(d.users); const m = d.message, c = d.chat; const mine = m.from === S.me.id;
  const isActive = S.active === c.id && S.cm && S.cm.chatId === c.id;
  const atBottom = isActive && !S.cm.hasAfter && isNearBottom();
  if (isActive && atBottom && document.hasFocus() && !mine) c.unread = 0;
  upsertChat(c);
  if (S.typing[c.id]) { delete S.typing[c.id][m.from]; }
  if (isActive) {
    if (!S.cm.hasAfter) {
      if (mine) { const pi = S.cm.list.findIndex(x => x.pending && x.type === m.type); if (pi >= 0) { const oldp = S.cm.list[pi]; S.cm.list[pi] = m; $(`.mrow[data-id="${oldp.id}"]`)?.setAttribute('data-id', m.id); patchRow(m.id, m); } else if (!S.cm.list.some(x => x.id === m.id)) appendMsg(m); }
      else if (!S.cm.list.some(x => x.id === m.id)) appendMsg(m);
      if (atBottom || mine) scrollBottom(true); else bumpScrollDown();
      if (atBottom && document.hasFocus() && !mine) markRead();
    }
  }
  if (!mine && m.type !== 'service' && !m.silent && !isMuted(c) && !(isActive && document.hasFocus())) {
    if (m.type !== 'call') sndMsg(); const u = U(m.from);
    notify(c.type === 'private' ? fullName(u) : `${c.title}`, (c.type === 'group' ? fullName(u) + ': ' : '') + previewText(m, c), c.id);
  }
}
function onMsgEdit(d) {
  const m = d.message, c = S.chats[m.chatId]; if (c && c.last && c.last.id === m.id) { c.last = m; renderChatList(); }
  if (S.cm && S.cm.chatId === m.chatId) { const i = S.cm.list.findIndex(x => x.id === m.id); if (i >= 0) { S.cm.list[i] = m; patchRow(m.id, m); } }
}
function onMsgDelete(d) {
  if (d.chat) { const old = S.chats[d.chatId]; if (old) d.chat.me.markedUnread = old.me.markedUnread; S.chats[d.chatId] = d.chat; }
  if (S.cm && S.cm.chatId === d.chatId) { const had = S.cm.list.length; S.cm.list = S.cm.list.filter(x => !d.ids.includes(x.id)); d.ids.forEach(id => $(`.mrow[data-id="${id}"],.service[data-id="${id}"]`)?.remove()); if (S.cm.list.length !== had) { renderMessages(true); } renderPins(); }
  renderChatList();
}
function onMsgReact(d) {
  if (S.cm && S.cm.chatId === d.chatId) { const m = S.cm.list.find(x => x.id === d.id); if (m) { m.reactions = d.reactions; patchRow(m.id, m, d.emoji && d.by !== S.me.id ? d.emoji : null); } }
  const c = S.chats[d.chatId]; if (c && c.last && c.last.id === d.id) c.last.reactions = d.reactions;
  if (d.by !== S.me.id && d.emoji) { const c2 = S.chats[d.chatId]; if (c2 && S.cm?.list.find(x => x.id === d.id)?.from === S.me.id && !isMuted(c2)) { tone([1046], .08); } }
}
function onChatRead(d) {
  const c = S.chats[d.chatId]; if (!c) return;
  if (d.userId === S.me.id) { c.me.read = Math.max(c.me.read, d.upTo); if (d.unread != null) c.unread = d.unread; c.me.markedUnread = false; }
  else { const old = c.peerRead; c.peerRead = Math.max(c.peerRead, d.upTo); if (S.cm && S.cm.chatId === c.id) S.cm.list.forEach(m => { if (m.from === S.me.id && m.id > old && m.id <= c.peerRead) patchRow(m.id, m); }); }
  renderChatList();
}
function onPresence(u) {
  if (S.active) { const c = S.chats[S.active]; if (c && c.peer === u.id) { renderHead(); } }
  renderChatList();
}
/* typing */
function onTyping(d) {
  const map = S.typing[d.chatId] = S.typing[d.chatId] || {}; clearTimeout(map[d.userId]?.t);
  map[d.userId] = { action: d.action, t: setTimeout(() => { delete map[d.userId]; refreshTyping(d.chatId); }, 5000) };
  ensureUsers([d.userId]).then(() => refreshTyping(d.chatId));
}
function typingText(cid, short) {
  const map = S.typing[cid]; if (!map) return ''; const ids = Object.keys(map); if (!ids.length) return '';
  const c = S.chats[cid]; const act = map[ids[0]].action;
  const verb = act === 'voice' ? t('записывает голосовое…') : act === 'video' ? t('записывает видео…') : act === 'upload' ? t('отправляет файл…') : t('печатает…');
  if (c.type === 'private') return verb; const names = ids.map(i => U(+i)?.name || '').filter(Boolean);
  return names.length > 1 ? `${names.slice(0, 2).join(', ')} ${t('печатают…')}` : `${names[0]} ${verb}`;
}
function refreshTyping(cid) { renderChatList(); if (S.active === cid) updateHeadStatus(); }

/* ───────── open / close chat ───────── */
function closeChat() {
  saveDraft(); S.active = null; S.cm = null; S.reply = null; S.edit = null; stopVoicePlayback?.();
  document.body.classList.remove('chat-open'); showEmptyMain(); renderChatList(); closeInfo();
}
window.addEventListener('popstate', e => { if (S.active && !(e.state && e.state.chat)) { document.body.classList.remove('chat-open'); closeChat(); } });
async function openChat(id, opts = {}) {
  const c = S.chats[id]; if (!c) { try { await refreshAll(); } catch (e) { } if (!S.chats[id]) return; }
  if (S.active === id && !opts.force && !opts.around) { if (document.body.classList.contains('chat-open') === false) document.body.classList.add('chat-open'); $('#inp')?.focus(); return; }
  if (S.active && S.active !== id) saveDraft(); exitSelect(true); stopVoicePlayback?.();
  const sameChat = S.active === id;
  S.active = id; S.reply = null; S.edit = null; document.body.classList.add('chat-open');
  if (!(history.state && history.state.chat)) history.pushState({ chat: id }, ''); else history.replaceState({ chat: id }, '');
  if (!sameChat || opts.force) renderChatShell();
  renderChatList();
  const chat = S.chats[id]; S.cm = { chatId: id, list: [], hasBefore: false, hasAfter: false, loading: false, unreadFrom: null };
  try {
    const q = opts.around ? `around=${opts.around}&limit=40` : 'limit=40';
    const r = await api('GET', `/api/chats/${encodeURIComponent(id)}/messages?${q}`);
    if (S.active !== id) return; mergeUsers(r.users);
    S.cm.list = r.messages; S.cm.hasBefore = r.hasMoreBefore; S.cm.hasAfter = r.hasMoreAfter;
    if (!opts.around && chat.unread > 0) { const f = r.messages.find(m => m.id > chat.me.read && m.from !== S.me.id && m.type !== 'service'); if (f && f.id !== r.messages[0].id) S.cm.unreadFrom = f.id; }
    renderMessages(); renderPins(); renderComposer(); updateHeadStatus();
    const box = $('#msgs');
    if (opts.around) jumpToDom(opts.around);
    else if (S.cm.unreadFrom) { const d = $('.unread-div'); if (d) box.scrollTop = d.offsetTop - 60; else scrollBottom(); }
    else scrollBottom();
    setTimeout(markRead, 400); if (!opts.noFocus && matchMedia('(min-width:801px)').matches) $('#inp')?.focus();
    observeCircles();
  } catch (e) { toast(errText(e)); }
}
function renderChatShell() {
  const c = S.chats[S.active];
  $('#main-body').innerHTML = `<div class="chat-view" id="chat-view"><div class="ch-head" id="ch-head"></div><div id="pin-wrap"></div><div class="msgs" id="msgs"><div class="msgs-inner" id="msgs-inner"></div></div><button class="scroll-down" id="sd">${ic('chevron-down')}</button><div id="comp-wrap"></div><div class="drop-zone hidden" id="dropz">${t('Перетащите файлы сюда')}</div></div>`;
  renderHead(); renderComposer();
  const msgs = $('#msgs');
  msgs.addEventListener('scroll', onMsgsScroll);
  msgs.addEventListener('click', onMsgsClick); msgs.addEventListener('dblclick', onMsgsDbl);
  msgs.addEventListener('contextmenu', e => { const r = e.target.closest('.mrow'); if (!r || e.target.closest('a')) return; e.preventDefault(); msgMenu(r.dataset.id, e); });
  bindLongPress(msgs, e => { const r = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mrow'); if (r) msgMenu(r.dataset.id, e); });
  $('#sd').onclick = () => { if (S.cm.hasAfter) openChat(S.active, { force: true, noFocus: true }); else scrollBottom(true); };
  const cv = $('#chat-view'); let dc = 0;
  cv.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { dc++; $('#dropz').classList.remove('hidden'); } });
  cv.addEventListener('dragleave', () => { if (--dc <= 0) { dc = 0; $('#dropz').classList.add('hidden'); } });
  cv.addEventListener('dragover', e => e.preventDefault());
  cv.addEventListener('drop', e => { e.preventDefault(); dc = 0; $('#dropz').classList.add('hidden'); if (e.dataTransfer.files.length) openAttachModal([...e.dataTransfer.files]); });
}
function renderHead() {
  const h = $('#ch-head'); const c = S.chats[S.active]; if (!h || !c) return;
  if (S.selMode) {
    h.innerHTML = `<button class="btn-icon" id="sel-x">${ic('x')}</button><div style="flex:1;font-size:1.15rem;font-weight:600">${S.sel.size} ${t('выбрано')}</div><button class="btn-icon" id="sel-fwd" title="${t('Переслать')}">${ic('forward')}</button><button class="btn-icon" id="sel-copy" title="${t('Копировать')}">${ic('copy')}</button><button class="btn-icon" id="sel-del" title="${t('Удалить')}" style="color:var(--danger)">${ic('trash-2')}</button>`;
    $('#sel-x').onclick = () => exitSelect(); $('#sel-fwd').onclick = () => S.sel.size && forwardDialog(c.id, [...S.sel].sort((a, b) => a - b)); $('#sel-del').onclick = () => S.sel.size && deleteDialog([...S.sel]);
    $('#sel-copy').onclick = () => { const txt = S.cm.list.filter(m => S.sel.has(m.id)).map(m => m.text).filter(Boolean).join('\n'); copyText(txt); exitSelect(); };
    return;
  }
  const priv = c.type === 'private' && !(U(c.peer)?.bot) && !U(c.peer)?.deleted;
  h.innerHTML = `<button class="btn-icon back" id="h-back">${ic('arrow-left')}</button><div class="ch-title" id="h-title">${chatAv(c, '2.6rem', { dot: true })}<div style="min-width:0"><div class="nm">${chatBadge(c)}${esc(chatTitle(c))}${c.type === 'private' ? verifiedBadge(U(c.peer)) : ''}${c.type === 'private' && U(c.peer)?.emoji ? `<span class="emoji-st">${esc(U(c.peer).emoji)}</span>` : ''}</div><div class="stat" id="h-stat"></div></div></div>
  <button class="btn-icon" id="h-search" title="${t('Поиск')}">${ic('search')}</button>${priv ? `<button class="btn-icon" id="h-call" title="${t('Звонок')}">${ic('phone')}</button><button class="btn-icon" id="h-vcall" title="${t('Видеозвонок')}">${ic('video')}</button>` : ''}<button class="btn-icon" id="h-info" title="${t('Информация')}">${ic('info')}</button><button class="btn-icon" id="h-more" data-menu-keep>${ic('ellipsis-vertical')}</button>`;
  $('#h-back').onclick = () => { if (history.state?.chat) history.back(); else closeChat(); };
  $('#h-title').onclick = $('#h-info').onclick = () => toggleInfo();
  $('#h-search').onclick = openChatSearch;
  if (priv) { $('#h-call').onclick = () => startCall(c.peer, false); $('#h-vcall').onclick = () => startCall(c.peer, true); }
  $('#h-more').onclick = () => {
    const u = c.type === 'private' ? U(c.peer) : null;
    popMenu([
      { icon: isMuted(c) ? 'bell' : 'bell-off', label: isMuted(c) ? t('Включить уведомления') : t('Выключить уведомления'), onClick: () => chatState(c, { muted: !isMuted(c) }) },
      { icon: 'clock', label: t('Отложенные сообщения'), onClick: showScheduled },
      { icon: 'search', label: t('Поиск по чату'), onClick: openChatSearch },
      { icon: 'check-circle', label: t('Выбрать сообщения'), onClick: () => enterSelect() },
      { icon: 'archive', label: c.me.archived ? t('Вернуть из архива') : t('В архив'), onClick: () => chatState(c, { archived: !c.me.archived }) },
      { sep: 1 },
      u && !u.bot && { icon: 'ban', danger: true, label: u.blockedByMe ? t('Разблокировать') : t('Заблокировать'), onClick: () => toggleBlock(u) },
      c.type !== 'saved' && !(u && u.system) && { icon: 'flag', danger: true, label: t('Пожаловаться'), onClick: () => reportDialog(u ? { kind: 'user', target: u.id } : { kind: 'chat', target: c.id }) },
      { icon: 'trash-2', danger: true, label: c.type === 'private' || c.type === 'saved' ? t('Удалить чат') : t('Покинуть'), onClick: () => deleteChatDialog(c) },
    ], { el: $('#h-more'), right: true });
  };
  updateHeadStatus();
}
function updateHeadStatus() {
  const s = $('#h-stat'); const c = S.chats[S.active]; if (!s || !c) return;
  const typ = typingText(c.id); let txt, cls = '';
  if (typ) { txt = `<span class="typing-dots"><span></span><span></span><span></span></span> ${esc(typ)}`; cls = 'typing'; }
  else if (c.type === 'private') { const u = U(c.peer); txt = esc(statusText(u)); if (u?.online) cls = 'on'; }
  else if (c.type === 'saved') txt = '';
  else { const n = c.count; txt = `${n} ${c.type === 'channel' ? pl(n, 'подписчик', 'подписчика', 'подписчиков') : pl(n, 'участник', 'участника', 'участников')}`; }
  s.className = 'stat ' + cls; s.innerHTML = txt;
}
async function toggleBlock(u) {
  if (!u.blockedByMe) { if (!(await confirmBox(t('Заблокировать {n}? Пользователь больше не сможет писать и звонить вам.', { n: esc(fullName(u)) }), { ok: t('Заблокировать'), danger: true }))) return; }
  try { const r = await api('POST', `/api/users/${u.id}/block`, { block: !u.blockedByMe }); mergeUsers([r.user]); toast(r.user.blockedByMe ? t('Пользователь заблокирован') : t('Пользователь разблокирован')); renderComposer(); renderHead(); updateInfoIfOpen(); } catch (e) { toast(errText(e)); }
}

/* ───────── pinned bar ───────── */
S.pinIdx = {}; S.pinCache = {};
async function renderPins() {
  const w = $('#pin-wrap'); const c = S.chats[S.active]; if (!w || !c) return;
  const pins = c.pins || []; if (!pins.length) { w.innerHTML = ''; return; }
  let idx = S.pinIdx[c.id]; if (idx == null || idx >= pins.length) idx = pins.length - 1; const id = pins[idx];
  let m = S.pinCache[id] || S.cm?.list.find(x => x.id === id);
  if (!m) { try { const r = await api('GET', `/api/chats/${encodeURIComponent(c.id)}/messages?around=${id}&limit=1`); m = r.messages.find(x => x.id === id); if (m) S.pinCache[id] = m; } catch (e) { } }
  if (!m || S.active !== c.id) return;
  const canPin = c.type === 'private' || c.type === 'saved' || c.me.role !== 'member';
  w.innerHTML = `<div class="pinned-bar"><div class="bar"></div><div class="tx"><div class="t">${t('Закреплённое сообщение')}${pins.length > 1 ? ` #${idx + 1}` : ''}</div><div class="x">${esc(previewText(m, c))}</div></div>${canPin ? `<button class="btn-icon" id="unpin" style="width:2.2rem;height:2.2rem">${ic('x')}</button>` : ''}</div>`;
  $('.pinned-bar', w).onclick = e => { if (e.target.closest('#unpin')) return; S.pinIdx[c.id] = (idx - 1 + pins.length) % pins.length; jumpTo(id); renderPins(); };
  $('#unpin', w)?.addEventListener('click', () => api('POST', `/api/chats/${encodeURIComponent(c.id)}/pin`, { msgId: id, unpin: true }));
}

/* ───────── messages rendering ───────── */
const mediaSize = (w, h, maxW = 330, maxH = 400) => { if (!w || !h) { w = 4; h = 3; } const k = Math.min(maxW / w, maxH / h, 1.6); let W = Math.max(120, Math.round(w * k)), H = Math.round(h * k); if (W > maxW) { H = Math.round(H * maxW / W); W = maxW; } return [W, Math.max(80, H)]; };
function rowHTML(i) {
  const list = S.cm.list, m = list[i], p = list[i - 1], n = list[i + 1], c = S.chats[S.cm.chatId];
  if (m.type === 'service') return `<div class="service" data-id="${m.id}">${esc(serviceText(m))}</div>`;
  const me = S.me.id, isCh = c.type === 'channel', out = !isCh && m.from === me, grp = c.type === 'group';
  const near = (a, b) => a && b && a.type !== 'service' && b.type !== 'service' && a.from === b.from && (b.ts - a.ts) < 300e3 && sameDay(new Date(a.ts), new Date(b.ts)) && !!a.fwd === !!b.fwd;
  const first = !near(p, m), last = !near(m, n); const u = U(m.from); const chk = S.selMode;
  const big = m.type === 'text' && CFG.bigEmoji && m.text && EMO_ONLY.test(m.text.trim());
  const hasR = m.reactions && Object.keys(m.reactions).length;
  const isStk = m.type === 'sticker' || big, isCircle = m.type === 'circle', noCap = ['photo', 'video'].includes(m.type) && !m.text;
  const mediaOnly = noCap && !m.fwd && !m.reply && !(grp && !out && first);
  let inner = '';
  if (grp && !out && first && !isStk && !isCircle) inner += `<div class="sender" data-u="${m.from}" style="color:${NAME_COLORS[(u?.color ?? hashN(m.from)) % 8]}">${esc(fullName(u))}${verifiedBadge(u)}</div>`;
  if (isCh && first) inner += `<div class="sender" style="color:var(--accent)">${esc(c.title)}</div>`;
  if (m.fwd) { const fu = U(m.fwd.from); inner += `<div class="fwd">${t('Переслано от')} <b>${esc(m.fwd.chat || fullName(fu))}</b></div>`; }
  if (m.replyTo && m.reply) { const r = m.reply; const ru = U(r.from); inner += `<div class="reply" data-reply="${r.id}">${r.thumb ? `<div class="th" style="background-image:url('${esc(r.thumb)}')"></div>` : ''}<div><div class="rt">${esc(r.from === me ? t('Вы') : fullName(ru))}</div><div class="rx2">${esc(previewText(r, c))}</div></div></div>`; }
  else if (m.replyTo) inner += `<div class="reply"><div><div class="rt">${t('Сообщение')}</div><div class="rx2">${t('Удалённое сообщение')}</div></div></div>`;
  const spacer = '<span class="mspace"></span>';
  switch (m.type) {
    case 'text': inner += big ? `<div class="text"><span class="big-emoji">${esc(m.text)}</span></div>` : `<div class="text">${fmt(m.text)}${spacer}</div>`; break;
    case 'photo': { const [W, H] = mediaSize(m.media.w, m.media.h); inner += `<div class="media-photo" data-view="${m.id}" style="width:${W}px;max-width:100%;aspect-ratio:${W}/${H}">${m.pending ? `<img src="${esc(m.media.local)}" style="opacity:.6">` : `<img src="${esc(m.media.url)}" loading="lazy" alt="">`}${m.pending ? '<div class="play" style="background:rgba(0,0,0,.4)"><span class="spin"></span></div>' : ''}</div>`; if (m.text) inner += `<div class="text cap">${fmt(m.text)}${spacer}</div>`; break; }
    case 'video': { const [W, H] = mediaSize(m.media.w, m.media.h); inner += `<div class="media-video" data-view="${m.id}" style="width:${W}px;max-width:100%;aspect-ratio:${W}/${H}">${m.pending ? '' : `<video src="${esc(m.media.url)}#t=0.1" preload="metadata" muted playsinline></video>`}<div class="play">${m.pending ? '<span class="spin"></span>' : ic('play')}</div><div class="dur">${fmtDur(m.media.duration)}</div></div>`; if (m.text) inner += `<div class="text cap">${fmt(m.text)}${spacer}</div>`; break; }
    case 'file': inner += `<a class="file" href="${esc(m.media.url)}?dl=1" download="${esc(m.media.name)}" onclick="${m.pending ? 'return false' : ''}" style="color:inherit;text-decoration:none"><div class="fi">${m.pending ? '<span class="spin"></span>' : ic('file-text')}</div><div style="min-width:0"><div class="fn">${esc(m.media.name)}</div><div class="fs">${fmtSize(m.media.size)}</div></div></a>` + (m.text ? `<div class="text">${fmt(m.text)}${spacer}</div>` : ''); break;
    case 'voice': inner += voiceHTML(m); break;
    case 'circle': inner += circleHTML(m); break;
    case 'sticker': inner += `<span class="sticker-em">${esc(m.sticker)}</span>`; break;
    case 'location': inner += `<a class="loc" href="https://www.openstreetmap.org/?mlat=${m.loc.lat}&mlon=${m.loc.lng}#map=16/${m.loc.lat}/${m.loc.lng}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;display:block"><div class="map">${ic('map-pin')}</div><div style="padding:.3rem 0 .1rem;font-weight:600">${t('Геопозиция')}</div><div style="font-size:.82rem;color:var(--text2)">${m.loc.lat.toFixed(5)}, ${m.loc.lng.toFixed(5)}</div></a>`; break;
    case 'poll': inner += pollHTML(m); break;
    case 'call': { const miss = m.call.status === 'missed' && m.from !== me || m.call.status === 'declined'; inner += `<div class="call-msg"><div class="ci ${miss ? 'miss' : ''}">${ic(m.call.status === 'missed' || m.call.status === 'declined' ? 'phone-missed' : (m.from === me ? 'phone-outgoing' : 'phone-incoming'))}</div><div><b>${esc(callText(m))}</b><div class="cs">${m.call.status === 'ended' ? fmtDur(m.call.duration) : fmtTime(m.ts)}</div></div></div>`; break; }
  }
  if (m.markup && m.markup.length) inner += `<div class="kb">${m.markup.map((row, ri) => `<div class="kb-row">${row.map((b, bi) => `<button class="kb-btn" data-kb="${ri}:${bi}">${esc(b.text)}${b.url ? ' ↗' : ''}</button>`).join('')}</div>`).join('')}</div>`;
  if (hasR) inner += `<div class="reactions">${Object.entries(m.reactions).map(([e, us]) => `<span class="rx ${us.includes(me) ? 'mine' : ''}" data-emoji="${e}"><span class="e">${e}</span>${us.length}</span>`).join('')}</div>`;
  const read = out && c.type !== 'saved' && !m.pending && m.id <= c.peerRead;
  const meta = `<span class="meta">${m.views != null ? `<span class="views">${ic('eye')}${m.views}</span>` : ''}${m.edited ? `<span class="ed">${t('изм.')}</span>` : ''}${fmtTime(m.ts)}${out && c.type !== 'saved' ? (m.pending ? ic('clock') : ic(read ? 'check-check' : 'check')) : ''}</span>`;
  const needPad = !['text', 'sticker'].includes(m.type) && !noCap && !(m.text && ['photo', 'video', 'file'].includes(m.type)) && m.type !== 'circle' && !big;
  const cls = ['bubble', mediaOnly ? 'media-only' : '', isStk ? 'sticker' : '', isCircle ? 'circle' : '', hasR ? 'has-reactions' : '', needPad && !hasR ? 'pad-b' : ''].filter(Boolean).join(' ');
  const avCol = grp && !out ? `<div class="m-av">${last ? userAv(u, '2.4rem') .replace('class="avatar', `data-u="${m.from}" class="avatar`) : ''}</div>` : '';
  return `<div class="mrow ${out ? 'out' : 'in'} ${first ? 'first' : ''} ${last ? 'last' : ''} ${first && p ? 'gap' : ''} ${isStk ? 'nobubble' : ''} ${chk ? 'sel-mode' : ''} ${S.sel.has(m.id) ? 'selected' : ''}" data-id="${m.id}"><div class="selbox">${ic('check')}</div>${avCol}<div class="${cls}">${inner}${meta}</div></div>`;
}
function dayAndRow(i) {
  const list = S.cm.list, m = list[i], p = list[i - 1]; let h = '';
  if (!p || !sameDay(new Date(p.ts), new Date(m.ts))) h += `<div class="day">${dayLabel(m.ts)}</div>`;
  if (S.cm.unreadFrom === m.id) h += `<div class="unread-div">${t('Непрочитанные сообщения')}</div>`;
  return h + rowHTML(i);
}
function renderMessages(keepScroll) {
  const box = $('#msgs-inner'); if (!box || !S.cm) return; const sc = $('#msgs'); const prevH = sc.scrollHeight, prevT = sc.scrollTop;
  let html = ''; if (S.cm.hasBefore) html += `<div class="service" style="align-self:center"><span class="spin" style="width:1rem;height:1rem;border-width:2px"></span></div>`;
  S.cm.list.forEach((m, i) => html += dayAndRow(i));
  if (!S.cm.list.length) { const c = S.chats[S.cm.chatId]; html = `<div class="service" style="margin:auto;padding:.6rem 1.2rem">${c.type === 'saved' ? t('Здесь будут ваши заметки, файлы и пересланные сообщения') : c.bot ? '' : t('Здесь пока нет сообщений…')}</div>`; if (c.bot && c.type === 'private') html = botIntroHTML(c); }
  box.innerHTML = html; hydrateRows(box);
  if (keepScroll) sc.scrollTop = prevT + (sc.scrollHeight - prevH);
}
function hydrateRows(root) { $$('.voice', root).forEach(refreshVoiceUI); }
function appendMsg(m) {
  const box = $('#msgs-inner'); if (!box) return; const list = S.cm.list;
  if (!list.length) box.innerHTML = '';
  list.push(m); const i = list.length - 1;
  if (i > 0) { const prev = list[i - 1]; patchRow(prev.id, prev, null, true); }
  box.insertAdjacentHTML('beforeend', dayAndRow(i)); hydrateRows(box); if (m.type === 'circle') observeCircles();
}
function patchRow(id, m, newEmoji, silent) {
  const node = $(`.mrow[data-id="${id}"]`); if (!node || !S.cm) return;
  let i = S.cm.list.findIndex(x => x.id === id); if (i < 0) i = S.cm.list.findIndex(x => x === m); if (i < 0) return;
  const nn = el(rowHTML(i)); nn.style.animation = 'none'; $$('.bubble', nn).forEach(b => b.style.animation = 'none');
  node.replaceWith(nn); hydrateRows(nn); if (m.type === 'circle') observeCircles();
  if (newEmoji) { const rx = $(`.rx[data-emoji="${newEmoji}"]`, nn); rx?.classList.add('pop'); }
}
const scheduleRowRefresh = () => { };
const isNearBottom = () => { const b = $('#msgs'); return !b || b.scrollHeight - b.scrollTop - b.clientHeight < 140; };
function scrollBottom(smooth) { const b = $('#msgs'); if (!b) return; if (smooth && CFG.anim) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); else b.scrollTop = b.scrollHeight; setSD(false); }
function setSD(show, n) { const sd = $('#sd'); if (!sd) return; sd.classList.toggle('show', show); const c = S.chats[S.active]; const un = n != null ? n : (c?.unread || 0); sd.innerHTML = ic('chevron-down') + (show && un ? `<span class="badge">${un}</span>` : ''); }
function bumpScrollDown() { setSD(true); }
let scrollBusy = false;
async function onMsgsScroll() {
  const b = $('#msgs'); if (!b || !S.cm) return;
  const near = isNearBottom(); setSD(!near || S.cm.hasAfter);
  if (near && !S.cm.hasAfter) markRead();
  if (scrollBusy) return;
  if (b.scrollTop < 250 && S.cm.hasBefore && S.cm.list.length) {
    scrollBusy = true; const cid = S.cm.chatId;
    try { const r = await api('GET', `/api/chats/${encodeURIComponent(cid)}/messages?before=${S.cm.list[0].id}&limit=40`); if (S.cm?.chatId === cid) { mergeUsers(r.users); S.cm.list = [...r.messages, ...S.cm.list]; S.cm.hasBefore = r.hasMoreBefore; renderMessages(true); } } catch (e) { }
    scrollBusy = false;
  } else if (b.scrollHeight - b.scrollTop - b.clientHeight < 250 && S.cm.hasAfter && S.cm.list.length) {
    scrollBusy = true; const cid = S.cm.chatId;
    try { const r = await api('GET', `/api/chats/${encodeURIComponent(cid)}/messages?after=${S.cm.list[S.cm.list.length - 1].id}&limit=40`); if (S.cm?.chatId === cid) { mergeUsers(r.users); const t0 = b.scrollTop; S.cm.list = [...S.cm.list, ...r.messages]; S.cm.hasAfter = r.hasMoreAfter; renderMessages(); b.scrollTop = t0; } } catch (e) { }
    scrollBusy = false;
  }
}
let readTimer = null;
function markRead() {
  const c = S.chats[S.active]; if (!c || !document.hasFocus() || document.hidden || !isNearBottom() || (S.cm && S.cm.hasAfter)) return;
  if (c.unread === 0 && !c.me.markedUnread && c.me.read >= c.lastId) return;
  clearTimeout(readTimer); readTimer = setTimeout(() => { const last = S.cm?.list[S.cm.list.length - 1]; const up = Math.max(last && !last.pending ? last.id : 0, c.lastId); api('POST', `/api/chats/${encodeURIComponent(c.id)}/read`, { upTo: up }).catch(() => { }); c.unread = 0; c.me.read = up; c.me.markedUnread = false; renderChatList(); setSD(!isNearBottom()); }, 150);
}
window.addEventListener('focus', () => setTimeout(markRead, 200));
document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(markRead, 200));
function jumpToDom(id) { const n = $(`.mrow[data-id="${id}"],.service[data-id="${id}"]`); if (!n) return false; n.scrollIntoView({ block: 'center', behavior: CFG.anim ? 'smooth' : 'auto' }); n.classList.remove('hl'); void n.offsetWidth; n.classList.add('hl'); return true; }
async function jumpTo(id) { if (S.cm?.list.some(m => m.id === id) && jumpToDom(id)) return; await openChat(S.active, { around: id, force: true, noFocus: true }); }

/* clicks inside message list */
function onMsgsClick(e) {
  const kb = e.target.closest('.kb-btn'); if (kb) { const r0 = kb.closest('.mrow'); return kbClick(+r0.dataset.id, kb); }
  const row = e.target.closest('.mrow'); const id = row ? +row.dataset.id || row.dataset.id : null;
  if (S.selMode) { if (row && !isNaN(+id)) toggleSel(+id); return; }
  const sp = e.target.closest('.spoiler'); if (sp) { sp.classList.toggle('open'); return; }
  const mn = e.target.closest('.mention[data-u]'); if (mn) { resolveUsername(mn.dataset.u); return; }
  const rp = e.target.closest('.reply[data-reply]'); if (rp) return jumpTo(+rp.dataset.reply);
  const rx = e.target.closest('.rx'); if (rx) return react(+id, rx.dataset.emoji);
  const av = e.target.closest('[data-u]'); if (av && (av.classList.contains('sender') || av.classList.contains('avatar'))) return openUserProfile(+av.dataset.u);
  const vw = e.target.closest('[data-view]'); if (vw) return openViewer(+vw.dataset.view);
  const pb = e.target.closest('.voice .pb'); if (pb) return toggleVoice(+id);
  const wf = e.target.closest('.voice .wf'); if (wf) return seekVoice(+id, e, wf);
  const sp2 = e.target.closest('.voice .spd'); if (sp2) return cycleVoiceSpeed(+id);
  const cw = e.target.closest('.circle-wrap'); if (cw) return toggleCircle(cw);
  const st = e.target.closest('.sticker-em'); if (st) { st.classList.remove('bounce'); void st.offsetWidth; st.classList.add('bounce'); return; }
  const po = e.target.closest('.popt'); if (po) return pollClick(+id, +po.dataset.i);
  const pv = e.target.closest('.pvote'); if (pv) return pollSubmit(+id);
  const pc = e.target.closest('.pclose'); if (pc) return api('POST', `/api/messages/${id}/poll/close`);
}
function onMsgsDbl(e) { const row = e.target.closest('.mrow'); if (!row || S.selMode || e.target.closest('.rx,a,.voice,.circle-wrap')) return; const id = +row.dataset.id; if (!isNaN(id)) react(id, CFG.quick || '👍', true); }
async function resolveUsername(un) {
  try { const r = await api('GET', '/api/resolve/' + un); if (r.type === 'user') openUserProfile(r.user.id, r.user); else { const c = r.chat; if (S.chats[c.id]) openChat(c.id); else joinPublicDialog(c); } } catch (e) { toast(t('Пользователь не найден')); }
}
function observeCircles() {
  if (!window.IntersectionObserver) return; window.circleIO = window.circleIO || new IntersectionObserver(es => es.forEach(en => { const v = $('video', en.target); if (!v || en.target.classList.contains('playing')) return; if (en.isIntersecting && CFG.autoplay) v.play().catch(() => { }); else v.pause(); }), { threshold: .6 });
  $$('.circle-wrap').forEach(n => { if (!n.dataset.obs) { n.dataset.obs = 1; circleIO.observe(n); } });
}

/* ───────── polls ───────── */
function pollHTML(m) {
  const p = m.poll; const sel = (S.pollSel && S.pollSel[m.id]) || [];
  const show = p.voted || p.closed;
  const tp = (p.quiz ? t('Викторина') : p.anon ? t('Анонимный опрос') : t('Опрос')) + (p.closed ? ' · ' + t('завершён') : '');
  return `<div class="poll"><div class="pq">${esc(p.q)}</div><div class="pt">${tp}${p.multiple ? ' · ' + t('несколько ответов') : ''}</div>${p.options.map((o, i) => {
    const pct = p.total ? Math.round(o.n / p.total * 100) : 0; const right = p.quiz && show && p.correct === i, wrong = p.quiz && show && o.mine && p.correct !== i;
    return `<div class="popt ${o.mine ? 'mine' : ''} ${right ? 'right' : ''} ${wrong ? 'wrong' : ''}" data-i="${i}"><div class="pc ${p.multiple ? 'sq' : ''}" style="${!show && sel.includes(i) ? 'background:var(--accent);border-color:var(--accent)' : ''}">${show ? (o.mine ? '✓' : '') : (sel.includes(i) ? '✓' : '')}</div><div class="pb2"><div class="pr"><span>${esc(o.t)}</span>${show ? `<b>${pct}%</b>` : ''}</div>${show ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div></div>`;
  }).join('')}${p.multiple && !show ? `<button class="pvote">${t('Проголосовать')}</button>` : ''}<div class="pt" style="margin:.4rem 0 0">${p.total} ${pl(p.total, 'голос', 'голоса', 'голосов')}${show && p.explanation ? ` · 💡 ${esc(p.explanation)}` : ''}</div>${m.from === S.me.id && !p.closed ? `<button class="pvote pclose" style="color:var(--danger)">${t('Завершить опрос')}</button>` : ''}</div>`;
}
S.pollSel = {};
async function pollClick(id, i) {
  const m = S.cm.list.find(x => x.id === id); if (!m || m.poll.closed) return;
  if (m.poll.voted && m.poll.quiz) return;
  if (m.poll.multiple && !m.poll.voted) { const a = S.pollSel[id] = S.pollSel[id] || []; const k = a.indexOf(i); k >= 0 ? a.splice(k, 1) : a.push(i); patchRow(id, m); return; }
  const cur = m.poll.options.map((o, k) => o.mine ? k : -1).filter(k => k >= 0);
  const opts = m.poll.multiple ? (cur.includes(i) ? cur.filter(k => k !== i) : [...cur, i]) : (cur.includes(i) ? [] : [i]);
  try { const r = await api('POST', `/api/messages/${id}/vote`, { options: opts }); const k = S.cm.list.findIndex(x => x.id === id); if (k >= 0) { S.cm.list[k] = r.message; patchRow(id, r.message); } } catch (e) { toast(errText(e)); }
}
async function pollSubmit(id) { const a = S.pollSel[id] || []; if (!a.length) return toast(t('Выберите вариант')); try { const r = await api('POST', `/api/messages/${id}/vote`, { options: a }); delete S.pollSel[id]; const k = S.cm.list.findIndex(x => x.id === id); if (k >= 0) { S.cm.list[k] = r.message; patchRow(id, r.message); } } catch (e) { toast(errText(e)); } }

/* ───────── in-chat search ───────── */
function openChatSearch() {
  const h = $('#ch-head'); const c = S.chats[S.active]; if (!h) return; let res = [], idx = 0;
  h.innerHTML = `<button class="btn-icon" id="cs-x">${ic('arrow-left')}</button><div class="ch-search"><input id="cs-in" placeholder="${t('Поиск по чату')}" autocomplete="off"><span class="cnt" id="cs-cnt"></span></div><button class="btn-icon" id="cs-up">${ic('chevron-up')}</button><button class="btn-icon" id="cs-dn">${ic('chevron-down')}</button>`;
  const inp = $('#cs-in'); inp.focus();
  const go = () => { if (!res.length) { $('#cs-cnt').textContent = ''; return; } $('#cs-cnt').textContent = `${idx + 1} ${t('из')} ${res.length}`; jumpTo(res[idx].id); };
  const run = debounce(async () => { const q = inp.value.trim(); if (!q) { res = []; $('#cs-cnt').textContent = ''; return; } try { const r = await api('GET', `/api/chats/${encodeURIComponent(c.id)}/messages?q=${encodeURIComponent(q)}`); res = r.messages; idx = 0; if (!res.length) $('#cs-cnt').textContent = t('Нет результатов'); else go(); } catch (e) { } }, 300);
  inp.oninput = run; inp.onkeydown = e => { if (e.key === 'Enter') { if (res.length) { idx = (idx + (e.shiftKey ? 1 : -1) + res.length) % res.length; go(); } } if (e.key === 'Escape') { e.stopPropagation(); renderHead(); } };
  $('#cs-up').onclick = () => { if (res.length) { idx = (idx + 1) % res.length; go(); } }; $('#cs-dn').onclick = () => { if (res.length) { idx = (idx - 1 + res.length) % res.length; go(); } };
  $('#cs-x').onclick = () => renderHead();
}

/* ───────── selection mode ───────── */
function enterSelect(id) { S.selMode = true; S.sel = new Set(id ? [id] : []); renderMessages(true); renderHead(); renderComposer(); }
function exitSelect(silent) { if (!S.selMode) return; S.selMode = false; S.sel.clear(); if (!silent) { renderMessages(true); renderHead(); renderComposer(); } }
function toggleSel(id) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); if (!S.sel.size) return exitSelect(); const n = $(`.mrow[data-id="${id}"]`); n?.classList.toggle('selected', S.sel.has(id)); renderHead(); }
