/* =========================================================================
   GeoMetric — service worker.
   Что это такое: маленький «помощник» внутри браузера. Он нужен, чтобы
   приложение можно было УСТАНОВИТЬ на телефон или компьютер (иконка на
   рабочем столе, отдельное окно без адресной строки) и чтобы интерфейс
   открывался мгновенно — даже при плохой связи.
   ВАЖНО: сообщения здесь НЕ кэшируются. Переписка всегда идёт напрямую с
   сервером, иначе можно показать устаревшее или чужое.
   ========================================================================= */

const CACHE = "geometric-shell-v6";
// Имя версии кэша: при выпуске новой версии число меняем — старое вычистится.

const SHELL = [
  // «Оболочка» приложения: без этих файлов интерфейс не открыть.
  // Пути ОТНОСИТЕЛЬНЫЕ: приложение теперь носит файлы с собой (в APK и EXE),
  // поэтому адреса не должны начинаться с /static/ — иначе на телефоне
  // и на компьютере часть файлов не нашлась бы.
  "./",
  "style.css",
  "design.css",
  "app.js",
  "crypto.js",
  "socket.io.min.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  // Установка: складываем файлы оболочки в кэш.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
    // addAll — загружает все файлы; skipWaiting — сразу активируем новую версию.
  );
});

self.addEventListener("activate", (event) => {
  // Активация: удаляем кэши прошлых версий.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Перехватываем запросы.
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  // Запросы с данными (сообщения, файлы, ключи) НЕ кэшируем — только «оболочку» интерфейса.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/socket.io/")) return;
  event.respondWith(
    // Сначала пробуем взять из кэша, иначе — из сети (и заодно обновляем кэш).
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
      }
      return res;
    }).catch(() => caches.match("/")))   // если сети нет — отдаём главную страницу из кэша
  );
});
