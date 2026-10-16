import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ORIGIN = 'https://ai.jch76.workers.dev';
const key = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setTimeout(resolve,15));
async function fixture(t) {
  const phoneKey=key(), pin='392841', sessionKey=key(), room=randomUUID();
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:['worker.mjs','assets.mjs'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../cloudflare/'+name,import.meta.url))})),
    compatibilityDate:'2026-10-08',
    bindings:{PHONE_KEY_HASH:hash(phoneKey),PAIRING_PIN_HASH:hash(pin),SESSION_SIGNING_KEY:sessionKey,ROOM_ID:room},
    durableObjects:{PHONE_ROOM:{className:'PhoneRoom',useSQLite:true}},
    outboundService:()=>{throw new Error('No external requests allowed.');},
  }));
  t.after(()=>mf.dispose());
  const fetch=(path,init)=>mf.dispatchFetch(ORIGIN+path,init);
  const session=await fetch('/api/session',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({pin})});
  assert.equal(session.status,200);
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const post=(action,body={},origin=ORIGIN)=>fetch('/api/'+action,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const state=()=>fetch('/api/state?room=demo',{headers:{cookie}});
  const connect=async (supplied=phoneKey)=>{
    const response=await fetch('/api/phone',{headers:{upgrade:'websocket',authorization:'Bearer '+supplied}});
    const socket=response.webSocket, events=[];
    if(socket){
      socket.addEventListener('message',event=>events.push(event.data==='pong'?'pong':JSON.parse(event.data)));
      socket.accept();t.after(()=>{try{socket.close();}catch{}});
    }
    const wait=async predicate=>{
      for(let i=0;i<200;i++){const found=events.find(predicate);if(found)return found;await tick();}
      throw new Error('No matching host message.');
    };
    const ready=async()=>{
      const hello=await wait(e=>e.type==='hello');assert.equal(hello.protocol,'three-way-host/1');
      socket.send(JSON.stringify({type:'ready',protocol:'three-way-host/1'}));await wait(e=>e.type==='connected');
    };
    return {response,socket,events,wait,ready};
  };
  return{mf,fetch,post,state,connect,phoneKey,pin,room,cookie};
}
test('PIN sessions, separate host credentials, own-origin writes, and fixed routes protect the Pi',async t=>{
  const f=await fixture(t);
  assert.equal((await f.fetch('/api/state')).status,401);
  assert.equal((await f.connect(key())).response.status,401);
  assert.equal((await f.fetch('/api/session',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({pin:'000000'})})).status,401);
  assert.equal((await f.fetch('/api/session',{method:'POST',headers:{origin:'https://other.example','content-type':'application/json'},body:JSON.stringify({pin:f.pin})})).status,403);
  assert.equal((await f.post('send',{},'https://other.example')).status,403);
  assert.equal((await f.fetch('/api/send',{headers:{cookie:f.cookie}})).status,405);
  assert.equal((await f.fetch('/api/proxy?url=http://localhost',{headers:{cookie:f.cookie}})).status,404);
  assert.equal((await f.fetch('/api/reset',{method:'DELETE',headers:{authorization:'Bearer '+f.phoneKey}})).status,404);
  assert.equal((await f.fetch('/api/backup',{method:'POST',headers:{authorization:'Bearer '+key(),'content-type':'application/json'},body:'{}'})).status,401);
});
test('PIN guessing is rate limited per client',async t=>{
  const f=await fixture(t), headers={origin:ORIGIN,'content-type':'application/json','CF-Connecting-IP':'192.0.2.10'};
  for(let i=0;i<4;i++) assert.equal((await f.fetch('/api/session',{method:'POST',headers,body:JSON.stringify({pin:'000000'})})).status,401);
  const blocked=await f.fetch('/api/session',{method:'POST',headers,body:JSON.stringify({pin:'000000'})});
  assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'900');
  assert.equal((await f.fetch('/api/session',{method:'POST',headers,body:JSON.stringify({pin:f.pin})})).status,429);
});
test('phone must complete its handshake; state and prompts are answered by the phone',async t=>{
  const f=await fixture(t);assert.equal((await f.state()).status,503);
  const p=await f.connect();await p.wait(e=>e.type==='hello');assert.equal((await f.state()).status,503);
  await p.ready();p.socket.send('ping');await p.wait(e=>e==='pong');
  const statePromise=f.state();const request=await p.wait(e=>e.action==='state');
  assert.deepEqual(request.body,{room:'demo'});
  const sentinel={rooms:[{id:'phone-only',title:'From phone'}],messages:[],connections:{gpt:{ready:false}}};
  p.socket.send(JSON.stringify({type:'response',id:request.id,status:200,body:sentinel}));
  assert.deepEqual(await(await statePromise).json(),sentinel);
  const prompt={request_id:randomUUID(),room:'phone-only',text:'Private prompt',target:'both',rounds:2};
  const sending=f.post('send',prompt);const write=await p.wait(e=>e.action==='send');
  assert.deepEqual(write.body,prompt);
  p.socket.send(JSON.stringify({type:'response',id:write.id,status:200,body:{ok:true,notice:'Saved on phone'}}));
  assert.equal((await sending).status,200);
  p.socket.close();await tick();assert.equal((await f.state()).status,503);
});
test('replacement cancels pending requests and cannot answer for the old phone',async t=>{
  const f=await fixture(t),first=await f.connect();await first.ready();
  const pending=f.state();const request=await first.wait(e=>e.action==='state');
  const second=await f.connect();await second.ready();await first.wait(e=>e.type==='replaced');
  assert.equal((await pending).status,503);
  second.socket.send(JSON.stringify({type:'response',id:request.id,status:200,body:{wrong:true}}));
  const next=f.state();const newRequest=await second.wait(e=>e.action==='state');
  second.socket.send(JSON.stringify({type:'response',id:newRequest.id,status:400,body:{error:'Real phone validation'}}));
  assert.equal((await next).status,400);
});
test('bounded concurrent operations reject overload and disconnect releases all waiters',async t=>{
  const f=await fixture(t),p=await f.connect();await p.ready();
  const requests=Array.from({length:8},()=>f.state());
  for(let i=0;i<200&&p.events.filter(e=>e.type==='request').length<8;i++)await tick();
  assert.equal((await f.state()).status,429);
  p.socket.close();assert.ok((await Promise.all(requests)).every(r=>r.status===503));
});
test('oversized requests fail; public assets keep the original layout without credentials',async t=>{
  const f=await fixture(t),p=await f.connect();await p.ready();
  assert.equal((await f.post('send',{text:'x'.repeat(65537)})).status,400);
  const html=await(await f.fetch('/')).text(),js=await(await f.fetch('/app.js')).text();
  assert.ok(html.includes('Just talk.')&&!html.includes('Talk it through'));
  assert.ok(html.includes('Connecting to Raspberry Pi')&&!html.includes('Connecting to your Raspberry Pi'));
  assert.ok(html.includes('id="pair-pin"')&&!html.includes('pair-room')&&!html.includes('pair-key'));
  assert.ok(!html.includes('id="gpt-login"')&&html.includes('id="claude-login"')&&html.includes('id="voice-orb"'));
  assert.ok(!html.includes(f.phoneKey)&&!js.includes(f.pin));
  assert.ok(!js.includes('innerHTML')&&!js.includes('backend-api')&&!js.includes('api.anthropic'));
  const logout=await f.post('logout');assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
});
test('phone-authorized backups are validated and require a Worker GitHub secret',async t=>{
  const f=await fixture(t);
  const bad=await f.fetch('/api/backup',{method:'POST',headers:{authorization:'Bearer '+f.phoneKey,'content-type':'application/json'},body:'{}'});
  assert.equal(bad.status,400);
  const valid=await f.fetch('/api/backup',{method:'POST',headers:{authorization:'Bearer '+f.phoneKey,'content-type':'application/json'},body:JSON.stringify({rooms:[],messages:[]})});
  assert.equal(valid.status,503);assert.match((await valid.json()).error,/not configured/);
});
