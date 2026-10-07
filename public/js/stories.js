/* GeoMetric Stories — 24-hour photo, video and text updates */
'use strict';
let storyRefreshTimer = null;

function initStories() {
  refreshStories();
  clearInterval(storyRefreshTimer);
  storyRefreshTimer = setInterval(refreshStories, 60_000);
}

async function refreshStories() {
  if (!S.token) return;
  try {
    const r = await api('GET', '/api/stories');
    S.stories = r.stories || [];
    mergeUsers(r.users || []);
    renderStories();
  } catch (e) { /* keep the last feed during brief disconnects */ }
}

function renderStories() {
  const strip = $('#story-strip'); if (!strip) return;
  const mine = S.stories.find(g => g.user.id === S.me?.id);
  const others = S.stories.filter(g => g.user.id !== S.me?.id);
  const drawItem = (group, own = false) => {
    const user = group?.user || S.me;
    if (!user) return '';
    const unseen = group?.items?.some(x => !x.seen) || false;
    const title = own ? (group ? t('Моя история') : t('Добавить историю')) : fullName(user);
    return `<button class="story-bubble ${unseen ? 'unseen' : ''} ${own ? 'story-own' : ''}" data-story-user="${user.id}" title="${esc(title)}">
      <span class="story-ring">${userAv(user, '3.25rem')}</span>${own ? `<span class="story-plus" title="${t('Добавить историю')}">${ic('plus')}</span>` : ''}
      <span class="story-label">${esc(own ? (group ? t('Моя история') : t('Моя история')) : (user.name || fullName(user)))}</span>
    </button>`;
  };
  strip.innerHTML = drawItem(mine, true) + others.slice(0, 30).map(g => drawItem(g)).join('');
  $$('.story-bubble', strip).forEach(b => b.onclick = e => {
    const id = +b.dataset.storyUser;
    if (id === S.me.id && (e.target.closest('.story-plus') || !S.stories.some(g => g.user.id === id))) openStoryComposer();
    else openStories(id);
  });
}

function openStoryComposer() {
  let file = null, previewUrl = '';
  let m;
  m = modal({
    title: t('Новая история'), cls: 'story-composer',
    body: `<div class="story-compose-preview" id="story-preview"><div class="story-compose-empty">${ic('image')}<span>${t('Добавьте фото или видео либо опубликуйте текст')}</span></div></div>
      <button class="row-item story-file-btn" id="story-pick">${ic('paperclip')}<span class="grow">${t('Выбрать фото или видео')}</span></button>
      <div class="field" style="max-width:none;margin:.6rem 0"><textarea id="story-text" placeholder=" " maxlength="500" rows="3"></textarea><label>${t('Текст или подпись')}</label></div>
      <label class="story-audience"><span>${ic('users')} ${t('Кто увидит')}</span><select id="story-audience"><option value="all">${t('Все пользователи')}</option><option value="contacts">${t('Мои контакты')}</option></select></label>
      <div class="story-hint">${t('История автоматически исчезнет через 24 часа. Максимум 20 активных историй.')}</div>`,
    buttons: [
      { label: t('Отмена') },
      { label: t('Опубликовать'), cls: 'story-publish', onClick: async (_api, btn) => {
        const text = $('#story-text', m.body).value.trim();
        if (!file && !text) { toast(t('Добавьте текст или медиа')); return false; }
        btn.disabled = true;
        try {
          let media = '';
          if (file) {
            const uploaded = await upload(file, file.name || 'story');
            media = uploaded.url;
          }
          const type = file ? (file.type.startsWith('video/') ? 'video' : 'photo') : 'text';
          await api('POST', '/api/stories', { type, text, media, audience: $('#story-audience', m.body).value });
          toast(t('История опубликована'));
          await refreshStories();
          if (previewUrl) URL.revokeObjectURL(previewUrl);
        } catch (e) { toast(errText(e)); btn.disabled = false; return false; }
      } }
    ],
    onClose: () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }
  });
  $('#story-pick', m.body).onclick = async () => {
    const [f] = await pickFile('image/*,video/*'); if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast(t('Максимальный размер истории — 20 МБ')); return; }
    if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) { toast(t('Поддерживаются только фото и видео')); return; }
    file = f;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    const preview = $('#story-preview', m.body);
    preview.innerHTML = f.type.startsWith('video/') ? `<video src="${previewUrl}" controls muted playsinline></video>` : `<img src="${previewUrl}" alt="">`;
    $('#story-pick .grow', m.body).textContent = f.name;
  };
}

function openStories(userId, firstStoryId) {
  const groups = S.stories.filter(g => g.items?.length);
  let gi = groups.findIndex(g => g.user.id === userId);
  if (gi < 0) return openStoryComposer();
  let ii = Math.max(0, groups[gi].items.findIndex(s => s.id === firstStoryId));
  if (groups[gi].items.findIndex(s => s.id === firstStoryId) < 0) ii = 0;
  const viewer = el('<div class="story-viewer" role="dialog" aria-modal="true"></div>');
  document.body.appendChild(viewer);
  let timer = 0, closed = false;
  const close = () => {
    if (closed) return; closed = true; clearTimeout(timer); viewer.remove();
    document.removeEventListener('keydown', keys);
  };
  const keys = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev(); };
  document.addEventListener('keydown', keys);
  const current = () => groups[gi].items[ii];
  const move = delta => {
    let ni = ii + delta, ng = gi;
    while (ng >= 0 && ng < groups.length) {
      if (ni >= 0 && ni < groups[ng].items.length) { gi = ng; ii = ni; draw(); return; }
      if (ni >= groups[ng].items.length) { ng++; ni = 0; }
      else { ng--; ni = groups[ng]?.items.length - 1; }
    }
    if (delta > 0) close(); else draw();
  };
  const next = () => move(1), prev = () => move(-1);
  const draw = () => {
    clearTimeout(timer);
    const group = groups[gi], story = current(), user = group.user, isMine = user.id === S.me.id;
    const progress = group.items.map((s, i) => `<span class="story-progress ${i < ii ? 'done' : ''}"><i class="${i === ii ? 'running' : ''}"></i></span>`).join('');
    let content = '';
    if (story.type === 'text') content = `<div class="story-text-card tone-${Math.abs(hashN(story.id)) % 6}"><div>${fmt(story.text)}</div></div>`;
    else if (story.type === 'video') content = `<video class="story-media" src="${esc(story.media)}" autoplay playsinline controls></video>`;
    else content = `<img class="story-media" src="${esc(story.media)}" alt="">`;
    viewer.innerHTML = `<div class="story-frame">${progress}<div class="story-top">${userAv(user, '2.6rem')}<div class="story-owner"><b>${esc(fullName(user))}</b><small>${fmtListTime(story.ts)}</small></div>
      ${isMine ? `<button class="story-views" title="${t('Просмотры')}">${ic('eye')} ${story.views || 0}</button>` : `<button class="story-message" title="${t('Написать')}">${ic('message-circle')}</button>`}
      ${isMine ? `<button class="story-delete" title="${t('Удалить историю')}">${ic('trash-2')}</button>` : ''}<button class="story-close" title="${t('Закрыть')}">${ic('x')}</button></div>
      <div class="story-content">${content}</div>${story.text && story.type !== 'text' ? `<div class="story-caption">${fmt(story.text)}</div>` : ''}
      <button class="story-hit left" aria-label="${t('Предыдущая')}"></button><button class="story-hit right" aria-label="${t('Следующая')}"></button></div>`;
    $('.story-close', viewer).onclick = close;
    $('.story-hit.left', viewer).onclick = prev; $('.story-hit.right', viewer).onclick = next;
    $('.story-message', viewer)?.addEventListener('click', () => { close(); openPrivate(user.id); });
    $('.story-views', viewer)?.addEventListener('click', () => showStoryViewers(story));
    $('.story-delete', viewer)?.addEventListener('click', async () => {
      if (!await confirmBox(t('Удалить эту историю?'), { danger: true, ok: t('Удалить') })) return;
      try { await api('DELETE', '/api/stories/' + encodeURIComponent(story.id)); await refreshStories(); if (!groups[gi].items.length || groups[gi].items.length === 1) close(); else { groups[gi].items.splice(ii, 1); ii = Math.min(ii, groups[gi].items.length - 1); draw(); } }
      catch (e) { toast(errText(e)); }
    });
    if (!isMine && !story.seen) {
      story.seen = true;
      api('POST', '/api/stories/' + encodeURIComponent(story.id) + '/view').then(r => { story.views = r.story.views; }).catch(() => { story.seen = false; });
    }
    const autoAdvance = () => { timer = setTimeout(next, 6000); };
    const video = $('.story-media', viewer);
    if (video?.tagName === 'VIDEO') {
      video.onended = next;
      video.onplay = () => { clearTimeout(timer); };
      video.onpause = () => { if (!video.ended) autoAdvance(); };
      timer = setTimeout(next, 30_000);
    } else autoAdvance();
  };
  draw();
  viewer.addEventListener('click', e => { if (e.target === viewer) close(); });
}

async function showStoryViewers(story) {
  const ids = story.viewers || [];
  await ensureUsers(ids);
  const names = ids.map(id => U(id)).filter(Boolean).map(u => `<div class="story-viewer-row">${userAv(u, '2.6rem')}<span>${esc(fullName(u))}</span>${u.username ? `<small>@${esc(u.username)}</small>` : ''}</div>`).join('');
  modal({ title: `${t('Просмотры')} · ${ids.length}`, cls: 'story-viewers-modal', body: names || `<div class="empty-list">${t('Пока нет просмотров')}</div>` });
}
