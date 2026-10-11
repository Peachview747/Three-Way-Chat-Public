import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ConversationStore} from '../store.mjs';

class FakeProviders {
  async status(){return{gpt:{ready:true,label:'Connected on Raspberry Pi'},claude:{ready:true,label:'Connected on Raspberry Pi'}}}
  loginInstructions(provider){return `login ${provider}`}
  async reply(provider,prompt,context,signal){if(signal.aborted)throw new DOMException('Stopped','AbortError');return `${provider}: ${prompt} (${context.length})`}
}
test('Pi store persists prompts, replies, deduplicates retries, and exports',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-')),file=join(dir,'conversations.json'),store=new ConversationStore(file,new FakeProviders());
  const initial=await store.handle('state',{});assert.equal(initial.status,200);const room=initial.body.rooms[0].id,id=randomUUID();
  const prompt={request_id:id,room,text:'Hello Pi',target:'both',rounds:2};
  assert.equal((await store.handle('send',prompt)).status,200);
  const state=await store.handle('state',{room});assert.deepEqual(state.body.messages.map(m=>m.author),['user','gpt','claude']);
  assert.equal((await store.handle('send',prompt)).status,200);assert.equal((await store.handle('state',{room})).body.messages.length,3);
  assert.equal((await store.handle('send',{...prompt,text:'changed'})).status,400);
  const reloaded=new ConversationStore(file,new FakeProviders());assert.equal((await reloaded.handle('state',{room})).body.messages.length,3);
  assert.doesNotReject(()=>readFile(file));
});
test('Pi store creates rooms and reports service-login commands',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-')),store=new ConversationStore(join(dir,'history.json'),new FakeProviders());
  await store.handle('state',{});const id=randomUUID();assert.equal((await store.handle('new',{request_id:id})).body.room,id);
  assert.match((await store.handle('login',{provider:'gpt'})).body.notice,/login gpt/);
});
