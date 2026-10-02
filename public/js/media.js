/* GeoMetric Beta — поле ввода, отправка, вложения, голосовые, кружки, просмотр медиа, действия с сообщениями */
'use strict';
const Rec = { active: false, starting: false, kind: null, locked: false };
S.recMode = localStorage.getItem('gm_recmode') || 'voice';

/* ───────── composer ───────── */
function renderComposer() {
  const w = $('#comp-wrap'); const c = S.chats[S.active]; if (!w || !c) return;
  const u = c.type === 'private' ? U(c.peer) : null;
  let mode = 'full';
  if (S.selMode) mode = 'sel'; else if (u && u.blockedByMe) mode = 'blocked'; else if (u && u.deleted) mode = 'deleted'; else if (!c.canPost) mode = 'ro-' + isMuted(c);
  if (w.dataset.mode === mode && w.firstChild) return; w.dataset.mode = mode;
  if (mode === 'sel') { w.innerHTML = ''; return; }
  if (mode !== 'full') {
    const lbl = mode === 'blocked' ? t('Разблокировать') : mode === 'deleted' ? t('Аккаунт удалён') : (isMuted(c) ? t('Включить уведомления') : t('Выключить уведомления'));
    w.innerHTML = `<div class="composer"><div class="comp-ro" id="comp-ro">${lbl}</div></div>`;
    $('#comp-ro').onclick = () => mode === 'blocked' ? toggleBlock(u) : mode === 'deleted' ? 0 : chatState(c, { muted: !isMuted(c) });
    return;
  }
  w.innerHTML = `<div class="composer" id="composer"><div class="comp-in"><div class="comp-box"><div class="comp-top hidden" id="comp-top"></div>
    <div class="comp-row" id="comp-row"><button class="btn-icon" id="b-emoji" data-menu-keep>${ic('smile')}</button><textarea id="inp" rows="1" placeholder="${t('Сообщение')}" maxlength="4096"></textarea><button class="btn-icon" id="b-attach" data-menu-keep>${ic('paperclip')}</button></div></div>
    <button class="send-btn" id="send-btn">${ic('mic')}</button></div></div>`;
  const inp = $('#inp'); inp.value = S.drafts[c.id] || '';
  inp.addEventListener('input', onInput); inp.addEventListener('keydown', onInpKey); inp.addEventListener('paste', onPaste);
  inp.addEventListener('mouseup', showFmtBar); inp.addEventListener('keyup', showFmtBar); inp.addEventListener('blur', () => setTimeout(() => $('.fmt-bar')?.remove(), 150));
  $('#b-emoji').onclick = toggleEmojiPanel; $('#b-attach').onclick = attachMenu;
  bindSendButton(); autoGrow(); updateSendBtn(); renderCompTop();
}
function onInput() {
  autoGrow(); updateSendBtn(); const c = S.active; if (!c) return;
  saveDraftSoon(); const now = Date.now(); if (now - (onInput.t || 0) > 3000 && $('#inp').value && !S.edit) { onInput.t = now; S.socket.emit('typing', { chatId: c, action: 'typing' }); }
}
const saveDraftSoon = debounce(() => saveDraft(), 400);
function saveDraft() {
  const inp = $('#inp'); const id = S.active; if (!inp || !id || S.edit) return; const v = inp.value;
  if (v.trim()) S.drafts[id] = v; else delete S.drafts[id]; localStorage.setItem('gm_drafts', JSON.stringify(S.drafts)); renderChatList();
}
function autoGrow() { const i = $('#inp'); if (!i) return; i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 256) + 'px'; }
function updateSendBtn() {
  const b = $('#send-btn'); const i = $('#inp'); if (!b || !i) return; const has = i.value.trim().length > 0 || !!S.edit;
  b.innerHTML = ic(S.edit ? 'check' : has ? 'send' : (S.recMode === 'video' ? 'video' : 'mic')); b.dataset.has = has ? 1 : '';
}
function onInpKey(e) {
  if (e.key === 'Enter') { const send = CFG.sendEnter ? !e.shiftKey : (e.ctrlKey || e.metaKey); if (send && !e.isComposing) { e.preventDefault(); return sendFromInput(); } }
  if (e.key === 'Escape' && (S.reply || S.edit)) { e.stopPropagation(); cancelReplyEdit(); }
  if (e.key === 'ArrowUp' && !e.target.value && !S.edit) { const last = [...S.cm.list].reverse().find(m => m.from === S.me.id && ['text', 'photo', 'video', 'file'].includes(m.type) && !m.pending); if (last) { e.preventDefault(); startEdit(last); } }
  if ((e.ctrlKey || e.metaKey)) { const k = e.key.toLowerCase(); const map = e.shiftKey ? { x: ['~~', '~~'], m: ['`', '`'], p: ['||', '||'] } : { b: ['**', '**'], i: ['__', '__'] }; if (map[k]) { e.preventDefault(); wrapSel(...map[k]); } }
}
function wrapSel(l, r) {
  const i = $('#inp'); const a = i.selectionStart, b = i.selectionEnd; const v = i.value, sel = v.slice(a, b);
  if (sel.startsWith(l) && sel.endsWith(r) && sel.length >= l.length + r.length) { i.setRangeText(sel.slice(l.length, sel.length - r.length), a, b, 'select'); }
  else i.setRangeText(l + sel + r, a, b, 'select'); i.focus(); onInput();
}
function showFmtBar() {
  $('.fmt-bar')?.remove(); const i = $('#inp'); if (!i || i.selectionStart === i.selectionEnd) return;
  const r = i.getBoundingClientRect(); const bar = el(`<div class="fmt-bar"><button data-k="b"><b>B</b></button><button data-k="i"><i>I</i></button><button data-k="s"><s>S</s></button><button data-k="m" style="font-family:monospace">&lt;/&gt;</button><button data-k="p">${ic('eye-off').replace('class="i', 'style="width:1.1rem;height:1.1rem" class="i')}</button></div>`);
  document.body.appendChild(bar); bar.style.left = Math.min(r.left + 20, innerWidth - 220) + 'px'; bar.style.top = Math.max(8, r.top - 46) + 'px';
  const M = { b: ['**', '**'], i: ['__', '__'], s: ['~~', '~~'], m: ['`', '`'], p: ['||', '||'] };
  $$('button', bar).forEach(b => { b.onmousedown = e => e.preventDefault(); b.onclick = () => { wrapSel(...M[b.dataset.k]); bar.remove(); }; });
}
function onPaste(e) { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); openAttachModal(fs); } }
function renderCompTop() {
  const top = $('#comp-top'); if (!top) return;
  const x = S.edit ? { icon: 'pencil', title: t('Редактирование'), m: S.edit } : S.reply ? { icon: 'reply', title: `${t('Ответ')} ${S.reply.from === S.me.id ? t('себе').replace('себе', fullName(S.me)) : fullName(U(S.reply.from))}`, m: S.reply } : null;
  if (!x) { top.classList.add('hidden'); top.innerHTML = ''; return; }
  top.classList.remove('hidden'); top.innerHTML = `${ic(x.icon)}<div class="tx"><div class="t">${esc(x.title)}</div><div class="x">${esc(previewText(x.m, S.chats[S.active]))}</div></div><button class="btn-icon" id="ct-x" style="width:2.2rem;height:2.2rem">${ic('x')}</button>`;
  $('#ct-x').onclick = cancelReplyEdit;
}
function cancelReplyEdit() { if (S.edit) { S.edit = null; const i = $('#inp'); if (i) { i.value = S.drafts[S.active] || ''; autoGrow(); } } S.reply = null; renderCompTop(); updateSendBtn(); }
function startReply(m) { S.edit = null; S.reply = m; renderCompTop(); $('#inp')?.focus(); updateSendBtn(); }
function startEdit(m) { S.reply = null; S.edit = m; renderCompTop(); const i = $('#inp'); i.value = m.text || ''; autoGrow(); i.focus(); updateSendBtn(); }

/* send */
function sendFromInput() {
  const i = $('#inp'); const text = i.value.trim();
  if (S.edit) { return doEdit(text); }
  if (!text) return; i.value = ''; autoGrow(); updateSendBtn(); delete S.drafts[S.active]; localStorage.setItem('gm_drafts', JSON.stringify(S.drafts));
  sendMsg({ type: 'text', text }); closeEmojiPanel();
}
async function doEdit(text) {
  const m = S.edit; if (!m) return; if (!text && m.type === 'text') return toast(t('Сообщение не может быть пустым'));
  if (text === (m.text || '')) return cancelReplyEdit();
  try { await api('PATCH', `/api/messages/${m.id}`, { text }); cancelReplyEdit(); } catch (e) { toast(errText(e)); }
}
function pushPending(data, mediaLocal) {
  const c = S.chats[S.active]; const id = 'p' + (++S.pendingN); const rep = S.reply;
  const pm = { id, chatId: S.active, from: S.me.id, type: data.type, text: data.text || '', ts: Date.now(), pending: true, reactions: {}, media: data.media ? { ...data.media, ...(mediaLocal ? { local: mediaLocal, url: mediaLocal } : {}) } : undefined, sticker: data.sticker, loc: data.loc, poll: undefined, replyTo: rep?.id, reply: rep ? { id: rep.id, from: rep.from, text: rep.text, type: rep.type } : undefined };
  if (data.type === 'poll') return null;
  if (S.cm.hasAfter) { return null; }
  appendMsg(pm); scrollBottom(true); return pm;
}
async function sendMsg(data, opts = {}) {
  const cid = S.active; if (!cid) return;
  if (S.cm.hasAfter) { await openChat(cid, { force: true, noFocus: true }); }
  const body = { ...data, replyTo: S.reply?.id, silent: opts.silent || undefined, scheduleAt: opts.scheduleAt };
  const pm = opts.scheduleAt ? null : pushPending(data, opts.local); S.reply = null; renderCompTop();
  const done = pm ? (m) => { const k = S.cm?.list.findIndex(x => x.id === pm.id); if (k >= 0) { S.cm.list[k] = m; patchRow(pm.id, m); } } : null;
  try {
    const r = await api('POST', `/api/chats/${encodeURIComponent(cid)}/messages`, body);
    if (r.scheduled) { toast(t('Сообщение запланировано на {d}', { d: new Date(r.scheduled.at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) })); return r; }
    sndSend();
    if (S.cm && S.cm.chatId === cid) { const k = S.cm.list.findIndex(x => x.id === pm?.id); const has = S.cm.list.some(x => x.id === r.message.id); if (has) { if (k >= 0) { S.cm.list.splice(k, 1); $(`.mrow[data-id="${pm.id}"]`)?.remove(); } } else if (k >= 0) { S.cm.list[k] = r.message; $(`.mrow[data-id="${pm.id}"]`)?.setAttribute('data-id', r.message.id); patchRow(r.message.id, r.message); } else if (!pm) { appendMsg(r.message); scrollBottom(true); } }
    return r;
  } catch (e) {
    if (pm && S.cm) { S.cm.list = S.cm.list.filter(x => x.id !== pm.id); $(`.mrow[data-id="${pm.id}"]`)?.remove(); }
    toast(errText(e)); if (data.type === 'text' && $('#inp') && !$('#inp').value) { $('#inp').value = data.text; updateSendBtn(); autoGrow(); } return null;
  }
}
async function sendMedia({ type, blob, name, meta = {}, text = '', silent }) {
  const cid = S.active; const local = URL.createObjectURL(blob);
  const media = { name, size: blob.size, mime: blob.type, ...meta };
  S.socket.emit('typing', { chatId: cid, action: type === 'voice' ? 'voice' : type === 'circle' ? 'video' : 'upload' });
  if (S.cm.hasAfter) await openChat(cid, { force: true, noFocus: true });
  const pm = pushPending({ type, text, media }, local); const rep = S.reply; S.reply = null; renderCompTop();
  try {
    const up = await upload(blob, name);
    const r = await api('POST', `/api/chats/${encodeURIComponent(cid)}/messages`, { type, text, media: { ...media, url: up.url, mime: up.mime }, replyTo: rep?.id, silent });
    sndSend();
    if (S.cm && S.cm.chatId === cid && pm) { const k = S.cm.list.findIndex(x => x.id === pm.id); const has = S.cm.list.some(x => x.id === r.message.id); if (has) { if (k >= 0) { S.cm.list.splice(k, 1); $(`.mrow[data-id="${pm.id}"]`)?.remove(); } } else if (k >= 0) { S.cm.list[k] = r.message; $(`.mrow[data-id="${pm.id}"]`)?.setAttribute('data-id', r.message.id); patchRow(r.message.id, r.message); } }
  } catch (e) { if (S.cm && pm) { S.cm.list = S.cm.list.filter(x => x.id !== pm.id); $(`.mrow[data-id="${pm.id}"]`)?.remove(); } toast(errText(e)); }
}

/* send button: tap / hold-to-record / context */
function bindSendButton() {
  const b = $('#send-btn'); let holdT = null, sx = 0, sy = 0, holding = false;
  b.onclick = e => { if (b.dataset.has) sendFromInput(); };
  b.oncontextmenu = e => { e.preventDefault(); if (b.dataset.has) sendOptions(e); };
  bindLongPress(b, e => { if (b.dataset.has) sendOptions(e); });
  b.onpointerdown = e => {
    if (b.dataset.has || e.button) return; e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (er) { }
    sx = e.clientX; sy = e.clientY; holding = false;
    holdT = setTimeout(() => { holding = true; startRecording(S.recMode); }, 230);
  };
  b.onpointermove = e => {
    if (!Rec.active || Rec.locked || !holding) return; const dx = e.clientX - sx, dy = e.clientY - sy;
    const hint = $('.rec-hint'); if (hint) hint.style.opacity = Math.max(0, 1 + dx / 120);
    if (dx < -110) { holding = false; stopRecording(false); }
    else if (dy < -80) { lockRecording(); }
  };
  b.onpointerup = e => {
    if (b.dataset.has) return; clearTimeout(holdT);
    if (Rec.starting) { Rec.lockAfterStart = true; return; }
    if (Rec.active && !Rec.locked && holding) { holding = false; stopRecording(true); }
    else if (!Rec.active && !holding) { S.recMode = S.recMode === 'voice' ? 'video' : 'voice'; localStorage.setItem('gm_recmode', S.recMode); updateSendBtn(); toast(S.recMode === 'video' ? t('Видеосообщение: удерживайте кнопку для записи кружка') : t('Голосовое: удерживайте кнопку для записи')); }
    else if (Rec.active && Rec.locked) { stopRecording(true); }
  };
}
function sendOptions(e) {
  popMenu([{ icon: 'bell-off', label: t('Отправить без звука'), onClick: () => { const text = $('#inp').value.trim(); if (!text) return; $('#inp').value = ''; autoGrow(); updateSendBtn(); sendMsg({ type: 'text', text }, { silent: true }); } },
  { icon: 'clock', label: t('Запланировать отправку'), onClick: scheduleDialog }], { x: e.clientX, y: e.clientY });
}
function scheduleDialog() {
  const text = $('#inp').value.trim(); if (!text) return toast(t('Введите сообщение'));
  const d = new Date(Date.now() + 3600e3); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  const m = modal({ title: t('Запланировать отправку'), body: `<div class="field" style="max-width:none;margin:.5rem 0"><input type="datetime-local" id="sch-dt" value="${d.toISOString().slice(0, 16)}" placeholder=" "><label>${t('Дата и время')}</label></div>`, buttons: [{ label: t('Отмена') }, { label: t('Запланировать'), onClick: async () => { const at = new Date($('#sch-dt').value).getTime(); if (!at || at < Date.now() + 10000) { toast(t('Выберите время в будущем')); return false; } $('#inp').value = ''; autoGrow(); updateSendBtn(); sendMsg({ type: 'text', text }, { scheduleAt: at }); } }] });
}
async function showScheduled() {
  const c = S.chats[S.active]; const r = await api('GET', `/api/chats/${encodeURIComponent(c.id)}/scheduled`);
  const body = el(`<div>${r.items.length ? r.items.map(s => `<div class="row-item static" data-id="${s.id}" style="padding-left:0;padding-right:0"><span class="grow"><span class="t">${esc(previewText({ type: s.data.type, text: s.data.text, media: s.data.media, poll: s.data.poll, sticker: s.data.sticker }, c))}</span><span class="s">${new Date(s.at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}</span></span><button class="btn-icon" data-send title="${t('Отправить сейчас')}">${ic('send')}</button><button class="btn-icon" data-del style="color:var(--danger)">${ic('trash-2')}</button></div>`).join('') : `<p style="color:var(--text2);text-align:center;padding:1.5rem 0">${t('Нет запланированных сообщений')}</p>`}</div>`);
  const m = modal({ title: t('Отложенные сообщения'), body });
  $$('.row-item', body).forEach(n => { $('[data-send]', n).onclick = async () => { await api('DELETE', `/api/scheduled/${n.dataset.id}?send=1`); n.remove(); }; $('[data-del]', n).onclick = async () => { await api('DELETE', `/api/scheduled/${n.dataset.id}`); n.remove(); }; });
}

/* ───────── recording: voice & circles ───────── */
function pickMime(kind) {
  const list = kind === 'voice' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'] : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function startRecording(kind) {
  if (Rec.active || Rec.starting) return; if (S.call) return toast(t('Нельзя записывать во время звонка'));
  if (!window.MediaRecorder || !navigator.mediaDevices) return toast(t('Запись не поддерживается в этом браузере'));
  Rec.starting = true; Rec.lockAfterStart = false;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(kind === 'voice' ? { audio: audioC() } : { audio: audioC(), video: videoC({ ...(CFG.camId ? {} : { facingMode: 'user' }), width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: 1 }) }); }
  catch (e) { Rec.starting = false; return toast(kind === 'voice' ? t('Нет доступа к микрофону') : t('Нет доступа к камере или микрофону')); }
  Rec.starting = false; Rec.active = true; Rec.kind = kind; Rec.locked = false; Rec.stream = stream; Rec.chunks = []; Rec.wave = []; Rec.t0 = Date.now(); Rec.cancel = false;
  const mime = pickMime(kind); Rec.mime = mime;
  const mr = Rec.mr = new MediaRecorder(stream, mime ? { mimeType: mime, ...(kind === 'circle' || kind === 'video' ? { videoBitsPerSecond: 900000 } : { audioBitsPerSecond: 48000 }) } : undefined);
  mr.ondataavailable = e => e.data.size && Rec.chunks.push(e.data); mr.onstop = onRecStop; mr.start(250);
  S.socket.emit('typing', { chatId: S.active, action: kind === 'voice' ? 'voice' : 'video' });
  Rec.typTimer = setInterval(() => S.socket.emit('typing', { chatId: S.active, action: kind === 'voice' ? 'voice' : 'video' }), 3500);
  if (kind === 'voice') {
    try { const c = audioCtx(); const src = c.createMediaStreamSource(stream); const an = Rec.an = c.createAnalyser(); an.fftSize = 512; src.connect(an); Rec.srcNode = src; } catch (e) { }
    $('#send-btn').classList.add('rec'); renderRecBar();
  } else { Rec.kind = 'video'; renderCircleRec(); $('#send-btn')?.classList.add('rec'); }
  Rec.tick = setInterval(recTick, 100);
  if (Rec.lockAfterStart) lockRecording();
}
function recTick() {
  const el_ = (Date.now() - Rec.t0) / 1000; const tm = $('.rec-time'); if (tm) tm.textContent = fmtDur(el_) + '.' + String(Math.floor(el_ * 10) % 10);
  if (Rec.an) { const d = new Uint8Array(Rec.an.fftSize); Rec.an.getByteTimeDomainData(d); let s = 0; for (const v of d) { const x = (v - 128) / 128; s += x * x; } const rms = Math.sqrt(s / d.length); const lvl = Math.min(31, Math.round(rms * 90)); Rec.wave.push(lvl); const w = $('.rec-wave'); if (w) { w.insertAdjacentHTML('beforeend', `<i style="height:${3 + lvl * .7}px"></i>`); while (w.children.length > 40) w.firstChild.remove(); } }
  if (Rec.kind === 'video') { const ring = $('.rec-circle svg circle'); if (ring) ring.style.strokeDashoffset = 100 - Math.min(100, el_ / 60 * 100); const rt = $('.rec-circle .rtime'); if (rt) rt.textContent = fmtDur(el_); }
  if (el_ >= 60 && Rec.kind === 'video') stopRecording(true);
  if (el_ >= 600) stopRecording(true);
}
function renderRecBar() {
  const row = $('#comp-row'); if (!row) return;
  row.innerHTML = `<div class="rec-bar"><span class="rec-dot"></span><span class="rec-time">0:00.0</span>${Rec.locked ? `<div class="rec-wave"></div><button class="btn-icon" id="rec-cancel" style="color:var(--danger)">${ic('trash-2')}</button>` : `<div class="rec-hint">◀ ${t('Влево — отмена, вверх — закрепить')}</div>`}</div>`;
  if (!Rec.locked && !$('.rec-lock')) $('#composer').insertAdjacentHTML('beforeend', `<div class="rec-lock">${ic('lock')}${ic('chevron-up')}</div>`);
  if (Rec.locked) { $('#send-btn').innerHTML = ic('send'); $('#send-btn').classList.remove('rec'); $('.rec-lock')?.remove(); $('#rec-cancel').onclick = () => stopRecording(false); }
  else { const w = el('<div class="rec-wave" style="display:none"></div>'); }
}
function lockRecording() { if (!Rec.active || Rec.locked) return; Rec.locked = true; if (Rec.kind === 'voice') renderRecBar(); else { $('.rec-circle .acts')?.classList.remove('hidden'); $('#send-btn')?.classList.remove('rec'); } }
function renderCircleRec() {
  const ov = el(`<div class="rec-circle"><div class="rcw"><div class="cv"><video autoplay muted playsinline></video></div><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg></div><div class="rtime" style="font-size:1.2rem;font-weight:600">0:00</div><div class="acts hidden"><button id="rc-x">${ic('trash-2')}</button><button class="go" id="rc-go">${ic('send')}</button></div><div style="opacity:.7;font-size:.85rem">${t('Отпустите — отправить · Проведите влево — отмена')}</div></div>`);
  $('video', ov).srcObject = Rec.stream; document.body.appendChild(ov); Rec.overlay = ov;
  $('#rc-x', ov).onclick = () => stopRecording(false); $('#rc-go', ov).onclick = () => stopRecording(true);
}
function stopRecording(send) {
  if (!Rec.active) return; Rec.active = false; Rec.cancel = !send; Rec.send = send; clearInterval(Rec.tick); clearInterval(Rec.typTimer);
  try { Rec.mr.stop(); } catch (e) { onRecStop(); }
  Rec.stream?.getTracks().forEach(tr => tr.stop()); try { Rec.srcNode?.disconnect(); } catch (e) { } Rec.overlay?.remove(); Rec.overlay = null; $('.rec-lock')?.remove(); $('#send-btn')?.classList.remove('rec');
  const row = $('#comp-row'); if (row) { const keep = S.drafts[S.active] || ''; row.innerHTML = `<button class="btn-icon" id="b-emoji" data-menu-keep>${ic('smile')}</button><textarea id="inp" rows="1" placeholder="${t('Сообщение')}" maxlength="4096"></textarea><button class="btn-icon" id="b-attach" data-menu-keep>${ic('paperclip')}</button>`; const inp = $('#inp'); inp.value = keep; inp.addEventListener('input', onInput); inp.addEventListener('keydown', onInpKey); inp.addEventListener('paste', onPaste); $('#b-emoji').onclick = toggleEmojiPanel; $('#b-attach').onclick = attachMenu; autoGrow(); updateSendBtn(); }
}
async function onRecStop() {
  const dur = (Date.now() - Rec.t0) / 1000; const kind = Rec.kind; const mime = Rec.mime || (kind === 'voice' ? 'audio/webm' : 'video/webm');
  if (!Rec.send) return; if (dur < (kind === 'voice' ? .7 : 1)) { toast(t('Слишком короткая запись')); return; }
  const blob = new Blob(Rec.chunks, { type: mime.split(';')[0] }); const ext = /mp4/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : 'webm';
  if (kind === 'voice') {
    const w = Rec.wave, N = 40, out = []; for (let i = 0; i < N; i++) { const a = Math.floor(i * w.length / N), b = Math.max(a + 1, Math.floor((i + 1) * w.length / N)); let s = 0, n = 0; for (let k = a; k < b && k < w.length; k++) { s += w[k]; n++; } out.push(n ? Math.round(s / n) : 2); }
    const mx = Math.max(...out, 1), norm = out.map(v => Math.max(2, Math.round(v / mx * 31)));
    sendMedia({ type: 'voice', blob, name: `voice.${ext}`, meta: { duration: Math.round(dur * 10) / 10, waveform: norm } });
  } else sendMedia({ type: 'circle', blob, name: `circle.${ext}`, meta: { duration: Math.round(dur * 10) / 10, w: 480, h: 480 } });
}

/* ───────── voice playback ───────── */
const VP = { audio: new Audio(), id: null, rate: 1 }; VP.audio.preload = 'auto';
const LISTENED = new Set(JSON.parse(localStorage.getItem('gm_listened') || '[]'));
function findMsgLocal(id) { return S.cm?.list.find(m => String(m.id) === String(id)); }
function voiceHTML(m) {
  const wf = m.media.waveform && m.media.waveform.length ? m.media.waveform : Array.from({ length: 40 }, (_, i) => 4 + ((hashN(m.id + '' + i) % 24)));
  const bars = wf.map((v, i) => `<i style="height:${Math.max(3, 3 + v / 31 * 26)}px"></i>`).join('');
  const out = m.from === S.me.id;
  return `<div class="voice" data-id="${m.id}"><button class="pb">${ic('play')}</button><div style="flex:1;min-width:0"><div class="wf">${bars}</div><div class="vd"><span class="vt">${fmtDur(m.media.duration)}</span>${!out && !LISTENED.has(String(m.id)) && !m.pending ? '<span class="unl"></span>' : ''}<span class="spd hidden"></span></div></div></div>`;
}
function refreshVoiceUI(node) {
  const id = node.dataset.id; const m = findMsgLocal(id); if (!m) return; const active = String(VP.id) === String(id);
  const playing = active && !VP.audio.paused; const dur = m.media.duration || VP.audio.duration || 0; const cur = active ? VP.audio.currentTime : 0;
  $('.pb', node).innerHTML = ic(playing ? 'pause' : 'play'); const bars = $$('.wf i', node); const upto = active ? Math.round(cur / (dur || 1) * bars.length) : 0;
  bars.forEach((b, i) => b.classList.toggle('pl', i < upto)); $('.vt', node).textContent = active && (playing || cur > 0) ? fmtDur(cur) : fmtDur(dur);
  const sp = $('.spd', node); sp.classList.toggle('hidden', !active); sp.textContent = VP.rate + '×';
}
function refreshActiveVoice() { $$('.voice').forEach(n => refreshVoiceUI(n)); }
function toggleVoice(id) {
  const m = findMsgLocal(id); if (!m || m.pending && !m.media.url) return;
  stopCircles();
  if (String(VP.id) === String(id)) { VP.audio.paused ? VP.audio.play() : VP.audio.pause(); return refreshActiveVoice(); }
  VP.id = id; applySink(VP.audio); VP.audio.src = m.media.url; VP.audio.playbackRate = VP.rate; VP.audio.play().catch(() => toast(t('Не удалось воспроизвести')));
  LISTENED.add(String(id)); localStorage.setItem('gm_listened', JSON.stringify([...LISTENED].slice(-500))); $(`.voice[data-id="${id}"] .unl`)?.remove();
  refreshActiveVoice();
}
VP.audio.addEventListener('loadedmetadata', () => { if (VP.audio.duration === Infinity) { VP.fix = true; VP.audio.currentTime = 1e7; } });
VP.audio.addEventListener('timeupdate', () => { if (VP.fix) { if (VP.audio.duration !== Infinity) { VP.fix = false; VP.audio.currentTime = 0; } return; } const n = $(`.voice[data-id="${VP.id}"]`); if (n) refreshVoiceUI(n); });
VP.audio.addEventListener('play', refreshActiveVoice); VP.audio.addEventListener('pause', refreshActiveVoice);
VP.audio.addEventListener('ended', () => {
  const cur = VP.id; VP.audio.currentTime = 0; VP.id = null; refreshActiveVoice(); if (!S.cm) return;
  const i = S.cm.list.findIndex(m => String(m.id) === String(cur)); const nx = S.cm.list.slice(i + 1).find(m => m.type === 'voice' && m.from !== S.me.id && !LISTENED.has(String(m.id)));
  if (nx) toggleVoice(nx.id);
});
function stopVoicePlayback() { try { VP.audio.pause(); } catch (e) { } VP.id = null; refreshActiveVoice(); }
function seekVoice(id, e, wf) {
  const m = findMsgLocal(id); if (!m) return; if (String(VP.id) !== String(id)) { toggleVoice(id); }
  const r = wf.getBoundingClientRect(); const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); const d = m.media.duration || VP.audio.duration;
  const seek = () => { try { VP.audio.currentTime = k * d; } catch (er) { } refreshActiveVoice(); }; if (VP.audio.readyState >= 1) seek(); else VP.audio.addEventListener('loadedmetadata', seek, { once: true });
}
function cycleVoiceSpeed(id) { const rates = [1, 1.5, 2]; VP.rate = rates[(rates.indexOf(VP.rate) + 1) % 3]; VP.audio.playbackRate = VP.rate; refreshActiveVoice(); }

/* circles */
function circleHTML(m) {
  const src = m.media.url || m.media.local;
  return `<div class="circle-wrap" data-id="${m.id}"><video src="${esc(src)}${m.pending ? '' : '#t=0.1'}" playsinline muted loop preload="metadata"></video><svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48.5" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg><div class="cdur">${fmtDur(m.media.duration)}</div><div class="cplay">${ic('play')}</div></div>`;
}
function stopCircles(except) { $$('.circle-wrap.playing').forEach(n => { if (n !== except) resetCircle(n); }); }
function resetCircle(n) { n.classList.remove('playing'); const v = $('video', n); v.muted = true; v.loop = true; v.onended = null; v.ontimeupdate = null; v.currentTime = 0; $('circle', n).style.strokeDashoffset = 100; const m = findMsgLocal(n.dataset.id); $('.cdur', n).textContent = fmtDur(m?.media.duration); v.play().catch(() => { }); }
function toggleCircle(n) {
  const v = $('video', n); if (n.classList.contains('playing')) { return resetCircle(n); }
  stopCircles(n); stopVoicePlayback(); n.classList.add('playing'); v.loop = false; v.muted = false; v.currentTime = 0; v.play().catch(() => { });
  const m = findMsgLocal(n.dataset.id); const d = m?.media.duration || v.duration || 1;
  v.ontimeupdate = () => { $('circle', n).style.strokeDashoffset = 100 - v.currentTime / d * 100; $('.cdur', n).textContent = fmtDur(v.currentTime); };
  v.onended = () => resetCircle(n);
}

/* ───────── attachments ───────── */
function attachMenu() {
  popMenu([
    { icon: 'image', label: t('Фото или видео'), onClick: async () => { const f = await pickFile('image/*,video/*', true); f.length && openAttachModal(f, true); } },
    { icon: 'file', label: t('Файл'), onClick: async () => { const f = await pickFile('*/*', true); f.length && openAttachModal(f, false); } },
    { icon: 'bar-chart-3', label: t('Опрос'), onClick: pollDialog },
    { icon: 'map-pin', label: t('Геопозиция'), onClick: sendLocation },
    { icon: 'camera', label: t('Видеосообщение (кружок)'), onClick: () => { S.recMode = 'video'; localStorage.setItem('gm_recmode', 'video'); updateSendBtn(); toast(t('Удерживайте кнопку справа для записи кружка')); } },
  ], { el: $('#b-attach'), right: false });
}
function openAttachModal(files, media) {
  const c = S.chats[S.active]; if (!c || !c.canPost) return;
  files = files.slice(0, 10); const items = files.map(f => ({ f, img: /^image\/(jpeg|png|webp|gif)/.test(f.type), vid: /^video\/(mp4|webm|quicktime)/.test(f.type), url: URL.createObjectURL(f) }));
  const body = el(`<div><div class="attach-prev">${items.map((it, i) => `<div class="ap" ${it.img ? `style="background-image:url('${it.url}')"` : ''} data-i="${i}">${it.vid ? `<video src="${it.url}#t=0.1" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" muted></video>` : ''}${!it.img && !it.vid ? `${ic('file-text')}<span>${esc(it.f.name.slice(0, 20))}</span><span style="color:var(--text2)">${fmtSize(it.f.size)}</span>` : ''}<button data-rm>${ic('x')}</button></div>`).join('')}</div>
  ${items.some(i => i.img) ? `<label class="check"><input type="checkbox" id="at-comp" checked><span class="box">${ic('check')}</span><span>${t('Сжать изображения')}</span></label>` : ''}
  <div class="field" style="max-width:none;margin:.5rem 0 0"><textarea id="at-cap" placeholder=" " rows="1" maxlength="1024"></textarea><label>${t('Подпись')}</label></div></div>`);
  const inp = $('#inp'); if (inp && inp.value.trim()) { $('#at-cap', body).value = inp.value.trim(); }
  const m = modal({ title: `${t('Отправить')} ${items.length} ${pl(items.length, 'файл', 'файла', 'файлов')}`, body, buttons: [{ label: t('Отмена') }, { label: t('Отправить'), onClick: () => doSendFiles(items, $('#at-cap', body).value.trim(), $('#at-comp', body)?.checked ?? true) }] });
  $$('[data-rm]', body).forEach(b => b.onclick = e => { e.stopPropagation(); const i = +b.parentNode.dataset.i; items[i] = null; b.parentNode.remove(); if (!items.some(Boolean)) m.close(); });
  setTimeout(() => $('#at-cap', body).focus(), 80);
}
async function doSendFiles(items, caption, compress) {
  if (inpHasCaption(caption)) { const i = $('#inp'); i.value = ''; autoGrow(); updateSendBtn(); }
  let first = true;
  for (const it of items.filter(Boolean)) {
    const text = first ? caption : ''; first = false; const f = it.f;
    try {
      if (it.img && compress && f.type !== 'image/gif') { const { blob, w, h } = await compressImage(f); await sendMedia({ type: 'photo', blob, name: f.name.replace(/\.\w+$/, '') + (blob.type === 'image/png' ? '.png' : '.jpg'), meta: { w, h }, text }); }
      else if (it.img && compress) { const im = await loadImage(it.url); await sendMedia({ type: 'photo', blob: f, name: f.name, meta: { w: im.width, h: im.height }, text }); }
      else if (it.vid) { const meta = await videoMeta(f); await sendMedia({ type: 'video', blob: f, name: f.name, meta, text }); }
      else await sendMedia({ type: 'file', blob: f, name: f.name, text });
    } catch (e) { toast(t('Не удалось отправить файл')); }
  }
}
const inpHasCaption = cap => { const i = $('#inp'); return cap && i && i.value.trim() === cap; };
function pollDialog() {
  const body = el(`<div><div class="field" style="max-width:none"><input id="pl-q" placeholder=" " maxlength="255"><label>${t('Вопрос')}</label></div><div id="pl-opts"></div><button class="btn flat" id="pl-add" style="padding-left:0">${ic('plus')} ${t('Добавить вариант')}</button>
  <label class="check"><input type="checkbox" id="pl-anon" checked><span class="box">${ic('check')}</span><span>${t('Анонимное голосование')}</span></label><label class="check"><input type="checkbox" id="pl-multi"><span class="box">${ic('check')}</span><span>${t('Несколько ответов')}</span></label><label class="check"><input type="checkbox" id="pl-quiz"><span class="box">${ic('check')}</span><span>${t('Режим викторины (отметьте верный ответ)')}</span></label></div>`);
  const opts = $('#pl-opts', body); const add = () => { if ($$('.po', opts).length >= 10) return; opts.insertAdjacentHTML('beforeend', `<div class="po" style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="pl-c" style="accent-color:var(--accent);display:none"><div class="field" style="max-width:none;margin-bottom:.6rem;flex:1"><input placeholder=" " maxlength="100"><label>${t('Вариант')}</label></div></div>`); };
  add(); add(); $('#pl-add', body).onclick = add;
  $('#pl-quiz', body).onchange = e => { $$('.po input[type=radio]', opts).forEach(r => r.style.display = e.target.checked ? '' : 'none'); if (e.target.checked) { $('#pl-multi', body).checked = false; $$('.po input[type=radio]', opts)[0].checked = true; } };
  modal({ title: t('Новый опрос'), body, buttons: [{ label: t('Отмена') }, { label: t('Создать'), onClick: () => {
    const q = $('#pl-q', body).value.trim(); const os = $$('.po', opts).map(p => $('.field input', p).value.trim()); const quiz = $('#pl-quiz', body).checked; const correct = $$('.po', opts).findIndex(p => $('input[type=radio]', p).checked);
    if (!q || os.filter(Boolean).length < 2) { toast(t('Нужен вопрос и минимум 2 варианта')); return false; }
    const filtered = os.map((o, i) => ({ o, i })).filter(x => x.o); sendMsg({ type: 'poll', poll: { q, options: filtered.map(x => x.o), anon: $('#pl-anon', body).checked, multiple: $('#pl-multi', body).checked, quiz, correct: Math.max(0, filtered.findIndex(x => x.i === correct)) } });
  } }] });
}
function sendLocation() {
  if (!navigator.geolocation) return toast(t('Геолокация недоступна'));
  navigator.geolocation.getCurrentPosition(p => sendMsg({ type: 'location', loc: { lat: p.coords.latitude, lng: p.coords.longitude } }), () => toast(t('Нет доступа к геопозиции')), { timeout: 10000 });
}

/* ───────── emoji / stickers panel ───────── */
function closeEmojiPanel() { $('.emoji-panel')?.remove(); }
function toggleEmojiPanel() {
  if ($('.emoji-panel')) return closeEmojiPanel();
  const p = el(`<div class="emoji-panel"><div class="ep-tabs"><button class="main-tab on" data-m="emoji">Emoji</button><button class="main-tab" data-m="stk">${t('Стикеры')}</button></div><div class="ep-tabs" id="ep-cats">${Object.keys(EMOJI).map((k, i) => `<button data-c="${i}" class="${i === 0 ? 'on' : ''}">${k}</button>`).join('')}</div><div class="ep-grid" id="ep-grid"></div></div>`);
  $('#composer').appendChild(p); let mode = 'emoji';
  const draw = () => {
    const g = $('#ep-grid', p); $('#ep-cats', p).style.display = mode === 'emoji' ? '' : 'none';
    if (mode === 'stk') { g.className = 'ep-grid stk'; g.innerHTML = STICKERS.map(s => `<button data-s="${s}">${s}</button>`).join(''); }
    else { g.className = 'ep-grid'; g.innerHTML = Object.entries(EMOJI).map(([k, v], i) => `<div class="cat" id="cat${i}">${[t('Смайлы'), t('Жесты и люди'), t('Животные и природа'), t('Еда и напитки'), t('Активности и транспорт'), t('Символы')][i]}</div>${v.split(' ').map(e => `<button data-e="${e}">${e}</button>`).join('')}`).join(''); }
  };
  draw();
  $$('.main-tab', p).forEach(b => b.onclick = () => { mode = b.dataset.m; $$('.main-tab', p).forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $$('#ep-cats button', p).forEach(b => b.onclick = () => { $$('#ep-cats button', p).forEach(x => x.classList.toggle('on', x === b)); $('#cat' + b.dataset.c, p)?.scrollIntoView(); });
  $('#ep-grid', p).onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.s) { sendMsg({ type: 'sticker', sticker: b.dataset.s }); closeEmojiPanel(); return; }
    const i = $('#inp'); i.setRangeText(b.dataset.e, i.selectionStart, i.selectionEnd, 'end'); onInput();
  };
  setTimeout(() => document.addEventListener('mousedown', function h(e) { if (!p.isConnected) return document.removeEventListener('mousedown', h); if (!p.contains(e.target) && !e.target.closest('#b-emoji')) { p.remove(); document.removeEventListener('mousedown', h); } }), 0);
}

/* ───────── media viewer ───────── */
function openViewer(id) {
  const list = S.cm.list.filter(m => (m.type === 'photo' || m.type === 'video') && !m.pending); let idx = list.findIndex(m => m.id === id); if (idx < 0) return;
  const v = el(`<div class="viewer"><div class="vtop"><div class="grow" id="v-info"></div><button class="btn-icon" id="v-fwd">${ic('forward')}</button><a class="btn-icon" id="v-dl" download>${ic('download')}</a><button class="btn-icon" id="v-x">${ic('x')}</button></div><div id="v-media" style="display:flex"></div><button class="nav l" id="v-l">${ic('chevron-left')}</button><button class="nav r" id="v-r">${ic('chevron-right')}</button><div class="vcap" id="v-cap"></div></div>`);
  const draw = () => { const m = list[idx]; $('#v-media', v).innerHTML = m.type === 'photo' ? `<img src="${esc(m.media.url)}">` : `<video src="${esc(m.media.url)}" controls autoplay playsinline></video>`; $('#v-info', v).innerHTML = `<b>${esc(fullName(U(m.from)))}</b><div style="font-size:.8rem;opacity:.8">${dayLabel(m.ts)} ${fmtTime(m.ts)} · ${idx + 1}/${list.length}</div>`; $('#v-cap', v).innerHTML = fmt(m.text || ''); $('#v-dl', v).href = m.media.url + '?dl=1'; $('#v-dl', v).setAttribute('download', m.media.name || 'file'); $('#v-l', v).style.display = idx > 0 ? '' : 'none'; $('#v-r', v).style.display = idx < list.length - 1 ? '' : 'none'; };
  const close = () => { v.remove(); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft' && idx > 0) { idx--; draw(); } if (e.key === 'ArrowRight' && idx < list.length - 1) { idx++; draw(); } };
  document.addEventListener('keydown', key); document.body.appendChild(v); draw();
  $('#v-x', v).onclick = close; $('#v-l', v).onclick = () => { idx--; draw(); }; $('#v-r', v).onclick = () => { idx++; draw(); }; $('#v-fwd', v).onclick = () => { close(); forwardDialog(S.active, [list[idx].id]); };
  v.addEventListener('click', e => { if (e.target === v || e.target.id === 'v-media') close(); });
}

/* ───────── actions on messages ───────── */
async function react(id, emoji, quick) {
  const m = findMsgLocal(id); if (!m) return;
  try { await api('POST', `/api/messages/${id}/react`, { emoji }); } catch (e) { toast(errText(e)); }
}
function msgMenu(id, e) {
  if (S.selMode) return; const m = findMsgLocal(id); if (!m || m.pending || m.type === 'service') return; const c = S.chats[m.chatId]; const mine = m.from === S.me.id;
  const canPin = c.type === 'private' || c.type === 'saved' || c.me.role !== 'member'; const pinned = (c.pins || []).includes(m.id);
  const top = `<div class="rbar">${REACTIONS.map(r => `<button data-r="${r}">${r}</button>`).join('')}</div>`;
  const media = ['photo', 'video', 'file', 'voice', 'circle'].includes(m.type);
  const items = [
    c.canPost && { icon: 'reply', label: t('Ответить'), onClick: () => startReply(m) },
    m.text && { icon: 'copy', label: t('Копировать текст'), onClick: () => copyText(m.text) },
    canPin && { icon: pinned ? 'pin-off' : 'pin', label: pinned ? t('Открепить') : t('Закрепить'), onClick: () => api('POST', `/api/chats/${encodeURIComponent(c.id)}/pin`, { msgId: m.id, unpin: pinned }).catch(er => toast(errText(er))) },
    m.type !== 'call' && { icon: 'forward', label: t('Переслать'), onClick: () => forwardDialog(c.id, [m.id]) },
    mine && !m.fwd && ['text', 'photo', 'video', 'file'].includes(m.type) && { icon: 'pencil', label: t('Изменить'), onClick: () => startEdit(m) },
    media && { icon: 'download', label: t('Скачать'), onClick: () => { const a = document.createElement('a'); a.href = m.media.url + '?dl=1'; a.download = m.media.name; a.click(); } },
    c.type !== 'saved' && m.type !== 'call' && { icon: 'bookmark', label: t('В «Избранное»'), onClick: async () => { await api('POST', '/api/messages/forward', { fromChat: c.id, ids: [m.id], toChats: [`p:${S.me.id}:${S.me.id}`], hideName: true }); toast(t('Сохранено в «Избранное»')); } },
    { icon: 'check-circle', label: t('Выбрать'), onClick: () => enterSelect(m.id) },
    !mine && c.type !== 'saved' && m.type !== 'call' && !U(m.from)?.system && { icon: 'flag', label: t('Пожаловаться'), onClick: () => reportDialog({ kind: 'message', target: c.id, msgId: m.id }) },
    { sep: 1 },
    (mine || c.type === 'private' || c.type === 'saved' || c.me.role !== 'member') && { icon: 'trash-2', danger: true, label: t('Удалить'), onClick: () => deleteDialog([m.id]) },
  ];
  const mn = popMenu(items, { x: e.clientX, y: e.clientY + 44 }, { top });
  $$('.rbar button', mn).forEach(b => b.onclick = () => { closeMenu(); react(m.id, b.dataset.r); });
  const r = mn.getBoundingClientRect(); if (r.top < 8) mn.style.top = '8px';
}
async function deleteDialog(ids) {
  const c = S.chats[S.active]; const msgs = S.cm.list.filter(m => ids.includes(m.id)); if (!msgs.length) return;
  const allMine = msgs.every(m => m.from === S.me.id), admin = c.me.role !== 'member' && c.type !== 'private' && c.type !== 'saved';
  let extra = '', forced = false;
  if (c.type === 'private') extra = `<label class="check"><input type="checkbox" id="d-all" checked><span class="box">${ic('check')}</span><span>${t('Также удалить у {n}', { n: esc(U(c.peer)?.name || '') })}</span></label>`;
  else if (c.type === 'saved') forced = false;
  else if (c.type === 'channel') forced = true;
  else if (allMine || admin) extra = `<label class="check"><input type="checkbox" id="d-all" ${allMine ? 'checked' : ''}><span class="box">${ic('check')}</span><span>${t('Удалить для всех')}</span></label>`;
  const r = await confirmBox(msgs.length === 1 ? t('Удалить это сообщение?') : t('Удалить {n} сообщений?', { n: msgs.length }), { ok: t('Удалить'), danger: true, extra });
  if (!r) return; const forAll = forced || !!$('#d-all', r.extra)?.checked;
  try { await api('POST', '/api/messages/delete', { chatId: c.id, ids, forAll }); exitSelect(); } catch (e) { toast(errText(e)); }
}
function forwardDialog(fromChat, ids) {
  const chats = sortedChats().filter(c => c.canPost); const sel = new Set();
  const body = el(`<div><div class="field" style="max-width:none;margin:0 0 .5rem"><input id="fw-q" placeholder=" "><label>${t('Поиск')}</label></div><div id="fw-list" style="max-height:20rem;overflow-y:auto;margin:0 -1.25rem"></div><label class="check"><input type="checkbox" id="fw-hide"><span class="box">${ic('check')}</span><span>${t('Скрыть имя отправителя')}</span></label></div>`);
  const draw = () => { const q = $('#fw-q', body).value.toLowerCase(); $('#fw-list', body).innerHTML = chats.filter(c => chatTitle(c).toLowerCase().includes(q)).map(c => `<div class="member" data-id="${esc(c.id)}">${chatAv(c, '2.8rem')}<div class="mn" style="flex:1">${esc(chatTitle(c))}</div><span class="check" style="padding:0"><span class="box round" style="${sel.has(c.id) ? 'background:var(--accent);border-color:var(--accent);color:#fff' : ''}">${ic('check')}</span></span></div>`).join(''); $$('.member', body).forEach(n => n.onclick = () => { sel.has(n.dataset.id) ? sel.delete(n.dataset.id) : sel.add(n.dataset.id); draw(); }); };
  draw(); $('#fw-q', body).oninput = draw;
  modal({ title: t('Переслать'), body, buttons: [{ label: t('Отмена') }, { label: t('Переслать'), onClick: async () => { if (!sel.size) { toast(t('Выберите чат')); return false; } try { await api('POST', '/api/messages/forward', { fromChat, ids, toChats: [...sel], hideName: $('#fw-hide', body).checked }); exitSelect(); toast(t('Сообщения пересланы')); if (sel.size === 1) openChat([...sel][0]); } catch (e) { toast(errText(e)); } } }] });
}
