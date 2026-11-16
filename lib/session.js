// In-memory sessions. Credentials entered in the panel live only here – never on disk and never in the browser,
// which only holds a random session id in an HttpOnly, SameSite=Strict cookie.
import { randomBytes } from 'node:crypto';

const COOKIE = 'stk_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createSessionStore({ idleMs, maxMs, maxSessions = 500 }) {
  const sessions = new Map();
  const expired = (s, now = Date.now()) => now - s.lastSeen > idleMs || now - s.created > maxMs;

  // Expired sessions (and the credentials in them) are dropped every minute.
  setInterval(() => {
    for (const [id, s] of sessions) if (expired(s)) sessions.delete(id);
  }, 60_000).unref();

  const cookie = (value, maxAge, secure) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  function get(req, res, { secure }) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    let s = id ? sessions.get(id) : null;
    if (s && expired(s)) {
      sessions.delete(s.id);
      s = null;
    }
    if (!s) {
      if (sessions.size >= maxSessions) {
        const oldest = [...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        sessions.delete(oldest.id);
      }
      s = { id: randomBytes(32).toString('base64url'), created: Date.now(), lastSeen: Date.now(), creds: {}, data: {} };
      sessions.set(s.id, s);
      res.setHeader('set-cookie', cookie(s.id, Math.floor(maxMs / 1000), secure));
    }
    s.lastSeen = Date.now();
    return s;
  }

  function destroy(s, res, { secure }) {
    sessions.delete(s.id);
    res.setHeader('set-cookie', cookie('', 0, secure));
  }

  const expiresAt = (s) => new Date(Math.min(s.lastSeen + idleMs, s.created + maxMs)).toISOString();

  return { get, destroy, expiresAt };
}
