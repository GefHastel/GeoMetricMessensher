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
import base64                                                       # кодирование файлов для выкладки аккаунтов на GitHub
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

def pick_data_dir() -> Path:
    """Выбирает папку для данных так, чтобы аккаунты НЕ пропадали при перезапуске сервера.

    Порядок такой:
      1) переменная окружения GEOMETRIC_DATA_DIR (или GM_DATA_DIR) — если её задали;
      2) постоянный диск хостинга (/var/data/geometric, /data/geometric) — если он есть;
      3) папка data рядом с сервером (обычный случай для дома и для компьютера).
    """
    for env_name in ("GEOMETRIC_DATA_DIR", "GM_DATA_DIR"):        # сначала смотрим переменные окружения
        value = os.environ.get(env_name)                          #   значение переменной
        if value:                                                 #   если оно задано —
            return Path(value).expanduser()                       #   берём его
    for candidate in (Path("/var/data/geometric"), Path("/data/geometric")):   # затем — постоянные диски хостингов
        try:
            candidate.mkdir(parents=True, exist_ok=True)          #   пробуем создать папку
            if os.access(candidate, os.W_OK):                     #   и проверить запись
                return candidate                                  #   получилось — работаем здесь
        except Exception:                                         #   не получилось —
            continue                                              #   пробуем следующий вариант
    return BASE_DIR / "data"                                      # иначе — обычная папка рядом с сервером


# Папку с данными можно указать снаружи (флаг --data-dir). Это нужно настольному
# приложению: само приложение лежит в «Program Files», а данные — в профиле пользователя.
DATA_DIR = pick_data_dir()                        # папка данных (по возможности — постоянная)
UPLOAD_DIR = DATA_DIR / "uploads"                 # загруженные файлы (в чатах — зашифрованные!)
DB_FILE = DATA_DIR / "db.json"                    # файл «базы данных»
BACKUP_FILE = DATA_DIR / "backup.json"            # резервная копия базы (спасает при сбое записи)

for _d in (STATIC_DIR, UPLOAD_DIR, DATA_DIR):     # создаём все нужные папки,
    _d.mkdir(parents=True, exist_ok=True)         # если их ещё нет


# ---------------------------------------------------------------------------
# 2-Б. ПАПКА users: аккаунты отдельными файлами (переживают перезапуск сервера)
# ---------------------------------------------------------------------------
# Зачем это нужно: база db.json — один большой файл. Если сервер перезапустится
# на хостинге или обновит код, такой файл легко потерять, и все аккаунты пропадут.
# Поэтому каждый аккаунт дополнительно хранится отдельным файлом в папке users.
# Папка лежит в самом проекте — значит, попадает в репозиторий на GitHub, и при
# следующем запуске сервер читает её и возвращает аккаунты на место.


def pick_users_dir() -> Path:
    """Выбирает папку users: сначала рядом с server.py (в проекте), иначе — в папке данных."""
    for env_name in ("GEOMETRIC_USERS_DIR", "GM_USERS_DIR"):       # папку можно указать переменной окружения
        value = os.environ.get(env_name)                           #   значение переменной
        if value:                                                  #   оно задано —
            return Path(value).expanduser()                        #   работаем с ним
    return BASE_DIR / "users"                                      # иначе — папка users рядом с сервером (в репозитории)


def ensure_users_dir() -> Path:
    """Создаёт папку users и проверяет, что в неё можно писать. Если нельзя — переносит её в папку данных."""
    global USERS_DIR                                               # меняем общую переменную
    for candidate in (USERS_DIR, DATA_DIR / "users"):              # сначала основное место, затем запасное
        try:                                                       # запись может быть запрещена —
            candidate.mkdir(parents=True, exist_ok=True)           #   создаём папку
            probe = candidate / ".write-test"                      #   файл для проверки записи
            probe.write_text("ok", encoding="utf-8")               #   пробуем записать
            probe.unlink()                                         #   и убираем его
            USERS_DIR = candidate                                  #   место годится — запоминаем его
            return candidate                                       #   и сообщаем о нём
        except Exception:                                          # не получилось —
            continue                                               #   пробуем следующее место
    return USERS_DIR                                               # ничего не подошло — оставляем как есть


def user_record_ok(rec) -> bool:                                   # признак: запись похожа на аккаунт
    """Проверяет, что запись — действительно аккаунт (в файле нет мусора)."""
    return isinstance(rec, dict) and bool(rec.get("username"))      # нужен словарь с логином внутри


def user_file(login: str) -> Path:                                 # путь к файлу аккаунта
    """Возвращает путь к файлу аккаунта внутри папки users."""
    safe = clean_login(login) or "user"                            # имя файла делаем безопасным (без «/» и прочего)
    return USERS_DIR / f"{safe}.json"                              # файл аккаунта: users/логин.json


def user_digest(rec: dict) -> str:                                 # отпечаток записи
    """Считает отпечаток аккаунта: по нему видно, менялась ли запись (чтобы не писать файл лишний раз)."""
    body = {k: v for k, v in rec.items() if k != "updatedAt"}       # поле времени изменения в отпечаток не берём
    blob = json.dumps(body, ensure_ascii=False, sort_keys=True)     # превращаем запись в текст с постоянным порядком полей
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()           # и считаем отпечаток


def write_user_file(rec: dict) -> bool:                            # запись одного аккаунта в файл
    """Сохраняет один аккаунт в отдельный файл папки users."""
    login = rec.get("username")                                    # логин аккаунта
    if not user_record_ok(rec) or not login:                        # если это не аккаунт —
        return False                                               #   писать нечего
    path = user_file(login)                                        # куда писать
    tmp = path.with_suffix(".tmp")                                 # пишем сначала во временный файл
    try:                                                           # диск может отказать —
        with open(tmp, "w", encoding="utf-8") as f:                #   открываем временный файл
            json.dump(rec, f, ensure_ascii=False, indent=2)        #   сохраняем запись (русские буквы не экранируем)
        os.replace(tmp, path)                                      #   подменяем основной файл одним движением
    except Exception:                                              # не получилось —
        return False                                               #   сообщаем об этом
    USERS_STATE[login] = user_digest(rec)                          # запоминаем отпечаток записанной записи
    return True                                                    # сообщаем об успехе


def read_users_dir() -> dict:                                      # чтение всех аккаунтов из папки
    """Читает папку users и возвращает словарь «логин → запись аккаунта»."""
    found = {}                                                     # сюда собираем прочитанное
    try:                                                           # папки может не быть —
        files = sorted(USERS_DIR.glob("*.json"))                   #   берём все файлы аккаунтов
    except Exception:                                              # не получилось прочитать список —
        return found                                               #   возвращаем пустой результат
    for path in files:                                             # идём по файлам по порядку
        try:                                                       # файл может быть битым —
            with open(path, "r", encoding="utf-8") as f:           #   открываем файл
                rec = json.load(f)                                 #   разбираем JSON
        except Exception:                                          #   битый файл —
            continue                                               #   пропускаем его
        if user_record_ok(rec):                                    # запись похожа на аккаунт —
            found[rec["username"]] = rec                           #   запоминаем её по логину
    return found                                                   # отдаём всё, что прочитали


def merge_users_from_dir(db: dict) -> int:                         # слияние папки users с базой
    """Добавляет в базу аккаунты из папки users (тех, кого в базе нет, и записи посвежее)."""
    added = 0                                                      # сколько аккаунтов вернули
    users = db.setdefault("users", {})                             # раздел пользователей в базе
    for login, rec in read_users_dir().items():                    # проходим по всем файлам аккаунтов
        current = users.get(login)                                 # что уже есть в базе по этому логину
        if current is None:                                        # в базе такого аккаунта нет —
            users[login] = rec                                     #   возвращаем его из файла
            USERS_STATE[login] = user_digest(rec)                  #   и запоминаем отпечаток файла
            added += 1                                             #   считаем возвращённые аккаунты
            continue                                               #   переходим к следующему файлу
        newer_file = float(rec.get("updatedAt") or 0)              # время изменения в файле
        newer_db = float(current.get("updatedAt") or 0)            # время изменения в базе
        if newer_file > newer_db:                                  # файл свежее базы —
            users[login] = rec                                     #   берём версию из файла
            USERS_STATE[login] = user_digest(rec)                  #   и запоминаем её отпечаток
            added += 1                                             #   считаем как восстановленный
    if added:                                                      # что-то восстановили —
        print(f"[GeoMetric] Из папки users прочитано аккаунтов: {added}")   # сообщаем в журнал
    return added                                                   # сколько аккаунтов вернули


def sync_users_to_dir() -> int:                                    # запись изменённых аккаунтов в папку users
    """Сохраняет в папку users все аккаунты, которые изменились с прошлого раза."""
    written = 0                                                    # сколько файлов записали
    with USERS_LOCK:                                               # пишем по одному потоку за раз
        users = DB.get("users", {})                                # все аккаунты базы
        for login, rec in list(users.items()):                     # идём по каждому аккаунту
            if not user_record_ok(rec):                            # запись битая —
                continue                                           #   пропускаем её
            digest = user_digest(rec)                              # текущий отпечаток записи
            if USERS_STATE.get(login) == digest:                   # запись не менялась —
                continue                                           #   файл не трогаем (меньше работы диску)
            rec["updatedAt"] = time.time()                         # помечаем время изменения записи
            if write_user_file(rec):                               # пишем файл аккаунта
                written += 1                                       #   считаем записанное
        for path in list(USERS_DIR.glob("*.json")):                 # теперь убираем файлы удалённых аккаунтов
            login = path.stem                                      # логин из имени файла
            if login not in users:                                 # такого аккаунта в базе больше нет —
                try:                                               #   удаление может не получиться —
                    path.unlink()                                  #   удаляем файл
                    USERS_STATE.pop(login, None)                   #   и забываем его отпечаток
                except Exception:                                  # не получилось —
                    pass                                           #   не страшно: попробуем в следующий раз
    return written                                                 # сколько файлов записали


def publish_users_git() -> bool:                                   # выкладка папки users в репозиторий (если он рядом)
    """Отправляет папку users в репозиторий git — тогда аккаунты не пропадут при обновлении сервера."""
    if not (BASE_DIR / ".git").exists():                            # репозитория рядом нет —
        return False                                               #   выкладывать некуда
    try:                                                           # git может быть не установлен —
        import shutil as _sh                                        #   берём поиск программ
        if not _sh.which("git"):                                    #   программы git нет —
            return False                                            #     выходим
        import subprocess as _sp                                    #   запускаем git отдельным процессом
        env = dict(os.environ)                                     #   переменные окружения для git
        env["GIT_TERMINAL_PROMPT"] = "0"                           #   никаких вопросов про пароль (сервер не должен зависнуть)

        def run(*args):                                            # короткая обёртка запуска git
            """Запускает команду git и возвращает её результат."""
            return _sp.run(["git", "-C", str(BASE_DIR), *args], env=env,   # запускаем git в папке проекта
                           capture_output=True, text=True, timeout=60)     # ждём ответа не дольше минуты

        run("add", "users")                                        # добавляем папку users в набор изменений
        if not run("diff", "--cached", "--name-only").stdout.strip():   # если изменений нет —
            return False                                           #   выкладывать нечего
        run("commit", "-m", "GeoMetric: аккаунты (папка users)")    # записываем изменения
        if run("push").returncode == 0:                             # отправляем в репозиторий; получилось —
            print("[GeoMetric] Папка users выложена в репозиторий")  #   сообщаем в журнал
            return True                                            #   и сообщаем об успехе
    except Exception:                                              # что-то пошло не так —
        pass                                                       #   тихо продолжаем: данные уже лежат в файлах
    return False                                                   # сообщаем, что выложить не удалось


def publish_users_github() -> bool:                                 # выкладка через сайт GitHub (по ключу доступа)
    """Отправляет файлы аккаунтов в репозиторий GitHub по его API (если владелец задал ключ доступа)."""
    if not (GITHUB_REPO and GITHUB_TOKEN):                          # ключа или адреса репозитория нет —
        return False                                               #   выкладывать некуда
    sent = 0                                                        # сколько файлов отправили
    for path in sorted(USERS_DIR.glob("*.json")):                   # идём по файлам аккаунтов
        try:                                                        # сеть может подвести —
            data = base64.b64encode(path.read_bytes()).decode("ascii")   # содержимое файла в виде текста
            url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/users/{path.name}"   # адрес файла в репозитории
            sha = ""                                                # отпечаток уже существующего файла в репозитории
            try:                                                    #   файл может отсутствовать —
                req = urllib.request.Request(url, headers={         #   спрашиваем у GitHub, есть ли такой файл
                    "Authorization": f"Bearer {GITHUB_TOKEN}",      #   ключ доступа владельца
                    "User-Agent": "GeoMetric",                      #   имя программы (GitHub требует этот заголовок)
                })
                with urllib.request.urlopen(req, timeout=20) as resp:   # открываем ответ
                    sha = json.loads(resp.read().decode("utf-8")).get("sha", "")   # берём отпечаток файла
            except Exception:                                       # файла нет или запрос не удался —
                sha = ""                                            #   значит файл создаём заново
            body = {"message": "GeoMetric: аккаунты (папка users)", "content": data, "branch": GITHUB_BRANCH}   # что записываем
            if sha:                                                 # файл уже есть —
                body["sha"] = sha                                   #   указываем его отпечаток (иначе GitHub откажет)
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="PUT", headers={   # отправляем запись
                "Authorization": f"Bearer {GITHUB_TOKEN}",          # ключ доступа владельца
                "Content-Type": "application/json",                 # тип данных — JSON
                "User-Agent": "GeoMetric",                          # имя программы
            })
            with urllib.request.urlopen(req, timeout=30):           # выполняем запрос
                sent += 1                                           # считаем отправленное
        except Exception:                                           # не получилось —
            continue                                                #   пробуем следующий файл
    if sent:                                                        # что-то отправили —
        print(f"[GeoMetric] Файлы аккаунтов отправлены на GitHub: {sent}")   # сообщаем в журнал
    return bool(sent)                                              # сообщаем, была ли отправка


def users_keeper_loop() -> None:                                   # фоновая служба сохранения аккаунтов
    """Раз в несколько минут пишет аккаунты в папку users и выкладывает её в репозиторий."""
    while True:                                                    # работаем, пока сервер запущен
        time.sleep(USERS_PUBLISH_EVERY)                            # ждём между проверками (по умолчанию 5 минут)
        try:                                                       # любая ошибка не должна ронять сервер —
            if sync_users_to_dir():                                #   записываем изменившиеся аккаунты; что-то записали —
                publish_users_github()                             #     выкладываем на GitHub (если задан ключ доступа)
                publish_users_git()                                #     либо в репозиторий рядом (если он есть)
        except Exception:                                          # ошибка —
            continue                                               #   продолжаем работу


def start_users_keeper() -> None:                                  # запуск фоновой службы
    """Запускает фоновую службу, которая хранит аккаунты в папке users."""
    thread = threading.Thread(target=users_keeper_loop, daemon=True)   # отдельный поток, он не мешает серверу
    thread.start()                                                 # запускаем поток
    print(f"[GeoMetric] Аккаунты хранятся отдельно: {USERS_DIR}")   # сообщаем, куда пишутся аккаунты


USERS_DIR = pick_users_dir()                                       # папка аккаунтов: рядом с сервером (в проекте) или там, где указано
USERS_STATE = {}                                                   # логин → отпечаток записи (чтобы не писать файл лишний раз)
USERS_LOCK = threading.RLock()                                     # замок: файлы аккаунтов пишем по одному потоку за раз
GITHUB_REPO = os.environ.get("GEOMETRIC_GITHUB_REPO", "")          # «владелец/репозиторий» для выкладки через API GitHub
GITHUB_TOKEN = os.environ.get("GEOMETRIC_GITHUB_TOKEN", "")        # ключ доступа к GitHub (задаёт владелец проекта)
GITHUB_BRANCH = os.environ.get("GEOMETRIC_GITHUB_BRANCH", "main")  # ветка репозитория
USERS_PUBLISH_EVERY = 300                                          # как часто сохранять и выкладывать аккаунты (секунд)
USERS_DIR = ensure_users_dir()                                     # создаём папку аккаунтов (или переносим её в папку данных)


STORY_TTL = 24 * 60 * 60                          # срок жизни истории — 24 часа
SERVER_VERSION = "1.0"
# Версия сервера. Меняется ТОЛЬКО по прямой просьбе владельца проекта.
MAX_UPLOAD = 128 * 1024 * 1024                    # максимум 128 МБ на файл
SOCKETIO_JS_URL = "https://cdn.socket.io/4.7.5/socket.io.min.js"   # откуда взять клиент socket.io

BOT_TOKEN_PREFIX = "gm-"                                  # с этих букв начинается токен бота — по нему его легко узнать
BOT_LIMIT = 20                                            # сколько своих ботов может завести один человек
BOT_ABOUT_MAX = 200                                       # предел длины описания бота (символов)
STICKER_LIMIT = 60                                        # сколько стикеров помещается в один набор
STICKER_MAX_BYTES = 1024 * 1024                           # предел размера одного стикера — 1 МБ
PACKS_PER_USER = 40                                       # сколько наборов стикеров может создать один человек
DEVICE_LIMIT = 30                                         # сколько устройств запоминаем в списке устройств

SYS_USER = "geometric"                            # логин служебного аккаунта GeoMetric
SYS_NAME = "GeoMetric"                           # его имя (с галочкой в интерфейсе)
SYS_PASSWORD = "GeoMetric5644"                    # пароль владельца проекта
SYS_ABOUT = "Системные уведомления и помощь"      # описание служебного аккаунта

DEFAULT_SETTINGS = {                              # настройки нового пользователя по умолчанию
    "theme": "dark",                              # тема: dark / light / amoled
    "lang": "ru",                                 # язык интерфейса: ru / en / de / es
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
TOKEN_DEVICE = {}                                 # токен сессии -> id устройства (нужно для списка устройств)
BOT_STATE = {}                                    # состояние Стикер-бота: логин человека -> что ждём от него
CALLS = {}                                        # активные звонки: call_id -> данные


# ---------------------------------------------------------------------------
# 3. БАЗА ДАННЫХ (JSON-файл)
# ---------------------------------------------------------------------------
def fill_db(db: dict) -> dict:
    """Дозаполняет базу недостающими разделами — чтобы файл старой версии тоже подошёл."""
    db.setdefault("users", {})                                    # пользователи
    db.setdefault("chats", {})                                    # личные переписки
    db.setdefault("rooms", {})                                    # комнаты: группы и каналы
    db.setdefault("packs", {})                                    # наборы стикеров
    db.setdefault("stories", [])                                  # истории
    if not isinstance(db.get("reports"), list):                    # если жалобы в базе хранятся не списком (старый файл) —
        db["reports"] = []                                        #   приводим к списку
    db.setdefault("reports", [])                                  # жалобы пользователей (их видит только владелец)
    return db                                                     # отдаём базу


def read_db_file(path: Path):
    """Пробует прочитать файл базы. Возвращает словарь или None, если файла нет или он битый."""
    if not path.exists():                                         # файла нет —
        return None                                               #   читать нечего
    try:                                                          # пробуем прочитать
        with open(path, "r", encoding="utf-8") as f:              #   открываем
            return fill_db(json.load(f))                          #   разбираем JSON и дозаполняем
    except Exception:                                             # файл битый —
        return None                                               #   сообщаем, что прочитать не вышло


def load_db():
    """Читает базу. Если основной файл потерялся — поднимает резервную копию.

    Дополнительно база дозаполняется аккаунтами из папки users: они хранятся
    отдельными файлами и потому переживают перезапуск сервера и обновление кода.
    """
    db = read_db_file(DB_FILE)                                    # сначала основной файл
    if db is None:                                                # основной файл не прочитался —
        db = read_db_file(BACKUP_FILE)                            #   пробуем резервную копию
        if db is not None:                                        # копия есть —
            print("[GeoMetric] Основная база не найдена — восстановил из резервной копии")   # сообщаем в лог
    if db is None:                                                # ни файла, ни копии —
        db = {"users": {}, "chats": {}, "rooms": {}, "stories": [], "packs": {}, "reports": []}   # пустая база (никаких тестовых аккаунтов)
    merge_users_from_dir(db)                                      # возвращаем аккаунты, сохранённые отдельными файлами
    return db                                                     # отдаём готовую базу


DB = load_db()                                    # загружаем базу при старте


def load_into_memory():
    """Перечитывает базу из файла (используется, если папку данных задали флагом --data-dir)."""
    global DB                                                    # меняем глобальную переменную
    DB = load_db()                                               #   читаем базу заново


LAST_BACKUP = [0.0]                                             # когда последний раз писали резервную копию


def save_db():
    """Атомарно сохраняет базу: сначала во временный файл, потом подменяет основной.

    Дополнительно раз в минуту пишется резервная копия (backup.json). Если основной
    файл когда-нибудь потеряется, сервер сам поднимет копию — аккаунты не пропадут.
    """
    with DB_LOCK:                                                 # только по одному потоку за раз
        tmp = DB_FILE.with_suffix(".tmp")                         # временный файл
        with open(tmp, "w", encoding="utf-8") as f:               # пишем в него
            json.dump(DB, f, ensure_ascii=False, indent=2)        # сериализуем (русские буквы не экранируются)
        os.replace(tmp, DB_FILE)                                  # подменяем атомарно — база не «побьётся»
        sync_users_to_dir()                                       # и сразу пишем аккаунты отдельными файлами (папка users)
        now = time.time()                                         # текущее время
        if now - LAST_BACKUP[0] > 60:                             # если копию давно не делали —
            try:                                                  #   пробуем её обновить
                btmp = BACKUP_FILE.with_suffix(".tmp")            #   временный файл копии
                with open(btmp, "w", encoding="utf-8") as f:      #   пишем копию
                    json.dump(DB, f, ensure_ascii=False, indent=2)   #   тем же составом
                os.replace(btmp, BACKUP_FILE)                     #   и подменяем атомарно
                LAST_BACKUP[0] = now                              #   запоминаем время копии
            except Exception:                                     # копия не удалась —
                pass                                              #   основной файл всё равно записан


def safe_emit(event: str, data: dict | None = None, room: str | None = None) -> None:
    """Отправляет событие в живой канал, если это возможно.

    Из обычного HTTP-запроса (например, при смене логина) живого канала рядом нет —
    тогда событие просто не отправляется, а данные всё равно сохранятся в базе.
    """
    try:                                                          # пробуем отправить
        emit(event, data or {}, room=room)                        #   в живой канал
    except Exception:                                             # канала нет (обычный запрос) —
        pass                                                      #   молча продолжаем


def clean_login(raw: str) -> str:
    """Приводит логин к безопасному виду: латиница, цифры и подчёркивание, не длиннее 32 символов."""
    text = str(raw or "").strip().lower()                         # убираем пробелы и приводим к нижнему регистру
    return "".join(ch for ch in text if ch.isalnum() or ch == "_")[:32]   # оставляем только разрешённые символы


def login_ok(value: str) -> bool:
    """Проверяет, годится ли логин (минимум 3 символа, только латиница, цифры и подчёркивание)."""
    return len(value) >= 3 and all(ch.isalnum() or ch == "_" for ch in value)   # простое правило


def ensure_system_user():
    """Создаёт служебный аккаунт GeoMetric (с галочкой) — от него приходят системные уведомления."""
    with DB_LOCK:                                                 # меняем базу под замком
        users = DB["users"]                                       # все пользователи
        rec = users.get(SYS_USER)                                 # запись служебного аккаунта
        if not rec:                                               # аккаунта ещё нет —
            pub, enc_priv, kek_salt = "", "", ""                  # у служебного аккаунта нет личных ключей шифрования
            users[SYS_USER] = {                                   # создаём запись
                "username": SYS_USER,                             # логин
                "name": SYS_NAME,                                 # имя
                "bio": SYS_ABOUT,                                 # описание
                "avatar": {"kind": "color", "value": "#4c6ef5"},  # аватар-цвет
                "password": hash_password(SYS_PASSWORD),          # пароль владельца (хранится только хешем)
                "pub": pub, "encPriv": enc_priv, "kekSalt": kek_salt,
                "settings": dict(DEFAULT_SETTINGS),               # настройки по умолчанию
                "created": time.time(),                           # когда создан
                "online": False, "last_seen": time.time(),        # статусы
                "is_system": True,                                # служебный аккаунт (не бот, не человек)
                "verified": True,                                 # галочка «проверенный»
                "is_admin": True,                                 # владелец проекта: видит жалобы
            }
            print("[GeoMetric] Создан служебный аккаунт GeoMetric (владелец проекта)")   # сообщаем в лог
        else:                                                     # аккаунт уже есть —
            rec.setdefault("is_system", True)                      #   гарантируем нужные признаки
            rec["verified"] = True                                 #   галочка
            rec["is_admin"] = True                                 #   права владельца
            if not rec.get("password"):                            #   если пароля нет (битая запись) —
                rec["password"] = hash_password(SYS_PASSWORD)       #     ставим пароль владельца
        save_db()                                                  # сохраняем базу


def is_admin(username: str) -> bool:
    """Владелец проекта (видит жалобы и может блокировать нарушителей)."""
    return bool((DB["users"].get(username) or {}).get("is_admin"))


def admins() -> list:
    """Список логинов владельцев проекта (им приходят жалобы)."""
    return [name for name, u in DB["users"].items() if u.get("is_admin")]   # по признаку в записи


def system_notice(to: str, text: str) -> None:
    """Отправляет человеку системное уведомление в чат с GeoMetric (это обычное сообщение)."""
    if to not in DB["users"] or to == SYS_USER:                    # такого человека нет или это сам сервис —
        return                                                     #   ничего не делаем
    cid = chat_id(SYS_USER, to)                                    # ID чата «GeoMetric ↔ человек»
    msg = {
        "id": uuid.uuid4().hex,                                    # уникальный ID
        "chat": cid,                                               # чат
        "from": SYS_USER,                                          # отправитель — служба GeoMetric
        "to": to,                                                  # получатель
        "kind": "text",                                            # обычное текстовое сообщение
        "e2e": None,                                               # шифровать нечего: это служебная строка
        "plain": {"t": text, "system": True},                      # текст сообщения (открытый — оно системное)
        "call": None,                                              # это не звонок
        "ts": time.time(),                                         # время
        "read": False,                                             # ещё не прочитано
    }
    with DB_LOCK:                                                  # пишем в базу
        get_chat(cid)["messages"].append(msg)                      # добавляем сообщение в переписку
        save_db()                                                  # сохраняем
    safe_emit("new_message", msg, room=f"u:{to}")                       # отправляем человеку на все его устройства
    safe_emit("chats_update", {"chats": chat_list_for(to)}, room=f"u:{to}")   # и обновляем список чатов


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
# 4-Б. УСТРОЙСТВА: с каких устройств человек входил в аккаунт
# ---------------------------------------------------------------------------
def client_ip():                                              # адрес, с которого пришёл запрос
    """Возвращает «человеческий» IP клиента (за прокси — из заголовка X-Forwarded-For)."""
    forwarded = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()   # первый адрес в цепочке
    return forwarded or request.remote_addr or ""             # если заголовка нет — обычный адрес


def detect_platform(ua: str, given: str = "") -> str:           # как подписывать устройство в списке
    """Определяет платформу устройства по подсказкам и по User-Agent.

    Важно для пользователя: в списке устройств должно быть видно «Приложение для ПК»,
    «Приложение для Android», «Веб-версия» — а не расплывчатое «браузер».
    """
    text = (given or "").strip().lower()                       # подсказка от клиента
    if "geometricdesktop" in text or "geometric pc" in text:    # приложение для компьютера
        return "Приложение для ПК"
    if "geometricapp" in text or "android" in text:             # приложение для телефона
        return "Приложение для Android"
    if "ios" in text or "iphone" in text or "ipad" in text:     # приложение для iPhone/iPad
        return "Приложение для iPhone"
    if "web" in text or "браузер" in text or "browser" in text: # сайт в браузере
        return "Веб-версия (браузер)"
    ua_low = (ua or "").lower()                                 # тот же разбор по User-Agent
    if "geometricdesktop" in ua_low:
        return "Приложение для ПК"
    if "geometricapp" in ua_low or "android" in ua_low:
        return "Приложение для Android"
    if "iphone" in ua_low or "ipad" in ua_low or "ios" in ua_low:
        return "Приложение для iPhone"
    if ua_low:                                                  # остальное считаем браузером
        return "Веб-версия (браузер)"
    return "Устройство"                                         # совсем ничего не поняли


def remember_device(username, device):                        # записать устройство в профиль
    """Запоминает устройство входа: имя, систему, время. Нужно для списка устройств в настройках."""
    info = device or {}                                       # данные от приложения (может быть пусто)
    did = str(info.get("id") or "unknown")[:64]                # идентификатор устройства (его придумывает приложение)
    name = str(info.get("name") or "Это устройство")[:60]      # понятное имя: «Телефон», «Ноутбук»
    platform = detect_platform(request.headers.get("User-Agent", ""), str(info.get("platform") or ""))[:40]   # понятная система
    with DB_LOCK:                                             # меняем базу под замком
        u = DB["users"].get(username)                         # запись самого человека
        if not u:                                             # если человека нет —
            return None                                       #   ничего не делаем
        devices = u.setdefault("devices", {})                  # список его устройств
        rec = devices.get(did) or {"id": did, "created": time.time()}   # старая запись или новая
        rec.update({"name": name, "platform": platform, "ip": client_ip(), "last_seen": time.time()})   # обновляем данные
        devices[did] = rec                                    # сохраняем обратно
        u["last_platform"] = platform                         # запоминаем, с чего человек заходил последний раз
        if len(devices) > DEVICE_LIMIT:                       # устройств стало слишком много —
            oldest = sorted(devices.values(), key=lambda d: d.get("last_seen", 0))[0]   # находим самое старое
            devices.pop(oldest.get("id"), None)               #   и забываем его
        save_db()                                             # пишем базу на диск
    return did                                                # отдаём идентификатор устройства


def devices_payload(username, current_device=None):           # список устройств для настроек
    """Собирает список устройств человека: имя, система, когда заходил и какое устройство сейчас."""
    u = DB["users"].get(username) or {}                       # запись человека
    out = []                                                  # сюда собираем ответ
    for dev in (u.get("devices") or {}).values():             # по всем известным устройствам
        out.append({                                          # описываем одно устройство
            "id": dev.get("id"),                              #   идентификатор
            "name": dev.get("name") or "Устройство",          #   имя
            "platform": dev.get("platform") or "",            #   система
            "ip": dev.get("ip") or "",                        #   адрес (виден только владельцу)
            "created": dev.get("created", 0),                 #   когда устройство впервые вошло
            "last_seen": dev.get("last_seen", 0),             #   когда было в сети последний раз
            "current": dev.get("id") == current_device,       #   это то устройство, где мы сейчас смотрим?
        })
    out.sort(key=lambda d: d.get("last_seen", 0), reverse=True)   # свежие устройства — сверху
    return out                                                # отдаём список


def drop_device(username, device_id):                         # «выйти» с устройства
    """Убирает устройство и все его сессии: после этого с него потребуется вход заново."""
    with DB_LOCK:                                             # меняем базу под замком
        u = DB["users"].get(username)                         # запись человека
        if u:                                                 # если человек есть —
            (u.get("devices") or {}).pop(device_id, None)     #   забываем устройство
            save_db()                                         #   и сохраняем
    for tok, meta in list(TOKEN_DEVICE.items()):              # теперь гасим все токены этого устройства
        if meta[0] == username and meta[1] == device_id:      # токен принадлежит человеку и устройству
            TOKENS.pop(tok, None)                             #   забываем токен
            TOKEN_DEVICE.pop(tok, None)                       #   и его привязку


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
    blocked_me = bool(viewer) and viewer in (u.get("blocked") or [])   # этот человек меня заблокировал?
    i_blocked = bool(viewer) and username in ((DB["users"].get(viewer) or {}).get("blocked") or [])   # я его заблокировал?
    if blocked_me:                                                # если он меня заблокировал —
        return {                                                  #   он для меня «почти невидим»
            "username": username,                                 #   логин
            "name": u.get("name", username),                      #   имя оставляем (иначе непонятно, кто это)
            "bio": "",                                            #   описание скрываем
            "avatar": {"kind": "color", "value": "#2a2f3d"},      #   аватарка пропадает (серый кружок)
            "pub": None,                                          #   ключа не даём: писать всё равно нельзя
            "online": False,                                      #   «в сети» не показываем
            "last_seen": 0,                                       #   «был(а) давно»
            "hidden_presence": True,                              #   статус скрыт
            "blocked": True,                                      #   признак: он меня заблокировал
            "verified": False,                                    #   галочку тоже прячем
            "bot": bool(u.get("is_bot")),                         #   бот или нет
            "birthday": "",                                       #   день рождения скрыт
            "pinned": "",                                         #   закреплённый канал скрыт
        }
    return {
        "username": username,                                     # логин
        "name": u.get("name", username),                          # имя
        "bio": u.get("bio", ""),                                  # описание профиля
        "avatar": u.get("avatar", {"kind": "color", "value": "#7f5af0"}),  # аватар: цвет или фото
        "pub": u.get("pub"),                                      # ПУБЛИЧНЫЙ ключ шифрования (нужен собеседнику)
        "online": bool(u.get("online")) if show_presence else False,          # статус «в сети»
        "last_seen": u.get("last_seen") if show_last else None,   # «был(а) недавно» (или None — скрыто)
        "hidden_presence": not show_presence,                     # флаг: статус скрыт (клиент покажет «недавно»)
        "verified": bool(u.get("verified")),                      # галочка «проверенный аккаунт»
        "bot": bool(u.get("is_bot")),                             # бот или нет
        "system": bool(u.get("is_system")),                       # служебный аккаунт GeoMetric
        "blocked": False,                                         # он меня не блокировал
        "i_blocked": i_blocked,                                   # я его заблокировал (клиент покажет «разблокировать»)
        "birthday": (u.get("birthday") or "") if (is_me or is_contact) else "",   # день рождения видят контакты
        "pinned": u.get("pinned") or "",                          # закреплённый канал (его ID)
    }


def me_payload(username):
    """Мой собственный профиль (плюс когда зарегистрирован и есть ли ключи)."""
    u = DB["users"][username]                                     # моя запись
    card = public_user(username, username)                        # карточка «для себя»
    card["settings"] = u.get("settings", dict(DEFAULT_SETTINGS))  # добавляем настройки
    card["has_keys"] = bool(u.get("pub") and u.get("encPriv"))    # сгенерированы ли ключи шифрования
    card["bot"] = bool(u.get("is_bot"))                           # это бот? (в интерфейсе — значок «бот»)
    card["system"] = bool(u.get("is_system"))                     # служебный аккаунт GeoMetric
    card["verified"] = bool(u.get("verified"))                    # галочка «проверенный»
    card["admin"] = bool(u.get("is_admin"))                       # владелец проекта (видит жалобы)
    card["birthday"] = u.get("birthday") or ""                    # день рождения (виден контактам)
    card["pinned"] = u.get("pinned") or ""                        # закреплённый личный канал
    card["blocked_users"] = list(u.get("blocked") or [])          # кого я заблокировал
    card["created"] = u.get("created", 0)                         # дата регистрации
    card["platform"] = u.get("last_platform") or ""               # с какого устройства заходил последний раз
    return card                                                   # отдаём


# ---------------------------------------------------------------------------
# 6. ЧАТЫ И СООБЩЕНИЯ
# ---------------------------------------------------------------------------
def chat_id(a, b):
    """ID личного чата — одинаковый с обеих сторон."""
    return "|".join(sorted([a, b]))                               # сортируем логины и соединяем


def ensure_dm_chat(cid: str) -> bool:
    """Создаёт личный чат, если его ещё нет (нужно для настроек чата до первого сообщения)."""
    parts = [p for p in cid.split("|") if p != "s"]               # участники без отметки «секретный»
    if len(parts) != 2:                                           # это не личный чат (например, комната) —
        return False                                              #   создавать нечего
    if any(part not in DB["users"] for part in parts):             # кого-то из участников нет —
        return False                                              #   тоже не создаём
    get_chat(cid)                                                 # создаём переписку (если её ещё нет)
    return True                                                   # сообщаем об успехе


def chat_meta(cid: str) -> dict:
    """Настройки чата: обои, «без звука», скрытие из списка, секретность, очистка истории."""
    meta = get_chat(cid).setdefault("meta", {})                  # раздел настроек внутри чата
    meta.setdefault("muted", {})                                 # кому чат «без звука» (логин → True)
    meta.setdefault("cleared", {})                               # кому история очищена (логин → время)
    meta.setdefault("hidden", [])                                # кто убрал чат из своего списка
    meta.setdefault("wallpaper", None)                           # обои для обоих (если меняли «у всех»)
    meta.setdefault("wallpaper_me", {})                          # личные обои (логин → обои)
    meta.setdefault("deleted_for", {})                           # кому какое сообщение не показывать
    meta.setdefault("secret", bool(meta.get("secret")))           # это секретный чат?
    return meta                                                  # отдаём настройки


def secret_chat_id(a: str, b: str) -> str:
    """ID секретного чата: та же пара людей, но отдельная переписка (с замочком)."""
    return chat_id(a, b) + "|s"                                  # добавляем отметку «секретный»


def chat_is_secret(cid: str) -> bool:
    """Это секретный чат? (по его ID)"""
    return cid.endswith("|s")                                    # отметка в конце ID


def dm_peer(cid: str, me: str) -> str:
    """Кто собеседник в личном чате (учитывает «Избранное» и секретные чаты)."""
    parts = [p for p in cid.split("|") if p != "s"]              # убираем служебную отметку «секретный»
    if len(parts) >= 2 and parts[0] == parts[1]:                 # «Избранное» (чат с самим собой)
        return me                                                #   собеседник — я сам
    return next((p for p in parts if p != me), "") or ""         # иначе — второй участник


def visible_messages(cid: str, me: str, limit: int = 800) -> list:
    """Сообщения чата, которые положено показывать этому человеку.

    Учитываются: удаление «у меня»/«у всех», очистка истории и блокировка.
    """
    chat = DB["chats"].get(cid) or {}                             # запись чата
    msgs = chat.get("messages", [])                               # все сообщения
    meta = chat.get("meta") or {}                                 # настройки чата
    since = (meta.get("cleared") or {}).get(me, 0)                # когда я очищал историю
    hidden_for_me = set((meta.get("deleted_for") or {}).get(me, []))   # что я удалил «у себя»
    out = []                                                      # результат
    for m in msgs:                                                # проходим по сообщениям
        if m.get("deleted"):                                      # удалено «у всех» —
            continue                                              #   не показываем
        if m["id"] in hidden_for_me:                              # удалено «у меня» —
            continue                                              #   не показываем
        if m.get("ts", 0) <= since:                               # было раньше очистки истории —
            continue                                              #   не показываем
        out.append(m)                                             # иначе — показываем
    return out[-limit:]                                           # отдаём последние сообщения


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
        parts = [p for p in cid.split("|") if p != "s"]           # логины участников (без отметки «секретный»)
        saved = len(parts) == 2 and parts[0] == parts[1]          # «Избранное» — чат с самим собой
        peer = username if saved else next((p for p in parts if p != username), "")   # кто собеседник
        secret = chat_is_secret(cid)                              # это секретный чат?
        meta = chat_meta(cid)                                     # настройки чата
        if username in (meta.get("hidden") or []):                # я убрал этот чат из списка —
            continue                                              #   не показываем
        peer_card = public_user(peer, username) or {}             # карточка собеседника
        if peer_card.get("blocked") and not secret:               # он меня заблокировал —
            continue                                              #   чата в списке больше нет
        msgs = visible_messages(cid, username, 1)                 # видимые мне сообщения (последнее нужно для превью)
        last = msgs[-1] if msgs else None                         # последнее видимое сообщение
        out.append({
            "kind": "saved" if saved else "dm",                   # вид строки: Избранное или личный чат
            "id": cid,                                            # ID чата
            "with": peer,                                         # логин собеседника
            "peer": peer_card,                                    # его карточка (с публичным ключом!)
            "last": last,                                         # последнее сообщение — «конверт» (клиент расшифрует сам)
            "ts": last["ts"] if last else 0,                      # время (для сортировки)
            "unread": 0 if (meta.get("muted", {}) or {}).get(username) else unread_count(cid, username),   # непрочитанных (в «без звука» не считаем)
            "secret": secret,                                     # секретный чат (в интерфейсе — замочек)
            "muted": bool((meta.get("muted", {}) or {}).get(username)),   # чат «без звука»
            "wallpaper": (meta.get("wallpaper_me", {}) or {}).get(username) or meta.get("wallpaper"),   # обои чата
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
# Веб-версия приложения включена ВСЕГДА: открыв адрес сервера в браузере, человек попадает
# в само приложение (та же программа, что и в APK). Флаг --api-only оставляет только API —
# это нужно, если сервер работает строго «как хранилище сообщений».
SERVE_UI = "--api-only" not in sys.argv                    # отдавать ли интерфейс вместе с данными
if SERVE_UI:                                              # обычный режим (он же веб-версия) —
    app = Flask(__name__, static_folder=str(WWW_DIR), static_url_path="")   #   файлы интерфейса из папки www
else:                                                     # режим «только данные» --
    app = Flask(__name__, static_folder=None)             #   файлы интерфейса не раздаются
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

    По этому адресу открывается веб-версия приложения (та же программа, что в APK и EXE).
    Если сервер запущен с флагом --api-only, вместо интерфейса отдаётся служебная справка."""
    if SERVE_UI:                                              # веб-версия включена —
        return send_from_directory(WWW_DIR, "index.html")      #   показываем интерфейс приложения
    return jsonify({
        "geometric": True,                                        # признак «это действительно сервер GeoMetric»
        "name": "GeoMetric Server",                               # название сервиса
        "version": SERVER_VERSION,                                # версия сервера
        "users": len(DB["users"]),                                # сколько аккаунтов зарегистрировано
        "e2ee": True,                                             # содержимое серверу не видно (технический флаг)
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
        "e2ee": True,                                             # содержимое серверу не видно (технический флаг)
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
    username = clean_login(data.get("username"))                  # логин — латиница, цифры и подчёркивание
    password = data.get("password") or ""                         # пароль
    name = (data.get("name") or username).strip()[:40]            # отображаемое имя
    pub = data.get("pub")                                         # публичный ключ шифрования (JWK)
    enc_priv = data.get("encPriv")                                # приватный ключ, зашифрованный паролем
    kek_salt = data.get("kekSalt")                                # соль для вывода ключа из пароля

    if not login_ok(username):                                    # валидация логина
        return jsonify({"error": "Логин: минимум 3 символа, только латинские буквы, цифры и _"}), 400
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
    TOKEN_DEVICE[token] = (username, remember_device(username, data.get("device")))   # запоминаем устройство входа
    print(f"[GeoMetric] Зарегистрирован новый пользователь: {username}")   # в лог пишем ТОЛЬКО логин
    system_notice(username, "Добро пожаловать в GeoMetric! Здесь будут системные уведомления: "
                            "новые входы в аккаунт, смена логина и пароля, ответы на жалобы.")   # приветствие
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
    device_id = remember_device(username, data.get("device"))      # запоминаем устройство входа
    TOKEN_DEVICE[token] = (username, device_id)                   # и привязываем к нему токен
    device = (u.get("devices") or {}).get(device_id) or {}         # данные этого устройства
    system_notice(username, f"Выполнен вход в аккаунт: {device.get('platform') or 'устройство'} "
                            f"({device.get('name') or 'без названия'}). Если это были не вы — смените пароль.")   # предупреждаем
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
    system_notice(username, "Пароль изменён. Если это были не вы, срочно войдите с новым паролем "
                            "и отключите лишние устройства в настройках.")   # предупреждаем владельца
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
        if "birthday" in data:                                    # день рождения
            value = str(data["birthday"] or "").strip()[:10]       #   вид 2026-09-25 (пустая строка — не указан)
            u["birthday"] = value if (not value or len(value) == 10) else u.get("birthday", "")   # принимаем только полную дату
        if "pinned" in data:                                      # закреплённый личный канал
            room_id = str(data["pinned"] or "")                    #   ID канала (пустая строка — снять закрепление)
            room = (DB.get("rooms") or {}).get(room_id)            #   сама комната
            if not room_id:                                        #   снимаем закрепление —
                u["pinned"] = ""                                   #     просто чистим
            elif room and room.get("type") == "channel" and room_role(room, username) in ("owner", "admin"):   # закрепить можно только свой канал
                u["pinned"] = room_id                              #     запоминаем
            else:                                                  #   чужой канал или не канал —
                return jsonify({"error": "Закрепить можно только свой канал"}), 403   #     отказываем
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
    secret = (request.args.get("secret") or "") == "1"            # просят секретный чат?
    cid = secret_chat_id(username, other) if secret else chat_id(username, other)   # ID чата
    peer = public_user(other, username) or {}                     # карточка собеседника
    msgs = [] if peer.get("blocked") else visible_messages(cid, username, 800)   # если он меня заблокировал — истории нет
    meta = (DB["chats"].get(cid) or {}).get("meta") or {}         # настройки чата
    return jsonify({
        "messages": msgs,                                         # видимые мне сообщения
        "chat": cid,                                              # ID чата
        "secret": secret,                                         # это секретный чат?
        "peer": peer,                                             # карточка собеседника
        "wallpaper": (meta.get("wallpaper_me", {}) or {}).get(username) or meta.get("wallpaper"),   # обои
        "muted": bool((meta.get("muted", {}) or {}).get(username)),   # «без звука»
    })


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
# 7-Б. БОТЫ: свои боты на Python и служебный Стикер-бот
# ---------------------------------------------------------------------------
def bot_token_new():                                          # выпустить новый токен бота
    """Новый токен бота. Показывается владельцу один раз — в базе лежит только его хеш."""
    return BOT_TOKEN_PREFIX + secrets.token_urlsafe(32)       # длинная случайная строка с узнаваемым началом


def bot_token_hash(token):                                    # хеш токена бота
    """Хеш токена: сам токен в базе не храним — если базу украдут, ботами не смогут управлять."""
    return hashlib.sha256((token or "").strip().encode("utf-8")).hexdigest()   # SHA-256 от строки токена


def find_bot_by_token(token):                                 # найти бота по его токену
    """Возвращает логин бота по токену или None, если токен не подходит."""
    if not (token or "").startswith(BOT_TOKEN_PREFIX):        # токены ботов начинаются с «gm-» —
        return None                                           #   чужой или пустой токен не подходит
    h = bot_token_hash(token)                                 # считаем хеш присланного токена
    for uname, u in DB["users"].items():                      # перебираем всех, кто есть в базе
        if u.get("is_bot") and u.get("botTokenHash") == h:    # нашли бота с таким токеном
            return uname                                      #   отдаём его логин
    return None                                               # ничего не нашли


def actor_from_request():                                     # кто выполняет запрос: человек или бот
    """Определяет «действующее лицо» запроса: обычный пользователь по токену сессии или бот по его токену."""
    data = request.get_json(silent=True) or {}                # данные из тела запроса
    token = (data.get("token") or request.form.get("token") or request.args.get("token") or "").strip()   # токен из любого места
    if token.startswith(BOT_TOKEN_PREFIX):                    # если прислали токен бота —
        bot = find_bot_by_token(token)                        #   ищем такого бота
        return (bot, True) if bot else (None, True)           #   и сообщаем, что это бот
    return user_by_token(token), False                        # иначе — обычная проверка сессии


def bot_record(username, owner, name, about):                 # запись нового бота в базе
    """Создаёт запись бота: это обычный аккаунт с пометкой «бот» и без личных ключей шифрования."""
    palette = ["#7f5af0", "#2cb67d", "#ff8c42", "#e53170", "#00b8d9", "#8a5cf6", "#f4a261", "#4cc9f0"]   # палитра аватаров
    return {                                                  # сама запись
        "username": username,                                 # логин бота (по нему его находят в поиске)
        "name": name,                                         # отображаемое имя
        "bio": (about or "")[:BOT_ABOUT_MAX],                 # описание (что умеет бот)
        "avatar": {"kind": "color", "value": palette[len(username) % len(palette)]},   # аватар-цвет
        "password": hash_password(secrets.token_urlsafe(24)),  # случайный пароль: человек в такой аккаунт не войдёт
        "pub": None,                                          # у ботов нет ключей шифрования:
        "encPriv": None,                                      #   переписка с ботом не может быть сквозной
        "kekSalt": None,                                      #   (бот сам читает сообщения — как в любом мессенджере)
        "settings": dict(DEFAULT_SETTINGS),                   # обычные настройки
        "created": time.time(),                               # когда создан
        "online": False,                                      # сейчас не в сети
        "last_seen": time.time(),                             # время последней активности
        "is_bot": True,                                       # пометка «это бот»
        "owner": owner,                                       # кто владелец (логин человека)
        "devices": {},                                        # устройства (у ботов бывают свои)
    }


def bot_card(username):                                       # карточка бота для интерфейса
    """Краткая карточка бота: без служебных полей и без токена."""
    u = DB["users"].get(username) or {}                       # запись бота
    return {
        "username": username,                                 # логин
        "name": u.get("name") or username,                    # имя
        "about": u.get("bio") or "",                          # описание
        "owner": u.get("owner"),                              # владелец (кто создал)
        "created": u.get("created", 0),                       # когда создан
        "avatar": u.get("avatar") or {"kind": "color", "value": "#6c5cff"},   # аватар
        "bot": True,                                          # пометка для интерфейса
    }


@app.post("/api/bots")
def api_bot_create():
    """Создать своего бота. В ответ один раз приходит токен — по нему запускается программа бота."""
    username, _ = actor_from_request()                        # проверяем, кто просит
    if not username:                                          # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    data = request.get_json(silent=True) or {}                # данные запроса
    bot_login = (data.get("username") or "").strip().lower()  # желаемый логин бота
    name = (data.get("name") or bot_login).strip()[:40]       # имя бота
    about = (data.get("about") or "").strip()                 # описание
    if len(bot_login) < 3 or not bot_login.isalnum():         # проверяем логин
        return jsonify({"error": "Логин бота: минимум 3 символа, только латиница и цифры"}), 400
    mine = [u for u in DB["users"].values() if u.get("owner") == username]   # сколько ботов уже создал человек
    if len(mine) >= BOT_LIMIT:                                # слишком много —
        return jsonify({"error": f"Можно создать не больше {BOT_LIMIT} ботов"}), 400
    token = bot_token_new()                                   # выпускаем токен
    with DB_LOCK:                                             # меняем базу под замком
        if bot_login in DB["users"]:                          # логин занят
            return jsonify({"error": "Этот логин уже занят"}), 409
        DB["users"][bot_login] = bot_record(bot_login, username, name, about)   # создаём бота
        DB["users"][bot_login]["botTokenHash"] = bot_token_hash(token)          # кладём только хеш токена
        save_db()                                             # сохраняем
    print(f"[GeoMetric] Создан бот @{bot_login} (владелец {username})")   # пишем в лог
    return jsonify({"bot": bot_card(bot_login), "token": token})   # токен показываем один раз


@app.get("/api/bots")
def api_bots_list():
    """Список моих ботов (без токенов)."""
    username = user_by_token(request.args.get("token"))       # проверяем токен
    if not username:                                          # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    out = [bot_card(u) for u, rec in DB["users"].items() if rec.get("owner") == username]   # собираем своих ботов
    out.sort(key=lambda b: b.get("created", 0))               # старые — первыми
    return jsonify({"bots": out})                             # отдаём список


@app.post("/api/bots/token")
def api_bot_new_token():
    """Выпустить новый токен для бота (старый перестанет работать)."""
    username = user_by_token((request.get_json(silent=True) or {}).get("token"))   # проверяем владельца
    if not username:                                          # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    bot_login = ((request.get_json(silent=True) or {}).get("bot") or "").strip().lower()   # логин бота
    u = DB["users"].get(bot_login) or {}                      # запись бота
    if u.get("owner") != username:                            # это не мой бот
        return jsonify({"error": "Это не ваш бот"}), 403
    token = bot_token_new()                                   # новый токен
    with DB_LOCK:                                             # меняем базу под замком
        u["botTokenHash"] = bot_token_hash(token)             # заменяем хеш токена
        save_db()                                             # сохраняем
    return jsonify({"token": token})                          # показываем один раз


@app.post("/api/bots/delete")
def api_bot_delete():
    """Удалить бота вместе с его переписками."""
    data = request.get_json(silent=True) or {}                # данные запроса
    owner = user_by_token(data.get("token"))                  # проверяем владельца
    if not owner:                                             # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    bot_login = (data.get("bot") or "").strip().lower()       # логин бота
    u = DB["users"].get(bot_login) or {}                      # запись бота
    if u.get("owner") != owner:                               # это не мой бот
        return jsonify({"error": "Это не ваш бот"}), 403
    with DB_LOCK:                                             # меняем базу под замком
        DB["users"].pop(bot_login, None)                      # убираем аккаунт бота
        for cid in [c for c in DB["chats"] if bot_login in c.split("|")]:   # находим все его переписки
            DB["chats"].pop(cid, None)                        #   и убираем их
        for pack_id, pack in list(DB.get("packs", {}).items()):   # ещё убираем наборы стикеров бота
            if pack.get("owner") == bot_login:                #   если набор принадлежал боту
                DB["packs"].pop(pack_id, None)                #   удаляем
        save_db()                                             # сохраняем
    return jsonify({"ok": True})                              # готово


@app.post("/api/bot/send")
def api_bot_send():
    """Отправка сообщения от имени бота. Нужна ботам на Python: им удобнее писать по HTTP, чем через сокет."""
    data = request.get_json(silent=True) or {}                 # данные запроса
    who = find_bot_by_token(data.get("token")) or user_by_token(data.get("token"))   # кто отправляет: бот или человек
    if not who:                                                # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    to = (data.get("to") or "").strip()                        # получатель (логин человека или бота)
    room = (data.get("room") or "").strip()                    # или комната (группа/канал)
    kind = data.get("kind") or "text"                          # вид сообщения
    if kind not in ("text", "media", "sticker", "voice", "circle"):   # поддерживаемые виды
        return jsonify({"error": "Неизвестный вид сообщения"}), 400   # отказываем
    plain = data.get("plain") or {}                            # открытая часть (боты не шифруют: они читают текст сами)
    if not plain:                                              # пустое сообщение —
        return jsonify({"error": "Пустое сообщение"}), 400     #   отправлять нечего
    if room and room not in DB["rooms"]:                       # указана комната, которой нет
        return jsonify({"error": "Комната не найдена"}), 404   #   сообщаем
    if not room and to not in DB["users"]:                     # получателя нет
        return jsonify({"error": "Получатель не найден"}), 404   #   сообщаем
    cid = room if room else chat_id(who, to)                   # куда пишем: комната или личный чат
    msg = {                                                    # готовим сообщение
        "id": uuid.uuid4().hex,                                # уникальный ID
        "chat": cid,                                           # чат (личный) — для комнат используется отдельная запись
        "room": room or None,                                  # комната, если писали в неё
        "from": who,                                           # отправитель (бот)
        "to": to or room,                                      # получатель
        "kind": kind,                                          # вид сообщения
        "e2e": None,                                           # боты не шифруют переписку
        "plain": plain,                                        # открытые данные
        "call": None,                                          # это не звонок
        "ts": time.time(),                                     # время отправки
        "read": False,                                         # пока не прочитано
    }
    with DB_LOCK:                                              # меняем базу под замком
        if room:                                               # писали в комнату —
            DB["rooms"][room].setdefault("messages", []).append(msg)   #   добавляем в комнату
        else:                                                  # писали человеку —
            get_chat(cid)["messages"].append(msg)              #   добавляем в личную переписку
        DB["users"][who]["last_seen"] = msg["ts"]              # отмечаем активность бота
        save_db()                                              # сохраняем
    if room:                                                   # в комнату —
        socketio.emit("new_room_message", msg, room=f"room:{room}")   #   всем участникам
        socketio.emit("room_history_update", {"room": room, "message": msg}, room=f"room:{room}")   #   и обновление истории
    else:                                                      # личное сообщение —
        socketio.emit("new_message", msg, room=f"u:{to}")      #   получателю (на все его устройства)
        socketio.emit("new_message", msg, room=f"u:{who}")     #   и самому боту (для его же связи)
        socketio.emit("chats_update", {"chats": chat_list_for(to)}, room=f"u:{to}")   # обновляем список чатов
    return jsonify({"ok": True, "message": msg})               # отдаём отправленное сообщение


@app.post("/api/bot/login")
def api_bot_login():
    """Вход для программы бота: по токену бота выдаём обычную сессию (дальше как у человека)."""
    data = request.get_json(silent=True) or {}                # данные запроса
    bot_login = find_bot_by_token(data.get("bot_token"))      # ищем бота по токену
    if not bot_login:                                         # токен неверный
        return jsonify({"error": "Неверный токен бота"}), 401
    token = new_token()                                       # сессия для бота
    TOKENS[token] = bot_login                                 # запоминаем
    TOKEN_DEVICE[token] = (bot_login, remember_device(bot_login, {
        "id": f"bot:{bot_login}",                             # устройство бота помечаем отдельно
        "name": (data.get("device") or {}).get("name") or "Сервер бота",   # где запущена программа бота
        "platform": (data.get("device") or {}).get("platform") or "Python",   # например «Python»
    }))
    with DB_LOCK:                                             # отмечаем бота «в сети»
        DB["users"][bot_login]["online"] = True               # флаг «в сети»
        DB["users"][bot_login]["last_seen"] = time.time()     # время активности
        save_db()                                             # сохраняем
    return jsonify({"token": token, "me": me_payload(bot_login)})   # отдаём сессию и профиль


# ---------------------------------------------------------------------------
# 7-В. УСТРОЙСТВА: список входов и выход с чужого устройства
# ---------------------------------------------------------------------------
@app.get("/api/devices")
def api_devices():
    """Список устройств, с которых входили в аккаунт."""
    data = request.args                                          # параметры запроса
    username = user_by_token(data.get("token"))                  # проверяем токен
    if not username:                                             # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    current = (TOKEN_DEVICE.get(data.get("token")) or (username, None))[1]   # текущее устройство
    return jsonify({"devices": devices_payload(username, current)})   # отдаём список


@app.post("/api/devices/revoke")
def api_devices_revoke():
    """Выйти с другого устройства: его сессии перестают работать."""
    data = request.get_json(silent=True) or {}                   # данные запроса
    username = user_by_token(data.get("token"))                  # проверяем токен
    if not username:                                             # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    device = str(data.get("device") or "")                       # какое устройство закрываем
    if not device:                                               # не указали —
        return jsonify({"error": "Не указано устройство"}), 400
    mine = (TOKEN_DEVICE.get(data.get("token")) or (username, None))[1]   # текущее устройство
    drop_device(username, device)                                # гасим устройство и его сессии
    return jsonify({"ok": True, "logged_out_me": device == mine})   # сообщаем, не своё ли устройство закрыли


# ---------------------------------------------------------------------------
# 7-Г. СТИКЕРЫ: наборы, добавление картинок и установка наборов
# ---------------------------------------------------------------------------
STICKER_BOT_USER = "stickers"                                 # логин служебного Стикер-бота (по нему к нему пишут)
EMOJI_DEFAULT = "🙂"                                          # значок по умолчанию, если человек его не указал


def pack_card(pack):                                          # краткая карточка набора (для списков)
    """Карточка набора стикеров: название, владелец и «обложка» — первый стикер."""
    stickers = pack.get("stickers") or []                     # стикеры набора
    return {
        "id": pack.get("id"),                                 # идентификатор набора
        "title": pack.get("title") or "Набор",                # название
        "short": pack.get("short") or "",                     # короткое имя (для ссылки)
        "owner": pack.get("owner"),                           # кто владелец
        "count": len(stickers),                               # сколько стикеров внутри
        "cover": (stickers[0] or {}).get("url") if stickers else "",   # обложка (первый стикер)
        "created": pack.get("created", 0),                    # когда создан
    }


def create_pack(owner, title, short=""):                      # создать набор стикеров
    """Создаёт пустой набор стикеров. owner — логин человека или бота."""
    pid = uuid.uuid4().hex[:12]                               # короткий идентификатор набора
    pack = {                                                  # сама запись набора
        "id": pid,                                            # идентификатор
        "title": (title or "Мой набор").strip()[:40],          # название
        "short": (short or "").strip().lower()[:24],          # короткое имя
        "owner": owner,                                       # владелец
        "stickers": [],                                       # пока пустой
        "created": time.time(),                               # когда создан
    }
    with DB_LOCK:                                             # меняем базу под замком
        DB.setdefault("packs", {})[pid] = pack                 # кладём набор
        u = DB["users"].get(owner)                            # владелец
        if u is not None:                                     # если он существует —
            u.setdefault("installedPacks", [])                 #   заводим список установленных наборов
            if pid not in u["installedPacks"]:                #   набор сразу доступен владельцу
                u["installedPacks"].append(pid)               #   добавляем
        save_db()                                             # сохраняем
    return pack                                               # отдаём набор


def add_sticker_to_pack(pack_id, url, emoji=""):               # положить картинку в набор
    """Добавляет стикер в набор. Возвращает стикер или None, если набор переполнен/не найден."""
    with DB_LOCK:                                             # меняем базу под замком
        pack = (DB.get("packs") or {}).get(pack_id)            # ищем набор
        if not pack:                                          # набора нет —
            return None                                       #   выходим
        if len(pack["stickers"]) >= STICKER_LIMIT:             # набор уже полный —
            return None                                       #   выходим
        sticker = {                                           # сама запись стикера
            "id": uuid.uuid4().hex[:10],                       # идентификатор
            "url": url,                                       # адрес картинки на сервере
            "emoji": (emoji or EMOJI_DEFAULT)[:8],            # значок для подбора
            "ts": time.time(),                                # когда добавлен
        }
        pack["stickers"].append(sticker)                       # добавляем в набор
        save_db()                                             # сохраняем
    return sticker                                            # отдаём добавленный стикер


def packs_payload(username):                                  # наборы для интерфейса
    """Возвращает мои наборы и установленные наборы (с обложками)."""
    u = DB["users"].get(username) or {}                        # запись человека
    all_packs = DB.get("packs") or {}                          # все наборы в базе
    mine = [pack_card(p) for p in all_packs.values() if p.get("owner") == username]   # созданные мной
    installed = [pack_card(all_packs[pid]) for pid in (u.get("installedPacks") or []) if pid in all_packs]   # установленные
    installed = [p for p in installed if p.get("owner") != username]   # свои отдельно — не дублируем
    mine.sort(key=lambda p: p.get("created", 0))              # свои — по порядку создания
    installed.sort(key=lambda p: p.get("title", ""))          # чужие — по названию
    return {"mine": mine, "installed": installed}             # отдаём оба списка


def bot_say(bot_login, to, text):                             # сообщение от имени бота
    """Пишет человеку от имени бота. Сообщения ботов не шифруются — бот сам их читает."""
    cid = chat_id(bot_login, to)                               # идентификатор переписки
    msg = {                                                    # готовим сообщение
        "id": uuid.uuid4().hex,                                # уникальный ID
        "chat": cid,                                           # чат
        "from": bot_login,                                     # отправитель — бот
        "to": to,                                              # получатель — человек
        "kind": "text",                                        # это текст
        "e2e": None,                                           # шифрования нет: бот обязан читать текст
        "plain": {"text": text, "file": None},                 # открытый текст
        "call": None,                                          # это не звонок
        "ts": time.time(),                                     # время
        "read": False,                                         # пока не прочитано
    }
    with DB_LOCK:                                              # меняем базу под замком
        get_chat(cid)["messages"].append(msg)                  # дописываем в переписку
        DB["users"][bot_login]["last_seen"] = msg["ts"]        # обновляем активность бота
        save_db()                                              # сохраняем
    socketio.emit("new_message", msg, room=f"u:{to}")          # отправляем человеку
    socketio.emit("new_message", msg, room=f"u:{bot_login}")   # и в комнату бота (для его программ)
    socketio.emit("chats_update", {"chats": chat_list_for(to)}, room=f"u:{to}")   # обновляем список чатов
    return msg                                                 # отдаём сообщение


def ensure_sticker_bot():                                      # создать служебного Стикер-бота
    """Создаёт аккаунт Стикер-бота при первом запуске сервера, если его ещё нет."""
    with DB_LOCK:                                              # меняем базу под замком
        if STICKER_BOT_USER in DB["users"]:                    # бот уже есть —
            return                                             #   ничего не делаем
        rec = bot_record(STICKER_BOT_USER, None, "Стикер-бот",  # создаём запись бота
                         "Создаю наборы стикеров: пришлите фото — получите стикер.")
        rec["botTokenHash"] = bot_token_hash(bot_token_new())   # токена у служебного бота нет ни у кого
        DB["users"][STICKER_BOT_USER] = rec                     # кладём в базу
        save_db()                                              # сохраняем
        print("[GeoMetric] Создан служебный аккаунт: Стикер-бот")   # сообщаем в лог


STICKER_BOT_HELP = (                                           # текст справки Стикер-бота
    "Привет! Я делаю наборы стикеров.\n\n"
    "/newpack Название — создать новый набор\n"
    "потом просто присылайте картинки — каждая станет стикером\n"
    "/done — закончить и установить набор\n"
    "/mypacks — мои наборы\n"
    "/delpack идентификатор — удалить набор"
)


def sticker_bot_handle(username, text, media):                 # логика Стикер-бота
    """Разбирает сообщение Стикер-боту: команды и картинки. Отвечает от имени бота."""
    t = (text or "").strip()                                   # текст сообщения
    low = t.lower()                                            # в нижнем регистре — удобно сравнивать команды
    state = BOT_STATE.get(username) or {}                      # что этот человек делает прямо сейчас
    pack_id = state.get("pack")                                # набор, в который добавляем стикеры
    if low.startswith("/newpack") or low.startswith("/new"):    # создать набор
        title = t.split(" ", 1)[1].strip() if " " in t else ""   # название из команды
        if not title:                                          # название не указали —
            bot_say(STICKER_BOT_USER, username, "Напишите так: /newpack Название набора")   # подсказываем
            return                                             # и выходим
        pack = create_pack(username, title)                    # создаём набор
        BOT_STATE[username] = {"pack": pack["id"]}             # запоминаем, куда добавлять стикеры
        bot_say(STICKER_BOT_USER, username,                    # отвечаем
                f"Набор «{pack['title']}» создан. Присылайте картинки — каждая станет стикером.\n"
                "Когда закончите — /done")
        socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем наборы в приложении
        return                                                 # готово
    if media and media.get("url"):                             # прислали картинку
        if not pack_id:                                        # набора ещё нет —
            bot_say(STICKER_BOT_USER, username, "Сначала создайте набор: /newpack Название")   # подсказываем
            return                                             # и выходим
        sticker = add_sticker_to_pack(pack_id, media["url"], media.get("emoji") or "")   # добавляем стикер
        if not sticker:                                        # не получилось (переполнен или удалён)
            bot_say(STICKER_BOT_USER, username, f"Не получилось добавить: набор удалён или в нём уже {STICKER_LIMIT} стикеров.")
            return                                             # выходим
        count = len((DB["packs"].get(pack_id) or {}).get("stickers") or [])   # сколько стикеров стало
        bot_say(STICKER_BOT_USER, username, f"Стикер добавлен. Всего в наборе: {count}.")   # подтверждаем
        socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем наборы
        return                                                 # готово
    if low.startswith("/done"):                                # закончить набор
        if not pack_id:                                        # набора нет —
            bot_say(STICKER_BOT_USER, username, "Набор ещё не создан. Начните с /newpack Название")   # подсказываем
            return                                             # и выходим
        pack = DB["packs"].get(pack_id) or {}                  # берём набор
        BOT_STATE.pop(username, None)                          # забываем состояние
        bot_say(STICKER_BOT_USER, username,                    # отвечаем
                f"Готово! Набор «{pack.get('title')}» из {len(pack.get('stickers') or [])} стикеров установлен.\n"
                "Откройте панель стикеров в любом чате — набор уже там.")
        socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем наборы
        return                                                 # готово
    if low.startswith("/mypacks"):                             # список моих наборов
        mine = [p for p in (DB.get("packs") or {}).values() if p.get("owner") == username]   # наборы человека
        if not mine:                                           # пусто —
            bot_say(STICKER_BOT_USER, username, "У вас пока нет наборов. Создайте: /newpack Название")   # подсказываем
            return                                             # и выходим
        lines = [f"• {p['title']} — {len(p.get('stickers') or [])} шт., id {p['id']}" for p in mine]   # строки списка
        bot_say(STICKER_BOT_USER, username, "Ваши наборы:\n" + "\n".join(lines))   # отправляем список
        return                                                 # готово
    if low.startswith("/delpack"):                             # удалить набор
        target = t.split(" ", 1)[1].strip() if " " in t else ""   # идентификатор из команды
        pack = (DB.get("packs") or {}).get(target) or {}        # ищем набор
        if pack.get("owner") != username:                       # не его набор —
            bot_say(STICKER_BOT_USER, username, "Не нашёл такой набор. Посмотрите список: /mypacks")
            return                                             # и выходим
        with DB_LOCK:                                           # меняем базу под замком
            DB["packs"].pop(target, None)                       # удаляем набор
            for u in DB["users"].values():                      # у всех, кто его установил,
                if target in (u.get("installedPacks") or []):   #   убираем из установленных
                    u["installedPacks"].remove(target)          #   чтобы не осталось пустых ссылок
            save_db()                                           # сохраняем
        BOT_STATE.pop(username, None)                           # сбрасываем состояние
        bot_say(STICKER_BOT_USER, username, "Набор удалён.")     # подтверждаем
        socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем наборы
        return                                                 # готово
    bot_say(STICKER_BOT_USER, username, STICKER_BOT_HELP)       # не поняли — показываем справку


@app.get("/api/stickers/packs")
def api_sticker_packs():
    """Наборы стикеров: мои собственные и установленные."""
    username = user_by_token(request.args.get("token"))        # проверяем токен
    if not username:                                           # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    return jsonify(packs_payload(username))                    # отдаём наборы


@app.get("/api/stickers/pack/<pack_id>")
def api_sticker_pack(pack_id):
    """Полный набор стикеров вместе со всеми картинками."""
    username = user_by_token(request.args.get("token"))        # проверяем токен
    if not username:                                           # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    pack = (DB.get("packs") or {}).get(pack_id)                # ищем набор
    if not pack:                                               # нет такого —
        return jsonify({"error": "Набор не найден"}), 404      #   сообщаем
    return jsonify({"pack": pack})                             # отдаём набор целиком


@app.post("/api/stickers/pack")
def api_sticker_pack_create():
    """Создать набор стикеров (из приложения — кнопкой, без команд боту)."""
    actor, _is_bot = actor_from_request()                      # кто просит: человек или бот
    if not actor:                                              # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    data = request.get_json(silent=True) or {}                 # данные запроса
    title = (data.get("title") or "").strip()                  # название набора
    if not title:                                              # название пустое —
        return jsonify({"error": "Укажите название набора"}), 400   #   просим указать
    mine = [p for p in (DB.get("packs") or {}).values() if p.get("owner") == actor]   # сколько наборов уже создано
    if len(mine) >= PACKS_PER_USER:                            # слишком много —
        return jsonify({"error": f"Можно создать не больше {PACKS_PER_USER} наборов"}), 400
    pack = create_pack(actor, title, data.get("short") or "")   # создаём набор
    socketio.emit("stickers_update", packs_payload(actor), room=f"u:{actor}")   # обновляем список в приложении
    return jsonify({"pack": pack_card(pack)})                  # отдаём карточку набора


@app.post("/api/stickers/add")
def api_sticker_add():
    """Добавить стикер в набор. Картинка идёт как есть: стикеры публичные, шифровать их не нужно."""
    actor, _is_bot = actor_from_request()                      # кто просит
    if not actor:                                              # не авторизован
        return jsonify({"error": "unauthorized"}), 401
    pack_id = (request.form.get("pack") or "").strip()         # в какой набор добавляем
    file = request.files.get("file")                           # сама картинка
    emoji = (request.form.get("emoji") or "").strip()          # значок (необязательно)
    pack = (DB.get("packs") or {}).get(pack_id) or {}          # ищем набор
    if pack.get("owner") != actor:                             # чужой набор менять нельзя
        return jsonify({"error": "Это не ваш набор"}), 403
    if not file or not file.filename:                           # картинку не прислали
        return jsonify({"error": "Файл не передан"}), 400
    data = file.read()                                         # читаем картинку в память
    if len(data) > STICKER_MAX_BYTES:                           # слишком большой файл —
        return jsonify({"error": f"Стикер должен быть не больше {STICKER_MAX_BYTES // 1024} КБ"}), 400
    ext = Path(file.filename).suffix.lower() or ".png"          # расширение (png/webp/jpg)
    fname = f"sticker_{uuid.uuid4().hex[:12]}{ext[:6]}"         # имя файла на сервере
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)               # на всякий случай создаём папку загрузок
    (UPLOAD_DIR / fname).write_bytes(data)                      # сохраняем картинку
    sticker = add_sticker_to_pack(pack_id, f"/uploads/{fname}", emoji)   # добавляем стикер в набор
    if not sticker:                                            # не получилось
        return jsonify({"error": f"В наборе уже {STICKER_LIMIT} стикеров или он удалён"}), 400
    owner = pack.get("owner")                                  # владелец набора
    if owner:                                                  # если владелец известен —
        socketio.emit("stickers_update", packs_payload(owner), room=f"u:{owner}")   # обновляем его список
    return jsonify({"sticker": sticker, "pack": pack_card(pack)})   # отдаём стикер и обновлённую карточку


@app.post("/api/stickers/install")
def api_sticker_install():
    """Установить чужой набор себе (или убрать его — по параметру remove)."""
    data = request.get_json(silent=True) or {}                 # данные запроса
    username = user_by_token(data.get("token"))                # проверяем токен
    if not username:                                           # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    pack_id = (data.get("pack") or "").strip()                 # какой набор
    remove = bool(data.get("remove"))                          # убрать вместо установки?
    if pack_id not in (DB.get("packs") or {}):                 # набора нет —
        return jsonify({"error": "Набор не найден"}), 404      #   сообщаем
    with DB_LOCK:                                              # меняем базу под замком
        u = DB["users"][username]                              # запись человека
        installed = u.setdefault("installedPacks", [])          # список установленных наборов
        if remove and pack_id in installed:                    # убираем —
            installed.remove(pack_id)                          #   вычёркиваем
        elif not remove and pack_id not in installed:          # ставим —
            installed.append(pack_id)                          #   добавляем
        save_db()                                              # сохраняем
    return jsonify(packs_payload(username))                    # отдаём свежие списки


@app.post("/api/stickers/remove")
def api_sticker_remove():
    """Удалить один стикер из набора."""
    data = request.get_json(silent=True) or {}                 # данные запроса
    username = user_by_token(data.get("token"))                # проверяем токен
    if not username:                                           # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    pack = (DB.get("packs") or {}).get((data.get("pack") or "").strip()) or {}   # ищем набор
    if pack.get("owner") != username:                          # не его набор
        return jsonify({"error": "Это не ваш набор"}), 403
    with DB_LOCK:                                              # меняем базу под замком
        pack["stickers"] = [st for st in pack.get("stickers") or [] if st.get("id") != data.get("sticker")]   # выкидываем стикер
        save_db()                                              # сохраняем
    socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем в приложении
    return jsonify({"pack": pack_card(pack)})                  # отдаём обновлённую карточку


@app.post("/api/stickers/delete_pack")
def api_sticker_delete_pack():
    """Удалить набор целиком."""
    data = request.get_json(silent=True) or {}                 # данные запроса
    username = user_by_token(data.get("token"))                # проверяем токен
    if not username:                                           # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    pack_id = (data.get("pack") or "").strip()                 # какой набор удаляем
    pack = (DB.get("packs") or {}).get(pack_id) or {}          # ищем набор
    if pack.get("owner") != username:                          # не его набор
        return jsonify({"error": "Это не ваш набор"}), 403
    with DB_LOCK:                                              # меняем базу под замком
        DB["packs"].pop(pack_id, None)                         # удаляем набор
        for u in DB["users"].values():                         # у всех, кто его поставил,
            if pack_id in (u.get("installedPacks") or []):     #   убираем из установленных
                u["installedPacks"].remove(pack_id)            #   чтобы не осталось пустых ссылок
        save_db()                                              # сохраняем
    socketio.emit("stickers_update", packs_payload(username), room=f"u:{username}")   # обновляем
    return jsonify({"ok": True})                               # готово


# ---------------------------------------------------------------------------
# 8. СОБЫТИЯ В РЕАЛЬНОМ ВРЕМЕНИ
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
#  6-Б. НОВЫЕ ВОЗМОЖНОСТИ ЧАТОВ (удаление, очистка, обои, поиск, блокировка)
# ---------------------------------------------------------------------------
def rename_user(old: str, new: str) -> bool:
    """Меняет логин человека везде: в профиле, чатах, комнатах, ботах и жалобах.

    Логин — это ключ ко всем данным, поэтому при смене его надо аккуратно перенести,
    иначе человек «потеряет» свои переписки.
    """
    if new in DB["users"] or old not in DB["users"]:              # новый логин занят или старого нет —
        return False                                              #   менять нельзя
    with DB_LOCK:                                                 # меняем базу под замком
        DB["users"][new] = DB["users"].pop(old)                   # переносим запись профиля
        DB["users"][new]["username"] = new                        # и поле логина внутри неё
        for cid in list(DB["chats"].keys()):                      # теперь переименовываем чаты
            if old not in cid.split("|"):                         # этот чат не его —
                continue                                          #   пропускаем
            parts = cid.split("|")                                # разбираем ID на части
            replaced = "|".join(new if part == old else part for part in parts)   # заменяем логин
            chat = DB["chats"].pop(cid)                           # забираем чат из старого ключа
            target = DB["chats"].get(replaced)                    # есть ли уже чат под новым ключом?
            if target:                                            # если есть —
                target["messages"].extend(chat.get("messages", []))   #   дописываем сообщения туда
                target["messages"].sort(key=lambda m: m.get("ts", 0))  #   и сортируем по времени
            else:                                                 # иначе —
                DB["chats"][replaced] = chat                      #   кладём под новым ключом
            for m in (DB["chats"].get(replaced) or {}).get("messages", []):   # у сообщений
                if m.get("from") == old:                          #   меняем отправителя
                    m["from"] = new                               #   на новый логин
                if m.get("to") == old:                            #   и получателя
                    m["to"] = new                                 #   тоже
                m["chat"] = replaced                              #   и ID чата
            for key, value in (chat.get("meta") or {}).items():   # переносим настройки чата
                if isinstance(value, dict):                       # словари вида «логин → значение»
                    got = (DB["chats"].get(replaced) or {}).setdefault("meta", {}).setdefault(key, {})   # где менять
                    if old in value:                              # если там есть старый логин —
                        value[new] = value.pop(old)               #   переносим значение
                    if isinstance(got, dict):                     # и в целевом чате —
                        got.update({k: v for k, v in value.items() if k == new})   #   переносим ключ
        for room in (DB.get("rooms") or {}).values():             # теперь комнаты
            members = room.get("members") or {}                   # участники
            if old in members:                                    # он участник —
                members[new] = members.pop(old)                   #   переносим запись участника
            if room.get("owner") == old:                          # был владельцем —
                room["owner"] = new                               #   становится владельцем под новым логином
            for key, value in list((room.get("keys") or {}).items()):   # ключи комнаты
                if key == old:                                    # выдан старому логину —
                    room["keys"][new] = room["keys"].pop(old)     #   переносим
            for m in room.get("messages", []):                    # и сообщения комнаты
                if m.get("from") == old:                          #   меняем автора
                    m["from"] = new                               #   на новый логин
        for pack in (DB.get("packs") or {}).values():             # наборы стикеров
            if pack.get("owner") == old:                          #   его набор —
                pack["owner"] = new                               #   меняем владельца
        for bot in DB["users"].values():                          # своих ботов
            if bot.get("owner") == old:                           #   которые принадлежали ему —
                bot["owner"] = new                                #   переносим владельца
        for story in DB.get("stories", []):                       # истории
            if story.get("from") == old:                          #   его история —
                story["from"] = new                               #   меняем автора
        for rep in DB.get("reports", []):                         # жалобы
            if rep.get("from") == old:                            #   он жаловался —
                rep["from"] = new                                 #   меняем автора
            if rep.get("about") == old:                           #   на него жаловались —
                rep["about"] = new                                #   меняем «виновника»
        for tok, name in list(TOKENS.items()):                    # токены сессий
            if name == old:                                       #   его токен —
                TOKENS[tok] = new                                 #   привязываем к новому логину
        for tok, meta in list(TOKEN_DEVICE.items()):              # привязки токенов к устройствам
            if meta[0] == old:                                    #   его устройство —
                TOKEN_DEVICE[tok] = (new, meta[1])                #   переносим
        save_db()                                                 # сохраняем всё разом
    return True                                                   # сообщаем об успехе


def client_device_id(token: str) -> str:
    """Определяет устройство по токену сессии (нужно, чтобы показать «это устройство»)."""
    meta = TOKEN_DEVICE.get(token) or (None, None)                # привязка токена к устройству
    return meta[1] or ""                                          # идентификатор устройства


@app.post("/api/username")
def api_username():
    """Смена логина (username) после регистрации."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто меняет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    if (DB["users"].get(username) or {}).get("is_bot"):            # боты логин не меняют
        return jsonify({"error": "Ботам нельзя менять логин"}), 400
    new = clean_login(data.get("username"))                        # новый логин
    if not login_ok(new):                                          # проверяем формат
        return jsonify({"error": "Логин: минимум 3 символа, только латинские буквы, цифры и _"}), 400
    if new == username:                                            # ничего не изменилось —
        return jsonify({"me": me_payload(username)})               #   просто отдаём профиль
    if not rename_user(username, new):                             # занят или не получилось
        return jsonify({"error": "Этот логин уже занят"}), 409
    system_notice(new, f"Ваш логин изменён: теперь вы @{new}. Сообщите его друзьям.")   # уведомляем владельца
    safe_emit("me_updated", {"me": me_payload(new)}, room=f"u:{new}")   # просим приложение обновить профиль
    safe_emit("chats_update", {"chats": chat_list_for(new)}, room=f"u:{new}")   # и список чатов
    print(f"[GeoMetric] Логин изменён: {username} → {new}")          # в лог пишем только логины
    return jsonify({"me": me_payload(new)})                        # отдаём обновлённый профиль


@app.post("/api/chat/secret")
def api_chat_secret():
    """Создаёт (или открывает) секретный чат с человеком — отдельная переписка с замочком."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто просит
    other = (data.get("with") or "").strip().lower()               # с кем
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    if other not in DB["users"] or (DB["users"][other] or {}).get("is_bot"):   # человека нет или это бот
        return jsonify({"error": "Секретный чат возможен только с человеком"}), 400
    if other == username:                                          # с самим собой —
        return jsonify({"error": "С собой секретный чат не нужен"}), 400
    cid = secret_chat_id(username, other)                          # ID секретного чата
    chat_meta(cid)["secret"] = True                                # помечаем секретным
    get_chat(cid)                                                  # создаём переписку
    save_db()                                                      # сохраняем
    safe_emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")   # обновляем список у себя
    print(f"[GeoMetric] Открыт секретный чат: {username} и {other}")   # в логе — только факт, без содержимого
    return jsonify({"chat": cid, "with": other, "secret": True})   # отдаём ID


@app.post("/api/chat/clear")
def api_chat_clear():
    """Очищает историю чата: у меня или у обоих."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто чистит
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    chat = data.get("chat") or ""                                 # ID чата
    scope = data.get("scope") or "me"                              # «me» — только у меня, «all» — у обоих
    if chat not in DB["chats"] and not ensure_dm_chat(chat):       # чата нет и создать не получилось —
        return jsonify({"error": "Чат не найден"}), 404            #   сообщаем
    if username not in chat.split("|"):                            # это не мой чат —
        return jsonify({"error": "Нет доступа"}), 403
    with DB_LOCK:                                                 # меняем базу
        if scope == "all":                                        # очистить у обоих разрешено в личной переписке
            DB["chats"][chat]["messages"] = []                     #   просто убираем сообщения
            DB["chats"][chat].setdefault("meta", {})["cleared"] = {}   #   сбрасываем отметки очистки
        else:                                                     # только у себя —
            meta = chat_meta(chat)                                 #   настройки чата
            meta["cleared"][username] = time.time()                #   запоминаем время очистки
        save_db()                                                 # сохраняем
    for part in chat.split("|"):                                  # всем участникам —
        if part in DB["users"]:                                   #   кто существует
            safe_emit("history_cleared", {"chat": chat, "scope": scope}, room=f"u:{part}")   # сообщаем об очистке
            safe_emit("chats_update", {"chats": chat_list_for(part)}, room=f"u:{part}")      # обновляем список чатов
    return jsonify({"ok": True})                                  # готово


@app.post("/api/chat/delete")
def api_chat_delete():
    """Убирает чат из моего списка (у собеседника он остаётся, если он его не удалял)."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто удаляет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    chat = data.get("chat") or ""                                 # ID чата
    if chat not in DB["chats"] and not ensure_dm_chat(chat):       # чата нет и создать не получилось —
        return jsonify({"error": "Чат не найден"}), 404            #   сообщаем
    if username not in chat.split("|"):                            # это не мой чат —
        return jsonify({"error": "Нет доступа"}), 403
    with DB_LOCK:                                                 # меняем базу
        meta = chat_meta(chat)                                    # настройки чата
        if username not in meta["hidden"]:                        # если ещё не скрыт —
            meta["hidden"].append(username)                       #   добавляем меня в скрытые
        others = [p for p in chat.split("|") if p not in ("s", username)]   # остальные участники
        if all(p in meta["hidden"] for p in others):               # если скрыли все —
            DB["chats"].pop(chat, None)                           #   чат можно удалить совсем
        save_db()                                                 # сохраняем
    safe_emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")   # обновляем список
    return jsonify({"ok": True})                                  # готово


@app.post("/api/chat/mute")
def api_chat_mute():
    """Включает или выключает уведомления по чату (в комнатах — для меня лично)."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто меняет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    chat = data.get("chat") or ""                                 # ID чата или комнаты
    on = bool(data.get("on"))                                     # включаем («без звука») или выключаем
    if chat in DB["chats"] or ensure_dm_chat(chat):                # личный чат (или только что создали) —
        chat_meta(chat)["muted"][username] = on                   #   запоминаем настройку
    elif chat in (DB.get("rooms") or {}):                         # комната —
        member = DB["rooms"][chat].setdefault("members", {}).setdefault(username, {})   # моя запись участника
        member["muted"] = on                                      #   запоминаем
    else:                                                         # ни того, ни другого —
        return jsonify({"error": "Чат не найден"}), 404           #   сообщаем
    save_db()                                                     # сохраняем
    safe_emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")   # обновляем список
    return jsonify({"ok": True, "muted": on})                     # готово


@app.post("/api/chat/wallpaper")
def api_chat_wallpaper():
    """Меняет обои чата: только у меня или у всех (в личном чате — у обоих)."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто меняет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    chat = data.get("chat") or ""                                 # ID чата или комнаты
    scope = data.get("scope") or "me"                             # «me» — у меня, «all» — у всех
    paper = data.get("wallpaper")                                 # обои: цвет или картинка (или null — сбросить)
    if chat in DB["chats"] or ensure_dm_chat(chat):                # личный чат (или только что создали) —
        meta = chat_meta(chat)                                    #   настройки
        if scope == "all":                                        #   для обоих
            meta["wallpaper"] = paper                             #     общие обои
        else:                                                     #   только для себя
            meta["wallpaper_me"][username] = paper                #     мои обои
    elif chat in (DB.get("rooms") or {}):                         # комната —
        room = DB["rooms"][chat]                                  #   её запись
        role = room_role(room, username)                          #   моя роль
        if scope == "all" and role not in ("owner", "admin"):      #   менять для всех может только админ
            return jsonify({"error": "Обои для всех может менять только администратор"}), 403
        if scope == "all":                                        #   для всех —
            room["wallpaper"] = paper                             #     запоминаем в комнате
        else:                                                     #   для себя —
            room.setdefault("wallpaper_me", {})[username] = paper   #     личные обои
    else:                                                         # чата нет —
        return jsonify({"error": "Чат не найден"}), 404           #   сообщаем
    save_db()                                                     # сохраняем
    for part in chat.split("|"):                                  # всем участникам чата —
        if part in DB["users"]:                                   #   кто существует
            safe_emit("wallpaper_changed", {"chat": chat, "scope": scope, "wallpaper": paper}, room=f"u:{part}")   # сообщаем
            safe_emit("chats_update", {"chats": chat_list_for(part)}, room=f"u:{part}")   # обновляем список
    return jsonify({"ok": True})                                  # готово


@app.post("/api/chat/block")
def api_chat_block():
    """Блокировка человека: он видит «был(а) давно», без аватарки, а переписка пропадает."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто блокирует
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    other = (data.get("with") or "").strip().lower()               # кого блокируют
    on = bool(data.get("on"))                                     # заблокировать или разблокировать
    if other not in DB["users"] or other == SYS_USER:              # нет такого человека (или это служба) —
        return jsonify({"error": "Пользователь не найден"}), 404   #   сообщаем
    with DB_LOCK:                                                 # меняем базу
        me = DB["users"][username]                                # моя запись
        blocked = me.setdefault("blocked", [])                    # список тех, кого я заблокировал
        if on and other not in blocked:                           # блокируем —
            blocked.append(other)                                 #   добавляем в список
            cid = chat_id(username, other)                        #   ID нашей переписки
            if cid in DB["chats"]:                                #   переписка есть —
                DB["chats"][cid]["messages"] = []                 #     сообщения пропадают (как и просили)
                DB["chats"][cid].setdefault("meta", {})["cleared"] = {username: time.time(), other: time.time()}   #   и история считается очищенной
        if not on and other in blocked:                           # разблокируем —
            blocked.remove(other)                                 #   убираем из списка
        save_db()                                                 # сохраняем
    peer_card = public_user(other, username)                       # карточка собеседника после изменений
    safe_emit("peer_updated", {"peer": peer_card}, room=f"u:{username}")   # сообщаем мне
    safe_emit("peer_updated", {"peer": public_user(username, other)}, room=f"u:{other}")   # и собеседнику (у него изменится мой вид)
    safe_emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")   # обновляем списки
    safe_emit("chats_update", {"chats": chat_list_for(other)}, room=f"u:{other}")         # у обоих
    print(f"[GeoMetric] {'Заблокирован' if on else 'Разблокирован'} пользователь: {other}")   # в лог — только логин
    return jsonify({"ok": True, "blocked": on})                    # готово


@app.post("/api/report")
def api_report():
    """Жалоба на человека: её видит владелец проекта (аккаунт GeoMetric)."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто жалуется
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    about = (data.get("with") or "").strip().lower()               # на кого жалуются
    reason = (data.get("reason") or "Другое").strip()[:60]          # причина
    text = (data.get("text") or "").strip()[:600]                  # подробности (если написали)
    if about not in DB["users"]:                                  # такого человека нет —
        return jsonify({"error": "Пользователь не найден"}), 404   #   сообщаем
    with DB_LOCK:                                                 # меняем базу
        DB.setdefault("reports", []).append({                     # добавляем жалобу
            "id": uuid.uuid4().hex,                               # номер жалобы
            "from": username,                                     # кто пожаловался
            "about": about,                                       # на кого
            "reason": reason,                                     # причина
            "text": text,                                         # пояснение
            "ts": time.time(),                                    # время
            "status": "new",                                      # состояние: new / ignored / blocked
        })
        save_db()                                                 # сохраняем
    for admin in admins():                                        # всем владельцам проекта —
        safe_emit("report_new", {"from": username, "about": about, "reason": reason}, room=f"u:{admin}")   # сообщаем о жалобе
        system_notice(admin, f"Новая жалоба от @{username} на @{about}. Причина: {reason}" + (f". Пояснение: {text}" if text else ""))   # и пишем в чат GeoMetric
    return jsonify({"ok": True})                                  # готово


@app.get("/api/reports")
def api_reports():
    """Список жалоб — только для владельца проекта."""
    username = user_by_token(request.args.get("token"))           # кто спрашивает
    if not username or not is_admin(username):                     # не владелец —
        return jsonify({"error": "Нет доступа"}), 403              #   отказываем
    items = sorted(DB.get("reports", []), key=lambda r: r.get("ts", 0), reverse=True)[:200]   # свежие жалобы сверху
    return jsonify({"reports": items})                            # отдаём список


@app.post("/api/report/action")
def api_report_action():
    """Действие владельца по жалобе: проигнорировать или заблокировать нарушителя."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто действует
    if not username or not is_admin(username):                     # не владелец —
        return jsonify({"error": "Нет доступа"}), 403              #   отказываем
    rid = data.get("id") or ""                                    # номер жалобы
    action = data.get("action") or "ignore"                       # что делаем
    report = next((r for r in DB.get("reports", []) if r.get("id") == rid), None)   # ищем жалобу
    if not report:                                                # не нашли —
        return jsonify({"error": "Жалоба не найдена"}), 404        #   сообщаем
    about = report.get("about", "")                                # на кого жалоба
    with DB_LOCK:                                                 # меняем базу
        report["status"] = "ignored" if action == "ignore" else "blocked"   # новое состояние
        report["handled_by"] = username                           # кто рассмотрел
        report["handled_at"] = time.time()                        # когда
        if about in DB["users"] and action == "block":            # блокируем нарушителя для владельца
            blocked = DB["users"].setdefault(username, {}).setdefault("blocked", [])   # список блокировок владельца
            if about not in blocked:                              # если ещё не заблокирован —
                blocked.append(about)                             #   добавляем
        save_db()                                                 # сохраняем
    if report.get("from") in DB["users"]:                         # автору жалобы —
        system_notice(report["from"], "Ваша жалоба рассмотрена. Спасибо, что помогаете делать GeoMetric лучше!")   # отвечаем
    if action == "block" and about in DB["users"]:                # если заблокировали нарушителя —
        system_notice(about, "Ваш аккаунт ограничен: на вас поступили жалобы.")   # сообщаем и ему
    return jsonify({"ok": True})                                  # готово


@app.get("/api/user")
def api_user():
    """Карточка одного человека по логину — нужна приложению, чтобы знать про собеседника всё сразу."""
    username = user_by_token(request.args.get("token"))            # кто спрашивает
    if not username:                                              # нет доступа —
        return jsonify({"error": "unauthorized"}), 401            #   сообщаем
    login = clean_login(request.args.get("username"))              # чей профиль нужен
    card = public_user(login, username)                            # карточка с учётом приватности
    if not card:                                                  # человека нет —
        return jsonify({"error": "not found"}), 404                #   сообщаем
    return jsonify(card)                                          # отдаём карточку


@app.get("/api/contacts")
def api_contacts():
    """Мои контакты: люди, с которыми есть переписка, и свои боты (для раздела «Контакты»)."""
    username = user_by_token(request.args.get("token"))           # кто спрашивает
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401
    people = []                                                   # список людей
    for name in sorted(contacts_of(username)):                     # все, с кем есть чат
        card = public_user(name, username)                        #   карточка
        if card:                                                  #   если человек существует
            people.append(card)                                   #     добавляем
    bots = [public_user(n, username) for n, u in DB["users"].items()   # свои боты
            if u.get("is_bot") and u.get("owner") == username]     # (только заведённые этим человеком)
    return jsonify({"contacts": people, "bots": [b for b in bots if b]})   # отдаём список


@app.get("/api/admin/backup")
def api_admin_backup():
    """Скачать резервную копию базы (только владелец проекта)."""
    username = user_by_token(request.args.get("token"))           # кто просит
    if not username or not is_admin(username):                     # не владелец —
        return jsonify({"error": "Нет доступа"}), 403              #   отказываем
    return jsonify({"db": DB, "ts": time.time(), "version": SERVER_VERSION})   # отдаём всю базу


@app.post("/api/admin/restore")
def api_admin_restore():
    """Загрузить резервную копию базы (только владелец проекта)."""
    data = request.get_json(silent=True) or {}                    # данные запроса
    username = user_by_token(data.get("token"))                   # кто просит
    if not username or not is_admin(username):                     # не владелец —
        return jsonify({"error": "Нет доступа"}), 403              #   отказываем
    db = data.get("db")                                           # сама база
    if not isinstance(db, dict) or "users" not in db:              # это не похоже на базу —
        return jsonify({"error": "Файл копии повреждён"}), 400      #   сообщаем
    with DB_LOCK:                                                 # меняем базу
        DB.clear()                                                # чистим текущую
        DB.update(fill_db(db))                                    # и заливаем из копии
        save_db()                                                 # сохраняем на диск
    ensure_system_user()                                          # проверяем служебный аккаунт
    print("[GeoMetric] База восстановлена из резервной копии владельцем проекта")   # пишем в лог
    return jsonify({"ok": True, "users": len(DB["users"])})        # готово


@app.get("/api/chat/search")
def api_chat_search():
    """Поиск по переписке делает приложение: серверу текст недоступен.

    Здесь отдаём то, что нужно приложению: подсказку о размере истории и ID чата.
    """
    username = user_by_token(request.args.get("token"))           # кто ищет
    if not username:                                              # нет доступа
        return jsonify({"error": "unauthorized"}), 401             # отказываем
    other = request.args.get("with", "")                           # с кем переписка
    secret = (request.args.get("secret") or "") == "1"             # секретный чат?
    cid = secret_chat_id(username, other) if secret else chat_id(username, other)   # ID чата
    return jsonify({"chat": cid, "count": len(visible_messages(cid, username, 100000))})   # отдаём число сообщений


@socketio.on("delete_message")
def on_delete_message(data):
    """Удаляет сообщение: «у меня» (только мне) или «у всех» (у обоих)."""
    username = SID_TO_USER.get(request.sid)                       # кто удаляет
    if not username:                                              # не авторизован —
        return                                                    #   выходим
    data = data or {}                                             # данные события
    chat = data.get("chat") or ""                                 # где сообщение: ID чата или комнаты
    mid = data.get("id") or ""                                    # ID сообщения
    scope = data.get("scope") or "me"                             # «me» или «all»
    if chat in (DB.get("rooms") or {}):                           # это комната —
        room = DB["rooms"][chat]                                  #   её запись
        msg = next((m for m in room.get("messages", []) if m.get("id") == mid), None)   # ищем сообщение
        if not msg:                                               # не нашли —
            return                                                #   выходим
        role = room_role(room, username)                          # моя роль в комнате
        mine = msg.get("from") == username                        # это моё сообщение?
        if scope == "all" and not (mine or role in ("owner", "admin")):   # удалять чужое для всех может админ
            scope = "me"                                          #   иначе удаляем только у себя
        with DB_LOCK:                                             # меняем базу
            if scope == "all":                                    # у всех —
                msg["deleted"] = True                             #   помечаем удалённым
                msg["e2e"] = None                                 #   и стираем содержимое
                msg["plain"] = None                               #   (и открытое тоже)
            else:                                                 # только у себя —
                room.setdefault("deleted_for", {}).setdefault(username, []).append(mid)   #   запоминаем
            save_db()                                             # сохраняем
        for member in list(room.get("members", {}).keys()):        # всем участникам —
            safe_emit("message_deleted", {"chat": chat, "id": mid, "scope": scope}, room=f"u:{member}")   # сообщаем
        return                                                    # готово
    if chat not in DB["chats"]:                                   # личного чата нет —
        return                                                    #   выходим
    if username not in chat.split("|"):                            # не мой чат —
        return                                                    #   выходим
    msg = next((m for m in DB["chats"][chat].get("messages", []) if m.get("id") == mid), None)   # ищем сообщение
    if not msg:                                                   # не нашли —
        return                                                    #   выходим
    if scope == "all" and msg.get("from") != username:              # чужое сообщение можно удалить только у себя
        scope = "me"                                              #   понижаем область удаления
    with DB_LOCK:                                                 # меняем базу
        meta = chat_meta(chat)                                    # настройки чата
        if scope == "all":                                        # удалить у всех —
            msg["deleted"] = True                                 #   помечаем
            msg["e2e"] = None                                     #   и стираем содержимое
            msg["plain"] = None                                   #   (сервер тоже не хранит лишнего)
        else:                                                     # только у себя —
            meta["deleted_for"].setdefault(username, []).append(mid)   #   запоминаем для меня
        save_db()                                                 # сохраняем
    if not chat_is_secret(chat):                                   # обычный чат —
        print(f"[GeoMetric] Сообщение удалено ({scope}) в чате {chat}")   # пишем факт без содержимого
    for part in chat.split("|"):                                  # всем участникам —
        if part in DB["users"]:                                   #   кто существует
            safe_emit("message_deleted", {"chat": chat, "id": mid, "scope": scope}, room=f"u:{part}")   # сообщаем


@socketio.on("connect")
def on_connect():
    """Кто-то подключился (авторизация будет отдельным шагом)."""
    print(f"[GeoMetric] Новое соединение: {request.sid}")         # лог без приватных данных


@socketio.on("disconnect")
def on_disconnect(*_args):
    # «Звёздочка» в аргументах нужна потому, что новые версии библиотеки передают
    # в этот обработчик причину закрытия соединения, а нам она не важна.
    """Соединение закрылось — помечаем человека «не в сети» (если у него нет других устройств)."""
    username = SID_TO_USER.pop(request.sid, None)                 # кто отключился
    if not username:                                              # анонимное соединение
        return
    if username in SID_TO_USER.values():                          # есть ещё открытые вкладки/устройства
        return                                                    #   статус не снимаем
    if username not in DB["users"]:                               # человека уже нет в базе (например, базу откатили из копии) —
        return                                                    #   тогда отмечать нечего
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
    if kind not in ("text", "media", "sticker", "voice", "circle"):   # разрешённые виды сообщений
        return                                                    #   прочие виды не принимаем
    e2e = (data or {}).get("e2e")                                 # зашифрованный «конверт» (сервер не читает)
    plain = (data or {}).get("plain")                             # незашифрованный вариант (только в режиме без E2EE)
    if not e2e and not plain:                                     # ни того, ни другого —
        return                                                    #   отправлять нечего
    secret = bool((data or {}).get("secret"))                     # это сообщение в секретном чате?
    peer_blocked_me = username in ((DB["users"].get(to) or {}).get("blocked") or [])   # собеседник меня заблокировал?
    if peer_blocked_me and not secret:                            # заблокирован —
        emit("error_msg", {"error": "Сообщение не отправлено"}, room=f"u:{username}")   #   сообщаем себе
        return                                                    #   и не отправляем ничего
    cid = secret_chat_id(username, to) if secret else chat_id(username, to)   # ID чата
    if secret:                                                    # для секретного чата
        chat_meta(cid)["secret"] = True                           #   помечаем его секретным
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
        "secret": secret,                                         # сообщение секретного чата?
    }
    with DB_LOCK:                                                 # пишем в базу
        get_chat(cid)["messages"].append(msg)                     #
        DB["users"][username]["last_seen"] = msg["ts"]            #
        save_db()                                                 #
    emit("new_message", msg, room=f"u:{to}")                      # получателю (на все его устройства)
    emit("new_message", msg, room=f"u:{username}")                # и себе (синхронизация вкладок)
    # Если написали Стикер-боту — сам сервер исполняет его роль: разбирает команды и картинки.
    if to == STICKER_BOT_USER:                                     # получатель — служебный Стикер-бот
        try:                                                       # любые ошибки бота не должны ронять сервер
            bot_file = (plain or {}).get("file") or None            # картинка из открытого сообщения (если была)
            sticker_bot_handle(username, (plain or {}).get("text") or "", bot_file)   # отдаём команду боту
        except Exception as e:                                      # что-то пошло не так —
            print(f"[GeoMetric] Стикер-бот: ошибка обработки: {e}")    #   пишем в лог и продолжаем
    # Обновляем СПИСОК ЧАТОВ у обоих: если переписка только началась, у получателя
    # должен появиться новый диалог (иначе сообщение «придёт в никуда»).
    emit("chats_update", {"chats": chat_list_for(to)}, room=f"u:{to}")
    emit("chats_update", {"chats": chat_list_for(username)}, room=f"u:{username}")
    # В консоль выводим только метаданные: кто, кому, сколько байт. Содержимое нам недоступно.
    # Для секретных чатов в консоль НЕ пишем ничего — они не оставляют следов.
    if not secret:                                                # обычный чат —
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
    secret = bool((data or {}).get("secret"))                     # просят историю секретной переписки?
    cid = secret_chat_id(chat_id(username, other)) if secret else chat_id(username, other)   # ID чата (с отметкой «секретный»)
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
    if DB["users"].get(to, {}).get("is_bot"):                     # боту звонить нельзя —
        emit("call_error", {"text": "Ботам нельзя звонить"})       #   сразу отвечаем понятной ошибкой
        return                                                    #   и выходим
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
            "unread": 0 if (room.get("members", {}).get(username, {}) or {}).get("muted") else room_unread(room, username),   # непрочитанных (в «без звука» не считаем)
            "post": room_can_post(room, username),                 # могу ли я писать в эту комнату
            "muted": bool((room.get("members", {}).get(username, {}) or {}).get("muted")),   # чат «без звука»
            "wallpaper": (room.get("wallpaper_me", {}) or {}).get(username) or room.get("wallpaper"),   # обои комнаты
            "pinned": bool((DB["users"].get(username) or {}).get("pinned") == room.get("id")),   # это мой закреплённый канал?
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
    if kind not in ("text", "media", "call", "sticker", "voice", "circle"):   # поддерживаемые типы
        return                                                    #   прочие виды не принимаем
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


# Старый обработчик удаления заменён новым (см. выше): он умеет и «у меня», и «у всех»,
# и работает как в личных чатах, так и в группах.


# ---------------------------------------------------------------------------
def main():
    """Точка входа: параметры командной строки и старт сервера."""
    parser = argparse.ArgumentParser(description="GeoMetric — сервер мессенджера со сквозным шифрованием")
    parser.add_argument("--host", default="0.0.0.0", help="адрес прослушивания (0.0.0.0 — доступен в сети)")
    parser.add_argument("--port", type=int, default=5000, help="порт (по умолчанию 5000)")
    parser.add_argument("--api-only", action="store_true",
                        help="только данные: не отдавать веб-версию приложения (по умолчанию она включена)")
    parser.add_argument("--serve-ui", action="store_true",
                        help="оставлено для совместимости: раньше включало веб-версию (сейчас она включена всегда)")
    parser.add_argument("--data-dir", default=None,
                        help="папка для данных (сообщения, файлы). По умолчанию — data рядом с сервером")
    args = parser.parse_args()                                    # разбираем аргументы

    global DATA_DIR, UPLOAD_DIR, DB_FILE, BACKUP_FILE, USERS_DIR   # меняем пути, если пользователь их указал
    if args.data_dir:                                             # флаг передан —
        DATA_DIR = Path(args.data_dir).expanduser().resolve()      #   берём указанную папку
        UPLOAD_DIR = DATA_DIR / "uploads"                          #   файлы складываем внутрь неё
        DB_FILE = DATA_DIR / "db.json"                             #   и базу тоже
        BACKUP_FILE = DATA_DIR / "backup.json"                     #   и её резервную копию (иначе копия осталась бы в старой папке)
        USERS_DIR = DATA_DIR / "users"                             #   и папку аккаунтов переносим туда же
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)              #   создаём папки
        ensure_users_dir()                                         #   создаём папку аккаунтов по новому адресу
        load_into_memory()                                         #   и перечитываем базу из нового места

    ensure_socketio_client()                                      # проверяем наличие js-библиотеки socket.io
    ensure_sticker_bot()                                          # создаём служебного Стикер-бота (если его ещё нет)
    ensure_system_user()                                          # создаём служебный аккаунт GeoMetric (владелец проекта)
    start_users_keeper()                                          # включаем хранение аккаунтов в папке users (они не пропадут)

    users = len(DB["users"])                                      # сколько пользователей уже зарегистрировано
    print("=" * 64)
    print("  GeoMetric запущен")
    print(f"  Адрес:            http://localhost:{args.port}")
    print(f"  Пользователей:    {users}" if users else "  Пользователей:    пока никого — создай аккаунт в приложении")
    print(f"  Данные:           {DATA_DIR}")                       # где лежит база (на хостинге нужен постоянный диск)
    print("  Режим работы:     содержимое переписки серверу не видно")
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
