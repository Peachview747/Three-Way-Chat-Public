import { DurableObject } from 'cloudflare:workers';
import { assets } from './assets.mjs';

const PROTOCOL = 'three-way-link/1';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
async function matches(key, expected) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const target = Uint8Array.from(expected.match(/../g), x => parseInt(x, 16));
  return crypto.subtle.timingSafeEqual(digest, target);
}
function bearer(request) { return request.headers.get('authorization')?.replace(/^Bearer /, '') || ''; }
function browserKey(request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)tw_link=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1] || ''; }
async function readJSON(request, max = 8192) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Use JSON.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing message.');
  let bytes = 0; const chunks = [];
  while (true) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > max) { await reader.cancel(); throw new Error('Message is too large.'); }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid message.');
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ app: 'three-way-phone-link', protocol: PROTOCOL });
    if (assets[url.pathname] && ['GET', 'HEAD'].includes(request.method)) {
      const [mime, body] = assets[url.pathname];
      return new Response(request.method === 'HEAD' ? null : body, { headers: { ...security, 'Content-Type': mime } });
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Open the pairing link in this browser.' }, 403);
      let body; try { body = await readJSON(request, 1024); } catch { return json({ error: 'Invalid pairing code.' }, 400); }
      if (body.room !== env.ROOM_ID || !await matches(body.key, env.BROWSER_KEY_HASH)) return json({ error: 'The pairing code did not match.' }, 401);
      return json({ ok: true }, 200, { 'Set-Cookie': `tw_link=${body.key}; Path=/api; Max-Age=28800; HttpOnly; Secure; SameSite=Strict` });
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Request rejected.' }, 403);
      return json({ ok: true }, 200, { 'Set-Cookie': 'tw_link=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
    }
    if (!['/api/phone', '/api/state', '/api/message', '/api/reset'].includes(url.pathname)) return json({ error: 'Not found.' }, 404);
    const phone = ['/api/phone', '/api/reset'].includes(url.pathname);
    if (!await matches(phone ? bearer(request) : browserKey(request), phone ? env.PHONE_KEY_HASH : env.BROWSER_KEY_HASH)) return json({ error: 'Pair this device first.' }, 401);
    if (url.pathname === '/api/phone') {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required.' }, 426);
      if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) return json({ error: 'Request rejected.' }, 403);
    } else if (url.pathname === '/api/message') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Request rejected.' }, 403);
    } else if (url.pathname === '/api/state' && request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    else if (url.pathname === '/api/reset' && request.method !== 'DELETE') return json({ error: 'Method not allowed.' }, 405);
    // The one provisioned room has separate phone and browser credentials.
    // No arbitrary proxy destinations, commands, or provider requests exist.
    return env.PHONE_ROOM.getByName(env.ROOM_ID).fetch(request);
  },
};

export class PhoneRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL)');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  phones() {
    return this.ctx.getWebSockets('phone').filter(ws => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const seen = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? ws.deserializeAttachment()?.acceptedAt ?? 0;
      if (Date.now() - seen <= 60_000) return true;
      try { ws.close(4002, 'Heartbeat expired'); } catch {}
      return false;
    });
  }
  snapshot() {
    return { type: 'state', protocol: PROTOCOL, connected: this.phones().length > 0,
      messages: this.ctx.storage.sql.exec('SELECT id, source, text, created FROM messages ORDER BY seq').toArray() };
  }
  notify() {
    const data = JSON.stringify(this.snapshot());
    for (const ws of this.phones()) { try { ws.send(data); } catch { try { ws.close(1011, 'Reconnect'); } catch {} } }
  }
  append(body, source) {
    if (!ID.test(body.id || '') || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000) throw new Error('Enter a message of 1–2,000 characters.');
    const text = body.text.trim();
    const existing = this.ctx.storage.sql.exec('SELECT id, source, text, created FROM messages WHERE id = ?', body.id).toArray()[0];
    if (existing) {
      if (existing.source !== source || existing.text !== text) throw new Error('This message ID is already in use.');
      return existing;
    }
    const message = { id: body.id, source, text, created: new Date().toISOString() };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO messages (id, source, text, created) VALUES (?, ?, ?, ?)', message.id, source, text, message.created);
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE seq NOT IN (SELECT seq FROM messages ORDER BY seq DESC LIMIT 100)');
    });
    return message;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/phone') {
      for (const old of this.phones()) {
        try { old.send(JSON.stringify({ type: 'replaced' })); } catch {}
        old.close(4001, 'Another phone connected');
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['phone']);
      server.serializeAttachment({ acceptedAt: Date.now() });
      server.send(JSON.stringify(this.snapshot()));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === '/api/state') return json(this.snapshot());
    if (path === '/api/reset') {
      this.ctx.storage.sql.exec('DELETE FROM messages'); this.notify(); return json({ ok: true });
    }
    if (path === '/api/message') {
      let body; try { body = await readJSON(request); } catch { return json({ error: 'Invalid message.' }, 400); }
      // Recheck after reading the body: the phone can disconnect during the read.
      if (!this.phones().length) return json({ error: 'Open Three Way on your iPhone and connect first.' }, 503);
      try { const message = this.append(body, 'browser'); this.notify(); return json({ ok: true, message }); }
      catch (error) { return json({ error: error.message }, 400); }
    }
    return json({ error: 'Not found.' }, 404);
  }
  webSocketMessage(ws, raw) {
    if (!this.phones().includes(ws)) return;
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 8192) { ws.close(1009, 'Message too large'); return; }
    try {
      const body = JSON.parse(raw);
      if (body.type !== 'message') throw new Error('Unknown message type.');
      this.append(body, 'iphone'); this.notify();
    } catch { ws.send(JSON.stringify({ type: 'error', error: 'Message was not saved. Check its length and retry.' })); }
  }
  webSocketClose(ws, code) { try { ws.close(code === 1006 ? 1000 : code, 'Disconnected'); } catch {} }
  webSocketError(ws) { try { ws.close(1011, 'Reconnect'); } catch {} }
}
