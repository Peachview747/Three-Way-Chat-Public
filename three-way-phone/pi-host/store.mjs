import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VOICES,DEFAULT_VOICE} from './voice.mjs';

const MAX_BYTES=600_000, MAX_ROOMS=50, MAX_MESSAGES=500;
export class StoreError extends Error {}

export class ConversationStore {
  constructor(file,providers,backup=async()=>{},voice=null) {
    this.file=file;this.providers=providers;this.backup=backup;this.voice=voice;this.history=null;this.loadError=null;this.active=null;
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
      login_busy:false,connections,voice:{available:Boolean(this.voice),voices:Object.entries(VOICES).map(([id,{label}])=>({id,label})),default:DEFAULT_VOICE}};
  }
  async ensureInitialSave(){try{await readFile(this.file)}catch(error){if(error.code==='ENOENT')await this.commit(this.history);else throw error}}
  validateSend(body) {
    if(typeof body.request_id!=='string'||!isUUID(body.request_id)||typeof body.room!=='string'||!this.history.rooms.some(r=>r.id===body.room)||
      typeof body.text!=='string'||body.target!=='claude'||!Number.isInteger(body.rounds)||body.rounds!==1)throw new StoreError('Invalid prompt. Refresh the room and retry.');
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
      if(action==='speak')return reply(200,await this.preview(body));
      if(action==='voice')return reply(200,await this.converse(body));
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
        const answer=await this.providers.reply(text,prior,controller.signal);
        if(this.active!==controller)throw new StoreError('The reply was stopped.');
        const next=clone(this.history);next.messages.push(message(`${body.request_id}:claude:0`,body.room,'claude',answer,'complete','claude',1));await this.commit(next);
        return reply(200,{ok:true,notice:'Claude’s reply is saved on your Raspberry Pi.'});
      } finally {if(this.active===controller)this.active=null}
    } catch(error) {
      const text=error.name==='AbortError'?'The reply was stopped.':error.message||'The Raspberry Pi could not complete this request.';
      return reply(error instanceof StoreError||error.name==='AbortError'?400:500,{error:text});
    }
  }

  // One spoken turn: what was heard, Claude's spoken-style answer, and that
  // answer as audio. Both sides are saved like typed messages.
  async converse(body) {
    if(!this.voice)throw new StoreError('Voice is not set up on this Raspberry Pi.');
    if(!isUUID(body.request_id)||typeof body.room!=='string'||!this.history.rooms.some(r=>r.id===body.room))throw new StoreError('Invalid voice turn. Refresh the room and retry.');
    if(typeof body.audio!=='string'||!body.audio||!AUDIO.test(body.audio))throw new StoreError('No audio arrived.');
    if(this.active)throw new StoreError('Claude is already replying.');
    const controller=new AbortController();this.active=controller;
    try {
      const heard=await this.voice.transcribe(Buffer.from(body.audio,'base64'),controller.signal);
      // Noise or silence: nothing to answer, and nothing saved.
      if(!heard||!/[a-z0-9]/i.test(heard))return {heard:'',reply:'',audio:null};
      if(this.history.messages.length+2>MAX_MESSAGES)throw new StoreError('This host supports 500 saved messages.');
      const prior=this.history.messages.filter(m=>m.room===body.room).map(({author,text})=>({author,text}));
      let next=clone(this.history);
      next.messages.push({...message(body.request_id,body.room,'user',heard,'complete','claude',1),spoken:true});
      const room=next.rooms.find(r=>r.id===body.room);if(room?.title==='New conversation')room.title=heard.slice(0,45);
      await this.commit(next);
      const answer=await this.providers.reply(heard,prior,controller.signal,{spoken:true});
      if(this.active!==controller)throw new StoreError('The reply was stopped.');
      next=clone(this.history);next.messages.push({...message(`${body.request_id}:claude:0`,body.room,'claude',answer,'complete','claude',1),spoken:true});
      await this.commit(next);
      const audio=await this.voice.speak(answer,body.voice,controller.signal);
      return {heard,reply:answer,audio,mime:'audio/mpeg'};
    } finally {if(this.active===controller)this.active=null}
  }
  async preview(body) {
    if(!this.voice)throw new StoreError('Voice is not set up on this Raspberry Pi.');
    const audio=await this.voice.speak('Hi, I’m Claude. This is how I’ll sound when we talk in the car.',body.voice);
    return {audio,mime:'audio/mpeg'};
  }
}
const clone=value=>structuredClone(value);
const AUDIO=/^[A-Za-z0-9+/]+=*$/;
const isUUID=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const reply=(status,body)=>({status,body});
const message=(id,room,author,text,status,target,rounds)=>({id,room,author,text,status,created:Date.now()/1000,target,rounds});
