import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CLIProviders} from '../providers.mjs';
import {speakable,cleanTranscript} from '../voice.mjs';

test('provider runner passes prompts as arguments without a shell',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-cli-'));
  const claude=join(dir,'claude');
  await writeFile(claude,`#!/bin/sh
if [ "$1" = auth ]; then exit 0; fi
printf '%s\\n' "$@" > '${dir}/claude-args'
printf 'Claude answer'
`);
  await chmod(claude,0o755);
  const old=process.env.PATH;process.env.PATH=dir+':'+old;
  try {
    const providers=new CLIProviders({home:dir,workdir:dir,timeout:5000});
    const state=await providers.status();assert.equal(state.claude.ready,true);assert.equal(state.gpt,undefined);
    assert.equal(await providers.reply('hello; touch /tmp/nope',[],new AbortController().signal),'Claude answer');
    const args=await readFile(join(dir,'claude-args'),'utf8');
    assert.doesNotMatch(args, /bypassPermissions/);assert.match(args,/--model\nsonnet/);assert.doesNotMatch(args,/read aloud/);
    const admin=new CLIProviders({home:dir,workdir:dir,timeout:5000,systemAccess:true,owner:''});
    await admin.reply('Check sudo.',[],new AbortController().signal,{spoken:true});
    const spoken=await readFile(join(dir,'claude-args'),'utf8');
    assert.match(spoken, /bypassPermissions/);assert.match(spoken,/read aloud/);
    assert.match(admin.transcript('Hello',[{author:'gpt',text:'old'}]), /ChatGPT \(earlier assistant\)/);
    assert.match(admin.transcript('Hello',[]), /Reboot or power off only when the current user explicitly requests it/);
    const room='11111111-2222-4333-8444-555555555555';
    await providers.reply('first',[{author:'user',text:'earlier'}],new AbortController().signal,{session:room,resume:false});
    let sent=await readFile(join(dir,'claude-args'),'utf8');
    assert.match(sent,new RegExp(`--session-id\n${room}`));assert.match(sent,/earlier/);assert.doesNotMatch(sent,/no-session-persistence/);
    await providers.reply('second',[{author:'user',text:'earlier'}],new AbortController().signal,{session:room,resume:true});
    sent=await readFile(join(dir,'claude-args'),'utf8');
    assert.match(sent,new RegExp(`--resume\n${room}`));assert.doesNotMatch(sent,/earlier/,'a resumed session already has the history');
    const owner=new CLIProviders({home:dir,workdir:dir,systemAccess:true,owner:'peachview'});
    assert.deepEqual(owner.ownerArgs(['-p','x']).slice(0,4),['-n','-u','peachview','-H']);
    assert.equal(new CLIProviders({home:dir,workdir:dir,systemAccess:false,owner:'peachview'}).owner,'','only with system access');
  } finally {process.env.PATH=old}
});

test('speech text drops markdown and noise markers',()=>{
  assert.equal(speakable('**Done.** Run `ls`:\n```\nls -la\n```\n- see https://x.y/z'),'Done. Run ls: (I put the code in the chat.) see the link in the chat');
  assert.equal(cleanTranscript(' [BLANK_AUDIO] (wind) hello  there '),'hello there');
});
