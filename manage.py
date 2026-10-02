#!/usr/bin/env python3
"""
GeoMetric Beta — консоль владельца (CLI).

Работает с запущенным сервером (локальным или на Render) по HTTPS и ключом ADMIN_KEY.
Зависимостей нет — только стандартная библиотека Python.

  export GM_URL=https://ваш-сервис.onrender.com
  export GM_KEY=<ADMIN_KEY из Render → Environment>

  python manage.py                         # интерактивная консоль
  python manage.py verify @alice           # одна команда
  python manage.py geo @alice
  python manage.py verify-chat @mychannel
  python manage.py export backup.zip       # скачать ZIP всех пользователей, чатов и файлов
  python manage.py import backup.zip       # загрузить архив на (новый) сервер
  python manage.py --url http://localhost:3000 --key SECRET stats
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def req(url, key, path, data=None, method=None, ctype='application/json', timeout=300):
    r = urllib.request.Request(url.rstrip('/') + path, data=data, method=method or ('POST' if data is not None else 'GET'))
    r.add_header('X-Admin-Key', key)
    r.add_header('User-Agent', 'geometric-manage/1.0')
    if data is not None:
        r.add_header('Content-Type', ctype)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        sys.exit(f'Не удалось подключиться к {url}: {e.reason}')


def run(url, key, line):
    st, body = req(url, key, '/api/admin/console', json.dumps({'cmd': line}).encode())
    if st == 401:
        sys.exit('Неверный ключ (или на сервере не задан ADMIN_KEY).')
    try:
        return json.loads(body).get('out', '')
    except Exception:
        return body.decode('utf8', 'replace')


def main():
    ap = argparse.ArgumentParser(description='GeoMetric Beta — консоль владельца', add_help=True)
    ap.add_argument('--url', default=os.environ.get('GM_URL', 'http://localhost:3000'))
    ap.add_argument('--key', default=os.environ.get('GM_KEY', ''))
    ap.add_argument('cmd', nargs=argparse.REMAINDER, help='команда (help — список)')
    a = ap.parse_args()
    if not a.key:
        sys.exit('Нужен ключ: --key или переменная GM_KEY (значение ADMIN_KEY сервера).')
    c = a.cmd
    if c and c[0] == 'export':
        out = c[1] if len(c) > 1 else 'geometric-backup.zip'
        st, body = req(a.url, a.key, '/api/admin/export')
        if st != 200:
            sys.exit(f'Ошибка {st}: {body[:200]!r}')
        with open(out, 'wb') as f:
            f.write(body)
        print(f'✔ Архив сохранён: {out} ({len(body) / 1024:.0f} КБ)')
        return
    if c and c[0] == 'import':
        if len(c) < 2:
            sys.exit('Использование: python manage.py import backup.zip')
        data = open(c[1], 'rb').read()
        if input('Это ЗАМЕНИТ все данные на сервере данными из архива. Продолжить? [y/N] ').strip().lower() != 'y':
            return sys.exit('Отменено.')
        st, body = req(a.url, a.key, '/api/admin/import', data, ctype='application/zip')
        print(body.decode('utf8', 'replace') if st == 200 else f'Ошибка {st}: {body[:200]!r}')
        return
    if c:
        print(run(a.url, a.key, ' '.join(c)))
        return
    print(f'GeoMetric Beta · консоль владельца · {a.url}\nВведите help для списка команд, exit — выход.\n')
    try:
        import readline  # noqa: F401  (история стрелками)
    except Exception:
        pass
    while True:
        try:
            line = input('geo> ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if line in ('exit', 'quit', 'q'):
            break
        if line:
            print(run(a.url, a.key, line))


if __name__ == '__main__':
    main()
