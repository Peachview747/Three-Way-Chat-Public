// Local control API for the Video Pilot portal (127.0.0.1 only). The portal
// shows AI Room inside itself and a Pi Health page; Video Pilot's server,
// behind the portal PIN, forwards those requests here with a shared key
// (/opt/pi-control/key, readable by ai-room and video-pilot). A custom key
// header also stops web pages in a browser on the Pi from calling it.
// This service already has passwordless sudo, so it reads system state and
// runs the fixed list of actions below; it never runs arbitrary commands.
import http from 'node:http';
import {execFile} from 'node:child_process';
import {readFile,statfs} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import os from 'node:os';

const OWNER='peachview', OWNER_UID=1000;
const SYSTEM_SERVICES={'video-pilot':'Video Pilot','ai-room':'AI Room'};
const USER_SERVICES={'claude-rc':'Claude Remote Control','video-pilot-live':'Netflix/Hulu helper','video-pilot-signin':'YouTube sign-in helper'};
const USER_ENV=[`XDG_RUNTIME_DIR=/run/user/${OWNER_UID}`,`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${OWNER_UID}/bus`];

function sh(command,args,{timeout=15_000}={}) {
  return new Promise(resolve=>execFile(command,args,{timeout,maxBuffer:4<<20},(error,stdout,stderr)=>
    resolve({ok:!error,code:error?.code??0,out:String(stdout||'').trim(),err:String(stderr||'').trim()})));
}
const sudo=(args,options)=>sh('sudo',['-n',...args],options);
const userctl=(args,options)=>sudo(['-u',OWNER,'env',...USER_ENV,'systemctl','--user',...args],options);

// Vital signs, service states, network and what AI Room is doing.
export async function health({store,relay}) {
  const [temp,throttled,disks,services,links,ping,storage]=await Promise.all([
    readFile('/sys/class/thermal/thermal_zone0/temp','utf8').then(v=>Number(v)/1000,()=>null),
    sudo(['vcgencmd','get_throttled']).then(r=>parseInt(r.out.split('=')[1],16)),
    Promise.all(['/','/srv/pi-data'].map(path=>statfs(path).then(s=>({path,total:s.blocks*s.bsize,free:s.bavail*s.bsize}),()=>null))),
    serviceStates(),
    sh('nmcli',['-t','-f','DEVICE,TYPE,STATE,CONNECTION','device']),
    sh('ping',['-c','1','-W','2','1.1.1.1']),
    sudo(['/usr/local/sbin/pi-storage','status']),
  ]);
  const flags=Number.isFinite(throttled)?throttled:0;
  return {
    at:Date.now(), hostname:os.hostname(), uptime:os.uptime(),
    vitals:{temperature:temp, load:os.loadavg(), cpus:os.cpus().length,
      memory:{total:os.totalmem(),free:os.freemem(),available:await memAvailable()},
      disks:disks.filter(Boolean),
      power:{undervoltageNow:Boolean(flags&0x1),throttledNow:Boolean(flags&0x4),undervoltageSinceBoot:Boolean(flags&0x10000),throttledSinceBoot:Boolean(flags&0x40000),raw:Number.isFinite(throttled)?`0x${throttled.toString(16)}`:null},
      storageMode:/protected OS/.test(storage.out)?'protected (read-only OS)':/writable/.test(storage.out)?'writable OS':'unknown'},
    services,
    network:{links:links.out.split('\n').filter(Boolean).map(line=>{const [device,type,state,connection]=line.split(':');return{device,type,state,connection}}).filter(l=>['ethernet','wifi'].includes(l.type)),
      internet:ping.ok, pingMs:Number(ping.out.match(/time=([\d.]+)/)?.[1])||null, aiRoomRelay:relay()},
    activity:{aiRoomBusy:Boolean(store.active)},
  };
}
async function memAvailable(){try{return Number((await readFile('/proc/meminfo','utf8')).match(/MemAvailable:\s+(\d+)/)[1])*1024}catch{return null}}
async function serviceStates() {
  const system=await Promise.all(Object.entries(SYSTEM_SERVICES).map(async([id,label])=>({id,label,scope:'system',...await state(sh('systemctl',['show',id,'-p','ActiveState,SubState,ActiveEnterTimestamp']))})));
  const user=await Promise.all(Object.entries(USER_SERVICES).map(async([id,label])=>({id,label,scope:'user',...await state(userctl(['show',id,'-p','ActiveState,SubState,ActiveEnterTimestamp']))})));
  return [...system,...user];
}
async function state(result) {
  const r=await result,fields=Object.fromEntries(r.out.split('\n').map(line=>line.split(/=(.*)/s).slice(0,2)));
  const since=Date.parse(fields.ActiveEnterTimestamp||'');
  return {active:fields.ActiveState||'unknown',sub:fields.SubState||'',since:Number.isFinite(since)?since:null};
}

// The fixed actions behind the page's buttons.
export const ACTIONS={
  'restart:claude-rc':{label:'Restart Claude Remote Control',run:()=>userctl(['restart','claude-rc'])},
  'restart:video-pilot':{label:'Restart Video Pilot',run:()=>sudo(['systemctl','restart','video-pilot'])},
  'restart:video-pilot-live':{label:'Restart the Netflix/Hulu helper',run:()=>userctl(['restart','video-pilot-live'])},
  'restart:video-pilot-signin':{label:'Restart the YouTube sign-in helper',run:()=>userctl(['restart','video-pilot-signin'])},
  // This service restarting itself: a moment later, so the answer gets out first.
  'restart:ai-room':{label:'Restart AI Room',run:()=>sudo(['systemd-run','--on-active=2','--unit',`ai-room-restart-${Date.now()}`,'systemctl','restart','ai-room'])},
  'reboot':{label:'Reboot the Pi',confirm:true,run:()=>sudo(['shutdown','-r','+0'],{timeout:5000}).then(()=>({ok:true,out:'Rebooting now. Back in about a minute.'}))},
  'shutdown':{label:'Shut down the Pi',confirm:true,run:()=>sudo(['shutdown','-h','+0'],{timeout:5000}).then(()=>({ok:true,out:'Shutting down. It stays off until power is cycled.'}))},
  'free-memory':{label:'Free cached memory',run:()=>sudo(['sh','-c','sync; echo 3 > /proc/sys/vm/drop_caches; free -h'])},
  'speed-test':{label:'Internet speed test',run:speedTest},
  'update-ytdlp':{label:'Update the YouTube downloader',run:()=>sudo(['-u','video-pilot','/opt/video-pilot/pi-host/.venv/bin/pip','install','-q','-U','yt-dlp','yt-dlp-ejs'],{timeout:180_000})
    .then(async r=>({...r,out:(r.ok?'Updated. ':'')+(await sh('/opt/video-pilot/pi-host/.venv/bin/yt-dlp',['--version'])).out}))},
  'top':{label:'What is using the CPU',run:()=>sh('ps',['-eo','pcpu,pmem,etime,comm','--sort=-pcpu']).then(r=>({...r,out:r.out.split('\n').slice(0,9).join('\n')}))},
  'logs:video-pilot':{label:'Video Pilot log (last 25 lines)',run:()=>sudo(['journalctl','-u','video-pilot','-n','25','--no-pager','-o','short'])},
  'logs:ai-room':{label:'AI Room log (last 25 lines)',run:()=>sudo(['journalctl','-u','ai-room','-n','25','--no-pager','-o','short'])},
};
async function speedTest() {
  const down=await sh('curl',['-s','-o','/dev/null','-w','%{speed_download}','https://speed.cloudflare.com/__down?bytes=25000000'],{timeout:60_000});
  const up=await sh('sh',['-c','head -c 10000000 /dev/zero | curl -s -o /dev/null -w "%{speed_upload}" --data-binary @- https://speed.cloudflare.com/__up'],{timeout:60_000});
  const mbps=value=>Number.isFinite(Number(value))&&Number(value)>0?`${Math.round(Number(value)*8/1e6)} Mbps`:'failed';
  return {ok:down.ok||up.ok,out:`Download ${mbps(down.out)} · Upload ${mbps(up.out)}`};
}

export async function readKey(file='/opt/pi-control/key'){try{const key=(await readFile(file,'utf8')).trim();return key.length>=32?key:null}catch{return null}}

export function createControlServer({store,key,relay=()=>null,alerts=null,voice=null,port=5020,host='127.0.0.1'}) {
  const expected=Buffer.from(key);
  return http.createServer(async(req,res)=>{
    const reply=(status,body)=>{const bytes=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store'});res.end(bytes)};
    try {
      const supplied=Buffer.from(String(req.headers['x-pi-control-key']||''));
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(403,{error:'Not allowed.'});
      if(req.method!=='POST')return reply(405,{error:'Method not allowed.'});
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>3_500_000)return reply(413,{error:'Request is too large.'});chunks.push(chunk)}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      const url=new URL(req.url,'http://localhost');
      const room=url.pathname.match(/^\/room\/([a-z]+)$/);
      if(room){const result=await store.handle(room[1],body);return reply(result.status,result.body)}
      if(url.pathname==='/health')return reply(200,await health({store,relay}));
      // Spoken alerts: new ones since an id, and any short text in Claude's voice.
      if(url.pathname==='/alerts')return reply(200,alerts?alerts.since(body.since):{alerts:[],latest:0});
      if(url.pathname==='/say') {
        if(!voice)return reply(503,{error:'Voice is not set up on this Raspberry Pi.'});
        const text=String(body.text||'').slice(0,400);
        if(!text.trim())return reply(400,{error:'Nothing to say.'});
        return reply(200,{audio:await voice.speak(text,body.voice),mime:'audio/mpeg'});
      }
      if(url.pathname==='/action'&&body.id==='test-alert'&&alerts){alerts.add('This is a test alert from your Pi.','test');return reply(200,{ok:true,output:'Test alert sent. Any open portal page will say it within 20 seconds.'})}
      if(url.pathname==='/actions')return reply(200,{actions:[...(alerts?[{id:'test-alert',label:'Test spoken alert',confirm:false}]:[]),...Object.entries(ACTIONS).map(([id,{label,confirm}])=>({id,label,confirm:Boolean(confirm)}))]});
      if(url.pathname==='/action') {
        const action=ACTIONS[body.id];
        if(!action)return reply(404,{error:'Unknown action.'});
        const result=await action.run();
        return reply(200,{ok:result.ok,output:(result.out||result.err||'').slice(-6000)||(result.ok?'Done.':'It did not work.')});
      }
      return reply(404,{error:'Not found.'});
    } catch(error) {if(!res.headersSent)reply(500,{error:String(error.message||error)})}
  }).listen(port,host);
}
