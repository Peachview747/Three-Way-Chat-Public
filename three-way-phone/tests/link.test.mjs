import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ORIGIN = 'https://three-way-chat.jcruzhoovertesla.workers.dev';
const key = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function fixture(t) {
  const phoneKey = key(), browserKey = key(), room = randomUUID();
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ['worker.mjs', 'assets.mjs'].map(name => ({type:'ESModule',path:fileURLToPath(new URL('../cloudflare/' + name, import.meta.url))})),
    // The current packaged workerd supports dates through October 8.
    // Production is also checked separately against Cloudflare's live runtime.
    compatibilityDate: '2026-10-08',
    bindings: { PHONE_KEY_HASH: hash(phoneKey), BROWSER_KEY_HASH: hash(browserKey), ROOM_ID: room },
    durableObjects: { PHONE_ROOM: {className:'PhoneRoom',useSQLite:true} },
    outboundService: () => { throw new Error('No external requests are allowed in connection tests.'); },
  }));
  t.after(() => mf.dispose());
  const fetch = (path, init) => mf.dispatchFetch(ORIGIN + path, init);
  const session = await fetch('/api/session', {method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({room,key:browserKey})});
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const state = async () => (await fetch('/api/state', {headers:{cookie}})).json();
  const send = (text, id = randomUUID(), origin = ORIGIN) => fetch('/api/message', {method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({text,id})});
  const connect = async (supplied = phoneKey) => {
    const response = await fetch('/api/phone', {headers:{upgrade:'websocket',authorization:'Bearer ' + supplied}});
    const socket = response.webSocket; const events = [];
    if (socket) {
      socket.addEventListener('message', event => { events.push(event.data === 'pong' ? 'pong' : JSON.parse(event.data)); });
      socket.accept(); t.after(() => { try {socket.close();} catch {} });
    }
    const wait = async predicate => {
      for (let i = 0; i < 200; i++) { const found = events.find(predicate); if (found) return found; await tick(); }
      throw new Error('No matching phone acknowledgment.');
    };
    return {response,socket,events,wait};
  };
  return {mf,fetch,phoneKey,browserKey,room,cookie,state,send,connect};
}

test('pairing and phone authentication cannot be exchanged; origin and methods are enforced', async t => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/state')).status, 401);
  assert.equal((await f.connect(f.browserKey)).response.status, 401);
  assert.equal((await f.fetch('/api/session',{method:'POST',headers:{origin:'https://other.example','content-type':'application/json'},body:JSON.stringify({room:f.room,key:f.browserKey})})).status,403);
  assert.equal((await f.fetch('/api/session',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({room:f.room,key:f.phoneKey})})).status,401);
  assert.equal((await f.send('blocked',randomUUID(),'https://other.example')).status,403);
  assert.equal((await f.fetch('/api/message',{headers:{cookie:f.cookie}})).status,405);
  assert.equal((await f.fetch('/api/reset',{method:'DELETE',headers:{cookie:f.cookie}})).status,401);
});

test('phone handshake, heartbeat, and real two-way messages share one canonical log', async t => {
  const f = await fixture(t);
  assert.equal((await f.state()).connected,false);
  assert.equal((await f.send('offline')).status,503);
  const p = await f.connect(); assert.equal(p.response.status,101);
  const hello = await p.wait(e => e.type === 'state');
  assert.equal(hello.protocol,'three-way-link/1'); assert.equal(hello.connected,true);
  p.socket.send('ping'); await p.wait(e => e === 'pong');
  const id = randomUUID();
  p.socket.send(JSON.stringify({type:'message',id,text:'Hello from phone'}));
  await p.wait(e => e.messages?.some(m => m.id === id));
  const response = await f.send('Hello from browser'); assert.equal(response.status,200);
  const saved = await response.json(); await p.wait(e => e.messages?.some(m => m.id === saved.message.id));
  assert.deepEqual((await f.state()).messages.map(m => [m.source,m.text]),[['iphone','Hello from phone'],['browser','Hello from browser']]);
  p.socket.close();
  for(let i=0;i<100&&(await f.state()).connected;i++) await tick();
  assert.equal((await f.state()).connected,false);
});

test('explicit retries deduplicate and a second phone replaces the first', async t => {
  const f = await fixture(t); const first = await f.connect(); await first.wait(e => e.type === 'state');
  const id = randomUUID(); assert.equal((await f.send('once',id)).status,200); assert.equal((await f.send('once',id)).status,200);
  assert.equal((await f.send('changed',id)).status,400); assert.equal((await f.state()).messages.length,1);
  const second = await f.connect(); await second.wait(e=>e.type==='state');
  await first.wait(e=>e.type==='replaced');
  first.socket.close();
  second.socket.send(JSON.stringify({type:'message',id:randomUUID(),text:'replacement phone'}));
  await second.wait(e=>e.messages?.some(m=>m.text==='replacement phone'));
});

test('malformed and oversized input is rejected, and concurrent writes retain the last 100', async t => {
  const f=await fixture(t); const p=await f.connect(); await p.wait(e=>e.type==='state');
  assert.equal((await f.send('x'.repeat(2001))).status,400);
  assert.equal((await f.send('x','not-a-uuid')).status,400);
  const replies=await Promise.all(Array.from({length:105},(_,i)=>f.send('Message '+i)));
  assert.ok(replies.every(r=>r.status===200));
  const state=await f.state(); assert.equal(state.messages.length,100); assert.equal(new Set(state.messages.map(m=>m.id)).size,100);
  const after=await f.fetch('/api/reset',{method:'DELETE',headers:{authorization:'Bearer '+f.phoneKey}}); assert.equal(after.status,200);
  assert.equal((await f.state()).messages.length,0);
});

test('public web assets do not contain keys, unsafe HTML rendering, or model endpoints', async t => {
  const f=await fixture(t);
  const html=await (await f.fetch('/')).text(), js=await (await f.fetch('/app.js')).text();
  assert.ok(html.includes('GPT and Claude connections come later'));
  assert.ok(!html.includes(f.phoneKey)&&!js.includes(f.browserKey));
  assert.ok(!js.includes('innerHTML')&&!js.includes('backend-api')&&!js.includes('api.anthropic'));
  const paired=await f.fetch('/api/logout',{method:'POST',headers:{origin:ORIGIN,cookie:f.cookie,'content-type':'application/json'},body:'{}'});
  assert.ok(paired.headers.get('set-cookie').includes('Max-Age=0'));
});
