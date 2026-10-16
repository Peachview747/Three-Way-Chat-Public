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
    const admin=new CLIProviders({home:dir,workdir:dir,timeout:5000,systemAccess:true});
    await admin.reply('Check sudo.',[],new AbortController().signal,{spoken:true});
    const spoken=await readFile(join(dir,'claude-args'),'utf8');
    assert.match(spoken, /bypassPermissions/);assert.match(spoken,/read aloud/);
    assert.match(admin.transcript('Hello',[{author:'gpt',text:'old'}]), /ChatGPT \(earlier assistant\)/);
    assert.match(admin.transcript('Hello',[]), /Reboot or power off only when the current user explicitly requests it/);
  } finally {process.env.PATH=old}
});

test('speech text drops markdown and noise markers',()=>{
  assert.equal(speakable('**Done.** Run `ls`:\n```\nls -la\n```\n- see https://x.y/z'),'Done. Run ls: (I put the code in the chat.) see the link in the chat');
  assert.equal(cleanTranscript(' [BLANK_AUDIO] (wind) hello  there '),'hello there');
});
