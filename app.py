# -*- coding: utf-8 -*-
"""
GeoMetric для компьютера: приложение-клиент (Windows / macOS / Linux).

Что делает этот файл:
  1. Запускает ЛОКАЛЬНЫЙ сервер файлов: отдаёт интерфейс мессенджера из папки www
     (она лежит рядом с программой). Это не «сайт в интернете» — файлы уже внутри
     приложения, а локальный адрес нужен лишь для того, чтобы окно могло их открыть
     и разрешило шифрование (на локальном адресе оно всегда доступно).
  2. Открывает окно приложения ДВУМЯ способами:
        • СВОЯ РАМКА (как у настоящей программы): если установлена библиотека pywebview,
          окно создаётся без системной рамки, а сверху рисуется наша полоса с кнопками
          «свернуть», «развернуть» и «закрыть» — она уже есть в интерфейсе (www).
        • ЗАПАСНОЙ СПОСОБ: Chrome или Edge в режиме --app (без адресной строки).
          Используется, если pywebview недоступна: тогда окно выглядит как «приложение»,
          но с системной рамкой Windows.
  3. Держит окно, пока пользователь его не закроет, и затем выключает локальный сервер.

Чего здесь НЕТ: сервера сообщений. Сервер GeoMetric (server.py) — отдельная программа,
которая хранит переписку. Её адрес пользователь вводит в приложении при первом запуске.
"""

import os                                       # работа с файлами и путями
import socket                                   # выбор свободного порта
import subprocess                               # запуск браузера как отдельной программы
import sys                                      # выход и пути Python
import threading                                # локальный сервер работает в отдельном потоке
import time                                     # паузы при ожидании запуска
import webbrowser                               # запасной способ открыть страницу
from functools import partial                   # «заморозка» аргументов для обработчика запросов
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer   # локальный сервер файлов

# ---------------------------------------------------------------------------
#  Кодировка вывода: на Windows консоль по умолчанию не умеет кириллицу
#  (cp866/cp1252) — из-за этого программа падала с UnicodeEncodeError при первом же
#  сообщении и не успевала открыть окно. Переключаем вывод на UTF-8 и запрещаем
#  падать из-за «непечатаемых» символов (errors="replace").
# ---------------------------------------------------------------------------
for _stream in (sys.stdout, sys.stderr):        # оба потока вывода (обычный и поток ошибок)
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")   # Python 3.7+: кодировка UTF-8, ошибки не роняют программу
    except Exception:                           # старый Python или поток без метода reconfigure —
        pass                                    #   молча продолжаем (текст просто может выглядеть иначе)

# ---------------------------------------------------------------------------
#  Пути: где лежит интерфейс приложения и где хранить настройки
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):               # программа собрана PyInstaller (один файл .exe) —
    BASE_DIR = os.path.dirname(sys.executable)  #   файлы лежат рядом с исполняемым файлом
else:                                           # обычный запуск из исходников —
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))   #   берём папку этого файла
    if not os.path.isdir(os.path.join(BASE_DIR, "www")):    # если www нет рядом (запуск из windows/) —
        BASE_DIR = os.path.dirname(BASE_DIR)                #   поднимаемся в корень проекта

WWW_DIR = os.path.join(BASE_DIR, "www")         # папка с интерфейсом приложения (html/css/js/иконки)

if not os.path.isdir(WWW_DIR):                  # интерфейса нет —
    print("Не найдена папка www с интерфейсом приложения рядом с программой.")   # объясняем проблему
    print("Распакуйте архив GeoMetric полностью и запустите программу заново.")  # и что делать
    sys.exit(1)                                 # выходим

LAUNCHED_BY_EXE = os.environ.get("GM_LAUNCHER") == "1"   # True, если программу запустил GeoMetric.exe

# Режим «окно откроет сам GeoMetric.exe»: тогда Python только отдаёт файлы интерфейса
# (своё окно рисует запускатор — это настоящее окно программы, без браузера).
EXTERNAL_WINDOW = os.environ.get("GM_NO_WINDOW") == "1"  # True, если окно рисует запускатор

# Папка данных приложения — та же, куда GeoMetric.exe пишет журнал (%LOCALAPPDATA%\GeoMetric).
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA") or BASE_DIR, "GeoMetric")   # общая папка с запускатором
PORT_FILE = os.path.join(DATA_DIR, "port.txt")           # файл с номером порта интерфейса (его читает GeoMetric.exe)
try:
    os.makedirs(DATA_DIR, exist_ok=True)                 # создаём папку данных, если её ещё нет
except Exception:                                        # прав может не хватить (редкий случай) —
    DATA_DIR = BASE_DIR                                   #   тогда складываем рядом с программой
    PORT_FILE = os.path.join(DATA_DIR, "port.txt")        #   и файл порта тоже

# ---------------------------------------------------------------------------
#  Свободный порт и запуск локального сервера файлов
# ---------------------------------------------------------------------------
def find_free_port() -> int:
    """Просит у системы свободный порт: подключается к «нулевому» порту и смотрит, какой выдали."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:   # создаём сокет и сразу «закрываем» через with
        s.bind(("127.0.0.1", 0))                                   # привязываемся к своему устройству, порт 0 = «любой свободный»
        return s.getsockname()[1]                                  # возвращаем номер порта, который выдала система


class QuietHandler(SimpleHTTPRequestHandler):
    """Обработчик файлов: без лишних сообщений в консоль и с правильными типами."""

    def log_message(self, format, *args):       # переопределяем журнал запросов
        pass                                    # молча: иначе консоль засыпает служебными строками

    def end_headers(self):                      # перед отправкой заголовков
        self.send_header("Cache-Control", "no-store")   # запрещаем кэширование: файлы и так локальные
        super().end_headers()                   # продолжаем стандартную отправку


def start_local_server(port: int) -> ThreadingHTTPServer:
    """Поднимает локальный сервер файлов из папки www на выбранном порту."""
    handler = partial(QuietHandler, directory=WWW_DIR)      # все запросы — к папке www
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)   # слушаем только своё устройство
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)   # сервер живёт в фоновом потоке
    thread.start()                                          # запускаем поток
    return httpd                                            # возвращаем сервер (нужен для остановки)


# ---------------------------------------------------------------------------
#  СВОЯ РАМКА ОКНА (через pywebview): кнопки «свернуть», «развернуть», «закрыть»
# ---------------------------------------------------------------------------
class WindowApi:
    """Мостик между интерфейсом (JavaScript) и окном программы.

    Интерфейс вызывает эти методы, когда пользователь нажимает кнопки в нашей полосе заголовка
    или тянет её мышкой, чтобы передвинуть окно. Так окно ведёт себя как системное, но выглядит
    так, как мы нарисовали (со своей рамкой)."""

    def __init__(self):
        self.window = None                      # само окно (появится после его создания)
        self.is_max = False                     # развёрнуто ли окно на весь экран
        self._drag = None                       # сведения о перетаскивании: (экранный X, экранный Y, X окна, Y окна)

    def win_minimize(self):
        """Кнопка «свернуть»: сворачивает окно в панель задач."""
        try:
            self.window.minimize()              # просим окно свернуться
        except Exception:                       # если не получилось —
            pass                                #   просто ничего не делаем (не роняем приложение)
        return True                             # отвечаем интерфейсу, что нажатие обработано

    def win_toggle_max(self):
        """Кнопка «развернуть»: разворачивает окно на весь экран или возвращает прежний размер."""
        try:
            if self.is_max:                     # окно уже развёрнуто —
                self.window.restore()           #   возвращаем прежний размер
                self.is_max = False             #   запоминаем состояние
            else:                               # окно обычного размера —
                self.window.maximize()          #   разворачиваем на весь экран
                self.is_max = True              #   запоминаем состояние
        except Exception:                       # если не получилось —
            pass                                #   игнорируем
        return self.is_max                      # сообщаем интерфейсу новое состояние (для иконки кнопки)

    def win_close(self):
        """Кнопка «закрыть»: закрывает программу целиком."""
        try:
            self.window.destroy()               # закрываем окно (вместе с ним завершится и программа)
        except Exception:                       # если не получилось —
            os._exit(0)                         #   выходим жёстко, чтобы окно точно закрылось
        return True                             # отвечаем интерфейсу

    def win_drag_start(self, x, y):
        """Начало перетаскивания окна за нашу полосу: запоминаем точку старта."""
        try:
            self._drag = (float(x), float(y), float(self.window.x), float(self.window.y))   # экранная точка и положение окна
        except Exception:                       # если координаты недоступны —
            self._drag = None                    #   перетаскивание просто не сработает
        return True                             # отвечаем интерфейсу

    def win_drag_move(self, x, y):
        """Продолжение перетаскивания: двигаем окно вслед за курсором."""
        if not self._drag:                      # перетаскивание не начато —
            return False                        #   ничего не делаем
        sx, sy, wx, wy = self._drag              # точка старта и положение окна в тот момент
        try:
            self.window.move(int(wx + (float(x) - sx)), int(wy + (float(y) - sy)))   # сдвигаем окно на ту же дельту
        except Exception:                       # если не получилось —
            pass                                #   игнорируем
        return True                             # отвечаем интерфейсу

    def win_drag_end(self):
        """Конец перетаскивания: забываем точку старта."""
        self._drag = None                       # сбрасываем состояние
        return True                             # отвечаем интерфейсу

    def win_is_max(self):
        """Сообщает интерфейсу, развёрнуто ли окно (чтобы нарисовать правильную иконку кнопки)."""
        return self.is_max                      # текущее состояние


def pywebview_available() -> bool:
    """Проверяет, есть ли в запущенном Python библиотека окна (pywebview)."""
    try:
        import webview                          # noqa: F401 — импорт нужен только для проверки
        return True                             # библиотека есть — сможем открыть своё окно
    except Exception:                           # библиотеки нет —
        return False                            #   сообщаем об этом


def relaunch_with_bundled_python() -> bool:
    """Перезапускает приложение встроенным Python (папка runtime) — в нём библиотека окна уже есть.

    Это нужно для случая, когда пользователь запустил app.py системным Python: тогда
    своё окно не открылось бы и показался браузер. Перезапуск решает это автоматически."""
    if os.environ.get("GM_RELAUNCH") == "1":     # мы уже перезапускались —
        return False                             #   второй раз не пробуем (иначе зациклимся)
    bundled = os.path.join(BASE_DIR, "runtime", "python.exe")   # встроенный Python рядом с программой (Windows)
    if not os.path.isfile(bundled):              # комплекта нет (например, запуск из исходников на Linux) —
        return False                             #   перезапуск невозможен
    if os.path.abspath(sys.executable).lower() == os.path.abspath(bundled).lower():   # мы и так запущены встроенным Python —
        return False                             #   перезапуск не нужен
    env = os.environ.copy()                      # копируем переменные окружения
    env["GM_RELAUNCH"] = "1"                     # ставим признак, чтобы не перезапускаться бесконечно
    print("Запускаю приложение встроенным Python (в нём есть библиотека окна)…")   # поясняем в консоли
    try:
        subprocess.Popen([bundled, "-u", os.path.join(BASE_DIR, "app.py")], env=env, cwd=BASE_DIR)   # запускаем себя заново
    except Exception as e:                       # не получилось —
        print(f"Не удалось перезапустить: {e}")   #   сообщаем и работаем как есть
        return False                             #   продолжаем обычным способом (браузер)
    return True                                  # перезапуск удался — родительский процесс можно закрывать


def install_pywebview() -> bool:
    """Ставит библиотеку «своей рамки» (pywebview), если её нет.

    Нужно только для случая «запускаю app.py своим Python без комплекта runtime»:
    тогда своё окно открыть нечем, и мы один раз пробуем установить библиотеку сами."""
    if os.environ.get("GM_NO_PIP") == "1":                   # установку запретили (например, нет интернета) —
        return False                                         #   сразу сообщаем о неудаче
    print("Библиотеки окна нет — пробую установить (нужен интернет, займёт до минуты)…")   # объясняем в консоли
    try:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "pywebview"],   # ставим библиотеку
                           timeout=180, capture_output=True)                                     # ждём не дольше 3 минут
        ok = r.returncode == 0                               # успех, если установка прошла без ошибок
    except Exception as e:                                   # не получилось —
        print(f"Установка не удалась: {e}")                   #   сообщаем
        ok = False                                           #   и продолжаем без своей рамки
    if ok:                                                   # если поставили —
        import importlib                                     #   перечитываем список библиотек Python,
        importlib.invalidate_caches()                        #   чтобы новый пакет стал виден сразу
    return ok                                                # сообщаем результат


def open_own_window(url: str) -> bool:
    """Открывает окно СО СВОЕЙ РАМКОЙ через pywebview. Возвращает True, если получилось."""
    try:
        import webview                          # библиотека «окно на движке системы»
    except Exception as e:                      # библиотеки нет или система не поддерживает —
        print(f"[GeoMetric] Своя рамка недоступна ({e.__class__.__name__}), открою окно браузера.")   # поясняем в журнале
        return False                            # сообщаем, что не получилось
    api = WindowApi()                           # создаём мостик для кнопок и перетаскивания
    try:
        window = webview.create_window(          # создаём окно программы
            "GeoMetric",                         # заголовок окна (виден в панели задач)
            url + "?app=1",                      # адрес интерфейса; app=1 — «мы внутри программы»
            width=1240,                          # ширина окна по умолчанию
            height=820,                          # высота окна по умолчанию
            min_size=(960, 620),                 # минимальный размер: меньше — вёрстка уже не нужна
            frameless=True,                      # БЕЗ системной рамки: сверху наша полоса с кнопками
            easy_drag=False,                     # окно тянется только за нашу полосу (не за любую точку)
            background_color="#0b0d14",          # цвет фона до загрузки интерфейса (тёмный, как тема)
            js_api=api,                          # отдаём интерфейсу мостик с кнопками
        )
    except Exception as e:                      # окно не создалось —
        print(f"[GeoMetric] Не удалось создать своё окно ({e}), открою окно браузера.")   # поясняем
        return False                            # сообщаем, что не получилось
    api.window = window                         # даём мостику доступ к окну
    def after_start():
        """Печатает признак «окно открыто» ТОЛЬКО когда окно действительно заработало."""
        print("WINDOW=pywebview", flush=True)   # ПРИЗНАК для GeoMetric.exe: окно открыли мы сами (браузер не нужен)
    try:
        webview.start(after_start, debug=False)  # запускаем цикл окна (вернётся, когда окно закрыли)
    except Exception as e:                       # система не дала открыть своё окно —
        print(f"[GeoMetric] Своё окно не открылось ({e}), открою окно браузера.")   # поясняем в журнале
        return False                             #   и уходим в запасной способ (браузер)
    return True                                  # окно закрыто пользователем — работа окончена


# ---------------------------------------------------------------------------
#  ЗАПАСНОЙ СПОСОБ: окно Chrome/Edge в режиме --app
# ---------------------------------------------------------------------------
def find_browser():
    """Ищет Chrome или Edge, чтобы открыть приложение в режиме «отдельного окна» (--app)."""
    if sys.platform.startswith("win"):                       # Windows —
        candidates = [                                       #   типовые места установки браузеров
            os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ]
    elif sys.platform == "darwin":                           # macOS —
        candidates = [                                       #   приложения в /Applications
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    else:                                                    # Linux —
        candidates = [                                       #   команды в PATH
            "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable",
        ]
    for path in candidates:                                  # проходим по списку
        if os.path.exists(path):                             # нашли файл —
            return path                                      #   возвращаем путь
    return None                                              # ничего не нашли


def open_app_window(url: str, profile_dir: str):
    """Открывает приложение: Chrome/Edge в режиме --app, иначе — браузер по умолчанию."""
    browser = find_browser()                                 # ищем браузерный движок
    if browser:                                              # нашли —
        os.makedirs(profile_dir, exist_ok=True)              #   создаём отдельный профиль (чтобы окно было «своим»)
        cmd = [                                              #   собираем команду запуска
            browser,
            f"--app={url}?app=1",                            #   режим приложения: без адресной строки и вкладок
            "--window-size=1280,840",                        #   удобный размер окна
            "--window-position=80,60",                       #   положение на экране
            f"--user-data-dir={profile_dir}",                #   отдельный профиль: история и пароли браузера не смешиваются
            "--no-first-run",                                #   без приветственных окон браузера
            "--no-default-browser-check",                    #   не спрашивать про браузер по умолчанию
            "--disable-pinch",                               #   запрещаем масштабирование жестом (как в приложении)
            "--overscroll-history-navigation=0",             #   прокрутка «за край» не листает историю
            "--disable-features=TouchpadOverscrollHistoryNavigation",   #   и не мешает работать
            "--hide-scrollbars",                             #   окно без полос прокрутки, как у обычной программы
            "--disable-background-mode",                     #   после закрытия окна процесс не висит в памяти
        ]
        proc = subprocess.Popen(cmd)                         # запускаем как отдельную программу
        return proc                                          # возвращаем процесс, чтобы ждать его закрытия
    webbrowser.open(url + "?app=1")                          # браузера из списка нет — открываем системным
    return None                                              # процесса для ожидания нет


# ---------------------------------------------------------------------------
#  Точка входа
# ---------------------------------------------------------------------------
def main():
    """Запускает приложение: локальный сервер файлов + окно мессенджера."""
    port = find_free_port()                                  # выбираем свободный порт
    httpd = start_local_server(port)                         # поднимаем локальный сервер интерфейса
    url = f"http://127.0.0.1:{port}/index.html"              # адрес приложения (адрес сервера вводится в нём же)
    try:
        with open(PORT_FILE, "w", encoding="utf-8") as f:     # пишем номер порта в файл —
            f.write(str(port))                               #   его читает GeoMetric.exe, чтобы открыть окно
    except Exception:                                        # не удалось записать (нет прав) —
        pass                                                 #   не страшно: запускатор поищет адрес в журнале
    print("=" * 64)                                          # рамка для красоты
    print("  GeoMetric запущен")                             # сообщаем в консоль
    print(f"  Интерфейс приложения: {url}")                  # показываем локальный адрес (его же ищет GeoMetric.exe)
    print("  Сервер сообщений выбирается внутри приложения (экран «Адрес сервера»).")   # напоминаем про сервер
    print("=" * 64)                                          # закрываем рамку
    sys.stdout.flush()                                       # сразу отдаём написанное в журнал (его читает GeoMetric.exe)

    if EXTERNAL_WINDOW:                                      # окно рисует сам GeoMetric.exe —
        print("Окно приложения рисует GeoMetric.exe. Это окно закрывать не нужно.")   # поясняем в журнале
        try:
            while True:                                      # держим локальный сервер запущенным,
                time.sleep(3600)                             #   пока запускатор не закончит работу
        except KeyboardInterrupt:                            # если приложение закрывают —
            pass                                             #   спокойно выходим
        return                                               # и завершаемся

    try:
        # 1) Если своё окно открыть нечем — перезапускаемся встроенным Python (там библиотека окна уже есть).
        if not pywebview_available() and relaunch_with_bundled_python():   # перезапуск удался —
            return                                           #   дальше работает новый процесс, а этот закрывается
        # 1.1) Совсем без библиотеки окна: пробуем поставить её сами (это работает, если есть интернет).
        if not pywebview_available() and not LAUNCHED_BY_EXE and install_pywebview():   # установка удалась —
            print("Библиотека окна установлена — открываю своё окно.")                  #   поясняем в журнале
        # 2) Пробуем открыть окно СО СВОЕЙ РАМКОЙ (кнопки «свернуть», «развернуть», «закрыть»).
        if open_own_window(url):                             # окно открылось и уже закрыто пользователем —
            return                                           #   работа завершена
        # 3) Если своя рамка недоступна — открываем окно браузера.
        if LAUNCHED_BY_EXE:                                  # нас запустил GeoMetric.exe —
            print("Закройте программу через панель задач (окно откроет GeoMetric.exe).")   # подсказываем
            while True:                                      # держим программу запущенной,
                time.sleep(1)                                #   раз в секунду просыпаемся
        profile_dir = os.path.join(BASE_DIR, "browser-profile")   # папка отдельного профиля браузера
        proc = open_app_window(url, profile_dir)             # открываем окно приложения
        if proc:                                             # окно запущено как отдельный процесс —
            proc.wait()                                      #   ждём, пока пользователь его закроет
        else:                                                # окно открылось в браузере по умолчанию —
            print("Закройте это окно, чтобы выключить приложение.")   # подсказываем
            while True:                                      # держим программу запущенной
                time.sleep(1)                                # раз в секунду просыпаемся
    except KeyboardInterrupt:                                # пользователь нажал Ctrl+C —
        pass                                                 #   выходим спокойно
    finally:                                                 # в любом случае
        httpd.shutdown()                                     # останавливаем локальный сервер файлов
        try:
            os.remove(PORT_FILE)                             # убираем файл с портом,
        except OSError:                                      # если он есть
            pass                                             # иначе просто идём дальше
        print("GeoMetric закрыт.")                           # прощаемся


if __name__ == "__main__":                                   # запуск только при прямом вызове файла
    main()
