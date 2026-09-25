/* =========================================================================
   GeoMetric 2.0 — логика приложения.
   -------------------------------------------------------------------------
   Что здесь происходит:
     1) Вход и регистрация вместе с генерацией ключей шифрования.
     2) Переписка: шифрование на устройстве, расшифровка при показе.
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

function apiUrl(path) {                                            // собирает полный адрес запроса к серверу
  return API_BASE + path;                                          // например, https://messenger.ru + /api/login
}

function absUrl(u) {                                               // делает ссылки с сервера полными
  if (!u) return u;                                                // пустое значение — нечего преобразовывать
  return /^https?:/i.test(u) ? u : apiUrl(u);                      // http(s) уже полный, иначе добавляем адрес сервера
}

function setServer(address) {                                      // сохраняет адрес сервера и перезапускает приложение
  localStorage.setItem(SERVER_KEY, address.trim().replace(/\/+$/, ""));   // запоминаем адрес без лишнего слэша
  location.reload();                                               // перезагружаем — приложение подключится к новому серверу
}

function showServerScreen(prefill) {                               // показывает экран «адрес сервера»
  hideSplash();                                                    // убираем заставку запуска
  $("server-screen").classList.remove("hidden");                   // показываем экран подключения
  $("auth-screen").classList.add("hidden");                        // прячем экран входа
  $("app").classList.add("hidden");                                // и сам мессенджер
  $("server-input").value = prefill || API_BASE || "";             // подставляем текущий адрес (если он есть)
  $("server-error").textContent = "";                              // очищаем прошлое сообщение об ошибке
}

$("server-connect").onclick = async () => {                        // нажатие «Подключиться»
  const raw = $("server-input").value.trim();                      // что ввёл человек
  const btn = $("server-connect");                                 // кнопка (её заблокируем на время проверки)
  if (!raw) { $("server-error").textContent = "Введите адрес сервера"; return; }   // пусто — подсказываем
  const addr = (/^https?:\/\//i.test(raw) ? raw : "https://" + raw).replace(/\/+$/, "");   // добавляем https:// и убираем слэш
  btn.disabled = true;                                             // блокируем кнопку
  btn.textContent = "Проверяю сервер…";                            // и показываем, что идёт проверка
  try {
    const res = await fetch(addr + "/api/status", { cache: "no-store" });   // спрашиваем у сервера «ты GeoMetric?»
    const info = await res.json();                                 // читаем ответ
    if (!res.ok || !info.geometric) throw new Error(info.error || "Это не сервер GeoMetric");   // это чужой сервер
    localStorage.setItem("gm_insecure_ok", "1");                   // запоминаем, что сервер проверен
    setServer(addr);                                               // сохраняем адрес и перезапускаем приложение
  } catch (e) {                                                    // сервер не ответил
    $("server-error").textContent = "Не удалось подключиться: " + e.message +
      ". Проверьте адрес и что сервер запущен.";                    // объясняем причину
    btn.disabled = false;                                          // возвращаем кнопку в рабочее состояние
    btn.textContent = "Подключиться";                              // и её подпись
  }
};

$("server-input").addEventListener("keydown", (e) => {             // удобство: Enter подключает
  if (e.key === "Enter") $("server-connect").click();              // нажали Enter — как будто нажали кнопку
});

$("server-demo").onclick = () => {                                 // кнопка демонстрационного сервера
  $("server-input").value = "https://5952e08b4c4846.lhr.life";     // подставляем демо-адрес
  $("server-hint").innerHTML = "Это временный демонстрационный сервер — он работает, пока идёт наша сессия. " +
    "Для постоянной работы поднимите свой сервер (инструкция в README, раздел про сервер).";  // предупреждаем
};


const previewCache = new Map();   // id сообщения -> расшифрованный текст превью
const mediaCache = new Map();     // URL шифрованного файла -> ссылка на расшифрованный blob

/* ===================== 3. ТЕМА ОФОРМЛЕНИЯ ===================== */
function applyTheme(theme) {
  // Меняет тему: переписывает атрибут data-theme у <html> (стили реагируют через CSS-переменные).
  theme = theme || "dark";
  localStorage.setItem("gm_theme", theme);                          // запоминаем выбор (чтобы не мигало при запуске)
  document.documentElement.setAttribute("data-theme", theme);
  // Плюс обновляем цвет статус-бара в мобильном приложении.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f6f7fb" : theme === "amoled" ? "#000000" : "#0b0d12");
  // Подсвечиваем выбранную карточку в настройках.
  document.querySelectorAll("#theme-picker .theme-card").forEach((b) =>
    b.classList.toggle("active", b.dataset.themeValue === theme));
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
  const pub = await peerPublicKey(username);
  if (!pub || !state.privJwk) return null;
  // Проверяем отпечаток ключа собеседника: если он изменился — предупреждаем (возможен перехват).
  const fp = await fingerprint(pub);
  const known = state.peerFingerprints[username];
  if (known && known !== fp) {
    toast(`⚠️ Ключ шифрования пользователя ${username} изменился`, 6000);
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
    err("Для работы шифрования откройте приложение через https:// или localhost");
    return;
  }
  try {
    if (authMode === "register") {
      // ---------- РЕГИСТРАЦИЯ ----------
      const name = $("field-name").value.trim() || username;
      if (password !== $("field-password2").value) { err("Пароли не совпадают"); return; }
      if (password.length < 6) { err("Пароль: минимум 6 символов"); return; }
      err("Готовлю ключи шифрования…");
      const { pubJwk, privJwk } = await generateIdentity();         // создаём пару ключей ECDH
      const { kek, saltB64 } = await deriveKEK(password);           // ключ из пароля
      const encPriv = await wrapPrivateKey(privJwk, kek);           // шифруем приватный ключ паролем
      const res = await fetch(apiUrl("/api/register"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, name, pub: pubJwk, encPriv, kekSalt: saltB64 }),
      });
      const data = await res.json();
      if (!res.ok) { err(data.error || "Не удалось зарегистрироваться"); return; }
      localStorage.setItem("gm_token", data.token);
      state.token = data.token; state.me = data.me;
      storeIdentity(privJwk, true);                                 // ключ храним в памяти и на устройстве
      err("");
      socket.emit("auth", { token: state.token });                  // входим в сеть
      toast("Аккаунт создан. Сохраните пароль — без него историю не восстановить");
    } else {
      // ---------- ВХОД ----------
      const res = await fetch(apiUrl("/api/login"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { err(data.error || "Не удалось войти"); return; }
      localStorage.setItem("gm_token", data.token);
      state.token = data.token; state.me = data.me;
      err("Расшифровываю ключ…");
      const { kek } = await deriveKEK(password, data.keys.kekSalt); // тот же ключ из пароля
      const privJwk = await unwrapPrivateKey(data.keys.encPriv, kek);   // расшифровываем приватный ключ
      storeIdentity(privJwk, true);
      err("");
      socket.emit("auth", { token: state.token });
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
  err("Расшифровываю…");
  try {
    const res = await fetch(apiUrl("/api/keys?token=" + encodeURIComponent(state.token)));
    const keys = await res.json();
    if (!keys.encPriv) { err("На сервере нет ключей для этого аккаунта"); return; }
    const { kek } = await deriveKEK(password, keys.kekSalt);
    const privJwk = await unwrapPrivateKey(keys.encPriv, kek);
    storeIdentity(privJwk, $("unlock-remember").checked);
    $("unlock-screen").classList.add("hidden");
    err("");
    $("unlock-password").value = "";
    socket.emit("auth", { token: state.token });                   // продолжаем вход
  } catch (ex) {
    err("Неверный пароль — расшифровать не удалось");
  }
};

$("unlock-logout").onclick = logout;

/* ===================== 7. SOCKET.IO: СВЯЗЬ С СЕРВЕРОМ ===================== */
// Подключаемся к серверу (сначала WebSocket, при неудаче — резервный способ).
// Если адрес сервера ещё не выбран — показываем экран подключения, а сокет подменяем заглушкой.
if (!API_BASE) {                                                   // адреса сервера ещё нет —
  // Особый случай: страница открыта прямо с сервера GeoMetric (проверка интерфейса).
  // Спрашиваем «есть ли тут сервер?» и, если да, используем этот же адрес.
  // Ждём ответ здесь же (в модуле разрешён await): так приложение подключается сразу,
  // без перезагрузки страницы и без мигания экрана.
  try {                                                            // запрос может не пройти —
    const info = await fetch("/api/status", { cache: "no-store" })  // спрашиваем состояние сервера
      .then((r) => (r.ok ? r.json() : null))                       // читаем ответ, если он успешен
      .catch(() => null);                                          // ошибка сети — считаем, что сервера нет
    if (info && info.geometric) {                                  // да, это сервер GeoMetric —
      API_BASE = location.origin;                                  //   используем текущий адрес
      localStorage.setItem(SERVER_KEY, API_BASE);                  //   и запоминаем его на устройстве
    } else {                                                       // нет, сервера рядом нет —
      showServerScreen("");                                        //   показываем экран ввода адреса
    }
  } catch (e) {                                                    // что-то пошло не так —
    showServerScreen("");                                          //   всё равно даём ввести адрес вручную
  }
}
const socket = API_BASE                                            // адрес есть —
  ? io(API_BASE, { transports: ["websocket", "polling"] })          //   подключаемся к этому серверу
  : { on() {}, emit() {}, connected: false, disconnect() {} };      // заглушка: обработчики просто не сработают

socket.on("connect", async () => {
  // Соединение установлено: решаем, что показать пользователю.
  hideSplash();                                                    // убираем заставку запуска
  if (!state.token) {                                              // токена нет —
    $("auth-screen").classList.remove("hidden");                   //   показываем экран входа
    return;
  }
  if (await ensureIdentity()) {                                    // ключ уже разблокирован —
    socket.emit("auth", { token: state.token });                   //   входим
    return;
  }
  if (!cryptoAvailable()) {                                        // браузер не умеет шифровать —
    $("insecure-banner").classList.remove("hidden");               //   предупреждаем об этом
    return;
  }
  // Токен есть, но ключ закрыт. Сначала проверим, что токен вообще живой:
  try {
    const probe = await fetch(apiUrl("/api/keys?token=" + encodeURIComponent(state.token)));
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
          <div class="chat-name">${esc(previewTitle(c))}${c.kind === "room" ? roomBadge(c) : ""}</div>
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
      el.innerHTML = `<span class="txt">🔒 История зашифрована</span>`;   //   честно сообщаем
      return;                                                      //
    }
    const prefix = msg.from === state.me.username ? "Вы: " : "";
    let text;
    if (!msg.e2e) {
      // Режим без шифрования: данные лежат открыто.
      text = msg.plain?.file ? (msg.plain.file.kind === "video" ? "🎥 Видео" : "📷 Фото") : (msg.plain?.text || "Сообщение");
    } else if (!key) {
      text = "🔒 Зашифровано";                                      // ключа пока нет
    } else {
      const obj = await decryptObject(key, msg.e2e);                // расшифровываем у себя в браузере
      if (obj === null) text = "🔒 Не удалось расшифровать";
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
    if (!key) return "🔒 Зашифрованное сообщение";
    const t = await decryptFull(key, msg);
    return t?.text || (t?.file ? "Медиа" : "Сообщение");
  } catch { return "Сообщение"; }
}

/* ===================== 9. ОТКРЫТИЕ ЧАТА И СООБЩЕНИЯ ===================== */
async function openChat(login, silent = false, saved = false) {
  // Открываем диалог с человеком (или с самим собой — «Избранное»).
  state.activeRoom = null;                                         // комнату закрываем
  state.savedMode = !!saved;                                       // режим «Избранное»?
  $("peer-card").classList.toggle("saved-mode", !!saved);           // помечаем шапку
  $("peer-card").classList.remove("room-mode");                     // это не комната
  state.activeChat = login;                                        // собеседник
  state.peer = saved ? state.me : (state.people[login] || { username: login, name: login });   // для Избранного — я сам
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
  $("peer-name").innerHTML = `${esc(state.peer.name || state.peer.username)}
    <svg title="Переписка защищена сквозным шифрованием"><use href="#i-lock"></use></svg>`;
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
  if (!msg.e2e) return { text: msg.plain?.text || "", file: msg.plain?.file || null };
  if (!key) return null;                                           // ключа нет — расшифровать невозможно
  const obj = await decryptObject(key, msg.e2e);                   // расшифровка в браузере
  if (obj === null) return null;                                   // расшифровать не удалось
  if (typeof obj === "string") return { text: obj, file: null };    // поддержка старого формата
  return { text: obj.t || "", file: obj.file || null };
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
    if (m.deleted) {                                              // сообщение удалено —
      continue;                                                   //   в ленте не показываем
    }
    let content = "";
    if (m.kind === "call") content = "";
    else if (dec === null) {
      // Расшифровать не удалось (например, ключ собеседника сменился).
      content = `<span class="bubble-undecryptable"><svg><use href="#i-unlock"></use></svg> Сообщение нельзя расшифровать (сменился ключ)</span>`;
    } else {
      if (dec.text) content += linkify(dec.text);
      if (dec.file) content += `<div class="bubble-media" data-file='${esc(JSON.stringify(dec.file))}'>${dec.file.kind === "video" ? `<div class="media-loading"></div>` : `<div class="media-loading"></div>`}</div>`;
      if (!dec.text && !dec.file) content = "Сообщение";
    }
    const tick = out ? (m.read
      ? `<span class="tick read" title="Прочитано"><svg><use href="#i-double-check"></use></svg></span>`
      : `<span class="tick" title="Доставлено"><svg><use href="#i-check"></use></svg></span>`) : "";
    const lock = m.e2e
      ? `<span class="bubble-lock" title="Сквозное шифрование"><svg><use href="#i-lock"></use></svg></span>`
      : `<span class="bubble-lock" title="Без шифрования" style="color:var(--warn)"><svg><use href="#i-unlock"></use></svg></span>`;
    // ВАЖНО: собираем разметку пузыря одной строкой без отступов.
    // У пузыря включён стиль white-space: pre-wrap (чтобы сохранялись переносы строк
    // в сообщениях), поэтому лишние пробелы и переводы строк из шаблона были бы
    // видны на экране — текст «уезжал» вправо, как будто выровнен по центру.
    parts.push(`<div class="${rowCls}" data-id="${m.id}"><div class="bubble ${lastInGroup ? "tail" : ""}">${replyQuoteHtml(m, dec)}${content.trim()}` +
      `<div class="bubble-time">${lock} ${fmtTime(m.ts)} ${tick}</div></div></div>`);
    prevFrom = m.from;
  }
  box.innerHTML = parts.join("") || "";
  // Расшифровываем медиа (фото/видео) и подставляем в пузыри.
  for (const el of box.querySelectorAll(".bubble-media")) {
    loadMediaInto(el);
  }
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
  const isVideo = info.kind === "video";
  try {
    let src;
    if (info.key && info.iv) {
      // Файл зашифрован: скачиваем, расшифровываем, делаем временную ссылку.
      if (mediaCache.has(info.url)) src = mediaCache.get(info.url);
      else {
        const blob = await decryptFile(info.url, info.key, info.iv);
        src = URL.createObjectURL(blob);
        mediaCache.set(info.url, src);
      }
    } else {
      src = info.url;                                              // без шифрования (режим без E2EE)
    }
    el.innerHTML = isVideo
      ? `<video src="${src}" controls playsinline preload="metadata"></video>`
      : `<img src="${src}" alt="${esc(info.name || "фото")}" loading="lazy" />`;
  } catch (e) {
    el.innerHTML = `<div class="bubble-undecryptable"><svg><use href="#i-unlock"></use></svg> Медиафайл не удалось расшифровать</div>`;
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
  if (state.unlocked && !state.insecure) {                          // шифрование доступно
    const key = inRoom ? roomKeys.get(state.activeRoom) : await convKeyFor(to);   // ключ комнаты или личный ключ
    if (!key) { toast(inRoom ? "Ключ комнаты ещё не получен — попросите администратора" : "Ключ собеседника ещё не загружен — попробуйте через секунду"); return; }
    envelope = await encryptPayload(key, obj);                      // ШИФРУЕМ текст прямо здесь (сервер увидит только набор байтов)
  } else {
    // Режим без шифрования: сервер (и все, кто получит доступ к базе) сможет это прочитать.
    plain = { text, file: file ? { ...file, key: undefined, iv: undefined } : null };
  }
  if (inRoom) {                                                     // сообщение в группу/канал
    socket.emit("send_room_message", { room: state.activeRoom, kind: file ? "media" : "text", e2e: envelope, plain });
  } else {
    socket.emit("send_message", { to, kind: file ? "media" : "text", e2e: envelope, plain });
  }
  input.value = "";                                                 // очищаем поле
  autoGrow(input);                                                  // возвращаем ему обычную высоту
  state.pendingFile = null;                                         // вложение отправлено
  state.replyTo = null;                                             // ответ отправлен
  renderReplyBar();                                                 // прячем полоску цитаты
  renderAttachPreview();                                            // обновляем превью вложения
}

$("btn-send").onclick = sendMessage;

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
    // Без Web Crypto файл уйдёт незашифрованным — предупреждаем честно.
    toast("Вложение будет отправлено без шифрования", 4000);
  }
  toast("Шифрую и загружаю файл…");
  try {
    const fd = new FormData();
    const kind = f.type.startsWith("video") ? "video" : "image";
    const meta = { name: f.name, mime: f.type, kind };
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
  $("security-section").classList.remove("hidden");
  $("password-section").classList.remove("hidden");
  $("peer-actions").classList.add("hidden");
  $("fp-label").textContent = "Ваш отпечаток ключа";               // подпись для своего профиля
  delete $("security-section").dataset.peer;                       // это свой профиль
  $("profile-name").disabled = false;
  $("profile-bio").disabled = false;
  $("avatar-badge").classList.remove("hidden");
  renderColorPicker();
  showFingerprint();
  $("profile-modal").classList.remove("hidden");
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
  $("security-section").classList.remove("hidden");                // у собеседника тоже интересен отпечаток ключа
  $("security-section").dataset.peer = "1";                        // помечаем: это чужой профиль
  $("password-section").classList.add("hidden");                   // а смена пароля — только своя
  $("fp-label").textContent = "Отпечаток ключа собеседника";       // подпись для чужого профиля
  $("peer-actions").classList.remove("hidden");
  $("profile-name").disabled = true;
  $("profile-bio").disabled = true;
  $("avatar-badge").classList.add("hidden");
  $("profile-modal").classList.remove("hidden");
  showPeerFingerprint(username);                                   // показываем отпечаток его ключа
}

async function showPeerFingerprint(username) {
  // Отпечаток ключа собеседника: его можно сверить голосом (как в Signal/Telegram).
  $("my-fingerprint").textContent = "…";
  // Временно показываем многоточие, пока считаем.
  try {
    const pub = await peerPublicKey(username);
    $("my-fingerprint").textContent = pub ? await fingerprint(pub) : "ключ ещё не получен";
  } catch { $("my-fingerprint").textContent = "недоступно"; }
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
    token: state.token,
    name: $("profile-name").value.trim() || state.me.username,
    bio: $("profile-bio").value.trim(),
    avatar: state.me.avatar,
    settings: state.settings,
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

async function showFingerprint() {
  // Отпечаток своего публичного ключа — можно продиктовать собеседнику и сверить.
  if (!state.me?.pub) { $("my-fingerprint").textContent = "нет ключа"; return; }
  try { $("my-fingerprint").textContent = await fingerprint(state.me.pub); }
  catch { $("my-fingerprint").textContent = "недоступно"; }
  $("enc-status").innerHTML = state.unlocked
    ? '<span style="color:var(--good)">включено (E2EE)</span>'
    : '<span style="color:var(--warn)">нет доступа к ключу</span>';
}

$("btn-change-password").onclick = async () => {
  // Смена пароля: ключ шифрования перешифровывается новым паролем.
  const old = $("pass-old").value, fresh = $("pass-new").value, again = $("pass-new2").value;
  if (fresh.length < 6) { toast("Новый пароль: минимум 6 символов"); return; }
  if (fresh !== again) { toast("Новые пароли не совпадают"); return; }
  try {
    toast("Перешифровываю ключ…");
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

$("btn-forget-device").onclick = () => {
  // Убираем сохранённый ключ с устройства: при следующем запуске спросим пароль.
  localStorage.removeItem("gm_priv");
  toast("Ключ больше не хранится на этом устройстве");
};

$("btn-regen-keys").onclick = async () => {
  // Полная замена ключей: старые сообщения станут нечитаемыми — предупреждаем.
  if (!confirm("Создать новые ключи шифрования?\n\nСтарые сообщения расшифровать будет НЕЛЬЗЯ.")) return;
  const password = prompt("Введите пароль, чтобы подтвердить:");
  if (!password) return;
  try {
    const res = await fetch(apiUrl("/api/login"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: state.me.username, password }),
    }).then((r) => r.json());
    if (res.error) { toast("Пароль неверный"); return; }
    const { pubJwk, privJwk } = await generateIdentity();           // новая пара ключей
    const { kek, saltB64 } = await deriveKEK(password);             // ключ из пароля
    const encPriv = await wrapPrivateKey(privJwk, kek);
    // Отправляем НОВЫЙ публичный ключ и приватный (зашифрованный паролем):
    await fetch(apiUrl("/api/keys/replace"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.token, pub: pubJwk, encPriv, kekSalt: saltB64 }),
    });
    state.me.pub = pubJwk;
    storeIdentity(privJwk, true);
    clearConversationCache();                                       // старый кэш ключей больше не нужен
    previewCache.clear();
    toast("Ключи обновлены. Прежние сообщения больше не читаются");
    showFingerprint();
    await renderMessages();
  } catch (e) { toast("Не удалось обновить ключи"); }
};

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
  $("server-now").textContent = API_BASE || "не выбран";        // адрес сервера, к которому подключено приложение
  $("set-hide-seen").checked = !!s.hideLastSeen;
  $("set-story-vis").value = s.storyVisibility || "all";
  $("set-story-seconds").value = String(s.storySeconds || 5);
  $("app-mode").textContent = isDesktopShell() ? "Настольное приложение"
    : isStandalone() ? "Установленное приложение" : "Браузер";
  $("enc-status-2").innerHTML = state.unlocked
    ? '<span style="color:var(--good)">E2EE включено</span>'
    : '<span style="color:var(--warn)">без шифрования</span>';
  $("settings-modal").classList.remove("hidden");
};
$("settings-close").onclick = () => $("settings-modal").classList.add("hidden");

$("btn-change-server").onclick = () => {                           // нажатие «Сменить сервер» в настройках
  $("settings-modal").classList.add("hidden");                     // закрываем настройки
  showServerScreen(API_BASE);                                      // и показываем экран подключения с текущим адресом
};

function applySettingsToUI() {
  // Применяем настройки к интерфейсу.
  document.body.classList.toggle("compact", !!state.settings.compactMode);
  applyTheme(state.settings.theme);
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
  if (!confirm("Очистить кэш, ключи и выйти из аккаунта?")) return;
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
$("btn-back").onclick = () => {
  // Кнопка «назад» на телефоне.
  state.activeChat = null;
  $("chat-area").classList.remove("open");
  $("chat-header").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  renderChats();
};

$("search").oninput = renderChats;
// Поиск по чатам фильтрует список на лету.

$("insecure-continue").onclick = () => {
  // Пользователь согласился работать без сквозного шифрования.
  state.insecure = true;
  $("insecure-banner").classList.add("hidden");
  toast("Внимание: сообщения отправляются незашифрованными", 5000);
  socket.emit("auth", { token: state.token });
};

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
  const bubble = e.target.closest(".bubble");           // нажатие пришлось на сообщение?
  if (!bubble || appMenu.contains(e.target)) return;    // если нет или это само меню — ничего не делаем
  pressFrom = { x: e.clientX, y: e.clientY };           // запоминаем точку нажатия
  pressTimer = setTimeout(() => {                       // через 480 мс считаем нажатие долгим
    const clone = bubble.cloneNode(true);               // копируем пузырь, чтобы ничего не менять на экране
    clone.querySelectorAll(".bubble-time, .bubble-lock, svg").forEach((n) => n.remove());   // убираем время, замок и иконки
    const text = (clone.textContent || "").replace(/\s+/g, " ").trim();   // берём только сам текст сообщения
    openAppMenu(bubble, text);                          // открываем своё меню вместо меню браузера
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

function deleteOwnMessage(msg) {
  // Удаляем своё сообщение у всех.
  const data = { id: msg.id };                                     // что удаляем
  if (state.activeRoom) data.room = state.activeRoom;              // если это комната — указываем её
  else data.with = state.activeChat;                               // иначе собеседника
  socket.emit("delete_message", data);                             // просим сервер
  toast("Сообщение удалено");                                      // сообщаем
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
        toast("Ключ комнаты получен — переписка защищена");           // сообщаем пользователю
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
    if (dec === null) content = `<span class="bubble-undecryptable"><svg><use href="#i-unlock"></use></svg> Сообщение нельзя расшифровать</span>`;   // ключа нет или он сменился
    else {
      content = "";                                                // собираем по частям
      if (dec.text) content += linkify(dec.text);                  // текст
      if (dec.file) content += `<div class="bubble-media" data-file='${esc(JSON.stringify(dec.file))}'>${dec.file.kind === "video" ? '<div class="media-loading"></div>' : '<div class="media-loading"></div>'}</div>`;   // медиа
      if (!dec.text && !dec.file) content = "Сообщение";           // пустое — общая подпись
    }
    const lock = m.e2e ? `<span class="bubble-lock" title="Сквозное шифрование"><svg><use href="#i-lock"></use></svg></span>` : "";   // замок
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
  const delBtn = document.getElementById("app-menu-delete");       // «Удалить»
  const mine = msg.from === state.me.username;                     // своё сообщение удалять можно
  delBtn.classList.toggle("hidden", !mine);                        // чужое — нельзя
  delBtn.onclick = () => { closeAppMenu(); deleteOwnMessage(msg); };    // удаляем
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
  toast(data.needs_key ? `Вы в «${data.title}». Ждём ключ шифрования от администратора` : `Вы в «${data.title}»`);   // сообщаем
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
