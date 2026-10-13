import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CLIProviders} from '../providers.mjs';

test('provider runner passes prompts as arguments without a shell',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-room-cli-'));
  const codex=join(dir,'codex'),claude=join(dir,'claude');
  await writeFile(codex,`#!/bin/sh
if [ "$1" = login ]; then exit 0; fi
printf '%s\\n' "$@" > '${dir}/codex-args'
while [ $# -gt 0 ]; do if [ "$1" = --output-last-message ]; then shift; out=$1; fi; shift; done
printf 'Codex answer' > "$out"
`);
  await writeFile(claude,`#!/bin/sh
if [ "$1" = auth ]; then exit 0; fi
printf '%s\\n' "$@" > '${dir}/claude-args'
printf 'Claude answer'
`);
  await chmod(codex,0o755);await chmod(claude,0o755);
  const old=process.env.PATH;process.env.PATH=dir+':'+old;
  try {
    const providers=new CLIProviders({home:dir,workdir:dir,timeout:5000});
    const state=await providers.status();assert.equal(state.gpt.ready,true);assert.equal(state.claude.ready,true);
    assert.equal(await providers.reply('gpt','hello; touch /tmp/nope',[],new AbortController().signal),'Codex answer');
    assert.equal(await providers.reply('claude','hello',[],new AbortController().signal),'Claude answer');
    assert.match(await readFile(join(dir,'codex-args'),'utf8'), /read-only/);
    assert.doesNotMatch(await readFile(join(dir,'claude-args'),'utf8'), /bypassPermissions/);
    const admin=new CLIProviders({home:dir,workdir:dir,timeout:5000,systemAccess:true});
    await admin.reply('gpt','Check sudo.',[],new AbortController().signal);
    await admin.reply('claude','Check sudo.',[],new AbortController().signal);
    assert.match(await readFile(join(dir,'codex-args'),'utf8'), /danger-full-access/);
    assert.match(await readFile(join(dir,'claude-args'),'utf8'), /bypassPermissions/);
    assert.match(admin.transcript('Hello',[]), /Reboot or power off only when the current user explicitly requests it/);
  } finally {process.env.PATH=old}
});
