// Voice for AI Room: speech to text with whisper.cpp (kept loaded as a local
// server so each turn skips loading the model) and text to speech with Piper.
// Both run offline on the Pi from /opt/ai-room-voice; audio never leaves it.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Medium Piper voices only: the "high" ones take longer to speak than to play on a Pi 5.
export const VOICES = {
  'en_US-ryan-medium':{label:'Ryan (US, male)'},
  'en_US-joe-medium':{label:'Joe (US, male)'},
  'en_US-john-medium':{label:'John (US, male)'},
  'en_US-norman-medium':{label:'Norman (US, male)'},
  'en_GB-alan-medium':{label:'Alan (UK, male)'},
  'en_US-hfc_female-medium':{label:'Hannah (US, female)'},
  'en_US-amy-medium':{label:'Amy (US, female)'},
  'en_US-kristin-medium':{label:'Kristin (US, female)'},
  'en_GB-jenny_dioco-medium':{label:'Jenny (UK, female)'},
};
export const DEFAULT_VOICE = 'en_US-ryan-medium';
const MAX_AUDIO = 3_000_000, MAX_SPEECH = 4000;

export class Voice {
  constructor({root=process.env.AI_ROOM_VOICE_DIR||'/opt/ai-room-voice',port=5010,run=runTool,fetcher=globalThis.fetch,logger=console}={}) {
    this.root=root;this.port=port;this.run=run;this.fetch=fetcher;this.logger=logger;this.server=null;this.stopped=false;
  }
  async available() {
    try {await Promise.all([access(join(this.root,'whisper.cpp/build/bin/whisper-server')),access(join(this.root,'piper/piper'))]);return true}
    catch {return false}
  }
  // The recognizer stays loaded; if it exits it is started again.
  start() {
    if(this.server||this.stopped)return;
    const child=spawn(join(this.root,'whisper.cpp/build/bin/whisper-server'),['-m',join(this.root,'models/ggml-base.en.bin'),
      '--host','127.0.0.1','--port',String(this.port),'-t','4','--no-timestamps'],{stdio:'ignore'});
    this.server=child;
    child.on('error',error=>this.logger.error('Voice recognizer:',error.message));
    child.on('exit',()=>{if(this.server===child)this.server=null;if(!this.stopped)setTimeout(()=>this.start(),5000)});
  }
  stop() {this.stopped=true;this.server?.kill('SIGTERM');this.server=null}

  // Browser audio (webm/opus, mp4/aac, wav…) → text.
  async transcribe(audio,signal) {
    if(!audio?.length)return '';
    if(audio.length>MAX_AUDIO)throw new VoiceError('That recording is too long. Keep each turn under a couple of minutes.');
    const dir=await mkdtemp(join(tmpdir(),'ai-room-voice-'));
    try {
      const input=join(dir,'input'),wav=join(dir,'speech.wav');
      await writeFile(input,audio);
      // Cut road rumble below speech. Whisper copes with the rest of the noise
      // itself; a stronger noise reducer made its transcripts worse in tests.
      await this.run('ffmpeg',['-loglevel','error','-y','-i',input,'-af','highpass=f=100','-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{signal});
      const form=new FormData();
      form.append('file',new Blob([await readFile(wav)],{type:'audio/wav'}),'speech.wav');
      form.append('response_format','json');form.append('temperature','0');
      let response;
      for(let attempt=0;;attempt++) {
        try {response=await this.fetch(`http://127.0.0.1:${this.port}/inference`,{method:'POST',body:form,signal});break}
        catch(error) {
          // Just started (or restarting): the model takes a moment to load.
          if(signal?.aborted||attempt>=10)throw new VoiceError('Speech recognition is not running on the Pi.');
          this.start();await new Promise(resolve=>setTimeout(resolve,1000));
        }
      }
      if(!response.ok)throw new VoiceError('Speech recognition failed on the Pi.');
      return cleanTranscript((await response.json()).text);
    } finally {await rm(dir,{recursive:true,force:true})}
  }

  // Text → MP3 (plays in every browser), base64.
  async speak(text,voice=DEFAULT_VOICE,signal) {
    const name=Object.hasOwn(VOICES,voice)?voice:DEFAULT_VOICE;
    const spoken=speakable(text).slice(0,MAX_SPEECH);
    if(!spoken)return null;
    const dir=await mkdtemp(join(tmpdir(),'ai-room-voice-'));
    try {
      const wav=join(dir,'reply.wav'),mp3=join(dir,'reply.mp3');
      await this.run(join(this.root,'piper/piper'),['-m',join(this.root,'voices',`${name}.onnx`),'-f',wav,'--sentence_silence','0.18','--noise_scale','0.95','--noise_w','1.1','--length_scale','0.9'],{signal,input:spoken});
      await this.run('ffmpeg',['-loglevel','error','-y','-i',wav,'-ac','1','-b:a','48k',mp3],{signal});
      return (await readFile(mp3)).toString('base64');
    } finally {await rm(dir,{recursive:true,force:true})}
  }
}
export class VoiceError extends Error {}

// Whisper marks silence and noise as "[BLANK_AUDIO]", "(wind blowing)" and so on.
export function cleanTranscript(text) {
  return String(text||'').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g,' ').replace(/\s+/g,' ').trim();
}
// What a voice should say: no markdown symbols, code or links read aloud.
export function speakable(text) {
  return String(text||'')
    .replace(/```[\s\S]*?```/g,' (I put the code in the chat.) ')
    .replace(/`([^`]*)`/g,'$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
    .replace(/https?:\/\/\S+/g,'the link in the chat')
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm,'')
    .replace(/[*_~#>|]/g,'')
    .replace(/\s+/g,' ').trim();
}

function runTool(command,args,{signal,input}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{signal,stdio:[input===undefined?'ignore':'pipe','ignore','pipe']});let stderr='';
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000)});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new VoiceError(`${command.split('/').pop()} failed: ${stderr.trim()||code}`)));
    if(input!==undefined)child.stdin.end(input);
  });
}
