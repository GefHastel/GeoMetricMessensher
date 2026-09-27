/* =========================================================================
   GeoMetric — модуль сквозного шифрования (E2EE).
   =========================================================================
   ГЛАВНАЯ ИДЕЯ: сервер НИКОГДА не видит твои сообщения.
   Текст шифруется прямо в браузере, и туда попадает уже «бессмысленный набор
   байтов». Ключи для расшифровки есть только у тебя и у собеседника.

   Как это работает по шагам:
     1) При регистрации браузер создаёт пару ключей ECDH (P-256):
        - публичный  — его можно показывать всем, он уходит на сервер;
        - приватный  — НИКОМУ не отдаём; храним зашифрованным паролем (KEK).
     2) Из пароля выводится «ключ шифрования ключа» (KEK) через PBKDF2 (250 000 итераций).
        Им шифруется приватный ключ — на сервере он лежит в зашифрованном виде.
     3) Для каждого диалога два публичных ключа (мой + собеседника) дают ОДИН общий
        секрет по алгоритму Диффи–Хеллмана (ECDH). Сервер его вычислить не может:
        у него нет приватных ключей.
     4) Сообщение шифруется AES-GCM-256 этим общим секретом. Сервер пересылает
        только шифротекст.

   Почему AES-GCM: он не только прячет текст, но и защищает от подмены —
   любую изменённую «на лету» букву расшифровка отвергнет.
   ========================================================================= */

/* ---------- Мелкие помощники для работы с байтами и base64 ---------- */

function b64(arr) {
  // Превращает байты (ArrayBuffer / Uint8Array) в строку base64.
  const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
  // Приводим вход к Uint8Array (массив байтов).
  let s = "";
  // Здесь собираем строку.
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // Каждый байт → символ (строка из «сырых» символов).
  return btoa(s);
  // btoa кодирует эту строку в base64 (безопасно для хранения и пересылки).
}

function unb64(str) {
  // Обратная операция: base64 → байты.
  const bin = atob(str);
  // Декодируем base64 в «сырую» строку.
  const out = new Uint8Array(bin.length);
  // Готовим массив такой же длины.
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Копируем коды символов в байты.
  return out;
  // Возвращаем байты.
}

const te = new TextEncoder();
// Кодировщик текста в байты (UTF-8).
const td = new TextDecoder();
// Декодер байтов обратно в текст.

function randBytes(n) {
  // Криптостойкие случайные байты — основа любой безопасности.
  return crypto.getRandomValues(new Uint8Array(n));
  // Браузерный генератор случайных чисел (не «Math.random»!).
}

/* ---------- Проверка: доступно ли шифрование в этом окружении ---------- */

export function cryptoAvailable() {
  // Браузер разрешает Web Crypto только в «безопасном контексте»:
  // это https://, localhost или установленное как приложение окно.
  return typeof crypto !== "undefined" && !!crypto.subtle;
  // Если crypto.subtle есть — шифрование доступно.
}

/* ---------- 1. Ключ из пароля (KEK) ---------- */

export async function deriveKEK(password, saltB64) {
  // Выводит из пароля ключ, которым будем шифровать приватный ключ.
  const salt = saltB64 ? unb64(saltB64) : randBytes(16);
  // Соль: делает одинаковые пароли разными ключами. Если не передали — создаём.
  const base = await crypto.subtle.importKey(
    // Импортируем пароль как «сырой» ключевой материал.
    "raw",
    // Тип данных — сырые байты.
    te.encode(password),
    // Сам пароль в байтах.
    "PBKDF2",
    // Алгоритм, который умеет растягивать пароль.
    false,
    // Экспортировать этот промежуточный ключ нельзя.
    ["deriveKey"],
    // Разрешаем только вывод ключа.
  );
  const kek = await crypto.subtle.deriveKey(
    // Теперь растягиваем пароль в полноценный ключ AES-256.
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    // Параметры: 250 000 итераций — перебор паролей становится очень долгим (Brute-force защита).
    base,
    // Из чего выводим.
    { name: "AES-GCM", length: 256 },
    // Что хотим получить: ключ AES-GCM на 256 бит.
    false,
    // Ключ нельзя выгрузить наружу (останется внутри Web Crypto).
    ["encrypt", "decrypt"],
    // Разрешения: шифровать и расшифровывать.
  );
  return { kek, saltB64: b64(salt) };
  // Возвращаем ключ и соль (соль можно хранить на сервере — она не секрет).
}

/* ---------- 2. Своя пара ключей (личность) ---------- */

export async function generateIdentity() {
  // Создаёт пару ключей ECDH: публичный и приватный.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    // ECDH на кривой P-256 — стандарт для обмена ключами в вебе.
    true,
    // true — ключи можно экспортировать (нужно, чтобы сохранить приватный зашифрованным).
    ["deriveKey"],
    // Разрешение: выводить из них общий секрет.
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Публичный ключ в формате JWK (обычный JSON) — его отдаём серверу.
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  // Приватный ключ тоже в JWK, но НАРУЖУ он уйдёт только зашифрованным.
  return { pair, pubJwk, privJwk };
  // Возвращаем всё нужное.
}

export async function wrapPrivateKey(privJwk, kek) {
  // Шифрует приватный ключ паролем пользователя (KEK).
  const iv = randBytes(12);
  // IV — «одноразовый номер» для AES-GCM (12 байт — стандартная длина).
  const ct = await crypto.subtle.encrypt(
    // Шифруем.
    { name: "AES-GCM", iv },
    // Алгоритм и IV.
    kek,
    // Ключ шифрования (из пароля).
    te.encode(JSON.stringify(privJwk)),
    // Данные — приватный ключ в виде JSON.
  );
  return `${b64(iv)}.${b64(ct)}`;
  // Формат хранения: IV.шифротекст (обе части в base64).
}

export async function unwrapPrivateKey(blob, kek) {
  // Расшифровывает приватный ключ паролем.
  const [ivB64, ctB64] = String(blob).split(".");
  // Разбираем строку «IV.шифротекст».
  if (!ivB64 || !ctB64) throw new Error("Повреждённый ключ");
  // Если формат не тот — сообщаем об ошибке.
  const pt = await crypto.subtle.decrypt(
    // Расшифровываем.
    { name: "AES-GCM", iv: unb64(ivB64) },
    // Алгоритм и IV.
    kek,
    // Тот же ключ из пароля.
    unb64(ctB64),
    // Шифротекст.
  );
  return JSON.parse(td.decode(pt));
  // Возвращаем приватный ключ как объект JWK.
  // Если пароль неверный — браузер бросит ошибку, и мы поймём, что пароль не подошёл.
}

/* ---------- 3. Общий секрет диалога (это и есть «сквозное» шифрование) ---------- */

const convCache = new Map();
// Кэш общих ключей: чтобы не пересчитывать при каждом сообщении.

export async function conversationKey(myPrivJwk, peerPubJwk, cacheKey) {
  // Считает общий секрет из моего приватного ключа и публичного ключа собеседника.
  if (cacheKey && convCache.has(cacheKey)) return convCache.get(cacheKey);
  // Если уже считали — берём из кэша (быстрее).
  const myPriv = await crypto.subtle.importKey(
    // Импортируем свой приватный ключ.
    "jwk",
    // Формат JWK.
    myPrivJwk,
    // Данные ключа.
    { name: "ECDH", namedCurve: "P-256" },
    // Алгоритм.
    false,
    // Экспортировать обратно не нужно.
    ["deriveKey"],
    // Разрешение на вывод общего ключа.
  );
  const peerPub = await crypto.subtle.importKey(
    // Импортируем публичный ключ собеседника.
    "jwk",
    peerPubJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
    // Публичным ключом ничего не подписываем и не выводим — он только участник обмена.
  );
  const key = await crypto.subtle.deriveKey(
    // Выводим общий ключ AES-GCM.
    { name: "ECDH", public: peerPub },
    // Участник: его публичный ключ.
    myPriv,
    // Мой приватный ключ.
    { name: "AES-GCM", length: 256 },
    // Результат: ключ AES-256 для шифрования переписки.
    false,
    ["encrypt", "decrypt"],
  );
  // ВАЖНО: у собеседника получится ТОЧНО ТАКОЙ ЖЕ ключ (из его приватного и моего публичного).
  // А сервер, зная только два публичных ключа, этот секрет вычислить не может.
  if (cacheKey) convCache.set(cacheKey, key);
  // Запоминаем в кэше.
  return key;
  // Отдаём ключ.
}

export function clearConversationCache() {
  // Сбрасывает кэш ключей (нужно при смене ключей или выходе из аккаунта).
  convCache.clear();
  // Очищаем Map.
}

/* ---------- 4. Шифрование текста ---------- */

export async function encryptText(convKey, text) {
  // Шифрует текст сообщения.
  const iv = randBytes(12);
  // Свой случайный IV для каждого сообщения (важно: повторять нельзя).
  const ct = await crypto.subtle.encrypt(
    // Шифруем.
    { name: "AES-GCM", iv },
    // Алгоритм и IV.
    convKey,
    // Общий ключ диалога.
    te.encode(JSON.stringify({ t: text })),
    // Полезная нагрузка: {"t": "текст"} — в JSON удобно хранить и текст, и другие поля.
  );
  return { v: 1, n: b64(iv), c: b64(ct) };
  // Возвращаем «конверт»: версия, IV и шифротекст. Сервер увидит только это.
}

export async function encryptPayload(convKey, obj) {
  // Шифрует ЛЮБОЙ объект (текст сообщения + данные файла) одним куском.
  const iv = randBytes(12);
  // Случайный IV для каждого сообщения.
  const ct = await crypto.subtle.encrypt(
    // Шифруем.
    { name: "AES-GCM", iv },
    convKey,
    // Общий ключ диалога.
    te.encode(JSON.stringify(obj)),
    // Всё содержимое сообщения превращаем в JSON и шифруем целиком.
  );
  return { v: 1, n: b64(iv), c: b64(ct) };
  // Сервер получит только это: версию, IV и «бессмысленные» байты.
}

export async function decryptObject(convKey, envelope) {
  // Расшифровывает «конверт» и возвращает ВЕСЬ объект целиком (текст + данные файла).
  if (!envelope || !envelope.c) return null;             // пустой конверт — нечего расшифровывать
  try {
    const pt = await crypto.subtle.decrypt(
      // Расшифровываем.
      { name: "AES-GCM", iv: unb64(envelope.n) },
      // Алгоритм и IV из конверта.
      convKey,
      // Ключ диалога.
      unb64(envelope.c),
      // Шифротекст.
    );
    return JSON.parse(td.decode(pt));
    // Превращаем байты в объект: {t: "текст", file: {...}}.
  } catch (e) {
    return null;
    // null = расшифровать не удалось (например, собеседник пересоздал ключи).
  }
}

export async function decryptText(convKey, envelope) {
  // Расшифровывает «конверт» обратно в текст.
  if (!envelope || !envelope.c) return "";
  // Пустой конверт — пустая строка.
  try {
    // Пробуем расшифровать (может не получиться, если ключ другой —
    // например, собеседник пересоздал свою пару ключей).
    const pt = await crypto.subtle.decrypt(
      // Расшифровываем.
      { name: "AES-GCM", iv: unb64(envelope.n) },
      // Алгоритм и IV из конверта.
      convKey,
      // Общий ключ диалога.
      unb64(envelope.c),
      // Шифротекст.
    );
    const obj = JSON.parse(td.decode(pt));
    // Превращаем байты в JSON-объект.
    return obj.t != null ? obj.t : "";
    // Возвращаем поле с текстом.
  } catch (e) {
    // Не удалось расшифровать.
    return null;
    // null означает «расшифровать невозможно» — покажем в интерфейсе замок со знаком вопроса.
  }
}

/* ---------- 5. Шифрование файлов (фото и видео в чате) ---------- */

export async function encryptFile(file) {
  // Шифрует целый файл своим собственным ключом.
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  // Отдельный случайный ключ AES-256 именно для этого файла.
  const iv = randBytes(12);
  // IV для файла.
  const buf = await file.arrayBuffer();
  // Читаем файл целиком в память (для фото/небольших видео это нормально).
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf);
  // Шифруем содержимое.
  const raw = await crypto.subtle.exportKey("raw", key);
  // Экспортируем сам ключ файла — его мы спрячем в зашифрованном сообщении.
  const blob = new Blob([ct], { type: "application/octet-stream" });
  // Зашифрованный файл как Blob — его и загрузим на сервер (сервер не поймёт, что внутри).
  return { blob, fileKey: b64(raw), iv: b64(iv) };
  // Возвращаем: сам шифротекст + ключ и IV (их отправим в зашифрованном сообщении).
}

export async function decryptFile(url, fileKeyB64, ivB64) {
  // Скачивает зашифрованный файл и расшифровывает его в браузере.
  const res = await fetch(url);
  // Забираем шифротекст с сервера.
  const ct = await res.arrayBuffer();
  // В виде байтов.
  const key = await crypto.subtle.importKey("raw", unb64(fileKeyB64), { name: "AES-GCM" }, false, ["decrypt"]);
  // Восстанавливаем ключ файла.
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, ct);
  // Расшифровываем содержимое.
  return new Blob([pt]);
  // Возвращаем расшифрованный файл (дальше покажем по временной ссылке).
}

/* ---------- 6. Отпечаток ключа (для проверки «свой-чужой») ---------- */

export async function fingerprint(pubJwk) {
  // Короткий «отпечаток» публичного ключа — как в Telegram/Signal.
  const canonical = `${pubJwk.crv}:${pubJwk.x}:${pubJwk.y}`;
  // Берём только математическую часть ключа в стабильном порядке.
  const digest = await crypto.subtle.digest("SHA-256", te.encode(canonical));
  // Считаем SHA-256 от ключа.
  const bytes = new Uint8Array(digest).slice(0, 16);
  // Берём первые 16 байт — этого достаточно для идентификации.
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Превращаем в hex-строку.
  return (hex.match(/.{1,4}/g) || []).join(" ");
  // Разбиваем по 4 символа — так удобнее сверять глазами: «a1b2 c3d4 ...».
}


/* ---------------------------------------------------------------------------
   Ключи для групп и каналов.
   Личный чат шифруется общим ключом двух людей (ECDH). В группе участников
   много, поэтому у комнаты ОДИН случайный ключ, а каждому участнику он
   выдаётся отдельно — «завёрнутым» на его личный ключ. Сервер хранит только
   такие «конверты» и сам ключ получить не может.
   --------------------------------------------------------------------------- */

export function randomRoomKey() {
  // Придумываем случайный ключ комнаты: 32 байта, для AES-256-GCM.
  return b64(randBytes(32));                                       // возвращаем его в виде текста base64
}

export async function unwrapRoomKeyRaw(myPrivJwk, ownerPubJwk, envelope, cacheKey) {
  // Достаём «сырой» (текстовый) ключ комнаты — он нужен, чтобы выдать доступ новым участникам.
  if (!envelope || !envelope.c) return null;                        // конверта нет — ключа нет
  const convKey = await conversationKey(myPrivJwk, ownerPubJwk, cacheKey);   // общий секрет с автором «конверта»
  if (!convKey) return null;                                        // секрет не получился
  return decryptText(convKey, envelope);                            // расшифровываем текст внутри конверта
}

export async function importRoomKey(rawB64) {
  // Превращаем текстовый ключ в рабочий ключ шифрования, с которым умеет работать браузер.
  const raw = unb64(rawB64);                                       // из base64 обратно в байты
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);   // ключ для шифрования и расшифровки
}

export async function unwrapRoomKey(myPrivJwk, ownerPubJwk, envelope, cacheKey) {
  // Достаём ключ комнаты из «конверта»: расшифровываем его личным ключом получателя.
  if (!envelope || !envelope.c) return null;                        // конверта нет — ключа нет
  const convKey = await conversationKey(myPrivJwk, ownerPubJwk, cacheKey);   // общий секрет со автором конверта
  if (!convKey) return null;                                        // секрет не получился
  const raw = await decryptText(convKey, envelope);                 // расшифровываем текст внутри конверта
  if (!raw) return null;                                            // не расшифровалось
  return importRoomKey(raw);                                        // превращаем в рабочий ключ
}

export async function wrapRoomKey(myPrivJwk, memberPubJwk, rawB64, cacheKey) {
  // Заворачиваем ключ комнаты для конкретного участника: только он сможет его открыть.
  const convKey = await conversationKey(myPrivJwk, memberPubJwk, cacheKey);   // общий секрет с этим участником
  if (!convKey) return null;                                        // секрета нет — не заворачиваем
  return encryptText(convKey, rawB64);                              // «конверт» с ключом комнаты
}
