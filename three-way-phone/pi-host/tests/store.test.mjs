import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ConversationStore} from '../store.mjs';

class FakeProviders {
  async status(){return{claude:{ready:true,label:'Connected on Raspberry Pi'}}}
  loginInstructions(){return 'login claude'}
  async reply(prompt,context,signal,{spoken=false}={}){if(signal.aborted)throw new DOMException('Stopped','AbortError');return `claude${spoken?' (spoken)':''}: ${prompt} (${context.length})`}
}
test('Pi store persists prompts, replies, deduplicates retries, and exports',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-')),file=join(dir,'conversations.json'),store=new ConversationStore(file,new FakeProviders());
  const initial=await store.handle('state',{});assert.equal(initial.status,200);const room=initial.body.rooms[0].id,id=randomUUID();
  const prompt={request_id:id,room,text:'Hello Pi',target:'claude',rounds:1};
  assert.equal((await store.handle('send',prompt)).status,200);
  const state=await store.handle('state',{room});assert.deepEqual(state.body.messages.map(m=>m.author),['user','claude']);
  assert.equal((await store.handle('send',prompt)).status,200);assert.equal((await store.handle('state',{room})).body.messages.length,2);
  assert.equal((await store.handle('send',{...prompt,request_id:randomUUID(),target:'gpt'})).status,400,'ChatGPT is gone');
  assert.equal((await store.handle('send',{...prompt,text:'changed'})).status,400);
  const reloaded=new ConversationStore(file,new FakeProviders());assert.equal((await reloaded.handle('state',{room})).body.messages.length,2);
  assert.doesNotReject(()=>readFile(file));
});
test('Pi store creates rooms and reports service-login commands',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-')),store=new ConversationStore(join(dir,'history.json'),new FakeProviders());
  await store.handle('state',{});const id=randomUUID();assert.equal((await store.handle('new',{request_id:id})).body.room,id);
  assert.match((await store.handle('login',{provider:'claude'})).body.notice,/login claude/);
});

test('a voice turn saves what was heard and the spoken reply, and returns audio',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-'));
  const voice={transcribe:async audio=>audio.toString()==='silence'?'':'what time is it',speak:async text=>Buffer.from('mp3:'+text).toString('base64')};
  const store=new ConversationStore(join(dir,'h.json'),new FakeProviders(),async()=>{},voice);
  const room=(await store.handle('state',{})).body.rooms[0].id;
  const quiet=await store.handle('voice',{request_id:randomUUID(),room,audio:Buffer.from('silence').toString('base64')});
  assert.deepEqual(quiet.body,{heard:'',reply:'',audio:null});
  const turn=await store.handle('voice',{request_id:randomUUID(),room,audio:Buffer.from('speech').toString('base64'),voice:'en_US-amy-medium'});
  assert.equal(turn.status,200);assert.equal(turn.body.heard,'what time is it');assert.equal(turn.body.reply,'claude (spoken): what time is it (0)');
  assert.equal(Buffer.from(turn.body.audio,'base64').toString(),'mp3:'+turn.body.reply);
  const messages=(await store.handle('state',{room})).body.messages;
  assert.deepEqual(messages.map(m=>[m.author,m.spoken]),[['user',true],['claude',true]]);
  assert.equal((await store.handle('state',{})).body.rooms[0].title,'what time is it');
  assert.equal((await store.handle('voice',{request_id:randomUUID(),room,audio:'not base64!'})).status,400);
});

test('each conversation is one Claude Code session, resumed after the first reply',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-pi-')),calls=[];
  const providers=new FakeProviders();providers.reply=async(prompt,context,signal,options)=>{calls.push(options);return 'ok'};
  const store=new ConversationStore(join(dir,'s.json'),providers);
  const room=(await store.handle('state',{})).body.rooms[0].id;
  for(const text of ['one','two'])assert.equal((await store.handle('send',{request_id:randomUUID(),room,text,target:'claude',rounds:1})).status,200);
  assert.deepEqual(calls,[{session:room,resume:false},{session:room,resume:true}]);
});
