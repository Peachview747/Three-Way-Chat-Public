import {execFile,spawn} from 'node:child_process';
import {readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
const exec=promisify(execFile);

export class CLIProviders {
  constructor({home,workdir,timeout=170_000}={}){this.home=home;this.workdir=workdir;this.timeout=timeout;this.cached=null;this.cachedAt=0}
  env(){return {...process.env,HOME:this.home,NO_COLOR:'1',TERM:'dumb'}}
  async commandStatus(command,args) {try{await exec(command,args,{env:this.env(),timeout:15_000});return true}catch{return false}}
  async status() {
    if(this.cached&&Date.now()-this.cachedAt<30_000)return this.cached;
    const [gpt,claude]=await Promise.all([this.commandStatus('codex',['login','status']),this.commandStatus('claude',['auth','status'])]);
    return this.cached={gpt:{ready:gpt,label:gpt?'Connected on Raspberry Pi':'Run ai-room-login gpt on the Pi'},
      claude:{ready:claude,label:claude?'Connected on Raspberry Pi':'Run ai-room-login claude on the Pi'}};
  }
  loginInstructions(provider) {
    if(provider==='gpt')return 'On the Raspberry Pi, run: sudo ai-room-login gpt';
    if(provider==='claude')return 'On the Raspberry Pi, run: sudo ai-room-login claude';
    return 'Choose ChatGPT or Claude.';
  }
  transcript(prompt,context) {
    const recent=context.slice(-24).map(turn=>`${turn.author==='user'?'User':turn.author==='gpt'?'ChatGPT':'Claude'}:\n${turn.text}`).join('\n\n');
    return `${recent?recent+'\n\n':''}User:\n${prompt}\n\nReply to the user directly. Do not describe this transcript.`;
  }
  async reply(provider,prompt,context,signal) {
    const input=this.transcript(prompt,context);
    if(provider==='gpt') {
      const output=join(tmpdir(),`ai-room-codex-${randomUUID()}.txt`);
      try {
        await run('codex',['exec','--skip-git-repo-check','--sandbox','read-only','--color','never','--output-last-message',output,input],this.options(signal));
        const text=(await readFile(output,'utf8')).trim();if(!text)throw new Error('ChatGPT returned an empty reply.');return text;
      } finally {await unlink(output).catch(()=>{})}
    }
    if(provider==='claude') {
      const text=(await run('claude',['-p',input,'--output-format','text','--no-session-persistence','--model','claude-sonnet-4-6'],this.options(signal))).trim();
      if(!text)throw new Error('Claude returned an empty reply.');return text;
    }
    throw new Error('Unknown assistant service.');
  }
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
