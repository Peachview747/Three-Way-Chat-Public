import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX_BYTES=600_000, MAX_ROOMS=50, MAX_MESSAGES=500;
export class StoreError extends Error {}

export class ConversationStore {
  constructor(file,providers,backup=async()=>{}) {
    this.file=file;this.providers=providers;this.backup=backup;this.history=null;this.loadError=null;this.active=null;
  }
  async load() {
    if(this.history||this.loadError)return;
    try {
      const data=await readFile(this.file);
      if(data.length>MAX_BYTES)throw new Error('large');
      const parsed=JSON.parse(data);
      if(!Array.isArray(parsed.rooms)||!parsed.rooms.length||parsed.rooms.length>MAX_ROOMS||!Array.isArray(parsed.messages)||parsed.messages.length>MAX_MESSAGES)throw new Error('invalid');
      this.history=parsed;
    } catch(error) {
      if(error.code==='ENOENT')this.history={rooms:[{id:randomUUID(),title:'New conversation'}],messages:[]};
      else this.loadError='The saved room could not be read. Its file has been preserved.';
    }
  }
  async commit(next) {
    const data=Buffer.from(JSON.stringify(next));
    if(data.length>MAX_BYTES)throw new StoreError('This Pi’s room storage is full. Export conversations first.');
    await mkdir(dirname(this.file),{recursive:true});
    const temp=this.file+'.tmp-'+process.pid;await writeFile(temp,data,{mode:0o600});await rename(temp,this.file);this.history=next;
    this.backup(data).catch(error=>console.error('backup:',error.message));
  }
  async snapshot(room='') {
    if(!this.history)await this.load();
    if(this.loadError)throw new StoreError(this.loadError);
    await this.ensureInitialSave();
    const connections=await this.providers.status();
    return {rooms:this.history.rooms,messages:this.history.messages.filter(m=>m.room===room),busy:!!this.active,
      login_busy:false,connections};
  }
  async ensureInitialSave(){try{await readFile(this.file)}catch(error){if(error.code==='ENOENT')await this.commit(this.history);else throw error}}
  validateSend(body) {
    if(typeof body.request_id!=='string'||!isUUID(body.request_id)||typeof body.room!=='string'||!this.history.rooms.some(r=>r.id===body.room)||
      typeof body.text!=='string'||!['both','gpt','claude','discuss'].includes(body.target)||!Number.isInteger(body.rounds)||body.rounds<1||body.rounds>3)throw new StoreError('Invalid prompt. Refresh the room and retry.');
    const text=body.text.trim();if(!text||[...text].length>12_000)throw new StoreError('Enter a prompt of 1–12,000 characters.');
    return text;
  }
  async handle(action,body={}) {
    await this.load();if(this.loadError)return reply(500,{error:this.loadError});
    try {
      if(action==='state'||action==='refresh')return reply(200,await this.snapshot(body.room||''));
      if(action==='export')return reply(200,this.history);
      if(action==='new') {
        if(!isUUID(body.request_id))throw new StoreError('Invalid conversation ID.');
        if(this.history.rooms.some(r=>r.id===body.request_id))return reply(200,{room:body.request_id});
        if(this.history.rooms.length>=MAX_ROOMS)throw new StoreError('This host supports 50 conversations.');
        const next=clone(this.history);next.rooms.unshift({id:body.request_id,title:'New conversation'});await this.commit(next);return reply(200,{room:body.request_id});
      }
      if(action==='login')return reply(200,{notice:this.providers.loginInstructions(body.provider)});
      if(action==='stop') {this.active?.abort();this.active=null;return reply(200,{ok:true,notice:'Stopped the current reply.'});}
      if(action!=='send')return reply(404,{error:'Unknown room action.'});
      if(this.active)throw new StoreError('The assistants are already replying.');
      const text=this.validateSend(body),existing=this.history.messages.find(m=>m.id===body.request_id);
      if(existing&&(existing.room!==body.room||existing.text!==text||existing.target!==body.target||existing.rounds!==body.rounds))throw new StoreError('This request ID is already in use.');
      if(this.history.messages.some(m=>m.id.startsWith(body.request_id+':')))return reply(200,{ok:true,notice:'This prompt and its replies are already saved.'});
      if(!existing) {
        if(this.history.messages.length>=MAX_MESSAGES)throw new StoreError('This host supports 500 saved messages.');
        const next=clone(this.history);next.messages.push(message(body.request_id,body.room,'user',text,'complete',body.target,body.rounds));
        const room=next.rooms.find(r=>r.id===body.room);if(room?.title==='New conversation')room.title=text.slice(0,45);await this.commit(next);
      }
      const controller=new AbortController();this.active=controller;
      try {
        const prior=this.history.messages.filter(m=>m.room===body.room&&m.id!==body.request_id).map(({author,text})=>({author,text}));
        const order=body.target==='discuss'?Array.from({length:body.rounds},()=>['gpt','claude']).flat():body.target==='both'?['gpt','claude']:[body.target];
        const made=[],context=[...prior];
        for(let i=0;i<order.length;i++) {
          const provider=order[i],prompt=body.target==='discuss'&&i>0?`Continue this discussion and respond to the other assistant's latest point. Original request: ${text}`:text;
          const answer=await this.providers.reply(provider,prompt,context,controller.signal);made.push(message(`${body.request_id}:${provider}:${i}`,body.room,provider,answer,'complete',provider,body.rounds));context.push({author:provider,text:answer});
        }
        if(this.active!==controller)throw new StoreError('The reply was stopped.');
        const next=clone(this.history);next.messages.push(...made);await this.commit(next);return reply(200,{ok:true,notice:'Assistant replies saved on your Raspberry Pi.'});
      } finally {if(this.active===controller)this.active=null}
    } catch(error) {
      const text=error.name==='AbortError'?'The reply was stopped.':error.message||'The Raspberry Pi could not complete this request.';
      return reply(error instanceof StoreError||error.name==='AbortError'?400:500,{error:text});
    }
  }
}
const clone=value=>structuredClone(value);
const isUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const reply=(status,body)=>({status,body});
const message=(id,room,author,text,status,target,rounds)=>({id,room,author,text,status,created:Date.now()/1000,target,rounds});
