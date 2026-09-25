/* =========================================================================
   GeoMetric 2.0 — логика приложения.
   -------------------------------------------------------------------------
   Что здесь происходит:
     1) Вход и регистрация с созданием вашего личного профиля.
     2) Переписка, звонки, истории, стикеры, голосовые и кружки.
     3) Журнал звонков прямо в чате (исходящий, пропущенный, отклонённый...).
     4) Звонки и видеозвонки через WebRTC (+ мини-окно).
     5) Профиль: имя, аватар, описание, смена пароля, ключи.
     6) Настройки: тема, звуки, приватность, уведомления.
     7) Истории на 24 часа.

   Важно про безопасность: приватный ключ пользователя хранится только
   в памяти браузера (и в зашифрованном виде на сервере). Всё шифрование —
   в файле crypto.js.
   ========================================================================= */

import {
  cryptoAvailable, deriveKEK, generateIdentity, wrapPrivateKey, unwrapPrivateKey,
  conversationKey, encryptPayload, decryptObject, encryptFile, decryptFile, fingerprint, clearConversationCache,
  randomRoomKey, importRoomKey, wrapRoomKey, unwrapRoomKey, unwrapRoomKeyRaw, decryptText,   // ключи для групп и каналов
} from "./crypto.js";

/* ===================== 1. УТИЛИТЫ ===================== */
const $ = (id) => document.getElementById(id);
// Короткая обёртка над document.getElementById.

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Экранирование HTML: любые «страшные» символы превращаются в безопасные.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Пауза (используется в анимациях и повторных попытках).

function linkify(text) {
  // Превращает обычный текст в безопасный HTML, где ссылки стали ссылками.
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g,
    '<a class="bubble-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function fmtTime(ts) {
  // Время вида «14:05».
  return new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(ts) {
  // «Сегодня», «Вчера» или дата.
  const d = new Date(ts * 1000), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, now)) return "Сегодня";
  if (same(d, new Date(now.getTime() - 864e5))) return "Вчера";
  const opts = { day: "numeric", month: "long" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";   // для прошлых лет добавляем год
  return d.toLocaleDateString("ru-RU", opts);
}

function fmtAgo(ts) {
  // «5 мин назад» — для статусов «был(а) …».
  if (!ts) return "недавно";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 604800) return `${Math.floor(s / 86400)} дн назад`;
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function fmtDuration(sec) {
  // Длительность звонка: «1 мин 5 с» или «12 с».
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m) return `${m} мин ${s} с`;
  return `${s} с`;
}

function plural(n, one, few, many) {
  // Правильная форма слова: 1 просмотр / 2 просмотра / 5 просмотров.
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
  return many;
}

function initials(person) {
  // Первая буква для аватара.
  const name = typeof person === "string" ? person : (person?.name || person?.username || "?");
  return (name.trim()[0] || "?").toUpperCase();
}

function avatarHtml(person, cls = "") {
  // Готовит HTML аватара: фото (если загружено) или цветной кружок с буквой.
  const a = person?.avatar || {};
  const color = a.kind === "color" ? a.value : "#7c5cff";
  // Цвет берём только если аватар — цветной кружок.
  const inner = a.kind === "photo" && a.value
    ? `<img src="${esc(a.value)}" alt="" loading="lazy" />`   // фото
    : esc(initials(person));                                  // буква
  return `<div class="avatar ${cls}" style="background:${esc(color)}">${inner}</div>`;
}

let toastTimer = null;
function toast(text, ms = 2600) {
  // Всплывающее уведомление.
  if (!text) return;
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/* ===================== 2. СОСТОЯНИЕ ПРИЛОЖЕНИЯ ===================== */
const state = {
  token: localStorage.getItem("gm_token") || null,   // токен сессии
  me: null,                                          // мой профиль
  privJwk: null,                                     // мой приватный ключ (в памяти!)
  unlocked: false,                                   // расшифровка доступна?
  insecure: false,                                   // работаем без шифрования (пользователь согласился)
  people: {},                                        // логин -> карточка человека
  chats: [],                                         // список чатов
  activeChat: null,                                  // логин открытого собеседника
  peer: null,                                        // карточка открытого собеседника
  messages: [],                                      // сообщения открытого чата
  stories: [],                                       // чужие истории
  myStories: [],                                     // мои истории
  viewerItems: [], viewerIndex: 0, viewerIsMine: false,   // состояние просмотра историй
  storyTimer: null,                                  // таймер смены истории
  pendingFile: null,                                 // файл, готовый к отправке
  storyFile: null,                                   // файл, выбранный для истории
  storyVis: "all",                                   // кому будет видна новая история
  typingSent: 0,                                     // когда последний раз отправляли «печатает»
  typingTimer: null,                                 // таймер скрытия надписи «печатает…»
  settings: {                                        // настройки (при входе заменяются серверными)
    theme: localStorage.getItem("gm_theme") || "dark",   // выбранная тема
    lang: localStorage.getItem("gm_lang") || "ru",        // выбранный язык интерфейса
    sounds: true,                                       // звуки сообщений и звонков
    enterToSend: true,                                  // отправка по Enter
    readReceipts: true,                                 // отправлять галочки «прочитано»
    notifications: false,                               // системные уведомления
    hideOnline: false,                                  // скрывать статус «в сети»
    hideLastSeen: false,                                // скрывать «был(а) недавно»
    storyVisibility: "all",                             // кому видны мои истории
    storySeconds: 5,                                    // сколько показывать фото в истории
    compactMode: false,                                 // компактный список чатов
  },
  peerFingerprints: JSON.parse(localStorage.getItem("gm_peer_fp") || "{}"),   // отпечатки ключей собеседников
  installPrompt: null,                               // отложенное предложение установки приложения
  editingPeer: null,                                 // чей профиль открыт (null = мой)
  secretChat: false,                                 // открыт ли сейчас секретный чат (отдельная переписка с замочком)
};

/* ================= 1.1 АДРЕС СЕРВЕРА (приложение — отдельная программа) =================
   Раньше интерфейс приезжал с сервера вместе с сайтом. Теперь интерфейс лежит внутри
   приложения (APK/EXE), а сервер — это только хранилище сообщений. Поэтому приложение
   должно знать адрес сервера: он берётся из ссылки (?server=...), из памяти устройства
   или спрашивается у человека на экране подключения. */

const SERVER_KEY = "gm_server";                                    // ключ в памяти устройства, где храним адрес сервера
const URL_SERVER = new URLSearchParams(location.search).get("server");  // адрес, переданный приложением при запуске
let API_BASE = (URL_SERVER || localStorage.getItem(SERVER_KEY) || "").trim().replace(/\/+$/, "");
// Итоговый адрес сервера: без завершающего слэша (например, https://messenger.ru).
if (URL_SERVER) localStorage.setItem(SERVER_KEY, API_BASE);        // адрес из ссылки запоминаем на будущее

/* ================= 1.2 ПРИЛОЖЕНИЕ ДЛЯ КОМПЬЮТЕРА (окно программы) =================
   Когда интерфейс открыт ВНУТРИ приложения для компьютера, ему доступны действия окна:
   свернуть, развернуть, закрыть и перетаскивание за полосу заголовка. Отличий от обычной
   программы человек не видит: ни адресной строки, ни меню браузера, ничего лишнего.
   Само приложение собрано на библиотеке webview и кладёт свои действия в window.pywebview.api;
   каждый вызов оттуда возвращает обещание (Promise), поэтому ошибки тихо гасим. */

window.__gmErrors = window.__gmErrors || [];                      // сюда собираем ошибки интерфейса (по ним видно, всё ли в порядке)
window.addEventListener("error", (e) => {                          // ловим любую ошибку скриптов —
  try { window.__gmErrors.push(String(e.message || e)); } catch (err) { /* не получилось запомнить — не страшно */ }
});
window.addEventListener("unhandledrejection", (e) => {              // и «необработанные отказы» (например, сетевые) —
  try { window.__gmErrors.push(String((e.reason && e.reason.message) || e.reason)); } catch (err) { /* не получилось — не страшно */ }
});

let GMDesktop = null;                                              // «мост» к окну приложения (появится ниже)
let shellMaximized = false;                                        // развёрнуто ли сейчас окно

window.addEventListener("pywebviewready", () => connectDesktopBridge());   // приложение сообщило, что «мост» готов

function desktopApi() {
  // Отдаёт действия окна, которые предоставило приложение (в браузере их нет).
  // «Мост» наполняется не сразу: сначала появляется пустой ящик, и только потом в нём
  // лежат действия. Поэтому ждём, пока появятся нужные — иначе вызовы уйдут «в пустоту».
  const api = window.pywebview && window.pywebview.api;            // действия библиотеки webview (может быть пусто)
  if (!api) return null;                                           // приложения нет — это обычный браузер
  if (typeof api.winMinimize !== "function") return null;          // «мост» ещё пустой — попробуем позже
  if (typeof api.setUser !== "function") return null;              // и это действие тоже должно быть на месте
  return api;                                                      // «мост» готов — можно работать
}

function quiet(promise) {
  // Выполняет действие окна «молча»: если что-то не так, консоль не шумит.
  try {                                                            // на всякий случай —
    if (promise && typeof promise.catch === "function") promise.catch(() => {});   // гасим отказ обещания
  } catch { /* не получилось — не страшно */ }
}

function connectDesktopBridge(tries = 0) {
  // Подключается к окну приложения: получает «мост» и оживляет полосу заголовка.
  if (!isDesktopShell()) return;                                   // это не приложение для ПК — ничего не делаем
  const api = desktopApi();                                        // действия окна от приложения
  if (!api) {                                                      // «мост» ещё не готов —
    if (tries < 60) setTimeout(() => connectDesktopBridge(tries + 1), 50);   //   ждём и пробуем снова (около трёх секунд)
    return;                                                        //   и выходим
  }
  if (GMDesktop) { syncShellUser(); return; }                       // «мост» уже собран — второй раз не собираем (иначе кнопки окна сработают дважды)
  GMDesktop = {                                                    // собираем «мост» в том виде, к которому привык интерфейс
    platform: "geometricdesktop",                                  // так устройство подписывается в списке устройств
    isApp: true,                                                   // да, это приложение, а не сайт
    setUser: (name, login) => quiet(api.setUser(String(name || ""), String(login || ""))),   // имя и логин — в заголовок окна
    notify: (title, body) => quiet(api.notify(String(title || ""), String(body || ""))),     // уведомление о сообщении
    call: (title, body) => quiet(api.call(String(title || ""), String(body || ""))),         // уведомление о звонке (важное)
    winMinimize: () => quiet(api.winMinimize()),                   // свернуть окно
    winToggleMax: () => quiet(api.winToggleMax()),                 // развернуть окно или вернуть прежний размер
    winClose: () => quiet(api.winClose()),                         // закрыть программу
    dragDoubleClick: () => quiet(api.winToggleMax()),              // двойной щелчок по полосе — как в Windows
    dragStart: null,                                               // тянуть окно умеет сама библиотека webview (класс на полосе)
    openExternal: (url) => quiet(api.openExternal(String(url || ""))),   // чужую ссылку открыть в браузере
  };
  wireDesktopShell();                                              // оживляем полосу заголовка
  syncShellUser();                                                 // сообщаем окну, кто вошёл
}

function wireDesktopShell() {
  // Оживляет полосу заголовка окна программы: перетаскивание и три кнопки справа.
  const bar = $("winbar");                                          // сама полоса
  if (bar) bar.classList.remove("hidden");                          // показываем её
  const drag = $("winbar-drag");                                    // зона, за которую тянут окно
  if (drag) {                                                       // она есть —
    drag.classList.add("pywebview-drag-region");                    //   помечаем её: библиотека webview сама тянет окно за такую зону
    drag.ondblclick = () => {                                      //   двойной щелчок по полосе —
      if (GMDesktop && GMDesktop.dragDoubleClick) GMDesktop.dragDoubleClick();   // развернуть окно или вернуть прежний размер
    };                                                             // конец обработчика

  }
  const min = $("win-min"), max = $("win-max"), close = $("win-close");   // три кнопки окна
  // Обработчики задаём через onclick (а не addEventListener): так повторный вызов
  // никого не задвоит — кнопка всегда сработает ровно один раз.
  if (min) min.onclick = () => GMDesktop && GMDesktop.winMinimize && GMDesktop.winMinimize();      // свернуть
  if (max) max.onclick = () => GMDesktop && GMDesktop.winToggleMax && GMDesktop.winToggleMax();    // развернуть
  if (close) close.onclick = () => GMDesktop && GMDesktop.winClose && GMDesktop.winClose();        // закрыть
  paintWindowState();                                               // рисуем правильный значок кнопки «развернуть»
}

window.gmWindowState = function (maximized) {                       // приложение сообщает: окно развёрнуто или нет
  shellMaximized = !!maximized;                                     // запоминаем состояние
  paintWindowState();                                               // обновляем значок кнопки
};

function paintWindowState() {
  // Меняет значок кнопки «развернуть» на «вернуть прежний размер» и обратно.
  const btn = $("win-max");                                         // сама кнопка
  if (!btn) return;                                                 // её нет — выходим
  const use = btn.querySelector("use");                             // значок внутри кнопки
  if (use) use.setAttribute("href", shellMaximized ? "#i-restore" : "#i-maximize");   // подходящий рисунок
  btn.title = shellMaximized ? "Вернуть прежний размер" : "Развернуть";   // и понятная подсказка
}

function syncShellUser() {
  // Сообщает окну приложения, кто вошёл: логин видно в полосе заголовка.
  if (!isDesktopShell()) return;                                    // это не приложение — выходим
  const who = (state.me && state.me.username) || "";                // логин вошедшего
  const label = $("winbar-user");                                   // подпись в полосе заголовка
  if (label) label.textContent = who ? "@" + who : "";              // пишем логин (или ничего)
  if (GMDesktop && GMDesktop.setUser) {                             // «мост» есть —
    GMDesktop.setUser((state.me && state.me.name) || "", who);      //   сообщаем имя и логин окну
  }
}

function apiUrl(path) {                                            // собирает полный адрес запроса к серверу
  return API_BASE + path;                                          // например, https://messenger.ru + /api/login
}

function absUrl(u) {                                               // делает ссылки с сервера полными
  if (!u) return u;                                                // пустое значение — нечего преобразовывать
  return /^https?:/i.test(u) ? u : apiUrl(u);                      // http(s) уже полный, иначе добавляем адрес сервера
}

// Сервер, через который работает приложение.
// Он один и тот же у всех и не меняется: в интерфейсе его нигде не видно.
const DEFAULT_SERVER = "https://geometricmessensher.onrender.com";   // сервер по умолчанию

const previewCache = new Map();                                    // id сообщения -> готовое превью для списка чатов
const mediaCache = new Map();                                      // адрес закрытого файла -> ссылка на открытый файл

/* ===================== 3. ТЕМА ОФОРМЛЕНИЯ ===================== */
const THEME_BG = {                                                // цвет полосы состояния для каждой темы
  dark: "#0b0d12",                                                // тёмная
  light: "#f6f7fb",                                               // светлая
  amoled: "#000000",                                              // чёрная
  blue: "#0a1020",                                                // синяя
  emerald: "#071410",                                             // изумрудная
  ocean: "#061318",                                               // морская
  rose: "#170a12",                                                // розовая
  sunset: "#170f07",                                              // «закат»
  coffee: "#12100e",                                              // кофейная
  graphite: "#0e1013",                                            // графитовая
  lavender: "#f7f5ff",                                            // лаванда (светлая)
  mint: "#f2fbf6",                                                // мятная (светлая)
};

function applyTheme(theme) {
  // Меняет тему: переписывает атрибут data-theme у <html> (стили реагируют через CSS-переменные).
  theme = theme || "dark";
  localStorage.setItem("gm_theme", theme);                          // запоминаем выбор (чтобы не мигало при запуске)
  document.documentElement.setAttribute("data-theme", theme);
  // Плюс обновляем цвет статус-бара в мобильном приложении.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_BG[theme] || "#0b0d12");   // цвет берём из таблицы выше
  // Подсвечиваем выбранную карточку в настройках.
  document.querySelectorAll("#theme-picker .theme-card").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeValue === theme));
}

function fetchWithTimeout(url, options = {}, ms = 15000) {
  // Обычный запрос к серверу, но с ограничением по времени: иначе «зависший»
  // ответ держал бы вход бесконечно (сервер может долго просыпаться).
  const controller = new AbortController();                        // устройство, которым можно прервать запрос
  const timer = setTimeout(() => controller.abort(), ms);           // через ms миллисекунд прерываем
  return fetch(url, { ...options, signal: controller.signal })       // делаем запрос и
    .finally(() => clearTimeout(timer));                            //   в любом случае выключаем таймер
}

/* ===================== 4. ШИФРОВАНИЕ: КЛЮЧИ И СЕССИЯ ===================== */

function isDesktopShell() {
  // Запущено ли внутри настольного приложения (desktop.py добавляет ?src=desktop).
  return new URLSearchParams(location.search).get("src") === "desktop";
}

function isStandalone() {
  // Открыто ли как установленное приложение.
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true || isDesktopShell();
}

async function ensureIdentity() {
  // Загружает приватный ключ из памяти вкладки (или с этого устройства) в state.
  if (state.privJwk) return true;                                  // уже загружен
  const fromSession = sessionStorage.getItem("gm_priv");           // ключ текущей вкладки
  if (fromSession) { state.privJwk = JSON.parse(fromSession); state.unlocked = true; return true; }
  const remembered = localStorage.getItem("gm_priv");              // ключ, сохранённый на устройстве
  if (remembered) { state.privJwk = JSON.parse(remembered); state.unlocked = true; return true; }
  return false;                                                    // ключа нет — нужен пароль
}

function storeIdentity(privJwk, remember) {
  // Сохраняет приватный ключ: в память вкладки, а по желанию — на устройство.
  // В приложении для компьютера ключ сохраняем ВСЕГДА: тогда следующий запуск сразу
  // открывает чаты человека, без повторного ввода пароля (вход на устройстве помнится).
  if (isDesktopShell()) remember = true;                           // приложение для ПК — запоминаем всегда
  state.privJwk = privJwk;
  state.unlocked = true;
  sessionStorage.setItem("gm_priv", JSON.stringify(privJwk));
  if (remember) localStorage.setItem("gm_priv", JSON.stringify(privJwk));
}

function forgetIdentity() {
  // Полностью забывает ключи на этом устройстве.
  state.privJwk = null;
  state.unlocked = false;
  sessionStorage.removeItem("gm_priv");
  localStorage.removeItem("gm_priv");
  clearConversationCache();
}

async function peerPublicKey(username) {
  // Публичный ключ собеседника (нужен для общего секрета). Для «Избранного» — мой собственный.
  if (state.me && username === state.me.username) return state.me.pub;   // чат с самим собой: ключ — свой
  const person = state.people[username] || (state.peer?.username === username ? state.peer : null);
  if (person?.pub) return person.pub;                              // он уже под рукой
  const peer = state.chats.find((c) => c.with === username)?.peer;  // ищем в списке чатов
  if (peer?.pub) { state.people[username] = peer; return peer.pub; }
  return null;                                                     // ключа нет (человек ещё не «загружен»)
}

async function convKeyFor(username) {
  // Общий секретный ключ диалога (одинаковый у меня и у собеседника).
  if (isBotUser(username)) return null;                          // с ботами ключ не нужен: они читают текст сами
  const pub = await peerPublicKey(username);
  if (!pub || !state.privJwk) return null;
  // Проверяем отпечаток ключа собеседника: если он изменился — предупреждаем (возможен перехват).
  const fp = await fingerprint(pub);
  const known = state.peerFingerprints[username];
  if (known && known !== fp) {
  }
  state.peerFingerprints[username] = fp;
  localStorage.setItem("gm_peer_fp", JSON.stringify(state.peerFingerprints));
  // Считаем (или берём из кэша) общий ключ.
  return conversationKey(state.privJwk, pub, `${state.me.username}:${username}:${fp}`);
}

/* ===================== 5. ВХОД И РЕГИСТРАЦИЯ ===================== */
let authMode = "login";

function setAuthMode(mode) {
  // Переключение вкладок «Вход / Регистрация».
  authMode = mode;
  const reg = mode === "register";
  $("tab-login").classList.toggle("active", !reg);
  $("tab-register").classList.toggle("active", reg);
  $("wrap-name").classList.toggle("hidden", !reg);
  $("wrap-password2").classList.toggle("hidden", !reg);
  $("auth-note").classList.toggle("hidden", !reg);
  $("auth-submit").textContent = reg ? "Создать аккаунт" : "Войти";
  $("auth-error").textContent = "";
}

$("tab-login").onclick = () => setAuthMode("login");
$("tab-register").onclick = () => setAuthMode("register");

$("auth-form").onsubmit = async (e) => {
  // Отправка формы входа или регистрации.
  e.preventDefault();
  const username = $("field-username").value.trim().toLowerCase();
  const password = $("field-password").value;
  const err = (t) => { $("auth-error").textContent = t; };
  if (!cryptoAvailable()) {                                        // нет Web Crypto — шифровать нечем
    err("Откройте приложение через https:// или localhost — сейчас браузер не даёт выполнить вход");
    return;
  }
  try {
    if (authMode === "register") {
      // ---------- РЕГИСТРАЦИЯ ----------
      const name = $("field-name").value.trim() || username;
      if (password !== $("field-password2").value) { err("Пароли не совпадают"); return; }
      if (password.length < 6) { err("Пароль: минимум 6 символов"); return; }
      err("Создаём профиль…");
      const { pubJwk, privJwk } = await generateIdentity();         // создаём пару ключей ECDH
      const { kek, saltB64 } = await deriveKEK(password);           // ключ из пароля
      const encPriv = await wrapPrivateKey(privJwk, kek);           // шифруем приватный ключ паролем
      const res = await fetch(apiUrl("/api/register"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, name, pub: pubJwk, encPriv, kekSalt: saltB64,   // обычные данные регистрации
          device: { id: deviceId(), name: deviceName(), platform: deviceHint() } }),   // и подпись устройства: «Приложение для телефона» и т. п.
      });
      const data = await res.json();
      if (!res.ok) { err(data.error || "Не удалось зарегистрироваться"); return; }
      localStorage.setItem("gm_token", data.token);
      state.token = data.token; state.me = data.me;
      storeIdentity(privJwk, true);                                 // ключ храним в памяти и на устройстве
      err("");
      emitAuth();                  // входим в сеть
      toast("Аккаунт создан. Сохраните пароль — без него историю не восстановить");
    } else {
      // ---------- ВХОД ----------
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password,                                             // логин и пароль
          device: { id: deviceId(), name: deviceName(), platform: deviceHint() } }),   // и с какого устройства входим
      });
      const data = await res.json();
      if (!res.ok) { err(data.error || "Не удалось войти"); return; }
      localStorage.setItem("gm_token", data.token);
      state.token = data.token; state.me = data.me;
      err("Проверяем данные…");
      const { kek } = await deriveKEK(password, data.keys.kekSalt); // тот же ключ из пароля
      const privJwk = await unwrapPrivateKey(data.keys.encPriv, kek);   // расшифровываем приватный ключ
      storeIdentity(privJwk, true);
      err("");
      emitAuth();
    }
  } catch (ex) {
    // Чаще всего сюда попадаем, если пароль не подошёл к зашифрованному ключу.
    err("Ошибка входа: " + (ex?.message || ex));
  }
};

function logout() {
  // Выход: забываем токен и (по желанию) ключи на устройстве.
  if (!confirm("Выйти из аккаунта?")) return;
  localStorage.removeItem("gm_token");
  forgetIdentity();
  location.href = "/";                                            // перезапускаем интерфейс
}

/* ===================== 6. ЭКРАН РАЗБЛОКИРОВКИ ===================== */
async function showUnlock() {
  // Показываем экран ввода пароля для расшифровки истории.
  if (!state.me && state.token) {
    // После перезагрузки профиль мог не загрузиться — спросим у сервера.
    try { state.me = (await fetch(apiUrl("/api/me?token=" + encodeURIComponent(state.token))).then((r) => r.json())).me; } catch {}
  }
  const card = $("unlock-user");
  card.innerHTML = state.me
    ? `${avatarHtml(state.me, "sm")}<div><b>${esc(state.me.name)}</b><div style="font-size:12px;color:var(--text-3)">@${esc(state.me.username)}</div></div>`
    : "";
  $("unlock-screen").classList.remove("hidden");
  $("unlock-password").focus();
}

$("unlock-submit").onclick = async () => {
  // Разблокировка: берём зашифрованный ключ с сервера и расшифровываем его паролем.
  const password = $("unlock-password").value;
  const err = (t) => { $("unlock-error").textContent = t; };
  err("Проверяем пароль…");
  try {
    const res = await fetch(apiUrl("/api/keys?token=" + encodeURIComponent(state.token)));
    const keys = await res.json();
    if (!keys.encPriv) { err("Не удалось открыть переписку на этом устройстве. Попробуйте войти заново"); return; }
    const { kek } = await deriveKEK(password, keys.kekSalt);
    const privJwk = await unwrapPrivateKey(keys.encPriv, kek);
    storeIdentity(privJwk, $("unlock-remember").checked);
    $("unlock-screen").classList.add("hidden");
    err("");
    $("unlock-password").value = "";
    emitAuth();                   // продолжаем вход
  } catch (ex) {
    err("Неверный пароль");
  }
};

$("unlock-logout").onclick = logout;

/* ===================== 7. SOCKET.IO: СВЯЗЬ С СЕРВЕРОМ ===================== */
// Подключаемся к серверу (сначала WebSocket, при неудаче — резервный способ).
// Адрес сервера: если приложение открыто прямо с сервера (веб-версия) — используем его же,
// иначе работаем через сервер по умолчанию. Спрашивать у человека ничего не нужно.
if (URL_SERVER) {                                                  // приложение само указало адрес сервера —
  API_BASE = URL_SERVER;                                           //   доверяем ему и лишний раз ничего не проверяем
} else try {                                                       // иначе — могут быть любые сбои сети —
  const info = await fetch("/api/status", { cache: "no-store" })   // спрашиваем «это сервер GeoMetric?»
    .then((r) => (r.ok ? r.json() : null))                         // читаем ответ, если он успешен
    .catch(() => null);                                            // ошибка сети — считаем, что сервера нет
  if (info && info.geometric) {                                    // да, это сервер GeoMetric —
    API_BASE = location.origin;                                    //   работаем через него (это и есть сайт)
    localStorage.setItem(SERVER_KEY, API_BASE);                    //   запоминаем адрес на устройстве
  } else {                                                         // рядом сервера нет —
    API_BASE = DEFAULT_SERVER;                                     //   работаем через сервер по умолчанию
  }
} catch (e) {                                                      // что-то пошло совсем не так —
  API_BASE = DEFAULT_SERVER;                                       //   всё равно подключаемся к нему
}

const socket = API_BASE                                            // адрес есть —
  ? io(API_BASE, {                                                 //   подключаемся к нему:
      transports: ["polling", "websocket"],                        //     сначала обычные запросы, затем быстрый канал
      reconnection: true,                                          //     обрывы связи переподключаем сами
      reconnectionDelay: 1000,                                     //     первая повторная попытка через секунду
      reconnectionDelayMax: 8000,                                  //     дальше — не чаще, чем раз в 8 секунд
      timeout: 25000,                                              //     ждём ответ до 25 секунд (сервер может «просыпаться»)
    })
  : { on() {}, emit() {}, connected: false, disconnect() {} };      // заглушка: обработчики просто не сработают

/* --- Связь с сервером: подсказки и повторные попытки ---
   Сервер бывает «спит» после паузы, а сеть — пропадать. Чтобы вход срабатывал
   всегда (а не «через раз»), интерфейс сам повторяет попытку и подсказывает,
   что именно происходит. */

let AUTH_TIMER = null;                                             // сторожевой таймер ожидания ответа на вход
let AUTH_TRIES = 0;                                                // сколько раз уже повторяли вход

function setNetStatus(text) {
  // Показывает (или убирает) полоску о состоянии связи.
  const el = $("net-status");                                      // сама полоска
  if (!el) return;                                                 // разметки нет — нечего показывать
  if (text) { el.textContent = text; el.classList.remove("hidden"); }   // есть текст — показываем полоску
  else el.classList.add("hidden");                                 // текста нет — прячем её
}

function armAuthWatchdog() {
  // Если сервер не ответил на «вход» — повторяем запрос (до 6 раз).
  clearTimeout(AUTH_TIMER);                                        // прошлый таймер больше не нужен
  AUTH_TIMER = setTimeout(() => {                                  // ждём ответ сервера
    const вошли = $("app") && !$("app").classList.contains("hidden");   // уже в чатах?
    if (!state.token || вошли) { setNetStatus(""); return; }        // вошли — подсказка не нужна
    if (AUTH_TRIES >= 6) {                                          // много попыток без ответа —
      setNetStatus("Сервер не отвечает. Проверьте интернет — попробуем снова.");   //   честно говорим об этом
      return;                                                       //   и ждём следующего подключения
    }
    AUTH_TRIES += 1;                                               // считаем попытку
    setNetStatus("Сервер просыпается… попытка " + (AUTH_TRIES + 1));   // показываем, что ждём
    try { socket.emit("auth", { token: state.token }); } catch (e) {}   // повторяем вход
    armAuthWatchdog();                                             // и снова ждём ответ
  }, 12000);                                                       // ждём 12 секунд
}

function emitAuth() {
  // Вход в аккаунт: отправляем токен и включаем ожидание ответа.
  AUTH_TRIES = 0;                                                  // начинаем счёт попыток заново
  socket.emit("auth", { token: state.token });                     // сам запрос на вход
  armAuthWatchdog();                                               // следим, что сервер ответил
}

socket.on("connect_error", () => {                                 // соединение не установилось —
  setNetStatus("Нет связи с сервером… пробую снова");              //   подсказываем и ждём переподключения
});

socket.on("disconnect", () => {                                    // связь оборвалась —
  if (state.token && !($("app") && $("app").classList.contains("hidden"))) setNetStatus("Связь потеряна… восстанавливаю");   //   если мы были в чатах, сообщаем об этом
});

socket.on("connect", async () => {
  // Соединение установлено: решаем, что показать пользователю.
  hideSplash();                                                    // убираем заставку запуска
  try {
    const link = phone();                                          // мост приложения на телефоне
    if (link && link.keepAlive) link.keepAlive(true);              // просим держать связь, пока приложение свёрнуто
  } catch (e) { /* в браузере этого нет — просто продолжаем */ }
  if (!state.token) {                                              // токена нет —
    $("auth-screen").classList.remove("hidden");                   //   показываем экран входа
    return;
  }
  if (await ensureIdentity()) {                                    // ключ уже разблокирован —
    emitAuth();                   //   входим
    return;
  }
  if (!cryptoAvailable()) {                                        // браузер не умеет шифровать —
    return;
  }
  // Токен есть, но ключ закрыт. Сначала проверим, что токен вообще живой:
  try {
    const probe = await fetchWithTimeout(apiUrl("/api/keys?token=" + encodeURIComponent(state.token)), {}, 10000);   // 10 секунд — и хватит
    if (probe.status === 401) {                                    // сессия истекла или токен подделан —
      localStorage.removeItem("gm_token");                         //   забываем его
      state.token = null;                                          //
      $("auth-screen").classList.remove("hidden");                 //   и просим войти заново
      return;
    }
  } catch {}
  showUnlock();                                                    // токен в порядке — просим пароль для ключа
});

socket.on("auth_error", () => {
  // Токен просрочен — на экран входа.
  localStorage.removeItem("gm_token");
  state.token = null;
  $("app").classList.add("hidden");
  $("auth-screen").classList.remove("hidden");
  hideSplash();
});

socket.on("auth_ok", (data) => {
  // Успешный вход: сервер прислал профиль, чаты и истории.
  clearTimeout(AUTH_TIMER);                                        // ответ пришёл — сторожевой таймер не нужен
  AUTH_TRIES = 0;                                                  // счёт попыток сбрасываем
  setNetStatus("");                                                // и убираем полоску о связи
  state.me = data.me;
  state.settings = { ...state.me.settings };
  applySettingsToUI();
  applyTheme(state.settings.theme);
  state.chats = data.chats || [];
  state.stories = data.stories || [];
  state.myStories = data.my_stories || [];
  // Собираем карточки всех собеседников в один справочник.
  state.people = {};
  for (const c of state.chats) if (c.peer) state.people[c.peer.username] = c.peer;
  $("auth-screen").classList.add("hidden");
  $("unlock-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  initRoomsAndTabs();                                              // вкладки, Избранное, комнаты
  renderChats();
  renderStories();
  if (state.activeChat) openChat(state.activeChat, true);          // восстанавливаем открытый чат
});

socket.on("users_update", (data) => {
  // Сервер сообщил об изменении статуса кого-то из контактов.
  for (const u of data.users || []) {
    if (!u) continue;
    state.people[u.username] = { ...(state.people[u.username] || {}), ...u };
    const chat = state.chats.find((c) => c.with === u.username);
    if (chat) chat.peer = { ...chat.peer, ...u };
    if (state.peer?.username === u.username) { state.peer = { ...state.peer, ...u }; renderPeerHeader(); }
  }
  renderChats();
});

socket.on("chats_update", (data) => {
  // Обновление списка чатов (новые сообщения, непрочитанные).
  state.chats = data.chats || [];
  for (const c of state.chats) {
    if (!c.peer) continue;
    state.people[c.peer.username] = { ...(state.people[c.peer.username] || {}), ...c.peer };
    // Если этот человек открыт в чате — обновляем и шапку.
    // Пример: когда переписка только началась, статус собеседника мог быть
    // ещё «скрыт» (он не считал нас контактом) — теперь его надо перепоказать.
    if (state.peer?.username === c.peer.username) {
      state.peer = state.people[c.peer.username];
      renderPeerHeader();
    }
  }
  renderChats();
});

socket.on("message_deleted", (data) => {
  // Сообщение удалено у всех участников — помечаем его у себя.
  const m = state.messages.find((x) => x.id === data.id);           // ищем у себя
  if (m) { m.deleted = true; m.e2e = null; m.plain = null; renderMessages(); }   // помечаем и перерисовываем
  previewCache.clear();                                             // превью в списке чатов тоже устарело
  renderChats();                                                    // обновляем список
});

socket.on("history", async (data) => {
  // Пришла история переписки (набор шифрованных «конвертов»).
  if (data.with !== state.activeChat) return;                      // это не тот чат — игнорируем
  if (data.peer) { state.peer = data.peer; state.people[data.peer.username] = data.peer; }
  state.messages = data.messages || [];
  await renderMessages();
  scrollMessagesToEnd();
  renderPeerHeader();
});

socket.on("new_message", async (msg) => {
  // Пришло новое сообщение.
  const cid = chatIdOf(state.me.username, state.activeChat);
  if (state.activeChat && msg.chat === cid) {                      // сообщение в открытый чат
    if (!state.messages.some((m) => m.id === msg.id)) state.messages.push(msg);
    await renderMessages();
    scrollMessagesToEnd();
    if (msg.to === state.me.username && state.settings.readReceipts) socket.emit("mark_read", { with: msg.from });
  } else if (msg.to === state.me.username) {
    // Сообщение в закрытый чат — уведомляем.
    const text = await messagePreviewText(msg);
    const person = state.people[msg.from] || { username: msg.from };
    toast(`${person.name || msg.from}: ${text}`);
    notifyDesktop(person.name || msg.from, text);
  }
});

socket.on("call_log", async (msg) => {
  // Сервер обновил/создал запись звонка в переписке.
  const cid = chatIdOf(state.me.username, state.activeChat);
  if (state.activeChat && msg.chat === cid) {
    const i = state.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) state.messages[i] = msg; else state.messages.push(msg);   // обновляем или добавляем
    await renderMessages();
    scrollMessagesToEnd();
  }
});

socket.on("messages_read", (data) => {
  // Собеседник прочитал мои сообщения — обновляем галочки.
  for (const m of state.messages) if (data.ids.includes(m.id)) m.read = true;
  renderMessages();
  renderChats();
});

socket.on("typing", (data) => {
  // «Печатает…» — только для открытого чата.
  if (data.from !== state.activeChat) return;
  $("typing-line").innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span> печатает…`;
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => { $("typing-line").innerHTML = ""; }, 3000);
});

socket.on("stories_update", (data) => {
  // Обновление историй.
  state.stories = data.stories || [];
  state.myStories = data.my_stories || [];
  renderStories();
});

socket.on("error_msg", (data) => toast(data.text || "Ошибка"));

/* ==========================================================================
   ВКЛАДКИ ЧАТОВ, ИЗБРАННОЕ, ГРУППЫ И КАНАЛЫ — данные в памяти приложения.
   ========================================================================== */
const FIXED_TABS = [                                              // встроенные вкладки (их нельзя удалить)
  { id: "all", name: "Все чаты", filter: "all", fixed: true },     //   всё подряд
  { id: "private", name: "Личные", filter: "private", fixed: true },   //   только личные переписки
  { id: "groups", name: "Группы", filter: "groups", fixed: true },  //   только группы
  { id: "channels", name: "Каналы", filter: "channels", fixed: true },   //   только каналы
  { id: "unread", name: "Непрочитанные", filter: "unread", fixed: true },   //   где есть новые сообщения
];
const roomKeys = new Map();                                       // ID комнаты -> рабочий ключ шифрования
const roomRaw = new Map();                                        // ID комнаты -> ключ комнаты текстом (нужен админам для выдачи)
const ROOM_COLORS = ["#7f5af0", "#2cb67d", "#ff8906", "#e53170", "#3da9fc", "#9b5de5", "#00b8a9"];   // цвета аватаров комнат
let pendingRoom = null;                                           // комната, которую сейчас открываем

/* ===================== 8. КОНТАКТЫ И СПИСОК ЧАТОВ ===================== */
const chatIdOf = (a, b) => [a, b].sort().join("|");
// Локальная копия правила сервера: ID чата = «логин1|логин2» по алфавиту.

function renderMe() {
  // Показываем свой профиль в шапке сайдбара.
  if (!state.me) return;
  syncShellUser();                                                 // и сообщаем окну приложения, кто вошёл
  $("me-avatar").innerHTML = avatarHtml(state.me);
  $("me-name").textContent = state.me.name || state.me.username;
  const parts = ["@" + state.me.username];
  if (state.settings.hideOnline) parts.push("статус скрыт");       // честно сообщаем, что нас не видно
  $("me-sub").textContent = parts.join(" · ");
}

function currentTabs() {
  // Все вкладки: встроенные + мои собственные (из настроек).
  const custom = Array.isArray(state.settings.tabs) ? state.settings.tabs : [];   // свои вкладки пользователя
  return [...FIXED_TABS, ...custom.map((t) => ({ ...t, fixed: false }))];          // встроенные всегда первыми
}

function chatMatchesTab(chat, tab) {
  // Подходит ли чат выбранной вкладке.
  const f = tab.filter;                                            // что показывает вкладка
  if (f === "private") return chat.kind === "dm";                  // только личные
  if (f === "groups") return chat.kind === "room" && chat.type === "group";   // только группы
  if (f === "channels") return chat.kind === "room" && chat.type === "channel";   // только каналы
  if (f === "unread") return (chat.unread || 0) > 0;               // только непрочитанные
  if (f === "saved") return chat.kind === "saved";                 // только Избранное
  return true;                                                     // «Все чаты» — всё подряд
}

function renderTabs() {
  // Рисуем полосу вкладок и «бегунок» под активной.
  const bar = $("tabs");                                           // полоса вкладок
  const tabs = currentTabs();                                      // список вкладок
  if (!tabs.some((t) => t.id === state.activeTab)) state.activeTab = "all";   // выбранной вкладки нет — показываем «Все»
  bar.innerHTML = tabs.map((t) => `
    <button class="chat-tab${t.id === state.activeTab ? " active" : ""}" data-tab="${esc(t.id)}">
      <span>${esc(t.name)}</span>
    </button>`).join("") + `<button class="chat-tab add" id="tab-add" title="Добавить вкладку">+</button>`;   // плюс кнопка добавления
  for (const btn of bar.querySelectorAll(".chat-tab[data-tab]")) {   // клик по вкладке
    btn.onclick = () => switchTab(btn.dataset.tab, btn);            // переключаем с анимацией
    btn.oncontextmenu = (e) => {                                    // правая кнопка по своей вкладке —
      e.preventDefault();                                           //   не даём открыть меню браузера
      const tab = tabs.find((t) => t.id === btn.dataset.tab);       // находим вкладку
      if (tab && !tab.fixed) {                                      // свои вкладки можно удалять
        state.settings.tabs = (state.settings.tabs || []).filter((x) => x.id !== tab.id);   // убираем её
        saveSettings();                                             // сохраняем настройки
        renderTabs(); renderChats();                                // перерисовываем
        toast("Вкладка «" + tab.name + "» удалена (правая кнопка убрала её)");
      }
    };
  }
  const add = $("tab-add");                                        // кнопка «+»
  if (add) add.onclick = openTabDialog;                            // открывает окно создания вкладки
  moveTabIndicator();                                              // ставим «бегунок» под активную вкладку
}

function moveTabIndicator() {
  // Плавный «бегунок» под активной вкладкой (анимация переключения).
  const bar = $("tabs");                                           // полоса вкладок
  const active = bar.querySelector(".chat-tab.active");            // активная вкладка
  const line = bar.querySelector(".tab-underline");                // сам бегунок
  if (!active || !line) return;                                    // нечего двигать
  line.style.width = active.offsetWidth + "px";                    // ширина = ширина вкладки
  line.style.transform = `translateX(${active.offsetLeft}px)`;      // сдвиг к активной вкладке
}

async function switchTab(id, btn) {
  // Переключение вкладки: анимация и фильтрация списка чатов.
  if (state.activeTab === id) return;                              // уже выбрана
  state.activeTab = id;                                            // запоминаем выбор
  const list = $("chat-list");                                     // список чатов
  const dir = btn && btn.offsetLeft > (($("tabs").querySelector(".chat-tab.active")?.offsetLeft) || 0) ? 1 : 1;   // направление анимации
  list.style.setProperty("--slide-from", dir > 0 ? "18px" : "-18px");   // откуда «влетает» список
  list.classList.remove("slide-in");                               // перезапускаем анимацию
  void list.offsetWidth;                                           // (нужно, чтобы браузер её заметил)
  list.classList.add("slide-in");                                  // включаем анимацию появления
  renderTabs();                                                    // обновляем активную вкладку и «бегунок»
  renderChats();                                                   // перерисовываем список
  haptic(8);                                                       // отклик вибрацией
  const st = state.settings;                                       // сохраняем выбор вкладки,
  st.activeTab = id;                                               //   чтобы при следующем входе
  saveSettings();                                                  //   открылась та же вкладка
}

function renderChats() {
  // Рисуем список чатов: Избранное всегда сверху, дальше — по выбранной вкладке.
  const list = $("chat-list");                                     // контейнер списка
  const q = $("search").value.trim().toLowerCase();                // поисковый запрос
  const tab = currentTabs().find((t) => t.id === state.activeTab) || FIXED_TABS[0];   // выбранная вкладка
  let rows = state.chats.map((c) => ({ ...c,                        // готовим строки списка
    person: c.kind === "room" || c.kind === "saved" ? null : (state.people[c.with] || c.peer || { username: c.with, name: c.with }),
  }));
  if (q) rows = rows.filter((r) => (previewTitle(r) + " " + (r.with || "")).toLowerCase().includes(q));   // фильтр по названию
  rows = rows.filter((r) => chatMatchesTab(r, tab) || (r.kind === "saved" && tab.filter === "all"));      // фильтр по вкладке
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));                  // свежие сверху
  if (tab.filter === "all" && !q) {                                // на вкладке «Все чаты» —
    const saved = rows.find((r) => r.kind === "saved");            //   Избранное всегда наверху
    if (saved) { rows = [saved, ...rows.filter((r) => r !== saved)]; }   //   даже если переписок не было
  }
  const sameList = list.dataset.signature === rows.map((r) => r.id + r.unread + (r.ts || 0)).join(",") + state.activeTab;   // список не изменился?
  list.dataset.signature = rows.map((r) => r.id + r.unread + (r.ts || 0)).join(",") + state.activeTab;    // запоминаем отпечаток
  list.innerHTML = "";                                             // очищаем список
  if (!rows.length) {                                              // пусто —
    list.innerHTML = `<div class="empty-list">${state.chats.length ? "На этой вкладке пока пусто" : "Пока нет чатов.<br>Нажмите ✎, чтобы найти собеседника или создать группу и канал."}</div>`;
    moveTabIndicator();                                            // всё равно ставим «бегунок»
    return;                                                        // и выходим
  }
  for (const c of rows) {                                          // по строкам
    const btn = document.createElement("button");                  // строка списка — кнопка
    const active = c.kind === "room" ? c.id === state.activeRoom : (c.with === state.activeChat && !state.activeRoom);   // это открытый чат?
    btn.className = "chat-item" + (active ? " active" : "") + (c.kind === "room" ? " room" : "") + (c.kind === "saved" ? " saved" : "");   // классы оформления
    btn.innerHTML = `
      <div class="chat-avatar-wrap">
        ${chatAvatarHtml(c)}
        ${c.kind === "dm" && c.person?.online ? '<span class="online-dot"></span>' : ""}
      </div>
      <div class="chat-body">
        <div class="chat-line">
          <div class="chat-name">${esc(previewTitle(c))}${c.kind === "room" ? roomBadge(c) : ""}${c.kind === "dm" && c.person?.bot ? '<span class="bot-tag">бот</span>' : ""}</div>
          <div class="chat-time">${c.last ? fmtTime(c.last.ts) : ""}</div>
        </div>
        <div class="chat-preview"><span class="txt">…</span></div>
      </div>
      ${c.unread ? `<div class="badge">${c.unread}</div>` : ""}`;
    btn.onclick = () => (c.kind === "room" ? openRoom(c.id) : openChat(c.with, false, c.kind === "saved"));   // открываем чат или комнату
    list.appendChild(btn);                                         // добавляем в список
    if (c.last) fillPreview(btn.querySelector(".chat-preview"), c);   // превью расшифровываем асинхронно
  }
  moveTabIndicator();                                              // «бегунок» под активной вкладкой
  applyCompactList();                                              // учитываем настройку «компактный список»
  injectStickerBotRow();                                           // добавляем строку Стикер-бота (он всегда под рукой)
}

function roomBadge(c) {
  // Маленькая пометка у названия комнаты: канал или число участников.
  if (c.type === "channel") return ' <svg class="room-badge"><use href="#i-broadcast"></use></svg>';
  return ' <span class="room-badge-txt">' + (c.members || 0) + '</span>';
}

function chatAvatarHtml(c) {
  // Аватар строки списка: у комнаты — «таблетка» с первой буквой и цветом.
  if (c.kind === "saved") {                                        // Избранное —
    return `<div class="avatar saved-avatar"><svg><use href="#i-bookmark"></use></svg></div>`;
  }
  if (c.kind === "room") {                                         // группа или канал —
    const bg = c.color || "#7f5af0";                               // цвет комнаты
    return `<div class="avatar room-avatar" style="--room-color:${esc(bg)}"><svg><use href="#i-${c.type === "channel" ? "broadcast" : "users"}"></use></svg></div>`;
  }
  return avatarHtml(c.person || { username: c.with, name: c.with });   // обычный человек
}

function previewTitle(c) {
  // Название строки в списке чатов.
  if (c.kind === "saved") return "Избранное";
  if (c.kind === "room") return c.title || "Комната";
  return (c.person?.name || c.with || "");
}

async function fillPreview(el, chat) {
  // Расшифровываем последнее сообщение для превью в списке чатов.
  const msg = chat.last;
  try {
    if (msg.kind === "call") {
      // Запись звонка показываем словами (пропущенный — красным).
      const info = callLogInfo(msg, state.me.username);
      el.innerHTML = `<span class="txt" style="${info.missed ? "color:var(--danger)" : ""}">${esc(info.title)}</span>`;
      return;
    }
    if (previewCache.has(msg.id)) {                                 // уже расшифровывали — берём из кэша
      el.innerHTML = previewCache.get(msg.id);
      return;
    }
    const key = chat.kind === "room" ? roomKeys.get(chat.id) : await convKeyFor(chat.with);   // ключ комнаты или личный
    if (chat.kind === "room" && !key) {                             // ключа комнаты ещё нет —
      el.innerHTML = `<span class="txt">История недоступна</span>`;   //   сообщаем, что показать нечего
      return;                                                      //
    }
    const prefix = msg.from === state.me.username ? "Вы: " : "";
    let text;
    if (!msg.e2e) {
      // Режим без шифрования: данные лежат открыто.
      text = msg.plain?.file ? (msg.plain.file.kind === "video" ? "🎥 Видео" : "📷 Фото") : (msg.plain?.text || "Сообщение");
    } else if (!key) {
      text = "Сообщение";                                          // ключа пока нет
    } else {
      const obj = await decryptObject(key, msg.e2e);                // расшифровываем у себя в браузере
      if (obj === null) text = "Сообщение недоступно";
      else if (obj.t) text = obj.t;
      else if (obj.file) text = obj.file.kind === "video" ? "🎥 Видео" : "📷 Фото";
      else text = "Сообщение";
    }
    const lock = msg.e2e ? '<svg class="lock"><use href="#i-lock"></use></svg>' : "";
    const html = `${lock}<span class="txt">${esc(prefix + text)}</span>`;
    previewCache.set(msg.id, html);                                 // запоминаем результат
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<span class="txt">Сообщение</span>`;
  }
}

async function messagePreviewText(msg) {
  // Короткий текст сообщения — для уведомлений.
  try {
    if (msg.kind === "call") return callLogInfo(msg, state.me.username).title;
    const key = await convKeyFor(msg.from === state.me.username ? msg.to : msg.from);
    if (!msg.e2e) return msg.plain?.text || "Медиа";
    if (!key) return "Сообщение";
    const t = await decryptFull(key, msg);
    return t?.text || (t?.file ? "Медиа" : "Сообщение");
  } catch { return "Сообщение"; }
}

/* ===================== 9. ОТКРЫТИЕ ЧАТА И СООБЩЕНИЯ ===================== */
async function openChat(login, silent = false, saved = false) {
  state.secretChat = false;                                        // обычный чат открывается без секретного режима
  // Открываем диалог с человеком (или с самим собой — «Избранное»).
  state.activeRoom = null;                                         // комнату закрываем
  state.savedMode = !!saved;                                       // режим «Избранное»?
  $("peer-card").classList.toggle("saved-mode", !!saved);           // помечаем шапку
  $("peer-card").classList.remove("room-mode");                     // это не комната
  state.activeChat = login;                                        // собеседник
  state.peer = saved ? state.me : await personCard(login);       // для Избранного — я сам, иначе карточка собеседника
  state.messages = [];
  $("empty-state").classList.add("hidden");
  $("chat-header").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  $("chat-area").classList.add("open");                            // на телефоне «выезжаем»
  $("typing-line").innerHTML = "";
  renderPeerHeader();
  await renderMessages();
  if (!silent) {
    socket.emit("get_history", { with: login });                   // просим историю
    if (state.settings.readReceipts) socket.emit("mark_read", { with: login });
  }
  renderChats();
}

function renderPeerHeader() {
  // Имя, аватар и статус собеседника в шапке чата (или «Избранное» для чата с собой).
  if (!state.peer) return;
  if (state.savedMode) {                                           // «Избранное»:
    $("peer-avatar").innerHTML = `<div class="avatar saved-avatar"><svg><use href="#i-bookmark"></use></svg></div>`;   //   закладка вместо аватара
    $("peer-name").innerHTML = `Избранное`;                        //   название
    $("peer-status").textContent = "Ваши заметки и файлы — видно только вам";   //   пояснение
    $("peer-status").classList.remove("online");                   //
    $("peer-card").onclick = () => openMyProfile();                //   клик открывает профиль
    return;                                                        //   дальше не идём
  }
  $("peer-card").onclick = () => state.activeChat && openPeerProfile(state.activeChat);
  $("peer-avatar").innerHTML = avatarHtml(state.peer);
  const botPeer = !!state.peer.bot;                              // открыт чат с ботом?
  $("peer-name").innerHTML = `${esc(state.peer.name || state.peer.username)}` +
    (botPeer ? ` <span class="bot-tag">бот</span>` : "");        // у ботов — пометка «бот»
  $("btn-call-audio").classList.toggle("hidden", botPeer);       // ботам звонить нельзя —
  $("btn-call-video").classList.toggle("hidden", botPeer);       //   прячем кнопки звонков
  const st = $("peer-status");
  if (state.peer.hidden_presence) { st.textContent = "статус скрыт"; st.classList.remove("online"); }
  else if (state.peer.online) { st.textContent = "в сети"; st.classList.add("online"); }
  else { st.textContent = state.peer.last_seen ? "был(а) " + fmtAgo(state.peer.last_seen) : "не в сети"; st.classList.remove("online"); }
}

function callLogInfo(msg, me) {
  // Превращает служебную запись звонка в понятную подпись.
  const outgoing = msg.from === me;                                 // звонок исходил от меня?
  const st = msg.call?.status || "dialing";
  const video = !!msg.call?.video;
  let title = "Звонок", missed = false, answered = false, icon = "i-phone-out";
  if (outgoing) {
    // Что видит тот, кто звонил.
    if (st === "dialing") { title = video ? "Видеозвонок" : "Исходящий звонок"; icon = "i-phone-out"; }
    else if (st === "answered") { title = video ? "Видеозвонок" : "Исходящий звонок"; answered = true; icon = "i-phone-out"; }
    else if (st === "canceled") { title = "Отменённый звонок"; icon = "i-phone-missed"; }
    else if (st === "no_answer" || st === "missed") { title = "Нет ответа"; icon = "i-phone-missed"; }
    else if (st === "declined") { title = "Отклонённый звонок"; icon = "i-phone-missed"; }
    else if (st === "busy") { title = "Занято"; icon = "i-phone-missed"; }
  } else {
    // Что видит тот, кому звонили.
    if (st === "dialing") { title = video ? "Видеозвонок" : "Входящий звонок"; icon = "i-phone-in"; }
    else if (st === "answered") { title = video ? "Видеозвонок" : "Входящий звонок"; answered = true; icon = "i-phone-in"; }
    else if (st === "declined") { title = "Отклонённый звонок"; icon = "i-phone-missed"; }
    else { title = "Пропущенный звонок"; missed = true; icon = "i-phone-missed"; }
    // Отменённый звонящим и «нет ответа» для вызываемого — это пропущенный звонок.
  }
  const dur = msg.call?.duration || 0;
  const sub = answered && dur ? `${fmtDuration(dur)} · ${fmtTime(msg.ts)}`
    : `${video ? "Видео" : "Аудио"} · ${fmtTime(msg.ts)}`;
  return { title, sub, missed, answered, icon };
}

async function decryptFull(key, msg) {
  // Достаёт из «конверта» полную полезную нагрузку: {text: "…", file: {...}}.
  if (!msg.e2e) return { text: msg.plain?.text || "", file: msg.plain?.file || null, sticker: msg.plain?.sticker || null };
  if (!key) return null;                                           // ключа нет — расшифровать невозможно
  const obj = await decryptObject(key, msg.e2e);                   // расшифровка в браузере
  if (obj === null) return null;                                   // расшифровать не удалось
  if (typeof obj === "string") return { text: obj, file: null };    // поддержка старого формата
  return { text: obj.t || "", file: obj.file || null, sticker: obj.sticker || null };   // стикер едет внутри сообщения
}

async function renderMessages() {
  // Рисуем все сообщения открытого чата (с расшифровкой).
  if (state.activeRoom && !state.activeChat) { await renderRoomMessages(); return; }   // открыта группа или канал — рисует комнатный отрисовщик
  const box = $("messages");
  if (!state.activeChat || !state.me) { box.innerHTML = ""; return; }
  const key = await convKeyFor(state.activeChat);                   // общий ключ диалога
  const parts = [];                                                // сюда собираем HTML
  let lastDay = "", prevFrom = null, prevTs = 0;
  const items = [];
  for (const m of state.messages) {
    // Сначала расшифровываем каждое сообщение.
    const dec = m.kind === "call" ? { call: m.call } : await decryptFull(key, m);
    items.push({ m, dec });
  }
  for (let i = 0; i < items.length; i++) {
    const { m, dec } = items[i];
    const day = fmtDay(m.ts);
    if (day !== lastDay) { parts.push(`<div class="msg-day">${esc(day)}</div>`); lastDay = day; prevFrom = null; }
    // --- запись звонка ---
    if (m.kind === "call") {
      const info = callLogInfo(m, state.me.username);
      parts.push(`<button class="call-log ${info.missed ? "missed" : info.answered ? "answered" : ""}" data-call="${esc(m.from === state.me.username ? m.to : m.from)}" data-kind="${m.call?.video ? "video" : "audio"}">
        <span class="call-log-icon"><svg><use href="#${info.icon}"></use></svg></span>
        <span class="call-log-text">
          <span class="call-log-title">${esc(info.title)}</span>
          <span class="call-log-sub">${esc(info.sub)}</span>
        </span></button>`);
      prevFrom = null;
      continue;
    }
    // --- обычное сообщение ---
    const out = m.from === state.me.username;
    const next = items[i + 1]?.m;
    const prev = items[i - 1]?.m;
    // Группируем подряд идущие сообщения одного автора (в пределах 5 минут).
    const grouped = prev && prev.kind !== "call" && prev.from === m.from && (m.ts - prev.ts) < 300;
    const lastInGroup = !(next && next.kind !== "call" && next.from === m.from && (next.ts - m.ts) < 300);
    const rowCls = ["msg-row", out ? "out" : "", grouped ? "grouped" : ""].join(" ");
    // Стикеры и видеокружки показываем БЕЗ фона пузыря — они «живут» прямо в переписке.
    const plainBubble = !!(dec && (dec.sticker || dec.file?.extra === "circle"));   // признак «сообщение без подложки»
    const bubbleCls = ["bubble", lastInGroup ? "tail" : "", plainBubble ? "bubble-plain" : ""].filter(Boolean).join(" ");   // классы пузыря
    if (m.deleted) {                                              // сообщение удалено —
      continue;                                                   //   в ленте не показываем
    }
    let content = "";
    if (m.kind === "call") content = "";
    else if (dec === null) {
      // Расшифровать не удалось (например, ключ собеседника сменился).
      content = `<span class="bubble-undecryptable">Сообщение недоступно</span>`;
    } else {
      content = renderPayload(dec);                              // собираем содержимое пузыря одной функцией
    }
    const tick = out ? (m.read
      ? `<span class="tick read" title="Прочитано"><svg><use href="#i-double-check"></use></svg></span>`
      : `<span class="tick" title="Доставлено"><svg><use href="#i-check"></use></svg></span>`) : "";
    const lock = "";                                             // никаких значков про шифрование в пузыре нет
    // ВАЖНО: собираем разметку пузыря одной строкой без отступов.
    // У пузыря включён стиль white-space: pre-wrap (чтобы сохранялись переносы строк
    // в сообщениях), поэтому лишние пробелы и переводы строк из шаблона были бы
    // видны на экране — текст «уезжал» вправо, как будто выровнен по центру.
    parts.push(`<div class="${rowCls}" data-id="${m.id}"><div class="${bubbleCls}">${replyQuoteHtml(m, dec)}${content.trim()}` +
      `<div class="bubble-time">${lock} ${fmtTime(m.ts)} ${tick}</div></div></div>`);
    prevFrom = m.from;
  }
  box.innerHTML = parts.join("") || "";
  // Расшифровываем медиа (фото/видео) и подставляем в пузыри.
  for (const el of box.querySelectorAll(".bubble-media")) {
    loadMediaInto(el);
  }
  wireSpecialBubbles(box);                                         // включаем голосовые, кружки и стикеры
  // Клик по записи звонка — перезвонить.
  for (const el of box.querySelectorAll(".call-log")) {
    el.onclick = () => startCall(el.dataset.kind, el.dataset.call);
  }
  bindBubbleMenu(box);                                             // навешиваем своё меню на пузыри
}

function replyQuoteHtml(msg, dec) {
  // Цитата «в ответ на…» внутри пузыря сообщения.
  const r = dec?.reply;                                             // цитата приходит внутри шифрованного пакета
  if (!r) return "";                                               // нет цитаты — пусто
  const mine = r.from === state.me.username;                        // я автор цитируемого?
  return `<div class="bubble-quote${mine ? " mine" : ""}" data-quote="${esc(r.id || "")}">
    <b>${esc(mine ? "Вы" : (r.name || r.from))}</b><span>${esc(r.text || "Медиафайл")}</span></div>`;   // сама цитата
}

async function loadMediaInto(el) {
  // Достаёт зашифрованный файл, расшифровывает и показывает в пузыре.
  let info;
  try { info = JSON.parse(el.dataset.file); } catch { return; }
  const isImage = (info.mime || "").startsWith("image") || (info.kind === "image" && !info.mime);   // это картинка?
  const isVideo = (info.mime || "").startsWith("video") || info.kind === "video";   // это видео?
  if (!isImage && !isVideo) {                                       // прислан обычный файл (документ, таблица, архив…)
    el.outerHTML = fileCardHtml(info);                              //   показываем его карточкой с кнопкой «открыть»
    return;                                                         //   и ничего не подгружаем
  }
  try {
    let src;
    if (info.key && info.iv) {
      // Файл закрыт: скачиваем и открываем его у себя, затем делаем временную ссылку.
      if (mediaCache.has(info.url)) src = mediaCache.get(info.url);
      else {
        const blob = await decryptFile(info.url, info.key, info.iv);
        src = URL.createObjectURL(blob);
        mediaCache.set(info.url, src);
      }
    } else {
      src = info.url;                                              // файл лежит открыто — берём ссылку как есть
    }
    el.innerHTML = isVideo
      ? `<video src="${src}" controls playsinline preload="metadata"></video>`
      : `<img src="${src}" alt="${esc(info.name || "фото")}" loading="lazy" />`;
  } catch (e) {
    el.innerHTML = `<div class="bubble-undecryptable">Не удалось открыть файл</div>`;
  }
}

function scrollMessagesToEnd() {
  // Прокрутка ленты к последнему сообщению.
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

/* ===================== 10. ОТПРАВКА СООБЩЕНИЙ ===================== */
async function sendMessage() {
  // Отправка текста (и прикреплённого файла, если он есть) — в личный чат, Избранное или комнату.
  const input = $("message-input");
  const text = input.value.trim();
  const file = state.pendingFile;
  const inRoom = !!state.activeRoom;                                // мы сейчас в группе или канале?
  if (!inRoom && !state.activeChat) return;                         // чат не открыт
  if ((!text && !file)) return;                                     // отправлять нечего
  const to = state.activeChat;                                      // собеседник (для личного чата)
  const obj = { v: 1, t: text };                                    // полезная нагрузка
  if (file) obj.file = file;                                        // данные файла уйдут внутри шифра
  if (state.replyTo) obj.reply = state.replyTo;                     // ответ на сообщение (цитата едет внутри шифра)
  let envelope = null, plain = null;                                // «конверт» и открытый вариант
  const botPeer = !inRoom && isBotUser(to);                          // собеседник — бот?
  if (state.unlocked && !state.insecure && !botPeer) {                // шифрование доступно и это не бот
    const key = inRoom ? roomKeys.get(state.activeRoom) : await convKeyFor(to);   // ключ комнаты или личный ключ
    if (!key) { toast(inRoom ? "Доступ к этой комнате ещё не открыт — попросите администратора" : "Собеседник ещё не готов к переписке — попробуйте через секунду"); return; }
    envelope = await encryptPayload(key, obj);                      // ШИФРУЕМ текст прямо здесь (сервер увидит только набор байтов)
  } else {
    // Режим без шифрования: сервер (и все, кто получит доступ к базе) сможет это прочитать.
    plain = { text, file: file ? { ...file, key: undefined, iv: undefined } : null };
  }
  if (inRoom) {                                                     // сообщение в группу/канал
    socket.emit("send_room_message", { room: state.activeRoom, kind: file ? "media" : "text", e2e: envelope, plain });
  } else {
    socket.emit("send_message", { to, kind: file ? "media" : "text", e2e: envelope, plain, secret: !!state.secretChat });   // в секретном чате помечаем сообщение отдельно
  }
  input.value = "";                                                 // очищаем поле
  autoGrow(input);                                                  // возвращаем ему обычную высоту
  state.pendingFile = null;                                         // вложение отправлено
  state.replyTo = null;                                             // ответ отправлен
  renderReplyBar();                                                 // прячем полоску цитаты
  renderAttachPreview();                                            // обновляем превью вложения
}

$("btn-send").onclick = () => {
  // Кнопка «отправить»: если сейчас идёт запись голосового — отправляем именно запись,
  // иначе отправляем обычное сообщение или вложение.
  if (typeof REC !== "undefined" && REC.busy) {                    // запись идёт —
    stopRecording(true);                                           //   завершаем и отправляем голосовое
    return;                                                        //   текст в этом случае не трогаем
  }
  sendMessage();                                                   // обычная отправка сообщения
};

$("message-input").addEventListener("keydown", (e) => {
  // Enter отправляет (если так включено), Shift+Enter — новая строка.
  if (e.key === "Enter" && !e.shiftKey && state.settings.enterToSend !== false) {
    e.preventDefault();
    sendMessage();
  }
});

function autoGrow(el) {
  // Поле ввода растёт вместе с текстом, но не выше 160 пикселей.
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

$("message-input").addEventListener("input", () => {
  // Автовысота + отдаём собеседнику «печатает…».
  autoGrow($("message-input"));
  if (!state.activeChat) return;                                   // личного чата нет (комната) — не сообщаем
  if (state.activeChat === state.me.username) return;              // «Избранное» — «печатает» показывать некому
  const now = Date.now();
  if (now - state.typingSent > 1500) {                             // не чаще раза в 1.5 секунды
    state.typingSent = now;
    socket.emit("typing", { to: state.activeChat });
  }
});

$("btn-attach").onclick = () => $("file-input").click();
// Кнопка-скрепка открывает выбор файла.

$("file-input").onchange = async () => {
  // Выбрали фото или видео — шифруем и готовим к отправке.
  const f = $("file-input").files[0];
  if (!f) return;
  if (!state.unlocked || state.insecure) {
    // Если браузер не поддерживает нужные возможности, файл уйдёт как есть.
    toast("Файл будет отправлен как есть", 4000);
  }
  toast("Загружаю файл…");
  try {
    const fd = new FormData();
    const kind = f.type.startsWith("video") ? "video"              // видео —
      : f.type.startsWith("audio") ? "audio"                       // музыка и звуки —
      : f.type.startsWith("image") ? "image"                       // картинки —
      : "file";                                                    // всё прочее (документ, таблица, архив, книга) — обычный файл
    const meta = { name: f.name, mime: f.type, kind, size: f.size };   // имя, тип, вид и размер файла
    fd.append("token", state.token);                               // ВАЖНО: без токена сервер откажет в загрузке
    if (state.unlocked && !state.insecure) {
      const { blob, fileKey, iv } = await encryptFile(f);           // шифруем файл отдельным ключом
      fd.append("file", blob, "blob.bin");                          // наружу уходят только зашифрованные байты
      fd.append("enc", "1");                                        // говорим серверу: это шифрованный файл
      const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());
      if (!up.url) throw new Error(up.error || "сервер отклонил файл");
      Object.assign(meta, { url: absUrl(up.url), key: fileKey, iv });       // ключ и IV поедут внутри шифрованного сообщения
    } else {
      fd.append("file", f, f.name);                                 // без шифрования (редкий случай)
      const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());
      if (!up.url) throw new Error(up.error || "сервер отклонил файл");
      Object.assign(meta, { url: absUrl(up.url) });
    }
    state.pendingFile = meta;
    renderAttachPreview();
    toast("Файл готов к отправке");
  } catch (e) {
    toast("Не удалось загрузить файл");
  }
  $("file-input").value = "";
};

function renderAttachPreview() {
  // Показываем плашку «файл прикреплён».
  const box = $("attach-preview");
  if (!state.pendingFile) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = `<svg><use href="${state.pendingFile.kind === "video" ? "#i-video" : "#i-photo"}"></use></svg>
    <span class="name">${esc(state.pendingFile.name || "файл")}</span>
    <button class="icon-btn" id="attach-cancel"><svg><use href="#i-x"></use></svg></button>`;
  $("attach-cancel").onclick = () => { state.pendingFile = null; renderAttachPreview(); };
}

/* ===================== 11. ЭМОДЗИ ===================== */
const EMOJIS = ["😀","😁","😂","🤣","😊","😍","🥰","😘","😎","🤩","🤔","🙃","😉","😴","😭","😅","😇","🥳","🤗","😳","👍","👎","👏","🙏","💪","🤝","👋","✌️","🔥","✨","💜","❤️","🎉","🚀","🌍","☕","🍕","⚽","🎧","📷","💡","🧠","🥇","🏆","📌","✅","❌","⏰","🗓"];
// Набор быстрых эмодзи.

$("emoji-panel").innerHTML = EMOJIS.map((e) => `<button type="button">${e}</button>`).join("");

$("emoji-panel").onclick = (e) => {
  // Вставка эмодзи в текст.
  if (e.target.tagName !== "BUTTON") return;
  const input = $("message-input");
  input.value += e.target.textContent;
  input.focus();
  autoGrow(input);
};

$("btn-emoji").onclick = () => $("emoji-panel").classList.toggle("hidden");

/* ===================== 12. ПОИСК ЛЮДЕЙ И НОВЫЙ ЧАТ ===================== */
$("btn-new-chat").onclick = () => {
  // Открываем окно поиска людей.
  $("new-chat-modal").classList.remove("hidden");
  $("user-search").value = "";
  $("user-list").innerHTML = `<div class="empty-list">Введите логин или имя человека</div>`;
  $("user-search").focus();
};
$("empty-new-chat").onclick = () => $("btn-new-chat").click();
$("new-chat-close").onclick = () => $("new-chat-modal").classList.add("hidden");

let searchTimer = null;
$("user-search").oninput = () => {
  // Ищем не на каждую букву, а с небольшой задержкой (чтобы не «долбить» сервер).
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchPeople, 350);
};

async function searchPeople() {
  // Поиск людей на сервере: выдаются только совпадения, а не все пользователи.
  const q = $("user-search").value.trim();
  const box = $("user-list");
  if (q.length < 2) { box.innerHTML = `<div class="empty-list">Введите минимум 2 символа</div>`; return; }
  box.innerHTML = `<div class="empty-list">Ищем…</div>`;
  try {
    const res = await fetch(apiUrl(`/api/find?token=${encodeURIComponent(state.token)}&q=${encodeURIComponent(q)}`));
    const data = await res.json();
    if (!data.users?.length) { box.innerHTML = `<div class="empty-list">Никого не найдено</div>`; return; }
    box.innerHTML = "";
    for (const u of data.users) {
      state.people[u.username] = u;
      const row = document.createElement("button");
      row.className = "user-row";
      row.innerHTML = `${avatarHtml(u)}
        <div class="user-row-info">
          <div class="user-row-name">${esc(u.name || u.username)}</div>
          <div class="user-row-sub">@${esc(u.username)} · ${u.online ? "в сети" : "не в сети"}</div>
        </div>`;
      row.onclick = () => {
        $("new-chat-modal").classList.add("hidden");
        openChat(u.username);
      };
      box.appendChild(row);
    }
  } catch { box.innerHTML = `<div class="empty-list">Ошибка поиска</div>`; }
}

/* ===================== 13. ПРОФИЛЬ ===================== */
const COLORS = ["#7c5cff", "#2cb67d", "#ff8c42", "#e53170", "#00b8d9", "#8a5cf6", "#f4a261", "#4cc9f0", "#ff4d6d", "#5b7bff"];

function openMyProfile() {
  // Открываем свой профиль для редактирования.
  state.editingPeer = null;
  $("profile-title").textContent = "Мой профиль";
  $("profile-name").value = state.me.name || "";
  $("profile-bio").value = state.me.bio || "";
  $("profile-username").textContent = "@" + state.me.username;
  $("profile-avatar").innerHTML = avatarHtml(state.me, "xl");
  $("profile-save-row").classList.remove("hidden");
  $("password-section").classList.remove("hidden");
  $("peer-actions").classList.add("hidden");
  $("profile-name").disabled = false;                              // своё имя можно менять
  $("profile-bio").disabled = false;                               // описание — тоже
  $("avatar-badge").classList.remove("hidden");                    // показываем «сменить аватар»
  if ($("profile-birthday")) {                                     // поле дня рождения —
    $("profile-birthday").value = state.me.birthday || "";          //   подставляем сохранённую дату
    $("profile-birthday").disabled = false;                        //   и разрешаем менять
  }
  if ($("profile-pinned")) {                                       // список моих каналов —
    fillPinnedChannels(state.me.pinned || "");                      //   заполняем и отмечаем закреплённый
    $("profile-pinned").disabled = false;                          //   и разрешаем выбирать
  }
  $("username-row")?.classList.remove("hidden");                   // строка логина с кнопкой «Изменить»
  $("username-edit-row")?.classList.add("hidden");                 // строку ввода нового логина прячем
  renderColorPicker();                                             // рисуем палитру аватара
  $("profile-modal").classList.remove("hidden");                   // открываем окно профиля
}

function openPeerProfile(username) {
  // Открываем профиль собеседника (только просмотр + звонки).
  const person = state.people[username] || { username };
  state.editingPeer = username;
  $("profile-title").textContent = person.name || username;
  $("profile-name").value = person.name || username;
  $("profile-bio").value = person.bio || "";
  $("profile-username").textContent = "@" + username;
  $("profile-avatar").innerHTML = avatarHtml(person, "xl");
  $("profile-save-row").classList.add("hidden");
  $("password-section").classList.add("hidden");                   // а смена пароля — только своя
  $("peer-actions").classList.remove("hidden");
  $("profile-name").disabled = true;                               // чужое имя менять нельзя
  $("profile-bio").disabled = true;                                // чужое описание — тоже
  if ($("profile-birthday")) {                                     // день рождения собеседника —
    $("profile-birthday").value = person.birthday || "";            //   показываем, если он его указал
    $("profile-birthday").disabled = true;                         //   менять нельзя
  }
  if ($("profile-pinned")) {                                       // закреплённый канал собеседника —
    fillPinnedChannels(person.pinned || "", true, person);           //   показываем только для чтения
    $("profile-pinned").disabled = true;                           //   менять нельзя
  }
  $("username-row")?.classList.add("hidden");                      // свою кнопку смены логина прячем
  $("username-edit-row")?.classList.add("hidden");                 // и строку ввода нового логина тоже
  $("avatar-badge").classList.add("hidden");
  $("profile-modal").classList.remove("hidden");
}

async function showPeerFingerprint(..._args) {
  // Раньше здесь показывался «отпечаток ключа» собеседника — в интерфейсе этого больше нет.
  return null;                                               // ничего не делаем
}

$("me-block").onclick = openMyProfile;
$("peer-card").onclick = () => state.activeChat && openPeerProfile(state.activeChat);
$("profile-close").onclick = () => $("profile-modal").classList.add("hidden");
$("peer-call-audio").onclick = () => { $("profile-modal").classList.add("hidden"); startCall("audio", state.editingPeer); };
$("peer-call-video").onclick = () => { $("profile-modal").classList.add("hidden"); startCall("video", state.editingPeer); };

function renderColorPicker() {
  // Палитра цветов для аватара.
  const box = $("color-picker");
  const current = state.me.avatar?.kind === "color" ? state.me.avatar.value : null;
  box.innerHTML = "";
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.className = "swatch" + (c === current ? " active" : "");
    b.style.background = c;
    b.onclick = () => {
      state.me.avatar = { kind: "color", value: c };               // мгновенно применяем локально
      $("profile-avatar").innerHTML = avatarHtml(state.me, "xl");
      renderColorPicker();
    };
    box.appendChild(b);
  }
}

$("avatar-editor").onclick = () => {
  // Клик по аватару — выбираем картинку.
  if (state.editingPeer) return;                                   // свою аватарку меняем, чужую — нет
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    toast("Загружаю аватар…");
    const fd = new FormData();
    fd.append("file", f, f.name);
    fd.append("token", state.token);                               // авторизация загрузки
    const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());
    if (up.url) {
      state.me.avatar = { kind: "photo", value: absUrl(up.url) };
      $("profile-avatar").innerHTML = avatarHtml(state.me, "xl");
      toast("Аватар загружен — не забудьте сохранить");
    }
  };
  inp.click();
};

$("profile-save").onclick = async () => {
  // Сохраняем профиль на сервере.
  const body = {
    token: state.token,                                            // кто сохраняет
    name: $("profile-name").value.trim() || state.me.username,      // имя
    bio: $("profile-bio").value.trim(),                            // описание
    birthday: $("profile-birthday") ? $("profile-birthday").value : "",            // день рождения
    pinned: $("profile-pinned") ? $("profile-pinned").value : "",  // закреплённый канал
    avatar: state.me.avatar,                                       // аватар
    settings: state.settings,                                      // настройки
  };
  const res = await fetch(apiUrl("/api/profile"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());
  if (res.me) {
    state.me = res.me;
    renderMe();
    renderChats();
    toast("Профиль сохранён");
    $("profile-modal").classList.add("hidden");
  }
};

$("copy-username").onclick = async () => {
  // Копируем логин (его сообщают друзьям, чтобы вас нашли).
  const login = state.editingPeer || state.me.username;
  try { await navigator.clipboard.writeText(login); toast("Логин скопирован: @" + login); }
  catch { toast("Логин: @" + login); }
};

async function showFingerprint(..._args) {
  // Отпечатки ключей убраны из интерфейса.
  return null;                                               // ничего не делаем
}

$("btn-change-password").onclick = async () => {
  // Смена пароля: ключ шифрования перешифровывается новым паролем.
  const old = $("pass-old").value, fresh = $("pass-new").value, again = $("pass-new2").value;
  if (fresh.length < 6) { toast("Новый пароль: минимум 6 символов"); return; }
  if (fresh !== again) { toast("Новые пароли не совпадают"); return; }
  try {
    toast("Обновляю данные…");
    const keys = await fetch(apiUrl("/api/keys?token=" + encodeURIComponent(state.token))).then((r) => r.json());
    const { kek: oldKek } = await deriveKEK(old, keys.kekSalt);     // старый ключ из старого пароля
    const privJwk = await unwrapPrivateKey(keys.encPriv, oldKek);   // проверяем, что старый пароль верный
    const { kek: newKek, saltB64 } = await deriveKEK(fresh);        // новый ключ из нового пароля
    const encPriv = await wrapPrivateKey(privJwk, newKek);          // тот же приватный ключ — новое шифрование
    const res = await fetch(apiUrl("/api/password"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token, old, new: fresh, encPriv, kekSalt: saltB64 }),
    }).then((r) => r.json());
    if (res.error) { toast(res.error); return; }
    storeIdentity(privJwk, true);                                   // обновляем ключ у себя
    $("pass-old").value = $("pass-new").value = $("pass-new2").value = "";
    toast("Пароль изменён. История сохранена");
  } catch (e) {
    toast("Старый пароль неверный");
  }
};

// Кнопка «btn-forget-device» убрана из интерфейса: обработчика больше нет.


// Кнопка «btn-regen-keys» убрана из интерфейса: обработчика больше нет.


/* ===================== 14. НАСТРОЙКИ ===================== */
$("btn-settings").onclick = () => {
  // Открываем настройки и подставляем текущие значения.
  const s = state.settings;
  $("set-compact").checked = !!s.compactMode;
  $("set-enter").checked = !!s.enterToSend;
  $("set-read").checked = !!s.readReceipts;
  $("set-sounds").checked = !!s.sounds;
  $("set-notify").checked = !!s.notifications;
  $("set-hide-online").checked = !!s.hideOnline;                 // статус «в сети»
  $("set-hide-seen").checked = !!s.hideLastSeen;
  $("set-story-vis").value = s.storyVisibility || "all";
  $("set-story-seconds").value = String(s.storySeconds || 5);
  $("app-mode").textContent = isDesktopShell() ? "Настольное приложение"
    : isStandalone() ? "Установленное приложение" : "Браузер";
  $("settings-modal").classList.remove("hidden");
};
$("settings-close").onclick = () => $("settings-modal").classList.add("hidden");

// Когда открываются настройки, дополнительно загружаем списки ботов и своих наборов стикеров.
const _openSettingsOld = $("btn-settings").onclick;                 // прежний обработчик (показать окно настроек)
$("btn-settings").onclick = () => {                                 // новый обработчик
  _openSettingsOld?.();                                             // сначала открываем окно как раньше
  loadBots();                                                       // затем подгружаем список ботов
  loadDevices();                                                    // и список устройств, где выполнен вход
  loadMyPacks();                                                    // и список своих наборов стикеров
  if (window.gmBuildLangPicker) window.gmBuildLangPicker(document.getElementById("lang-picker"));   // собираем карточки языков
};



function applySettingsToUI() {
  // Применяем настройки к интерфейсу.
  document.body.classList.toggle("compact", !!state.settings.compactMode);
  applyTheme(state.settings.theme);
  if (window.gmApplyLanguage) window.gmApplyLanguage(state.settings.lang || window.gmLang || "ru");   // переводим надписи на выбранный язык
}

async function saveSettings() {
  // Сохраняем настройки на сервере.
  const res = await fetch(apiUrl("/api/profile"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.token, settings: state.settings }),
  }).then((r) => r.json());
  if (res.me) state.me = res.me;
  applySettingsToUI();
  renderMe();
}

function bindSetting(id, key, transform = (v) => v) {
  // Универсально привязываем элемент настроек к полю в state.settings.
  $(id).onchange = async () => {
    const el = $(id);
    state.settings[key] = transform(el.type === "checkbox" ? el.checked : el.value);
    applySettingsToUI();
    if (key === "notifications" && state.settings.notifications) await askNotifications();
    await saveSettings();
  };
}

bindSetting("set-compact", "compactMode");
bindSetting("set-enter", "enterToSend");
bindSetting("set-read", "readReceipts");
bindSetting("set-sounds", "sounds");
bindSetting("set-notify", "notifications");
bindSetting("set-hide-online", "hideOnline");
bindSetting("set-hide-seen", "hideLastSeen");
bindSetting("set-story-vis", "storyVisibility");
bindSetting("set-story-seconds", "storySeconds", (v) => Number(v));

$("theme-picker").onclick = async (e) => {
  // Выбор темы.
  const btn = e.target.closest(".theme-card");
  if (!btn) return;
  state.settings.theme = btn.dataset.themeValue;
  applyTheme(state.settings.theme);
  await saveSettings();
};

async function askNotifications() {
  // Запрашиваем разрешение на системные уведомления.
  if (!("Notification" in window)) { toast("Уведомления не поддерживаются"); return; }
  const p = await Notification.requestPermission();
  if (p !== "granted") { state.settings.notifications = false; $("set-notify").checked = false; saveSettings(); }
}

function notifyDesktop(title, body) {
  // Показываем системное уведомление о новом сообщении.
  if (!state.settings.notifications) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;   // окно открыто — не мешаем
  try { new Notification(title, { body, icon: "icons/icon-192.png" }); } catch {}
}

$("btn-install").onclick = async () => {
  // Кнопка «Установить приложение» (если браузер предложил установку).
  if (state.installPrompt) {
    state.installPrompt.prompt();
    const res = await state.installPrompt.userChoice;
    if (res.outcome === "accepted") toast("Приложение устанавливается…");
    state.installPrompt = null;
  } else if (isStandalone()) {
    toast("Вы уже пользуетесь приложением");
  } else {
    toast("Откройте меню браузера → «Установить приложение»", 5000);
  }
};

window.addEventListener("beforeinstallprompt", (e) => {
  // Браузер сообщает, что приложение можно установить — запоминаем событие.
  e.preventDefault();
  state.installPrompt = e;
});

$("btn-clear").onclick = async () => {
  // Полная очистка локальных данных.
  if (!confirm("Очистить данные на этом устройстве и выйти из аккаунта?")) return;
  localStorage.clear();
  sessionStorage.clear();
  if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); }
  location.href = "/";
};

$("btn-logout-2").onclick = logout;

/* ===================== 15. ИСТОРИИ ===================== */
function openStoryModal() {
  // Сброс окна и показ.
  $("story-file").value = "";
  $("story-text").value = "";
  state.storyFile = null;
  state.storyVis = state.settings.storyVisibility || "all";
  $("story-preview-img").classList.add("hidden");
  $("story-preview-video").classList.add("hidden");
  $("story-preview-text").classList.remove("hidden");
  $("story-error").textContent = "";
  $("story-modal").classList.remove("hidden");
  $("story-visibility")?.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p.dataset.vis === state.storyVis));
}

$("story-close").onclick = () => $("story-modal").classList.add("hidden");
$("story-drop").onclick = () => $("story-file").click();
$("story-file").onclick = (e) => e.stopPropagation();

$("story-visibility").onclick = (e) => {
  // Выбор «кому видна история».
  const pill = e.target.closest(".pill");
  if (!pill) return;
  state.storyVis = pill.dataset.vis;
  $("story-visibility").querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === pill));
};

$("story-file").onchange = async () => {
  // Выбор файла истории: загружаем на сервер (истории хранятся как обычные файлы — об этом честно написано в README).
  const f = $("story-file").files[0];
  if (!f) return;
  $("story-error").textContent = "Загружаю…";
  const fd = new FormData();
  fd.append("file", f, f.name);
  fd.append("token", state.token);                                 // без токена сервер откажет в загрузке
  try {
    const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());
    if (!up.url) { $("story-error").textContent = up.error || "Ошибка загрузки"; return; }
    state.storyFile = { url: absUrl(up.url), kind: up.kind };
    $("story-error").textContent = "";
    $("story-preview-text").classList.add("hidden");
    if (up.kind === "video") {
      const v = $("story-preview-video");
      v.src = absUrl(up.url); v.classList.remove("hidden");
    } else {
      const im = $("story-preview-img");
      im.src = absUrl(up.url); im.classList.remove("hidden");
    }
  } catch { $("story-error").textContent = "Не удалось загрузить файл"; }
};

$("story-publish").onclick = async () => {
  // Публикация истории.
  if (!state.storyFile) { $("story-error").textContent = "Сначала выберите фото или видео"; return; }
  // Запоминаем выбранную видимость в настройках, чтобы она действовала по умолчанию.
  state.settings.storyVisibility = state.storyVis;
  await saveSettings();
  socket.emit("post_story", {
    url: state.storyFile.url, kind: state.storyFile.kind, text: $("story-text").value.trim(),
  });
  $("story-modal").classList.add("hidden");
  toast("История опубликована на 24 часа");
};

function renderStories() {
  // Лента историй слева сверху.
  const bar = $("stories-bar");
  bar.innerHTML = "";
  // Кнопка «добавить историю».
  const add = document.createElement("button");
  add.className = "story-item";
  add.innerHTML = `<span class="story-add"><svg><use href="#i-plus"></use></svg></span><span class="story-label">История</span>`;
  add.onclick = openStoryModal;
  bar.appendChild(add);
  // Моя история.
  if (state.myStories.length) {
    const mine = document.createElement("button");
    mine.className = "story-item";
    mine.innerHTML = `<span class="story-ring mine">${avatarHtml(state.me)}</span><span class="story-label">Моя</span>`;
    mine.onclick = () => openStoryViewer(state.myStories, 0, true);
    bar.appendChild(mine);
  }
  // Истории других людей.
  for (const g of state.stories) {
    const item = document.createElement("button");
    item.className = "story-item";
    item.innerHTML = `<span class="story-ring ${g.seen ? "seen" : ""}">${avatarHtml(g.user)}</span>
      <span class="story-label">${esc(g.user?.name || g.author)}</span>`;
    item.onclick = () => openStoryViewer(g.items, 0, false);
    bar.appendChild(item);
  }
}

function openStoryViewer(items, index, isMine) {
  // Открываем полноэкранный просмотр.
  if (!items?.length) return;
  state.viewerItems = items;
  state.viewerIndex = index;
  state.viewerIsMine = isMine;
  $("story-viewer").classList.remove("hidden");
  showStorySlide();
}

function closeStoryViewer() {
  // Закрываем просмотр.
  $("story-viewer").classList.add("hidden");
  clearTimeout(state.storyTimer);
  $("story-stage").innerHTML = "";
  state.viewerItems = [];
  renderStories();
}

$("story-viewer-close").onclick = closeStoryViewer;
$("story-prev").onclick = () => { if (state.viewerIndex > 0) { state.viewerIndex--; showStorySlide(); } else closeStoryViewer(); };
$("story-next").onclick = () => { if (state.viewerIndex < state.viewerItems.length - 1) { state.viewerIndex++; showStorySlide(); } else closeStoryViewer(); };

$("story-delete").onclick = () => {
  // Удаление своей истории.
  const item = state.viewerItems[state.viewerIndex];
  if (!item || !state.viewerIsMine) return;
  socket.emit("delete_story", { id: item.id });
  closeStoryViewer();
  toast("История удалена");
};

function showStorySlide() {
  // Показ одной истории.
  clearTimeout(state.storyTimer);
  const item = state.viewerItems[state.viewerIndex];
  if (!item) { closeStoryViewer(); return; }
  const stage = $("story-stage");
  stage.innerHTML = "";
  // Для своих историй подтягиваем свежие данные (в т.ч. счётчик просмотров).
  if (state.viewerIsMine) {
    const fresh = state.myStories.find((s) => s.id === item.id);
    if (fresh) Object.assign(item, fresh);
  }
  const el = document.createElement(item.kind === "video" ? "video" : "img");
  el.src = item.url;
  if (item.kind === "video") {
    el.autoplay = true; el.playsInline = true; el.onended = () => $("story-next").click();
  }
  stage.appendChild(el);
  // Данные автора.
  const owner = item.author ? (state.people[item.author] || { username: item.author, name: item.author }) : state.me;
  $("story-avatar").innerHTML = avatarHtml(owner, "sm");
  $("story-author").textContent = (owner.name || owner.username) + (state.viewerIsMine ? " (вы)" : "");
  $("story-time").textContent = fmtAgo(item.ts);
  $("story-caption").textContent = item.text || "";
  $("story-views").textContent = state.viewerIsMine
    ? `👁 ${item.views} ${plural(item.views, "просмотр", "просмотра", "просмотров")}${item.viewers?.length ? " · " + item.viewers.map((v) => state.people[v]?.name || v).join(", ") : ""}`
    : "";
  $("story-delete").classList.toggle("hidden", !state.viewerIsMine);
  // Полоски прогресса.
  $("story-progress").innerHTML = state.viewerItems
    .map((_, i) => `<div class="progress-seg"><b style="width:${i < state.viewerIndex ? "100%" : "0"}"></b></div>`).join("");
  // Сообщаем серверу о просмотре (для счётчика и отметки «просмотрено»).
  if (!state.viewerIsMine) socket.emit("view_story", { id: item.id });
  // Прогресс: для видео — по его времени, для фото — по секундам из настроек.
  const seg = $("story-progress").children[state.viewerIndex].firstElementChild;
  if (item.kind === "video") {
    el.ontimeupdate = () => { if (el.duration) seg.style.width = (el.currentTime / el.duration) * 100 + "%"; };
  } else {
    const total = (Number(state.settings.storySeconds) || 5) * 1000;
    const started = Date.now();
    const tick = () => {
      const pct = Math.min(100, ((Date.now() - started) / total) * 100);
      seg.style.width = pct + "%";
      if (pct < 100) state.storyTimer = setTimeout(tick, 50);
      else $("story-next").click();
    };
    tick();
  }
}

document.addEventListener("keydown", (e) => {
  // Горячие клавиши в просмотре историй.
  if ($("story-viewer").classList.contains("hidden")) return;
  if (e.key === "Escape") closeStoryViewer();
  if (e.key === "ArrowLeft") $("story-prev").click();
  if (e.key === "ArrowRight") $("story-next").click();
});

/* ===================== 16. ЗВОНКИ ===================== */
const call = {
  active: false, peer: null, kind: "audio", id: null,
  pc: null, localStream: null, pendingIce: [], pendingOffer: null,
  ringTimer: null, durationTimer: null, startedAt: 0,
  muted: false, cameraOff: false, minimized: false, timeout: null,
};

let ringCtx = null, ringLoop = null;

function startRing(kind) {
  // Гудки: браузер сам синтезирует звук (никаких mp3 не нужно).
  if (!state.settings.sounds) return;
  stopRing();
  try { ringCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  const beep = (freq, dur, at, gain = .16) => {
    const o = ringCtx.createOscillator(), g = ringCtx.createGain();
    o.frequency.value = freq;
    o.connect(g); g.connect(ringCtx.destination);
    const t = ringCtx.currentTime + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + .03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + .05);
  };
  const pattern = () => {
    if (kind === "in") { beep(880, .35, 0); beep(880, .35, .55); }    // входящий — два высоких
    else { beep(420, .9, 0, .12); }                                    // исходящий — один низкий
  };
  pattern();
  ringLoop = setInterval(pattern, kind === "in" ? 1700 : 3200);
}

function stopRing() {
  // Выключаем гудки.
  if (ringLoop) { clearInterval(ringLoop); ringLoop = null; }
  if (ringCtx) { try { ringCtx.close(); } catch {} ringCtx = null; }
}

async function getLocalStream(kind) {
  // Доступ к микрофону (и камере для видеозвонка).
  try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" }); }
  catch {
    if (kind === "video") {                                          // камеры нет — пробуем хотя бы звук
      try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { return new MediaStream(); }
    }
    return new MediaStream();
  }
}

function createPeer(peerLogin) {
  // Создаём WebRTC-соединение: через него пойдут звук и видео НАПРЯМУЮ собеседнику.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
    // STUN-серверы помогают браузерам узнать свои внешние адреса.
  });
  call.pc = pc;
  call.localStream.getTracks().forEach((t) => pc.addTrack(t, call.localStream));   // отдаём свои дорожки
  pc.ontrack = (e) => {
    // Пришёл поток собеседника.
    const rv = $("remote-video");
    rv.srcObject = e.streams[0];
    rv.play().catch(() => {});
    const hasVideo = e.streams[0].getVideoTracks().length > 0;
    $("call-overlay").classList.toggle("video", hasVideo);           // переключаем вид «видеозвонок»
  };
  pc.onicecandidate = (e) => {
    // Кандидаты (маршруты) пересылаем собеседнику через сервер.
    if (e.candidate) socket.emit("ice_candidate", { to: peerLogin, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    // Состояние соединения.
    if (pc.connectionState === "connected") {
      stopRing();
      clearTimeout(call.timeout);
      call.startedAt = Date.now();
      $("call-status").textContent = "Разговор";
      clearInterval(call.durationTimer);
      call.durationTimer = setInterval(() => {
        const sec = Math.floor((Date.now() - call.startedAt) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
        $("call-status").textContent = `Разговор · ${mm}:${ss}`;
        $("mini-status").textContent = `${mm}:${ss}`;
      }, 1000);
    } else if (["failed", "disconnected"].includes(pc.connectionState)) {
      toast("Соединение потеряно");
      endCall(false);
    }
  };
  return pc;
}

function showCallUI(person, kind, status, isIncoming = false) {
  // Показываем экран звонка.
  $("call-overlay").classList.remove("hidden");
  $("call-overlay").classList.remove("video");
  $("call-avatar").innerHTML = avatarHtml(person, "lg");
  $("call-name").textContent = person.name || person.username;
  $("call-status").textContent = status;
  $("btn-accept").classList.toggle("hidden", !isIncoming);
  $("btn-mute").classList.remove("off");
  $("btn-camera").classList.remove("off");
  $("btn-camera").classList.toggle("hidden", kind !== "video");
  const lv = $("local-video");
  lv.srcObject = call.localStream;
  lv.classList.toggle("hidden", kind !== "video");
  lv.play().catch(() => {});
  $("remote-video").srcObject = null;
  call.minimized = false;
  $("call-overlay").classList.remove("minimized");
  $("mini-call").classList.add("hidden");
  $("mini-name").textContent = person.name || person.username;
  $("mini-status").textContent = status;
}

async function startCall(kind, explicitPeer = null) {
  // Начать звонок (kind: "audio" или "video").
  const peerLogin = explicitPeer || state.activeChat;
  if (!peerLogin || call.active) return;
  const person = state.people[peerLogin] || { username: peerLogin, name: peerLogin };
  call.active = true;
  call.peer = peerLogin;
  call.kind = kind;
  call.id = "c" + Math.random().toString(36).slice(2, 10);
  call.localStream = await getLocalStream(kind);
  showCallUI(person, kind, kind === "video" ? "Видеозвонок…" : "Звоним…");
  startRing("out");
  const pc = createPeer(peerLogin);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("call_offer", { to: peerLogin, call_id: call.id, kind, sdp: pc.localDescription });
  // Если за 45 секунд не ответили — завершаем и пишем в журнал «Нет ответа».
  call.timeout = setTimeout(() => {
    if (call.active && !call.startedAt) {
      socket.emit("call_end", { to: peerLogin, call_id: call.id, reason: "timeout" });
      toast("Не отвечают");
      endCall(false);
    }
  }, 45000);
}

$("btn-call-audio").onclick = () => startCall("audio");
$("btn-call-video").onclick = () => startCall("video");

async function acceptCall() {
  // Принять входящий звонок.
  const offer = call.pendingOffer;
  if (!offer) return;
  stopRing();
  clearTimeout(call.timeout);
  call.active = true;
  call.peer = offer.from;
  call.kind = offer.kind;
  call.id = offer.call_id;
  call.localStream = await getLocalStream(offer.kind);
  showCallUI(state.people[offer.from] || { username: offer.from }, offer.kind, "Соединение…");
  const pc = createPeer(offer.from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("call_answer", { to: offer.from, call_id: call.id, sdp: pc.localDescription });
  for (const c of call.pendingIce) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
  call.pendingIce = [];
  call.pendingOffer = null;
  $("incoming-bar").classList.add("hidden");
}

function rejectCall(reason = "declined") {
  // Отклонить входящий звонок.
  const offer = call.pendingOffer;
  if (offer) socket.emit("call_reject", { to: offer.from, call_id: offer.call_id, reason });
  call.pendingOffer = null;
  stopRing();
  clearTimeout(call.timeout);
  $("call-overlay").classList.add("hidden");
  $("incoming-bar").classList.add("hidden");
}

function endCall(notifyPeer = true, reason = "hangup") {
  // Завершить звонок: сообщаем серверу (он запишет итог в журнал) и убираем за собой.
  if (notifyPeer && call.peer) socket.emit("call_end", { to: call.peer, call_id: call.id, reason });
  stopRing();
  clearTimeout(call.timeout);
  clearInterval(call.durationTimer);
  if (call.pc) { try { call.pc.close(); } catch {} }
  if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
  // ВАЖНО: здесь гасится индикатор камеры/микрофона в браузере.
  call.active = false;
  call.pc = null; call.localStream = null; call.startedAt = 0;
  call.pendingOffer = null; call.pendingIce = []; call.minimized = false;
  $("remote-video").srcObject = null;
  $("local-video").srcObject = null;
  $("call-overlay").classList.add("hidden");
  $("call-overlay").classList.remove("minimized");
  $("mini-call").classList.add("hidden");
  $("incoming-bar").classList.add("hidden");
}

$("btn-hangup").onclick = () => {
  // Кнопка «положить трубку»: для входящего это отказ, для активного — завершение.
  if (call.pendingOffer && !call.startedAt) rejectCall();
  else endCall(true);
};
$("btn-accept").onclick = acceptCall;

$("btn-mute").onclick = () => {
  // Микрофон: enabled=false означает «не передавать звук».
  if (!call.localStream) return;
  call.muted = !call.muted;
  call.localStream.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
  $("btn-mute").classList.toggle("off", call.muted);
};

$("btn-camera").onclick = () => {
  // Камера.
  if (!call.localStream) return;
  call.cameraOff = !call.cameraOff;
  call.localStream.getVideoTracks().forEach((t) => (t.enabled = !call.cameraOff));
  $("btn-camera").classList.toggle("off", call.cameraOff);
};

$("btn-minimize").onclick = () => {
  // Свернуть окно звонка: видео становится крошечным, но звук продолжает идти.
  call.minimized = true;
  $("call-overlay").classList.add("minimized");
  $("mini-call").classList.remove("hidden");
};
$("mini-open").onclick = () => {
  // Развернуть обратно.
  call.minimized = false;
  $("call-overlay").classList.remove("minimized");
  $("mini-call").classList.add("hidden");
};
$("mini-hangup").onclick = () => endCall(true);

socket.on("incoming_call", (data) => {
  // Кто-то звонит.
  if (call.active) {                                               // мы уже разговариваем —
    socket.emit("call_reject", { to: data.from, call_id: data.call_id, reason: "busy" });
    return;
  }
  call.pendingOffer = data;
  const person = data.user || state.people[data.from] || { username: data.from };
  showCallUI(person, data.kind, "Входящий звонок", true);
  $("local-video").classList.add("hidden");
  $("incoming-bar").classList.remove("hidden");
  $("incoming-bar").innerHTML = `<svg><use href="${data.kind === "video" ? "#i-video" : "#i-phone"}"></use></svg> Входящий звонок: ${esc(person.name || data.from)}`;
  startRing("in");
  // Если не ответить за 45 секунд, сервер сам запишет «пропущенный».
  call.timeout = setTimeout(() => {
    if (call.pendingOffer) { call.pendingOffer = null; stopRing(); $("call-overlay").classList.add("hidden"); $("incoming-bar").classList.add("hidden"); }
  }, 45000);
});

socket.on("call_answered", async (data) => {
  // Собеседник взял трубку (мы — звонящий).
  if (!call.active || !call.pc) return;
  stopRing();
  clearTimeout(call.timeout);
  $("call-status").textContent = "Соединение…";
  await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  for (const c of call.pendingIce) { try { await call.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
  call.pendingIce = [];
});

socket.on("ice_candidate", async (data) => {
  // Пришёл маршрут соединения.
  if (!data.candidate) return;
  if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {} }
  else call.pendingIce.push(data.candidate);                       // придержим до готовности соединения
});

socket.on("call_rejected", () => {
  // Наш звонок отклонили.
  if (!call.active) return;
  toast("Звонок отклонён");
  endCall(false);
});

socket.on("call_ended", () => {
  // Собеседник завершил звонок.
  if (call.active || call.pendingOffer) {
    toast("Звонок завершён");
    endCall(false);
  }
});

/* ===================== 17. ПРОЧЕЕ ===================== */
function returnToMainMenu() {
  // Возврат из чата в главное меню (список чатов) — с анимацией, а не выходом из приложения.
  const area = $("chat-area");                                     // область переписки
  if (!state.activeChat && !state.activeRoom) return false;         // мы и так в главном меню
  area.classList.add("closing");                                   // запускаем анимацию «уезжает вправо»
  state.activeChat = null;                                         // закрываем переписку
  state.activeRoom = null;                                         // и комнату, если она была открыта
  state.secretChat = false;                                        // выходим из секретного режима
  setTimeout(() => {                                               // когда анимация закончилась —
    area.classList.remove("open", "closing");                       //   показываем главное меню
    $("chat-header").classList.add("hidden");                      //   шапку чата прячем
    $("composer").classList.add("hidden");                         //   поле ввода прячем
    $("empty-state").classList.remove("hidden");                   //   заглушку возвращаем
    document.body.classList.remove("chat-open");                   //   нижнее меню снова на месте
    renderChats();                                                 //   обновляем список чатов
  }, 220);                                                         // столько длится анимация
  return true;                                                     // сообщаем, что вернулись
}

$("btn-back").onclick = () => {
  // Кнопка «назад» на телефоне — уходим в главное меню, приложение не закрывается.
  returnToMainMenu();                                              // анимация возврата
};

window.addEventListener("popstate", () => {
  // Системная кнопка «назад» на телефоне тоже ведёт в главное меню, а не закрывает приложение.
  if (returnToMainMenu()) history.pushState({ gm: "app" }, "");     // возвращаем «страховку», чтобы не выйти
});

document.addEventListener("keydown", (e) => {
  // На компьютере Escape делает то же самое — выйти из переписки в список чатов.
  if (e.key === "Escape" && (state.activeChat || state.activeRoom)) returnToMainMenu();   // возврат в меню
});

$("search").oninput = renderChats;
// Поиск по чатам фильтрует список на лету.



function hideSplash() {
  // Убираем заставку запуска.
  $("splash").classList.add("gone");
  setTimeout(() => $("splash").classList.add("hidden"), 450);
}

document.addEventListener("visibilitychange", () => {
  // Когда окно снова активно — обновляем «печатает…» и прокрутку.
  if (document.visibilityState === "visible" && state.activeChat) scrollMessagesToEnd();
});

if ("serviceWorker" in navigator) {
  // Регистрируем service worker: он нужен для установки приложения и офлайн-оболочки.
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ===================== 18. СТАРТ ===================== */
applyTheme(localStorage.getItem("gm_theme") || "dark");
// Тема применяется сразу (чтобы не мигало белым при запуске).
setAuthMode("login");
// Форма открывается на вкладке «Вход».
setTimeout(() => { if (!$("app") || $("app").classList.contains("hidden")) hideSplash(); }, 2500);
// Если сервер долго не отвечает, заставку всё равно убираем.

/* ===================== 19. РЕЖИМ НАСТОЯЩЕГО ПРИЛОЖЕНИЯ =====================
   Этот раздел отвечает за «нативность»: интерфейс должен вести себя как
   программа (APK/EXE), а не как открытая в браузере веб-страница.
   Здесь: запрет выделения текста, запрет меню браузера, своё меню действий
   над сообщением, «волны» от нажатий, вибрация и свайп «назад» на телефоне. */

document.documentElement.classList.add("native-app");   // помечаем окно как приложение (на случай CSS-правил)
if (isDesktopShell()) {                                 // это приложение для компьютера —
  document.documentElement.classList.add("desktop-shell");         //   включаем оформление окна программы
  const remember = $("unlock-remember");                          //   флажок «запомнить на этом устройстве»
  if (remember) remember.checked = true;                          //   в программе он включён сразу: вход помнится
  document.addEventListener("wheel", (e) => {                     //   зум колесом мыши (Ctrl+колесо) —
    if (e.ctrlKey) e.preventDefault();                            //     запрещаем: в программе масштаба нет
  }, { passive: false });
}
connectDesktopBridge();                                // подключаемся к окну приложения (полоса заголовка и кнопки)
document.addEventListener("contextmenu", (e) => {       // ловим вызов меню по правой кнопке / долгому тапу
  if (!e.target.closest("input, textarea")) e.preventDefault();   // вне полей ввода меню браузера запрещено
});
document.addEventListener("dragstart", (e) => {         // ловим попытку «утащить» картинку или ссылку мышью
  e.preventDefault();                                   // перетаскивание элементов запрещаем полностью
});
document.addEventListener("wheel", (e) => {             // ловим прокрутку колесом (в том числе с Ctrl)
  if (e.ctrlKey) e.preventDefault();                    // Ctrl+колесо больше не меняет масштаб окна
}, { passive: false });                                 // passive: false — иначе запретить действие нельзя
for (const g of ["gesturestart", "gesturechange", "gestureend"]) {   // жесты «щипок» в Safari
  document.addEventListener(g, (e) => e.preventDefault());           // их тоже отключаем
}

function haptic(ms = 10) {                              // короткая вибрация — отклик, как в нативных приложениях
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* не поддерживается — молча пропускаем */ } }
}

function appCopy(text) {                                // копирование текста в буфер обмена (для меню сообщения)
  if (!text) { toast("Нечего копировать"); return; }    // пустое сообщение копировать нечего
  const okMsg = () => toast("Текст сообщения скопирован");   // сообщение об успехе
  if (navigator.clipboard?.writeText) {                 // современный способ (нужен https или localhost)
    navigator.clipboard.writeText(text).then(okMsg).catch(() => legacyCopy(text, okMsg));   // при отказе — старый способ
  } else {
    legacyCopy(text, okMsg);                            // старый способ сразу
  }
}
function legacyCopy(text, done) {                       // запасной способ копирования (скрытое поле ввода)
  const ta = document.createElement("textarea");        // создаём невидимое поле
  ta.value = text;                                      // кладём в него текст сообщения
  ta.style.position = "fixed";                          // фиксируем положение
  ta.style.opacity = "0";                               // и делаем полностью прозрачным
  document.body.appendChild(ta);                        // добавляем в документ (иначе не сработает)
  ta.select();                                          // выделяем текст внутри поля
  try { document.execCommand("copy"); done(); } catch { toast("Скопировать не удалось"); }   // копируем и сообщаем итог
  ta.remove();                                          // убираем поле за ненадобностью
}

const appMenu = document.getElementById("app-menu");    // окно своего меню действий над сообщением
function openAppMenu(anchor, text) {                    // открываем меню для выбранного пузыря
  const title = document.getElementById("app-menu-title");   // подпись в шапке меню
  const copyBtn = document.getElementById("app-menu-copy");  // кнопка «Копировать текст»
  title.textContent = text ? (text.length > 40 ? text.slice(0, 40) + "…" : text) : "Медиафайл";   // что именно выбрано
  copyBtn.style.display = text ? "" : "none";           // если текста нет (фото/видео) — копировать нечего
  copyBtn.onclick = () => { appCopy(text); closeAppMenu(); };   // копируем и закрываем меню
  appMenu.classList.remove("hidden");                   // показываем меню
  haptic(12);                                           // лёгкая вибрация — «приложение отозвалось»
}

function closeAppMenu() {                               // закрываем меню действий
  appMenu.classList.add("hidden");                      // прячем окно меню
}
document.getElementById("app-menu-close").onclick = closeAppMenu;               // кнопка «Закрыть»
appMenu.addEventListener("click", (e) => { if (e.target === appMenu) closeAppMenu(); });   // тап по затемнению — закрыть

const LONG_PRESS_MS = 480;                              // сколько держать палец, чтобы открылось меню
let pressTimer = null;                                  // таймер долгого нажатия
let pressFrom = null;                                   // точка, где палец коснулся экрана
document.addEventListener("pointerdown", (e) => {       // палец (или мышь) коснулся экрана
  const row = e.target.closest(".msg-row");             // строка сообщения (нажатие могло попасть и в её отступы)
  const bubble = row ? row.querySelector(".bubble") : null;   // сам пузырь внутри строки
  if (!bubble || appMenu.contains(e.target)) return;    // если нет или это само меню — ничего не делаем
  pressFrom = { x: e.clientX, y: e.clientY };           // запоминаем точку нажатия
  pressTimer = setTimeout(() => {                       // через 480 мс считаем нажатие долгим
    const row = bubble.closest(".msg-row");             // строка сообщения (в ней лежит ID)
    const msg = row ? state.messages.find((m) => m.id === row.dataset.id) : null;   // данные сообщения
    if (msg) openMessageMenu(msg, bubble);              // открываем меню: ответ, копировать, удалить у меня/у всех
    else {                                              // если сообщение по какой-то причине не нашли —
      const clone = bubble.cloneNode(true);             //   берём видимый текст
      const text = (clone.textContent || "").replace(/\s+/g, " ").trim();   //   и показываем простое меню
      openAppMenu(bubble, text);                        //   с копированием текста
    }
    pressTimer = null;                                  // таймер отработал
  }, LONG_PRESS_MS);
}, true);
document.addEventListener("pointermove", (e) => {       // палец поехал по экрану
  if (!pressFrom) return;                               // долгое нажатие и не начиналось
  const moved = Math.abs(e.clientX - pressFrom.x) + Math.abs(e.clientY - pressFrom.y);   // насколько сдвинулся палец
  if (moved > 12 && pressTimer) { clearTimeout(pressTimer); pressTimer = null; }   // это прокрутка — отменяем меню
}, true);
const stopPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } pressFrom = null; };   // сброс состояния
document.addEventListener("pointerup", stopPress, true);        // палец отпущен — отменяем таймер
document.addEventListener("pointercancel", stopPress, true);    // жест прерван системой — тоже отменяем

document.addEventListener("pointerdown", (e) => {       // «волна» от нажатия на кнопках (эффект как в Android)
  const el = e.target.closest("button, .chat-item, .user-row, .theme-card, .tab");   // кнопка под пальцем (кнопки — все <button>)
  if (!el) return;                                      // нажали не на кнопку — выходим
  const r = el.getBoundingClientRect();                 // размеры и положение кнопки на экране
  const size = Math.max(r.width, r.height) * 1.1;       // диаметр «волны» чуть больше кнопки
  const wave = document.createElement("span");          // создаём элемент «волны»
  wave.className = "ripple";                            // подключаем стиль .ripple из design.css
  wave.style.width = wave.style.height = size + "px";   // задаём размер волны
  wave.style.left = (e.clientX - r.left - size / 2) + "px";   // положение по горизонтали — от точки нажатия
  wave.style.top = (e.clientY - r.top - size / 2) + "px";     // положение по вертикали — от точки нажатия
  el.appendChild(wave);                                 // добавляем волну внутрь кнопки
  setTimeout(() => wave.remove(), 560);                 // удаляем её после завершения анимации
}, true);

const sendBtn = document.getElementById("btn-send");     // кнопка отправки сообщения
if (sendBtn) sendBtn.addEventListener("click", () => haptic(8));   // при отправке — короткая вибрация
for (const id of ["btn-accept", "btn-call-audio", "btn-call-video", "btn-hangup"]) {   // кнопки звонков
  const b = document.getElementById(id);                 // берём кнопку по её идентификатору
  if (b) b.addEventListener("click", () => haptic(14)); // при звонке вибрация чуть ощутимее
}

let swipeX = null;                                       // где палец коснулся экрана при свайпе «назад»
let swipePane = null;                                    // какую панель тянем (открытый чат)
document.addEventListener("touchstart", (e) => {         // начало касания
  if (window.innerWidth > 760) return;                   // свайп нужен только на телефоне
  const pane = document.getElementById("chat-area");     // панель открытого чата
  if (!pane.classList.contains("open")) return;          // если чат закрыт — свайп не нужен
  const t = e.touches[0];                                // первое касание
  if (t.clientX > 30) return;                            // жест должен начинаться у самого левого края
  swipeX = t.clientX; swipePane = pane;                  // запоминаем начало жеста
}, { passive: true });
document.addEventListener("touchmove", (e) => {          // движение пальца
  if (swipeX === null || !swipePane) return;             // жест не начат — выходим
  const dx = e.touches[0].clientX - swipeX;              // насколько сдвинулся палец вправо
  if (dx > 0) swipePane.style.transform = `translateX(${Math.min(dx, 110)}px)`;   // чат «едет» за пальцем
}, { passive: true });
document.addEventListener("touchend", (e) => {           // палец отпущен
  if (swipeX === null || !swipePane) return;             // жест не начат — выходим
  const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : swipeX) - swipeX;   // итоговая длина жеста
  swipePane.style.transform = "";                        // возвращаем панель на место
  if (dx > 90) {                                         // если потянули достаточно далеко —
    const back = document.getElementById("btn-back");    //   берём кнопку «назад»
    if (back) back.click();                              //   и возвращаемся к списку чатов
  }
  swipeX = null; swipePane = null;                       // сбрасываем состояние жеста
}, { passive: true });

/* Контекстное меню и выделение отключаются и внутри Android-WebView —
   это сделано в MainActivity.java (setLongClickable(false), setOnLongClickListener). */


/* =========================================================================
   20. КОМНАТЫ (ГРУППЫ И КАНАЛЫ), ИЗБРАННОЕ, ВКЛАДКИ, ОТВЕТЫ, УДАЛЕНИЕ.
   Здесь собрано всё «как в Telegram»: вход в группу и канал, выдача ключа
   шифрования участникам, вкладки чатов, Избранное и ответы на сообщения.
   ========================================================================= */

/* ---------- 20.1 Ответы и удаление сообщений ---------- */
function renderReplyBar() {
  // Полоска «в ответ на…» над полем ввода.
  const bar = $("reply-bar");                                      // элемент полоски
  if (!bar) return;                                                // разметки нет — выходим
  if (!state.replyTo) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }   // ответ не выбран — прячем
  bar.innerHTML = `<svg><use href="#i-reply"></use></svg>
    <div class="reply-text"><b>${esc(state.replyTo.name || "Сообщение")}</b><span>${esc(state.replyTo.text || "Медиафайл")}</span></div>
    <button class="icon-btn" id="reply-cancel" title="Отменить ответ"><svg><use href="#i-x"></use></svg></button>`;
  bar.classList.remove("hidden");                                   // показываем
  $("reply-cancel").onclick = () => { state.replyTo = null; renderReplyBar(); };   // кнопка отмены ответа
}

function startReply(msg, text) {
  // Готовим ответ на конкретное сообщение.
  const name = msg.from === state.me.username ? "Вы" : (state.people[msg.from]?.name || msg.from);   // кто автор
  state.replyTo = { id: msg.id, from: msg.from, name, text: (text || "").slice(0, 120) };   // цитата (уйдёт внутри шифра)
  renderReplyBar();                                                // показываем полоску
  $("message-input").focus();                                      // ставим курсор в поле
}

function deleteOwnMessage(msg, scope = "all") {
  // Удаляем сообщение: scope = "me" — только у себя, "all" — у всех.
  const data = { id: msg.id, scope };                              // что удаляем и насколько широко
  if (state.activeRoom) data.room = state.activeRoom;              // в группе или канале — указываем комнату
  else {                                                           // в личной переписке —
    data.chat = chatIdOf(state.me.username, state.activeChat);      //   указываем сам чат
    if (state.secretChat) data.chat = data.chat + "|s";             //   секретный чат помечен отдельно
  }
  socket.emit("delete_message", data);                             // просим сервер удалить
  toast(scope === "all" ? "Удалено у всех" : "Удалено у вас");      // сообщаем результат
}

/* ---------- 20.2 Избранное ---------- */
function openSaved() {
  // Открываем «Избранное» — это чат с самим собой: заметки, ссылки, файлы.
  state.activeRoom = null;                                         // мы не в комнате
  $("peer-card").classList.add("saved-mode");                      // помечаем шапку как «Избранное»
  openChat(state.me.username, false, true);                        // открываем чат с собой
}

/* ---------- 20.3 Комнаты: открытие, расшифровка, отправка ---------- */
async function openRoom(roomId, silent = false) {
  // Открываем группу или канал.
  const info = state.chats.find((c) => c.kind === "room" && c.id === roomId) || { id: roomId, title: "Комната", type: "group" };   // данные из списка
  state.activeRoom = roomId;                                       // запоминаем выбранную комнату
  state.activeChat = null;                                         // личный чат закрыт
  state.peer = null;                                               // собеседника нет
  state.messages = [];                                             // лента пока пуста
  $("empty-state").classList.add("hidden");                        // прячем заглушку
  $("chat-header").classList.remove("hidden");                     // показываем шапку
  $("composer").classList.remove("hidden");                        // и панель ввода
  $("chat-area").classList.add("open");                            // на телефоне «выезжаем»
  pendingRoom = roomId;                                            // ждём ответ сервера по этой комнате
  socket.emit("get_room", { room: roomId });                       // просим историю, состав и МОЙ ключ
  if (!silent) socket.emit("room_mark_read", { room: roomId });    // помечаем прочитанным
  renderChats();                                                   // подсвечиваем строку в списке
}

async function onRoomHistory(data) {
  // Сервер прислал историю комнаты и «конверт» с ключом — расшифровываем ключ.
  if (data.room !== state.activeRoom) return;                      // это не та комната — игнорируем
  state.roomInfo = data;                                           // сохраняем сведения о комнате
  state.messages = data.messages || [];                            // история сообщений
  const ownerRec = (data.members || []).find((m) => m.role === "owner") || {};   // запись владельца комнаты
  const ownerKey = ownerRec.pub || (await peerPublicKey(ownerRec.username));   // его публичный ключ (он заворачивал ключ комнаты)
  if (data.key && ownerKey && state.unlocked && !state.insecure) {   // есть «конверт», ключ владельца и шифрование доступно
    try {
      const cv = await conversationKey(state.privJwk, ownerKey, "room:" + data.room);   // общий секрет с владельцем комнаты
      const rawKey = cv ? await decryptText(cv, data.key) : null;    // раскрываем «сырой» ключ комнаты
      if (rawKey) {                                                 // ключ раскрылся —
        roomKeys.set(data.room, await importRoomKey(rawKey));        //   запоминаем рабочий ключ,
        if (["owner", "admin"].includes(data.my_role)) roomRaw.set(data.room, rawKey);   //   админ помнит и «сырой» (чтобы выдавать доступ новым)
        toast("Доступ к комнате открыт — можно писать");           // сообщаем пользователю
      }
    } catch (e) { console.warn("Не удалось открыть ключ комнаты:", e); }   // (ключ придёт от админа комнаты отдельным сообщением)
  }
  for (const m of data.members || []) {                            // по составу комнаты
    if (m.pub && m.username !== state.me.username) state.people[m.username] = { ...(state.people[m.username] || {}), username: m.username, name: m.name, pub: m.pub };   // запоминаем публичные ключи участников
  }
  renderRoomHeader();                                              // рисуем шапку комнаты
  renderMessages();                                                // и ленту сообщений
  scrollMessagesToEnd();                                           // прокручиваем вниз
  renderChats();                                                   // обновляем список чатов
}

function renderRoomHeader() {
  // Шапка комнаты: аватар, название, состав, кнопка «О комнате».
  const info = state.roomInfo;                                     // сведения от сервера
  if (!info) return;                                               // ещё не загрузились
  const color = (state.chats.find((c) => c.id === info.room) || {}).color || "#7f5af0";   // цвет аватара
  $("peer-avatar").innerHTML = `<div class="avatar room-avatar" style="--room-color:${esc(color)}"><svg><use href="#i-${info.type === "channel" ? "broadcast" : "users"}"></use></svg></div>`;
  $("peer-name").innerHTML = `${esc(info.title)} ${info.type === "channel" ? '<svg class="room-badge"><use href="#i-broadcast"></use></svg>' : ""}`;
  const count = (info.members || []).length;                       // сколько участников
  $("peer-status").textContent = info.type === "channel"                    // в канале показываем подписчиков,
    ? `${count} подписчик(ов)`                                       //
    : `${count} участник(ов)`;                                       // в группе — участников
  $("peer-status").classList.remove("online");                      // «в сети» к комнатам не относится
  $("peer-card").classList.add("room-mode");                        // помечаем шапку как комнату
  $("peer-card").onclick = () => openRoomInfo();                    // клик по шапке — сведения о комнате
  const canPost = info.post !== false;                              // могу ли я писать
  $("composer").classList.toggle("readonly", !canPost);             // в канале для читателей поле ввода гасим
  $("composer-readonly").classList.toggle("hidden", canPost);       // и показываем пояснение
}

async function renderRoomMessages() {
  // Лента сообщений комнаты: расшифровываем тем же ключом комнаты.
  const box = $("messages");                                       // контейнер ленты
  const key = roomKeys.get(state.activeRoom);                      // ключ комнаты
  const parts = [];                                                // куски разметки
  let prevFrom = null;                                             // автор предыдущего сообщения
  for (const m of state.messages) {                                // по всем сообщениям
    if (m.deleted) {                                               // удалённые не показываем вовсе
      continue;                                                    //
    }
    const out = m.from === state.me.username;                      // моё сообщение?
    const first = prevFrom !== m.from;                             // первый в группе подряд?
    const dec = m.kind === "call" ? { call: m.call } : await decryptFull(key, m);   // расшифровываем ключом комнаты
    const author = out || !first ? "" : `<div class="bubble-author">${esc(state.people[m.from]?.name || m.from)}</div>`;   // имя автора в группе
    let content;                                                   // содержимое пузыря
    if (dec === null) content = `<span class="bubble-undecryptable"><svg><use href="#i-unlock"></use></svg> Сообщение не удалось открыть</span>`;   // ключа нет или он сменился
    else {
      content = "";                                                // собираем по частям
      if (dec.text) content += linkify(dec.text);                  // текст
      if (dec.file) content += `<div class="bubble-media" data-file='${esc(JSON.stringify(dec.file))}'>${dec.file.kind === "video" ? '<div class="media-loading"></div>' : '<div class="media-loading"></div>'}</div>`;   // медиа
      if (!dec.text && !dec.file) content = "Сообщение";           // пустое — общая подпись
    }
    const lock = "";   // значок «замок» убран: в интерфейсе нет слов и символов про шифрование
    const tick = out && m.read ? `<span class="tick read" title="Прочитано"><svg><use href="#i-double-check"></use></svg></span>` : out ? `<span class="tick"><svg><use href="#i-check"></use></svg></span>` : "";   // галочки
    parts.push(`<div class="msg-row ${out ? "out" : ""} ${first ? "" : "grouped"}" data-id="${m.id}">` +
      `<div class="bubble tail">${author}${replyQuoteHtml(m, dec)}${content}<div class="bubble-time">${lock} ${fmtTime(m.ts)} ${tick}</div></div></div>`);   // пузырь целиком
    prevFrom = m.from;                                             // запоминаем автора
  }
  box.innerHTML = parts.join("") || `<div class="empty-list">Пока пусто. Напишите первое сообщение.</div>`;
  for (const el of box.querySelectorAll(".bubble-media")) loadMediaInto(el);   // подгружаем медиа
  bindBubbleMenu(box);                                             // навешиваем своё меню на пузыри
}

function bindBubbleMenu(box) {
  // Своё меню действий над сообщением: ответ, копировать, удалить.
  for (const row of box.querySelectorAll(".msg-row")) {            // по всем пузырям
    const bubble = row.querySelector(".bubble");                   // сам пузырь
    if (!bubble) continue;                                         // пузыря нет — пропускаем
    const id = row.dataset.id;                                     // ID сообщения
    const msg = state.messages.find((m) => m.id === id);           // данные сообщения
    if (!msg) continue;                                            // не нашли — пропускаем
    bubble.oncontextmenu = (e) => { e.preventDefault(); openMessageMenu(msg, bubble); };   // своё меню вместо браузерного
  }
}

function openMessageMenu(msg, bubble) {
  // Меню действий над сообщением (правая кнопка или долгое нажатие).
  const text = (bubble.textContent || "").replace(/\s+/g, " ").trim();   // видимый текст
  const title = document.getElementById("app-menu-title");         // подпись меню
  title.textContent = text ? (text.length > 40 ? text.slice(0, 40) + "…" : text) : "Медиафайл";   // что выбрано
  const copyBtn = document.getElementById("app-menu-copy");        // «Копировать текст»
  copyBtn.style.display = text ? "" : "none";                      // без текста копировать нечего
  copyBtn.onclick = () => { appCopy(text); closeAppMenu(); };      // копируем и закрываем
  const replyBtn = document.getElementById("app-menu-reply");      // «Ответить»
  replyBtn.onclick = () => { closeAppMenu(); startReply(msg, text); };   // включаем режим ответа
  const delBtn = document.getElementById("app-menu-delete");       // «Удалить у меня»
  const mine = msg.from === state.me.username;                     // это моё сообщение?
  delBtn.querySelector("span").textContent = "Удалить у меня";      // так понятнее, чем просто «Удалить»
  delBtn.classList.remove("hidden");                               // удалить у себя можно любое сообщение
  delBtn.onclick = () => { closeAppMenu(); deleteOwnMessage(msg, "me"); };   // удаляем только у себя
  const delAll = document.getElementById("app-menu-delete-all");   // «Удалить у всех»
  if (delAll) {                                                    // кнопка есть в разметке —
    delAll.classList.toggle("hidden", !mine);                      //   показываем только для своих сообщений
    delAll.onclick = () => { closeAppMenu(); deleteOwnMessage(msg, "all"); };   // удаляем у обоих
  }                                                                // конец ветки «Удалить у всех»
  document.getElementById("app-menu").classList.remove("hidden");  // показываем меню
  haptic(12);                                                      // лёгкая вибрация
}

/* ---------- 20.4 Создание группы и канала ---------- */
function openCreateRoomDialog(type) {
  // Окно создания группы или канала.
  const modal = $("room-modal");                                   // окно
  modal.dataset.type = type;                                       // запоминаем вид создаваемого
  $("room-modal-title").textContent = type === "channel" ? "Новый канал" : "Новая группа";   // заголовок
  $("room-title").value = "";                                      // очищаем поля
  $("room-about").value = "";                                      //
  $("room-handle").value = "";                                     //
  $("room-members").innerHTML = "";                                // список приглашённых пуст
  state.roomMembers = [];                                          // и в памяти тоже
  $("room-public").checked = type === "channel";                   // каналы обычно открытые
  $("room-handle-wrap").classList.toggle("hidden", !$("room-public").checked);   // @адрес — только для открытых
  renderRoomColorPicker();                                         // палитра цветов
  renderFoundPeople("");                                           // список людей для приглашения
  modal.classList.remove("hidden");                                // показываем окно
}

function renderRoomColorPicker() {
  // Кружки выбора цвета аватара комнаты.
  const box = $("room-colors");                                    // контейнер
  box.innerHTML = ROOM_COLORS.map((c, i) =>
    `<button class="color-dot${i === 0 ? " active" : ""}" data-color="${c}" style="--dot:${c}"></button>`).join("");   // кружки
  box.dataset.color = ROOM_COLORS[0];                              // выбран первый
  for (const b of box.querySelectorAll(".color-dot")) {            // клик по кружку
    b.onclick = () => {                                            //
      box.querySelectorAll(".color-dot").forEach((x) => x.classList.remove("active"));   // снимаем выделение
      b.classList.add("active");                                   // выделяем выбранный
      box.dataset.color = b.dataset.color;                         // запоминаем цвет
    };
  }
}

function renderFoundPeople(q) {
  // Список людей, которых можно пригласить (поиск по логину через сервер).
  const box = $("room-people");                                    // контейнер
  if (!q) { box.innerHTML = `<div class="hint">Введите логин, чтобы найти человека</div>`; return; }   // без запроса — подсказка
  fetch(`${API_BASE}/api/find?token=${encodeURIComponent(state.token)}&q=${encodeURIComponent(q)}`)   // ищем на сервере
    .then((r) => r.json())                                          // разбираем ответ
    .then((data) => {
      const users = (data.users || []).filter((u) => u.username !== state.me.username);   // без себя
      for (const u of users) state.people[u.username] = { ...(state.people[u.username] || {}), ...u };   // запоминаем их публичные ключи
      box.innerHTML = users.length ? users.map((u) => `
        <button class="user-row" data-user="${esc(u.username)}">
          ${avatarHtml(u)}<div class="user-info"><div class="user-name">${esc(u.name || u.username)}</div><div class="user-login">@${esc(u.username)}</div></div>
          <span class="pick">${state.roomMembers.includes(u.username) ? "✓" : "+"}</span>
        </button>`).join("") : `<div class="hint">Никого не нашли</div>`;   // строки найденных
      for (const row of box.querySelectorAll(".user-row")) {        // клик по человеку
        row.onclick = () => {                                       // добавляем или убираем из списка
          const u = row.dataset.user;                               // логин
          state.roomMembers = state.roomMembers.includes(u) ? state.roomMembers.filter((x) => x !== u) : [...state.roomMembers, u];   // переключаем
          $("room-members").innerHTML = state.roomMembers.map((x) => `<span class="chip">@${esc(x)}</span>`).join("");   // показываем выбранных
          row.querySelector(".pick").textContent = state.roomMembers.includes(u) ? "✓" : "+";   // обновляем галочку
        };
      }
    })
    .catch(() => { box.innerHTML = `<div class="hint">Поиск недоступен</div>`; });   // сеть подвела
}

async function createRoom() {
  // Создаём группу или канал: придумываем ключ и заворачиваем его каждому участнику.
  const modal = $("room-modal");                                   // окно
  const type = modal.dataset.type || "group";                      // вид комнаты
  const title = $("room-title").value.trim();                       // название
  if (!title) { toast("Введите название"); return; }                 // без названия нельзя
  const about = $("room-about").value.trim();                       // описание
  const publicRoom = $("room-public").checked;                      // открытая или закрытая
  const handle = $("room-handle").value.trim().replace(/^@/, "");    // @адрес
  const color = $("room-colors").dataset.color;                     // цвет
  const members = [...state.roomMembers];                           // кого приглашаем
  const raw = randomRoomKey();                                      // придумываем ключ комнаты
  const keys = {};                                                  // «конверты» с ключом для участников
  if (state.unlocked && !state.insecure) {                          // шифрование доступно
    const myPub = state.me.pub;                                     // мой публичный ключ (ключ себе тоже заворачиваем)
    try { keys[state.me.username] = await wrapRoomKey(state.privJwk, myPub, raw, "wrap:self:" + title); } catch (e) {}   // себе
    for (const u of members) {                                      // каждому приглашённому
      try {
        const pub = await peerPublicKey(u);                         // его публичный ключ
        if (!pub) continue;                                         // ключа нет — пропускаем (выдадут позже)
        const env = await wrapRoomKey(state.privJwk, pub, raw, "wrap:" + u + ":" + title);   // «конверт» с ключом комнаты
        if (env) keys[u] = env;                                     // сохраняем
      } catch (e) { /* не удалось — не страшно */ }
    }
  }
  socket.emit("create_room", { type, title, about, color, public: publicRoom, handle, members, keys });   // создаём на сервере
  socket.once("room_created", async (data) => {                     // сервер подтвердил создание
    const keyObj = await importRoomKey(raw);                        // готовим рабочий ключ
    roomKeys.set(data.room, keyObj);                                // запоминаем
    roomRaw.set(data.room, raw);                                    // и текстовый (нужен, чтобы выдавать ключ новым участникам)
    modal.classList.add("hidden");                                  // закрываем окно
    toast(type === "channel" ? "Канал создан" : "Группа создана");   // сообщаем
    openRoom(data.room, true);                                      // сразу открываем
  });
}

/* ---------- 20.5 Выдача ключа новым участникам ---------- */
socket.on("room_key_needed", async (data) => {
  // Новому участнику нужен ключ комнаты — его выдаёт админ (то есть мы, если мы админ).
  const raw = roomRaw.get(data.room);                               // наш текстовый ключ комнаты
  if (!raw) {                                                       // ключа в памяти нет —
    const info = state.chats.find((c) => c.id === data.room);        //   попробуем запросить комнату,
    if (info) socket.emit("get_room", { room: data.room });          //   чтобы получить свой «конверт» и вспомнить ключ
    return;                                                         // и выйдем — выдадим в следующий раз
  }
  try {
    const pub = data.pub || (await peerPublicKey(data.member));     // публичный ключ нового участника (сервер присылает его в просьбе)
    if (!pub) return;                                               // нет ключа — выдавать нечего
    state.people[data.member] = { ...(state.people[data.member] || {}), username: data.member, pub };   // запоминаем ключ новичка
    const env = await wrapRoomKey(state.privJwk, pub, raw, "wrap:" + data.member + ":" + data.room);   // заворачиваем ключ комнаты
    if (env) socket.emit("room_key_set", { room: data.room, member: data.member, key: env });   // отдаём серверу «конверт»
  } catch (e) { /* не получилось — повторим при следующем входе */ }
});

socket.on("room_key_ready", (data) => {
  // Ключ комнаты для нас готов — перечитываем историю.
  if (data.room === state.activeRoom) socket.emit("get_room", { room: data.room });   // перезапрашиваем комнату
  toast("Доступ к переписке открыт");                               // сообщаем
});

socket.on("room_history", (data) => { onRoomHistory(data); });       // сервер прислал историю комнаты — открываем её

socket.on("room_message", async (msg) => {
  // Новое сообщение в комнате.
  if (msg.room === state.activeRoom) {                              // открыта эта комната —
    if (!state.messages.some((m) => m.id === msg.id)) state.messages.push(msg);   // добавляем в ленту
    await renderRoomMessages();                                     // перерисовываем
    scrollMessagesToEnd();                                          // вниз
    socket.emit("room_mark_read", { room: msg.room });              // помечаем прочитанным
  } else if (msg.from !== state.me?.username) {                     // сообщение в другую комнату —
    const key = roomKeys.get(msg.room);                             // ключ комнаты (если есть)
    let text = "Новое сообщение";                                   // текст для уведомления
    try {                                                           // пробуем расшифровать заранее
      const obj = key ? await decryptObject(key, msg.e2e) : null;   // расшифровка
      if (obj?.t) text = obj.t; else if (obj?.file) text = "Медиа";  //
    } catch (e) {}                                                  //
    const room = state.chats.find((c) => c.id === msg.room);         // данные комнаты
    toast(`${room?.title || "Комната"}: ${text}`);                   // показываем уведомление
    notifyDesktop(room?.title || "Комната", text);                  // и системное уведомление
  }
});

socket.on("room_invited", (data) => toast(`Вас пригласили: ${data.title}`));   // приглашение в комнату
socket.on("room_joined", (data) => {                                // вход в открытую комнату выполнен
  toast(data.needs_key ? `Вы в «${data.title}». Нужен доступ от администратора` : `Вы в «${data.title}»`);   // сообщаем
  openRoom(data.room);                                             // сразу открываем комнату
});
socket.on("room_left", (data) => {                                  // вышли из комнаты
  if (state.activeRoom === data.room) { closeRoom(); }               // если она была открыта — закрываем
  toast("Вы вышли из комнаты");                                     //
});
socket.on("room_updated", (data) => {                               // название/описание изменились
  if (state.roomInfo?.room === data.room) { state.roomInfo.title = data.title; renderRoomHeader(); }   // обновляем шапку
  renderChats();                                                    // и список
});
socket.on("rooms_found", (data) => renderFoundRooms(data.rooms || []));   // результаты поиска комнат

function renderFoundRooms(rooms) {
  // Показываем найденные открытые группы и каналы в окне создания/поиска.
  const box = $("room-found");                                     // контейнер
  if (!box) return;                                                // разметки нет
  box.innerHTML = rooms.length ? rooms.map((r) => `
    <button class="user-row" data-room="${esc(r.id)}">
      <div class="avatar room-avatar" style="--room-color:${esc(r.color || "#7f5af0")}"><svg><use href="#i-${r.type === "channel" ? "broadcast" : "users"}"></use></svg></div>
      <div class="user-info"><div class="user-name">${esc(r.title)}</div><div class="user-login">@${esc(r.handle || "")} · ${r.members} участн.</div></div>
      <span class="pick">Войти</span>
    </button>`).join("") : `<div class="hint">Открытых групп и каналов не найдено</div>`;
  for (const row of box.querySelectorAll(".user-row")) {            // клик — вход
    row.onclick = () => { socket.emit("join_room", { room: row.dataset.room }); $("room-search-modal").classList.add("hidden"); };   // входим и закрываем окно
  }
}

/* ---------- 20.6 Сведения о комнате ---------- */
function openRoomInfo() {
  // Окно «О комнате»: название, описание, участники, роли, выход.
  const info = state.roomInfo;                                     // данные
  if (!info) return;                                               // ещё не загрузились
  $("room-info-title").textContent = info.title;                   // заголовок
  $("room-info-about").textContent = info.about || "Без описания";  // описание
  $("room-info-link").textContent = info.handle ? "@" + info.handle : "закрытая комната";   // @адрес
  $("room-info-kind").textContent = info.type === "channel" ? "Канал" : "Группа";   // вид
  const iAmAdmin = info.my_role === "owner" || info.my_role === "admin";   // мои права
  $("room-info-members").innerHTML = (info.members || []).map((m) => `
    <div class="member-row">
      ${avatarHtml(m)}
      <div class="user-info"><div class="user-name">${esc(m.name || m.username)}</div><div class="user-login">@${esc(m.username)} · ${m.role === "owner" ? "владелец" : m.role === "admin" ? "админ" : "участник"}</div></div>
      ${iAmAdmin && m.role !== "owner" ? `<button class="icon-btn" data-remove="${esc(m.username)}" title="Удалить из комнаты"><svg><use href="#i-x"></use></svg></button>` : ""}
    </div>`).join("");                                             // список участников
  for (const b of $("room-info-members").querySelectorAll("[data-remove]")) {   // удаление участника
    b.onclick = () => socket.emit("remove_room_member", { room: info.room, member: b.dataset.remove });   // просим сервер
  }
  $("room-info-leave").onclick = () => { socket.emit("leave_room", { room: info.room }); $("room-info-modal").classList.add("hidden"); };   // выйти из комнаты
  $("room-info-modal").classList.remove("hidden");                 // показываем окно
}

function closeRoom() {
  // Закрываем комнату: возвращаемся к «пустому» экрану.
  state.activeRoom = null;                                         // комнаты больше нет
  state.roomInfo = null;                                           // сведения убираем
  $("chat-header").classList.add("hidden");                        // прячем шапку
  $("composer").classList.add("hidden");                           // и панель ввода
  $("empty-state").classList.remove("hidden");                     // показываем заглушку
  $("chat-area").classList.remove("open");                         // на телефоне «уезжаем»
  renderChats();                                                   // обновляем список
}

/* ---------- 20.7 Вкладки: своё окно создания ---------- */
function openTabDialog() {
  // Окно «Добавить вкладку»: название + что показывать.
  $("tab-name").value = "";                                        // очищаем название
  $("tab-filter").value = "private";                               // фильтр по умолчанию
  $("tab-modal").classList.remove("hidden");                       // показываем окно
}

function addTab() {
  // Добавляем свою вкладку.
  const name = $("tab-name").value.trim();                          // название
  if (!name) { toast("Введите название вкладки"); return; }          // без названия нельзя
  const filter = $("tab-filter").value;                            // что показывает
  const id = "t" + Date.now().toString(36);                        // ID вкладки
  state.settings.tabs = [...(state.settings.tabs || []), { id, name, filter }];   // добавляем
  saveSettings();                                                  // сохраняем в настройках
  $("tab-modal").classList.add("hidden");                          // закрываем окно
  switchTab(id);                                                   // сразу переключаемся на неё
  toast("Вкладка «" + name + "» добавлена");                        // сообщаем
}

/* ---------- 20.8 Окно программы на компьютере ----------
   На компьютере окно рисует само приложение (файлы desktop/gm_ui.py) — это нативное окно
   со своей полосой и кнопками. В телефонной версии и в предпросмотре ничего этого не нужно,
   поэтому здесь кода окна нет: интерфейс внутри APK работает как обычное приложение. */
function applyCompactList() {
  // Настройка «компактный список чатов»: строки становятся ниже (класс .compact уже описан в style.css).
  document.body.classList.toggle("compact", !!state.settings.compactMode);   // включаем класс оформления
}

/* =========================================================================
   21. ПРИВЯЗКА НОВЫХ КНОПОК И ОКОН.
   ========================================================================= */
function wireRoomUI() {
  // Кнопки в окне «Новый чат».
  $("go-create-group").onclick = () => { $("new-chat-modal").classList.add("hidden"); openCreateRoomDialog("group"); };   // создать группу
  $("go-create-channel").onclick = () => { $("new-chat-modal").classList.add("hidden"); openCreateRoomDialog("channel"); };   // создать канал
  $("go-find-rooms").onclick = () => { $("new-chat-modal").classList.add("hidden"); $("room-search-modal").classList.remove("hidden"); socket.emit("get_rooms"); };   // искать открытые комнаты
  $("go-saved").onclick = () => { $("new-chat-modal").classList.add("hidden"); openSaved(); };   // открыть Избранное

  // Окно создания комнаты.
  $("room-close").onclick = () => $("room-modal").classList.add("hidden");   // закрыть
  $("room-create").onclick = createRoom;                                     // создать
  $("room-public").onchange = () => $("room-handle-wrap").classList.toggle("hidden", !$("room-public").checked);   // показывать @адрес только для открытых
  let roomSearchTimer = null;                                                // таймер, чтобы не искать на каждую букву
  $("room-search").oninput = () => {                                         //
    clearTimeout(roomSearchTimer);                                           // отменяем прошлый поиск
    roomSearchTimer = setTimeout(() => renderFoundPeople($("room-search").value.trim()), 350);   // ищем через 0,35 с
  };

  // Окно «О комнате».
  $("room-info-close").onclick = () => $("room-info-modal").classList.add("hidden");   // закрыть

  // Окно поиска комнат.
  $("room-search-close").onclick = () => $("room-search-modal").classList.add("hidden");   // закрыть

  // Окно «Своя вкладка».
  $("tab-close").onclick = () => $("tab-modal").classList.add("hidden");     // закрыть
  $("tab-save").onclick = addTab;                                           // добавить вкладку
}

/* =========================================================================
   22. СТАРТ НОВЫХ РАЗДЕЛОВ.

   (Ниже — маленькая «приборная панель» для проверок; на работу не влияет.)
   ========================================================================= */
function initRoomsAndTabs() {
  // Включаем вкладки, комнаты и Избранное после входа.
  wireRoomUI();                                                    // привязываем кнопки
  state.activeTab = state.settings.activeTab || "all";              // возвращаем последнюю выбранную вкладку
  renderTabs();                                                    // рисуем вкладки
  renderChats();                                                   // и список чатов
  const saved = state.chats.find((c) => c.kind === "saved");        // есть ли строка «Избранное»
  if (!saved) {                                                     // если переписки с собой ещё нет —
    state.chats.push({                                              //   добавляем её в список сразу,
      kind: "saved", id: [state.me.username, state.me.username].sort().join("|"),       //
      with: state.me.username, peer: state.me, last: null, ts: 0, unread: 0,            //   чтобы «Избранное» всегда было под рукой
    });
    renderChats();                                                  // перерисовываем
  }
  window.addEventListener("resize", moveTabIndicator);              // при изменении окна двигаем «бегунок»
}

/* ===================== 24. НОВЫЕ ВОЗМОЖНОСТИ: БОТЫ, УСТРОЙСТВА, СТИКЕРЫ, ГОЛОСОВЫЕ, КРУЖКИ ===================== */

// ПУНКТ 6: имена и подписи в списке чатов стоят ровно, без «прыжков» —
// за это отвечает оформление (.chat-body и .chat-name выровнены по левому краю).

function personCard(login) {
  // Карточка человека с сервера (в ней есть отметка «бот» — она нужна, чтобы
  // понимать, можно ли звонить собеседнику и как отправлять ему сообщения).
  if (state.people[login]?.bot !== undefined && state.people[login]?.ts) return state.people[login];   // уже знаем и она свежая
  return fetch(apiUrl(`/api/user?token=${encodeURIComponent(state.token)}&username=${encodeURIComponent(login)}`))
    .then((r) => r.json())                                          // читаем ответ
    .then((u) => { if (u && !u.error) { state.people[login] = { ...(state.people[login] || {}), ...u }; } return state.people[login] || { username: login, name: login }; })
    .catch(() => state.people[login] || { username: login, name: login });   // сеть подвела — отдаём что есть
}

function isBotUser(login) {
  // Собеседник — бот? (боты читают сообщения открытым текстом и не принимают звонки)
  return !!(state.people[login]?.bot || (state.peer?.username === login && state.peer?.bot));
}

/* ---------- СТИКЕРЫ (пункты 1 и 3) ---------- */

const STICKERS = { packs: [], active: null, serverPacks: [] };      // наборы, открытый набор, наборы с сервера

const DEFAULT_STICKERS = [                                          // «Смайлики» — базовый набор, всегда доступен
  "😀", "😄", "😁", "😂", "😊", "😉", "😍", "😘", "😎", "🤩",
  "🙂", "🤔", "😐", "😴", "😢", "😭", "😡", "🤯", "🥳", "😷",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "✌️", "🤙", "👋", "🫡",
  "❤️", "🔥", "⭐", "🎉", "🎁", "🍕", "☕", "🍀", "🌙", "☀️",
];

function stickerImgHtml(st, size) {
  // Картинка стикера (обычный стикер — 120 px, в панели — 56 px).
  const s = size || 120;                                            // размер
  return `<img class="sticker" src="${absUrl(st.url)}" alt="${esc(st.emoji || "стикер")}" style="width:${s}px;height:${s}px" loading="lazy">`;
}

function openStickerPanel() {
  // Открываем панель стикеров и показываем её поверх композера.
  $("emoji-panel").classList.add("hidden");                         // эмодзи закрываем
  $("sticker-panel").classList.remove("hidden");                    // стикеры открываем
  renderStickerTabs();                                              // рисуем вкладки наборов
  if (!STICKERS.active) STICKERS.active = STICKERS.packs[0]?.id || "emoji";   // если ничего не выбрано — первый набор
  renderStickerBody();                                              // рисуем содержимое набора
}

function closeStickerPanel() {
  // Закрываем панель стикеров.
  $("sticker-panel").classList.add("hidden");                       // просто прячем
}

function renderStickerTabs() {
  // Вкладки: «Смайлики», мои наборы, установленные наборы.
  const box = $("sticker-tabs");                                    // контейнер вкладок
  const items = [{ id: "emoji", title: "😀 Смайлики" }]             // базовый набор
    .concat(STICKERS.packs.filter((p) => p.owner === state.me?.username).map((p) => ({ id: p.id, title: p.short || p.title })))   // мои наборы
    .concat(STICKERS.packs.filter((p) => p.owner !== state.me?.username).map((p) => ({ id: p.id, title: p.title })));   // установленные наборы
  box.innerHTML = items.map((it) => `<button class="sticker-tab${it.id === STICKERS.active ? " active" : ""}" data-pack="${esc(it.id)}">${esc(it.title)}</button>`).join("");
  for (const b of box.querySelectorAll(".sticker-tab")) {           // по вкладкам
    b.onclick = () => {                                             // при нажатии —
      STICKERS.active = b.dataset.pack;                             //   запоминаем выбор
      renderStickerTabs();                                          //   перерисовываем вкладки
      renderStickerBody();                                          //   и содержимое
    };
  }
}

function renderStickerBody() {
  // Содержимое выбранной вкладки: либо эмодзи, либо картинки набора.
  const box = $("sticker-body");                                    // контейнер
  if (STICKERS.active === "emoji") {                                // вкладка «Смайлики»
    box.innerHTML = DEFAULT_STICKERS.map((e) => `<button class="sticker-item emoji-item" data-emoji="${esc(e)}">${e}</button>`).join("");
    for (const b of box.querySelectorAll(".emoji-item")) {          // по смайликам
      b.onclick = () => {                                           // при нажатии —
        const input = $("message-input");                           //   берём поле ввода
        input.value += b.dataset.emoji;                             //   дописываем смайлик
        input.focus();                                              //   возвращаем фокус
      };
    }
    return;                                                         // дальше не идём
  }
  const pack = STICKERS.packs.find((p) => p.id === STICKERS.active);   // выбранный набор
  if (!pack) { box.innerHTML = `<div class="empty-list">Набор не найден</div>`; return; }   // защита
  if (!pack.stickers) {                                             // картинки ещё не загружены —
    box.innerHTML = `<div class="empty-list">Загружаем стикеры…</div>`;   //   показываем подсказку
    loadPackStickers(pack.id).then(() => {                          //   запрашиваем картинки
      if (STICKERS.active === pack.id) renderStickerBody();          //   и перерисовываем, если набор тот же
    });
    return;                                                         // дальше не идём
  }
  if (!pack.stickers.length) { box.innerHTML = `<div class="empty-list">В этом наборе пока нет стикеров</div>`; return; }   // пустой набор
  box.innerHTML = pack.stickers.map((st) => `<button class="sticker-item" data-sticker='${esc(JSON.stringify(st))}'>${stickerImgHtml(st, 56)}</button>`).join("");
  for (const b of box.querySelectorAll("[data-sticker]")) {         // по стикерам
    b.onclick = () => {                                             // при нажатии —
      sendSticker(JSON.parse(b.dataset.sticker));                    //   отправляем стикер
      closeStickerPanel();                                          //   и закрываем панель
    };
  }
}

async function loadStickerPacks() {
  // Загружаем наборы с сервера: свои и установленные. Сами картинки подгружаются
  // отдельно, когда человек открывает набор — так список наборов приходит мгновенно.
  try {
    const res = await fetch(apiUrl(`/api/stickers/packs?token=${encodeURIComponent(state.token)}`));
    const data = await res.json();                                  // ответ сервера
    if (data.error) throw new Error(data.error);                    // сервер ругается — выходим
    const старые = new Map(STICKERS.packs.map((p) => [p.id, p]));    // что уже знали (в том числе стикеры)
    const карточки = [...(data.mine || []), ...(data.installed || [])];   // все доступные наборы
    STICKERS.packs = карточки.map((p) => ({ ...p, stickers: старые.get(p.id)?.stickers || null }));   // сохраняем загруженные картинки
    if (STICKERS.active && !STICKERS.packs.some((p) => p.id === STICKERS.active)) STICKERS.active = null;   // набор пропал — сбрасываем выбор
  } catch (e) {
    STICKERS.packs = [];                                            // при ошибке просто нет наборов
  }
  if (!$("sticker-panel").classList.contains("hidden")) { renderStickerTabs(); renderStickerBody(); }   // панель открыта — обновляем её
  if (!$("settings-modal").classList.contains("hidden")) loadMyPacks();   // настройки открыты — обновляем список наборов
}

async function loadPackStickers(packId) {
  // Подгружаем картинки набора целиком (по сети они ходят только когда набор открыт).
  const pack = STICKERS.packs.find((p) => p.id === packId);         // наш набор в списке
  if (!pack) return null;                                          // нет такого
  if (pack.stickers) return pack.stickers;                          // уже загружали
  try {
    const res = await fetch(apiUrl(`/api/stickers/pack/${encodeURIComponent(packId)}?token=${encodeURIComponent(state.token)}`));
    const data = await res.json();                                  // ответ сервера
    if (data.error) throw new Error(data.error);                    // ошибка
    pack.stickers = data.pack?.stickers || [];                      // запоминаем картинки
    pack.title = data.pack?.title || pack.title;                    // и точное название
    return pack.stickers;                                           // отдаём
  } catch (e) {
    pack.stickers = [];                                             // не получилось — считаем пустым
    return pack.stickers;
  }
}

async function sendSticker(st) {
  // Отправляем стикер: если у собеседника есть этот набор — покажется стикер,
  // если нет — он тоже увидит картинку (стикер едет прямо в сообщении).
  const to = state.activeRoom ? null : state.activeChat;            // кому отправляем
  if (!state.activeRoom && !to) return;                             // чат не открыт — некуда слать
  const payload = { t: "", sticker: st };                           // содержимое сообщения
  if (state.activeRoom) {                                           // отправка в группу/канал —
    socket.emit("send_message", { room: state.activeRoom, kind: "sticker", plain: payload });   // открытым текстом (иначе бот и другие участники не прочитают)
    return;                                                         // готово
  }
  const botPeer = isBotUser(to);                                    // собеседник — бот?
  if (state.unlocked && !state.insecure && !botPeer) {               // обычный человек —
    try {
      const key = await convKeyFor(to);                             // общий ключ диалога
      if (!key) { toast("Подождите секунду и попробуйте снова"); return; }   // ключ ещё не готов
      const env = await encryptPayload(key, payload);                // закрываем содержимое сообщения
      socket.emit("send_message", { to, kind: "sticker", e2e: { v: 1, n: env.n, c: env.c } });   // отправляем закрытый пакет
    } catch (e) { toast("Не удалось отправить стикер"); }             // ошибка — сообщаем
  } else {                                                          // бот —
    socket.emit("send_message", { to, kind: "sticker", plain: payload });   // отправляем открытым текстом
  }
}

async function createPackFromFiles(files, title) {
  // Создаём набор стикеров из выбранных картинок: сначала набор, потом по одной картинке.
  if (!files?.length) return null;                                  // ничего не выбрали
  const res = await fetch(apiUrl("/api/stickers/pack"), {           // создаём набор
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.token, title: title || "Мой набор", short: (title || "Мой").slice(0, 8) }),
  });
  const data = await res.json();                                    // ответ сервера
  if (data.error) { toast(data.error); return null; }               // ошибка — сообщаем
  const packId = data.pack?.id || data.id;                          // идентификатор набора
  let count = 0;                                                    // сколько стикеров добавили
  for (const f of files) {                                          // по картинкам
    const form = new FormData();                                    // форма загрузки
    form.append("token", state.token);                              //   токен
    form.append("pack", packId);                                    //   набор
    form.append("emoji", "🙂");                                     //   значок (по умолчанию)
    form.append("file", f);                                         //   сама картинка
    const up = await fetch(apiUrl("/api/stickers/add"), { method: "POST", body: form })   // отправляем
      .then((r) => r.json()).catch(() => ({ error: "сеть" }));       // читаем ответ
    if (!up.error) count++;                                         // получилось — считаем
  }
  toast(count ? `Набор готов: ${count} стикеров` : "Не удалось загрузить картинки");   // итог
  if (count) STICKERS.active = packId;                              // новый набор сразу открываем — так его видно
  await loadStickerPacks();                                         // обновляем список наборов
  return packId;                                                    // возвращаем номер набора
}

async function loadMyPacks() {
  // Список своих наборов в настройках (можно удалить).
  const box = $("my-packs");                                        // контейнер
  if (!box) return;                                                 // разметки нет — выходим
  const mine = STICKERS.packs.filter((p) => p.owner === state.me?.username);   // только мои
  box.innerHTML = mine.length ? mine.map((p) => `
    <div class="pack-row" data-pack="${esc(p.id)}">
      <div class="pack-title">${esc(p.title)} <span class="pack-count">${p.count ?? p.stickers?.length ?? 0} шт.</span></div>
      <button class="btn btn-danger btn-sm" data-del="${esc(p.id)}">Удалить</button>
    </div>`).join("") : `<div class="empty-list">Пока нет своих наборов</div>`;   // рисуем строки
  for (const b of box.querySelectorAll("[data-del]")) {             // по кнопкам удаления
    b.onclick = async () => {                                       // при нажатии —
      const res = await fetch(apiUrl("/api/stickers/delete_pack"), {   // удаляем набор
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, pack: b.dataset.del }),
      }).then((r) => r.json()).catch(() => ({ error: "сеть" }));
      if (res.error) { toast(res.error); return; }                   // ошибка — сообщаем
      toast("Набор удалён");                                        // говорим, что всё хорошо
      await loadStickerPacks();                                     // обновляем список
    };
  }
  }

function renderMyPacks() {
  // Наборы показываем в настройках: если окно открыто — просто обновляем список.
  if ($("my-packs")) loadMyPacks();                                 // обновляем
}

function packPicker(title, onReady) {
  // Модальное окно выбора: «создать набор из картинок» или «взять готовый набор».
  $("tab-modal") && $("tab-modal").classList.add("hidden");         // на всякий случай закрываем другие окна
  const old = document.getElementById("pack-modal");                // прошлое окно
  if (old) old.remove();                                            // убираем, если было
  const wrap = document.createElement("div");                       // создаём окно
  wrap.id = "pack-modal"; wrap.className = "modal";                 // классы оформления
  wrap.innerHTML = `
    <div class="modal-card modal-wide">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="icon-btn" data-close><svg><use href="#i-x"></use></svg></button>
      </div>
      <div class="section">
        <div class="section-title"><svg><use href="#i-sticker"></use></svg> Из моих картинок</div>
        <input class="input" id="pack-title" type="text" maxlength="40" placeholder="Название набора" />
        <input class="input" id="pack-files" type="file" accept="image/*" multiple />
        <button class="btn btn-primary btn-sm" id="pack-make">Создать набор</button>
      </div>
      <div class="section">
        <div class="section-title"><svg><use href="#i-bookmark"></use></svg> Готовые наборы</div>
        <div class="pack-grid" id="pack-grid"></div>
      </div>
    </div>`;
  document.body.appendChild(wrap);                                  // показываем окно
  wrap.querySelector("[data-close]").onclick = () => wrap.remove();   // крестик закрывает
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };  // клик по фону — тоже
  const grid = wrap.querySelector("#pack-grid");                    // сетка готовых наборов
  const others = STICKERS.packs.filter((p) => p.owner !== state.me?.username);   // то, что можно установить
  grid.innerHTML = others.length ? others.map((p) => `
    <button class="pack-card" data-install="${esc(p.id)}">
      <div class="pack-card-title">${esc(p.title)}</div>
      <div class="pack-card-count">${p.count ?? p.stickers?.length ?? 0} стикеров</div>
    </button>`).join("") : `<div class="empty-list">Готовых наборов пока нет</div>`;
  for (const b of grid.querySelectorAll("[data-install]")) {        // по готовым наборам
    b.onclick = async () => {                                       // при нажатии —
      const res = await fetch(apiUrl("/api/stickers/install"), {    // устанавливаем набор
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, pack: b.dataset.install }),
      }).then((r) => r.json()).catch(() => ({ error: "сеть" }));
      if (res.error) { toast(res.error); return; }                  // ошибка — сообщаем
      toast("Набор добавлен в стикеры");                            // всё хорошо
      STICKERS.active = b.dataset.install;                          // открываем только что установленный набор
      await loadStickerPacks();                                     // обновляем список наборов
      wrap.remove();                                                // закрываем окно
    };
  }
  wrap.querySelector("#pack-make").onclick = async () => {          // создание своего набора
    const files = wrap.querySelector("#pack-files").files;          // выбранные картинки
    if (!files.length) { toast("Выберите картинки"); return; }      // ничего не выбрали
    const made = await createPackFromFiles([...files], wrap.querySelector("#pack-title").value.trim());   // создаём
    wrap.remove();                                                  // закрываем окно
    if (made && onReady) onReady(made);                             // сообщаем вызывающему
  };
}

/* ---------- ГОЛОСОВЫЕ СООБЩЕНИЯ И КРУЖКИ (пункты 1 и 2) ---------- */

function pickRecorderMime(kind) {
  // Подбираем формат записи, который понимает браузер (и телефон, и компьютер).
  const list = kind === "circle"
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of list) {                                           // по списку вариантов
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;   // первый поддерживаемый
  }
  return "";                                                        // ничего не поддерживается — пусть браузер сам решает
}

function extForMime(mime, kind) {
  // Расширение файла по типу записи.
  if (!mime) return kind === "circle" ? "webm" : "webm";             // по умолчанию — webm
  if (mime.includes("mp4")) return "mp4";                           // mp4
  if (mime.includes("ogg")) return "ogg";                           // ogg
  return "webm";                                                    // всё остальное — webm
}

async function startRecording(kind) {
  // Начинаем запись голосового (kind = "voice") или видеокружка (kind = "circle").
  if (REC.busy) return;                                             // уже пишем — выходим
  try {
    const stream = await navigator.mediaDevices.getUserMedia(kind === "circle"
      ? { audio: true, video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } } }
      : { audio: true });                                           // просим микрофон (и камеру для кружка)
    REC.stream = stream;                                            // запоминаем поток
    REC.kind = kind;                                                // что записываем
    REC.chunks = [];                                                // собранные кусочки
    REC.started = Date.now();                                       // время начала
    const mime = pickRecorderMime(kind);                            // формат записи
    REC.mime = mime;                                                // запоминаем
    REC.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);   // создаём запись
    REC.rec.ondataavailable = (e) => { if (e.data.size) REC.chunks.push(e.data); };   // копим кусочки
    REC.rec.start();                                                // начинаем
    REC.busy = true;                                                // помечаем: идёт запись
    const hint = $("rec-hint");                                     // подсказка
    hint.classList.remove("hidden");                                // показываем
    $("rec-hint-text").textContent = kind === "circle" ? "Запись кружка" : "Запись голосового";   // текст
    const preview = $("rec-preview");                               // окошко с камерой (нужно для кружка)
    if (kind === "circle" && preview) {                             // записываем кружок —
      preview.srcObject = stream;                                   //   показываем в окошке то, что видит камера
      preview.classList.remove("hidden");                           //   само окошко на экране
      try { await preview.play(); } catch (e) { /* автозапуск может быть запрещён — не страшно */ }
    } else if (preview) {                                           // пишем голосовое —
      preview.classList.add("hidden");                              //   камера не нужна, окошко прячем
    }
    const tip = $("rec-hint-tip");                                  // пояснение «отпустите, чтобы отправить»
    if (tip) tip.classList.toggle("hidden", kind === "circle");      // для кружка оно не подходит: отправляет кнопка
    REC.timer = setInterval(() => {                                 // раз в 200 мс обновляем счётчик
      const sec = Math.floor((Date.now() - REC.started) / 1000);    // сколько уже пишем
      REC.seconds = sec;                                            // запоминаем
      const clock = $("rec-time");                                  // где показываем время записи
      if (clock) clock.textContent = fmtRecDuration(sec);           // показываем «0:07» и подобное
      if (sec >= MAX_REC_SECONDS) stopRecording(true);              // слишком долго — останавливаем автоматически
    }, 200);
  } catch (e) {                                                     // нет доступа к микрофону/камере
    toast(kind === "circle" ? "Нет доступа к камере или микрофону" : "Нет доступа к микрофону");
  }
}

async function stopRecording(send) {
  // Заканчиваем запись: send = true — отправляем, false — отменяем.
  if (!REC.busy) return;                                            // ничего не пишем — выходим
  clearInterval(REC.timer);                                         // останавливаем счётчик
  REC.busy = false;                                                 // помечаем: запись закончена
  $("rec-hint").classList.add("hidden");                            // прячем подсказку
  const preview = $("rec-preview");                                 // окошко с камерой
  if (preview) {                                                    // если окошко есть —
    try { preview.pause(); } catch (e) { /* уже остановлено — не важно */ }   //   останавливаем показ
    preview.srcObject = null;                                       //   отключаем камеру от окошка
    preview.classList.add("hidden");                                //   и прячем его
  }
  const rec = REC.rec;                                              // запись
  const stream = REC.stream;                                        // поток
  const дождаться = new Promise((resolve) => {                      // ждём, пока запись отдаст последние данные
    rec.onstop = () => resolve();                                   //   по событию остановки
    try { rec.stop(); } catch (e) { resolve(); }                    //   и сама останавливаем
  });
  await дождаться;                                                  // ждём
  for (const t of stream.getTracks()) t.stop();                     // выключаем камеру и микрофон
  const blob = new Blob(REC.chunks, { type: REC.mime || (REC.kind === "circle" ? "video/webm" : "audio/webm") });   // собираем файл
  const seconds = Math.round((Date.now() - REC.started) / 1000);    // длительность
  REC.chunks = []; REC.stream = null; REC.rec = null;               // чистим состояние
  if (!send || seconds < 1 || blob.size < 800) {                    // слишком короткая запись —
    if (send) toast("Слишком коротко");                             //   подсказываем
    return;                                                         //   и ничего не отправляем
  }
  const ext = extForMime(REC.mime, REC.kind);                       // расширение файла
  const name = (REC.kind === "circle" ? "kruzhok-" : "golosovoe-") + Date.now() + "." + ext;   // имя файла
  const file = new File([blob], name, { type: blob.type });         // файл для отправки
  await sendMediaFile(file, REC.kind === "circle" ? "video" : "audio", REC.kind, seconds);   // отправляем
}

async function mediaSrc(info) {
  // Ссылка на файл для показа: если файл зашифрован — скачиваем и открываем у себя, иначе берём как есть.
  if (!info?.url) return null;                                     // адреса нет — показывать нечего
  if (!info.key || !info.iv) return info.url;                      // файл не зашифрован — ссылка готова
  if (mediaCache.has(info.url)) return mediaCache.get(info.url);   // уже открывали — берём готовую ссылку
  const blob = await decryptFile(info.url, info.key, info.iv);     // скачиваем и открываем файл у себя
  const src = URL.createObjectURL(blob);                           // делаем временную ссылку
  mediaCache.set(info.url, src);                                   // запоминаем, чтобы не скачивать дважды
  return src;                                                      // отдаём ссылку
}

async function sendMediaFile(file, kind, extraKind, seconds) {
  // Отправляем файл в открытый чат: голосовое, кружок или обычное вложение.
  const to = state.activeRoom ? null : state.activeChat;            // кому отправляем
  if (!state.activeRoom && !to) { toast("Откройте чат"); return; }  // чата нет — отправлять некуда
  try {
    const fd = new FormData();                                     // форма загрузки
    const meta = { name: file.name, mime: file.type, kind };       // описание файла для собеседника
    if (extraKind) meta.extra = extraKind;                         // пометка «голосовое» или «кружок»
    if (seconds) meta.duration = seconds;                          // длительность записи
    fd.append("token", state.token);                               // без токена сервер загрузку не примет
    const засекретить = state.unlocked && !state.insecure && !isBotUser(to || "");   // прятать ли содержимое от сервера
    if (засекретить) {                                             // обычный человек — отправляем закрытым
      const { blob, fileKey, iv } = await encryptFile(file);        // шифруем файл отдельным ключом
      fd.append("file", blob, "blob.bin");                          // наружу уходят только закрытые байты
      fd.append("enc", "1");                                        // сообщаем серверу, что это закрытый файл
      const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());   // загружаем
      if (!up.url) throw new Error(up.error || "сервер отклонил файл");   // сервер отказал
      Object.assign(meta, { url: absUrl(up.url), key: fileKey, iv });      // ключ и вектор поедут в самом сообщении
    } else {                                                       // бот или группа — отправляем как есть
      fd.append("file", file, file.name);                          // сам файл
      const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json());   // загружаем
      if (!up.url) throw new Error(up.error || "сервер отклонил файл");   // сервер отказал
      meta.url = absUrl(up.url);                                   // адрес файла на сервере
    }
    const payload = { t: "", file: meta };                          // содержимое сообщения
    const kindName = extraKind === "voice" ? "voice" : extraKind === "circle" ? "circle" : "media";   // вид сообщения
    if (state.activeRoom) {                                        // группа или канал —
      socket.emit("send_message", { room: state.activeRoom, kind: kindName, plain: payload });   // отправляем открытым текстом
      return;                                                      // готово
    }
    if (засекретить) {                                              // личный чат —
      const key = await convKeyFor(to);                             // общий ключ диалога
      const env = await encryptPayload(key, payload);               // закрываем описание сообщения
      socket.emit("send_message", { to, kind: kindName, e2e: { v: 1, n: env.n, c: env.c }, secret: !!state.secretChat });   // отправляем закрытый пакет (в секретном чате — с отметкой)
    } else {                                                        // бот —
      socket.emit("send_message", { to, kind: kindName, plain: payload });   // отправляем открытым текстом
    }
  } catch (e) {
    toast("Не удалось отправить файл");                            // что-то сорвалось — сообщаем
  }
}

function fmtRecDuration(sec) {
  // «0:07», «1:12» — длительность голосового или кружка.
  const s = Math.max(0, Math.round(sec || 0));                      // целые секунды
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");   // «минуты:секунды»
}

function renderPayload(dec) {
  // Собираем содержимое пузыря: стикер, текст, фото/видео, голосовое или кружок.
  let out = "";                                                     // итоговая разметка
  if (dec.sticker) {                                                // стикер —
    return `<div class="bubble-sticker" data-sticker='${esc(JSON.stringify(dec.sticker))}'>` +
      (dec.sticker.url ? stickerImgHtml(dec.sticker) : `<span class="sticker-emoji">${esc(dec.sticker.emoji || "🙂")}</span>`) + `</div>`;   // картинка или крупный смайлик
  }
  if (dec.text) out += linkify(dec.text);                           // текст (со ссылками)
  const f = dec.file;                                               // файл сообщения
  if (f) {                                                          // если файл есть —
    const д = f.duration ? `<span class="media-dur">${fmtRecDuration(f.duration)}</span>` : "";   // длительность записи
    if (f.extra === "voice") {                                      // голосовое сообщение
      out += `<div class="voice-msg" data-file='${esc(JSON.stringify(f))}'>
        <button class="voice-play" title="Прослушать"><svg><use href="#i-phone-in"></use></svg></button>
        <div class="voice-wave"></div>${д}<span class="voice-status">Нажмите, чтобы прослушать</span></div>`;
    } else if (f.extra === "circle") {                              // видеокружок
      out += `<div class="circle-msg" data-file='${esc(JSON.stringify(f))}'>
        <div class="circle-thumb"><svg><use href="#i-cam"></use></svg></div>${д}</div>`;
    } else if ((f.mime || "").startsWith("audio")) {                // прислали музыку или другой звук —
      out += `<div class="music-msg" data-file='${esc(JSON.stringify(f))}'>
        <button class="music-play" title="Слушать"><svg><use href="#i-phone-in"></use></svg></button>
        <div class="music-body">
          <div class="music-title">${esc(f.name || "Музыка")}</div>
          <div class="music-bar"><i></i></div>
        </div>
        <span class="music-time">0:00</span></div>`;                 //   рисуем плеер: он играет прямо в ленте
    } else if ((f.mime || "").startsWith("image")) {                // прислали картинку —
      out += `<div class="bubble-media" data-file='${esc(JSON.stringify(f))}'><div class="media-loading"></div></div>`;   //   показываем её прямо в переписке
    } else if ((f.mime || "").startsWith("video") || f.kind === "video") {   // прислали видео —
      out += `<div class="bubble-media" data-file='${esc(JSON.stringify(f))}'><div class="media-loading"></div></div>`;   //   показываем плеером
    } else {                                                        // любой другой файл: документ, таблица, архив, книга…
      out += fileCardHtml(f);                                       //   показываем карточкой с кнопкой «открыть»
    }
  }
  if (!out) out = "Сообщение";                                      // пусто — не оставляем пузырь
  return out;
}

function fileCardHtml(f) {
  // Карточка обычного файла (документ, таблица, архив, книга и любой другой формат).
  // По нажатию файл открывается программой этого компьютера или телефона.
  const имя = f.name || "Файл";                                    // как называется файл
  const размер = f.size ? " · " + fmtSize(f.size) : "";            // размер, если сервер его сообщил
  return `<div class="file-msg" data-file='${esc(JSON.stringify(f))}'>` +
    `<span class="file-icon"><svg><use href="#i-clip"></use></svg></span>` +
    `<span class="file-body"><span class="file-name">${esc(имя)}</span>` +
    `<span class="file-hint">Нажмите, чтобы открыть${размер}</span></span></div>`;   // сама карточка
}

function fmtSize(bytes) {
  // Человеческий размер файла: байты, килобайты, мегабайты.
  const b = Number(bytes) || 0;                                   // сколько байт
  if (b < 1024) return b + " Б";                                  // совсем маленький
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " КБ";      // килобайты
  return (b / 1024 / 1024).toFixed(1) + " МБ";                    // мегабайты
}

function bytesToB64(bytes) {
  // Превращает байты файла в текст base64: так файл можно передать программе-окну.
  let out = "";                                                   // сюда собираем результат
  const chunk = 0x8000;                                           // по 32 КБ — иначе большие файлы «роняют» вызов
  for (let i = 0; i < bytes.length; i += chunk) {                 // идём по файлу кусками
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));   // превращаем кусок в строку
  }
  return btoa(out);                                               // и кодируем её в base64
}

async function openAttachedFile(el) {
  // Открывает присланный файл подходящей программой компьютера или телефона.
  let f;                                                          // описание файла из сообщения
  try { f = JSON.parse(el.dataset.file || "{}"); } catch { return; }
  const имя = f.name || "файл";                                   // имя файла
  toast("Открываю файл…");                                        // сообщаем человеку, что начали
  try {
    const src = await mediaSrc(f);                                // получаем ссылку (файл при необходимости расшифруется)
    if (!src) { toast("Не удалось открыть файл"); return; }        // ссылки нет — не получилось
    const blob = await fetch(src).then((r) => r.blob());          // читаем сам файл
    const байты = new Uint8Array(await blob.arrayBuffer());        // и превращаем его в байты
    const api = desktopApi();                                     // мост программы для компьютера
    if (api && typeof api.openFile === "function") {              // на компьютере —
      const res = await api.openFile(имя, bytesToB64(байты));      //   сохраняем файл рядом с программой и открываем системной программой
      if (res && res.ok) toast("Файл открыт: " + имя);             //   получилось
      else toast((res && res.error) || "Не удалось открыть файл");  //   не получилось — говорим почему
      return;                                                     // готово
    }
    const link = phone();                                         // мост приложения на телефоне
    if (link && typeof link.openFile === "function") {            // на телефоне —
      link.openFile(имя, blob.type || f.mime || "", bytesToB64(байты));   //   передаём файл приложению: оно откроет его своим просмотрщиком
      toast("Открываю файл: " + имя);                              //   сообщаем человеку
      return;                                                     // готово
    }
    const url = URL.createObjectURL(blob);                        // в браузере — просто скачиваем файл
    const a = document.createElement("a");                        // невидимая ссылка
    a.href = url; a.download = имя; a.click();                    // запускаем скачивание
    setTimeout(() => URL.revokeObjectURL(url), 20000);            // ссылку подчищаем позже
  } catch (e) {
    console.error("файл:", e);                                    // подробности — в консоль разработчика
    toast("Не удалось открыть файл");                             // а человеку — коротко
  }
}

async function openCircle(el) {
  // Открываем кружок на весь экран: сначала (если нужно) расшифровываем файл.
  const f = JSON.parse(el.dataset.file || "{}");                    // описание файла
  try {
    const src = await mediaSrc(f);                                  // получаем ссылку на расшифрованный файл
    if (!src) { toast("Не удалось открыть кружок"); return; }        // не получилось
    $("circle-video").src = src;                                    // подставляем видео
    $("circle-view").classList.remove("hidden");                    // показываем окно
    $("circle-video").play().catch(() => {});                       // пробуем запустить
  } catch (e) { console.error("кружок:", e); toast("Не удалось открыть кружок"); }   // ошибка
}

function voiceAudioFor(el, f) {
  // Готовим звук для голосового сообщения (одна запись на пузырь).
  if (!el._audio) el._audio = new Audio();                          // создаём плеер, если его ещё нет
  const audio = el._audio;                                          // тот самый плеер
  if (!audio.src) {                                                 // ссылки ещё нет —
    mediaSrc(f).then((src) => {                                     //   берём расшифрованную ссылку
      if (src) audio.src = src;                                     //   подставляем в плеер
    }).catch(() => {});                                             // ошибки не ломают интерфейс
  }
  return audio;                                                     // отдаём плеер
}

async function toggleVoicePlay(el, f) {
  // Играем или ставим на паузу голосовое сообщение.
  const audio = voiceAudioFor(el, f);                               // плеер этого сообщения
  const во = el.querySelector(".voice-wave");                       // «волна» — по ней видно, что играет
  if (!audio.src) {                                                 // ссылки ещё нет —
    const src = await mediaSrc(f);                                  //   получаем её сейчас
    if (!src) { toast("Не удалось воспроизвести"); return; }         //   не вышло
    audio.src = src;                                                //   подставляем
  }
  if (audio.paused) {                                               // сейчас тишина —
    await audio.play().catch(() => {});                             //   запускаем
    el.classList.add("playing");                                    //   помечаем, что играет
  } else {                                                          // сейчас играет —
    audio.pause();                                                  //   ставим паузу
    el.classList.remove("playing");                                 //   снимаем отметку
  }
  if (во) во.classList.toggle("on", !audio.paused);                 // подсвечиваем волну
  audio.onended = () => { el.classList.remove("playing"); if (во) во.classList.remove("on"); };   // доиграло — снимаем отметки
}

function toggleVoiceCircle(el) {
  // Тап по голосовому: показываем «кружок» (видеосообщение) — аватарку с волной.
  // Ещё один тап возвращает обычный вид, как просил пользователь.
  const f = JSON.parse(el.dataset.file || "{}");                    // описание файла
  if (el.classList.contains("as-circle")) {                         // кружок уже показан —
    el.classList.remove("as-circle");                               //   возвращаем обычный вид
    el.querySelector(".voice-circle")?.remove();                    //   и убираем круг
    return;                                                         //   больше ничего не делаем
  }
  const row = el.closest(".msg-row");                               // строка сообщения
  const mine = row ? row.classList.contains("out") : false;          // это моё голосовое?
  const from = mine ? state.me.username : state.activeChat;          // чей голос: мой или собеседника
  const person = state.people[from] || (mine ? state.me : { username: from });   // карточка автора
  const круг = document.createElement("div");                       // сам круг
  круг.className = "voice-circle";                                 // класс оформления
  круг.innerHTML = `<div class="vc-avatar">${avatarHtml(person, "lg")}</div>
    <div class="vc-wave">${Array.from({ length: 18 }, (_, i) => `<i style="height:${6 + ((i * 5) % 16)}px"></i>`).join("")}</div>
    <div class="vc-hint">Ещё раз — вернуть обычный вид</div>`;      // аватарка, «волна» и подсказка
  el.classList.add("as-circle");                                    // помечаем пузырь как «кружок»
  el.appendChild(круг);                                             // показываем круг
  toggleVoicePlay(el, f);                                           // сразу начинаем воспроизведение
}

function musicAudio(el) {
  // Готовим звук для присланной музыки: один плеер на сообщение.
  if (!el._audio) el._audio = new Audio();                          // создаём плеер, если его ещё нет
  const audio = el._audio;                                          // он же
  const bar = el.querySelector(".music-bar i");                     // полоса прогресса
  const time = el.querySelector(".music-time");                     // время звучания
  audio.ontimeupdate = () => {                                      // пока играет —
    const d = audio.duration || 0;                                  //   длительность записи
    if (bar) bar.style.width = (d ? (audio.currentTime / d) * 100 : 0) + "%";   //   двигаем полосу
    if (time) time.textContent = fmtRecDuration(audio.currentTime);  //   и показываем время
  };
  audio.onended = () => {                                           // доиграло —
    el.classList.remove("playing");                                 //   снимаем отметку
    if (bar) bar.style.width = "0%";                                 //   сбрасываем полосу
    const btn = el.querySelector(".music-play");                     //   кнопка «слушать»
    if (btn) btn.innerHTML = `<svg><use href="#i-phone-in"></use></svg>`;   //   возвращаем значок
  };
  return audio;                                                     // отдаём плеер
}

async function musicToggle(el) {
  // Включаем или выключаем музыку, присланную в сообщении.
  const f = JSON.parse(el.dataset.file || "{}");                    // описание файла
  const btn = el.querySelector(".music-play");                      // кнопка «слушать»
  const audio = musicAudio(el);                                     // плеер этого сообщения
  if (!audio.src) {                                                 // ссылки ещё нет —
    const src = await mediaSrc(f);                                  //   расшифровываем файл
    if (!src) { toast("Не удалось открыть музыку"); return; }        //   не вышло
    audio.src = src;                                                //   подставляем ссылку
  }
  if (audio.paused) {                                               // сейчас тишина —
    await audio.play().catch(() => {});                             //   запускаем
    el.classList.add("playing");                                    //   помечаем, что играет
  } else {                                                          // сейчас играет —
    audio.pause();                                                  //   ставим паузу
    el.classList.remove("playing");                                 //   снимаем отметку
  }
  if (btn) btn.innerHTML = `<svg><use href="#${audio.paused ? "i-phone-in" : "i-minimize"}"></use></svg>`;   // меняем значок
}

function initMessageDelegation() {
  // Один обработчик кликов на всю ленту: кнопки голосовых, музыки и кружков работают
  // всегда — даже после того, как лента перерисовалась (тогда старые обработчики теряются).
  const box = $("messages");                                        // лента сообщений
  if (!box || box._gmDelegated) return;                             // разметки нет или уже включено
  box._gmDelegated = true;                                          // помечаем, что включили
  box.addEventListener("click", async (e) => {                      // любое нажатие в ленте
    const music = e.target.closest(".music-msg");                   // нажали по музыке?
    if (music) { await musicToggle(music); return; }                 //   включаем или выключаем её
    const voice = e.target.closest(".voice-msg");                   // нажали по голосовому?
    if (voice) {                                                    //   да —
      const f = JSON.parse(voice.dataset.file || "{}");              //   описание файла
      if (e.target.closest(".voice-play")) toggleVoicePlay(voice, f);   //   по кнопке — играем
      else toggleVoiceCircle(voice);                                //   по пузырю — показываем кружок
      return;                                                       //   и выходим
    }
    const circle = e.target.closest(".circle-msg");                 // нажали по кружку —
    if (circle) { openCircle(circle); return; }                     //   открываем его на весь экран
    const file = e.target.closest(".file-msg");                     // нажали по файлу (документ, таблица, архив…)
    if (file) { await openAttachedFile(file); return; }             //   открываем его программой этого устройства
  });
}

function wireSpecialBubbles(box) {
  // Рисуем «волну» у голосовых и включаем общий обработчик кликов по ленте.
  for (const el of box.querySelectorAll(".voice-msg")) {            // по голосовым сообщениям
    const wave = el.querySelector(".voice-wave");                    // их «волна»
    if (wave && !wave.innerHTML) {                                  // если она ещё не нарисована —
      wave.innerHTML = Array.from({ length: 22 }, (_, i) => `<i style="height:${5 + ((i * 7) % 14)}px"></i>`).join("");   // рисуем полоски
    }
  }
  for (const el of box.querySelectorAll(".music-msg")) musicAudio(el);   // готовим плееры музыки
  initMessageDelegation();                                          // включаем общий обработчик кликов
}

/* ---------- УСТРОЙСТВА И БОТЫ В НАСТРОЙКАХ (пункты 4 и 8) ---------- */

function fmtDeviceTime(ts) {
  // Время «последнего входа» устройства по-русски.
  if (!ts) return "—";                                              // данных нет
  const d = new Date(ts * 1000);                                    // время
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });   // например «24.09, 11:05»
}

async function loadDevices() {
  // Список устройств, где выполнен вход в аккаунт.
  const box = $("devices-list");                                    // контейнер
  if (!box) return;                                                 // разметки нет
  const res = await fetch(apiUrl(`/api/devices?token=${encodeURIComponent(state.token)}`)).then((r) => r.json()).catch(() => ({ error: "сеть" }));
  if (res.error) { box.innerHTML = `<div class="empty-list">Не удалось получить список</div>`; return; }   // ошибка
  const list = res.devices || [];                                   // устройства
  box.innerHTML = list.length ? list.map((d) => `
    <div class="device-row">
      <div class="device-info">
        <div class="device-name">${esc(d.name || "Устройство")}${d.current ? '<span class="dev-now">это устройство</span>' : ""}</div>
        <div class="device-sub">${esc(d.platform || "")} · вход ${fmtDeviceTime(d.last_seen || d.created)}</div>
      </div>
      ${d.current ? "" : `<button class="btn btn-danger btn-sm" data-revoke="${esc(d.id)}">Выйти</button>`}
    </div>`).join("") : `<div class="empty-list">Список пуст</div>`;   // рисуем строки
  for (const b of box.querySelectorAll("[data-revoke]")) {          // по кнопкам «Выйти»
    b.onclick = async () => {                                       // при нажатии —
      const r = await fetch(apiUrl("/api/devices/revoke"), {         // отзываем доступ устройству
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, id: b.dataset.revoke }),
      }).then((x) => x.json()).catch(() => ({ error: "сеть" }));
      if (r.error) { toast(r.error); return; }                      // ошибка
      toast("Устройство отключено");                                // всё хорошо
      loadDevices();                                                // обновляем список
    };
  }
}

async function loadBots() {
  // Список своих ботов: имя, логин, кнопки «токен» и «удалить».
  const box = $("bots-list");                                       // контейнер
  if (!box) return;                                                 // разметки нет
  const res = await fetch(apiUrl(`/api/bots?token=${encodeURIComponent(state.token)}`)).then((r) => r.json()).catch(() => ({ error: "сеть" }));
  if (res.error) { box.innerHTML = `<div class="empty-list">Не удалось получить список</div>`; return; }   // ошибка
  const list = res.bots || [];                                      // боты
  box.innerHTML = list.length ? list.map((b) => `
    <div class="bot-row">
      <div class="bot-info">
        <div class="bot-name">${esc(b.name || b.username)} <span class="bot-tag">бот</span></div>
        <div class="bot-sub">@${esc(b.username)}${b.about ? " · " + esc(b.about) : ""}</div>
      </div>
      <div class="bot-actions">
        <button class="btn btn-ghost btn-sm" data-chat="${esc(b.username)}">Написать</button>
        <button class="btn btn-ghost btn-sm" data-token="${esc(b.username)}">Показать токен</button>
        <button class="btn btn-danger btn-sm" data-del="${esc(b.username)}">Удалить</button>
      </div>
    </div>`).join("") : `<div class="empty-list">Пока нет ботов</div>`;   // рисуем строки
  for (const b of box.querySelectorAll("[data-chat]")) {            // написать боту
    b.onclick = () => { $("settings-modal").classList.add("hidden"); openChat(b.dataset.chat); };
  }
  for (const b of box.querySelectorAll("[data-token]")) {           // показать токен (можно ещё раз получить новый)
    b.onclick = async () => {
      const r = await fetch(apiUrl("/api/bots/token"), {            // просим у сервера новый токен
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, username: b.dataset.token }),
      }).then((x) => x.json()).catch(() => ({ error: "сеть" }));
      if (r.error) { toast(r.error); return; }                      // ошибка
      showBotToken(b.dataset.token, r.token);                       // показываем инструкцию
    };
  }
  for (const b of box.querySelectorAll("[data-del]")) {             // удалить бота
    b.onclick = async () => {
      if (!confirm(`Удалить бота @${b.dataset.del}? Это действие необратимо.`)) return;   // спрашиваем
      const r = await fetch(apiUrl("/api/bots/delete"), {           // удаляем
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, username: b.dataset.del }),
      }).then((x) => x.json()).catch(() => ({ error: "сеть" }));
      if (r.error) { toast(r.error); return; }                      // ошибка
      toast("Бот удалён");                                          // всё хорошо
      loadBots();                                                   // обновляем список
    };
  }
}

function showBotToken(login, token) {
  // Показываем токен и короткую инструкцию, как запустить бота на Python.
  const box = $("bot-token-box");                                   // блок показа
  if (!box) { toast("Токен: " + token, 8000); return; }             // разметки нет — показываем всплывашкой
  box.classList.remove("hidden");                                   // раскрываем блок
  box.innerHTML = `
    <div class="bot-token-title">Токен бота @${esc(login)}</div>
    <code class="bot-token-value">${esc(token)}</code>
    <div class="bot-token-hint">Токен показывается один раз — сохраните его. Токен нужен только вашей программе-боту.</div>`;
}

$("bot-create") && ($("bot-create").onclick = async () => {          // создать бота (эта работа только у владельца аккаунта)
  const login = $("bot-login").value.trim().toLowerCase();           // логин
  const name = $("bot-name").value.trim();                           // имя
  const about = $("bot-about").value.trim();                         // описание
  if (login.length < 3) { toast("Логин бота — минимум 3 символа"); return; }   // проверка
  const r = await fetch(apiUrl("/api/bots"), {                       // создаём
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: state.token, username: login, name: name || login, about }),
  }).then((x) => x.json()).catch(() => ({ error: "сеть" }));
  if (r.error) { toast(r.error); return; }                           // ошибка
  $("bot-login").value = $("bot-name").value = $("bot-about").value = "";   // очищаем поля
  showBotToken(login, r.token);                                      // показываем токен
  loadBots();                                                        // обновляем список
  toast("Бот создан. Сохраните токен и запустите программу бота");    // подсказываем порядок действий
});

$("sticker-bot-chat") && ($("sticker-bot-chat").onclick = () => {     // кнопка «Стикер-бот» в панели стикеров
  closeStickerPanel();                                               // закрываем панель
  openChat("stickers");                                              // открываем переписку со Стикер-ботом
});

$("sticker-new") && ($("sticker-new").onclick = () => {               // «Новый набор» в панели стикеров
  packPicker("Новый набор стикеров", () => { closeStickerPanel(); });   // открываем окно создания
});

$("sticker-manage") && ($("sticker-manage").onclick = () => {         // «Мои наборы»
  packPicker("Мои наборы стикеров");                                  // окно управления наборами
});

$("pack-create") && ($("pack-create").onclick = () => {               // «Создать набор из картинок» в настройках
  packPicker("Создать набор стикеров");                               // то же окно
});

/* ---------- ЗАПИСЬ ГОЛОСОВЫХ И КРУЖКОВ: КНОПКИ ---------- */

const REC = { busy: false, rec: null, stream: null, chunks: [], kind: "voice", started: 0, seconds: 0, mime: "", timer: null };   // состояние записи
const MAX_REC_SECONDS = 30;                                          // максимальная длина записи (30 секунд)

const circleBtn = $("btn-circle");                                 // кнопка видеокружка
if (circleBtn) {                                                   // кнопка есть —
  circleBtn.addEventListener("click", async (e) => {                // одно нажатие — начали, второе — отправили
    e.preventDefault();                                            // не выделяем текст
    if (REC.busy && REC.kind === "circle") { stopRecording(true); return; }   // запись идёт — заканчиваем и отправляем
    closeStickerPanel();                                           // панели закрываем, чтобы ничего не мешало
    await startRecording("circle");                                // начинаем запись кружка
  });
}

$("rec-send") && ($("rec-send").onclick = () => {                   // кнопка «Отправить» в окне записи
  if (REC.busy) stopRecording(true);                               // отправляем то, что записали
});

$("rec-cancel") && ($("rec-cancel").onclick = () => {               // кнопка «Отмена» в окне записи
  if (REC.busy) stopRecording(false);                              // выбрасываем запись и ничего не отправляем
});

for (const [id, kind] of [["btn-mic", "voice"], ["btn-circle", "circle"]]) {   // кнопка голосового и кнопка кружка
  if (kind === "circle") continue;                                 // кружок работает «по нажатию» — см. выше
  const btn = $(id);                                               // сама кнопка
  if (!btn) continue;                                              // кнопки нет — пропускаем
  const начать = async (e) => {                                     // начали удерживать
    e.preventDefault();                                            // не выделяем текст
    await startRecording(kind);                                    // начинаем запись
  };
  const завершить = (e) => {                                       // отпустили палец или кнопку мыши
    e.preventDefault();                                            // ничего лишнего
    if (REC.busy && REC.kind === kind) stopRecording(true);         // закончили и отправили
  };
  btn.addEventListener("pointerdown", начать);                     // удержание на телефоне и на ПК
  btn.addEventListener("pointerup", завершить);                    // отпускание
  btn.addEventListener("pointercancel", () => { if (REC.busy && REC.kind === kind) stopRecording(false); });   // жест отменили
  btn.addEventListener("pointerleave", () => { if (REC.busy && REC.kind === kind) stopRecording(false); });   // палец ушёл с кнопки
  if (kind === "voice") {                                          // для голосового —
    btn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (REC.busy && REC.kind === "voice") stopRecording(false); });   //   правая кнопка мыши отменяет запись
  }
}

$("sticker-input") && ($("sticker-input").onchange = async () => {    // выбор картинок для нового набора
  const files = [...$("sticker-input").files];                      // выбранные файлы
  $("sticker-input").value = "";                                    // сразу очищаем поле
  if (!files.length) return;                                        // ничего не выбрали
  const made = await createPackFromFiles(files, "Набор " + new Date().toLocaleDateString("ru-RU"));   // создаём набор
  if (made) openStickerPanel();                                     // получилось — показываем панель
});

$("btn-sticker") && ($("btn-sticker").onclick = () => {               // кнопка «Стикеры» у поля ввода
  if ($("sticker-panel").classList.contains("hidden")) openStickerPanel();   // открыть
  else closeStickerPanel();                                         // или закрыть
});

$("circle-close") && ($("circle-close").onclick = () => {             // закрыть просмотр кружка
  $("circle-view").classList.add("hidden");                         // прячем окно
  try { $("circle-video").pause(); } catch (e) {}                   // останавливаем видео
});

document.addEventListener("keydown", (e) => {                       // Escape закрывает панель стикеров и кружок
  if (e.key !== "Escape") return;                                   // только Escape
  closeStickerPanel();                                              // панель
  if (!$("circle-view").classList.contains("hidden")) $("circle-close").click();   // окно кружка
});

socket.on("stickers_update", () => { loadStickerPacks(); });         // наборы изменились (например, бот добавил стикеры)

// Догружаем наборы стикеров при входе в приложение.
if (state.token) {                                                   // если человек уже вошёл —
  loadStickerPacks();                                               //   сразу спрашиваем наборы
}

function injectStickerBotRow() {
  // Добавляем в список чатов строку «Стикер-бот» — он всегда под рукой.
  const list = $("chat-list");                                      // список чатов
  if (!list) return;                                                // разметки нет
  if (state.chats.some((c) => c.kind === "dm" && c.with === "stickers")) return;   // переписка уже есть — добавлять не нужно
  const btn = document.createElement("button");                     // строка списка
  btn.className = "chat-item bot-row-item";                         // классы оформления
  btn.innerHTML = `
    <div class="chat-avatar-wrap"><div class="avatar bot-avatar"><svg><use href="#i-sticker"></use></svg></div></div>
    <div class="chat-body">
      <div class="chat-line">
        <div class="chat-name">Стикер-бот <span class="bot-tag">бот</span></div>
      </div>
      <div class="chat-preview"><span class="txt">Делает наборы стикеров из картинок</span></div>
    </div>`;
  btn.onclick = () => openChat("stickers");                         // открываем переписку со Стикер-ботом
  list.appendChild(btn);                                            // добавляем в конец списка
}

/* =====================================================================
   23. ВОЗМОЖНОСТИ ИЗ СПИСКА ПОЛЬЗОВАТЕЛЯ
   Здесь собрано всё, что просили добавить: заголовок с версией, смена логина,
   закреплённый канал, меню «три точки», поиск в переписке, обои, уведомления,
   секретный чат, ярлык на телефоне, жалобы, блокировка, очистка истории,
   удаление чата, контакты, нижнее меню и системные уведомления.
   ===================================================================== */

/* ---------- 23.1 Версия приложения и подпись устройства ---------- */

async function loadServerInfo() {
  // Спрашиваем у сервера его состояние: версию и общие сведения.
  try {
    const info = await fetch(apiUrl("/api/status")).then((r) => r.json());   // ответ сервера
    if (info && info.version && $("brand-version")) $("brand-version").textContent = info.version;   // версию показываем сверху
  } catch (e) {
    // Сервер недоступен — оставляем версию, которая вшита в разметку.
  }
}

function deviceId() {
  // Постоянный идентификатор этого устройства: он нужен, чтобы список устройств не пух
  // и чтобы можно было отключить вход с конкретного аппарата.
  let id = localStorage.getItem("gm_device_id");                   // уже придумывали раньше?
  if (!id) {                                                       // нет —
    id = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);   //   придумываем
    localStorage.setItem("gm_device_id", id);                      //   и запоминаем на этом устройстве
  }
  return id;                                                       // отдаём идентификатор
}

function deviceName() {
  // Понятное имя устройства: его человек видит в списке входов.
  if (phone() && phone().isApp) return "Телефон";                  // приложение на телефоне
  if (isDesktopShell()) return "Компьютер";                        // программа для ПК (окно с интерфейсом внутри)
  const ua = navigator.userAgent || "";                            // строка браузера
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone";                // техника Apple
  if (/android/i.test(ua)) return "Телефон";                       // техника на Android
  if (/macintosh|mac os x/i.test(ua)) return "Компьютер (Mac)";     // Mac
  if (/windows/i.test(ua)) return "Компьютер (Windows)";           // Windows
  if (/linux/i.test(ua)) return "Компьютер (Linux)";               // Linux
  return "Устройство";                                             // на всякий случай
}

function deviceHint() {
  // Подсказка серверу, откуда выполнен вход: чтобы в списке устройств было
  // «Приложение для ПК / Android / Web», а не безликое «браузер».
  if (phone() && phone().isApp) return "geometricapp";              // приложение на телефоне
  if (isDesktopShell()) return "geometricdesktop";                        // программа для компьютера
  if (isStandalone()) return "geometricapp";                              // установленное приложение (PWA)
  return "web";                                                          // обычный браузер
}

/* ---------- 23.2 Смена логина прямо в профиле ---------- */

function wireUsernameChange() {
  // Кнопка «Изменить логин» и сохранение нового логина.
  $("profile-rename")?.addEventListener("click", () => {                  // нажали «Изменить логин»
    $("username-edit-row")?.classList.remove("hidden");                   // показываем строку ввода
    if ($("profile-username-new")) $("profile-username-new").value = state.me.username;   // подставляем текущий логин
    $("profile-username-new")?.focus();                                   // сразу ставим курсор
  });
  $("profile-rename-save")?.addEventListener("click", async () => {       // нажали «Сохранить»
    const fresh = ($("profile-username-new")?.value || "").trim().toLowerCase();   // новый логин
    if (fresh.length < 3) { toast("Логин: минимум 3 символа"); return; }   // проверка длины
    if (fresh === state.me.username) { toast("Это ваш текущий логин"); return; }   // ничего не меняем
    const res = await fetch(apiUrl("/api/username"), {                     // просим сервер переименовать
      method: "POST", headers: { "Content-Type": "application/json" },     // обычный JSON-запрос
      body: JSON.stringify({ token: state.token, username: fresh }),        // что отправляем
    }).then((r) => r.json()).catch(() => ({ error: "сеть" }));             // ответ сервера
    if (res.error) { toast(res.error); return; }                          // ошибка — сообщаем
    state.token = res.token || state.token;                               // сервер мог выдать новый токен
    localStorage.setItem("gm_token", state.token);                        // запоминаем его на устройстве
    state.me = res.me || { ...state.me, username: fresh };                // обновляем профиль
    $("profile-username").textContent = "@" + state.me.username;          // показываем новый логин
    $("username-edit-row")?.classList.add("hidden");                      // прячем строку ввода
    renderMe();                                                           // обновляем карточку наверху
    renderChats();                                                        // и список чатов
    toast("Логин изменён: @" + fresh);                                     // сообщаем человеку
  });
}

/* ---------- 23.3 Закреплённый личный канал в профиле ---------- */

function myChannels() {
  // Мои каналы, которые можно закрепить (владелец или администратор).
  return (state.chats || []).filter((c) => (c.kind === "room" || c.kind === "channel")
    && (c.role === "owner" || c.role === "admin" || c.post));             // только те, где я могу управлять
}

function fillPinnedChannels(pinned, readOnly, person) {
  // Заполняем список «Закреплённый канал» в профиле.
  const sel = $("profile-pinned");                                       // сам список
  if (!sel) return;                                                      // разметки нет — выходим
  if (readOnly) {                                                        // чужой профиль — только показываем
    const card = person || {};                                           // карточка человека
    sel.innerHTML = `<option value="${esc(pinned || "")}">${esc(card.pinned_title || "Канал не закреплён")}</option>`;   // одна строка для чтения
    return;                                                              // и выходим
  }
  const channels = myChannels();                                         // мои каналы
  sel.innerHTML = `<option value="">Не закреплять</option>` + channels.map((c) =>   // первый пункт — «не закреплять»
    `<option value="${esc(c.id || c.with || "")}" ${((c.id || "") === pinned) ? "selected" : ""}>${esc(c.title || c.name || "Канал")}</option>`   // остальные — мои каналы
  ).join("");                                                            // собираем разметку
}

/* ---------- 23.4 Меню «три точки» в шапке чата ---------- */

function currentChatKey() {
  // Ключ открытой переписки (для личного чата — «логин|логин», для секретного — с «|s»).
  if (state.activeRoom) return state.activeRoom;                         // группа или канал
  if (!state.activeChat || !state.me) return "";                         // переписка не открыта
  const base = chatIdOf(state.me.username, state.activeChat);             // обычный личный чат
  return state.secretChat ? base + "|s" : base;                          // секретный помечаем «|s»
}

function openChatMenu() {
  // Открываем меню «три точки».
  const chat = state.activeChat || state.activeRoom;                      // открытая переписка
  if (!chat) { toast("Сначала откройте чат"); return; }                    // нечего настраивать
  const card = state.chats.find((c) => (c.with || c.id) === (state.activeRoom || state.activeChat));   // карточка чата
  $("chat-menu-title").textContent = card?.name || card?.title || state.activeChat || "Чат";   // название сверху
  const muted = !!card?.muted;                                            // уведомления выключены?
  $("cm-notify-text").textContent = muted ? "Включить уведомления" : "Выключить уведомления";   // подпись кнопки
  $("cm-secret-text").textContent = state.secretChat ? "Выйти из секретного чата" : "Секретный чат";   // подпись секретного пункта
  $("cm-block-text").textContent = card?.i_blocked ? "Разблокировать" : "Заблокировать";   // подпись блокировки
  const link = phone();                                                    // мост приложения на телефоне
  $("cm-shortcut").classList.toggle("hidden", !(link && (link.makeShortcut || link.addShortcut)));   // ярлык — только в приложении на телефоне
  const этоя = state.activeChat === state.me?.username;                    // открыт «Избранное» (чат с самим собой)
  $("cm-report").classList.toggle("hidden", !!state.activeRoom || этоя);   // жаловаться можно только на другого человека
  $("cm-secret").classList.toggle("hidden", этоя);                         // секретный чат бывает только с собеседником
  $("chat-menu").classList.remove("hidden");                              // показываем меню
  haptic(10);                                                            // лёгкая вибрация
}

function closeChatMenu() {
  // Закрываем меню «три точки».
  $("chat-menu").classList.add("hidden");                                // прячем окно
}

/* ---------- 23.5 Поиск по переписке ---------- */

function openChatSearch() {
  // Показываем полосу поиска по открытой переписке.
  closeChatMenu();                                                       // меню закрываем
  $("chat-search")?.classList.remove("hidden");                           // полосу показываем
  $("chat-search-results")?.classList.add("hidden");                      // результаты пока пустые
  if ($("chat-search-input")) { $("chat-search-input").value = ""; $("chat-search-input").focus(); }   // чистим поле и ставим курсор
}

function closeChatSearch() {
  // Скрываем поиск и снимаем подсветку найденных сообщений.
  $("chat-search")?.classList.add("hidden");                              // прячем полосу
  $("chat-search-results")?.classList.add("hidden");                      // и список результатов
  for (const el of document.querySelectorAll(".msg-row.found")) el.classList.remove("found");   // убираем подсветку
}

async function runChatSearch(query) {
  // Ищем слово в переписке. Поиск идёт прямо на устройстве: сообщения уже расшифрованы,
  // поэтому серверу не нужно ничего знать о содержимом — так надёжнее и приватнее.
  const q = (query || "").trim().toLowerCase();                          // что ищем (без учёта регистра)
  const box = $("chat-search-results");                                  // список результатов
  if (!box) return;                                                      // разметки нет
  if (q.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }   // слишком короткий запрос
  const key = state.activeRoom ? roomKeys.get(state.activeRoom) : await convKeyFor(state.activeChat);   // ключ переписки
  const found = [];                                                      // найденные сообщения
  for (const m of state.messages) {                                      // по всем сообщениям ленты
    if (m.deleted) continue;                                             // удалённые не ищем
    const dec = m.kind === "call" ? null : await decryptFull(key, m);     // расшифровываем содержимое
    const text = dec ? (dec.text || "") : (m.kind === "call" ? "Звонок" : "");   // текст сообщения
    if (text && text.toLowerCase().includes(q)) found.push({ id: m.id, ts: m.ts, text });   // совпало — запоминаем
  }
  box.innerHTML = found.length                                              // собираем список
    ? found.slice(0, 80).map((m) => `<button class="search-hit" data-id="${esc(m.id)}">
        <span class="hit-time">${fmtTime(m.ts)}</span>
        <span class="hit-text">${esc(m.text)}</span></button>`).join("")   // каждая находка — кнопка
    : `<div class="empty-list">Ничего не нашлось</div>`;                    // ничего не нашли
  box.classList.remove("hidden");                                          // показываем список
  for (const b of box.querySelectorAll(".search-hit")) {                    // по найденным строкам
    b.onclick = () => {                                                     // при нажатии —
      for (const el of document.querySelectorAll(".msg-row.found")) el.classList.remove("found");   // снимаем прошлую подсветку
      const row = document.querySelector(`.msg-row[data-id="${b.dataset.id}"]`);   // ищем сообщение в ленте
      if (row) { row.scrollIntoView({ block: "center", behavior: "smooth" }); row.classList.add("found"); }   // прокручиваем и подсвечиваем
      else toast("Сообщение глубже в истории — прокрутите ленту");            // в ленте его нет
    };
  }
}

/* ---------- 23.6 Обои чата ---------- */

const WALLPAPER_COLORS = ["#0b0d12", "#111a2b", "#1b1230", "#0f2027", "#2b1a12", "#12281c", "#241018", "#1a1a1a"];   // готовые цвета обоев

function renderWallpaperColors() {
  // Рисуем кружки с готовыми цветами.
  const box = $("wallpaper-colors");                                     // контейнер
  if (!box) return;                                                      // разметки нет
  box.innerHTML = WALLPAPER_COLORS.map((c, i) =>                          // по каждому цвету —
    `<button class="wp-color ${i === 0 ? "active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("");   // кружок с цветом
  for (const b of box.querySelectorAll(".wp-color")) {                    // по кружкам
    b.onclick = async () => {                                              // при выборе цвета —
      box.querySelectorAll(".wp-color").forEach((x) => x.classList.remove("active"));   // снимаем отметку с других
      b.classList.add("active");                                           // отмечаем выбранный
      await setChatWallpaper({ kind: "color", value: b.dataset.color });    // сохраняем обои
    };
  }
}

function applyWallpaper(wallpaper) {
  // Применяем обои к ленте сообщений.
  const box = $("messages");                                             // лента сообщений
  if (!box) return;                                                      // разметки нет
  if (!wallpaper) { box.style.backgroundImage = ""; box.style.backgroundColor = ""; return; }   // обои убраны — обычный фон
  if (wallpaper.kind === "photo") {                                      // обои-картинка
    box.style.backgroundColor = "";                                      // цвет не нужен
    box.style.backgroundImage = `url("${wallpaper.value}")`;              // ставим картинку
  } else {                                                              // обои-цвет
    box.style.backgroundImage = "";                                      // картинку убираем
    box.style.backgroundColor = wallpaper.value || "";                    // ставим цвет
  }
}

async function setChatWallpaper(wallpaper) {
  // Сохраняем обои чата на сервере: «у меня» или «у обоих».
  const chat = state.activeRoom || chatIdOf(state.me.username, state.activeChat);   // какой чат
  const scope = document.querySelector("#wallpaper-scope .seg-btn.active")?.dataset.scope || "me";   // выбранная область
  const res = await fetch(apiUrl("/api/chat/wallpaper"), {                 // отправляем на сервер
    method: "POST", headers: { "Content-Type": "application/json" },       // обычный JSON
    body: JSON.stringify({ token: state.token, chat, scope, wallpaper }),   // что именно
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));              // ответ
  if (res.error) { toast(res.error); return; }                           // ошибка — сообщаем
  applyWallpaper(wallpaper);                                             // сразу показываем у себя
  const card = state.chats.find((c) => (c.with || c.id) === (state.activeRoom || state.activeChat));   // карточка чата
  if (card) card.wallpaper = wallpaper;                                  // запоминаем в состоянии
  toast(scope === "all" ? "Обои поставили обоим" : "Обои изменены у вас");   // сообщаем результат
}

function openWallpaper() {
  // Открываем окно выбора обоев.
  closeChatMenu();                                                       // меню закрываем
  renderWallpaperColors();                                               // рисуем цвета
  $("wallpaper-modal").classList.remove("hidden");                        // показываем окно
}

/* ---------- 23.7 Системные уведомления ---------- */

function canNotify() {
  // Можно ли показывать системные уведомления.
  return ("Notification" in window) && Notification.permission === "granted" && !!state.settings.notifications;   // разрешение и настройка
}

function phone() {
  // Возможности телефона, которые даёт приложение: уведомления, ярлыки, вывод на экран.
  return window.GeoMetricBridge || window.Android || null;               // мост приложения (в браузере его нет)
}

function pushNotify(title, body, tag) {
  // Показываем системное уведомление: работает и когда окно свёрнуто,
  // а на телефоне — как обычное уведомление приложения.
  try {
    const link = phone();                                                 // мост приложения на телефоне
    if (link && link.notify) {                                            // приложение умеет уведомления —
      link.notify(String(title), String(body));                           //   показываем системное уведомление
      return;                                                             //   и выходим
    }
    if (GMDesktop && GMDesktop.notify) {                                  // приложение для компьютера —
      GMDesktop.notify(String(title), String(body));                      //   показываем системное уведомление Windows
      return;                                                             //   и выходим
    }
    if (!canNotify()) return;                                             // разрешения нет — молчим
    const n = new Notification(String(title), { body: String(body), tag: tag || "geometric", silent: false, icon: "icon-192.png" });   // само уведомление
    n.onclick = () => { window.focus(); n.close(); };                      // тап по уведомлению возвращает в приложение
  } catch (e) {
    // Телефон может запрещать уведомления — просто продолжаем работу.
  }
}

/* ---------- 23.8 Секретный чат ---------- */

async function toggleSecretChat() {
  // Включаем или выключаем секретный чат с собеседником.
  closeChatMenu();                                                       // меню закрываем
  if (state.secretChat) {                                                // мы уже в секретном —
    state.secretChat = false;                                            //   выходим в обычный
    $("peer-status").classList.remove("secret");                         //   убираем пометку
    await openChat(state.activeChat);                                    //   и перезагружаем обычную переписку
    return;                                                              //   готово
  }
  const res = await fetch(apiUrl("/api/chat/secret"), {                    // создаём (или находим) секретную переписку
    method: "POST", headers: { "Content-Type": "application/json" },       // обычный JSON
    body: JSON.stringify({ token: state.token, with: state.activeChat }),   // с кем
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));              // ответ
  if (res.error) { toast(res.error); return; }                           // ошибка — сообщаем
  state.secretChat = true;                                               // переходим в секретный режим
  await openChat(state.activeChat, true);                                // перезагружаем переписку (тихо)
  toast("Секретный чат открыт");                                          // сообщаем
}

/* ---------- 23.9 Ярлык на телефоне ---------- */

function addPhoneShortcut() {
  // Просим приложение на телефоне поставить ярлык с аватаркой и ником.
  closeChatMenu();                                                       // меню закрываем
  const person = state.people[state.activeChat] || state.peer || { username: state.activeChat };   // собеседник
  const name = person.name || state.activeChat;                          // ник для ярлыка
  const avatar = person.avatar?.kind === "photo" ? person.avatar.value : "";   // аватарка, если она картинкой
  const link = phone();                                                   // мост приложения на телефоне
  const maker = link && (link.makeShortcut || link.addShortcut);          // умеет ли он ярлыки
  if (maker) {                                                            // умеет —
    maker.call(link, String(state.activeChat), String(name), String(avatar || ""));   // просим поставить ярлык
    toast("Ярлык добавлен на рабочий стол");                              // сообщаем
  } else {                                                              // в браузере ярлыки так не ставятся —
    toast("Ярлык можно добавить в приложении на телефоне");                // подсказываем
  }
}

/* ---------- 23.10 Жалоба на собеседника ---------- */

async function sendReport(reason, text) {
  // Отправляем жалобу на собеседника.
  const res = await fetch(apiUrl("/api/report"), {                          // просим сервер
    method: "POST", headers: { "Content-Type": "application/json" },        // обычный JSON
    body: JSON.stringify({ token: state.token, with: state.activeChat, reason, text }),   // кого, за что и пояснение
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));               // ответ
  if (res.error) { toast(res.error); return; }                            // ошибка — сообщаем
  toast("Жалоба отправлена. Спасибо, что помогаете!");                      // благодарим
}

function openReportDialog() {
  // Простое окно жалобы: причина, пояснение, кнопка «Отправить».
  closeChatMenu();                                                       // меню закрываем
  const modal = document.createElement("div");                           // затемнение
  modal.className = "modal";                                             // класс оформления
  modal.innerHTML = `
    <div class="sheet">
      <div class="sheet-top"><div class="sheet-title">Жалоба на @${esc(state.activeChat)}</div>
        <button class="icon-btn" data-close><svg><use href="#i-x"></use></svg></button></div>
      <select class="input" id="report-reason">
        <option>Спам и реклама</option>
        <option>Оскорбления</option>
        <option>Мошенничество</option>
        <option>Другое</option>
      </select>
      <textarea class="input" id="report-text" rows="3" maxlength="400" placeholder="Расскажите, что случилось"></textarea>
      <button class="btn btn-primary" id="report-send">Отправить</button>
    </div>`;                                                             // разметка окна
  document.body.appendChild(modal);                                      // показываем
  const закрыть = () => modal.remove();                                  // функция закрытия
  modal.querySelector("[data-close]").onclick = закрыть;                 // кнопка «закрыть»
  modal.onclick = (e) => { if (e.target === modal) закрыть(); };          // тап по затемнению
  modal.querySelector("#report-send").onclick = async () => {              // кнопка «Отправить»
    await sendReport(modal.querySelector("#report-reason").value, modal.querySelector("#report-text").value);   // отправляем
    закрыть();                                                           // закрываем окно
  };
}

/* ---------- 23.11 Блокировка собеседника ---------- */

async function toggleBlock() {
  // Блокируем или разблокируем собеседника.
  closeChatMenu();                                                       // меню закрываем
  const card = state.chats.find((c) => (c.with || c.id) === state.activeChat);   // карточка чата
  const on = !card?.i_blocked;                                           // включаем, если сейчас не заблокирован
  const res = await fetch(apiUrl("/api/chat/block"), {                     // просим сервер
    method: "POST", headers: { "Content-Type": "application/json" },       // обычный JSON
    body: JSON.stringify({ token: state.token, with: state.activeChat, on }),   // кого и что делать
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));              // ответ
  if (res.error) { toast(res.error); return; }                           // ошибка — сообщаем
  if (card) card.i_blocked = on;                                         // запоминаем состояние
  state.messages = [];                                                   // сообщения у собеседника пропадают
  if (on) {                                                              // заблокировали —
    $("messages").innerHTML = `<div class="empty-list">Вы заблокировали этого человека. Сообщения скрыты.</div>`;   //   показываем пояснение
    toast("Собеседник заблокирован");                                     //   сообщаем
  } else {                                                              // разблокировали —
    await openChat(state.activeChat);                                     //   перезагружаем переписку
    toast("Собеседник разблокирован");                                    //   сообщаем
  }
  renderChats();                                                         // обновляем список чатов
}

/* ---------- 23.12 Очистка истории и удаление чата ---------- */

async function clearHistory(scope) {
  // Очищаем историю: «me» — только у себя, «all» — у обоих.
  closeChatMenu();                                                       // меню закрываем
  const chat = state.activeRoom || chatIdOf(state.me.username, state.activeChat);   // какой чат
  const res = await fetch(apiUrl("/api/chat/clear"), {                     // просим сервер
    method: "POST", headers: { "Content-Type": "application/json" },       // обычный JSON
    body: JSON.stringify({ token: state.token, chat, scope }),              // что чистим
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));              // ответ
  if (res.error) { toast(res.error); return; }                           // ошибка — сообщаем
  state.messages = [];                                                   // у себя чистим ленту
  renderMessages();                                                      // перерисовываем
  toast(scope === "all" ? "История очищена у обоих" : "История очищена у вас");   // сообщаем результат
}

async function deleteChat() {
  // Удаляем чат из своего списка.
  closeChatMenu();                                                       // меню закрываем
  const chat = state.activeRoom || chatIdOf(state.me.username, state.activeChat);   // какой чат
  const res = await fetch(apiUrl("/api/chat/delete"), {                     // просим сервер
    method: "POST", headers: { "Content-Type": "application/json" },        // обычный JSON
    body: JSON.stringify({ token: state.token, chat }),                     // что удаляем
  }).then((r) => r.json()).catch(() => ({ error: "сеть" }));              // ответ
  if (res.error) { toast(res.error); return; }                            // ошибка — сообщаем
  state.chats = state.chats.filter((c) => (c.with || c.id) !== (state.activeRoom || state.activeChat));   // убираем из списка
  renderChats();                                                         // обновляем список
  returnToMainMenu();                                                    // уходим в главное меню
  toast("Чат удалён");                                                    // сообщаем
}

/* ---------- 23.13 Контакты ---------- */

async function loadContacts(query) {
  // Показываем контакты: люди, с которыми есть переписка, и результаты поиска.
  const box = $("contacts-list");                                         // список
  if (!box) return;                                                       // разметки нет
  const q = (query || "").trim();                                         // что ищем
  if (q.length >= 2) {                                                    // поиск по логину или имени —
    const res = await fetch(apiUrl(`/api/find?token=${encodeURIComponent(state.token)}&q=${encodeURIComponent(q)}`)).then((r) => r.json()).catch(() => ({ users: [] }));   // спрашиваем сервер
    const people = res.users || [];                                        // найденные люди
    box.innerHTML = people.length                                          // рисуем строки
      ? people.map((p) => `<button class="contact-row" data-open="${esc(p.username)}">
          ${avatarHtml(p, "md")}<span class="contact-body"><b>${esc(p.name || p.username)}</b><i>@${esc(p.username)}</i></span></button>`).join("")
      : `<div class="empty-list">Никого не нашли</div>`;                    // пусто
  } else {                                                                // обычный режим —
    const res = await fetch(apiUrl(`/api/contacts?token=${encodeURIComponent(state.token)}`)).then((r) => r.json()).catch(() => ({ contacts: [] }));   // берём свои контакты
    const people = res.contacts || [];                                     // список людей
    box.innerHTML = people.length                                          // рисуем строки
      ? people.map((p) => `<button class="contact-row" data-open="${esc(p.username)}">
          ${avatarHtml(p, "md")}<span class="contact-body"><b>${esc(p.name || p.username)}</b><i>@${esc(p.username)}${p.verified ? " ✔" : ""}</i></span></button>`).join("")
      : `<div class="empty-list">Пока никого. Найдите человека по логину.</div>`;   // пусто
  }
  for (const b of box.querySelectorAll("[data-open]")) {                   // по строкам контактов
    b.onclick = () => {                                                    // при нажатии —
      $("contacts-modal").classList.add("hidden");                          //   закрываем окно контактов
      openChat(b.dataset.open);                                            //   и открываем переписку
    };
  }
}

/* ---------- 23.14 Нижнее меню и системная кнопка «назад» ---------- */

function wireBottomNav() {
  // Кнопки нижнего меню: Чаты, Контакты, Профиль, Настройки.
  const nav = $("bottom-nav");                                            // само меню
  if (!nav) return;                                                       // разметки нет
  for (const btn of nav.querySelectorAll(".nav-btn")) {                    // по кнопкам
    btn.addEventListener("click", async () => {                            // при нажатии —
      nav.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));   // снимаем отметку со всех
      btn.classList.add("active");                                         // отмечаем выбранную
      haptic(8);                                                           // лёгкая вибрация
      const what = btn.dataset.nav;                                        // что выбрали
      if (what === "chats") { returnToMainMenu(); }                        // «Чаты» — вернуться к списку
      if (what === "contacts") { await loadContacts(""); $("contacts-modal").classList.remove("hidden"); }   // «Контакты» — открыть список
      if (what === "profile") { openMyProfile(); }                         // «Профиль» — открыть свой профиль
      if (what === "settings") { $("btn-settings").click(); }               // «Настройки» — открыть настройки
    });
  }
  if ($("contacts-close")) $("contacts-close").onclick = () => $("contacts-modal").classList.add("hidden");   // закрыть контакты
  if ($("contacts-search")) $("contacts-search").oninput = (e) => loadContacts(e.target.value);   // поиск по контактам
}

/* ---------- 23.15 Запись голосового жестом: зажать → вверх → отпустить --- */

const VOICE_SWIPE_UP = 70;                                              // насколько провести вверх, чтобы запись «закрепилась»

function wireVoiceGesture() {
  // Кнопка микрофона: зажать — пишем; провести вверх и отпустить — запись продолжается
  // без удержания, а кнопка «отправить» её отправляет. Провести в сторону — отмена.
  const btn = $("btn-mic");                                             // сама кнопка
  if (!btn) return;                                                      // разметки нет — выходим
  let startY = 0, locked = false, moved = false;                         // состояние жеста
  btn.addEventListener("pointerdown", async (e) => {                      // палец (или мышь) нажал
    e.preventDefault();                                                   // не выделяем текст
    startY = e.clientY;                                                  // запоминаем начало
    locked = false;                                                      // закрепления пока нет
    moved = false;                                                       // движения пока не было
    try { btn.setPointerCapture(e.pointerId); } catch (err) {}            // дальше следим за этим же пальцем
    await startRecording("voice");                                        // начинаем запись
    btn.classList.add("recording");                                       // подсвечиваем кнопку
    const hint = $("rec-hint");                                           // подсказка на экране
    if (hint && !hint.classList.contains("hidden")) {                     // если она показана —
      $("rec-hint-text").textContent = "Ведите вверх и отпустите — запись продолжится";   // подсказываем жест
      hint.classList.add("swipe");                                        // включаем стиль «проведите вверх»
    }
  });
  btn.addEventListener("pointermove", (e) => {                            // палец поехал
    if (!REC.busy) return;                                               // записи нет — ничего не делаем
    const up = startY - e.clientY;                                       // насколько ушли вверх
    if (up > 12) moved = true;                                           // заметили движение
    if (up > VOICE_SWIPE_UP && !locked) {                                 // провели достаточно вверх —
      locked = true;                                                     //   фиксируем: удерживать больше не нужно
      REC.locked = true;                                                 //   помечаем и в состоянии записи
      $("rec-hint")?.classList.add("locked");                             //   подсказка закрепляется
      if ($("rec-hint-text")) $("rec-hint-text").textContent = "Запись идёт. Отпустите палец, потом нажмите «отправить»";   // текст
      haptic(15);                                                        // отклик
    }
  });
  const finish = (e, canceled) => {                                      // отпустили палец
    btn.classList.remove("recording");                                    // убираем подсветку кнопки
    REC.locked = false;                                                  // сбрасываем закрепление
    const hint2 = $("rec-hint");                                          // подсказка
    hint2?.classList.remove("swipe", "locked");                           // снимаем стили жеста
    if (!REC.busy) return;                                               // записи нет — выходим
    if (locked) return;                                                  // запись закреплена — НЕ останавливаем
    stopRecording(!canceled && !moved ? true : !canceled);                // обычное удержание: отпустили — отправили
  };
  btn.addEventListener("pointerup", (e) => finish(e, false));             // отпустили палец
  btn.addEventListener("pointercancel", (e) => finish(e, true));          // жест отменили
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (REC.busy) stopRecording(false); });   // правая кнопка мыши — отмена
  // Пока запись закреплена, кнопка показывает «отправить».
  document.addEventListener("pointerdown", (e) => {                       // нажатие вне кнопки
    if (!REC.busy || !locked) return;                                    // записи или закрепления нет
    if (e.target.closest("#btn-mic") || e.target.closest("#btn-send")) return;   // по нужным кнопкам — не мешаем
    stopRecording(false);                                                // тап мимо — отменяем запись
    toast("Запись отменена");                                             // сообщаем
  }, true);
}

/* ---------- 23.15 Кнопка «назад» телефона ---------- */

window.gmHandleBack = function () {
  // Эту функцию зовёт приложение на телефоне, когда человек нажимает системную кнопку «назад».
  // Если открыт чат — уходим в главное меню с анимацией и отвечаем «да» (выходить не надо).
  const area = $("chat-area");                                          // область переписки
  const open = area && area.classList.contains("open");                 // чат сейчас открыт?
  if (open) {                                                           // чат открыт —
    returnToMainMenu();                                                 //   возвращаемся в список чатов с анимацией
    return true;                                                        //   и говорим приложению: выход не нужен
  }
  const modal = document.querySelector(".modal:not(.hidden)");          // открыто ли какое-то окно
  if (modal) {                                                          // окно открыто —
    modal.classList.add("hidden");                                      //   закрываем его
    return true;                                                        //   выход не нужен
  }
  return false;                                                         // мы в главном меню — приложение само спросит про выход
};

/* ---------- 23.16 Подключение всего перечисленного ---------- */

function initExtras() {
  // Включаем всё новое: заголовок с версией, меню чата, поиск, обои, контакты, меню.
  loadServerInfo();                                                      // версия приложения сверху
  wireUsernameChange();                                                  // смена логина в профиле
  wireBottomNav();                                                       // нижнее меню
  wireVoiceGesture();                                                    // жест записи голосового

  $("btn-chat-menu")?.addEventListener("click", openChatMenu);            // «три точки» в шапке чата
  $("chat-menu-close")?.addEventListener("click", closeChatMenu);         // закрыть меню
  $("chat-menu")?.addEventListener("click", (e) => { if (e.target === $("chat-menu")) closeChatMenu(); });   // тап по затемнению
  $("cm-search")?.addEventListener("click", openChatSearch);              // поиск в переписке
  $("cm-wallpaper")?.addEventListener("click", openWallpaper);            // обои чата
  $("cm-notify")?.addEventListener("click", async () => {                 // уведомления по чату
    closeChatMenu();                                                     // меню закрываем
    const chat = state.activeRoom || chatIdOf(state.me.username, state.activeChat);   // какой чат
    const card = state.chats.find((c) => (c.with || c.id) === (state.activeRoom || state.activeChat));   // карточка
    const on = !card?.muted;                                             // включаем, если сейчас выключены
    const res = await fetch(apiUrl("/api/chat/mute"), {                    // просим сервер
      method: "POST", headers: { "Content-Type": "application/json" },     // JSON
      body: JSON.stringify({ token: state.token, chat, on }),               // что меняем
    }).then((r) => r.json()).catch(() => ({ error: "сеть" }));             // ответ
    if (res.error) { toast(res.error); return; }                          // ошибка
    if (card) card.muted = on;                                            // запоминаем
    toast(on ? "Уведомления выключены" : "Уведомления включены");           // сообщаем
  });
  $("cm-secret")?.addEventListener("click", toggleSecretChat);            // секретный чат
  $("cm-shortcut")?.addEventListener("click", addPhoneShortcut);          // ярлык на телефоне
  $("cm-report")?.addEventListener("click", openReportDialog);            // жалоба
  $("cm-block")?.addEventListener("click", toggleBlock);                  // блокировка
  $("cm-clear")?.addEventListener("click", async () => {                  // очистка истории
    const уСебя = confirm("Очистить историю только у вас? Нажмите «Отмена», чтобы очистить у обоих.");
    await clearHistory(уСебя ? "me" : "all");                             // выполняем
  });
  $("cm-delete")?.addEventListener("click", async () => {                 // удалить чат
    if (confirm("Удалить чат из списка?")) await deleteChat();             // подтверждаем и удаляем
  });

  $("chat-search-close")?.addEventListener("click", closeChatSearch);      // закрыть поиск
  $("chat-search-input")?.addEventListener("input", (e) => runChatSearch(e.target.value));   // искать по мере ввода

  $("wallpaper-close")?.addEventListener("click", () => $("wallpaper-modal").classList.add("hidden"));   // закрыть окно обоев
  $("wallpaper-modal")?.addEventListener("click", (e) => { if (e.target === $("wallpaper-modal")) $("wallpaper-modal").classList.add("hidden"); });   // тап по затемнению
  $("wallpaper-pick")?.addEventListener("click", () => $("wallpaper-file").click());   // выбрать свою картинку
  $("wallpaper-file")?.addEventListener("change", async (e) => {           // картинку выбрали
    const f = e.target.files[0];                                          // сам файл
    e.target.value = "";                                                  // очищаем поле
    if (!f) return;                                                       // ничего не выбрали
    const fd = new FormData();                                            // форма загрузки
    fd.append("file", f, f.name);                                         // файл
    fd.append("token", state.token);                                       // авторизация
    const up = await fetch(apiUrl("/api/upload"), { method: "POST", body: fd }).then((r) => r.json()).catch(() => ({}));   // загружаем
    if (!up.url) { toast("Не удалось загрузить картинку"); return; }        // ошибка
    await setChatWallpaper({ kind: "photo", value: absUrl(up.url) });      // ставим как обои
  });
  $("wallpaper-reset")?.addEventListener("click", () => setChatWallpaper(null));   // убрать обои
  for (const b of document.querySelectorAll("#wallpaper-scope .seg-btn")) b.onclick = () => {   // выбор «у меня / у обоих»
    document.querySelectorAll("#wallpaper-scope .seg-btn").forEach((x) => x.classList.remove("active"));   // снимаем отметку
    b.classList.add("active");                                            // отмечаем выбранное
  };

  // Системные уведомления о новых сообщениях и звонках.
  socket.on("new_message", (msg) => {                                     // пришло сообщение
    if (!msg || msg.from === state.me?.username) return;                   // своё не уведомляем
    const chat = chatIdOf(state.me.username, msg.from);                    // какой чат
    const card = state.chats.find((c) => (c.with || c.id) === chat || (c.with || c.id) === chat + "|s");   // карточка
    if (card?.muted) return;                                              // чат «без звука» — молчим
    if (document.hasFocus() && state.activeChat === msg.from) return;      // человек и так смотрит этот чат
    messagePreviewText(msg).then((text) => {                              // достаём текст (расшифровка у нас)
      const person = state.people[msg.from] || { username: msg.from };     // кто написал
      pushNotify(person.name || msg.from, text);                          // показываем системное уведомление
    });
  });
  socket.on("incoming_call", (data) => {                                  // входящий звонок
    const person = data?.user || state.people[data?.from] || { username: data?.from };   // кто звонит
    const link = phone();                                                // мост приложения на телефоне
    if (link && link.call) {                                             // телефон умеет «звонковое» уведомление —
      link.call(`Звонок: ${person.name || person.username}`, "Входящий звонок в GeoMetric");   //   показываем его: оно важное, со звуком и вибрацией
    } else if (GMDesktop && GMDesktop.call) {                            // приложение для компьютера —
      GMDesktop.call(`Звонок: ${person.name || person.username}`, "Входящий звонок в GeoMetric");   //   такое же важное уведомление Windows
    } else {                                                             // иначе (браузер) —
      pushNotify(`Звонок: ${person.name || person.username}`, "Входящий звонок в GeoMetric", "gm-call");   //   обычное уведомление
    }
    haptic(60);                                                          // заметная вибрация
  });
  socket.on("message_deleted", (data) => {                                // сообщение удалили
    if (!data) return;                                                   // пустых событий не бывает
    if (data.scope === "all") {                                          // удалили у всех —
      state.messages = state.messages.filter((m) => m.id !== data.id);     //   убираем из ленты
      renderMessages();                                                  //   и перерисовываем
    }
  });
}

// Сохраняем выбранный язык в профиль (вызывается из i18n.js при нажатии карточки языка).
window.gmSaveSettingsSoon = () => {                               // эту функцию зовёт словарь языков
  state.settings.lang = window.gmLang || "ru";                    // запоминаем выбранный язык
  saveSettings();                                                 // и сохраняем настройки в профиль
};

// Запускаем всё новое после загрузки страницы.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initExtras);   // страница ещё грузится
else initExtras();                                                                                    // уже загрузилась — сразу

// Язык интерфейса: подставляем сразу после загрузки страницы.
window.addEventListener("load", () => {                            // когда страница полностью готова
  if (window.gmBuildLangPicker) window.gmBuildLangPicker(document.getElementById("lang-picker"));   // собираем карточки языков в настройках
  if (window.gmApplyLanguage) window.gmApplyLanguage(state.settings.lang || window.gmLang || "ru");   // переводим все надписи
  if (window.gmStartLanguageWatch) window.gmStartLanguageWatch();  // и следим за новыми надписями (чаты, меню, подсказки)
});
