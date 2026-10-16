import {readFile,copyFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import WebSocket from 'ws';
import {ConversationStore} from './store.mjs';
import {CLIProviders} from './providers.mjs';
import {Voice} from './voice.mjs';
const exec=promisify(execFile),PROTOCOL='three-way-host/1';
const configPath=process.env.AI_ROOM_CONFIG||'/etc/ai-room/host.json',dataDir=process.env.AI_ROOM_DATA_DIR||'/var/lib/ai-room';
const config=JSON.parse(await readFile(configPath,'utf8'));validate(config);
const providers=new CLIProviders({home:dataDir,workdir:dataDir});
// Voice turns need the offline speech tools in /opt/ai-room-voice; without
// them AI Room is text-only.
const voice=new Voice();
const voiceReady=await voice.available();
if(voiceReady)voice.start();else console.error('Voice tools not found; AI Room runs text-only.');
const store=new ConversationStore(join(dataDir,'conversations.json'),providers,data=>backup(data,config.backupRepoPath),voiceReady?voice:null);
let attempt=0,stopping=false;

function connect(){
  const url=new URL('api/phone',config.server);url.protocol='wss:';
  const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${config.phoneKey}`},maxPayload:4_000_000,handshakeTimeout:15_000});
  let heartbeat,lastPong=0;
  ws.on('open',()=>{attempt=0;lastPong=Date.now();console.log('Connected to AI Room Worker.');heartbeat=setInterval(()=>{if(Date.now()-lastPong>45_000){console.error('AI Room heartbeat timed out. Reconnecting…');return ws.terminate()}if(ws.readyState===WebSocket.OPEN)ws.send('ping')},20_000)});
  ws.on('message',raw=>{const text=raw.toString();if(text==='pong'){lastPong=Date.now();return}let body;try{body=JSON.parse(text)}catch{return ws.close(1008,'Invalid relay message')}
    if(body.type==='hello'&&body.protocol===PROTOCOL)return ws.send(JSON.stringify({type:'ready',protocol:PROTOCOL}));
    if(body.type==='connected')return;
    if(body.type==='replaced'){console.error('Another host replaced this Pi.');return ws.close(4001,'Replaced')}
    if(body.type==='request'&&typeof body.id==='string'&&typeof body.action==='string'&&body.body&&typeof body.body==='object') {
      store.handle(body.action,body.body).then(result=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',id:body.id,...result}))})
        .catch(error=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',id:body.id,status:500,body:{error:error.message}}))});
    }
  });
  ws.on('error',error=>console.error('Relay:',error.message));
  ws.on('close',()=>{clearInterval(heartbeat);if(!stopping){const delay=Math.min(30_000,1000*2**Math.min(attempt++,5));console.log(`Reconnecting in ${delay/1000}s…`);setTimeout(connect,delay)}});
}
connect();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;voice.stop();process.exit(0)});

async function backup(data,path){
  if(!path)return;const target=join(path,'conversations','ai-room-conversations.json');await mkdir(dirname(target),{recursive:true});await copyFile(join(dataDir,'conversations.json'),target);
  await exec('git',['-C',path,'add','conversations/ai-room-conversations.json']);
  try{await exec('git',['-C',path,'commit','-m','Back up AI Room conversations'])}catch(error){if(!String(error.stdout).includes('nothing to commit'))throw error}
  await exec('git',['-C',path,'push','origin','HEAD:main'],{timeout:60_000});
}
function validate(value){if(value?.version!==1||value.server!=='https://ai.jch76.workers.dev/'||!/^[0-9a-f-]{36}$/i.test(value.room||'')||!/^[A-Za-z0-9_-]{43}$/.test(value.phoneKey||''))throw new Error('Invalid AI Room Pi host configuration.')}
