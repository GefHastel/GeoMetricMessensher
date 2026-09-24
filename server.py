# -*- coding: utf-8 -*-
"""
GeoMetric — сервер мессенджера со СКВОЗНЫМ ШИФРОВАНИЕМ (E2EE).

Главный принцип этого сервера: он НЕ МОЖЕТ прочитать переписку.
   * Текст сообщений приходит сюда уже зашифрованным (AES-GCM-256).
   * Ключи для расшифровки есть только у двух собеседников (ECDH P-256).
   * Сервер хранит «конверты» — наборы байтов, из которых ничего не понять.
   * Если открыть data/db.json, вместо сообщений будут строки вида base64.

Что ещё умеет сервер:
   1. Регистрация/вход (пароли — только в виде хеша PBKDF2).
   2. Личные чаты с мгновенной доставкой по WebSocket.
   3. Журнал звонков прямо в переписке: исходящий / входящий / пропущенный / отклонённый.
   4. Истории на 24 часа (с настройкой «показывать всем или только контактам»).
   5. Статусы «в сети» — с уважением к приватности (можно скрыть).
   6. Поиск людей — по точному логину, без выдачи всего списка пользователей.
   7. Звонки: сервер передаёт только технические сигналы (SDP/ICE), звук идёт напрямую.

Запуск:  python server.py            (подробности в README.md)
"""

# ---------------------------------------------------------------------------
# 1. ИМПОРТЫ
# ---------------------------------------------------------------------------
import argparse                                                     # разбор параметров командной строки (--host, --port)
import hashlib                                                      # хеширование паролей (PBKDF2-SHA256)
import json                                                         # хранение базы в JSON-файле
import mimetypes                                                    # определение типа загружаемых файлов
import os                                                           # работа с файловой системой
import secrets                                                      # криптостойкие случайные значения
import sys                                                          # потоки вывода (stdout/stderr) — для безопасной печати
import threading                                                    # блокировки потоков при записи в базу
import time                                                         # метки времени (сообщения, истории, звонки)
import urllib.request                                               # скачивание js-клиента socket.io при первом запуске
import uuid                                                         # уникальные идентификаторы
from pathlib import Path                                            # удобные пути


def _make_output_safe():
    """Делает вывод в консоль безопасным: UTF-8 и замена «непечатаемых» символов.

    Зачем это нужно: на Windows (особенно когда приложение запущено без окна консоли,
    как это делает GeoMetric.exe) печать русских букв или эмодзи может уронить программу
    ошибкой кодировки. Здесь мы заранее включаем UTF-8 с заменой символов,
    а если консоли нет вовсе — подставляем «пустышку», чтобы print() не падал.
    """
    class _SilentStream:                                            # класс-заглушка вместо отсутствующей консоли
        encoding = "utf-8"                                          # делаем вид, что кодировка UTF-8
        errors = "replace"                                          # и что неподдерживаемые символы заменяются

        def write(self, _text):                                     # метод «записи» —
            return len(_text)                                       #   просто делаем вид, что всё записали
        def flush(self):                                            # метод «сброса буфера» —
            pass                                                    #   ничего делать не нужно
        def isatty(self):                                           # консоль ли это —
            return False                                            #   нет, это заглушка

    for _name in ("stdout", "stderr"):                              # проверяем оба потока вывода
        _stream = getattr(sys, _name, None)                         # берём текущий поток
        if _stream is None:                                         # потока нет (нет консоли) —
            setattr(sys, _name, _SilentStream())                    #   подставляем заглушку
            continue                                                #   и переходим к следующему
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")   # включаем UTF-8 и замену символов
        except Exception:                                           # поток может не поддерживать настройку —
            pass                                                    #   тогда просто ничего не делаем


_make_output_safe()                                                 # выполняем сразу при запуске сервера

from flask import Flask, jsonify, request, send_from_directory       # веб-фреймворк
from flask_socketio import SocketIO, emit, join_room                 # обмен данными в реальном времени


# ---------------------------------------------------------------------------
# 2. ПУТИ И КОНСТАНТЫ
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent        # корень проекта (папка с этим файлом)
STATIC_DIR = BASE_DIR / "static"                  # служебные файлы сайта (иконки для страницы установки)
WWW_DIR = BASE_DIR / "www"                        # интерфейс приложения (тот же, что упакован в APK и EXE)
# WWW_DIR используется ТОЛЬКО в режиме предпросмотра (--serve-ui):
# обычно интерфейс лежит внутри приложений, а сервер отдаёт лишь данные.

# Папку с данными можно указать снаружи (флаг --data-dir). Это нужно настольному
# приложению: само приложение лежит в «Program Files», а данные — в профиле пользователя.
DATA_DIR = Path(os.environ.get("GEOMETRIC_DATA_DIR") or (BASE_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"                 # загруженные файлы (в чатах — зашифрованные!)
DB_FILE = DATA_DIR / "db.json"                    # файл «базы данных»

for _d in (STATIC_DIR, UPLOAD_DIR, DATA_DIR):     # создаём все нужные папки,
    _d.mkdir(parents=True, exist_ok=True)         # если их ещё нет

STORY_TTL = 24 * 60 * 60                          # срок жизни истории — 24 часа
SERVER_VERSION = "3.0"
# Версия сервера (приложение показывает её на экране подключения).
MAX_UPLOAD = 128 * 1024 * 1024                    # максимум 128 МБ на файл
SOCKETIO_JS_URL = "https://cdn.socket.io/4.7.5/socket.io.min.js"   # откуда взять клиент socket.io

DEFAULT_SETTINGS = {                              # настройки нового пользователя по умолчанию
    "theme": "dark",                              # тема: dark / light / amoled
    "sounds": True,                               # звуки сообщений и звонков
    "enterToSend": True,                          # отправлять сообщение по Enter
    "readReceipts": True,                         # отправлять ли галочки «прочитано»
    "hideOnline": False,                          # скрывать статус «в сети»
    "hideLastSeen": False,                        # скрывать «был(а) недавно»
    "storyVisibility": "all",                     # истории: all (всем) или contacts (только контактам)
    "notifications": True,                        # показывать уведомления браузера
    "storySeconds": 5,                            # сколько секунд показывать фото-историю
    "compactMode": False,                         # компактный список чатов
    "tabs": [],                                   # свои вкладки чатов (название + что показывать)
    "activeTab": "all",                           # какая вкладка была открыта последней
}

DB_LOCK = threading.RLock()                       # мьютекс: защищает базу от одновременной записи
SID_TO_USER = {}                                  # socket-соединение -> логин
TOKENS = {}                                       # токен сессии -> логин
CALLS = {}                                        # активные звонки: call_id -> данные


# ---------------------------------------------------------------------------
# 3. БАЗА ДАННЫХ (JSON-файл)
# ---------------------------------------------------------------------------
def load_db():
    """Читает базу. Если файла нет — создаёт пустую (никаких тестовых аккаунтов!)."""
    if DB_FILE.exists():                                          # файл существует?
        try:                                                      # пробуем прочитать
            with open(DB_FILE, "r", encoding="utf-8") as f:       #   открываем
                db = json.load(f)                                 #   разбираем JSON
                db.setdefault("users", {})                        #   на всякий случай дозаполняем структуру,
                db.setdefault("chats", {})                        #   если файл из старой версии
                db.setdefault("rooms", {})                        #   комнаты: группы и каналы
                db.setdefault("stories", [])                      #
                return db                                         #   отдаём базу
        except Exception:                                         # файл битый —
            pass                                                  #   начнём с пустой
    return {"users": {}, "chats": {}, "rooms": {}, "stories": []}   # пустая база (никаких тестовых аккаунтов)


DB = load_db()                                    # загружаем базу при старте


def load_into_memory():
    """Перечитывает базу из файла (используется, если папку данных задали флагом --data-dir)."""
    global DB                                                    # меняем глобальную переменную
    DB = load_db()                                               #   читаем базу заново


def save_db():
    """Атомарно сохраняет базу: сначала во временный файл, потом подменяет основной."""
    with DB_LOCK:                                                 # только по одному потоку за раз
        tmp = DB_FILE.with_suffix(".tmp")                         # временный файл
        with open(tmp, "w", encoding="utf-8") as f:               # пишем в него
            json.dump(DB, f, ensure_ascii=False, indent=2)        # сериализуем (русские буквы не экранируются)
        os.replace(tmp, DB_FILE)                                  # подменяем атомарно — база не «побьётся»


# ---------------------------------------------------------------------------
# 4. ПАРОЛИ, ТОКЕНЫ, КЛЮЧИ
# ---------------------------------------------------------------------------
def hash_password(password, salt=None):
    """Превращает пароль в необратимый хеш (сам пароль нигде не хранится)."""
    salt = salt or secrets.token_hex(16)                          # соль — 32 случайных символа
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
    # PBKDF2-SHA256, 200 000 итераций: восстановить пароль по хешу практически невозможно.
    return f"{salt}${h}"                                          # храним «соль$хеш» одной строкой


def verify_password(password, stored):
    """Сравнивает введённый пароль с сохранённым хешем."""
    try:                                                          # защищаемся от битых записей
        salt, _ = stored.split("$", 1)                            # отделяем соль
    except Exception:                                             #
        return False                                              #   битая запись — не пускаем
    return secrets.compare_digest(hash_password(password, salt), stored)   # сравнение «постоянного времени»


def new_token():
    """Создаёт токен сессии (по нему сервер узнаёт вошедшего)."""
    return secrets.token_urlsafe(32)                              # 32 случайных байта в текстовом виде


def user_by_token(token):
    """Возвращает логин по токену или None."""
    name = TOKENS.get(token or "")                                # ищем логин в памяти
    return name if name in DB["users"] else None                  # отдаём только если пользователь существует


# ---------------------------------------------------------------------------
# 5. ПОЛЬЗОВАТЕЛИ (с учётом приватности!)
# ---------------------------------------------------------------------------
def contacts_of(username):
    """Люди, с которыми у тебя есть переписка. Только им видно твой онлайн-статус."""
    people = set()                                                # множество логинов
    for cid in DB["chats"].keys():                                # перебираем все чаты
        parts = cid.split("|")                                    #   ID чата имеет вид «login1|login2»
        if username in parts:                                     #   если это мой чат,
            people.update(p for p in parts if p != username)      #   добавляем собеседника
    return people                                                 # возвращаем список контактов


def public_user(username, viewer=None):
    """Карточка пользователя для клиента. Никаких паролей и приватных ключей!

    Важно: онлайн-статус и «последний раз в сети» отдаются только если пользователь
    сам это разрешил в настройках (hideOnline / hideLastSeen) и только его контактам.
    """
    u = DB["users"].get(username)                                 # берём запись из базы
    if not u:                                                     # пользователя нет —
        return None                                               #   ничего не возвращаем
    is_me = viewer == username                                    # смотрю свой профиль?
    is_contact = viewer in contacts_of(username) if viewer else False   # смотрит мой контакт?
    st = u.get("settings", {})                                    # настройки приватности пользователя
    show_presence = is_me or (is_contact and not st.get("hideOnline"))     # показывать ли «в сети»
    show_last = is_me or (is_contact and not st.get("hideLastSeen"))       # показывать ли «был(а) ...»
    return {
        "username": username,                                     # логин
        "name": u.get("name", username),                          # имя
        "bio": u.get("bio", ""),                                  # описание профиля
        "avatar": u.get("avatar", {"kind": "color", "value": "#7f5af0"}),  # аватар: цвет или фото
        "pub": u.get("pub"),                                      # ПУБЛИЧНЫЙ ключ шифрования (нужен собеседнику)
        "online": bool(u.get("online")) if show_presence else False,          # статус «в сети»
        "last_seen": u.get("last_seen") if show_last else None,   # «был(а) недавно» (или None — скрыто)
        "hidden_presence": not show_presence,                     # флаг: статус скрыт (клиент покажет «недавно»)
    }


def me_payload(username):
    """Мой собственный профиль (плюс когда зарегистрирован и есть ли ключи)."""
    u = DB["users"][username]                                     # моя запись
    card = public_user(username, username)                        # карточка «для себя»
    card["settings"] = u.get("settings", dict(DEFAULT_SETTINGS))  # добавляем настройки
    card["has_keys"] = bool(u.get("pub") and u.get("encPriv"))    # сгенерированы ли ключи шифрования
    card["created"] = u.get("created", 0)                         # дата регистрации
    return card                                                   # отдаём


# ---------------------------------------------------------------------------
# 6. ЧАТЫ И СООБЩЕНИЯ
# ---------------------------------------------------------------------------
def chat_id(a, b):
    """ID личного чата — одинаковый с обеих сторон."""
    return "|".join(sorted([a, b]))                               # сортируем логины и соединяем


def get_chat(cid):
    """Возвращает чат, создавая его при необходимости."""
    return DB["chats"].setdefault(cid, {"messages": []})          # словарь чатов + создание пустого


def chats_of(username):
    """Список ID чатов пользователя."""
    return [cid for cid in DB["chats"].keys() if username in cid.split("|")]


def last_message(cid):
    """Последнее сообщение чата (для превью в списке)."""
    msgs = DB["chats"].get(cid, {}).get("messages", [])           # все сообщения
    return msgs[-1] if msgs else None                             # последнее или None


def unread_count(cid, me):
    """Сколько сообщений я ещё не прочитал (сервер считает только число — текст ему недоступен)."""
    msgs = DB["chats"].get(cid, {}).get("messages", [])           # сообщения чата
    return sum(1 for m in msgs if m["from"] != me and m["to"] == me and not m.get("read"))


def chat_list_for(username):
    """Список чатов для сайдбара: собеседник, последний «конверт», непрочитанные, комнаты."""
    out = []                                                      # сюда собираем результат
    for cid in chats_of(username):                                # по всем моим личным чатам
        parts = cid.split("|")                                    # логины участников
        saved = len(parts) == 2 and parts[0] == parts[1]          # «Избранное» — чат с самим собой
        peer = username if saved else next((p for p in parts if p != username), "")   # кто собеседник
        last = last_message(cid)                                  # последнее сообщение
        out.append({
            "kind": "saved" if saved else "dm",                   # вид строки: Избранное или личный чат
            "id": cid,                                            # ID чата
            "with": peer,                                         # логин собеседника
            "peer": public_user(peer, username),                  # его карточка (с публичным ключом!)
            "last": last,                                         # последнее сообщение — «конверт» (клиент расшифрует сам)
            "ts": last["ts"] if last else 0,                      # время (для сортировки)
            "unread": unread_count(cid, username),                # непрочитанных
        })
    out.extend(room_list_for(username))                           # добавляем группы и каналы
    out.sort(key=lambda c: c["ts"], reverse=True)                 # свежие чаты сверху
    return out                                                    # отдаём


# ------------------------------- ИСТОРИИ -----------------------------------
def active_stories():
    """Истории младше 24 часов."""
    now = time.time()                                             # текущее время
    return [s for s in DB["stories"] if now - s["ts"] < STORY_TTL]   # только свежие


def story_visible_to(story, viewer):
    """Можно ли этому зрителю видеть эту историю (учитываем настройку автора)."""
    author = story["author"]                                      # автор истории
    if author == viewer:                                          # своя история — всегда видна
        return True
    mode = DB["users"].get(author, {}).get("settings", {}).get("storyVisibility", "all")
    # Настройка автора: «всем» или «только контактам».
    if mode == "contacts":                                        # если «только контактам» —
        return viewer in contacts_of(author)                      #   показываем лишь тем, с кем есть переписка
    return True                                                   # иначе — всем


def grouped_stories(viewer):
    """Истории, сгруппированные по авторам, с отметками «просмотрено»."""
    groups = {}                                                   # автор -> группа
    for s in sorted(active_stories(), key=lambda x: x["ts"]):     # старые истории первыми
        if not story_visible_to(s, viewer):                       # история скрыта от зрителя —
            continue                                              #   пропускаем
        g = groups.setdefault(s["author"], {
            "author": s["author"],                                # логин автора
            "user": public_user(s["author"], viewer),             # его карточка
            "items": [],                                          # список историй
            "seen": True,                                         # «всё просмотрено» (уточним ниже)
            "ts": s["ts"],                                        # время последней истории
        })
        g["items"].append({
            "id": s["id"],                                        # ID истории
            "kind": s["kind"],                                    # image или video
            "url": s["url"],                                      # файл
            "text": s.get("text", ""),                            # подпись
            "ts": s["ts"],                                        # время
            "views": len(s.get("views", [])),                     # число просмотров
            "viewers": s.get("views", [])[-8:],                   # последние зрители (видно только автору)
            "seen": viewer in s.get("views", []),                 # смотрел ли я
        })
        g["ts"] = max(g["ts"], s["ts"])                           # обновляем время группы
        if viewer not in s.get("views", []):                      # если есть непросмотренная история —
            g["seen"] = False                                     #   группа помечается «новая»
    groups.pop(viewer, None)                                      # свои истории в общую ленту не кладём
    return sorted(groups.values(), key=lambda g: (g["seen"], -g["ts"]))   # непросмотренные — впереди


def my_stories_payload(username):
    """Мои истории (для своей ленты и счётчика просмотров)."""
    mine = [s for s in active_stories() if s["author"] == username]
    return [{
        "id": s["id"], "author": s["author"], "kind": s["kind"], "url": s["url"],
        "text": s.get("text", ""), "ts": s["ts"],
        "views": len(s.get("views", [])),                         # число просмотров
        "viewers": s.get("views", []),                            # кто смотрел
    } for s in sorted(mine, key=lambda x: x["ts"])]


def broadcast_stories():
    """Рассылает истории персонально: у каждого свой набор (свои не показываем, «просмотрено» разное)."""
    seen = set()                                                  # чтобы не слать дважды одному человеку
    for uname in list(SID_TO_USER.values()):                      # по всем подключённым людям
        if uname in seen:                                         # уже отправляли —
            continue                                              #   пропускаем
        seen.add(uname)                                           # отмечаем
        socketio.emit("stories_update", {
            "stories": grouped_stories(uname),                    # чужие истории
            "my_stories": my_stories_payload(uname),              # свои истории
        }, room=f"u:{uname}")                                     # в личную комнату


def broadcast_presence(username):
    """Сообщает об изменении статуса ТОЛЬКО контактам (а не всем подряд!)."""
    card = {"users": [public_user(username, viewer) for viewer in contacts_of(username)]}
    # Готовим персональные карточки: каждый контакт увидит статус согласно настройкам приватности.
    for viewer in contacts_of(username):                          # по каждому контакту
        socketio.emit("users_update", {"users": [public_user(username, viewer)]}, room=f"u:{viewer}")
        # Отправляем ему только этого пользователя — списки всех людей по сети не гуляют.


# ---------------------------------------------------------------------------
# 7. ВЕБ-СЕРВЕР
# ---------------------------------------------------------------------------
# Режим предпросмотра включается флагом --serve-ui (по умолчанию выключен):
# в нём сервер дополнительно отдаёт файлы интерфейса, чтобы приложение можно было
# открыть в браузере без сборки APK/EXE. В обычной работе интерфейс лежит внутри
# приложений, и сервер отдаёт только данные.
SERVE_UI = "--serve-ui" in sys.argv                       # включён ли режим предпросмотра
if SERVE_UI:                                              # режим предпросмотра —
    app = Flask(__name__, static_folder=str(WWW_DIR), static_url_path="")   #   файлы интерфейса из папки www
else:                                                     # обычный режим —
    app = Flask(__name__, static_folder=None)             #   сервер — только API: файлы интерфейса не раздаёт
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD                     # лимит размера загрузки
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")        # WebSocket-сервер


def ensure_socketio_client():
    """Скачивает socket.io.min.js один раз (нужен интернет только при первом запуске)."""
    target = STATIC_DIR / "socket.io.min.js"                      # куда положить
    if target.exists() and target.stat().st_size > 10_000:        # уже есть —
        return                                                    #   выходим
    try:                                                          # пробуем скачать
        print("[GeoMetric] Скачиваю socket.io.min.js …")
        with urllib.request.urlopen(SOCKETIO_JS_URL, timeout=20) as r:
            target.write_bytes(r.read())
        print("[GeoMetric] Готово.")
    except Exception as e:                                        # нет интернета —
        print(f"[GeoMetric] Не удалось скачать socket.io.min.js: {e}")
        print("[GeoMetric] Положи файл вручную: static/socket.io.min.js")


# ------------------ СЛУЖЕБНЫЕ АДРЕСА (СЕРВЕР — ТОЛЬКО API) -----------------


@app.get("/")
def status_page():
    """Главная страница сервера.

    В обычном режиме здесь только служебная справка (JSON) — интерфейса мессенджера нет,
    он лежит внутри приложения (APK/EXE). Если сервер запущен с флагом --serve-ui
    (предпросмотр), то по этому адресу открывается сам интерфейс приложения."""
    if SERVE_UI:                                              # режим предпросмотра —
        return send_from_directory(WWW_DIR, "index.html")      #   показываем интерфейс приложения
    return jsonify({
        "geometric": True,                                        # признак «это действительно сервер GeoMetric»
        "name": "GeoMetric Server",                               # название сервиса
        "version": SERVER_VERSION,                                # версия сервера
        "users": len(DB["users"]),                                # сколько аккаунтов зарегистрировано
        "e2ee": True,                                             # сервер хранит только шифротексты
        "time": time.time(),                                      # текущее время сервера
    })


@app.get("/api/status")
def api_status():
    """Проверка сервера приложением: приложение спрашивает этот адрес перед подключением,
    чтобы человек не ввёл по ошибке чужой сервер."""
    return jsonify({
        "geometric": True,                                        # «я — сервер GeoMetric»
        "version": SERVER_VERSION,                                # версия
        "users": len(DB["users"]),                                # число аккаунтов
        "e2ee": True,                                             # поддержка сквозного шифрования
    })


@app.get("/uploads/<path:filename>")
def uploaded_file(filename):
    """Отдаёт загруженный файл (фото из чата, аватар, история).

    Файлы из чата лежат здесь в зашифрованном виде — сервер отдаёт их как есть,
    расшифровывает уже приложение на устройстве получателя."""
    return send_from_directory(UPLOAD_DIR, filename)               # безопасная отдача файла из папки загрузок


@app.after_request
def allow_cross_origin(resp):
    """Разрешает приложению обращаться к серверу (CORS).

    Зачем это нужно: интерфейс теперь живёт не на сервере, а внутри приложения,
    поэтому запросы приходят с «другого адреса». Без этих заголовков браузер внутри
    приложения запретил бы обращения к серверу (и не работали бы ни чаты, ни звонки)."""
    resp.headers["Access-Control-Allow-Origin"] = "*"              # разрешаем обращения с любого адреса приложения
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"  # какие заголовки приложение может присылать
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"   # какие методы разрешены
    resp.headers["Access-Control-Max-Age"] = "86400"               # запоминаем разрешение на сутки
    return resp


# ------------------------------- АККАУНТЫ ---------------------------------
@app.post("/api/register")
def api_register():
    """Регистрация. Клиент присылает свою публичную пару ключей (E2EE готовится в браузере)."""
    data = request.get_json(silent=True) or {}                    # читаем данные
    username = (data.get("username") or "").strip().lower()       # логин — латиница, в нижнем регистре
    password = data.get("password") or ""                         # пароль
    name = (data.get("name") or username).strip()[:40]            # отображаемое имя
    pub = data.get("pub")                                         # публичный ключ шифрования (JWK)
    enc_priv = data.get("encPriv")                                # приватный ключ, зашифрованный паролем
    kek_salt = data.get("kekSalt")                                # соль для вывода ключа из пароля

    if len(username) < 3 or not username.isalnum():               # валидация логина
        return jsonify({"error": "Логин: минимум 3 символа, только латинские буквы и цифры"}), 400
    if len(password) < 6:                                         # валидация пароля
        return jsonify({"error": "Пароль: минимум 6 символов"}), 400
    if not (pub and enc_priv and kek_salt):                       # без ключей регистрировать нельзя:
        return jsonify({"error": "Не сгенерированы ключи шифрования"}), 400
        # (так мы гарантируем, что переписка сразу защищена)

    with DB_LOCK:                                                 # дальше меняем базу
        if username in DB["users"]:                               # логин занят
            return jsonify({"error": "Этот логин уже занят"}), 409
        palette = ["#7f5af0", "#2cb67d", "#ff8c42", "#e53170", "#00b8d9", "#8a5cf6", "#f4a261", "#4cc9f0"]
        DB["users"][username] = {
            "username": username,                                 # логин
            "name": name,                                         # имя
            "bio": "",                                            # описание профиля
            "avatar": {"kind": "color", "value": palette[len(DB["users"]) % len(palette)]},   # аватар-цвет
            "password": hash_password(password),                  # хеш пароля (сам пароль не храним)
            "pub": pub,                                           # публичный ключ (открытая часть)
            "encPriv": enc_priv,                                  # приватный ключ под паролем — сервер его не прочитает
            "kekSalt": kek_salt,                                  # соль вывода ключа
            "settings": dict(DEFAULT_SETTINGS),                   # настройки по умолчанию
            "created": time.time(),                               # дата регистрации
            "online": False,                                      # сейчас не в сети
            "last_seen": time.time(),                             # время последней активности
        }
        save_db()                                                 # сохраняем базу
    token = new_token()                                           # токен сессии
    TOKENS[token] = username                                      # запоминаем
    print(f"[GeoMetric] Зарегистрирован новый пользователь: {username}")   # в лог пишем ТОЛЬКО логин
    return jsonify({"token": token, "me": me_payload(username)})   # отдаём токен и профиль


@app.post("/api/login")
def api_login():
    """Вход. Дополнительно отдаём зашифрованный приватный ключ — клиент расшифрует его паролем."""
    data = request.get_json(silent=True) or {}                    # читаем данные
    username = (data.get("username") or "").strip().lower()       # логин
    password = data.get("password") or ""                         # пароль
    u = DB["users"].get(username)                                 # ищем пользователя
    if not u or not verify_password(password, u["password"]):     # нет такого или пароль неверный
        return jsonify({"error": "Неверный логин или пароль"}), 401
    token = new_token()                                           # новый токен
    TOKENS[token] = username                                      # запоминаем
    return jsonify({
        "token": token,                                           # токен для последующих запросов
        "me": me_payload(username),                               # мой профиль
        "keys": {                                                 # ключи для расшифровки истории:
            "encPriv": u.get("encPriv"),                          #   приватный ключ (зашифрован паролем)
            "kekSalt": u.get("kekSalt"),                          #   соль для вывода ключа из пароля
            "pub": u.get("pub"),                                  #   свой публичный ключ
        },
    })


@app.get("/api/keys")
def api_keys():
    """Отдаёт зашифрованный приватный ключ (например, после перезагрузки страницы)."""
    username = user_by_token(request.args.get("token"))           # проверяем токен
    if not username:                                              # не авторизован —
        return jsonify({"error": "unauthorized"}), 401            #   отказ
    u = DB["users"][username]                                     # моя запись
    return jsonify({"encPriv": u.get("encPriv"), "kekSalt": u.get("kekSalt"), "pub": u.get("pub")})


@app.post("/api/password")
def api_password():
    """Смена пароля: сервер меняет хеш, а клиент заново шифрует приватный ключ новым паролем."""
    data = request.get_json(silent=True) or {}                    # читаем данные
    username = user_by_token(data.get("token"))                   # кто запрашивает
    if not username:                                              # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    old = data.get("old") or ""                                   # старый пароль
    new = data.get("new") or ""                                   # новый пароль
    if not verify_password(old, DB["users"][username]["password"]):   # старый пароль неверный
        return jsonify({"error": "Старый пароль неверный"}), 403
    if len(new) < 6:                                              # новый слишком короткий
        return jsonify({"error": "Новый пароль: минимум 6 символов"}), 400
    if not (data.get("encPriv") and data.get("kekSalt")):         # клиент должен прислать ключ, перешифрованный новым паролем
        return jsonify({"error": "Не передан перешифрованный ключ"}), 400
    with DB_LOCK:                                                 # меняем данные в базе
        DB["users"][username]["password"] = hash_password(new)    # новый хеш пароля
        DB["users"][username]["encPriv"] = data["encPriv"]        # приватный ключ под новым паролем
        DB["users"][username]["kekSalt"] = data["kekSalt"]        # новая соль
        save_db()                                                 # сохраняем
    print(f"[GeoMetric] Пользователь {username} сменил пароль")
    return jsonify({"ok": True})


@app.post("/api/keys/replace")
def api_keys_replace():
    """Полная замена ключей шифрования. Нужна, если пользователь считает, что устройство взломано.

    Сервер принимает новый публичный ключ и приватный, зашифрованный паролем.
    Старые сообщения после этого прочитать нельзя — это ожидаемая цена безопасности.
    """
    data = request.get_json(silent=True) or {}                    # читаем данные
    username = user_by_token(data.get("token"))                   # кто запрашивает
    if not username:                                              # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    if not (data.get("pub") and data.get("encPriv") and data.get("kekSalt")):   # ключей нет
        return jsonify({"error": "Не переданы новые ключи"}), 400
    with DB_LOCK:                                                 # пишем в базу
        DB["users"][username]["pub"] = data["pub"]                 # новый публичный ключ
        DB["users"][username]["encPriv"] = data["encPriv"]         # новый приватный (зашифрованный)
        DB["users"][username]["kekSalt"] = data["kekSalt"]         # новая соль
        save_db()                                                 #
    print(f"[GeoMetric] Пользователь {username} сменил ключи шифрования")
    return jsonify({"ok": True})


@app.get("/api/me")
def api_me():
    """Кто я + мои чаты + истории (используется при перезагрузке страницы)."""
    username = user_by_token(request.args.get("token"))            # проверка токена
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({
        "me": me_payload(username),                               # профиль и настройки
        "chats": chat_list_for(username),                         # чаты с собеседниками
        "stories": grouped_stories(username),                     # чужие истории
        "my_stories": my_stories_payload(username),               # мои истории
    })


@app.get("/api/find")
def api_find():
    """Поиск людей по логину или имени. Отдаём только совпадения — весь список юзеров не выдаём."""
    username = user_by_token(request.args.get("token"))           # проверка токена
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    q = (request.args.get("q") or "").strip().lower()[:32]        # поисковый запрос
    if len(q) < 2:                                                # слишком короткий запрос
        return jsonify({"users": []})                             #   → пустой результат
    found = []                                                    # найденные люди
    for name, u in DB["users"].items():                           # перебираем базу
        if name == username:                                      # себя не показываем
            continue
        if q in name or q in (u.get("name", "").lower()):         # совпадение по логину или имени
            card = public_user(name, username)                    # карточка человека
            card["pub"] = u.get("pub")                            # ПУБЛИЧНЫЙ ключ шифрования (он не секретный — им только шифруют)
            found.append(card)                                    # добавляем карточку
        if len(found) >= 20:                                      # не больше 20 результатов
            break
    return jsonify({"users": found})


@app.post("/api/profile")
def api_profile():
    """Изменение профиля: имя, описание, аватар, настройки."""
    data = request.get_json(silent=True) or {}                    # читаем данные
    username = user_by_token(data.get("token"))                   # кто меняет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    with DB_LOCK:                                                 # пишем в базу
        u = DB["users"][username]                                 # моя запись
        if "name" in data:                                        # если пришло новое имя
            u["name"] = (data["name"] or username).strip()[:40]   #   сохраняем (не длиннее 40 символов)
        if "bio" in data:                                         # описание профиля
            u["bio"] = (data["bio"] or "").strip()[:200]          #   до 200 символов
        if "avatar" in data and isinstance(data["avatar"], dict): # аватар: либо цвет, либо фото
            kind = data["avatar"].get("kind")                     #   вид аватара
            if kind == "color":                                   #   цветной кружок
                u["avatar"] = {"kind": "color", "value": str(data["avatar"].get("value", "#7f5af0"))[:16]}
            elif kind == "photo":                                 #   картинка из /uploads
                u["avatar"] = {"kind": "photo", "value": str(data["avatar"].get("value", ""))[:300]}
        if "settings" in data and isinstance(data["settings"], dict):   # настройки
            s = u.setdefault("settings", dict(DEFAULT_SETTINGS))        #   текущие настройки
            for key in DEFAULT_SETTINGS.keys():                         #   принимаем только известные ключи
                if key in data["settings"]:                             #   (чтобы нельзя было записать что угодно)
                    s[key] = data["settings"][key]
        save_db()                                                 # сохраняем
    return jsonify({"me": me_payload(username)})                   # отдаём обновлённый профиль


@app.post("/api/upload")
def api_upload():
    """Принимает файл. Для чатов файл приходит УЖЕ ЗАШИФРОВАННЫМ (сервер видит просто байты)."""
    username = user_by_token(request.form.get("token") or request.args.get("token"))
    if not username:                                              # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    file = request.files.get("file")                              # сам файл
    if not file or not file.filename:                             # файла нет
        return jsonify({"error": "Файл не передан"}), 400
    enc = (request.form.get("enc") or request.args.get("enc")) == "1"   # это зашифрованный блоб?
    if enc:                                                       # зашифрованный файл
        fname = f"enc_{int(time.time())}_{uuid.uuid4().hex[:10]}.bin"    #   имя без исходного расширения —
        kind = "file"                                             #   сервер даже не знает, фото это или видео
    else:                                                         # обычный файл (аватар, история)
        ext = Path(file.filename).suffix.lower()[:10]             #   берём расширение
        fname = f"{int(time.time())}_{uuid.uuid4().hex[:8]}{ext}" #   уникальное имя
        kind = "video" if (mimetypes.guess_type(fname)[0] or "").startswith("video") else "image"
    path = UPLOAD_DIR / fname                                     # путь сохранения
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)                 # на всякий случай создаём папку загрузок
    file.save(path)                                               # сохраняем
    return jsonify({"url": f"/uploads/{fname}", "size": path.stat().st_size, "enc": enc, "kind": kind})


@app.get("/api/history")
def api_history():
    """История переписки: набор зашифрованных «конвертов» (сервер их не читает)."""
    username = user_by_token(request.args.get("token"))           # проверка токена
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    other = request.args.get("with", "")                          # с кем переписка
    cid = chat_id(username, other)                                # ID чата
    msgs = DB["chats"].get(cid, {}).get("messages", [])           # сообщения
    return jsonify({"messages": msgs[-800:], "chat": cid, "peer": public_user(other, username)})


@app.get("/api/stories")
def api_stories():
    """Чужие истории."""
    username = user_by_token(request.args.get("token"))           # проверка токена
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"stories": grouped_stories(username)})


@app.get("/api/my_stories")
def api_my_stories():
    """Мои истории."""
    username = user_by_token(request.args.get("token"))           # проверка токена
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    return jsonify({"stories": my_stories_payload(username)})


# ---------------------------------------------------------------------------
# 8. СОБЫТИЯ В РЕАЛЬНОМ ВРЕМЕНИ
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    """Кто-то подключился (авторизация будет отдельным шагом)."""
    print(f"[GeoMetric] Новое соединение: {request.sid}")         # лог без приватных данных


@socketio.on("disconnect")
def on_disconnect():
    """Соединение закрылось — помечаем человека «не в сети» (если у него нет других устройств)."""
    username = SID_TO_USER.pop(request.sid, None)                 # кто отключился
    if not username:                                              # анонимное соединение
        return
    if username in SID_TO_USER.values():                          # есть ещё открытые вкладки/устройства
        return                                                    #   статус не снимаем
    with DB_LOCK:                                                 # меняем базу
        DB["users"][username]["online"] = False                   #   офлайн
        DB["users"][username]["last_seen"] = time.time()          #   время последней активности
        save_db()
    broadcast_presence(username)                                  # сообщаем ТОЛЬКО контактам
    # Завершаем незакрытые звонки, чтобы в журнале не осталось «вечных» звонков.
    for call_id, c in list(CALLS.items()):
        if username in (c["from"], c["to"]):                      # этот человек участвовал в звонке
            finish_call(call_id, "canceled" if c["from"] == username else "no_answer")


@socketio.on("auth")
def on_auth(data):
    """Авторизация: проверяем токен, включаем «онлайн», отдаём чаты и истории."""
    username = user_by_token((data or {}).get("token"))           # проверяем токен
    if not username:                                              # токен неверный
        emit("auth_error", {"error": "Сессия истекла"})           #   просим войти заново
        return
    SID_TO_USER[request.sid] = username                           # привязываем соединение
    join_room(f"u:{username}")                                    # входим в личную комнату
    with DB_LOCK:                                                 # отметим себя онлайн
        DB["users"][username]["online"] = True                    #
        DB["users"][username]["last_seen"] = time.time()          #
        save_db()                                                 #
    emit("auth_ok", {                                             # отвечаем этому клиенту:
        "me": me_payload(username),                               #   мой профиль и настройки
        "chats": chat_list_for(username),                         #   мои чаты
        "stories": grouped_stories(username),                     #   чужие истории
        "my_stories": my_stories_payload(username),               #   свои истории
    })
    broadcast_presence(username)                                  # контактам: «я в сети»


@socketio.on("send_message")
def on_send_message(data):
    """Новое сообщение. Сервер обращается с содержимым как с «чёрным ящиком»."""
    username = SID_TO_USER.get(request.sid)                       # отправитель
    if not username:                                              # не авторизован
        return
    to = (data or {}).get("to", "")                               # получатель
    if to not in DB["users"]:                                     # получателя нет
        return
    # Отправка самому себе разрешена: так работает «Избранное» — личная заметка/файл.
    kind = (data or {}).get("kind", "text")                       # тип: text или media
    if kind not in ("text", "media"):                             # другие типы клиент присылать не должен
        return
    e2e = (data or {}).get("e2e")                                 # зашифрованный «конверт» (сервер не читает)
    plain = (data or {}).get("plain")                             # незашифрованный вариант (только в режиме без E2EE)
    if not e2e and not plain:                                     # ни того, ни другого —
        return                                                    #   отправлять нечего
    cid = chat_id(username, to)                                   # ID чата
    msg = {
        "id": uuid.uuid4().hex,                                   # уникальный ID
        "chat": cid,                                              # чат
        "from": username,                                         # от кого
        "to": to,                                                 # кому
        "kind": kind,                                             # тип сообщения
        "e2e": e2e,                                               # ПУСТО ПО СМЫСЛУ ДЛЯ СЕРВЕРА: зашифрованные байты
        "plain": plain,                                           # используется только если шифрование недоступно в браузере
        "call": None,                                             # для журнала звонков (заполняется отдельно)
        "ts": time.time(),                                        # время отправки
        "read": False,                                            # прочитано?
    }
    with DB_LOCK:                                                 # пишем в базу
        get_chat(cid)["messages"].append(msg)                     #
        DB["users"][username]["last_seen"] = msg["ts"]            #
        save_db()                                                 #
    emit("new_message", msg, room=f"u:{to}")                      # получателю (на все его устройства)
    emit("new_message", msg, room=f"u:{username}")                # и себе (синхронизация вкладок)
    # Обновляем СПИСОК ЧАТОВ у обоих: если переписка только началась, у получателя
    # должен появиться новый диалог (иначе сообщение «придёт в никуда»).
    emit("chats_update", {"chats": chat_list_for(to)}, room=f"u:{to}")
    emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")
    # В консоль выводим только метаданные: кто, кому, сколько байт. Содержимое нам недоступно.
    print(f"[GeoMetric] {username} → {to}: {kind}, "
          f"{len((e2e or {}).get('c', '') or (plain or {}).get('text', ''))} симв. шифротекста")


@socketio.on("typing")
def on_typing(data):
    """«Печатает…» — событие уходит только собеседнику."""
    username = SID_TO_USER.get(request.sid)                       # кто печатает
    to = (data or {}).get("to")                                   # кому
    if username and to:                                           # данные на месте
        emit("typing", {"from": username}, room=f"u:{to}")        # сообщаем собеседнику


@socketio.on("mark_read")
def on_mark_read(data):
    """Я открыл чат — мои входящие помечаются прочитанными (галочки у собеседника)."""
    username = SID_TO_USER.get(request.sid)                       # кто читает
    other = (data or {}).get("with")                              # с кем чат
    if not username or not other:                                 # нет данных
        return
    cid = chat_id(username, other)                                # ID чата
    changed = []                                                  # ID прочитанных сообщений
    with DB_LOCK:                                                 # работа с базой
        for m in get_chat(cid)["messages"]:                       # по всем сообщениям
            if m["to"] == username and not m.get("read"):         # адресовано мне и не прочитано
                m["read"] = True                                  #   помечаем
                changed.append(m["id"])                           #   запоминаем
        if changed:                                               #
            save_db()                                             #
    if changed:                                                   # если что-то изменилось,
        payload = {"chat": cid, "by": username, "ids": changed}   # сообщаем обоим:
        emit("messages_read", payload, room=f"u:{username}")      #
        emit("messages_read", payload, room=f"u:{other}")         #
        emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")


@socketio.on("get_history")
def on_get_history(data):
    """Клиент просит историю переписки."""
    username = SID_TO_USER.get(request.sid)                       # кто просит
    other = (data or {}).get("with")                              # с кем
    if not username or not other:                                 # нет данных
        return
    cid = chat_id(username, other)                                # ID чата
    msgs = DB["chats"].get(cid, {}).get("messages", [])           # сообщения
    emit("history", {"chat": cid, "with": other, "messages": msgs[-800:],
                     "peer": public_user(other, username)})       # отдаём «конверты» и карточку собеседника


@socketio.on("get_chats")
def on_get_chats():
    """Клиент просит обновить список чатов."""
    username = SID_TO_USER.get(request.sid)                       # кто просит
    if username:                                                  #
        emit("chats_update", {"chats": chat_list_for(username)})  #


# ------------------------------- ИСТОРИИ -----------------------------------
@socketio.on("post_story")
def on_post_story(data):
    """Публикация истории (фото или видео + подпись)."""
    username = SID_TO_USER.get(request.sid)                       # автор
    url = (data or {}).get("url")                                 # ссылка на файл
    if not username or not url:                                   # нет данных
        return
    story = {
        "id": uuid.uuid4().hex,                                   # ID истории
        "author": username,                                       # автор
        "kind": (data or {}).get("kind", "image"),                # image или video
        "url": url,                                               # файл
        "text": ((data or {}).get("text") or "").strip()[:200],    # подпись
        "ts": time.time(),                                        # время публикации
        "views": [],                                              # список зрителей
    }
    with DB_LOCK:                                                 # пишем в базу
        DB["stories"].append(story)                               #
        DB["stories"] = active_stories()                          #   заодно убираем просроченные
        save_db()                                                 #
    broadcast_stories()                                           # рассылаем всем (персонально)
    print(f"[GeoMetric] {username} опубликовал историю")


@socketio.on("view_story")
def on_view_story(data):
    """Просмотр истории — увеличиваем счётчик."""
    username = SID_TO_USER.get(request.sid)                       # зритель
    story_id = (data or {}).get("id")                             # ID истории
    if not username or not story_id:                              # нет данных
        return
    changed = False                                               # изменился ли счётчик
    with DB_LOCK:                                                 #
        for s in DB["stories"]:                                   #
            if s["id"] == story_id and username not in s["views"]:    # нашли и ещё не считали
                s["views"].append(username)                       #   записываем зрителя
                save_db()                                         #
                changed = True                                    #
                break                                             #
    if changed:                                                   # если счётчик изменился —
        broadcast_stories()                                       #   обновляем истории у всех


@socketio.on("delete_story")
def on_delete_story(data):
    """Автор удаляет свою историю."""
    username = SID_TO_USER.get(request.sid)                       # кто удаляет
    story_id = (data or {}).get("id")                             # ID истории
    if not username or not story_id:                              #
        return                                                    #
    with DB_LOCK:                                                 #
        DB["stories"] = [s for s in DB["stories"]                 # оставляем все, кроме своей удаляемой
                         if not (s["id"] == story_id and s["author"] == username)]
        save_db()                                                 #
    broadcast_stories()                                           #


# --------------------------- ЗВОНКИ + ЖУРНАЛ -------------------------------
# Сервер здесь — «телефонная станция»: пересылает технические сигналы (SDP/ICE),
# а также ведёт журнал звонков, который виден прямо в переписке:
#   исходящий, входящий, пропущенный, отклонённый, отменённый, занято.
def upsert_call_message(call, status, duration=None):
    """Создаёт или обновляет запись звонка в переписке и сообщает об этом обоим участникам."""
    cid = chat_id(call["from"], call["to"])                       # чат звонящего и вызываемого
    with DB_LOCK:                                                 # пишем в базу
        chat = get_chat(cid)                                      # чат
        msg = next((m for m in chat["messages"] if m["id"] == call["log_id"]), None)   # ищем запись
        call_info = {
            "status": status,                                     # dialing / answered / missed / declined / canceled / no_answer / busy
            "video": call["kind"] == "video",                     # видеозвонок или аудио
            "duration": duration or 0,                            # длительность разговора в секундах
            "ts": call["started"],                                # когда начался звонок
        }
        if msg:                                                   # запись уже есть —
            msg["call"] = call_info                               #   обновляем её статус
            msg["ts"] = call["started"]                           #   время начала звонка
        else:                                                     # записи нет —
            msg = {                                               #   создаём новую
                "id": call["log_id"],                             #   ID
                "chat": cid,                                      #   чат
                "from": call["from"],                             #   кто звонил
                "to": call["to"],                                 #   кому
                "kind": "call",                                   #   тип «звонок»
                "e2e": None,                                      #   шифровать тут нечего: это служебная запись
                "plain": None,                                    #
                "call": call_info,                                #   данные звонка
                "ts": call["started"],                            #   время
                "read": False,                                    #   «непрочитанность» уточним ниже
            }
            chat["messages"].append(msg)                          #   добавляем в переписку
        # Пропущенный звонок подсвечивается красным счётчиком у того, кому звонили,
        # и не считается новым у того, кто звонил.
        msg["read"] = status not in ("canceled", "no_answer", "missed")
        save_db()                                                 #
    emit("call_log", msg, room=f"u:{call['from']}")               # обновляем журнал у звонящего
    emit("call_log", msg, room=f"u:{call['to']}")                 # и у вызываемого
    emit("chats_update", {"chats": chat_list_for(call["from"])}, room=f"u:{call['from']}")
    emit("chats_update", {"chats": chat_list_for(call["to"])}, room=f"u:{call['to']}")
    return msg                                                    #


def finish_call(call_id, status, duration=None):
    """Завершает звонок и записывает финальный статус в журнал."""
    call = CALLS.pop(call_id, None)                               # забираем звонок из активных
    if not call:                                                  # такого звонка нет
        return None                                               #
    return upsert_call_message(call, status, duration)            # пишем финальную запись


@socketio.on("call_offer")
def on_call_offer(data):
    """Мне звонят: сервер заводит запись «Исходящий звонок» и будит вызываемого."""
    username = SID_TO_USER.get(request.sid)                       # кто звонит
    to = (data or {}).get("to")                                   # кому
    call_id = (data or {}).get("call_id")                         # ID звонка
    if not username or not to or to not in DB["users"] or not call_id:   # данные неполные
        return
    call = {
        "id": call_id,                                            # ID
        "from": username,                                         # звонящий
        "to": to,                                                 # вызываемый
        "kind": (data or {}).get("kind", "audio"),                # audio или video
        "started": time.time(),                                   # время начала
        "log_id": f"call-{call_id}",                              # ID записи в журнале
        "answered": False,                                        # ещё не ответили
        "connected_at": None,                                     # момент соединения
    }
    CALLS[call_id] = call                                         # запоминаем активный звонок
    upsert_call_message(call, "dialing")                          # сразу пишем «звонок идёт» в переписку
    emit("incoming_call", {                                       # будим вызываемого:
        "from": username,                                         #   кто звонит
        "user": public_user(username, to),                        #   его карточка
        "call_id": call_id,                                       #   ID звонка
        "kind": call["kind"],                                     #   тип
        "sdp": (data or {}).get("sdp"),                           #   техническое описание соединения
    }, room=f"u:{to}")
    # В лог — только факт: кто кому звонит. Содержимое разговора серверу недоступно (он идёт напрямую).
    print(f"[GeoMetric] Звонок ({call['kind']}): {username} → {to}")


@socketio.on("call_answer")
def on_call_answer(data):
    """Вызываемый взял трубку."""
    username = SID_TO_USER.get(request.sid)                       # кто взял
    call_id = (data or {}).get("call_id")                         # ID звонка
    call = CALLS.get(call_id)                                     # активный звонок
    if not call or call["to"] != username:                        # не тот участник
        return
    call["answered"] = True                                       # помечаем: ответили
    call["connected_at"] = time.time()                            # момент соединения
    upsert_call_message(call, "answered")                         # в журнале — «Входящий/Исходящий звонок»
    emit("call_answered", {                                       # сообщаем звонящему
        "from": username,                                         #   кто ответил
        "call_id": call_id,                                       #   какому звонку
        "sdp": (data or {}).get("sdp"),                           #   ответное описание соединения
    }, room=f"u:{call['from']}")


@socketio.on("ice_candidate")
def on_ice(data):
    """Пересылка ICE-кандидатов (маршруты соединения) между участниками."""
    username = SID_TO_USER.get(request.sid)                       # от кого
    to = (data or {}).get("to")                                   # кому
    if username and to:                                           #
        emit("ice_candidate", {"from": username, "candidate": (data or {}).get("candidate")}, room=f"u:{to}")


@socketio.on("call_reject")
def on_call_reject(data):
    """Звонок отклонили (или вызываемый занят)."""
    username = SID_TO_USER.get(request.sid)                       # кто отклонил
    call_id = (data or {}).get("call_id")                         # ID звонка
    call = CALLS.get(call_id)                                     # активный звонок
    reason = (data or {}).get("reason", "declined")               # причина: declined или busy
    status = "busy" if reason == "busy" else "declined"           # статус для журнала
    if call:                                                      # если звонок известен —
        finish_call(call_id, status)                              #   пишем финальный статус
    if call and username == call["to"]:                           # сообщаем звонящему
        emit("call_rejected", {"from": username, "call_id": call_id, "reason": reason}, room=f"u:{call['from']}")


@socketio.on("call_end")
def on_call_end(data):
    """Кто-то «положил трубку»."""
    username = SID_TO_USER.get(request.sid)                       # кто завершил
    call_id = (data or {}).get("call_id")                         # ID звонка
    reason = (data or {}).get("reason", "hangup")                 # причина: hangup (сам положил) или timeout (не ответили)
    call = CALLS.get(call_id)                                     # активный звонок
    if call:                                                      # есть такой звонок
        if call["answered"]:                                      # разговор состоялся —
            duration = int(time.time() - (call["connected_at"] or call["started"]))
            finish_call(call_id, "answered", duration)            #   пишем длительность
        elif reason == "timeout":                                 # никто не взял трубку
            finish_call(call_id, "no_answer")                     #   «нет ответа» у звонящего / «пропущенный» у вызываемого
        else:                                                     # звонящий сам отменил до ответа
            finish_call(call_id, "canceled")
    to = (data or {}).get("to")                                   # второму участнику
    if username and to:                                           # сообщаем «звонок окончен»
        emit("call_ended", {"from": username, "call_id": call_id}, room=f"u:{to}")


# ---------------------------------------------------------------------------
# 9. ЗАПУСК
# ---------------------------------------------------------------------------
#  20. ГРУППЫ И КАНАЛЫ (комнаты)
#  Сервер и здесь остаётся «слепым»: сообщения приходят зашифрованными, а ключ
#  комнаты выдаётся участникам в виде «конверта», зашифрованного на ИХ личный
#  ключ. Сервер такой конверт открыть не может — значит, и переписку прочитать.
# ---------------------------------------------------------------------------
def room_of(room_id):
    """Возвращает комнату по ID или None."""
    return DB.get("rooms", {}).get(room_id)                        # комната из базы


def room_members(room):
    """Список логинов участников комнаты."""
    return list(room.get("members", {}).keys())                    # ключи словаря участников


def room_role(room, username):
    """Роль пользователя в комнате: owner / admin / member / None."""
    m = room.get("members", {}).get(username)                      # запись участника
    return m.get("role") if m else None                            # роль или None


def room_can_post(room, username):
    """Можно ли этому участнику писать в комнату (в канале — только владелец и админы)."""
    role = room_role(room, username)                               # его роль
    if not role:                                                   # не участник —
        return False                                               #   писать нельзя
    if room.get("type") == "channel":                              # канал:
        return role in ("owner", "admin")                          #   только админы публикуют
    return True                                                    # в группе пишут все


def room_last_message(room):
    """Последнее сообщение комнаты (для превью в списке)."""
    msgs = room.get("messages", [])                                # все сообщения
    return msgs[-1] if msgs else None                              # последнее или None


def room_unread(room, username):
    """Сколько сообщений в комнате я ещё не видел (сервер считает только число)."""
    mark = room.get("members", {}).get(username, {}).get("last_read", 0)   # когда я читал в последний раз
    return sum(1 for m in room.get("messages", [])                    # считаем сообщения,
               if m["ts"] > mark and m.get("from") != username and not m.get("deleted"))   # присланные мне после этой отметки


def room_list_for(username):
    """Строки групп и каналов для моего списка чатов."""
    out = []                                                       # результат
    for room in DB.get("rooms", {}).values():                       # по всем комнатам сервера
        if username not in room.get("members", {}):                 # я не участник —
            continue                                               #   не показываем
        last = room_last_message(room)                              # последнее сообщение
        out.append({
            "kind": "room",                                        # это комната
            "type": room.get("type", "group"),                     # group или channel
            "id": room["id"],                                      # ID комнаты
            "title": room.get("title", "Без названия"),            # название
            "about": room.get("about", ""),                        # описание
            "color": room.get("color", "#7f5af0"),                 # цвет аватара
            "handle": room.get("handle", ""),                      # @адрес (для поиска)
            "public": bool(room.get("public")),                    # открытая или закрытая
            "role": room_role(room, username),                     # моя роль
            "members": len(room.get("members", {})),               # сколько участников
            "peer": None,                                          # собеседника нет — рисуем аватар комнаты
            "last": last,                                          # последний «конверт»
            "ts": last["ts"] if last else room.get("created", 0),  # время для сортировки
            "unread": room_unread(room, username),                 # непрочитанных
            "post": room_can_post(room, username),                 # могу ли я писать в эту комнату
        })
    return out                                                     # отдаём список


def broadcast_rooms(username):
    """Отправляет пользователю обновлённый список чатов (личные + комнаты)."""
    emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")


def broadcast_rooms_many(users):
    """То же самое, но сразу нескольким пользователям (например, всем участникам комнаты)."""
    for u in set(users):                                           # без повторов
        broadcast_rooms(u)                                         # каждому его список


def clean_handle(raw):
    """Приводит @адрес к безопасному виду: латиница, цифры, подчёркивание."""
    return "".join(ch for ch in str(raw or "").lower() if ch.isalnum() or ch == "_")[:24]   # фильтр символов и длины


def handle_busy(handle, except_room=None):
    """Проверяет, занят ли @адрес (пользователем или другой комнатой)."""
    if not handle:                                                 # пустой адрес не проверяем
        return False                                               # (просто не используется)
    if handle in DB["users"]:                                      # логин пользователя
        return True                                                # занят
    for room in DB.get("rooms", {}).values():                      # по всем комнатам
        if room.get("handle") == handle and room["id"] != except_room:   # адрес совпал и это не та же комната
            return True                                            # занят
    return False                                                   # свободен


def room_key_store(env):
    """Оставляет в «конверте» с ключом комнаты только нужные поля: версию v, блок n и шифротекст c.
    Поле n — это «одноразовый номер» (IV) шифра AES-GCM; сервер его не читает, только хранит."""
    return {"v": env.get("v", 1), "n": env.get("n"), "c": env.get("c")}   # возвращаем «конверт» в том же виде, в каком его прислал клиент


def notify_key_needed(room, member):
    """Просит админов комнаты выдать новому участнику ключ шифрования."""
    admins = [u for u, m in room.get("members", {}).items() if m.get("role") in ("owner", "admin")]   # кто может выдать ключ
    for admin in admins:                                           # всем админам
        if admin == member:                                        # новому участнику самому не пишем
            continue                                               #
        emit("room_key_needed", {"room": room["id"], "title": room.get("title", ""), "member": member, "pub": DB["users"].get(member, {}).get("pub")}, room=f"u:{admin}")   # просьба (+ публичный ключ новичка: он не секретный, без него ключ не зашифровать)


@socketio.on("create_room")
def on_create_room(data):
    """Создание группы или канала. Ключ комнаты придумывает клиент и присылает уже зашифрованным."""
    username = SID_TO_USER.get(request.sid)                        # создатель
    if not username:                                               # не авторизован
        return
    data = data or {}                                              # данные запроса
    rtype = data.get("type") if data.get("type") in ("group", "channel") else "group"   # вид комнаты
    title = (str(data.get("title") or "").strip() or ("Канал" if rtype == "channel" else "Группа"))[:64]   # название
    about = str(data.get("about") or "").strip()[:200]             # описание
    color = str(data.get("color") or "#7f5af0")[:16]               # цвет аватара
    public = bool(data.get("public"))                              # открытая ли комната
    handle = clean_handle(data.get("handle")) if public else ""     # @адрес только для открытых
    if handle and handle_busy(handle):                             # адрес занят —
        emit("error_msg", {"text": "Такой @адрес уже занят"}); return   #   сообщаем и выходим
    members = [u for u in (data.get("members") or []) if u in DB["users"] and u != username][:200]   # кого пригласили
    keys = data.get("keys") if isinstance(data.get("keys"), dict) else {}   # «конверты» с ключом комнаты
    room_id = uuid.uuid4().hex[:16]                                # ID новой комнаты
    room = {
        "id": room_id,                                             # идентификатор
        "type": rtype,                                             # group или channel
        "title": title,                                            # название
        "about": about,                                            # описание
        "color": color,                                            # цвет аватара
        "owner": username,                                         # владелец
        "handle": handle,                                          # @адрес (может быть пустым)
        "public": public,                                          # открытая или закрытая
        "created": time.time(),                                    # когда создана
        "members": {},                                             # участники
        "keys": {},                                                # зашифрованные ключи комнаты (по одному на участника)
        "messages": [],                                            # сообщения (только шифротексты)
    }
    with DB_LOCK:                                                  # пишем в базу под замком
        room["members"][username] = {"role": "owner", "joined": time.time(), "last_read": time.time()}   # я — владелец
        for u in members:                                          # приглашённые
            room["members"][u] = {"role": "member", "joined": time.time(), "last_read": 0}   # становятся участниками
        for u, env in keys.items():                                # ключи комнаты
            if u in room["members"] and isinstance(env, dict) and env.get("c"):   # только для участников и валидные
                room["keys"][u] = room_key_store(env)                 # сохраняем «конверт» как есть (v, n, c)
        DB.setdefault("rooms", {})[room_id] = room                 # кладём комнату в базу
        save_db()                                                  # сохраняем файл
    emit("room_created", {"room": room_id, "type": rtype, "title": title}, room=f"u:{username}")   # мне — уведомление
    broadcast_rooms_many([username] + members)                     # всем — обновлённый список чатов
    for u in members:                                              # приглашённым —
        emit("room_invited", {"room": room_id, "title": title, "type": rtype, "owner": username}, room=f"u:{u}")   # весточка
    print(f"[GeoMetric] {username} создал {rtype} «{title}»: участников {len(room['members'])}")   # метаданные в консоль


@socketio.on("room_key_set")
def on_room_key_set(data):
    """Владелец/админ выдаёт участнику ключ комнаты (зашифрованный на его личный ключ)."""
    username = SID_TO_USER.get(request.sid)                        # кто выдаёт
    data = data or {}                                              # данные
    room = room_of(data.get("room"))                               # комната
    member = data.get("member")                                    # кому
    env = data.get("key")                                          # «конверт» с ключом
    if not room or not member or not isinstance(env, dict) or not env.get("c"):   # данных не хватает
        return
    if room_role(room, username) not in ("owner", "admin"):        # выдавать может только админ
        return
    if member not in room["members"]:                              # участника в комнате нет
        return
    with DB_LOCK:                                                  # под замком
        room["keys"][member] = room_key_store(env)                 # сохраняем ключ для участника (v, n, c)
        save_db()                                                  # сохраняем базу
    emit("room_key_ready", {"room": room["id"]}, room=f"u:{member}")   # сообщаем участнику, что ключ готов


@socketio.on("get_room")
def on_get_room(data):
    """Открытие комнаты: отдаём историю, состав, мою роль и МОЙ ключ (остальные ключи сервер не отдаёт)."""
    username = SID_TO_USER.get(request.sid)                        # кто просит
    room = room_of((data or {}).get("room"))                       # комната
    if not username or not room or username not in room["members"]:   # нет доступа
        return
    my = room["members"][username]                                 # моя запись
    emit("room_history", {
        "room": room["id"],                                        # ID комнаты
        "type": room.get("type"),                                  # вид
        "title": room.get("title"),                                # название
        "about": room.get("about", ""),                            # описание
        "color": room.get("color"),                                # цвет
        "handle": room.get("handle", ""),                          # @адрес
        "my_role": my.get("role"),                                 # моя роль
        "post": room_can_post(room, username),                     # могу ли писать
        "members": [{**public_user(u, username), "role": room["members"][u].get("role"), "pub": DB["users"].get(u, {}).get("pub")} for u in room["members"]],   # состав (с публичными ключами — они не секретные)
        "messages": room.get("messages", [])[-800:],               # история (шифротексты)
        "key": room.get("keys", {}).get(username),                 # ТОЛЬКО мой «конверт» с ключом
    })


@socketio.on("send_room_message")
def on_send_room_message(data):
    """Сообщение в группу или канал."""
    username = SID_TO_USER.get(request.sid)                        # отправитель
    data = data or {}                                              # данные
    room = room_of(data.get("room"))                               # комната
    if not username or not room or username not in room["members"]:   # нет доступа
        return
    if not room_can_post(room, username):                          # право писать
        emit("error_msg", {"text": "В этом канале писать могут только администраторы"}); return   # в канале молчим
    kind = data.get("kind", "text")                                # тип содержимого
    if kind not in ("text", "media", "call"):                      # поддерживаемые типы
        return
    e2e = data.get("e2e")                                          # зашифрованный «конверт»
    plain = data.get("plain")                                      # открытый вариант (только когда браузер не умеет шифровать)
    if not e2e and not plain:                                      # нечего отправлять
        return
    msg = {
        "id": uuid.uuid4().hex,                                    # ID сообщения
        "room": room["id"],                                        # комната
        "from": username,                                          # автор
        "kind": kind,                                              # тип
        "e2e": e2e,                                                # шифротекст (сервер не читает)
        "plain": plain,                                            # открытый текст (когда E2EE недоступно)
        "call": None,                                              # звонков в комнатах пока нет
        "ts": time.time(),                                         # время
        "read": False,                                             # прочитано кем-то
        "deleted": False,                                          # удалено или нет
    }
    with DB_LOCK:                                                  # пишем под замком
        room["messages"].append(msg)                               # добавляем в историю
        room["members"][username]["last_read"] = msg["ts"]          # автор сам «прочитал» своё сообщение
        DB["users"][username]["last_seen"] = msg["ts"]              # отметка активности
        save_db()                                                  # сохраняем
    for u in room_members(room):                                   # всем участникам,
        emit("room_message", msg, room=f"u:{u}")                   #   включая автора (синхронизация устройств)
        broadcast_rooms(u)                                         #   и обновлённый список чатов
    print(f"[GeoMetric] {username} → {room.get('title')}: {kind}, {len((e2e or {}).get('c', '') or '')} симв. шифротекста")


@socketio.on("join_room")
def on_join_room(data):
    """Вход в открытую комнату по @адресу или ID."""
    username = SID_TO_USER.get(request.sid)                        # кто входит
    if not username:                                               # не авторизован
        return
    data = data or {}                                              # данные
    room = None                                                    # искомая комната
    if data.get("room"):                                           # по ID
        room = room_of(data.get("room"))                           #   ищем
    elif data.get("handle"):                                       # по @адресу
        handle = clean_handle(data.get("handle"))                  #   нормализуем
        room = next((r for r in DB.get("rooms", {}).values() if r.get("handle") == handle), None)   # ищем
    if not room or not room.get("public"):                         # комнаты нет или она закрытая
        emit("error_msg", {"text": "Комната не найдена или закрыта"}); return
    if username in room["members"]:                                # уже внутри
        broadcast_rooms(username); return                          # просто обновляем список
    with DB_LOCK:                                                  # под замком
        room["members"][username] = {"role": "member", "joined": time.time(), "last_read": 0}   # добавляем участника
        if room.get("type") == "channel":                          # в канале
            room["members"][username]["role"] = "member"           #   роль подписчика
        save_db()                                                  # сохраняем
    broadcast_rooms_many(room_members(room))                       # обновляем список у всех участников
    emit("room_joined", {"room": room["id"], "title": room.get("title"), "needs_key": bool(room.get("keys", {}).get(username) is None)}, room=f"u:{username}")   # сообщаем вошедшему
    notify_key_needed(room, username)                              # просим админов выдать ключ
    print(f"[GeoMetric] {username} вошёл в «{room.get('title')}»")


@socketio.on("leave_room")
def on_leave_room(data):
    """Выход из группы или канала."""
    username = SID_TO_USER.get(request.sid)                        # кто выходит
    room = room_of((data or {}).get("room"))                       # комната
    if not username or not room or username not in room["members"]:    # нет доступа
        return
    with DB_LOCK:                                                  # под замком
        room["members"].pop(username, None)                        # убираем участника
        room["keys"].pop(username, None)                           # и его ключ
        if not room["members"]:                                    # если не осталось никого —
            DB["rooms"].pop(room["id"], None)                      #   удаляем комнату целиком
        save_db()                                                  # сохраняем
    broadcast_rooms_many(room_members(room) + [username])          # обновляем списки
    emit("room_left", {"room": room["id"]}, room=f"u:{username}")  # сообщаем вышедшему


@socketio.on("add_room_member")
def on_add_room_member(data):
    """Админ добавляет участника в закрытую комнату."""
    username = SID_TO_USER.get(request.sid)                        # кто добавляет
    data = data or {}                                              # данные
    room = room_of(data.get("room"))                               # комната
    member = data.get("member")                                    # кого добавляем
    if not room or member not in DB["users"]:                      # комнаты или человека нет
        return
    if room_role(room, username) not in ("owner", "admin"):        # права
        return
    if member in room["members"]:                                  # уже участник
        return
    with DB_LOCK:                                                  # под замком
        room["members"][member] = {"role": "member", "joined": time.time(), "last_read": 0}   # добавляем
        save_db()                                                  # сохраняем
    broadcast_rooms_many(room_members(room))                       # обновляем списки
    emit("room_invited", {"room": room["id"], "title": room.get("title"), "type": room.get("type"), "owner": username}, room=f"u:{member}")   # уведомляем
    notify_key_needed(room, member)                                # просим ключ для нового участника


@socketio.on("remove_room_member")
def on_remove_room_member(data):
    """Админ удаляет участника (или участник удаляет сам себя)."""
    username = SID_TO_USER.get(request.sid)                        # кто выполняет
    data = data or {}                                              # данные
    room = room_of(data.get("room"))                               # комната
    member = data.get("member")                                    # кого удаляем
    if not room or member not in room["members"]:                  # нет комнаты или участника
        return
    my_role = room_role(room, username)                            # моя роль
    if username != member and my_role not in ("owner", "admin"):    # чужого может убрать только админ
        return
    if room["members"][member].get("role") == "owner":             # владельца убрать нельзя
        emit("error_msg", {"text": "Владельца нельзя удалить"}); return
    with DB_LOCK:                                                  # под замком
        room["members"].pop(member, None)                          # удаляем участника
        room["keys"].pop(member, None)                             # и его ключ
        save_db()                                                  # сохраняем
    broadcast_rooms_many(room_members(room) + [member])            # обновляем списки
    emit("room_left", {"room": room["id"]}, room=f"u:{member}")    # сообщаем удалённому


@socketio.on("update_room")
def on_update_room(data):
    """Меняет название, описание, цвет, @адрес и открытость комнаты."""
    username = SID_TO_USER.get(request.sid)                        # кто меняет
    data = data or {}                                              # данные
    room = room_of(data.get("room"))                               # комната
    if not room or room_role(room, username) not in ("owner", "admin"):   # права
        return
    with DB_LOCK:                                                  # под замком
        if data.get("title"):                                      # новое название
            room["title"] = str(data["title"]).strip()[:64]        #
        if "about" in data:                                        # новое описание
            room["about"] = str(data.get("about") or "").strip()[:200]
        if data.get("color"):                                      # новый цвет
            room["color"] = str(data["color"])[:16]
        if "public" in data:                                       # открытость
            room["public"] = bool(data.get("public"))
        if "handle" in data:                                       # @адрес
            handle = clean_handle(data.get("handle"))               # нормализуем
            if not handle or not handle_busy(handle, except_room=room["id"]):   # свободен —
                room["handle"] = handle                             #   сохраняем
            else:                                                   # занят —
                emit("error_msg", {"text": "Такой @адрес уже занят"})   # сообщаем
        if data.get("members_role") and isinstance(data["members_role"], dict):   # смена ролей
            for u, role in data["members_role"].items():            # по каждому участнику
                if u in room["members"] and role in ("admin", "member") and room["members"][u].get("role") != "owner":
                    room["members"][u]["role"] = role               # меняем роль
        save_db()                                                  # сохраняем
    broadcast_rooms_many(room_members(room))                       # обновляем списки
    for u in room_members(room):                                   # и сообщаем всем
        emit("room_updated", {"room": room["id"], "title": room.get("title"), "about": room.get("about"),
                              "color": room.get("color"), "handle": room.get("handle"), "public": room.get("public")}, room=f"u:{u}")


@socketio.on("room_mark_read")
def on_room_mark_read(data):
    """Я открыл комнату — снимаем счётчик непрочитанных."""
    username = SID_TO_USER.get(request.sid)                        # кто читает
    room = room_of((data or {}).get("room"))                       # комната
    if not username or not room or username not in room["members"]:    # нет доступа
        return
    with DB_LOCK:                                                  # под замком
        room["members"][username]["last_read"] = time.time()        # отметка «прочитано по»
        save_db()                                                  # сохраняем
    broadcast_rooms(username)                                      # обновляем список чатов


@socketio.on("get_rooms")
def on_get_rooms():
    """Публичные комнаты — для поиска и вкладок."""
    username = SID_TO_USER.get(request.sid)                        # кто спрашивает
    if not username:                                               # не авторизован
        return
    public = [{"id": r["id"], "type": r.get("type"), "title": r.get("title"), "about": r.get("about", ""),
               "color": r.get("color"), "handle": r.get("handle", ""), "members": len(r.get("members", {}))}
              for r in DB.get("rooms", {}).values() if r.get("public")]   # все открытые комнаты
    emit("rooms_found", {"rooms": public})                         # отдаём


@socketio.on("delete_message")
def on_delete_message(data):
    """Удаление своего сообщения (у всех участников)."""
    username = SID_TO_USER.get(request.sid)                        # кто удаляет
    data = data or {}                                              # данные
    mid = data.get("id")                                           # ID сообщения
    room = room_of(data.get("room")) if data.get("room") else None  # комната (если это группа)
    targets = []                                                   # кого уведомлять
    with DB_LOCK:                                                  # под замком
        if room:                                                   # сообщение в комнате
            for m in room.get("messages", []):                     # ищем его
                if m["id"] == mid and m.get("from") == username and not m.get("deleted"):   # своё и не удалено
                    m["deleted"] = True                            # помечаем удалённым
                    m["e2e"] = None                                # и стираем содержимое
                    m["plain"] = None                              #
                    targets = room_members(room)                   # уведомляем всех участников
                    break                                          #
        else:                                                      # личный чат
            other = data.get("with")                               # собеседник
            cid = chat_id(username, other) if other else None      # ID чата
            chat = DB["chats"].get(cid) if cid else None           # сам чат
            if chat:                                               # если найден
                for m in chat.get("messages", []):                 # ищем сообщение
                    if m["id"] == mid and m.get("from") == username and not m.get("deleted"):   # своё и не удалено
                        m["deleted"] = True                        # помечаем
                        m["e2e"] = None                            # стираем содержимое
                        m["plain"] = None                          #
                        targets = [username, other]                # уведомляем обоих
                        break                                      #
        save_db()                                                  # сохраняем базу
    for u in targets:                                              # всем, кого это касается
        emit("message_deleted", {"id": mid, "room": room["id"] if room else None}, room=f"u:{u}")   # сообщаем об удалении
        broadcast_rooms(u)                                         # и обновляем превью чата


# ---------------------------------------------------------------------------
def main():
    """Точка входа: параметры командной строки и старт сервера."""
    parser = argparse.ArgumentParser(description="GeoMetric — сервер мессенджера со сквозным шифрованием")
    parser.add_argument("--host", default="0.0.0.0", help="адрес прослушивания (0.0.0.0 — доступен в сети)")
    parser.add_argument("--port", type=int, default=5000, help="порт (по умолчанию 5000)")
    parser.add_argument("--serve-ui", action="store_true",
                        help="предпросмотр: отдавать и интерфейс приложения (для проверки в браузере)")
    parser.add_argument("--data-dir", default=None,
                        help="папка для данных (сообщения, файлы). По умолчанию — data рядом с сервером")
    args = parser.parse_args()                                    # разбираем аргументы

    global DATA_DIR, UPLOAD_DIR, DB_FILE                          # меняем пути, если пользователь их указал
    if args.data_dir:                                             # флаг передан —
        DATA_DIR = Path(args.data_dir).expanduser().resolve()      #   берём указанную папку
        UPLOAD_DIR = DATA_DIR / "uploads"                          #   файлы складываем внутрь неё
        DB_FILE = DATA_DIR / "db.json"                             #   и базу тоже
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)              #   создаём папки
        load_into_memory()                                         #   и перечитываем базу из нового места

    ensure_socketio_client()                                      # проверяем наличие js-библиотеки socket.io

    users = len(DB["users"])                                      # сколько пользователей уже зарегистрировано
    print("=" * 64)
    print("  GeoMetric запущен")
    print(f"  Адрес:            http://localhost:{args.port}")
    print(f"  Пользователей:    {users}" if users else "  Пользователей:    пока никого — создай аккаунт в приложении")
    print("  Шифрование:       включено (E2EE, AES-GCM + ECDH). Сервер не читает переписку.")
    print("=" * 64)

    socketio.run(                                                 # запускаем сервер
        app,                                                      #   приложение
        host=args.host,                                           #   адрес
        port=args.port,                                           #   порт
        debug=False,                                              #   без режима отладки
        allow_unsafe_werkzeug=True,                               #   разрешаем встроенный сервер (для дома/учёбы)
    )


if __name__ == "__main__":                                        # запускается только при прямом вызове файла
    main()
