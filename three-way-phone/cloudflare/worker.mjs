import { DurableObject } from 'cloudflare:workers';
import { assets } from './assets.mjs';

const PROTOCOL = 'three-way-host/1';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { ...security, 'Content-Type': 'application/json; charset=utf-8', ...extra },
});
async function matchesHash(value, expected, pattern) {
  if (typeof value !== 'string' || !pattern.test(value) || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const target = Uint8Array.from(expected.match(/../g), x => parseInt(x, 16));
  return crypto.subtle.timingSafeEqual(digest, target);
}
const matchesKey = (key, expected) => matchesHash(key, expected, /^[A-Za-z0-9_-]{43}$/);
const matchesPin = (pin, expected) => matchesHash(pin, expected, /^\d{6}$/);
function bearer(request) { return request.headers.get('authorization')?.replace(/^Bearer /, '') || ''; }
function browserSession(request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)tw_session=([0-9]{10,13}\.[A-Za-z0-9_-]{43})(?:;|$)/)?.[1] || ''; }
function base64URL(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function signingKey(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const padded = secret.replaceAll('-', '+').replaceAll('_', '/') + '=';
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
async function sessionSignature(expires, room, secret) {
  const bytes = signingKey(secret); if (!bytes) return '';
  const key = await crypto.subtle.importKey('raw', bytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return base64URL(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${expires}.${room}`))));
}
async function validSession(value, room, secret) {
  const [rawExpires, supplied, extra] = value.split('.');
  const expires = Number(rawExpires), now = Math.floor(Date.now() / 1000);
  if (extra !== undefined || !Number.isSafeInteger(expires) || expires <= now || expires > now + 28_860 || !/^[A-Za-z0-9_-]{43}$/.test(supplied || '')) return false;
  const expected = await sessionSignature(expires, room, secret);
  return expected !== '' && crypto.subtle.timingSafeEqual(new TextEncoder().encode(supplied), new TextEncoder().encode(expected));
}
async function readJSON(request, max = 65536) {
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

function base64UTF8(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data)); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function backupToGitHub(history, env) {
  if (!env.GITHUB_TOKEN) return json({error:'Private GitHub backup is not configured on this Worker.'},503);
  const repository = env.GITHUB_REPOSITORY || 'Peachview747/Three-Way-Chat-App-Data';
  const path = env.GITHUB_BACKUP_PATH || 'conversations/ai-room-conversations.json';
  const endpoint = `https://api.github.com/repos/${repository}/contents/${path}`;
  const headers = {'Authorization':`Bearer ${env.GITHUB_TOKEN}`,'Accept':'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','User-Agent':'AI-Room-Worker'};
  const current = await fetch(endpoint,{headers}); let sha;
  if (current.ok) sha = (await current.json()).sha;
  else if (current.status !== 404) return json({error:'GitHub backup could not read the private data file.'},502);
  const body = {message:'Back up AI Room conversations',content:base64UTF8(history),...(sha?{sha}:{})};
  const saved = await fetch(endpoint,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!saved.ok) return json({error:'GitHub rejected the private conversation backup.'},502);
  return json({ok:true});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ app: 'three-way-phone-link', protocol: PROTOCOL });
    const asset = assets[url.pathname === '/index.html' ? '/' : url.pathname];
    if (asset && ['GET', 'HEAD'].includes(request.method)) {
      const [mime, body] = asset;
      return new Response(request.method === 'HEAD' ? null : body, { headers: { ...security, 'Content-Type': mime } });
    }
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Open AI Room in this browser.' }, 403);
      let body; try { body = await readJSON(request, 1024); } catch { return json({ error: 'Enter a six-digit PIN.' }, 400); }
      if (typeof body.pin !== 'string' || !/^\d{6}$/.test(body.pin)) return json({ error: 'Enter a six-digit PIN.' }, 400);
      const room = env.PHONE_ROOM.getByName(env.ROOM_ID);
      const checked = await room.fetch('https://ai-room.internal/__session', {
        method:'POST', headers:{'Content-Type':'application/json','X-Client-IP':request.headers.get('CF-Connecting-IP') || 'unknown'},
        body:JSON.stringify({pin:body.pin}),
      });
      if (!checked.ok) return checked;
      const expires = Math.floor(Date.now() / 1000) + 28_800;
      const signature = await sessionSignature(expires, env.ROOM_ID, env.SESSION_SIGNING_KEY);
      if (!signature) return json({error:'AI Room sign-in is not configured.'},503);
      return json({ ok: true }, 200, { 'Set-Cookie': `tw_session=${expires}.${signature}; Path=/api; Max-Age=28800; HttpOnly; Secure; SameSite=Strict` });
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Request rejected.' }, 403);
      return json({ ok: true }, 200, { 'Set-Cookie': 'tw_session=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
    }
    if (url.pathname === '/api/backup' && request.method === 'POST') {
      if (!await matchesKey(bearer(request), env.PHONE_KEY_HASH)) return json({error:'Host authorization failed.'},401);
      let history; try { history = await readJSON(request,750_000); } catch { return json({error:'Invalid conversation backup.'},400); }
      if (!Array.isArray(history.rooms) || !Array.isArray(history.messages)) return json({error:'Invalid conversation backup.'},400);
      return backupToGitHub(history,env);
    }
    const routes = {phone:'GET',state:'GET',export:'GET',send:'POST',new:'POST',refresh:'POST',login:'POST',stop:'POST',voice:'POST',speak:'POST',hear:'POST'};
    const action = url.pathname.slice('/api/'.length);
    if (!url.pathname.startsWith('/api/') || !Object.hasOwn(routes, action)) return json({error:'Not found.'},404);
    const phone = action === 'phone';
    const authorized = phone
      ? await matchesKey(bearer(request), env.PHONE_KEY_HASH)
      : await validSession(browserSession(request), env.ROOM_ID, env.SESSION_SIGNING_KEY);
    if (!authorized) return json({ error: 'Enter your AI Room PIN to connect to the Raspberry Pi.' }, 401);
    if (request.method !== routes[action]) return json({error:'Method not allowed.'},405);
    if (phone) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({error:'WebSocket required.'},426);
      if (request.headers.has('origin') && request.headers.get('origin') !== url.origin) return json({error:'Request rejected.'},403);
    } else if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return json({error:'Request rejected.'},403);
    // The one provisioned room has separate host and browser credentials.
    // No arbitrary proxy destinations, commands, or provider requests exist.
    return env.PHONE_ROOM.getByName(env.ROOM_ID).fetch(request);
  },
};

export class PhoneRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Pending fetches keep the instance awake until the bounded request completes.
    // Conversations are owned by the Raspberry Pi and never written to DO storage.
    this.pending = new Map();
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
  finish(id, reply) {
    const pending = this.pending.get(id); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(reply);
  }
  disconnected(ws) {
    for (const [id, pending] of this.pending) if (pending.ws === ws) {
      this.finish(id, json({error:'The Raspberry Pi host disconnected. Check its AI Room service.'},503));
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__session' && request.method === 'POST') {
      const client = request.headers.get('X-Client-IP') || 'unknown';
      const clientDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client));
      const attemptKey = `pin:${base64URL(new Uint8Array(clientDigest))}`;
      const now = Date.now(), windowMs = 5 * 60_000, blockMs = 15 * 60_000;
      let attempt = await this.ctx.storage.get(attemptKey) || {started:now, failures:0, blockedUntil:0};
      if (attempt.blockedUntil > now) return json({error:'Too many PIN attempts. Try again in 15 minutes.'},429,{'Retry-After':'900'});
      if (now - attempt.started > windowMs) attempt = {started:now, failures:0, blockedUntil:0};
      let body; try { body = await readJSON(request, 1024); } catch { return json({error:'Enter a six-digit PIN.'},400); }
      if (await matchesPin(body.pin, this.env.PAIRING_PIN_HASH)) {
        await this.ctx.storage.delete(attemptKey);
        return json({ok:true});
      }
      attempt.failures += 1;
      if (attempt.failures >= 5) attempt.blockedUntil = now + blockMs;
      await this.ctx.storage.put(attemptKey, attempt);
      return json(
        {error:attempt.blockedUntil ? 'Too many PIN attempts. Try again in 15 minutes.' : 'That PIN did not match.'},
        attempt.blockedUntil ? 429 : 401,
        attempt.blockedUntil ? {'Retry-After':'900'} : {},
      );
    }
    if (url.pathname === '/api/phone') {
      for (const old of this.phones()) {
        try { old.send(JSON.stringify({type:'replaced'})); } catch {}
        this.disconnected(old); old.close(4001,'Another host connected');
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server,['phone']);
      server.serializeAttachment({acceptedAt:Date.now(),ready:false});
      server.send(JSON.stringify({type:'hello',protocol:PROTOCOL}));
      return new Response(null,{status:101,webSocket:client});
    }
    const ws = this.phones().find(phone => phone.deserializeAttachment()?.ready);
    if (!ws) return json({error:'The Raspberry Pi host is offline. Check the ai-room service.'},503);
    if (this.pending.size >= 8) return json({error:'The Raspberry Pi host is busy. Retry in a moment.'},429);
    let body;
    // A voice turn carries recorded audio (a few hundred KB at most).
    try { body = request.method === 'GET' ? {room:url.searchParams.get('room') || ''} : await readJSON(request, url.pathname === '/api/voice' || url.pathname === '/api/hear' ? 3_000_000 : 65536); }
    catch { return json({error:'Invalid room request.'},400); }
    if (this.pending.size >= 8) return json({error:'The Raspberry Pi host is busy. Retry in a moment.'},429);
    // The host receives a named room operation, never an arbitrary URL or command.
    const action = url.pathname.slice('/api/'.length), id = crypto.randomUUID();
    return new Promise(resolve => {
      const timeout = action === 'send' || action === 'voice' ? 180_000 : action === 'speak' || action === 'hear' ? 30_000 : 15_000;
      const timer = setTimeout(() => this.finish(id,json({error:'The Raspberry Pi host did not answer. Check the ai-room service.'},504)),timeout);
      this.pending.set(id,{resolve,timer,ws});
      try { ws.send(JSON.stringify({type:'request',id,action,body})); }
      catch { this.finish(id,json({error:'The Raspberry Pi host disconnected.'},503)); }
    });
  }
  webSocketMessage(ws, raw) {
    if (!this.phones().includes(ws)) return;
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4_000_000) { this.disconnected(ws); ws.close(1009,'Response too large'); return; }
    try {
      const body = JSON.parse(raw);
      if (body.type === 'ready' && body.protocol === PROTOCOL) {
        ws.serializeAttachment({...ws.deserializeAttachment(),ready:true});
        ws.send(JSON.stringify({type:'connected',protocol:PROTOCOL})); return;
      }
      if (body.type !== 'response' || !ID.test(body.id || '') || ![200,400,404,500,503].includes(body.status) || !body.body || typeof body.body !== 'object' || Array.isArray(body.body)) throw new Error('Invalid response.');
      // A replacement host cannot complete the previous host’s pending request.
      if (this.pending.get(body.id)?.ws === ws) this.finish(body.id,json(body.body,body.status));
    } catch { this.disconnected(ws); ws.close(1008,'Invalid host response'); }
  }
  webSocketClose(ws, code) { this.disconnected(ws); try { ws.close(code === 1006 ? 1000 : code,'Disconnected'); } catch {} }
  webSocketError(ws) { this.disconnected(ws); try { ws.close(1011,'Reconnect'); } catch {} }
}
