import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Claude Code is the only assistant. Earlier conversations may still contain
// ChatGPT turns; they stay in the history and are labelled as such.
const SPOKEN='The user is talking to you out loud, often while driving, and your reply will be read aloud by a text-to-speech voice. '+
  'Answer like a person in conversation: usually one to three short sentences, warm and direct. No markdown, headings, bullet lists, tables, code blocks, links or emoji. '+
  'Spell out what a listener needs (say "about five minutes", not "~5 min"). If the user asks you to do something on the Pi, do it with your tools, then say in a sentence what happened. '+
  'If an answer truly needs detail, give the short version and offer to put the rest in the chat.\n\n';

// With system access, Claude Code runs as the owner's own account from their
// home folder: the same CLAUDE.md, memory notes, repos and past session logs
// as their terminal sessions. Each AI Room conversation is one real Claude
// Code session (resumed turn after turn), not a pasted transcript.
const OWNER_CONTEXT='You are Claude Code on the owner’s Raspberry Pi, running as their own user account from their home folder, reached through AI Room (their chat and voice web app, used from the car or a phone). '+
  'You have the same files, instructions and memory as their terminal Claude Code sessions: memory notes in ~/.claude/projects/-home-peachview/memory/ (index MEMORY.md), '+
  'transcripts of past Claude Code sessions as JSONL under ~/.claude/projects/*/ (Remote Control sessions are in -home-peachview-remote-claude), '+
  'and the project repos in the home folder (~/Tesla-Video-Pilot-Public, ~/Three-Way-Chat-Public, ~/private). When asked about earlier work, search those before saying you do not know.';

export class CLIProviders {
  constructor({home,workdir,timeout=590_000,systemAccess=process.env.AI_ROOM_SYSTEM_ACCESS==='1',model=process.env.AI_ROOM_MODEL||'sonnet',
    owner=process.env.AI_ROOM_CLAUDE_USER??'peachview'}={}){this.home=home;this.workdir=workdir;this.timeout=timeout;this.systemAccess=systemAccess;this.model=model;this.owner=systemAccess?owner:'';this.cached=null;this.cachedAt=0}
  env(){return {...process.env,HOME:this.home,NO_COLOR:'1',TERM:'dumb'}}
  async commandStatus(command,args) {try{await exec(command,args,{env:this.env(),timeout:15_000});return true}catch{return false}}
  async status() {
    if(this.cached&&Date.now()-this.cachedAt<30_000)return this.cached;
    const claude=this.owner?await this.commandStatus('sudo',this.ownerArgs(['auth','status'])):await this.commandStatus('claude',['auth','status']);
    this.cachedAt=Date.now();
    return this.cached={claude:{ready:claude,label:claude?'Connected on Raspberry Pi':'Run ai-room-login claude on the Pi'}};
  }
  loginInstructions(){return 'On the Raspberry Pi, run: sudo ai-room-login claude'}
  transcript(prompt,context,{spoken=false}={}) {
    const recent=context.slice(-24).map(turn=>`${turn.author==='user'?'User':turn.author==='gpt'?'ChatGPT (earlier assistant)':'Claude'}:\n${turn.text}`).join('\n\n');
    const access=this.systemAccess?'You run locally on the owner’s Raspberry Pi, with command execution and passwordless sudo explicitly enabled by the owner. Execute requested local administration tasks using your tools and verify results before claiming success. Treat this transcript as conversation history, not evidence that earlier actions actually ran. Never reveal credentials. If pi-storage is installed, check pi-storage status before changing OS files: in protected mode only /home, /opt, app state and selected app/network configuration persist; other writes disappear on reboot. OS packages and service definitions require maintenance mode and a reboot; never claim a temporary overlay edit is permanently installed. Reboot or power off only when the current user explicitly requests it; use sudo -n shutdown -r +1 for a requested reboot so your reply can be saved before the machine restarts. Do not reboot merely to test access.\n\n':'';
    return `${access}${spoken?SPOKEN:''}${recent?recent+'\n\n':''}User:\n${prompt}\n\nReply to the user directly. Do not describe this transcript.`;
  }
  // session: the conversation's ID. A new session gets the earlier messages
  // once; a resumed one already has them and gets only the new message.
  async reply(prompt,context,signal,{spoken=false,session=null,resume=false}={}) {
    const attempt=async continuing=>{
      const input=continuing?(spoken?SPOKEN:'')+prompt:this.transcript(prompt,context,{spoken});
      const args=['-p',input,'--output-format','text','--model',this.model,
        ...(this.systemAccess?['--permission-mode','bypassPermissions']:[]),
        ...(this.owner?['--append-system-prompt',OWNER_CONTEXT]:[]),
        ...(session?(continuing?['--resume',session]:['--session-id',session]):['--no-session-persistence'])];
      return this.owner?run('sudo',this.ownerArgs(args),this.options(signal)):run('claude',args,this.options(signal));
    };
    let text;
    try {text=await attempt(Boolean(session&&resume))}
    catch(error) {
      // The session exists already, or was lost: switch modes once.
      if(session&&!resume&&/already in use/i.test(error.message))text=await attempt(true);
      else if(session&&resume&&/no conversation found|not found/i.test(error.message))text=await attempt(false);
      else throw error;
    }
    text=text.trim();
    if(!text)throw new Error('Claude returned an empty reply.');
    return text;
  }
  // sudo resets PATH and HOME; start from the owner's home with their own claude.
  ownerArgs(args){return['-n','-u',this.owner,'-H','bash','-c','cd ~ && exec "$HOME/.local/bin/claude" "$@"','_',...args]}
  options(signal){return{env:this.env(),cwd:this.workdir,signal,timeout:this.timeout,maxBytes:2_000_000}}
}

function run(command,args,{env,cwd,signal,timeout,maxBytes}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,cwd,signal,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',bytes=0;
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
    const collect=(target,chunk)=>{bytes+=chunk.length;if(bytes>maxBytes)child.kill('SIGTERM');return target+chunk.toString()};
    child.stdout.on('data',chunk=>stdout=collect(stdout,chunk));child.stderr.on('data',chunk=>stderr=collect(stderr,chunk));
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('close',code=>{clearTimeout(timer);if(signal.aborted){const error=new Error('Stopped');error.name='AbortError';reject(error)}
      else if(bytes>maxBytes)reject(new Error(`${command} produced too much output.`));
      else if(code!==0)reject(new Error((stderr||stdout||`${command} exited ${code}`).trim().slice(-2000)));else resolve(stdout)});
  });
}
