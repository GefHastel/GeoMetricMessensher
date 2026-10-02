#!/usr/bin/env python3
"""
GeoMetric Beta — сервер мессенджера на Python.

Один процесс отдаёт И сайт (public/), И API, И реалтайм:
  aiohttp (HTTP + статика) + python-socketio (события, QR-вход, WebRTC-сигналинг)
  Хранилище: PostgreSQL (DATABASE_URL, asyncpg) либо файл DATA_DIR/db.json
  Почта: Brevo / Resend (HTTPS API) или SMTP; без настроек — демо-режим (код на экране)
"""
import asyncio
import hashlib
import inspect
import json
import mimetypes
import os
import re
import secrets
import smtplib
import ssl
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from urllib.parse import quote
from dotenv import load_dotenv
from html import escape as html_escape
load_dotenv()

import aiohttp
import socketio
from aiohttp import web

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / 'public'
PORT = int(os.environ.get('PORT', 3000))
DATA_DIR = Path(os.environ.get('DATA_DIR') or BASE / 'data')
UPLOAD_DIR = DATA_DIR / 'uploads'
DB_FILE = DATA_DIR / 'db.json'
APP_NAME = 'GeoMetric Beta'
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('text/javascript', '.js')

sio = socketio.AsyncServer(async_mode='aiohttp', cors_allowed_origins='*', ping_interval=20, ping_timeout=25,
                           max_http_buffer_size=2_000_000, logger=False, engineio_logger=False)


# ───────────────────────── helpers ─────────────────────────
def now() -> int:
    return int(time.time() * 1000)


def rid(n: int = 16) -> str:
    return secrets.token_hex(n)


def clamp(s, n: int) -> str:
    return ('' if s is None else str(s))[:n]


def num(x, default=0):
    """аналог JS `+x || 0`"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    if v != v or v in (float('inf'), float('-inf')):
        return default
    return int(v) if v.is_integer() else v


def toint(x, default=0) -> int:
    v = num(x, default)
    return int(v)


EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$')
USERNAME_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9_]{4,31}$')
MEDIA_RE = re.compile(r'^/media/[a-f0-9]+$')
ID_RE = re.compile(r'^[a-f0-9]+$')


def valid_email(e: str) -> bool:
    return bool(EMAIL_RE.match(e)) and len(e) <= 120


def sha(s: str) -> str:
    return hashlib.sha256((s + (os.environ.get('CODE_SECRET') or 'geometric-secret')).encode()).hexdigest()


def parse_ua(ua: str = ''):
    b, o = 'Browser', 'Unknown'
    if 'Edg/' in ua: b = 'Edge'
    elif 'OPR/' in ua: b = 'Opera'
    elif 'Firefox/' in ua: b = 'Firefox'
    elif 'Chrome/' in ua: b = 'Chrome'
    elif 'Safari/' in ua: b = 'Safari'
    if 'Windows' in ua: o = 'Windows'
    elif 'Android' in ua: o = 'Android'
    elif 'iPhone' in ua or 'iPad' in ua: o = 'iOS'
    elif 'Mac OS' in ua: o = 'macOS'
    elif 'Linux' in ua: o = 'Linux'
    mobile = any(k in ua for k in ('Android', 'iPhone', 'iPad', 'Mobile'))
    return {'browser': b, 'os': o, 'mobile': mobile}


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code


def err(status: int, code: str):
    raise ApiError(status, code)


def log(*a):
    print(*a, flush=True)


# ───────────────────────── storage ─────────────────────────
pool = None          # asyncpg pool (если задан DATABASE_URL)
db: dict = {}
msg_index: dict = {}     # msgId -> chatId
user_chats: dict = {}    # uid(int) -> set(chatId)
_save_handle = None
_saving = False


def blank():
    return {'users': {}, 'sessions': {}, 'chats': {}, 'messages': {}, 'scheduled': [], 'usernames': {}, 'reports': [], 'sys': {},
            'c': {'user': 0, 'msg': 0, 'chat': 0, 'sched': 0, 'report': 0}}


async def load_db():
    global db, pool
    dsn = os.environ.get('DATABASE_URL')
    if dsn:
        import asyncpg
        sctx = None
        if os.environ.get('PGSSL') != 'off':
            sctx = ssl.create_default_context()
            sctx.check_hostname = False
            sctx.verify_mode = ssl.CERT_NONE
        pool = await asyncpg.create_pool(dsn, ssl=sctx, min_size=1, max_size=5)
        async with pool.acquire() as con:
            await con.execute('create table if not exists kv(key text primary key, value jsonb not null)')
            await con.execute('create table if not exists media(id text primary key, mime text, name text, size int, data bytea)')
            row = await con.fetchrow("select value from kv where key='db'")
        if row:
            v = row['value']
            db = json.loads(v) if isinstance(v, str) else v
        else:
            db = blank()
    elif DB_FILE.exists():
        try:
            db = json.loads(DB_FILE.read_text('utf8'))
        except Exception as e:
            log('db corrupt', e)
            db = blank()
    else:
        db = blank()
    for k, v in blank().items():
        db.setdefault(k, v)
    for cid, arr in db['messages'].items():
        for m in arr:
            msg_index[m['id']] = cid
    for ch in db['chats'].values():
        for uid in ch['members']:
            user_chats.setdefault(int(uid), set()).add(ch['id'])
    seed()


def save():
    global _save_handle
    if _save_handle:
        return
    loop = asyncio.get_event_loop()

    def fire():
        global _save_handle
        _save_handle = None
        asyncio.ensure_future(persist())
    _save_handle = loop.call_later(1.5, fire)


async def persist():
    global _saving
    if _saving:
        save()
        return
    _saving = True
    try:
        s = json.dumps(db, ensure_ascii=False, separators=(',', ':'))
        if pool:
            async with pool.acquire() as con:
                await con.execute("insert into kv(key,value) values('db',$1::jsonb) on conflict (key) do update set value=excluded.value", s)
        else:
            tmp = DB_FILE.with_suffix('.tmp')
            tmp.write_text(s, 'utf8')
            os.replace(tmp, DB_FILE)
    except Exception as e:
        log('save error', e)
    finally:
        _saving = False


# ───────────────────────── mail ─────────────────────────
def mail_from():
    return os.environ.get('MAIL_FROM') or os.environ.get('SMTP_USER') or ''


def mail_provider():
    if os.environ.get('BREVO_API_KEY'): return 'brevo'
    if os.environ.get('RESEND_API_KEY'): return 'resend'
    if os.environ.get('SMTP_HOST'): return 'smtp'
    return None


def mail_html(code):
    safe_code = html_escape(str(code))
    brand = html_escape(str(APP_NAME or "GeoMetric Beta"))

    return f"""<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>{brand} — код входа</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f6fb;color:#182338;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    Ваш код входа в {brand}: {safe_code}. Он действует 10 минут.
  </div>

  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
         style="width:100%;border-collapse:collapse;background-color:#f3f6fb;">
    <tr>
      <td align="center" style="padding:36px 14px;">

        <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"
               style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;border:1px solid #e5eaf2;border-radius:22px;overflow:hidden;background-color:#ffffff;box-shadow:0 18px 50px rgba(19,34,61,0.08);">

          <tr>
            <td style="height:4px;line-height:4px;font-size:0;background-color:#3989ff;background-image:linear-gradient(90deg,#39d7c1,#3989ff,#8a63f8);">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding:25px 30px;background-color:#0d1730;background-image:linear-gradient(135deg,#0d1730,#1a315a);">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="48" height="48" align="center" valign="middle"
                      style="width:48px;height:48px;border-radius:14px;background-color:#3287ff;background-image:linear-gradient(135deg,#39c6e8,#4778ff 58%,#875bff);color:#ffffff;font-size:22px;font-weight:800;">
                    G
                  </td>
                  <td valign="middle" style="padding-left:13px;">
                    <div style="color:#ffffff;font-size:17px;line-height:21px;font-weight:700;letter-spacing:-0.2px;">
                      {brand}
                    </div>
                    <div style="padding-top:4px;color:#a9bbd9;font-size:10px;line-height:14px;font-weight:600;letter-spacing:1.7px;">
                      BETA · SECURE ACCESS
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 30px 30px;background-color:#ffffff;">
              <div style="color:#4778dc;font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;">
                ПОДТВЕРЖДЕНИЕ ВХОДА
              </div>

              <h1 style="margin:10px 0 9px;color:#17243a;font-size:28px;line-height:34px;font-weight:750;letter-spacing:-0.6px;">
                Ваш код доступа
              </h1>

              <p style="margin:0;color:#6c788b;font-size:15px;line-height:23px;">
                Введите его на странице {brand}, чтобы завершить вход.
              </p>

              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
                     style="width:100%;margin-top:25px;border-collapse:separate;border-spacing:0;">
                <tr>
                  <td align="center" style="padding:19px 12px 21px;border:1px solid #dce9ff;border-radius:16px;background-color:#f2f7ff;">
                    <div style="color:#8292ac;font-size:10px;line-height:14px;font-weight:700;letter-spacing:2px;">
                      ОДНОРАЗОВЫЙ КОД
                    </div>
                    <div style="padding-top:8px;color:#2673e8;font-size:34px;line-height:42px;font-weight:750;letter-spacing:7px;">
                      <span dir="ltr" style="white-space:nowrap;">{safe_code}</span>
                    </div>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
                     style="width:100%;margin-top:15px;border-collapse:separate;border-spacing:0;">
                <tr>
                  <td style="padding:14px 15px;border:1px solid #edf0f5;border-radius:14px;background-color:#f8fafc;">
                    <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td width="42" valign="middle" style="width:42px;">
                          <div style="width:31px;height:31px;border-radius:10px;background-color:#e8f0ff;color:#3975d8;text-align:center;font-size:13px;line-height:31px;font-weight:800;">
                            10
                          </div>
                        </td>
                        <td valign="middle">
                          <div style="color:#26354c;font-size:14px;line-height:20px;font-weight:700;">
                            Код действует 10 минут
                          </div>
                          <div style="padding-top:3px;color:#7b8798;font-size:12px;line-height:18px;">
                            Используйте его один раз и никому не пересылайте.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0;color:#8a95a5;font-size:12px;line-height:19px;">
                Если вы не запрашивали код, просто проигнорируйте это письмо.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:16px 24px;border-top:1px solid #edf0f5;background-color:#fafbfd;color:#98a2b1;font-size:11px;line-height:17px;">
              Письмо отправлено автоматически сервисом {brand}. Отвечать на него не нужно.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _smtp_send(to, subject, text, html):
    host, port = os.environ['SMTP_HOST'], int(os.environ.get('SMTP_PORT') or 587)
    msg = MIMEMultipart('alternative')
    msg['Subject'], msg['From'], msg['To'] = subject, f'"{APP_NAME}" <{mail_from()}>', to
    msg.attach(MIMEText(text, 'plain', 'utf-8'))
    msg.attach(MIMEText(html, 'html', 'utf-8'))
    cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
    with cls(host, port, timeout=20) as s:
        if port != 465:
            try:
                s.starttls()
            except Exception:
                pass
        if os.environ.get('SMTP_USER'):
            s.login(os.environ['SMTP_USER'], os.environ.get('SMTP_PASS', ''))
        s.sendmail(mail_from(), [to], msg.as_string())


async def send_mail(to: str, code: str) -> str:
    subject = f'{code} — код входа в {APP_NAME}'
    text = f'Ваш код подтверждения {APP_NAME}: {code}\nКод действует 10 минут.'
    html = mail_html(code)
    p = mail_provider()
    if p == 'brevo':
        async with aiohttp.ClientSession() as cs:
            async with cs.post('https://api.brevo.com/v3/smtp/email',
                               headers={'api-key': os.environ['BREVO_API_KEY'], 'accept': 'application/json'},
                               json={'sender': {'name': APP_NAME, 'email': mail_from()}, 'to': [{'email': to}], 'subject': subject,
                                     'htmlContent': html, 'textContent': text}, timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status >= 300:
                    raise RuntimeError(f'brevo {r.status} {await r.text()}')
    elif p == 'resend':
        async with aiohttp.ClientSession() as cs:
            async with cs.post('https://api.resend.com/emails', headers={'Authorization': 'Bearer ' + os.environ['RESEND_API_KEY']},
                               json={'from': f'{APP_NAME} <{mail_from()}>', 'to': [to], 'subject': subject, 'html': html, 'text': text},
                               timeout=aiohttp.ClientTimeout(total=20)) as r:
                if r.status >= 300:
                    raise RuntimeError(f'resend {r.status} {await r.text()}')
    elif p == 'smtp':
        await asyncio.to_thread(_smtp_send, to, subject, text, html)
    else:
        log(f'[MAIL:DEV] code for {to}: {code}')
        return 'dev'
    return 'sent'


# ───────────────────────── rate limit ─────────────────────────
hits: dict = {}


def limited(key: str, mx: int, window_ms: float) -> bool:
    t = now()
    a = [x for x in hits.get(key, []) if t - x < window_ms]
    a.append(t)
    hits[key] = a
    return len(a) > mx


# ───────────────────────── socket emit queue (сохраняет порядок событий) ─────────────────────────
_q: asyncio.Queue = None  # type: ignore


def emit_room(room, ev, data, skip=None):
    _q.put_nowait((room, ev, data, skip))


def emit_to(uid, ev, data):
    emit_room(f'u:{uid}', ev, data)


async def _emitter():
    while True:
        room, ev, data, skip = await _q.get()
        try:
            await sio.emit(ev, data, room=room, skip_sid=skip)
        except Exception as e:
            log('emit error', ev, e)


# ───────────────────────── users ─────────────────────────
online: dict = {}      # uid -> set(sid)
sess_online: dict = {}  # session sid -> count


def is_online(uid) -> bool:
    return len(online.get(int(uid), ())) > 0


def U(i):
    return db['users'].get(str(i)) if i is not None else None


def seed():
    if '1' not in db['users']:
        db['c']['user'] = max(db['c']['user'], 1)
        db['users']['1'] = {'id': 1, 'email': 'system@geometric.local', 'name': 'GeoMetric', 'lastName': '', 'username': 'geometric',
                            'bio': 'Официальный бот GeoMetric Beta. Напишите /help', 'avatar': '', 'color': 5, 'emoji': '',
                            'verified': True, 'bot': True, 'createdAt': now(), 'lastSeen': now(), 'privacy': {}, 'settings': {},
                            'contacts': [], 'blocked': []}
        db['usernames']['geometric'] = {'t': 'user', 'id': 1}
    seed_system()


def new_user(email: str):
    db['c']['user'] += 1
    uid = db['c']['user']
    nm = re.sub(r'[._-]+', ' ', email.split('@')[0])
    nm = re.sub(r'\d+', '', nm).strip() or 'User'
    db['users'][str(uid)] = {'id': uid, 'email': email, 'name': nm[:1].upper() + nm[1:30], 'lastName': '', 'username': '', 'bio': '',
                             'birthday': None, 'avatar': '', 'color': uid % 8, 'emoji': '', 'createdAt': now(), 'lastSeen': now(),
                             'privacy': {'lastSeen': 'everyone', 'birthday': 'contacts', 'calls': 'everyone', 'photo': 'everyone', 'invites': 'everyone'},
                             'settings': {}, 'contacts': [], 'blocked': []}
    return db['users'][str(uid)]


def pub(u, viewer):
    if not u:
        return None
    selfv = viewer == u['id']
    pr = u.get('privacy') or {}
    is_c = viewer in (u.get('contacts') or [])

    def ok(lvl):
        return selfv or (lvl or 'everyone') == 'everyone' or (lvl == 'contacts' and is_c)
    p = {'id': u['id'], 'name': u['name'], 'lastName': u.get('lastName', ''), 'username': u.get('username', ''), 'bio': u.get('bio', ''),
         'color': u.get('color', 0), 'emoji': u.get('emoji', ''), 'verified': bool(u.get('verified')), 'bot': bool(u.get('bot')),
         'createdAt': u.get('createdAt'), 'deleted': bool(u.get('deleted')), 'geo': bool(u.get('geo')), 'banned': bool(u.get('banned'))}
    if u.get('bot'):
        cfg = u.get('botCfg') or {}
        p['botDesc'] = u.get('botDesc', '')
        p['commands'] = [{'cmd': c['cmd'], 'desc': c.get('desc', '')} for c in cfg.get('commands', [])]
        p['system'] = bool(u.get('system'))
    p['avatar'] = u.get('avatar', '') if ok(pr.get('photo')) else ''
    show_ls = ok(pr.get('lastSeen')) or bool(u.get('bot'))
    p['online'] = bool(show_ls and is_online(u['id']))
    p['lastSeen'] = u.get('lastSeen') if show_ls else None
    p['lastSeenHidden'] = not show_ls
    p['birthday'] = u.get('birthday') if ok(pr.get('birthday')) else None
    if selfv:
        p.update(email=u['email'], privacy=pr, settings=u.get('settings', {}), blocked=u.get('blocked', []), contacts=u.get('contacts', []),
                 birthday=u.get('birthday'), avatar=u.get('avatar', ''), isOwner=bool(u.get('owner')), staff=is_staff(u),
                 hasPassword=bool(u.get('pwd')))
    else:
        v = U(viewer)
        p['isContact'] = u['id'] in ((v or {}).get('contacts') or [])
        p['blockedByMe'] = u['id'] in ((v or {}).get('blocked') or [])
        p['canCall'] = bool(ok(pr.get('calls')))
    return p


def pubs(ids, viewer):
    out, seen = [], set()
    for i in ids:
        if i is None or i in seen:
            continue
        seen.add(i)
        p = pub(U(i), viewer)
        if p:
            out.append(p)
    return out


# ───────────────────────── chats ─────────────────────────
def C(i):
    return db['chats'].get(i) if i is not None else None


def mem(chat, uid):
    return chat['members'].get(str(uid))


def is_member(chat, uid) -> bool:
    if not chat:
        return False
    m = chat['members'].get(str(uid))
    return bool(m) and not m.get('left')


def is_admin(chat, uid) -> bool:
    m = mem(chat, uid)
    return bool(m) and not m.get('left') and m.get('role') in ('owner', 'admin')


def add_member(chat, uid, role='member'):
    chat['members'][str(uid)] = {'role': role, 'read': chat.get('lastId', 0), 'pinned': 0, 'muted': False, 'archived': False, 'joined': now(), 'cleared': 0}
    user_chats.setdefault(int(uid), set()).add(chat['id'])


def private_chat(a: int, b: int):
    x, y = (a, b) if a < b else (b, a)
    cid = f'p:{x}:{y}'
    if cid not in db['chats']:
        ch = db['chats'][cid] = {'id': cid, 'type': 'saved' if a == b else 'private', 'members': {}, 'pins': [], 'lastId': 0, 'created': now()}
        add_member(ch, a)
        if a != b:
            add_member(ch, b)
        db['messages'][cid] = []
    return db['chats'][cid]


def chat_msgs(cid):
    return db['messages'].setdefault(cid, [])


def visible_msgs(chat, uid):
    m = mem(chat, uid)
    cl = m.get('cleared', 0)
    return [x for x in chat_msgs(chat['id']) if x['id'] > cl and uid not in x.get('deletedFor', ())]


def ser_poll(m, uid):
    p = m.get('poll')
    if not p:
        return None
    voted = any(uid in o['voters'] for o in p['options'])
    total = len({v for o in p['options'] for v in o['voters']})
    reveal = voted or p.get('closed')
    out = {'q': p['q'], 'multiple': p.get('multiple'), 'anon': p.get('anon'), 'quiz': p.get('quiz'), 'closed': p.get('closed'), 'total': total, 'voted': voted,
           'options': []}
    if reveal and p.get('explanation') is not None:
        out['explanation'] = p['explanation']
    if p.get('quiz') and reveal and p.get('correct') is not None:
        out['correct'] = p['correct']
    for o in p['options']:
        oo = {'t': o['t'], 'n': len(o['voters']), 'mine': uid in o['voters']}
        if not p.get('anon') and reveal:
            oo['voters'] = o['voters'][:5]
        out['options'].append(oo)
    return out


_SER_KEYS = ('id', 'chatId', 'from', 'type', 'text', 'media', 'ts', 'edited', 'reactions', 'fwd', 'replyTo', 'silent', 'loc', 'call', 'service', 'sticker', 'via', 'markup')


def ser(m, uid, chat=None):
    o = {k: m[k] for k in _SER_KEYS if m.get(k) is not None}
    if m.get('replyTo'):
        r = next((x for x in chat_msgs(m['chatId']) if x['id'] == m['replyTo']), None)
        if r:
            rr = {'id': r['id'], 'from': r['from'], 'text': r['text'], 'type': r['type']}
            if r.get('media') and r['type'] == 'photo':
                rr['thumb'] = r['media']['url']
            if r.get('media', {}) and r['media'].get('name'):
                rr['mediaName'] = r['media']['name']
            if r.get('sticker'):
                rr['sticker'] = r['sticker']
            o['reply'] = rr
    if m.get('poll'):
        o['poll'] = ser_poll(m, uid)
    chat = chat or C(m['chatId'])
    if chat and chat['type'] == 'channel':
        o['views'] = sum(1 for x in chat['members'].values() if x.get('read', 0) >= m['id'])
    return o


def chat_view(chat, uid):
    me = mem(chat, uid)
    msgs = visible_msgs(chat, uid)
    last = msgs[-1] if msgs else None
    rd = me.get('read', 0)
    unread = sum(1 for x in msgs if x['id'] > rd and x['from'] != uid and x['type'] != 'service')
    others = [m for i, m in chat['members'].items() if int(i) != uid and not m.get('left')]
    v = {'id': chat['id'], 'type': chat['type'], 'title': chat.get('title'), 'about': chat.get('about'), 'avatar': chat.get('avatar'),
         'username': chat.get('username'), 'createdBy': chat.get('createdBy'), 'created': chat.get('created'), 'verified': bool(chat.get('verified')),
         'count': sum(1 for m in chat['members'].values() if not m.get('left')), 'pins': chat.get('pins') or [],
         'me': {'role': me.get('role'), 'read': rd, 'pinned': me.get('pinned', 0), 'muted': me.get('muted', False), 'archived': me.get('archived', False),
                'hidden': me.get('hidden'), 'left': me.get('left')},
         'unread': unread, 'last': ser(last, uid, chat) if last else None, 'lastId': chat.get('lastId', 0),
         'peerRead': max((m.get('read', 0) for m in others), default=0)}
    if chat['type'] == 'private':
        v['peer'] = next(int(i) for i in chat['members'] if int(i) != uid)
    if chat['type'] == 'saved':
        v['peer'] = uid
    if chat['type'] not in ('private', 'saved'):
        if is_admin(chat, uid):
            v['invite'] = chat.get('invite')
        v['canPost'] = chat['type'] == 'group' or is_admin(chat, uid)
    else:
        pr = U(v['peer'])
        v['canPost'] = True
        if pr and pr.get('bot'):
            v['bot'] = True
    return v


def members_list(chat):
    return [{'id': int(i), 'role': m.get('role')} for i, m in chat['members'].items() if not m.get('left')]


def broadcast_chat(chat, fn):
    for i, m in list(chat['members'].items()):
        if not m.get('left'):
            fn(int(i))


def push_message(chat, frm, data):
    db['c']['msg'] += 1
    m = {'id': db['c']['msg'], 'chatId': chat['id'], 'from': frm, 'type': data.get('type') or 'text', 'text': data.get('text') or '', 'ts': now(), 'reactions': {}}
    for k in ('media', 'fwd', 'replyTo', 'silent', 'loc', 'call', 'service', 'sticker', 'poll', 'via', 'markup'):
        if data.get(k) is not None:
            m[k] = data[k]
    chat_msgs(chat['id']).append(m)
    msg_index[m['id']] = chat['id']
    chat['lastId'] = m['id']
    if frm and mem(chat, frm):
        mem(chat, frm)['read'] = m['id']
    for mm in chat['members'].values():
        if mm.get('hidden'):
            mm['hidden'] = False
    extra = [int(i) for i in chat['members']] if chat['type'] in ('private', 'saved') else []
    ids = [x for x in [frm, *extra] if x]

    def go(uid):
        emit_to(uid, 'msg:new', {'message': ser(m, uid, chat), 'chat': chat_view(chat, uid), 'users': pubs(ids, uid)})
    broadcast_chat(chat, go)
    save()
    bot_hook(chat, m)
    return m


def service(chat, frm, action, **extra):
    return push_message(chat, frm, {'type': 'service', 'service': {'action': action, **extra}})


# (bot logic lives in the 'bots' section below)


# ───────────────────────── web framework glue ─────────────────────────
routes_list = []


def route(method, path, auth=True):
    def deco(fn):
        routes_list.append((method, path, fn, auth))
        return fn
    return deco


class Ctx:
    def __init__(self, request):
        self.request = request
        self.query = request.query
        self.params = request.match_info
        self.body = {}
        self.uid = None
        self.me = None
        self.s = None

    @property
    def ip(self):
        xf = self.request.headers.get('X-Forwarded-For')
        return xf.split(',')[0].strip() if xf else (self.request.remote or '')

    def pid(self, name='id'):
        return toint(self.params.get(name), -1)


async def load_body(ctx: Ctx):
    r = ctx.request
    if r.method in ('POST', 'PUT', 'PATCH', 'DELETE') and r.can_read_body and 'json' in (r.content_type or ''):
        if (r.content_length or 0) > 2_000_000:
            err(413, 'too_big')
        try:
            b = await r.json()
            ctx.body = b if isinstance(b, dict) else {}
        except Exception:
            ctx.body = {}


def authenticate(ctx: Ctx):
    h = ctx.request.headers.get('Authorization', '')
    tok = h[7:] if h.startswith('Bearer ') else ''
    s = db['sessions'].get(tok)
    if not s or str(s['userId']) not in db['users']:
        err(401, 'unauthorized')
    u = db['users'][str(s['userId'])]
    if u.get('banned'):
        err(403, 'banned')
    s['active'] = now()
    ctx.s, ctx.uid, ctx.me = s, s['userId'], u


def make_handler(fn, need_auth):
    async def handler(request):
        ctx = Ctx(request)
        try:
            if need_auth:
                authenticate(ctx)
            await load_body(ctx)
            r = fn(ctx)
            if inspect.isawaitable(r):
                r = await r
            if isinstance(r, web.StreamResponse):
                return r
            if isinstance(r, tuple):
                return web.json_response(r[1], status=r[0])
            return web.json_response(r if r is not None else {'ok': True}, dumps=lambda o: json.dumps(o, ensure_ascii=False))
        except ApiError as e:
            return web.json_response({'error': e.code}, status=e.status)
        except web.HTTPException:
            raise
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({'error': 'server_error'}, status=500)
    return handler


def create_session(uid, ua, ip, device):
    token = rid(32)
    p = parse_ua(ua or '')
    db['sessions'][token] = {'sid': rid(6), 'token': token, 'userId': uid, 'device': device or f"{p['browser']}, {p['os']}", 'mobile': p['mobile'],
                             'ip': ip or '', 'created': now(), 'active': now()}
    save()
    return token


# ───────────────────────── auth routes ─────────────────────────
codes: dict = {}


@route('POST', '/api/auth/request', auth=False)
async def auth_request(c: Ctx):
    email = clamp(c.body.get('email'), 120).strip().lower()
    if not valid_email(email):
        err(400, 'bad_email')
    if limited('ip:' + c.ip, 20, 600e3) or limited('em:' + email, 5, 600e3):
        err(429, 'too_many')
    old = codes.get(email)
    if old and now() - old['sent'] < 25e3:
        err(429, 'wait')
    code = str(10000 + secrets.randbelow(90000))
    codes[email] = {'hash': sha(email + code), 'exp': now() + 600e3, 'tries': 0, 'sent': now()}
    try:
        mode = await send_mail(email, code)
    except Exception as e:
        log('mail error', e)
        codes.pop(email, None)
        err(502, 'mail_failed')
    exists = any(u['email'] == email for u in db['users'].values())
    out = {'ok': True, 'mode': mode, 'exists': exists}
    if mode == 'dev' and os.environ.get('HIDE_DEV_CODE') != '1':
        out['devCode'] = code
    return out


@route('POST', '/api/auth/verify', auth=False)
def auth_verify(c: Ctx):
    email = clamp(c.body.get('email'), 120).strip().lower()
    code = clamp(c.body.get('code'), 5).strip()
    cd = codes.get(email)
    if not cd or cd['exp'] < now():
        err(400, 'expired')
    cd['tries'] += 1
    if cd['tries'] > 5:
        codes.pop(email, None)
        err(429, 'too_many')
    if not re.fullmatch(r'\d{5}', code) or sha(email + code) != cd['hash']:
        err(400, 'wrong_code')
    codes.pop(email, None)
    u = next((x for x in db['users'].values() if x['email'] == email and not x.get('deleted')), None)
    if u and u.get('banned'):
        return 403, {'error': 'banned', 'reason': u['banned'].get('reason', '')}
    is_new = False
    if not u:
        u = new_user(email)
        is_new = True
        apply_owner_emails()
        ch = private_chat(1, u['id'])
        push_message(ch, 1, {'text': f"👋 Добро пожаловать в **GeoMetric Beta**, {u['name']}!\n\nЯ покажу, что тут можно делать — напишите /help. Заполните профиль в «Настройки → Редактировать профиль»: аватар, @username, дату рождения и описание.\n\n🤖 Попробуйте ИИ-помощника @geoai и создайте своего бота через @botfather."})
    token = create_session(u['id'], c.request.headers.get('User-Agent', ''), c.ip, clamp(c.body.get('device'), 80))
    return {'token': token, 'user': pub(u, u['id']), 'isNew': is_new}


@route('POST', '/api/auth/logout')
def auth_logout(c: Ctx):
    db['sessions'].pop(c.s['token'], None)
    save()
    emit_room('s:' + c.s['sid'], 'session:revoked', None)
    return {'ok': True}


# QR: desktop uses socket, phone uses these routes
qr_tokens: dict = {}


@route('POST', '/api/qr/scan')
def qr_scan(c: Ctx):
    q = qr_tokens.get(str(c.body.get('token') or ''))
    if not q or q['exp'] < now():
        err(404, 'qr_expired')
    q['scanner'], q['state'] = c.uid, 'scanned'
    emit_room(q['sid'], 'qr:scanned', {'user': {'name': c.me['name'], 'avatar': c.me.get('avatar', ''), 'color': c.me.get('color', 0)}})
    return {'device': q['device'], 'ip': q['ip']}


@route('POST', '/api/qr/approve')
def qr_approve(c: Ctx):
    t = str(c.body.get('token') or '')
    q = qr_tokens.get(t)
    if not q or q['exp'] < now() or q.get('scanner') != c.uid:
        err(404, 'qr_expired')
    qr_tokens.pop(t, None)
    if not c.body.get('ok'):
        emit_room(q['sid'], 'qr:rejected', None)
        return {'ok': True}
    token = create_session(c.uid, q['ua'], q['ip'], q['device'])
    emit_room(q['sid'], 'qr:approved', {'token': token, 'user': pub(c.me, c.uid)})
    return {'ok': True}


# ───────────────────────── me / profile ─────────────────────────
def username_free(u, self_key=None):
    e = db['usernames'].get(u.lower())
    return e is None or bool(self_key and e['t'] == self_key['t'] and e['id'] == self_key['id'])


@route('GET', '/api/username/check')
def username_check(c: Ctx):
    u = str(c.query.get('u', ''))
    if not USERNAME_RE.match(u):
        return {'ok': False, 'reason': 'invalid'}
    chat = c.query.get('chat')
    key = {'t': 'chat', 'id': chat} if chat else {'t': 'user', 'id': c.uid}
    return {'ok': username_free(u, key), 'reason': 'taken'}


@route('GET', '/api/me')
def get_me(c: Ctx):
    return {'user': pub(c.me, c.uid)}


@route('PATCH', '/api/me')
def patch_me(c: Ctx):
    u, b = c.me, c.body
    if 'name' in b:
        n = clamp(b['name'], 40).strip()
        if not n:
            err(400, 'name_required')
        u['name'] = n
    if 'lastName' in b: u['lastName'] = clamp(b['lastName'], 40).strip()
    if 'bio' in b: u['bio'] = clamp(b['bio'], 200)
    if 'color' in b: u['color'] = max(0, min(7, toint(b['color'])))
    if 'emoji' in b: u['emoji'] = clamp(b['emoji'], 8)
    if 'avatar' in b: u['avatar'] = b['avatar'] if MEDIA_RE.fullmatch(b.get('avatar') or '') else ''
    if 'birthday' in b:
        bd = b['birthday']
        if not bd:
            u['birthday'] = None
        else:
            d, m = toint(bd.get('d')), toint(bd.get('m'))
            y = toint(bd.get('y')) if bd.get('y') else None
            if not (1 <= d <= 31 and 1 <= m <= 12) or (y and (y < 1900 or y > time.gmtime().tm_year + 1)):
                err(400, 'bad_birthday')
            u['birthday'] = {'d': d, 'm': m, 'y': y}
    if 'username' in b:
        nu = str(b['username'] or '')
        nu = nu[1:] if nu.startswith('@') else nu
        if nu:
            if not USERNAME_RE.match(nu):
                err(400, 'bad_username')
            if not username_free(nu, {'t': 'user', 'id': u['id']}):
                err(409, 'username_taken')
        if u.get('username'):
            db['usernames'].pop(u['username'].lower(), None)
        u['username'] = nu
        if nu:
            db['usernames'][nu.lower()] = {'t': 'user', 'id': u['id']}
    if isinstance(b.get('privacy'), dict):
        for k in ('lastSeen', 'birthday', 'calls', 'photo', 'invites'):
            if b['privacy'].get(k) in ('everyone', 'contacts', 'nobody'):
                u['privacy'][k] = b['privacy'][k]
    save()
    emit_room(f"u:{u['id']}", 'me:update', {'user': pub(u, u['id'])})
    presence_broadcast(u['id'])
    return {'user': pub(u, u['id'])}


@route('PUT', '/api/me/settings')
def put_settings(c: Ctx):
    s = c.body if isinstance(c.body, dict) else {}
    if len(json.dumps(s)) > 20000:
        err(400, 'too_big')
    c.me['settings'] = s
    save()
    emit_room(f'u:{c.uid}', 'settings:sync', {'settings': s, 'from': c.s['sid']})
    return {'ok': True}


@route('DELETE', '/api/me')
def delete_me(c: Ctx):
    u = c.me
    for t, s in list(db['sessions'].items()):
        if s['userId'] == u['id']:
            db['sessions'].pop(t, None)
            emit_room('s:' + s['sid'], 'session:revoked', None)
    if u.get('username'):
        db['usernames'].pop(u['username'].lower(), None)
    u.update(name='Deleted Account', lastName='', username='', bio='', avatar='', email=f"deleted{u['id']}@deleted", deleted=True, birthday=None, emoji='')
    save()
    return {'ok': True}


@route('GET', '/api/sessions')
def list_sessions(c: Ctx):
    ss = sorted((s for s in db['sessions'].values() if s['userId'] == c.uid), key=lambda s: -s['active'])
    return {'sessions': [{'sid': s['sid'], 'device': s['device'], 'mobile': s.get('mobile'), 'ip': s.get('ip'), 'created': s['created'], 'active': s['active'],
                          'current': s['token'] == c.s['token'], 'online': sess_online.get(s['sid'], 0) > 0} for s in ss]}


@route('DELETE', '/api/sessions/{sid}')
def kill_session(c: Ctx):
    for t, s in list(db['sessions'].items()):
        if s['userId'] == c.uid and s['sid'] == c.params['sid'] and t != c.s['token']:
            db['sessions'].pop(t, None)
            emit_room('s:' + s['sid'], 'session:revoked', None)
    save()
    return {'ok': True}


@route('DELETE', '/api/sessions')
def kill_other_sessions(c: Ctx):
    for t, s in list(db['sessions'].items()):
        if s['userId'] == c.uid and t != c.s['token']:
            db['sessions'].pop(t, None)
            emit_room('s:' + s['sid'], 'session:revoked', None)
    save()
    return {'ok': True}


# ───────────────────────── users / contacts ─────────────────────────
@route('GET', '/api/users/{id}')
def get_user(c: Ctx):
    u = U(c.pid())
    if not u:
        err(404, 'not_found')
    return {'user': pub(u, c.uid)}


@route('POST', '/api/users/batch')
def users_batch(c: Ctx):
    ids = [toint(x, -1) for x in (c.body.get('ids') or [])[:200]]
    return {'users': pubs(ids, c.uid)}


@route('GET', '/api/contacts')
def get_contacts(c: Ctx):
    return {'users': pubs(c.me.get('contacts') or [], c.uid)}


@route('POST', '/api/contacts/{id}')
def add_contact(c: Ctx):
    i = c.pid()
    if not U(i) or i == c.uid:
        err(400, 'bad')
    if i not in c.me['contacts']:
        c.me['contacts'].append(i)
    save()
    emit_to(c.uid, 'me:update', {'user': pub(c.me, c.uid)})
    return {'user': pub(U(i), c.uid)}


@route('DELETE', '/api/contacts/{id}')
def del_contact(c: Ctx):
    i = c.pid()
    c.me['contacts'] = [x for x in c.me['contacts'] if x != i]
    save()
    emit_to(c.uid, 'me:update', {'user': pub(c.me, c.uid)})
    return {'ok': True}


@route('POST', '/api/users/{id}/block')
def block_user(c: Ctx):
    i = c.pid()
    if not U(i) or i == c.uid or i in SYSTEM_BOTS:
        err(400, 'bad')
    b = c.me['blocked']
    if c.body.get('block') and i not in b:
        b.append(i)
    if not c.body.get('block') and i in b:
        b.remove(i)
    save()
    emit_to(c.uid, 'me:update', {'user': pub(c.me, c.uid)})
    return {'user': pub(U(i), c.uid)}


@route('GET', '/api/search')
def search(c: Ctx):
    q = str(c.query.get('q', '')).strip().lower()
    q = q[1:] if q.startswith('@') else q
    if not q:
        return {'users': [], 'chats': [], 'messages': []}
    users = [u for u in db['users'].values() if not u.get('deleted') and u['id'] != c.uid
             and (q in (u.get('username') or '').lower() or q in f"{u['name']} {u.get('lastName', '')}".lower())][:20]
    chats = [ch for ch in db['chats'].values() if ch['type'] in ('group', 'channel')
             and (q in ch['title'].lower() or q in (ch.get('username') or '').lower()) and (is_member(ch, c.uid) or ch.get('username'))][:15]
    messages = []
    if len(q) >= 2:
        for cid in list(user_chats.get(c.uid, ())):
            ch = C(cid)
            if not is_member(ch, c.uid):
                continue
            for m in visible_msgs(ch, c.uid):
                if m.get('text') and m['type'] != 'service' and q in m['text'].lower():
                    messages.append(m)
    messages.sort(key=lambda m: -m['ts'])
    ms = messages[:30]
    return {'users': pubs([u['id'] for u in users], c.uid),
            'chats': [{'id': ch['id'], 'type': ch['type'], 'title': ch['title'], 'avatar': ch.get('avatar'), 'username': ch.get('username'),
                       'count': len(ch['members']), 'joined': is_member(ch, c.uid), 'verified': bool(ch.get('verified'))} for ch in chats],
            'messages': [ser(m, c.uid) for m in ms], 'mUsers': pubs([m['from'] for m in ms], c.uid)}


@route('GET', '/api/resolve/{username}')
def resolve(c: Ctx):
    n = c.params['username'].lower()
    n = n[1:] if n.startswith('@') else n
    e = db['usernames'].get(n)
    if not e:
        err(404, 'not_found')
    if e['t'] == 'user':
        return {'type': 'user', 'user': pub(U(e['id']), c.uid)}
    ch = C(e['id'])
    return {'type': 'chat', 'chat': {'id': ch['id'], 'type': ch['type'], 'title': ch['title'], 'avatar': ch.get('avatar'), 'about': ch.get('about'),
                                      'username': ch.get('username'), 'count': len(ch['members']), 'joined': is_member(ch, c.uid), 'verified': bool(ch.get('verified'))}}


# ───────────────────────── chats ─────────────────────────
@route('GET', '/api/bootstrap')
def bootstrap(c: Ctx):
    uid = c.uid
    private_chat(uid, uid)
    ensure_geoai_chat(uid)
    lst = [ch for ch in (C(i) for i in list(user_chats.get(uid, ()))) if ch and is_member(ch, uid) and not mem(ch, uid).get('hidden')]
    chats = [chat_view(ch, uid) for ch in lst]
    uids = [uid, *(c.me.get('contacts') or []), *(c.me.get('blocked') or [])]
    for ch in chats:
        if ch.get('peer'): uids.append(ch['peer'])
        if ch.get('last'): uids.append(ch['last']['from'])
    return {'me': pub(c.me, uid), 'chats': chats, 'users': pubs(uids, uid), 'sid': c.s['sid'], 'mail': mail_provider() or 'dev'}


@route('POST', '/api/chats/private')
def chats_private(c: Ctx):
    i = toint(c.body.get('userId'), -1)
    u = U(i)
    if not u or u.get('deleted'):
        err(404, 'not_found')
    ch = private_chat(c.uid, i)
    mem(ch, c.uid)['hidden'] = False
    return {'chat': chat_view(ch, c.uid), 'users': pubs([i, c.uid], c.uid)}


@route('POST', '/api/chats')
def create_chat(c: Ctx):
    b = c.body
    typ = 'channel' if b.get('type') == 'channel' else 'group'
    title = clamp(b.get('title'), 64).strip()
    if not title:
        err(400, 'title_required')
    uname = b.get('username')
    if uname and (not USERNAME_RE.match(str(uname)) or not username_free(str(uname))):
        err(409, 'username_taken')
    db['c']['chat'] += 1
    cid = f"g:{db['c']['chat']}"
    ch = db['chats'][cid] = {'id': cid, 'type': typ, 'title': title, 'about': clamp(b.get('about'), 255),
                             'avatar': b['avatar'] if MEDIA_RE.fullmatch(b.get('avatar') or '') else '', 'username': '', 'createdBy': c.uid,
                             'created': now(), 'pins': [], 'lastId': 0, 'invite': rid(8), 'members': {}}
    db['messages'][cid] = []
    if uname:
        ch['username'] = str(uname)
        db['usernames'][str(uname).lower()] = {'t': 'chat', 'id': cid}
    add_member(ch, c.uid, 'owner')
    ids = list(dict.fromkeys(toint(x, -1) for x in (b.get('members') or [])))
    for x in [i for i in ids if U(i) and i != c.uid and not U(i).get('deleted')][:200]:
        add_member(ch, x)
    service(ch, c.uid, 'create', type=typ)
    return {'chat': chat_view(ch, c.uid)}


def guard(c: Ctx, need_admin=False):
    ch = C(c.params['id'])
    if not ch or not is_member(ch, c.uid):
        err(404, 'not_found')
    if need_admin and not (ch['type'] in ('group', 'channel') and is_admin(ch, c.uid)):
        err(403, 'forbidden')
    return ch


def update_chat(ch):
    broadcast_chat(ch, lambda uid: emit_to(uid, 'chat:update', {'chat': chat_view(ch, uid)}))


@route('PATCH', '/api/chats/{id}')
def patch_chat(c: Ctx):
    ch = guard(c, True)
    b = c.body
    if 'title' in b:
        t = clamp(b['title'], 64).strip()
        if t and t != ch['title']:
            ch['title'] = t
            service(ch, c.uid, 'title', title=t)
    if 'about' in b:
        ch['about'] = clamp(b['about'], 255)
    if 'avatar' in b:
        ch['avatar'] = b['avatar'] if MEDIA_RE.fullmatch(b.get('avatar') or '') else ''
        service(ch, c.uid, 'avatar')
    if 'username' in b:
        nu = str(b['username'] or '')
        nu = nu[1:] if nu.startswith('@') else nu
        if nu:
            if not USERNAME_RE.match(nu):
                err(400, 'bad_username')
            if not username_free(nu, {'t': 'chat', 'id': ch['id']}):
                err(409, 'username_taken')
        if ch.get('username'):
            db['usernames'].pop(ch['username'].lower(), None)
        ch['username'] = nu
        if nu:
            db['usernames'][nu.lower()] = {'t': 'chat', 'id': ch['id']}
    save()
    update_chat(ch)
    return {'chat': chat_view(ch, c.uid)}


@route('GET', '/api/chats/{id}/members')
def get_members(c: Ctx):
    ch = guard(c)
    ms = members_list(ch)
    return {'members': ms, 'users': pubs([m['id'] for m in ms], c.uid)}


@route('POST', '/api/chats/{id}/members')
def add_members(c: Ctx):
    ch = guard(c)
    if ch['type'] in ('private', 'saved'):
        err(400, 'bad')
    if ch['type'] == 'channel' and not is_admin(ch, c.uid):
        err(403, 'forbidden')
    added = []
    for i in [toint(x, -1) for x in (c.body.get('userIds') or [])]:
        u = U(i)
        if not u or u.get('deleted') or is_member(ch, i):
            continue
        inv = (u.get('privacy') or {}).get('invites')
        if (inv == 'contacts' and c.uid not in (u.get('contacts') or [])) or inv == 'nobody':
            continue
        m = ch['members'].get(str(i))
        if m:
            m['left'] = False
            m['read'] = ch['lastId']
        else:
            add_member(ch, i)
        added.append(i)
    for i in added:
        service(ch, c.uid, 'add', user=i)
    update_chat(ch)
    for i in added:
        emit_to(i, 'chat:update', {'chat': chat_view(ch, i), 'users': pubs([ch.get('createdBy')], i)})
    return {'added': added}


@route('DELETE', '/api/chats/{id}/members/{uid}')
def remove_member(c: Ctx):
    ch = guard(c)
    target = toint(c.params['uid'], -1)
    tm = mem(ch, target)
    if target != c.uid and not (is_admin(ch, c.uid) and (tm or {}).get('role') != 'owner'):
        err(403, 'forbidden')
    if not is_member(ch, target):
        err(404, 'not_found')
    if tm['role'] == 'owner':
        nxt = next((m for i, m in ch['members'].items() if int(i) != target and not m.get('left')), None)
        if nxt:
            nxt['role'] = 'owner'
    service(ch, c.uid, 'leave' if target == c.uid else 'remove', user=target)
    tm['left'], tm['role'] = True, 'member'
    emit_to(target, 'chat:left', {'chatId': ch['id']})
    update_chat(ch)
    return {'ok': True}


@route('POST', '/api/chats/{id}/admins')
def set_admin(c: Ctx):
    ch = guard(c)
    if mem(ch, c.uid)['role'] != 'owner':
        err(403, 'forbidden')
    t = mem(ch, toint(c.body.get('userId'), -1))
    if not t or t.get('left') or t['role'] == 'owner':
        err(400, 'bad')
    t['role'] = 'admin' if c.body.get('admin') else 'member'
    save()
    update_chat(ch)
    return {'ok': True}


@route('POST', '/api/chats/{id}/invite/reset')
def invite_reset(c: Ctx):
    ch = guard(c, True)
    ch['invite'] = rid(8)
    save()
    update_chat(ch)
    return {'invite': ch['invite']}


def _chat_by_invite(code):
    return next((x for x in db['chats'].values() if x.get('invite') and x['invite'] == code), None)


@route('GET', '/api/join/{code}')
def join_info(c: Ctx):
    ch = _chat_by_invite(c.params['code'])
    if not ch:
        err(404, 'not_found')
    return {'chat': {'id': ch['id'], 'type': ch['type'], 'title': ch['title'], 'avatar': ch.get('avatar'), 'about': ch.get('about'),
                     'count': sum(1 for m in ch['members'].values() if not m.get('left')), 'joined': is_member(ch, c.uid), 'verified': bool(ch.get('verified'))}}


def join_chat(ch, uid):
    if is_member(ch, uid):
        return
    m = ch['members'].get(str(uid))
    if m:
        m['left'] = False
        m['read'] = ch['lastId']
    else:
        add_member(ch, uid)
    service(ch, uid, 'join')
    update_chat(ch)


@route('POST', '/api/join/{code}')
def join_post(c: Ctx):
    code = c.params['code']
    ch = _chat_by_invite(code) or next((x for x in db['chats'].values() if x['id'] == code and x.get('username')), None)
    if not ch:
        err(404, 'not_found')
    join_chat(ch, c.uid)
    return {'chat': chat_view(ch, c.uid)}


@route('POST', '/api/chats/{id}/join')
def join_public(c: Ctx):
    ch = C(c.params['id'])
    if not ch or not ch.get('username'):
        err(404, 'not_found')
    join_chat(ch, c.uid)
    return {'chat': chat_view(ch, c.uid)}


@route('DELETE', '/api/chats/{id}')
def delete_chat(c: Ctx):
    ch = guard(c)
    uid, q = c.uid, c.query
    m = mem(ch, uid)
    if ch['type'] in ('private', 'saved'):
        if q.get('both') == '1' and ch['type'] == 'private':
            db['messages'][ch['id']] = []
            ch['pins'] = []

            def f(u):
                mem(ch, u)['cleared'] = ch['lastId']
                mem(ch, u)['hidden'] = True
                emit_to(u, 'chat:cleared', {'chatId': ch['id'], 'hide': True})
            broadcast_chat(ch, f)
        else:
            m['cleared'] = ch['lastId']
            if q.get('clear') != '1':
                m['hidden'] = True
            emit_to(uid, 'chat:cleared', {'chatId': ch['id'], 'hide': q.get('clear') != '1'})
    elif q.get('destroy') == '1' and m['role'] == 'owner':
        broadcast_chat(ch, lambda u: emit_to(u, 'chat:left', {'chatId': ch['id']}))
        if ch.get('username'):
            db['usernames'].pop(ch['username'].lower(), None)
        for x in chat_msgs(ch['id']):
            msg_index.pop(x['id'], None)
        db['messages'].pop(ch['id'], None)
        db['chats'].pop(ch['id'], None)
        for s in user_chats.values():
            s.discard(ch['id'])
    else:
        if q.get('clear') == '1':
            m['cleared'] = ch['lastId']
            emit_to(uid, 'chat:cleared', {'chatId': ch['id']})
        else:
            if m['role'] == 'owner':
                nxt = next((mm for i, mm in ch['members'].items() if int(i) != uid and not mm.get('left')), None)
                if nxt:
                    nxt['role'] = 'owner'
            service(ch, uid, 'leave', user=uid)
            m['left'], m['role'] = True, 'member'
            emit_to(uid, 'chat:left', {'chatId': ch['id']})
            update_chat(ch)
    save()
    return {'ok': True}


@route('PATCH', '/api/chats/{id}/me')
def patch_chat_me(c: Ctx):
    ch = guard(c)
    m, b = mem(ch, c.uid), c.body
    if 'pinned' in b:
        m['pinned'] = now() if b['pinned'] else 0
    if 'muted' in b:
        mu = b['muted']
        m['muted'] = (mu if isinstance(mu, (int, float)) and not isinstance(mu, bool) else True) if mu else False
    if 'archived' in b:
        m['archived'] = bool(b['archived'])
    save()
    emit_to(c.uid, 'chat:update', {'chat': chat_view(ch, c.uid)})
    return {'chat': chat_view(ch, c.uid)}


@route('POST', '/api/chats/{id}/read')
def mark_read(c: Ctx):
    ch = guard(c)
    m = mem(ch, c.uid)
    up = min(toint(c.body.get('upTo')) or ch['lastId'], ch['lastId'])
    if up > m.get('read', 0):
        m['read'] = up
        save()
        broadcast_chat(ch, lambda u: emit_to(u, 'chat:read', {'chatId': ch['id'], 'userId': c.uid, 'upTo': up,
                                                              **({'unread': chat_view(ch, u)['unread']} if u == c.uid else {})}))
    return {'ok': True}


@route('POST', '/api/chats/{id}/unread')
def mark_unread(c: Ctx):
    ch = guard(c)
    m = mem(ch, c.uid)
    msgs = [x for x in visible_msgs(ch, c.uid) if x['from'] != c.uid]
    if msgs:
        m['read'] = min(m.get('read', 0), msgs[-1]['id'] - 1)
    save()
    emit_to(c.uid, 'chat:update', {'chat': chat_view(ch, c.uid)})
    return {'ok': True}


@route('POST', '/api/chats/{id}/pin')
def pin_msg(c: Ctx):
    ch = guard(c)
    if ch['type'] in ('group', 'channel') and not is_admin(ch, c.uid):
        err(403, 'forbidden')
    mid = toint(c.body.get('msgId'), -1)
    ch.setdefault('pins', [])
    if c.body.get('unpin'):
        ch['pins'] = [] if c.body.get('all') else [x for x in ch['pins'] if x != mid]
    elif mid not in ch['pins'] and msg_index.get(mid) == ch['id']:
        ch['pins'].append(mid)
        service(ch, c.uid, 'pin', msg=mid)
    save()
    update_chat(ch)
    return {'pins': ch['pins']}


# ───────────────────────── messages ─────────────────────────
def load_page(ch, uid, q):
    allm = visible_msgs(ch, uid)
    lim = min(toint(q.get('limit')) or 40, 100)
    if q.get('around'):
        a = toint(q['around'])
        i = next((k for k, m in enumerate(allm) if m['id'] >= a), -1)
        cc = len(allm) - 1 if i < 0 else i
        sl = allm[max(0, cc - lim // 2): cc + (lim + 1) // 2]
    elif q.get('after'):
        a = toint(q['after'])
        sl = [m for m in allm if m['id'] > a][:lim]
    elif q.get('before'):
        b = toint(q['before'])
        sl = [m for m in allm if m['id'] < b][-lim:]
    else:
        sl = allm[-lim:]
    first = sl[0]['id'] if sl else None
    last = sl[-1]['id'] if sl else None
    sm = [ser(m, uid, ch) for m in sl]
    uids = []
    for m in sm:
        uids += [m['from'], (m.get('fwd') or {}).get('from'), (m.get('reply') or {}).get('from')]
    return {'messages': sm, 'hasMoreBefore': bool(sl) and allm[0]['id'] < first, 'hasMoreAfter': bool(sl) and allm[-1]['id'] > last,
            'users': pubs([x for x in uids if x], uid)}


@route('GET', '/api/chats/{id}/messages')
def get_messages(c: Ctx):
    ch = guard(c)
    q = str(c.query.get('q', '')).strip().lower()
    if q:
        ms = [m for m in visible_msgs(ch, c.uid) if m.get('text') and m['type'] != 'service' and q in m['text'].lower()]
        ms.reverse()
        return {'messages': [ser(m, c.uid, ch) for m in ms[:200]]}
    return load_page(ch, c.uid, c.query)


URL_RE = re.compile(r'https?://\S+')


@route('GET', '/api/chats/{id}/shared')
def shared(c: Ctx):
    ch = guard(c)
    t = c.query.get('type')

    def ok(m):
        if t == 'media': return m['type'] in ('photo', 'video')
        if t == 'files': return m['type'] == 'file'
        if t == 'voice': return m['type'] in ('voice', 'circle')
        if t == 'links': return bool(m.get('text') and URL_RE.search(m['text']))
        return False
    ms = [m for m in visible_msgs(ch, c.uid) if ok(m)]
    ms.reverse()
    return {'messages': [ser(m, c.uid, ch) for m in ms[:300]]}


def validate_send(ch, b):
    typ = b.get('type') if b.get('type') in ('text', 'photo', 'video', 'file', 'voice', 'circle', 'sticker', 'location', 'poll') else 'text'
    d = {'type': typ, 'text': clamp(b.get('text'), 4096), 'silent': bool(b.get('silent'))}
    if typ in ('photo', 'video', 'file', 'voice', 'circle'):
        md = b.get('media')
        if not isinstance(md, dict) or not MEDIA_RE.fullmatch(md.get('url') or ''):
            return {'error': 'bad_media'}
        d['media'] = {'url': md['url'], 'name': clamp(md.get('name'), 120), 'size': num(md.get('size')), 'mime': clamp(md.get('mime'), 80),
                      'duration': num(md.get('duration')), 'w': num(md.get('w')), 'h': num(md.get('h'))}
        if isinstance(md.get('waveform'), list):
            d['media']['waveform'] = [max(0, min(31, toint(x))) for x in md['waveform'][:64]]
    elif typ == 'text' and not d['text'].strip():
        return {'error': 'empty'}
    elif typ == 'sticker':
        d['sticker'] = clamp(b.get('sticker'), 16)
    elif typ == 'location':
        loc = b.get('loc') or {}
        try:
            la, lo = float(loc.get('lat')), float(loc.get('lng'))
        except (TypeError, ValueError):
            return {'error': 'bad_loc'}
        d['loc'] = {'lat': la, 'lng': lo}
    elif typ == 'poll':
        p = b.get('poll') or {}
        opts = [clamp(x, 100).strip() for x in (p.get('options') or [])]
        opts = [x for x in opts if x][:10]
        if not p.get('q') or len(opts) < 2:
            return {'error': 'bad_poll'}
        quiz = bool(p.get('quiz'))
        d['poll'] = {'q': clamp(p['q'], 255), 'multiple': bool(p.get('multiple')) and not quiz, 'anon': p.get('anon') is not False, 'quiz': quiz,
                     'explanation': clamp(p.get('explanation'), 200), 'options': [{'t': t, 'voters': []} for t in opts]}
        if quiz:
            d['poll']['correct'] = max(0, min(len(opts) - 1, toint(p.get('correct'))))
    if b.get('replyTo') and msg_index.get(toint(b['replyTo'], -1)) == ch['id']:
        d['replyTo'] = toint(b['replyTo'])
    if b.get('fwd'):
        d['fwd'] = b['fwd']
    return {'d': d}


@route('POST', '/api/chats/{id}/messages')
def send_message(c: Ctx):
    ch = guard(c)
    if ch['type'] == 'channel' and not is_admin(ch, c.uid):
        err(403, 'forbidden')
    if ch['type'] == 'private':
        other = U(next(int(i) for i in ch['members'] if int(i) != c.uid))
        if c.uid in (other.get('blocked') or []):
            err(403, 'blocked')
        if other.get('deleted'):
            err(403, 'deleted')
    r = validate_send(ch, c.body)
    if r.get('error'):
        err(400, r['error'])
    sched = toint(c.body.get('scheduleAt'))
    if sched and sched > now() + 5000:
        db['c']['sched'] += 1
        s = {'id': db['c']['sched'], 'chatId': ch['id'], 'from': c.uid, 'data': r['d'], 'at': sched}
        db['scheduled'].append(s)
        save()
        return {'scheduled': {'id': s['id'], 'at': s['at'], 'data': s['data']}}
    m = push_message(ch, c.uid, r['d'])
    return {'message': ser(m, c.uid, ch)}


@route('GET', '/api/chats/{id}/scheduled')
def get_scheduled(c: Ctx):
    ch = guard(c)
    return {'items': [{'id': s['id'], 'at': s['at'], 'data': s['data']} for s in db['scheduled'] if s['chatId'] == ch['id'] and s['from'] == c.uid]}


@route('DELETE', '/api/scheduled/{id}')
def del_scheduled(c: Ctx):
    sid = c.pid()
    i = next((k for k, s in enumerate(db['scheduled']) if s['id'] == sid and s['from'] == c.uid), -1)
    if i >= 0:
        s = db['scheduled'].pop(i)
        if c.query.get('send') == '1':
            ch = C(s['chatId'])
            if ch:
                push_message(ch, c.uid, s['data'])
        save()
    return {'ok': True}


def find_msg(c: Ctx):
    mid = c.pid()
    cid = msg_index.get(mid)
    ch = C(cid) if cid else None
    if not ch or not is_member(ch, c.uid):
        err(404, 'not_found')
    m = next((x for x in chat_msgs(cid) if x['id'] == mid), None)
    if not m:
        err(404, 'not_found')
    return m, ch


@route('PATCH', '/api/messages/{id}')
def edit_message(c: Ctx):
    m, ch = find_msg(c)
    if m['from'] != c.uid or m['type'] in ('service', 'call', 'poll', 'sticker', 'location'):
        err(403, 'forbidden')
    t = clamp(c.body.get('text'), 4096)
    if not t.strip() and m['type'] == 'text':
        err(400, 'empty')
    m['text'], m['edited'] = t, now()
    save()
    broadcast_chat(ch, lambda u: emit_to(u, 'msg:edit', {'message': ser(m, u, ch)}))
    return {'message': ser(m, c.uid, ch)}


@route('POST', '/api/messages/delete')
def delete_messages(c: Ctx):
    ch = C(c.body.get('chatId'))
    if not ch or not is_member(ch, c.uid):
        err(404, 'not_found')
    ids = [toint(x, -1) for x in (c.body.get('ids') or [])]
    arr = chat_msgs(ch['id'])
    removed = []
    for i in ids:
        m = next((x for x in arr if x['id'] == i), None)
        if not m:
            continue
        if c.body.get('forAll'):
            can = ch['type'] == 'private' or m['from'] == c.uid or (ch['type'] in ('group', 'channel') and is_admin(ch, c.uid))
            if not can:
                continue
            arr.remove(m)
            msg_index.pop(i, None)
            removed.append(i)
        else:
            df = m.setdefault('deletedFor', [])
            if c.uid not in df:
                df.append(c.uid)
    if c.body.get('forAll'):
        ch['pins'] = [p for p in (ch.get('pins') or []) if p not in removed]
        broadcast_chat(ch, lambda u: emit_to(u, 'msg:delete', {'chatId': ch['id'], 'ids': removed, 'chat': chat_view(ch, u)}))
    else:
        emit_to(c.uid, 'msg:delete', {'chatId': ch['id'], 'ids': ids, 'chat': chat_view(ch, c.uid)})
    save()
    return {'ok': True}


@route('POST', '/api/messages/forward')
def forward(c: Ctx):
    src = C(c.body.get('fromChat'))
    if not src or not is_member(src, c.uid):
        err(404, 'not_found')
    ids = [toint(x, -1) for x in (c.body.get('ids') or [])]
    out = []
    for to in (c.body.get('toChats') or [])[:10]:
        dst = C(to)
        if not dst or not is_member(dst, c.uid):
            continue
        if dst['type'] == 'channel' and not is_admin(dst, c.uid):
            continue
        if dst['type'] == 'private':
            o = U(next(int(i) for i in dst['members'] if int(i) != c.uid))
            if c.uid in (o.get('blocked') or []):
                continue
        for i in ids:
            m = next((x for x in chat_msgs(src['id']) if x['id'] == i), None)
            if not m or m['type'] in ('service', 'call'):
                continue
            d = {'type': m['type'], 'text': m.get('text'), 'media': m.get('media'), 'sticker': m.get('sticker'), 'loc': m.get('loc')}
            if m.get('poll'):
                d['poll'] = {**m['poll'], 'options': [{'t': o['t'], 'voters': []} for o in m['poll']['options']], 'closed': False}
            if not c.body.get('hideName'):
                fw = m.get('fwd')
                if not fw:
                    fw = {'from': m['from']}
                    if src['type'] == 'channel':
                        fw['chat'] = src['title']
                d['fwd'] = fw
            out.append(push_message(dst, c.uid, d)['id'])
    return {'ok': True, 'count': len(out)}


@route('POST', '/api/messages/{id}/react')
def react(c: Ctx):
    m, ch = find_msg(c)
    emoji = clamp(c.body['emoji'], 8) if c.body.get('emoji') else None
    rx = m.setdefault('reactions', {})
    had = bool(emoji and c.uid in rx.get(emoji, []))
    for k in list(rx.keys()):
        rx[k] = [x for x in rx[k] if x != c.uid]
        if not rx[k]:
            del rx[k]
    if emoji and not had:
        rx.setdefault(emoji, []).append(c.uid)
    save()
    broadcast_chat(ch, lambda u: emit_to(u, 'msg:react', {'chatId': ch['id'], 'id': m['id'], 'reactions': rx, 'by': c.uid, 'emoji': emoji if emoji and not had else None}))
    return {'reactions': rx}


@route('POST', '/api/messages/{id}/vote')
def vote(c: Ctx):
    m, ch = find_msg(c)
    if not m.get('poll'):
        err(404, 'not_found')
    p = m['poll']
    if p.get('closed'):
        err(400, 'closed')
    sel = [i for i in dict.fromkeys(toint(x, -1) for x in (c.body.get('options') or [])) if 0 <= i < len(p['options'])]
    if not p.get('multiple'):
        sel = sel[:1]
    if p.get('quiz') and any(c.uid in o['voters'] for o in p['options']):
        err(400, 'voted')
    for i, o in enumerate(p['options']):
        o['voters'] = [x for x in o['voters'] if x != c.uid]
        if i in sel:
            o['voters'].append(c.uid)
    save()
    broadcast_chat(ch, lambda u: emit_to(u, 'msg:edit', {'message': ser(m, u, ch)}))
    return {'message': ser(m, c.uid, ch)}


@route('POST', '/api/messages/{id}/poll/close')
def poll_close(c: Ctx):
    m, ch = find_msg(c)
    if not m.get('poll') or m['from'] != c.uid:
        err(403, 'forbidden')
    m['poll']['closed'] = True
    save()
    broadcast_chat(ch, lambda u: emit_to(u, 'msg:edit', {'message': ser(m, u, ch)}))
    return {'ok': True}


@route('GET', '/api/health', auth=False)
def health(c: Ctx):
    return {'ok': True, 'name': APP_NAME, 'runtime': 'python'}


@route('GET', '/api/ice')
def ice(c: Ctx):
    servers = [{'urls': ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478']}]
    if os.environ.get('TURN_URL'):
        servers.append({'urls': os.environ['TURN_URL'].split(','), 'username': os.environ.get('TURN_USER', ''), 'credential': os.environ.get('TURN_PASS', '')})
    return {'iceServers': servers}


# ───────────────────────── media ─────────────────────────
SAFE_INLINE = re.compile(r'^(image/(png|jpe?g|gif|webp|avif|bmp)|video/(mp4|webm|quicktime|ogg|x-matroska)|audio/(webm|ogg|mpeg|mp4|wav|x-m4a|aac|opus|flac|x-wav|mp3)|application/pdf)', re.I)


@route('POST', '/api/upload')
async def upload(c: Ctx):
    body = await c.request.read()
    if not body:
        err(400, 'empty')
    if limited(f'up:{c.uid}', 120, 60e3):
        err(429, 'too_many')
    mid = rid(12)
    mime = clamp((c.request.headers.get('Content-Type') or 'application/octet-stream').split(';')[0], 80)
    name = clamp(c.query.get('name') or 'file', 120)
    if pool:
        async with pool.acquire() as con:
            await con.execute('insert into media(id,mime,name,size,data) values($1,$2,$3,$4,$5)', mid, mime, name, len(body), body)
    else:
        (UPLOAD_DIR / mid).write_bytes(body)
        (UPLOAD_DIR / (mid + '.json')).write_text(json.dumps({'mime': mime, 'name': name, 'size': len(body)}), 'utf8')
    return {'url': '/media/' + mid, 'name': name, 'size': len(body), 'mime': mime}


async def media_get(request: web.Request):
    mid = request.match_info['id']
    if not ID_RE.fullmatch(mid):
        raise web.HTTPNotFound()
    if pool:
        async with pool.acquire() as con:
            row = await con.fetchrow('select mime,name,size,data from media where id=$1', mid)
        if not row:
            raise web.HTTPNotFound()
        meta, buf = dict(row), bytes(row['data'])
    else:
        f = UPLOAD_DIR / mid
        if not f.exists():
            raise web.HTTPNotFound()
        meta = json.loads((UPLOAD_DIR / (mid + '.json')).read_text('utf8'))
        buf = await asyncio.to_thread(f.read_bytes)
    size = len(buf)
    inline = bool(SAFE_INLINE.match(meta['mime'] or ''))
    headers = {'Content-Type': meta['mime'] if inline else 'application/octet-stream',
               'Content-Disposition': f"{'inline' if inline and request.query.get('dl') != '1' else 'attachment'}; filename*=UTF-8''{quote(meta['name'])}",
               'Cache-Control': 'public,max-age=31536000,immutable', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff'}
    start, end, status = 0, size - 1, 200
    rg = re.match(r'bytes=(\d*)-(\d*)', request.headers.get('Range', ''))
    if rg:
        if rg.group(1): start = int(rg.group(1))
        if rg.group(2): end = min(int(rg.group(2)), size - 1)
        if not rg.group(1) and rg.group(2):
            start, end = max(0, size - int(rg.group(2))), size - 1
        if start > end or start >= size:
            return web.Response(status=416, headers={'Content-Range': f'bytes */{size}'})
        status = 206
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return web.Response(status=status, body=buf[start:end + 1], headers=headers)


# ───────────────────────── static site ─────────────────────────
async def static_get(request: web.Request):
    rel = request.match_info.get('tail', '') or 'index.html'
    f = (PUBLIC / rel).resolve()
    try:
        f.relative_to(PUBLIC.resolve())
    except ValueError:
        raise web.HTTPNotFound()
    if f.is_dir():
        f = f / 'index.html'
    if not f.is_file():
        if rel.startswith(('api/', 'media/', 'socket.io')) or '.' in Path(rel).name:
            raise web.HTTPNotFound()
        f = PUBLIC / 'index.html'   # SPA-fallback
    cache = 'public,max-age=86400' if ('vendor' in f.parts or f.name == 'icons.js') else 'no-cache'
    return web.FileResponse(f, headers={'Cache-Control': cache})


@web.middleware
async def security(request, handler):
    try:
        resp = await handler(request)
    except web.HTTPException as e:
        resp = e
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    return resp


# ───────────────────────── sockets ─────────────────────────
socks: dict = {}   # sid -> {'uid','sess'}
qr_ttl = 70e3


def presence_broadcast(uid):
    peers = set()
    for cid in list(user_chats.get(uid, ())):
        ch = C(cid)
        if ch and ch['type'] == 'private':
            for i in ch['members']:
                if int(i) != uid:
                    peers.add(int(i))
    u = U(uid)
    if not u:
        return
    for p in peers:
        emit_to(p, 'presence', {'user': pub(u, p)})


calls: dict = {}       # callId -> call
user_call: dict = {}   # uid -> callId


def end_call(call, status, by_uid=None):
    if call['id'] not in calls:
        return
    calls.pop(call['id'], None)
    user_call.pop(call['from'], None)
    user_call.pop(call['to'], None)
    if call.get('timer'):
        call['timer'].cancel()
    duration = round((now() - call['answered']) / 1000) if call['answered'] else 0
    ch = private_chat(call['from'], call['to'])
    st = 'ended' if call['answered'] else status
    push_message(ch, call['from'], {'type': 'call', 'call': {'status': st, 'duration': duration, 'video': call['video']}})
    for u in (call['from'], call['to']):
        emit_to(u, 'call:ended', {'callId': call['id'], 'reason': st, 'by': by_uid})


@sio.event
async def connect(sid, environ, auth=None):
    tok = auth.get('token') if isinstance(auth, dict) else None
    s = db['sessions'].get(tok) if tok else None
    ua = environ.get('HTTP_USER_AGENT', '')
    xf = environ.get('HTTP_X_FORWARDED_FOR')
    ip = xf.split(',')[0].strip() if xf else (environ.get('REMOTE_ADDR') or '')
    st = {'uid': None, 'sess': None, 'ua': ua, 'ip': ip}
    socks[sid] = st
    if s and str(s['userId']) in db['users'] and not db['users'][str(s['userId'])].get('banned'):
        uid = s['userId']
        st['uid'], st['sess'] = uid, s
        await sio.enter_room(sid, f'u:{uid}')
        await sio.enter_room(sid, f"s:{s['sid']}")
        sess_online[s['sid']] = sess_online.get(s['sid'], 0) + 1
        was_off = not online.get(uid)
        online.setdefault(uid, set()).add(sid)
        if was_off:
            presence_broadcast(uid)


@sio.event
async def disconnect(sid, *a):
    st = socks.pop(sid, None)
    if not st or not st['uid']:
        return
    uid = st['uid']
    ssid = st['sess']['sid']
    sess_online[ssid] = max(0, sess_online.get(ssid, 1) - 1)
    s = online.get(uid)
    if s:
        s.discard(sid)
        if not s:
            online.pop(uid, None)
            u = U(uid)
            if u:
                u['lastSeen'] = now()
                save()
            presence_broadcast(uid)
            cid = user_call.get(uid)
            cl = calls.get(cid) if cid else None
            if cl:
                end_call(cl, 'ended' if cl['answered'] else 'missed', uid)


@sio.on('qr:create')
async def qr_create(sid, *args):
    st = socks.get(sid) or {}
    token = rid(20)
    d = parse_ua(st.get('ua', ''))
    qr_tokens[token] = {'sid': sid, 'exp': now() + qr_ttl, 'ua': st.get('ua', ''), 'device': f"{d['browser']}, {d['os']}", 'ip': st.get('ip', ''), 'state': 'new'}
    return {'token': token, 'ttl': 60}


@sio.on('typing')
async def on_typing(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return
    uid = st['uid']
    ch = C(data.get('chatId'))
    if not ch or not is_member(ch, uid):
        return
    act = data.get('action') if data.get('action') in ('typing', 'voice', 'video', 'upload') else 'typing'
    broadcast_chat(ch, lambda u: emit_to(u, 'typing', {'chatId': ch['id'], 'userId': uid, 'action': act}) if u != uid else None)


@sio.on('call:invite')
async def call_invite(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return {'error': 'unavailable'}
    uid = st['uid']
    to = toint(data.get('to'), -1)
    target = U(to)
    if not target or to == uid or target.get('bot') or target.get('deleted'):
        return {'error': 'unavailable'}
    if uid in (target.get('blocked') or []):
        return {'error': 'blocked'}
    pc = (target.get('privacy') or {}).get('calls') or 'everyone'
    if pc == 'nobody' or (pc == 'contacts' and uid not in (target.get('contacts') or [])):
        return {'error': 'privacy'}
    if uid in user_call or to in user_call:
        return {'error': 'already' if uid in user_call else 'busy'}
    call = {'id': str(data.get('callId') or rid(8))[:40], 'from': uid, 'to': to, 'video': bool(data.get('video')), 'started': now(), 'answered': 0, 'timer': None}
    if not is_online(to):
        calls[call['id']] = call
        end_call(call, 'missed', uid)
        return {'error': 'offline'}
    calls[call['id']] = call
    user_call[uid] = user_call[to] = call['id']
    call['timer'] = asyncio.get_event_loop().call_later(45, end_call, call, 'missed')
    emit_to(to, 'call:incoming', {'callId': call['id'], 'from': pub(U(uid), to), 'video': call['video']})
    return {'ok': True, 'callId': call['id']}


@sio.on('call:accept')
async def call_accept(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return
    uid = st['uid']
    c = calls.get(data.get('callId'))
    if not c or c['to'] != uid or c['answered']:
        return
    c['answered'] = now()
    if c.get('timer'):
        c['timer'].cancel()
    emit_room(f'u:{uid}', 'call:ended', {'callId': c['id'], 'reason': 'handled'}, skip=sid)
    emit_to(c['from'], 'call:accepted', {'callId': c['id']})


@sio.on('call:decline')
async def call_decline(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return
    uid = st['uid']
    c = calls.get(data.get('callId'))
    if c and uid in (c['to'], c['from']):
        end_call(c, 'declined' if c['to'] == uid else 'missed', uid)


@sio.on('call:end')
async def call_end(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return
    uid = st['uid']
    c = calls.get(data.get('callId'))
    if c and uid in (c['to'], c['from']):
        end_call(c, 'missed' if c['from'] == uid else 'declined', uid)


@sio.on('call:signal')
async def call_signal(sid, data=None):
    st = socks.get(sid)
    if not st or not st['uid'] or not isinstance(data, dict):
        return
    uid = st['uid']
    c = calls.get(data.get('callId'))
    if not c or uid not in (c['to'], c['from']):
        return
    emit_to(c['to'] if c['from'] == uid else c['from'], 'call:signal', {'callId': c['id'], 'data': data.get('data')})


# ═════════════════════════════════════════════════════════════════════════════
#  СИСТЕМНЫЕ БОТЫ · BotFather · Bot API · GeoAI · модерация · консоль · экспорт
# ═════════════════════════════════════════════════════════════════════════════
import csv
import io
import ipaddress
import socket
import tempfile
import zipfile
from urllib.parse import urlparse

GEOAI_ID = 0
BOTFATHER_ID = 0
SYSTEM_BOTS: set = {1}
bot_tokens: dict = {}          # token -> bot uid
OWNER_EMAILS = {e.strip().lower() for e in (os.environ.get('OWNER_EMAILS') or '').split(',') if e.strip()}
STARTED = time.time()


def _cmds(*pairs):
    return [{'cmd': c, 'desc': d, 'reply': ''} for c, d in pairs]


def seed_system():
    """создаёт GeoAI и BotFather (id выбираются из счётчика, чтобы не конфликтовать с существующими пользователями)"""
    global GEOAI_ID, BOTFATHER_ID
    sysd = db.setdefault('sys', {})
    specs = {
        'geoai': ('GeoAI', 'geoai', 'ИИ-помощник GeoMetric: ответит на вопросы, придумает идеи, переведёт и напишет текст.', '/img/geoai.svg', 4, 'Задайте любой вопрос — я отвечу.',
                  _cmds(('start', 'Приветствие'), ('clear', 'Забыть историю диалога'), ('help', 'Что я умею'))),
        'botfather': ('BotFather', 'botfather', 'Создавайте и настраивайте собственных ботов GeoMetric.', '/img/botfather.svg', 6, 'Я помогу создать бота. Напишите /newbot.',
                      _cmds(('newbot', 'Создать нового бота'), ('mybots', 'Мои боты и их настройки'), ('setname', 'Сменить имя'), ('setdescription', 'Описание бота'),
                            ('setabouttext', 'Текст «О боте»'), ('setcommands', 'Список команд'), ('setuserpic', 'Аватарка бота'), ('setwebhook', 'Webhook'),
                            ('token', 'Показать токен'), ('revoke', 'Перевыпустить токен'), ('deletebot', 'Удалить бота'), ('cancel', 'Отменить действие'))),
    }
    for key, (name, uname, bio, av, color, desc, cmds) in specs.items():
        uid = sysd.get(key)
        if not uid or str(uid) not in db['users']:
            db['c']['user'] += 1
            uid = db['c']['user']
            un = uname if uname not in db['usernames'] else uname + '_bot'
            db['users'][str(uid)] = {'id': uid, 'email': f'{key}@geometric.local', 'name': name, 'lastName': '', 'username': un, 'bio': bio, 'avatar': av, 'color': color,
                                     'emoji': '', 'verified': True, 'bot': True, 'system': True, 'createdAt': now(), 'lastSeen': now(), 'privacy': {}, 'settings': {},
                                     'contacts': [], 'blocked': [], 'botDesc': desc, 'botCfg': {'commands': cmds}}
            db['usernames'][un] = {'t': 'user', 'id': uid}
            sysd[key] = uid
        else:
            u = db['users'][str(uid)]
            u.update(avatar=av, bio=bio, botDesc=desc, verified=True, bot=True, system=True)
            u.setdefault('botCfg', {})['commands'] = cmds
    GEOAI_ID, BOTFATHER_ID = sysd['geoai'], sysd['botfather']
    SYSTEM_BOTS.update({1, GEOAI_ID, BOTFATHER_ID})
    g = db['users']['1']
    g.update(avatar='/img/geometric.svg', verified=True, bot=True, system=True, botDesc='Официальный бот GeoMetric Beta.', emoji='')
    g.setdefault('botCfg', {})['commands'] = _cmds(('start', 'Начать'), ('help', 'Справка'), ('ping', 'Проверка связи'), ('time', 'Время'), ('dice', 'Бросить кубик'))
    apply_owner_emails()
    bot_tokens.clear()
    for u in db['users'].values():
        t = (u.get('botCfg') or {}).get('token')
        if u.get('bot') and t and not u.get('deleted'):
            bot_tokens[t] = u['id']


def apply_owner_emails():
    for u in db['users'].values():
        if (u.get('email') or '').lower() in OWNER_EMAILS and not u.get('owner'):
            u['owner'] = True


def is_staff(u) -> bool:
    return bool(u) and not u.get('banned') and bool(u.get('geo') or u.get('owner'))


def is_owner(u) -> bool:
    return bool(u) and not u.get('banned') and bool(u.get('owner'))


def ensure_geoai_chat(uid: int):
    cid = f'p:{min(uid, GEOAI_ID)}:{max(uid, GEOAI_ID)}'
    if cid in db['chats'] or uid in SYSTEM_BOTS:
        return
    ch = private_chat(GEOAI_ID, uid)
    push_message(ch, GEOAI_ID, {'text': AI_WELCOME, 'markup': AI_MARKUP})


# ───────────────────────── inline-клавиатуры и ответы ботов ─────────────────────────
def Bt(text, data=None, url=None):
    d = {'text': str(text)[:64]}
    if url:
        d['url'] = url
    else:
        d['data'] = str(data if data is not None else text)[:64]
    return d


def clean_markup(rm):
    """Telegram-формат {'inline_keyboard':[[{text,callback_data,url}]]} или внутренний список рядов → внутренний формат"""
    if isinstance(rm, str):
        try:
            rm = json.loads(rm)
        except Exception:
            return None
    rows = rm.get('inline_keyboard') if isinstance(rm, dict) else rm
    if not isinstance(rows, list):
        return None
    out = []
    for row in rows[:8]:
        if not isinstance(row, list):
            continue
        r = []
        for b in row[:8]:
            if not isinstance(b, dict) or not b.get('text'):
                continue
            url = b.get('url')
            if url:
                if not re.match(r'^https?://', str(url)):
                    continue
                r.append(Bt(b['text'], url=str(url)[:500]))
            else:
                d = b.get('callback_data', b.get('data'))
                if d is None:
                    continue
                r.append(Bt(b['text'], str(d)[:64]))
        if r:
            out.append(r)
    return out or None


def bot_send(bot_id, uid, text, markup=None, reply_to=None, silent=False, extra=None):
    ch = private_chat(bot_id, uid)
    d = {'type': 'text', 'text': clamp(text, 4096)}
    if markup:
        d['markup'] = markup
    if reply_to and msg_index.get(reply_to) == ch['id']:
        d['replyTo'] = reply_to
    if silent:
        d['silent'] = True
    if extra:
        d.update(extra)
    mem(ch, uid)['hidden'] = False
    return push_message(ch, bot_id, d)


def bot_reply(bot_id, uid, text, markup=None, delay=0.45, reply_to=None):
    """ответ бота с индикатором «печатает…»"""
    ch = private_chat(bot_id, uid)
    loop = asyncio.get_event_loop()
    emit_to(uid, 'typing', {'chatId': ch['id'], 'userId': bot_id, 'action': 'typing'})
    loop.call_later(delay, lambda: bot_send(bot_id, uid, text, markup, reply_to) if ch['id'] in db['chats'] else None)


def bot_edit(m, text=None, markup=False, mark=False):
    ch = C(m['chatId'])
    if text is not None:
        m['text'] = clamp(text, 4096)
    if markup is not False:
        if markup:
            m['markup'] = markup
        else:
            m.pop('markup', None)
    if mark:
        m['edited'] = now()
    save()
    broadcast_chat(ch, lambda u: emit_to(u, 'msg:edit', {'message': ser(m, u, ch)}))


def cb_answer(uid, text='', alert=False):
    emit_to(uid, 'cb:answer', {'text': text, 'alert': bool(alert)})


def peer_of(chat, uid):
    return next((int(i) for i in chat['members'] if int(i) != uid), None)


def bot_hook(chat, m):
    """вызывается на каждое новое сообщение: если собеседник — бот, он отвечает"""
    if chat['type'] != 'private' or m['type'] in ('service', 'call'):
        return
    sender = U(m['from'])
    if not sender or sender.get('bot'):
        return
    peer = peer_of(chat, m['from'])
    bot = U(peer)
    if not bot or not bot.get('bot') or bot.get('deleted'):
        return
    if peer == 1:
        geometric_bot(chat, m)
    elif peer == GEOAI_ID:
        geoai_bot(chat, m)
    elif peer == BOTFATHER_ID:
        botfather_msg(chat, m)
    else:
        custom_bot_msg(chat, m, bot)


# ───────────────────────── GeoMetric (id 1) + команды модерации [GEO] ─────────────────────────
HELP_TEXT = ('✨ **GeoMetric Beta** — функции:\n• личные чаты, группы, каналы, «Избранное»\n• голосовые и видео-кружки (удерживайте микрофон; нажмите на значок — смена режима)\n'
             '• звонки и видеозвонки, демонстрация экрана\n• реакции (двойной клик), ответы, пересылка, закрепы, опросы\n• QR-код и ссылка профиля\n'
             '• вход по QR: Настройки → Устройства → Подключить устройство\n• 🤖 @geoai — ИИ-помощник, @botfather — свои боты\n\nПопробуйте /ping, /time или /dice')
STAFF_CMDS = ('reports', 'ban', 'unban', 'kick', 'whois', 'resolve')


def geometric_bot(chat, m):
    uid = m['from']
    u = U(uid)
    t = (m.get('text') or '').strip()
    low = t.lower()
    first = low.split()[0].split('@')[0] if low.startswith('/') else ''
    if is_staff(u) and first[1:] in STAFF_CMDS:
        bot_reply(1, uid, exec_cmd(t, u, 'staff'))
        return
    if first in ('/start', '/help'):
        txt = HELP_TEXT
        if is_staff(u):
            txt += ('\n\n🛡 **Инструменты [GEO]**\n/reports — открытые жалобы\n/ban @user причина\n/unban @user\n/kick @user — завершить все сеансы\n/whois @user\n/resolve ID — закрыть жалобу')
        bot_reply(1, uid, txt)
    elif first == '/ping':
        bot_reply(1, uid, 'pong 🏓')
    elif first == '/time':
        try:
            from datetime import datetime
            from zoneinfo import ZoneInfo
            reply = '🕒 ' + datetime.now(ZoneInfo('Asia/Vladivostok')).strftime('%d.%m.%Y, %H:%M:%S')
        except Exception:
            reply = '🕒 ' + time.strftime('%d.%m.%Y, %H:%M:%S', time.gmtime()) + ' UTC'
        bot_reply(1, uid, reply)
    elif first == '/dice':
        bot_reply(1, uid, '🎲 Выпало: **' + str(1 + secrets.randbelow(6)) + '**')
    else:
        bot_reply(1, uid, 'Я простой бот 🤖 Напишите /help, чтобы узнать, что умеет GeoMetric.')


def geometric_cb(uid, m, data):
    u = U(uid)
    if not data.startswith('rep:'):
        return
    if not is_staff(u):
        return cb_answer(uid, 'Только для команды [GEO]', True)
    _, act, rid_ = data.split(':', 2)
    rep = next((r for r in db['reports'] if str(r['id']) == rid_), None)
    if not rep:
        return cb_answer(uid, 'Жалоба не найдена', True)
    if act == 'whois':
        bot_send(1, uid, whois_text(U(rep['tuid'])) if rep.get('tuid') else 'Цель недоступна')
        return cb_answer(uid, '')
    if rep['status'] != 'open':
        return cb_answer(uid, 'Уже обработано', True)
    t = U(rep.get('tuid'))
    try:
        if act == 'ban':
            out = do_ban(t, f"жалоба #{rep['id']}: {rep['reason']}", u)
        elif act == 'kick':
            out = do_kick(t)
        else:
            out = 'отклонена'
    except CmdError as e:
        return cb_answer(uid, str(e), True)
    resolve_report(rep, u, out)
    cb_answer(uid, '✅ ' + out)


# ───────────────────────── жалобы ─────────────────────────
@route('POST', '/api/reports')
def create_report(c: Ctx):
    b = c.body
    kind = b.get('kind')
    if limited(f'rep:{c.uid}', 10, 3600e3):
        err(429, 'too_many')
    reason = clamp(b.get('reason') or 'other', 40)
    text = clamp(b.get('text'), 500)
    rep = {'id': 0, 'from': c.uid, 'kind': kind, 'reason': reason, 'text': text, 'ts': now(), 'status': 'open', 'msgs': []}
    quote_ = ''
    if kind == 'user':
        t = U(toint(b.get('target'), -1))
        if not t or t['id'] == c.uid:
            err(400, 'bad')
        rep.update(tuid=t['id'], target=f"{fullname(t)} (@{t.get('username') or '—'}, id {t['id']})")
    elif kind == 'chat':
        ch = C(b.get('target'))
        if not ch or ch['type'] not in ('group', 'channel'):
            err(400, 'bad')
        rep.update(tuid=ch.get('createdBy'), tchat=ch['id'], target=f"{'канал' if ch['type'] == 'channel' else 'группа'} «{ch['title']}» (@{ch.get('username') or '—'})")
    elif kind == 'message':
        mid = toint(b.get('msgId'), -1)
        cid = msg_index.get(mid)
        ch = C(cid) if cid else None
        if not ch or not is_member(ch, c.uid):
            err(404, 'not_found')
        m = next((x for x in chat_msgs(cid) if x['id'] == mid), None)
        if not m or m['from'] == c.uid:
            err(400, 'bad')
        t = U(m['from'])
        rep.update(tuid=m['from'], tchat=cid, tmsg=mid, target=f"сообщение #{mid} от {fullname(t)} (@{(t or {}).get('username') or '—'}, id {m['from']})")
        quote_ = (m.get('text') or f"[{m['type']}]")[:300]
    else:
        err(400, 'bad')
    rep['quote'] = quote_
    db['c']['report'] = db['c'].get('report', 0) + 1
    rep['id'] = db['c']['report']
    db['reports'].append(rep)
    save()
    n = deliver_report(rep)
    return {'ok': True, 'id': rep['id'], 'delivered': n}


def fullname(u):
    return ' '.join(x for x in [(u or {}).get('name'), (u or {}).get('lastName')] if x) or 'Пользователь'


def deliver_report(rep) -> int:
    f = U(rep['from'])
    reasons = {'spam': 'Спам', 'abuse': 'Оскорбления', 'violence': 'Насилие', 'fraud': 'Мошенничество', 'porn': 'Неприемлемый контент', 'other': 'Другое'}
    txt = (f"🚨 **Жалоба #{rep['id']}**\nОт: {fullname(f)} (@{(f or {}).get('username') or '—'}, id {rep['from']})\nНа: {rep['target']}\n"
           f"Причина: **{reasons.get(rep['reason'], rep['reason'])}**")
    if rep.get('text'):
        txt += f"\nКомментарий: {rep['text']}"
    if rep.get('quote'):
        txt += f"\n\n«{rep['quote']}»"
    rid_ = rep['id']
    mk = [[Bt('🚫 Забанить', f'rep:ban:{rid_}'), Bt('🚪 Кикнуть', f'rep:kick:{rid_}')], [Bt('👁 Профиль', f'rep:whois:{rid_}'), Bt('✖ Отклонить', f'rep:dismiss:{rid_}')]]
    n = 0
    for u in list(db['users'].values()):
        if is_staff(u) and u['id'] != rep['from']:
            m = bot_send(1, u['id'], txt, mk)
            rep['msgs'].append(m['id'])
            n += 1
    save()
    return n


def resolve_report(rep, by, action):
    rep['status'], rep['by'], rep['action'], rep['resolvedAt'] = 'resolved', by['id'] if by else None, action, now()
    for mid in rep.get('msgs', []):
        cid = msg_index.get(mid)
        m = next((x for x in chat_msgs(cid) if x['id'] == mid), None) if cid else None
        if m:
            base = m['text'].split('\n\n✅')[0]
            bot_edit(m, base + f"\n\n✅ **Решено** — {fullname(by)}: {action}", markup=None)
    save()


# ───────────────────────── модерация ─────────────────────────
class CmdError(Exception):
    pass


def find_user(ref: str):
    ref = (ref or '').strip()
    if not ref:
        raise CmdError('Укажите пользователя: @username, id или e-mail')
    if ref.startswith('@'):
        e = db['usernames'].get(ref[1:].lower())
        u = U(e['id']) if e and e['t'] == 'user' else None
    elif ref.isdigit():
        u = U(int(ref))
    elif '@' in ref:
        u = next((x for x in db['users'].values() if (x.get('email') or '').lower() == ref.lower()), None)
    else:
        e = db['usernames'].get(ref.lower())
        u = U(e['id']) if e and e['t'] == 'user' else None
    if not u:
        raise CmdError(f'Пользователь «{ref}» не найден')
    return u


def find_chat(ref: str):
    ref = (ref or '').strip()
    ch = None
    if ref.startswith('@') or (ref and ref in db['usernames']):
        e = db['usernames'].get(ref.lstrip('@').lower())
        ch = C(e['id']) if e and e['t'] == 'chat' else None
    else:
        ch = C(ref)
        if not ch and ref.isdigit():
            ch = C(f'g:{ref}')
    if not ch or ch['type'] not in ('group', 'channel'):
        raise CmdError(f'Группа/канал «{ref}» не найден(а)')
    return ch


def refresh_user(u):
    emit_to(u['id'], 'me:update', {'user': pub(u, u['id'])})
    presence_broadcast(u['id'])
    save()


def kill_sessions(u):
    n = 0
    for t, s in list(db['sessions'].items()):
        if s['userId'] == u['id']:
            db['sessions'].pop(t, None)
            emit_room('s:' + s['sid'], 'session:revoked', None)
            n += 1
    save()
    return n


def do_ban(t, reason, by):
    if t['id'] in SYSTEM_BOTS or t.get('system'):
        raise CmdError('Нельзя заблокировать системного бота')
    if by and t['id'] == by['id']:
        raise CmdError('Нельзя заблокировать самого себя')
    if t.get('owner'):
        raise CmdError('Нельзя заблокировать владельца')
    if t.get('geo') and by and not by.get('owner'):
        raise CmdError('Участника [GEO] может заблокировать только владелец')
    t['banned'] = {'reason': clamp(reason, 200), 'by': by['id'] if by else 0, 'at': now()}
    n = kill_sessions(t)
    presence_broadcast(t['id'])
    save()
    return f"@{t.get('username') or t['id']} заблокирован (сеансов закрыто: {n})"


def do_unban(t):
    if not t.get('banned'):
        raise CmdError('Пользователь не заблокирован')
    t.pop('banned', None)
    presence_broadcast(t['id'])
    save()
    return f"@{t.get('username') or t['id']} разблокирован"


def do_kick(t):
    if t['id'] in SYSTEM_BOTS:
        raise CmdError('Нельзя кикнуть системного бота')
    n = kill_sessions(t)
    return f"@{t.get('username') or t['id']}: завершено сеансов — {n} (пользователь вышел из аккаунта на всех устройствах)"


def whois_text(u):
    if not u:
        return 'Пользователь не найден'
    flags = [k for k, v in (('✔ verified', u.get('verified')), ('[GEO]', u.get('geo')), ('owner', u.get('owner')), ('bot', u.get('bot')), ('deleted', u.get('deleted')), ('password', u.get('pwd'))) if v]
    if u.get('banned'):
        flags.append('🚫 banned: ' + (u['banned'].get('reason') or '—'))
    sess = sum(1 for s in db['sessions'].values() if s['userId'] == u['id'])
    reps = sum(1 for r in db['reports'] if r.get('tuid') == u['id'])
    return (f"id {u['id']} · {fullname(u)} · @{u.get('username') or '—'}\n{u.get('email')}\nЗарегистрирован: {time.strftime('%d.%m.%Y %H:%M', time.gmtime((u.get('createdAt') or 0) / 1000))} UTC\n"
            f"Сеансов: {sess} · жалоб на пользователя: {reps} · {'онлайн' if is_online(u['id']) else 'оффлайн'}\nФлаги: {', '.join(flags) or '—'}")


CMDS: dict = {}


def cmd(name, level='owner', usage='', doc=''):
    def d(fn):
        CMDS[name] = (fn, level, usage, doc)
        return fn
    return d


def exec_cmd(line, actor=None, level='owner') -> str:
    line = (line or '').strip()
    if line.startswith('/'):
        line = line[1:]
    if not line:
        return ''
    name, _, rest = line.partition(' ')
    name = name.lower().split('@')[0]
    ent = CMDS.get(name)
    if not ent:
        return f'Неизвестная команда «{name}». Введите help.'
    fn, lv, _u, _d = ent
    if lv == 'owner' and level != 'owner':
        return '⛔ Команда доступна только владельцу.'
    try:
        return fn(rest.strip(), actor, level)
    except CmdError as e:
        return f'⚠ {e}'


@cmd('help', 'staff', 'help', 'список команд')
def c_help(a, actor, level):
    rows = [f'  {u:<34} {d}' for _n, (_f, lv, u, d) in CMDS.items() if level == 'owner' or lv == 'staff']
    return 'Команды:\n' + '\n'.join(rows)


@cmd('stats', 'owner', 'stats', 'статистика сервера')
def c_stats(a, actor, level):
    us = list(db['users'].values())
    return (f"Пользователи: {sum(1 for u in us if not u.get('bot') and not u.get('deleted'))} (онлайн {len(online)}) · боты: {sum(1 for u in us if u.get('bot'))}\n"
            f"Чатов: {len(db['chats'])} · сообщений: {sum(len(v) for v in db['messages'].values())} · сеансов: {len(db['sessions'])}\n"
            f"С галочкой: {sum(1 for u in us if u.get('verified') and not u.get('system'))} · [GEO]: {sum(1 for u in us if u.get('geo'))} · заблокировано: {sum(1 for u in us if u.get('banned'))}\n"
            f"Открытых жалоб: {sum(1 for r in db['reports'] if r['status'] == 'open')} · хранилище: {'PostgreSQL' if pool else 'файл'} · аптайм: {int((time.time() - STARTED) // 60)} мин")


@cmd('users', 'owner', 'users [поиск]', 'список пользователей (до 40)')
def c_users(a, actor, level):
    q = a.lower().lstrip('@')
    rows = []
    for u in db['users'].values():
        if u.get('bot') or u.get('deleted'):
            continue
        if q and q not in f"{u['name']} {u.get('lastName', '')} {u.get('username', '')} {u['email']}".lower():
            continue
        fl = ''.join(x for x, k in (('✔', 'verified'), ('G', 'geo'), ('O', 'owner'), ('🚫', 'banned')) if u.get(k))
        rows.append(f"{u['id']:>4}  @{(u.get('username') or '—'):<16} {fullname(u)[:22]:<22} {u['email']}  {fl}")
    return f'Найдено: {len(rows)}\n' + '\n'.join(rows[:40])


@cmd('whois', 'staff', 'whois @user', 'информация о пользователе')
def c_whois(a, actor, level):
    return whois_text(find_user(a))


def _flag(a, key, val, label_on, label_off, notice=None):
    u = find_user(a)
    if u.get('bot') and key in ('geo', 'owner'):
        raise CmdError('Это бот')
    u[key] = val
    refresh_user(u)
    if val and notice and not u.get('banned') and not u.get('bot'):
        bot_send(1, u['id'], notice)
    return f"@{u.get('username') or u['id']}: {label_on if val else label_off}"


@cmd('verify', 'owner', 'verify @user', 'выдать галочку ✔')
def c_verify(a, actor, level):
    return _flag(a, 'verified', True, 'галочка выдана ✔', '', '✅ Ваш аккаунт получил **галочку** подтверждения.')


@cmd('unverify', 'owner', 'unverify @user', 'снять галочку')
def c_unverify(a, actor, level):
    return _flag(a, 'verified', False, '', 'галочка снята')


@cmd('geo', 'owner', 'geo @user', 'выдать статус [GEO] (модератор)')
def c_geo(a, actor, level):
    return _flag(a, 'geo', True, 'статус [GEO] выдан', '', '🛡 Вам выдан статус **[GEO]**. Теперь вы можете блокировать и кикать пользователей, а жалобы будут приходить сюда. Напишите /help.')


@cmd('ungeo', 'owner', 'ungeo @user', 'снять статус [GEO]')
def c_ungeo(a, actor, level):
    return _flag(a, 'geo', False, '', 'статус [GEO] снят')


@cmd('owner', 'owner', 'owner @user', 'сделать владельцем (консоль)')
def c_owner(a, actor, level):
    return _flag(a, 'owner', True, 'теперь владелец', '')


@cmd('unowner', 'owner', 'unowner @user', 'снять права владельца')
def c_unowner(a, actor, level):
    u = find_user(a)
    if actor and u['id'] == actor['id']:
        raise CmdError('Нельзя снять права с себя')
    return _flag(a, 'owner', False, '', 'владелец снят')


@cmd('verify-chat', 'owner', 'verify-chat @канал|id', 'выдать [VER] группе/каналу')
def c_verify_chat(a, actor, level):
    ch = find_chat(a)
    ch['verified'] = True
    save()
    update_chat(ch)
    return f"«{ch['title']}»: [VER] выдан"


@cmd('unverify-chat', 'owner', 'unverify-chat @канал|id', 'снять [VER]')
def c_unverify_chat(a, actor, level):
    ch = find_chat(a)
    ch['verified'] = False
    save()
    update_chat(ch)
    return f"«{ch['title']}»: [VER] снят"


@cmd('ban', 'staff', 'ban @user [причина]', 'заблокировать аккаунт')
def c_ban(a, actor, level):
    ref, _, reason = a.partition(' ')
    return do_ban(find_user(ref), reason.strip() or 'нарушение правил', actor)


@cmd('unban', 'staff', 'unban @user', 'разблокировать')
def c_unban(a, actor, level):
    return do_unban(find_user(a))


@cmd('kick', 'staff', 'kick @user', 'выкинуть из аккаунта на всех устройствах')
def c_kick(a, actor, level):
    t = find_user(a)
    if t.get('owner') and not (actor or {}).get('owner') and actor is not None:
        raise CmdError('Нельзя кикнуть владельца')
    return do_kick(t)


@cmd('resetpass', 'owner', 'resetpass @user', 'удалить пароль пользователя')
def c_resetpass(a, actor, level):
    u = find_user(a)
    u.pop('pwd', None)
    refresh_user(u)
    return f"@{u.get('username') or u['id']}: пароль удалён (вход по коду из почты)"


@cmd('bots', 'owner', 'bots', 'список созданных ботов')
def c_bots(a, actor, level):
    rows = [f"{u['id']:>4}  @{u.get('username')}  владелец: {u.get('botOwner')}  {'webhook' if (u.get('botCfg') or {}).get('webhook') else ''}" for u in db['users'].values() if u.get('botOwner') and not u.get('deleted')]
    return f'Ботов: {len(rows)}\n' + '\n'.join(rows)


@cmd('delbot', 'owner', 'delbot @bot', 'удалить бота')
def c_delbot(a, actor, level):
    b = find_user(a)
    if not b.get('botOwner'):
        raise CmdError('Это не пользовательский бот')
    delete_bot(b)
    return 'бот удалён'


@cmd('reports', 'staff', 'reports [all]', 'жалобы')
def c_reports(a, actor, level):
    rs = [r for r in db['reports'] if a == 'all' or r['status'] == 'open']
    if not rs:
        return 'Открытых жалоб нет ✅'
    return '\n'.join(f"#{r['id']} [{r['status']}] {r['reason']}: {r['target']}" + (f" — {r['text']}" if r.get('text') else '') for r in rs[-30:])


@cmd('resolve', 'staff', 'resolve ID [заметка]', 'закрыть жалобу')
def c_resolve(a, actor, level):
    rid_, _, note = a.partition(' ')
    rep = next((r for r in db['reports'] if str(r['id']) == rid_), None)
    if not rep:
        raise CmdError('Жалоба не найдена')
    resolve_report(rep, actor, note or 'закрыта')
    return f'Жалоба #{rid_} закрыта'


@cmd('announce', 'owner', 'announce текст', 'сообщение всем пользователям от GeoMetric')
def c_announce(a, actor, level):
    if not a:
        raise CmdError('Введите текст')
    n = 0
    for u in list(db['users'].values()):
        if not u.get('bot') and not u.get('deleted') and not u.get('banned'):
            bot_send(1, u['id'], '📢 ' + a)
            n += 1
    return f'Отправлено: {n}'


@cmd('export', 'owner', 'export', 'ZIP-архив всех данных (в веб-консоли — кнопка)')
def c_export(a, actor, level):
    return 'Архив скачивается кнопкой «Скачать ZIP» в консоли или командой: python manage.py export backup.zip'


def delete_bot(b):
    t = (b.get('botCfg') or {}).get('token')
    bot_tokens.pop(t, None)
    if b.get('username'):
        db['usernames'].pop(b['username'].lower(), None)
    b.update(name='Deleted Bot', username='', avatar='', bio='', deleted=True)
    b['botCfg'] = {'commands': []}
    save()


# ───────────────────────── консоль владельца: HTTP ─────────────────────────
def admin_auth(c: Ctx):
    """ключ ADMIN_KEY (для manage.py) либо сеанс владельца"""
    key = os.environ.get('ADMIN_KEY') or ''
    hk = c.request.headers.get('X-Admin-Key', '')
    if key and hk and secrets.compare_digest(hk, key):
        return None
    try:
        authenticate(c)
    except ApiError:
        err(401, 'unauthorized')
    if not is_owner(c.me):
        err(403, 'forbidden')
    return c.me


@route('POST', '/api/admin/console', auth=False)
def admin_console(c: Ctx):
    if limited('adm:' + c.ip, 120, 60e3):
        err(429, 'too_many')
    actor = admin_auth(c)
    return {'out': exec_cmd(str(c.body.get('cmd') or ''), actor, 'owner')}


def _zip_media_pg(z, rows):
    for r in rows:
        z.writestr(f"media/{r['id']}", bytes(r['data']))
        z.writestr(f"media/{r['id']}.json", json.dumps({'mime': r['mime'], 'name': r['name'], 'size': r['size']}))


async def build_export(path: str) -> dict:
    users = [u for u in db['users'].values() if not u.get('system')]
    cnt = {'users': len([u for u in users if not u.get('bot')]), 'bots': len([u for u in users if u.get('bot')]), 'chats': len(db['chats']),
           'messages': sum(len(v) for v in db['messages'].values()), 'media': 0}
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('db.json', json.dumps(db, ensure_ascii=False))
        pubu = [{'id': u['id'], 'email': u.get('email'), 'name': u.get('name'), 'lastName': u.get('lastName'), 'username': u.get('username'), 'bio': u.get('bio'),
                 'birthday': u.get('birthday'), 'verified': bool(u.get('verified')), 'geo': bool(u.get('geo')), 'owner': bool(u.get('owner')), 'bot': bool(u.get('bot')),
                 'banned': u.get('banned'), 'createdAt': u.get('createdAt')} for u in users]
        z.writestr('users.json', json.dumps(pubu, ensure_ascii=False, indent=1))
        sio_ = io.StringIO()
        w = csv.writer(sio_)
        w.writerow(['id', 'email', 'name', 'last_name', 'username', 'verified', 'geo', 'banned', 'bot', 'created'])
        for u in pubu:
            w.writerow([u['id'], u['email'], u['name'], u['lastName'], u['username'], u['verified'], u['geo'], bool(u['banned']), u['bot'],
                        time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime((u['createdAt'] or 0) / 1000))])
        z.writestr('users.csv', '\ufeff' + sio_.getvalue())
        if pool:
            async with pool.acquire() as con:
                ids = [r['id'] for r in await con.fetch('select id from media')]
            for i in range(0, len(ids), 20):
                async with pool.acquire() as con:
                    rows = await con.fetch('select id,mime,name,size,data from media where id = any($1::text[])', ids[i:i + 20])
                _zip_media_pg(z, rows)
                cnt['media'] += len(rows)
        else:
            for f in UPLOAD_DIR.iterdir():
                if f.suffix != '.json':
                    z.write(f, f'media/{f.name}')
                    z.write(f.with_name(f.name + '.json'), f'media/{f.name}.json') if f.with_name(f.name + '.json').exists() else None
                    cnt['media'] += 1
        z.writestr('manifest.json', json.dumps({'app': APP_NAME, 'version': 1, 'created': now(), **cnt}, ensure_ascii=False, indent=1))
        z.writestr('README.txt', 'Архив GeoMetric Beta.\nНа новом сервере: python manage.py import <этот файл>.zip (или «Импорт ZIP» в консоли владельца).\nusers.csv — удобный список пользователей.\n')
    return cnt


@route('GET', '/api/admin/export', auth=False)
async def admin_export(c: Ctx):
    admin_auth(c)
    fd, path = tempfile.mkstemp(suffix='.zip')
    os.close(fd)
    try:
        await build_export(path)
        data = await asyncio.to_thread(Path(path).read_bytes)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    name = time.strftime('geometric-backup-%Y%m%d-%H%M.zip', time.gmtime())
    return web.Response(body=data, headers={'Content-Type': 'application/zip', 'Content-Disposition': f'attachment; filename="{name}"', 'Cache-Control': 'no-store'})


@route('POST', '/api/admin/import', auth=False)
async def admin_import(c: Ctx):
    admin_auth(c)
    raw = await c.request.read()
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        newdb = json.loads(z.read('db.json').decode('utf8'))
        assert isinstance(newdb.get('users'), dict)
    except Exception:
        err(400, 'bad_archive')
    db.clear()
    db.update(newdb)
    for k, v in blank().items():
        db.setdefault(k, v)
    msg_index.clear()
    user_chats.clear()
    for cid, arr in db['messages'].items():
        for m in arr:
            msg_index[m['id']] = cid
    for ch in db['chats'].values():
        for uid in ch['members']:
            user_chats.setdefault(int(uid), set()).add(ch['id'])
    seed()
    nm = 0
    names = set(z.namelist())
    for n in names:
        if n.startswith('media/') and not n.endswith('.json') and n + '.json' in names:
            mid = n[6:]
            if not ID_RE.fullmatch(mid):
                continue
            meta = json.loads(z.read(n + '.json').decode('utf8'))
            data = z.read(n)
            if pool:
                async with pool.acquire() as con:
                    await con.execute('insert into media(id,mime,name,size,data) values($1,$2,$3,$4,$5) on conflict (id) do update set data=excluded.data, mime=excluded.mime, name=excluded.name, size=excluded.size',
                                      mid, meta.get('mime'), meta.get('name'), len(data), data)
            else:
                (UPLOAD_DIR / mid).write_bytes(data)
                (UPLOAD_DIR / (mid + '.json')).write_text(json.dumps(meta), 'utf8')
            nm += 1
    await persist()
    return {'ok': True, 'users': len(db['users']), 'chats': len(db['chats']), 'media': nm}


# ───────────────────────── пароль (необязательный способ входа) ─────────────────────────
def pw_hash(pw: str, salt: str = None):
    salt = salt or secrets.token_hex(16)
    return {'salt': salt, 'hash': hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), 150_000).hex()}


def pw_check(u, pw: str) -> bool:
    p = u.get('pwd')
    if not p or not pw:
        return False
    return secrets.compare_digest(pw_hash(pw, p['salt'])['hash'], p['hash'])


@route('PUT', '/api/me/password')
async def set_password(c: Ctx):
    pw = str(c.body.get('password') or '')
    if len(pw) < 6 or len(pw) > 100:
        err(400, 'weak_password')
    if limited(f'pw:{c.uid}', 10, 600e3):
        err(429, 'too_many')
    if c.me.get('pwd') and not await asyncio.to_thread(pw_check, c.me, str(c.body.get('current') or '')):
        err(403, 'wrong_password')
    c.me['pwd'] = await asyncio.to_thread(pw_hash, pw)
    save()
    emit_to(c.uid, 'me:update', {'user': pub(c.me, c.uid)})
    return {'ok': True}


@route('DELETE', '/api/me/password')
async def remove_password(c: Ctx):
    if limited(f'pw:{c.uid}', 10, 600e3):
        err(429, 'too_many')
    if c.me.get('pwd'):
        if not await asyncio.to_thread(pw_check, c.me, str(c.body.get('current') or '')):
            err(403, 'wrong_password')
        c.me.pop('pwd', None)
        save()
        emit_to(c.uid, 'me:update', {'user': pub(c.me, c.uid)})
    return {'ok': True}


@route('POST', '/api/auth/login', auth=False)
async def auth_login(c: Ctx):
    email = clamp(c.body.get('email'), 120).strip().lower()
    pw = str(c.body.get('password') or '')
    if limited('lg:' + c.ip, 30, 600e3) or limited('lg:' + email, 8, 600e3):
        err(429, 'too_many')
    u = next((x for x in db['users'].values() if (x.get('email') or '').lower() == email and not x.get('deleted') and not x.get('bot')), None)
    ok = await asyncio.to_thread(pw_check, u, pw) if u else False
    if not ok:
        await asyncio.sleep(0.4)
        err(400, 'wrong_password')
    if u.get('banned'):
        return 403, {'error': 'banned', 'reason': u['banned'].get('reason', '')}
    token = create_session(u['id'], c.request.headers.get('User-Agent', ''), c.ip, clamp(c.body.get('device'), 80))
    return {'token': token, 'user': pub(u, u['id']), 'isNew': False}


# ───────────────────────── колбэки inline-кнопок ─────────────────────────
@route('POST', '/api/messages/{id}/callback')
def msg_callback(c: Ctx):
    m, ch = find_msg(c)
    bot = U(m['from'])
    data = str(c.body.get('data') or '')
    if not bot or not bot.get('bot') or not any(b.get('data') == data for row in (m.get('markup') or []) for b in row):
        err(400, 'bad')
    if limited(f'cb:{c.uid}', 120, 60e3):
        err(429, 'too_many')
    bid = bot['id']
    if bid == 1:
        geometric_cb(c.uid, m, data)
    elif bid == GEOAI_ID:
        geoai_cb(c.uid, m, data)
    elif bid == BOTFATHER_ID:
        botfather_cb(c.uid, m, data)
    else:
        qid = rid(8)
        cb_queries[qid] = {'uid': c.uid, 'msg': m['id'], 'ts': now()}
        bot_push_update(bot, 'callback_query', {'id': qid, 'from': api_user(c.me), 'message': api_msg(m, c.uid), 'chat_instance': str(c.uid), 'data': data})
    return {'ok': True}


cb_queries: dict = {}


# ───────────────────────── GeoAI ─────────────────────────
AI_WELCOME = ('👋 Привет! Я **GeoAI** — ИИ-помощник GeoMetric.\n\nМогу ответить на вопросы, придумать идею, объяснить сложное простыми словами, перевести или написать текст и код.\n'
              'Просто напишите сообщение или выберите подсказку ниже.\n\n/clear — забыть историю диалога')
AI_MARKUP = [[Bt('💡 Придумай идею', 'ask:Придумай 5 необычных идей для вечера с друзьями'), Bt('🧠 Объясни просто', 'ask:Объясни простыми словами, как работает интернет')],
             [Bt('🌍 Переведи', 'ask:Переведи на английский: «Мы запускаем новый мессенджер»'), Bt('✍ Напиши пост', 'ask:Напиши короткий весёлый пост о запуске мессенджера GeoMetric Beta')]]
AI_SYSTEM = ('Ты GeoAI — дружелюбный ИИ-помощник мессенджера GeoMetric Beta. Отвечай на языке пользователя, по делу и кратко (обычно до 8–10 строк), если не просили подробнее. '
             'Форматирование поддерживается только такое: **жирный**, __курсив__, `код`, блоки кода в тройных обратных кавычках; для списков используй символ «•». '
             'Не используй заголовки с #, таблицы и ссылки в формате [текст](url). Не выдумывай факты; если не уверен — скажи об этом.')
ai_locks: dict = {}


def ai_clean(t: str) -> str:
    t = re.sub(r'^\s{0,3}#{1,6}\s*(.+?)\s*$', r'**\1**', t, flags=re.M)
    t = re.sub(r'^\s*[-*]\s+', '• ', t, flags=re.M)
    t = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'\1 (\2)', t)
    t = re.sub(r'(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])', r'__\1__', t)
    return t.strip()[:4000]


def ai_config():
    key = (os.environ.get('AI_API_KEY') or '').strip()
    base = (os.environ.get('AI_BASE_URL') or '').strip().rstrip('/')
    model = (os.environ.get('AI_MODEL') or '').strip()
    prov = 'custom'
    if key and not base:
        if key.startswith('gsk_'):
            prov, base, model = 'Groq', 'https://api.groq.com/openai/v1', model or 'llama-3.3-70b-versatile'
        elif key.startswith('AIza'):
            prov, base, model = 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', model or 'gemini-2.0-flash'
        elif key.startswith('sk-or-'):
            prov, base, model = 'OpenRouter', 'https://openrouter.ai/api/v1', model or 'meta-llama/llama-3.3-70b-instruct:free'
        else:
            prov, base, model = 'OpenAI', 'https://api.openai.com/v1', model or 'gpt-4o-mini'
    elif not base:
        prov, base, model = 'Pollinations (без ключа, нестабильно)', 'https://text.pollinations.ai/openai', model or 'openai-fast'
    url = base if base.endswith(('/chat/completions', '/openai')) else base + '/chat/completions'
    return {'key': key, 'url': url, 'model': model or 'gpt-4o-mini', 'provider': prov}


async def ai_complete(messages):
    cfg = ai_config()
    headers = {'Authorization': 'Bearer ' + cfg['key']} if cfg['key'] else {}
    payload = {'model': cfg['model'], 'messages': [{'role': 'system', 'content': AI_SYSTEM}, *messages], 'temperature': 0.7, 'max_tokens': 900}
    last = None
    for attempt in range(2):
        try:
            async with aiohttp.ClientSession() as cs:
                async with cs.post(cfg['url'], json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=70)) as r:
                    j = await r.json(content_type=None)
                    if r.status >= 300:
                        raise RuntimeError(f'ai {r.status} {str(j)[:200]}')
            txt = (j['choices'][0]['message'].get('content') or '').strip()
            if txt:
                return txt
            raise RuntimeError('empty answer')
        except Exception as e:
            last = e
            if '402' in str(e) or '401' in str(e) or '403' in str(e):
                break
            await asyncio.sleep(1.2)
    raise last


@cmd('ai', 'owner', 'ai', 'провайдер и статус GeoAI')
def c_ai(a, actor, level):
    cf = ai_config()
    return f"GeoAI: провайдер {cf['provider']}, модель {cf['model']}, ключ {'задан' if cf['key'] else 'НЕ задан'}"


AI_NOKEY = ('⚠ ИИ пока не подключён. Владельцу сервера нужно задать переменную окружения **AI_API_KEY** (подойдёт бесплатный ключ Groq, Google Gemini или OpenRouter) — '
            'инструкция в README, раздел «GeoAI».')


def ai_context(chat, uid):
    base = chat.get('aiReset', 0)
    msgs = [m for m in visible_msgs(chat, uid) if m['id'] > base and m['type'] == 'text' and m.get('text') and not m['text'].startswith('/')]
    out = []
    for m in msgs[-14:]:
        role = 'user' if m['from'] == uid else 'assistant'
        if out and out[-1]['role'] == role:
            out[-1]['content'] += '\n' + m['text']
        else:
            out.append({'role': role, 'content': m['text'][:2000]})
    while out and out[0]['role'] != 'user':
        out.pop(0)
    return out


async def ai_answer(chat, uid):
    lock = ai_locks.setdefault(chat['id'], asyncio.Lock())
    async with lock:
        ctx = ai_context(chat, uid)
        if not ctx or ctx[-1]['role'] != 'user':
            return
        stop = asyncio.Event()

        async def typing():
            while not stop.is_set():
                emit_to(uid, 'typing', {'chatId': chat['id'], 'userId': GEOAI_ID, 'action': 'typing'})
                try:
                    await asyncio.wait_for(stop.wait(), 3)
                except asyncio.TimeoutError:
                    pass
        tk = asyncio.create_task(typing())
        try:
            text = ai_clean(await ai_complete(ctx))
        except Exception as e:
            log('ai error', e)
            nokey = not ai_config()['key']
            text = AI_NOKEY if nokey else '⚠ Не получилось получить ответ ИИ. Попробуйте ещё раз через минуту.'
        finally:
            stop.set()
            await tk
        if chat['id'] in db['chats']:
            bot_send(GEOAI_ID, uid, text)


def geoai_bot(chat, m):
    uid = m['from']
    t = (m.get('text') or '').strip()
    low = t.lower().split('@')[0]
    if low in ('/start', '/help'):
        bot_reply(GEOAI_ID, uid, AI_WELCOME, AI_MARKUP)
        return
    if low == '/clear':
        chat['aiReset'] = chat['lastId']
        save()
        bot_reply(GEOAI_ID, uid, '🧹 Контекст очищен. Начнём с чистого листа!')
        return
    if m['type'] != 'text' or not t:
        bot_reply(GEOAI_ID, uid, 'Я понимаю только текстовые сообщения 🙂')
        return
    if limited(f'ai:{uid}', 30, 600e3):
        bot_reply(GEOAI_ID, uid, '⏳ Слишком много запросов. Подождите пару минут.')
        return
    asyncio.ensure_future(ai_answer(chat, uid))


def geoai_cb(uid, m, data):
    if data.startswith('ask:'):
        ch = C(m['chatId'])
        push_message(ch, uid, {'text': data[4:]})
        cb_answer(uid, '')


# ───────────────────────── BotFather ─────────────────────────
BF_HELP = ('🤖 **BotFather** — здесь создаются и настраиваются боты GeoMetric.\n\n**Создание**\n/newbot — создать бота\n/mybots — мои боты и все настройки\n\n**Настройка**\n'
           '/setname — имя\n/setdescription — описание (видно в пустом чате)\n/setabouttext — текст «О боте»\n/setcommands — список команд\n/setuserpic — аватарка\n'
           '/setwebhook — webhook для вашего сервера\n/token — показать токен\n/revoke — новый токен\n/deletebot — удалить бота\n/cancel — отменить текущее действие\n\n'
           'В /mybots → «Команды и ответы» можно задать готовые ответы на команды **без программирования**. Для сложной логики используйте Bot API: `/bot<TOKEN>/getUpdates`, `sendMessage` и т. д. — как в Telegram.')
BF_ACTIONS = {'setname': 'name', 'setdescription': 'desc', 'setabouttext': 'about', 'setcommands': 'cmds', 'setuserpic': 'avatar', 'setwebhook': 'webhook', 'setgreeting': 'greeting', 'setdefault': 'default'}
BF_PROMPTS = {
    'name': 'Отправьте **новое имя** бота (до 40 символов).',
    'desc': 'Отправьте **описание** бота — оно показывается в пустом чате (до 512 символов). «-» — очистить.',
    'about': 'Отправьте текст **«О боте»** — виден в профиле (до 200 символов). «-» — очистить.',
    'cmds': 'Отправьте список команд, по одной в строке:\n`start - Начать работу`\n`help - Помощь`\nСтарые ответы для совпадающих команд сохранятся. «-» — очистить список.',
    'avatar': 'Отправьте **фото** — оно станет аватаркой бота.',
    'webhook': 'Отправьте **https-адрес** вашего сервера: на него будут приходить обновления (JSON, как в Telegram). «-» — отключить webhook и вернуться к встроенным ответам.',
    'greeting': 'Отправьте текст **приветствия** — ответ на /start. Можно использовать {name} и {username}. «-» — сбросить.',
    'default': 'Отправьте **ответ по умолчанию** — на любое сообщение, не являющееся командой. «-» — отключить.',
}


def bf_owned(uid):
    return [u for u in db['users'].values() if u.get('botOwner') == uid and not u.get('deleted')]


def bf_bot(uid, bid):
    b = U(bid)
    return b if b and b.get('botOwner') == uid and not b.get('deleted') else None


def bf_state(uid, st=None, clear=False):
    u = U(uid)
    if clear:
        u.pop('bf', None)
    elif st is not None:
        u['bf'] = st
    save()


def bf_menu(b):
    cfg = b['botCfg']
    txt = (f"🤖 **{b['name']}** · @{b['username']}\n\n**Описание:** {b.get('botDesc') or '—'}\n**О боте:** {b.get('bio') or '—'}\n**Команд:** {len(cfg['commands'])}"
           f" · **Режим:** {'webhook ' + cfg['webhook'] if cfg.get('webhook') else 'встроенные ответы'}")
    i = b['id']
    mk = [[Bt('✏ Имя', f'act:name:{i}'), Bt('📝 Описание', f'act:desc:{i}'), Bt('ℹ О боте', f'act:about:{i}')],
          [Bt('🖼 Аватарка', f'act:avatar:{i}'), Bt('⌨ Команды и ответы', f'cm:{i}')],
          [Bt('👋 Приветствие', f'act:greeting:{i}'), Bt('💬 Ответ по умолчанию', f'act:default:{i}')],
          [Bt('🔗 Webhook', f'act:webhook:{i}'), Bt('🔑 Токен', f'tok:{i}')],
          [Bt('🗑 Удалить бота', f'del:{i}'), Bt('⬅ Мои боты', 'list')]]
    return txt, mk


def bf_cmds_menu(b):
    cm = b['botCfg']['commands']
    lines = [f"/{c['cmd']} — {c.get('desc') or '—'}" + (f"\n    ↳ ответ: {c['reply'][:60]}" if c.get('reply') else '') for c in cm]
    txt = f"⌨ **Команды @{b['username']}**\n\n" + ('\n'.join(lines) if lines else 'Пока нет команд.') + '\n\nДобавьте команду с готовым ответом или откройте существующую.'
    mk = [[Bt(f"/{c['cmd']}", f"cs:{b['id']}:{c['cmd']}")] for c in cm[:12]]
    mk.append([Bt('➕ Добавить команду', f"ca:{b['id']}"), Bt('📋 Списком', f"act:cmds:{b['id']}")])
    mk.append([Bt('⬅ Назад', f"mb:{b['id']}")])
    return txt, mk


def bf_list(uid, text_only=False):
    bots = bf_owned(uid)
    if not bots:
        return 'У вас пока нет ботов. Создайте первого — /newbot', None
    return 'Выберите бота:', [[Bt(f"@{b['username']}", f"mb:{b['id']}")] for b in bots] + [[Bt('➕ Новый бот', 'new')]]


def bf_choose(uid, action):
    bots = bf_owned(uid)
    if not bots:
        return bot_reply(BOTFATHER_ID, uid, 'У вас пока нет ботов. Создайте первого — /newbot')
    if action in ('token', 'revoke', 'deletebot'):
        pre = {'token': 'tok', 'revoke': 'rev', 'deletebot': 'del'}[action]
        mk = [[Bt(f"@{b['username']}", f"{pre}:{b['id']}")] for b in bots]
    else:
        mk = [[Bt(f"@{b['username']}", f"act:{BF_ACTIONS[action]}:{b['id']}")] for b in bots]
    bot_reply(BOTFATHER_ID, uid, 'Выберите бота:', mk)


def create_bot(owner, name, username):
    db['c']['user'] += 1
    bid = db['c']['user']
    token = f'{bid}:{secrets.token_urlsafe(24)}'
    db['users'][str(bid)] = {'id': bid, 'email': f'bot{bid}@bots.geometric.local', 'name': name, 'lastName': '', 'username': username, 'bio': '', 'avatar': '', 'color': bid % 8,
                             'emoji': '', 'bot': True, 'botOwner': owner, 'botDesc': '', 'createdAt': now(), 'lastSeen': now(), 'privacy': {}, 'settings': {}, 'contacts': [], 'blocked': [],
                             'botCfg': {'token': token, 'commands': [], 'greeting': '', 'default': '', 'webhook': ''}}
    db['usernames'][username.lower()] = {'t': 'user', 'id': bid}
    bot_tokens[token] = bid
    save()
    return db['users'][str(bid)], token


def bf_done(uid, b, text='✅ Готово!'):
    bf_state(uid, clear=True)
    bot_send(BOTFATHER_ID, uid, text, [[Bt('⚙ Меню бота', f"mb:{b['id']}"), Bt('📋 Мои боты', 'list')]])


def botfather_msg(chat, m):
    uid = m['from']
    text = (m.get('text') or '').strip()
    st = U(uid).get('bf')
    cmd_ = text.split()[0].lower().split('@')[0] if text.startswith('/') else ''
    say = lambda t, mk=None: bot_reply(BOTFATHER_ID, uid, t, mk)
    if cmd_ == '/cancel':
        bf_state(uid, clear=True)
        return say('Действие отменено. Что дальше? /mybots')
    if cmd_ in ('/start', '/help'):
        bf_state(uid, clear=True)
        return say(BF_HELP, [[Bt('🤖 Новый бот', 'new'), Bt('📋 Мои боты', 'list')]])
    if cmd_ == '/newbot':
        bf_state(uid, {'a': 'new_name'})
        return say('Отлично! Как назовём бота? Отправьте **имя** (оно будет видно в чатах), например: GeoShop')
    if cmd_ == '/mybots':
        bf_state(uid, clear=True)
        t, mk = bf_list(uid)
        return say(t, mk)
    if cmd_[1:] in BF_ACTIONS:
        bf_state(uid, clear=True)
        return bf_choose(uid, cmd_[1:])
    if cmd_ in ('/token', '/revoke', '/deletebot'):
        bf_state(uid, clear=True)
        return bf_choose(uid, cmd_[1:])
    if cmd_:
        return say('Не знаю такой команды. Список — /help')
    if not st:
        return say('Я BotFather 🤖 Используйте /newbot, /mybots или /help.')
    a = st.get('a')
    if a == 'new_name':
        if not text or len(text) > 40 or m['type'] != 'text':
            return say('Имя — от 1 до 40 символов. Попробуйте ещё раз или /cancel.')
        bf_state(uid, {'a': 'new_user', 'name': text})
        return say('Теперь придумайте **username** бота. Он должен заканчиваться на `bot`, содержать только латиницу, цифры и «_», например: `geoshop_bot`.')
    if a == 'new_user':
        un = text.lstrip('@')
        if not USERNAME_RE.match(un) or not un.lower().endswith('bot'):
            return say('Username: 5–32 символа (a-z, 0-9, _), обязательно оканчивается на `bot`. Попробуйте ещё раз.')
        if not username_free(un):
            return say('Этот username занят. Придумайте другой.')
        b, token = create_bot(uid, st['name'], un)
        bf_state(uid, clear=True)
        return bot_reply(BOTFATHER_ID, uid, f"🎉 Готово! Бот **{b['name']}** создан: @{b['username']}\n\nВаш токен (храните в тайне!):\n```{token}```\n"
                         f"Бот уже отвечает на /start. Настройте ответы, команды, аватарку и webhook в меню. API: `/bot{token.split(':')[0]}:…/getMe`",
                         [[Bt('⚙ Настроить', f"mb:{b['id']}"), Bt('💬 Открыть чат', url=f"{PUBLIC_URL()}/?u={b['username']}")]])
    if a == 'set':
        b = bf_bot(uid, st.get('b'))
        if not b:
            bf_state(uid, clear=True)
            return say('Бот не найден. /mybots')
        f = st['f']
        cfg = b['botCfg']
        clear_ = text == '-'
        if f == 'avatar':
            if m['type'] != 'photo' or not m.get('media'):
                return say('Нужно именно **фото**. Отправьте картинку или /cancel.')
            b['avatar'] = m['media']['url']
            return bf_done(uid, b, '✅ Аватарка обновлена!')
        if m['type'] != 'text' or not text:
            return say('Нужен текст. Отправьте сообщение или /cancel.')
        if f == 'name':
            b['name'] = text[:40]
        elif f == 'desc':
            b['botDesc'] = '' if clear_ else text[:512]
        elif f == 'about':
            b['bio'] = '' if clear_ else text[:200]
        elif f == 'greeting':
            cfg['greeting'] = '' if clear_ else text[:2000]
        elif f == 'default':
            cfg['default'] = '' if clear_ else text[:2000]
        elif f == 'webhook':
            if clear_:
                cfg['webhook'] = ''
            else:
                return asyncio.ensure_future(bf_set_webhook(uid, b, text))
        elif f == 'cmds':
            if clear_:
                cfg['commands'] = []
            else:
                old = {c['cmd']: c for c in cfg['commands']}
                new = []
                for line in text.splitlines():
                    mm = re.match(r'^/?([A-Za-z0-9_]{1,32})\s*[-–—:]?\s*(.*)$', line.strip())
                    if mm:
                        cm = mm.group(1).lower()
                        new.append({'cmd': cm, 'desc': mm.group(2)[:100], 'reply': old.get(cm, {}).get('reply', '')})
                if not new:
                    return say('Не распознал команды. Формат: `команда - описание`, по одной в строке.')
                cfg['commands'] = new[:50]
        save()
        return bf_done(uid, b)
    if a == 'cmd_add':
        b = bf_bot(uid, st.get('b'))
        if not b:
            bf_state(uid, clear=True)
            return say('Бот не найден.')
        s = st['s']
        if m['type'] != 'text' or not text:
            return say('Нужен текст.')
        if s == 'cmd':
            cm = text.lstrip('/').split()[0].lower()
            if not re.fullmatch(r'[a-z0-9_]{1,32}', cm):
                return say('Команда: латиница/цифры/«_», до 32 символов. Например: `price`')
            st.update(s='desc', cmd=cm)
            bf_state(uid, st)
            return say(f'Команда `/{cm}`. Теперь отправьте **короткое описание** (видно в подсказках), или «-» чтобы пропустить.')
        if s == 'desc':
            st.update(s='reply', d='' if text == '-' else text[:100])
            bf_state(uid, st)
            return say('Наконец отправьте **ответ бота** на эту команду. Можно использовать {name} и {username}.')
        if s == 'reply':
            cfg = b['botCfg']
            cfg['commands'] = [c for c in cfg['commands'] if c['cmd'] != st['cmd']] + [{'cmd': st['cmd'], 'desc': st['d'], 'reply': text[:2000]}]
            save()
            return bf_done(uid, b, f"✅ Команда /{st['cmd']} сохранена. Попробуйте написать её своему боту!")
    if a == 'cmd_reply':
        b = bf_bot(uid, st.get('b'))
        if not b or m['type'] != 'text':
            return say('Нужен текст ответа.')
        for c in b['botCfg']['commands']:
            if c['cmd'] == st['cmd']:
                c['reply'] = '' if text == '-' else text[:2000]
        save()
        return bf_done(uid, b)
    bf_state(uid, clear=True)
    say('Что-то пошло не так. Начните с /help')


async def bf_set_webhook(uid, b, url):
    if not await safe_url(url):
        return bot_send(BOTFATHER_ID, uid, '⚠ Адрес должен быть публичным http(s)-URL. Попробуйте ещё раз или /cancel.')
    b['botCfg']['webhook'] = url[:500]
    save()
    bf_done(uid, b, f'✅ Webhook установлен: {url[:100]}\nТеперь все сообщения боту приходят на ваш сервер.')


def PUBLIC_URL():
    return (os.environ.get('PUBLIC_URL') or os.environ.get('RENDER_EXTERNAL_URL') or '').rstrip('/')


def botfather_cb(uid, m, data):
    parts = data.split(':')
    k = parts[0]
    edit = lambda t, mk=None: bot_edit(m, t, mk)
    if k == 'new':
        bf_state(uid, {'a': 'new_name'})
        return bot_reply(BOTFATHER_ID, uid, 'Как назовём бота? Отправьте **имя**.')
    if k == 'list':
        t, mk = bf_list(uid)
        return edit(t, mk)
    bid = toint(parts[2 if k == 'act' else 1] if len(parts) > (2 if k == 'act' else 1) else '', -1)
    b = bf_bot(uid, bid)
    if not b:
        return cb_answer(uid, 'Бот не найден', True)
    if k == 'mb':
        bf_state(uid, clear=True)
        t, mk = bf_menu(b)
        return edit(t, mk)
    if k == 'act':
        f = parts[1]
        if f not in BF_PROMPTS:
            return
        bf_state(uid, {'a': 'set', 'f': f, 'b': bid})
        return bot_reply(BOTFATHER_ID, uid, f"**@{b['username']}**\n" + BF_PROMPTS[f], [[Bt('✖ Отмена', f'mb:{bid}')]])
    if k == 'cm':
        t, mk = bf_cmds_menu(b)
        return edit(t, mk)
    if k == 'ca':
        bf_state(uid, {'a': 'cmd_add', 'b': bid, 's': 'cmd'})
        return bot_reply(BOTFATHER_ID, uid, 'Отправьте **название команды** (без «/»), например: `price`', [[Bt('✖ Отмена', f'cm:{bid}')]])
    if k == 'cs':
        cm = next((c for c in b['botCfg']['commands'] if c['cmd'] == parts[2]), None)
        if not cm:
            return cb_answer(uid, 'Команда не найдена', True)
        edit(f"⌨ **/{cm['cmd']}**\nОписание: {cm.get('desc') or '—'}\nОтвет: {cm.get('reply') or '— (не задан)'}",
             [[Bt('✏ Изменить ответ', f"cr:{bid}:{cm['cmd']}"), Bt('🗑 Удалить', f"cd:{bid}:{cm['cmd']}")], [Bt('⬅ Команды', f'cm:{bid}')]])
        return
    if k == 'cr':
        bf_state(uid, {'a': 'cmd_reply', 'b': bid, 'cmd': parts[2]})
        return bot_reply(BOTFATHER_ID, uid, f'Отправьте новый **ответ** для /{parts[2]} («-» — очистить).', [[Bt('✖ Отмена', f'cm:{bid}')]])
    if k == 'cd':
        b['botCfg']['commands'] = [c for c in b['botCfg']['commands'] if c['cmd'] != parts[2]]
        save()
        t, mk = bf_cmds_menu(b)
        cb_answer(uid, 'Удалено')
        return edit(t, mk)
    if k == 'tok':
        return bot_reply(BOTFATHER_ID, uid, f"🔑 Токен @{b['username']}:\n```{b['botCfg']['token']}```\nНе публикуйте его. Если токен утёк — /revoke.", [[Bt('♻ Перевыпустить', f'rev:{bid}'), Bt('⬅ Меню', f'mb:{bid}')]])
    if k == 'rev':
        if len(parts) > 2 and parts[2] == 'yes':
            bot_tokens.pop(b['botCfg'].get('token'), None)
            token = f'{bid}:{secrets.token_urlsafe(24)}'
            b['botCfg']['token'] = token
            bot_tokens[token] = bid
            save()
            return edit(f"♻ Новый токен @{b['username']}:\n```{token}```\nСтарый токен больше не работает.", [[Bt('⬅ Меню', f'mb:{bid}')]])
        return edit(f"Перевыпустить токен @{b['username']}? Старый перестанет работать.", [[Bt('✔ Да, перевыпустить', f'rev:{bid}:yes'), Bt('✖ Нет', f'mb:{bid}')]])
    if k == 'del':
        if len(parts) > 2 and parts[2] == 'yes':
            delete_bot(b)
            cb_answer(uid, 'Бот удалён')
            return edit('🗑 Бот удалён.', [[Bt('📋 Мои боты', 'list')]])
        return edit(f"Удалить бота @{b['username']}? Это нельзя отменить.", [[Bt('🗑 Да, удалить', f'del:{bid}:yes'), Bt('✖ Нет', f'mb:{bid}')]])


# ───────────────────────── пользовательские боты: встроенные ответы + Bot API ─────────────────────────
bot_updates: dict = {}


def api_user(u):
    return {'id': u['id'], 'is_bot': bool(u.get('bot')), 'first_name': u.get('name', ''), 'last_name': u.get('lastName', ''), 'username': u.get('username', '')}


def api_msg(m, user_id):
    u = U(user_id)
    d = {'message_id': m['id'], 'from': api_user(U(m['from'])), 'chat': {'id': user_id, 'type': 'private', 'first_name': (u or {}).get('name', ''), 'username': (u or {}).get('username', '')},
         'date': m['ts'] // 1000, 'text': m.get('text', '')}
    if m.get('replyTo'):
        cid = m['chatId']
        r = next((x for x in chat_msgs(cid) if x['id'] == m['replyTo']), None)
        if r:
            d['reply_to_message'] = {'message_id': r['id'], 'from': api_user(U(r['from'])), 'text': r.get('text', '')}
    if m.get('media'):
        d['file'] = {'type': m['type'], 'url': PUBLIC_URL() + m['media']['url'], 'name': m['media'].get('name')}
    if m.get('loc'):
        d['location'] = {'latitude': m['loc']['lat'], 'longitude': m['loc']['lng']}
    if m['type'] == 'text' and (m.get('text') or '').startswith('/'):
        d['entities'] = [{'type': 'bot_command', 'offset': 0, 'length': len((m['text'].split() or [''])[0])}]
    return d


def bot_push_update(bot, kind, payload):
    st = bot_updates.setdefault(bot['id'], {'q': [], 'n': 0, 'ev': asyncio.Event(), 'polled': 0})
    st['n'] += 1
    upd = {'update_id': st['n'], kind: payload}
    st['q'].append(upd)
    del st['q'][:-200]
    st['ev'].set()
    wh = (bot.get('botCfg') or {}).get('webhook')
    if wh:
        asyncio.ensure_future(deliver_webhook(wh, upd))


async def safe_url(url: str) -> bool:
    try:
        p = urlparse(url)
        if p.scheme not in ('http', 'https') or not p.hostname:
            return False
        if os.environ.get('ALLOW_PRIVATE_WEBHOOKS') == '1':
            return True
        infos = await asyncio.get_event_loop().getaddrinfo(p.hostname, p.port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM)
        for i in infos:
            ip = ipaddress.ip_address(i[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                return False
        return True
    except Exception:
        return False


async def deliver_webhook(url, upd):
    try:
        if not await safe_url(url):
            return
        async with aiohttp.ClientSession() as cs:
            await cs.post(url, json=upd, timeout=aiohttp.ClientTimeout(total=10), allow_redirects=False)
    except Exception as e:
        log('webhook error', url, e)


def fill(t, u):
    return (t or '').replace('{name}', u.get('name', '')).replace('{username}', '@' + (u.get('username') or '')).replace('{id}', str(u['id']))


def custom_bot_msg(chat, m, bot):
    uid = m['from']
    u = U(uid)
    cfg = bot.setdefault('botCfg', {'commands': []})
    bot_push_update(bot, 'message', api_msg(m, uid))
    st = bot_updates.get(bot['id'])
    if cfg.get('webhook') or (st and now() - st['polled'] < 60_000):
        return                      # логику ведёт внешний сервер (webhook / getUpdates)
    text = (m.get('text') or '').strip()
    if text.startswith('/'):
        name = text.split()[0][1:].lower().split('@')[0]
        c = next((c for c in cfg.get('commands', []) if c['cmd'] == name), None)
        if c and c.get('reply'):
            return bot_reply(bot['id'], uid, fill(c['reply'], u))
        if name == 'start':
            g = cfg.get('greeting') or (bot.get('botDesc') and f"{bot['botDesc']}") or f"Привет, {u['name']}! Я {bot['name']}."
            return bot_reply(bot['id'], uid, fill(g, u))
        if name == 'help' and cfg.get('commands'):
            return bot_reply(bot['id'], uid, 'Мои команды:\n' + '\n'.join(f"/{c['cmd']} — {c.get('desc') or ''}" for c in cfg['commands']))
    if cfg.get('default'):
        return bot_reply(bot['id'], uid, fill(cfg['default'], u))


BOT_API_METHODS = {}


def bot_method(name):
    def d(fn):
        BOT_API_METHODS[name.lower()] = fn
        return fn
    return d


class BotApiError(Exception):
    def __init__(self, code, desc):
        self.code, self.desc = code, desc


def _target_user(bot, p):
    uid = toint(p.get('chat_id'), -1)
    u = U(uid)
    if not u or u.get('bot'):
        raise BotApiError(400, 'Bad Request: chat not found')
    cid = f'p:{min(uid, bot["id"])}:{max(uid, bot["id"])}'
    if cid not in db['chats']:
        raise BotApiError(403, 'Forbidden: bot can\'t initiate conversation with a user')
    if bot['id'] in (u.get('blocked') or []):
        raise BotApiError(403, 'Forbidden: bot was blocked by the user')
    return u


@bot_method('getMe')
async def bm_getme(bot, p):
    return {**api_user(bot), 'can_join_groups': False, 'description': bot.get('botDesc', '')}


@bot_method('sendMessage')
async def bm_send(bot, p):
    u = _target_user(bot, p)
    text = str(p.get('text') or '')
    if not text.strip():
        raise BotApiError(400, 'Bad Request: message text is empty')
    mk = clean_markup(p.get('reply_markup')) if p.get('reply_markup') else None
    m = bot_send(bot['id'], u['id'], text, mk, toint(p.get('reply_to_message_id'), 0) or None, bool(p.get('disable_notification')))
    return api_msg(m, u['id'])


@bot_method('editMessageText')
async def bm_edit(bot, p):
    u = _target_user(bot, p)
    mid = toint(p.get('message_id'), -1)
    cid = msg_index.get(mid)
    m = next((x for x in chat_msgs(cid) if x['id'] == mid), None) if cid else None
    if not m or m['from'] != bot['id'] or cid != private_chat(bot['id'], u['id'])['id']:
        raise BotApiError(400, 'Bad Request: message to edit not found')
    mk = clean_markup(p.get('reply_markup')) if 'reply_markup' in p else False
    bot_edit(m, str(p.get('text') or m['text']), mk if mk is not None else None, mark=True)
    return api_msg(m, u['id'])


@bot_method('deleteMessage')
async def bm_delete(bot, p):
    u = _target_user(bot, p)
    mid = toint(p.get('message_id'), -1)
    ch = private_chat(bot['id'], u['id'])
    arr = chat_msgs(ch['id'])
    m = next((x for x in arr if x['id'] == mid and x['from'] == bot['id']), None)
    if not m:
        raise BotApiError(400, 'Bad Request: message to delete not found')
    arr.remove(m)
    msg_index.pop(mid, None)
    ch['pins'] = [x for x in ch.get('pins', []) if x != mid]
    broadcast_chat(ch, lambda x: emit_to(x, 'msg:delete', {'chatId': ch['id'], 'ids': [mid], 'chat': chat_view(ch, x)}))
    save()
    return True


@bot_method('sendChatAction')
async def bm_action(bot, p):
    u = _target_user(bot, p)
    ch = private_chat(bot['id'], u['id'])
    emit_to(u['id'], 'typing', {'chatId': ch['id'], 'userId': bot['id'], 'action': 'typing'})
    return True


@bot_method('answerCallbackQuery')
async def bm_answer_cb(bot, p):
    q = cb_queries.pop(str(p.get('callback_query_id')), None)
    if not q:
        raise BotApiError(400, 'Bad Request: query is too old or invalid')
    cb_answer(q['uid'], str(p.get('text') or '')[:200], bool(p.get('show_alert')))
    return True


@bot_method('getUpdates')
async def bm_updates(bot, p):
    if (bot.get('botCfg') or {}).get('webhook'):
        raise BotApiError(409, 'Conflict: can\'t use getUpdates method while webhook is active')
    st = bot_updates.setdefault(bot['id'], {'q': [], 'n': 0, 'ev': asyncio.Event(), 'polled': 0})
    st['polled'] = now()
    off = toint(p.get('offset'), 0)
    if off:
        st['q'] = [u for u in st['q'] if u['update_id'] >= off]
    timeout = min(toint(p.get('timeout'), 0), 25)
    if not st['q'] and timeout > 0:
        st['ev'].clear()
        try:
            await asyncio.wait_for(st['ev'].wait(), timeout)
        except asyncio.TimeoutError:
            pass
        st['polled'] = now()
    return st['q'][:max(1, min(toint(p.get('limit'), 100), 100))]


@bot_method('setWebhook')
async def bm_setwebhook(bot, p):
    url = str(p.get('url') or '')
    if not url:
        bot['botCfg']['webhook'] = ''
    else:
        if not await safe_url(url):
            raise BotApiError(400, 'Bad Request: bad webhook: URL must be a public http(s) address')
        bot['botCfg']['webhook'] = url[:500]
    save()
    return True


@bot_method('deleteWebhook')
async def bm_delwebhook(bot, p):
    bot['botCfg']['webhook'] = ''
    save()
    return True


@bot_method('getWebhookInfo')
async def bm_whinfo(bot, p):
    st = bot_updates.get(bot['id'])
    return {'url': bot['botCfg'].get('webhook', ''), 'pending_update_count': len(st['q']) if st else 0}


@bot_method('setMyCommands')
async def bm_setcmds(bot, p):
    cmds = p.get('commands')
    if isinstance(cmds, str):
        try:
            cmds = json.loads(cmds)
        except Exception:
            cmds = None
    if not isinstance(cmds, list):
        raise BotApiError(400, 'Bad Request: commands must be an array')
    old = {c['cmd']: c for c in bot['botCfg'].get('commands', [])}
    new = []
    for c in cmds[:50]:
        name = str((c or {}).get('command', '')).lstrip('/').lower()
        if re.fullmatch(r'[a-z0-9_]{1,32}', name):
            new.append({'cmd': name, 'desc': str(c.get('description', ''))[:100], 'reply': old.get(name, {}).get('reply', '')})
    bot['botCfg']['commands'] = new
    save()
    return True


@bot_method('getMyCommands')
async def bm_getcmds(bot, p):
    return [{'command': c['cmd'], 'description': c.get('desc', '')} for c in bot['botCfg'].get('commands', [])]


@bot_method('setMyName')
async def bm_setname(bot, p):
    n = str(p.get('name') or '').strip()[:40]
    if n:
        bot['name'] = n
        save()
    return True


@bot_method('setMyDescription')
async def bm_setdesc(bot, p):
    bot['botDesc'] = str(p.get('description') or '')[:512]
    save()
    return True


@bot_method('setMyShortDescription')
async def bm_setabout(bot, p):
    bot['bio'] = str(p.get('short_description') or '')[:200]
    save()
    return True


async def bot_api_handler(request: web.Request):
    token = request.match_info['token']
    method = request.match_info['method'].lower()
    p = {}
    for k, v in request.query.items():
        p[k] = v
    if request.method == 'POST' and request.can_read_body:
        try:
            if 'json' in (request.content_type or ''):
                b = await request.json()
                if isinstance(b, dict):
                    p.update(b)
            else:
                p.update({k: v for k, v in (await request.post()).items() if isinstance(v, str)})
        except Exception:
            pass

    def out(ok, **kw):
        return web.json_response({'ok': ok, **kw}, status=kw.get('error_code', 200) if not ok else 200, dumps=lambda o: json.dumps(o, ensure_ascii=False))
    bid = bot_tokens.get(token)
    bot = U(bid) if bid else None
    if not bot or bot.get('deleted'):
        if limited('bt:' + (request.remote or ''), 30, 60e3):
            return out(False, error_code=429, description='Too Many Requests')
        return out(False, error_code=401, description='Unauthorized')
    fn = BOT_API_METHODS.get(method)
    if not fn:
        return out(False, error_code=404, description='Not Found: method not found')
    if limited(f'ba:{bid}', 600, 60e3):
        return out(False, error_code=429, description='Too Many Requests: retry later')
    try:
        return out(True, result=await fn(bot, p))
    except BotApiError as e:
        return out(False, error_code=e.code, description=e.desc)
    except Exception as e:
        log('bot api error', e)
        return out(False, error_code=500, description='Internal Server Error')


# ───────────────────────── background jobs / app ─────────────────────────
async def background():
    n = 0
    while True:
        await asyncio.sleep(4)
        n += 1
        try:
            t = now()
            due = [s for s in db['scheduled'] if s['at'] <= t]
            if due:
                db['scheduled'] = [s for s in db['scheduled'] if s['at'] > t]
                for s in due:
                    ch = C(s['chatId'])
                    if ch and is_member(ch, s['from']):
                        push_message(ch, s['from'], s['data'])
                save()
            if n % 8 == 0:
                for k, q in list(qr_tokens.items()):
                    if q['exp'] < t: qr_tokens.pop(k, None)
                for k, v in list(codes.items()):
                    if v['exp'] < t: codes.pop(k, None)
            if n % 150 == 0:
                for k, a in list(hits.items()):
                    if not any(t - x < 3600e3 for x in a): hits.pop(k, None)
        except Exception as e:
            log('background error', e)


def _stdin_console(loop):
    """Консоль владельца прямо в окне, где запущен сервер: пишите verify @ник, geo @ник, stats, help…"""
    import threading

    def work():
        print('  ► Консоль владельца активна. Введите help (список команд), например: verify @ник  |  geo @ник\n', flush=True)
        while True:
            try:
                line = sys.stdin.readline()
            except Exception:
                return
            if not line:
                return            # stdin закрыт (Render, фон) — консоль отключаем
            line = line.strip()
            if not line:
                continue
            fut = asyncio.run_coroutine_threadsafe(_stdin_exec(line), loop)
            try:
                print(fut.result(60), flush=True)
            except Exception as e:
                print(f'Ошибка: {e}', flush=True)
    threading.Thread(target=work, daemon=True).start()


async def _stdin_exec(line):
    low = line.lstrip('/').split(None, 1)
    if low and low[0].lower() == 'export':
        name = low[1].strip() if len(low) > 1 else time.strftime('geometric-backup-%Y%m%d-%H%M.zip')
        info = await build_export(name)
        return f'✔ Архив сохранён: {Path(name).resolve()}  ({info})'
    out = exec_cmd(line, None, 'owner')
    await persist()
    return out


async def on_startup(app):
    global _q
    _q = asyncio.Queue()
    await load_db()
    if (sys.stdin and sys.stdin.isatty() and os.environ.get('NO_STDIN_CONSOLE') != '1') or os.environ.get('GM_STDIN') == '1':
        _stdin_console(asyncio.get_running_loop())
    app['tasks'] = [asyncio.create_task(_emitter()), asyncio.create_task(background())]
    log(f'\n  {APP_NAME} (Python) запущен на порту {PORT}')
    log(f"  Хранилище: {'PostgreSQL' if pool else 'файл ' + str(DB_FILE)}")
    log(f"  Почта: {mail_provider() or 'НЕ НАСТРОЕНА (dev-режим: код показывается на экране и в логах)'}\n")


async def on_cleanup(app):
    global _save_handle
    if _save_handle:
        _save_handle.cancel()
        _save_handle = None
    await persist()
    for t in app.get('tasks', []):
        t.cancel()
    if pool:
        await pool.close()


def make_app():
    app = web.Application(middlewares=[security], client_max_size=64 * 1024 * 1024)
    sio.attach(app)
    for method, path, fn, need_auth in routes_list:
        app.router.add_route(method, path, make_handler(fn, need_auth))
    app.router.add_get('/healthz', lambda r: web.Response(text='ok'))
    app.router.add_get('/media/{id}', media_get)
    app.router.add_route('*', '/bot{token}/{method}', bot_api_handler)
    app.router.add_get('/admin', lambda r: web.FileResponse(PUBLIC / 'admin.html', headers={'Cache-Control': 'no-cache'}))
    app.router.add_get('/', static_get)
    app.router.add_get('/{tail:.*}', static_get)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == '__main__':
    web.run_app(make_app(), host='0.0.0.0', port=PORT, print=None, access_log=None)
