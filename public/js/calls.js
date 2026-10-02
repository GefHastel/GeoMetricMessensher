/* GeoMetric Beta — звонки и видеозвонки (WebRTC, сигналинг через Socket.IO) */
'use strict';
let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const callId = () => Math.random().toString(36).slice(2, 10);

async function getLocalMedia(video) {
  try { return await navigator.mediaDevices.getUserMedia({ audio: audioC(), video: video ? videoC({ width: { ideal: 1280 }, height: { ideal: 720 }, ...(CFG.camId ? {} : { facingMode: 'user' }) }) : false }); }
  catch (e) {
    if (video) { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); toast(t('Камера недоступна — звонок будет только с голосом')); return s; } catch (e2) { } }
    toast(t('Нет доступа к микрофону')); return null;
  }
}
async function startCall(uid, video) {
  if (S.call) return toast(t('Вы уже в звонке'));
  if (!navigator.mediaDevices?.getUserMedia) return toast(t('Звонки не поддерживаются в этом браузере (нужен HTTPS)'));
  const local = await getLocalMedia(video); if (!local) return;
  try { const r = await api('GET', '/api/ice'); ICE_SERVERS = r.iceServers; } catch (e) { }
  const id = callId();
  S.call = { id, peer: uid, video: !!video && local.getVideoTracks().length > 0, dir: 'out', state: 'calling', local, remoteState: {}, polite: false, t0: 0 };
  showCallUI(); startRing(true);
  S.socket.emit('call:invite', { to: uid, video: S.call.video, callId: id }, r => { if (r && r.error) { toast(errText({ error: r.error })); cleanupCall(); } });
}
function onCallIncoming(d) {
  mergeUsers([d.from]);
  if (S.call || S.incoming) { S.socket.emit('call:decline', { callId: d.callId }); return; }
  S.incoming = d; startRing(false);
  notify(fullName(d.from), d.video ? t('Входящий видеозвонок') : t('Входящий звонок'), '');
  const box = el(`<div class="incoming" id="incoming">${userAv(d.from, '3.4rem')}<div><div class="nm">${esc(fullName(d.from))}</div><div class="st">${d.video ? t('Входящий видеозвонок…') : t('Входящий звонок…')}</div></div><div class="acts"><button class="no" id="in-no">${ic('phone-off')}</button><button class="yes" id="in-yes">${ic(d.video ? 'video' : 'phone')}</button></div></div>`);
  document.body.appendChild(box);
  $('#in-no').onclick = () => { S.socket.emit('call:decline', { callId: d.callId }); clearIncoming(); };
  $('#in-yes').onclick = async () => {
    const inc = S.incoming; clearIncoming(); if (!inc) return;
    const local = await getLocalMedia(inc.video); if (!local) { S.socket.emit('call:decline', { callId: inc.callId }); return; }
    try { const r = await api('GET', '/api/ice'); ICE_SERVERS = r.iceServers; } catch (e) { }
    S.call = { id: inc.callId, peer: inc.from.id, video: inc.video && local.getVideoTracks().length > 0, dir: 'in', state: 'connecting', local, remoteState: {}, polite: true, t0: 0 };
    showCallUI(); S.socket.emit('call:accept', { callId: inc.callId });
  };
}
function clearIncoming() { stopRing(); S.incoming = null; $('#incoming')?.remove(); }
function makePC() {
  const c = S.call; if (c.pc) return c.pc;
  const pc = c.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); c.remote = new MediaStream();
  pc.onicecandidate = e => e.candidate && sendSig({ type: 'candidate', candidate: e.candidate });
  pc.ontrack = e => { if (!c.remote.getTracks().includes(e.track)) c.remote.addTrack(e.track); const v = $('#call-rv'); if (v) { if (v.srcObject !== c.remote) v.srcObject = c.remote; applySink(v); v.play().catch(() => { }); } updateCallUI(); };
  pc.onconnectionstatechange = () => {
    if (!S.call || S.call.pc !== pc) return;
    if (pc.connectionState === 'connected') { clearTimeout(c.failT); if (c.state !== 'active') { c.state = 'active'; c.t0 = Date.now(); stopRing(); tone([660, 880], .12, 'sine', .8); c.timer = setInterval(updateCallUI, 1000); updateCallUI(); } }
    if (pc.connectionState === 'failed') hangup();
    if (pc.connectionState === 'disconnected') { c.failT = setTimeout(() => S.call && S.call.pc === pc && pc.connectionState !== 'connected' && hangup(), 9000); }
  };
  let making = false; c.ignoreOffer = false;
  pc.onnegotiationneeded = async () => { try { making = true; await pc.setLocalDescription(); sendSig({ type: 'desc', desc: pc.localDescription }); } catch (e) { console.warn(e); } finally { making = false; } };
  c.isMaking = () => making;
  return pc;
}
const sendSig = data => S.call && S.socket.emit('call:signal', { callId: S.call.id, data });
function addLocalTracks() { const c = S.call, pc = c.pc; c.local.getTracks().forEach(tr => { if (!pc.getSenders().some(s => s.track === tr)) pc.addTrack(tr, c.local); }); }
async function onCallAccepted() { const c = S.call; if (!c || c.dir !== 'out') return; stopRing(); c.state = 'connecting'; updateCallUI(); makePC(); addLocalTracks(); }
async function onCallSignal({ callId, data }) {
  const c = S.call; if (!c || c.id !== callId) return;
  if (data.type === 'media') { c.remoteState = { ...c.remoteState, ...data.state }; updateCallUI(); return; }
  const pc = makePC();
  try {
    if (data.type === 'desc') {
      const d = data.desc; const collision = d.type === 'offer' && (c.isMaking() || pc.signalingState !== 'stable');
      c.ignoreOffer = !c.polite && collision; if (c.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') { if (c.dir === 'in') addLocalTracks(); await pc.setLocalDescription(); sendSig({ type: 'desc', desc: pc.localDescription }); }
    } else if (data.type === 'candidate') { try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!c.ignoreOffer) console.warn(e); } }
  } catch (e) { console.warn('signal', e); }
}
function hangup() { const c = S.call; if (!c) return; S.socket.emit('call:end', { callId: c.id }); cleanupCall(); }
function onCallEnded(d) {
  if (S.incoming && S.incoming.callId === d.callId) { clearIncoming(); if (d.reason === 'missed') toast(t('Пропущенный звонок')); return; }
  if (!S.call || S.call.id !== d.callId) return;
  const msg = { declined: t('Звонок отклонён'), missed: S.call.state === 'calling' ? t('Нет ответа') : t('Звонок завершён'), ended: t('Звонок завершён'), handled: '' }[d.reason]; cleanupCall(); if (msg && d.reason !== 'ended') toast(msg);
}
function cleanupCall() {
  const c = S.call; if (!c) return; stopRing(); clearInterval(c.timer); clearTimeout(c.failT);
  c.local?.getTracks().forEach(tr => tr.stop()); c.screen?.getTracks().forEach(tr => tr.stop()); try { c.pc?.close(); } catch (e) { }
  S.call = null; $('#call-ui')?.remove(); tone([520, 380], .15, 'sine', .8);
}
function showCallUI() {
  $('#call-ui')?.remove(); const c = S.call; const u = U(c.peer);
  const ui = el(`<div class="call" id="call-ui"><video class="rv" id="call-rv" autoplay playsinline></video><video class="lv hidden" id="call-lv" autoplay playsinline muted></video>
  <div class="call-top"><button id="c-min" title="${t('Свернуть')}">${ic('minimize')}</button></div>
  <div class="call-info"><div id="c-av" class="ring">${userAv(u, '9rem')}</div><div class="nm">${esc(fullName(u))}</div><div class="st" id="c-st"></div></div>
  <div class="call-ctrl"><button id="c-mic" title="${t('Микрофон')}">${ic('mic')}</button><button id="c-cam" title="${t('Камера')}">${ic('video')}</button><button id="c-scr" title="${t('Демонстрация экрана')}">${ic('screen-share')}</button><button class="end" id="c-end" title="${t('Завершить')}">${ic('phone-off')}</button></div>
  <div class="call-enc">🔒 ${t('Звонок защищён: соединение напрямую между устройствами (WebRTC)')}</div></div>`);
  document.body.appendChild(ui);
  $('#c-end').onclick = hangup; $('#c-mic').onclick = toggleMic; $('#c-cam').onclick = toggleCam; $('#c-scr').onclick = toggleScreen;
  $('#c-min').onclick = () => ui.classList.add('mini'); ui.addEventListener('click', e => { if (ui.classList.contains('mini')) { ui.classList.remove('mini'); e.stopPropagation(); } }, true);
  if (!navigator.mediaDevices.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) $('#c-scr').remove();
  const lv = $('#call-lv'); lv.srcObject = c.local; updateCallUI();
}
function updateCallUI() {
  const c = S.call, ui = $('#call-ui'); if (!c || !ui) return;
  const st = $('#c-st'); const el_ = c.t0 ? Math.floor((Date.now() - c.t0) / 1000) : 0;
  st.textContent = c.state === 'calling' ? t('Вызов…') : c.state === 'connecting' ? t('Соединение…') : fmtDur(el_) + (c.remoteState.mic === false ? ' · ' + t('микрофон выключен') : '');
  $('#c-av').classList.toggle('ring', c.state !== 'active');
  const rv = c.remote && c.remote.getVideoTracks().some(tr => tr.readyState === 'live') && c.remoteState.cam !== false;
  const lvOn = c.local.getVideoTracks().some(tr => tr.enabled && tr.readyState === 'live') || !!c.screen;
  $('#call-rv').style.display = rv ? '' : 'none'; $('#call-lv').classList.toggle('hidden', !lvOn);
  ui.classList.toggle('video-on', !!rv || lvOn);
  const mic = c.local.getAudioTracks()[0]; $('#c-mic').classList.toggle('off', mic && !mic.enabled); $('#c-mic').innerHTML = ic(mic && !mic.enabled ? 'mic-off' : 'mic');
  $('#c-cam').classList.toggle('off', !lvOn || !!c.screen && false); $('#c-cam').innerHTML = ic(lvOn && !c.screen ? 'video' : 'video-off');
  $('#c-scr')?.classList.toggle('off', !!c.screen);
}
function toggleMic() { const c = S.call; const tr = c.local.getAudioTracks()[0]; if (!tr) return; tr.enabled = !tr.enabled; sendSig({ type: 'media', state: { mic: tr.enabled } }); updateCallUI(); }
async function toggleCam() {
  const c = S.call; let tr = c.local.getVideoTracks()[0];
  if (c.screen) return toggleScreen();
  if (tr) { tr.enabled = !tr.enabled; if (!tr.enabled) { tr.stop(); c.local.removeTrack(tr); const s = c.pc?.getSenders().find(s => s.track === tr); s && c.pc.removeTrack(s); tr = null; } sendSig({ type: 'media', state: { cam: !!tr } }); }
  else {
    try { const s = await navigator.mediaDevices.getUserMedia({ video: videoC({ width: { ideal: 1280 }, height: { ideal: 720 } }) }); const nt = s.getVideoTracks()[0]; c.local.addTrack(nt); if (c.pc) c.pc.addTrack(nt, c.local); $('#call-lv').srcObject = c.local; sendSig({ type: 'media', state: { cam: true } }); }
    catch (e) { toast(t('Нет доступа к камере')); }
  }
  updateCallUI();
}
async function toggleScreen() {
  const c = S.call;
  if (c.screen) { stopScreen(); return; }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); c.screen = s; const tr = s.getVideoTracks()[0]; tr.onended = stopScreen;
    const sender = c.pc?.getSenders().find(x => x.track && x.track.kind === 'video');
    if (sender) { c.camTrack = sender.track; await sender.replaceTrack(tr); } else if (c.pc) { c.screenSender = c.pc.addTrack(tr, c.screen); }
    const lv = $('#call-lv'); lv.srcObject = s; lv.classList.add('screen'); sendSig({ type: 'media', state: { cam: true, screen: true } }); updateCallUI();
  } catch (e) { }
}
async function stopScreen() {
  const c = S.call; if (!c || !c.screen) return; const tr = c.screen.getVideoTracks()[0]; c.screen.getTracks().forEach(x => x.stop()); c.screen = null;
  const sender = c.pc?.getSenders().find(x => x.track === tr || (c.screenSender && x === c.screenSender));
  if (sender) { if (c.camTrack && c.camTrack.readyState === 'live') { await sender.replaceTrack(c.camTrack); } else { try { c.pc.removeTrack(sender); } catch (e) { } sendSig({ type: 'media', state: { cam: false, screen: false } }); } }
  c.camTrack = null; const lv = $('#call-lv'); lv.classList.remove('screen'); lv.srcObject = c.local; sendSig({ type: 'media', state: { screen: false } }); updateCallUI();
}
document.addEventListener('click', e => { const cm = e.target.closest('.call-msg'); if (cm) { const row = cm.closest('.mrow'); const m = findMsgLocal(row?.dataset.id); const c = m && S.chats[m.chatId]; if (c && c.peer) startCall(c.peer, !!m.call.video); } });
