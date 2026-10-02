/* GeoMetric Beta — запуск приложения */
'use strict';
async function loadBootstrap() {
  const r = await api('GET', '/api/bootstrap');
  S.me = r.me; S.sid = r.sid; S.mailMode = r.mail; S.users = {}; mergeUsers(r.users); S.users[S.me.id] = S.me;
  S.chats = {}; r.chats.forEach(c => S.chats[c.id] = c);
}
async function boot() {
  stopQR?.();
  try { await loadBootstrap(); }
  catch (e) { if (e.error === 'unauthorized') return; $('#root').innerHTML = `<div style="position:fixed;inset:0;display:flex;flex-direction:column;gap:1rem;align-items:center;justify-content:center"><div class="logo sm">${LOGO}</div><div>${t('Нет соединения с сервером…')}</div><button class="btn" onclick="location.reload()">${t('Повторить')}</button></div>`; return; }
  const srv = S.me.settings || {};
  if (srv && Object.keys(srv).length) { CFG = { ...DEF, ...srv }; localStorage.setItem('gm_cfg', JSON.stringify(CFG)); LANG = CFG.lang || LANG; } else saveCfgRemote();
  S.booted = true; buildApp(); connectSocket(); applyTheme();
  handleUrlParams();
  const unlock = () => { try { audioCtx().resume(); } catch (e) { } if (CFG.desktop && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);
}
function handleUrlParams() {
  if (handleProfilePath()) return;
  const p = new URLSearchParams(location.search); let changed = false;
  if (p.get('qr')) { handleQRLink(p.get('qr')); changed = true; }
  if (p.get('invite')) { handleInvite(p.get('invite')); changed = true; }
  if (p.get('u')) { resolveUsername(p.get('u')); changed = true; }
  if (changed) history.replaceState(null, '', location.pathname);
}
async function refreshAll() {
  try {
    const keep = S.active; const r = await api('GET', '/api/bootstrap'); S.me = r.me; mergeUsers(r.users); S.users[S.me.id] = S.me;
    S.chats = {}; r.chats.forEach(c => S.chats[c.id] = c); renderChatList();
    if (keep && S.cm && S.chats[keep]) {
      const last = [...S.cm.list].reverse().find(m => !m.pending);
      if (last && !S.cm.hasAfter) { const j = await api('GET', `/api/chats/${encodeURIComponent(keep)}/messages?after=${last.id}&limit=100`); mergeUsers(j.users); const stick = isNearBottom(); j.messages.forEach(m => { if (!S.cm.list.some(x => x.id === m.id)) appendMsg(m); }); if (stick) scrollBottom(); }
      renderHead(); renderPins();
    }
  } catch (e) { }
}
(function init() {
  applyTheme();
  const p = new URLSearchParams(location.search);
  if (S.token) boot(); else { showAuth(); if (p.get('qr')) toast(t('Войдите в аккаунт на телефоне, затем отсканируйте QR-код ещё раз')); }
})();
if ('serviceWorker' in navigator) { /* PWA не регистрируем в бета-версии, чтобы не кэшировать обновления */ }
