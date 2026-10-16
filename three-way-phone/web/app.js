'use strict';
let pendingSend = null, room = localStorage.getItem('threeway-room') || '', current = null, lastMessages = '', lastRooms = '', fetching = false;
const $ = id => document.getElementById(id);
const notice = text => { $('notice').textContent = text; };
const native = !!window.webkit?.messageHandlers?.threeway;
let pairingPrompted = false;
const waiting = new Map();
window.threeWayReceive = encoded => {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const reply = JSON.parse(new TextDecoder().decode(bytes));
  const pending = waiting.get(reply.id); if (!pending) return;
  waiting.delete(reply.id); clearTimeout(pending.timer);
  if (reply.status >= 400) pending.reject(new Error(reply.body.error || 'Request failed.'));
  else pending.resolve(reply.body);
};
async function api(action, body = {}) {
  if (native) return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The host did not respond.')); }, action === 'voice' ? 180000 : 15000);
    waiting.set(id, {resolve, reject, timer});
    window.webkit.messageHandlers.threeway.postMessage({id, action, body});
  });
  const read = action === 'state' || action === 'export';
  const response = await fetch('/api/' + action + (action === 'state' ? '?room=' + encodeURIComponent(body.room || '') : ''), {
    method: read ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(read ? {} : {headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)})
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !pairingPrompted) { pairingPrompted = true; $('pairing').showModal(); }
    throw new Error(result.error || 'Request failed.');
  }
  return result;
}
const post = api;
function label(author) { return {user:'You',gpt:'ChatGPT',claude:'Claude',system:'Room notice'}[author] || author; }
function render(state) {
  current = state;
  if (!state.rooms.some(r => r.id === room)) { room = state.rooms[0]?.id || ''; localStorage.setItem('threeway-room',room); lastMessages = ''; }
  const roomsKey = JSON.stringify(state.rooms) + room;
  if (roomsKey !== lastRooms) {
    $('rooms').replaceChildren();
    for (const r of state.rooms) {
      const button = document.createElement('button'); button.textContent = r.title; button.title = r.title; button.className = r.id === room ? 'active' : '';
      button.onclick = () => { room = r.id; localStorage.setItem('threeway-room',room); lastMessages = ''; refresh(); };
      $('rooms').append(button);
    }
    $('room-title').textContent = state.rooms.find(r => r.id === room)?.title || 'Your conversation'; lastRooms = roomsKey;
  }
  const claude = state.connections.claude || {ready:false, label:'Not connected'};
  $('claude-status').textContent = claude.label;
  document.querySelector('[data-provider="claude"]').classList.toggle('ready', claude.ready);
  $('claude-login').hidden = claude.ready;
  renderVoices(state.voice);
  const messagesKey = JSON.stringify(state.messages);
  if (messagesKey !== lastMessages) {
    const nearBottom = $('chat').scrollHeight - $('chat').scrollTop - $('chat').clientHeight < 130;
    $('welcome').hidden = state.messages.length > 0;
    $('messages').replaceChildren();
    for (const m of state.messages) {
      const article = document.createElement('article'); article.className = 'message ' + m.author + ' ' + m.status;
      const avatar = document.createElement('span'); avatar.className = 'avatar ' + (m.author === 'user' ? 'you' : m.author); avatar.textContent = {gpt:'G',claude:'C',user:'Y',system:'!'}[m.author];
      const content = document.createElement('div'); content.className = 'message-content';
      const heading = document.createElement('div'); heading.className = 'message-heading';
      const name = document.createElement('span'); name.textContent = label(m.author); heading.append(name);
      const time = document.createElement('time'); time.textContent = new Date(m.created*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); heading.append(time);
      if (m.spoken) { const spoken = document.createElement('span'); spoken.className = 'status spoken'; spoken.textContent = 'Spoken'; heading.append(spoken); }
      if (m.status !== 'complete') { const status = document.createElement('span'); status.className = 'status '+m.status; status.textContent = {working:'Replying',interrupted:'Stopped',error:'Incomplete',saved:'Saved on Pi'}[m.status] || m.status; heading.append(status); }
      const text = document.createElement('div'); text.className = 'message-text'; text.textContent = m.text || (m.status === 'working' ? 'Thinking…' : 'No reply saved.');
      content.append(heading,text); article.append(avatar,content); $('messages').append(article);
    }
    if (nearBottom || !lastMessages) $('chat').scrollTop = $('chat').scrollHeight;
    lastMessages = messagesKey;
  }
  $('send').disabled = state.busy || state.login_busy;
  $('stop').hidden = !state.busy || voice.active;
  $('input').disabled = state.busy;
  $('new').disabled = state.busy;
  for (const id of ['talk','talk-header','talk-welcome']) $(id).hidden = !state.voice?.available;
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const state = await api('state',{room});
    if (!state.rooms.some(r => r.id === room)) { room = state.rooms[0]?.id || ''; fetching = false; return refresh(); }
    render(state);
  } catch(e) { notice(e.message); $('send').disabled = true; $('new').disabled = true; }
  finally { fetching = false; }
}
$('composer').onsubmit = async event => {
  event.preventDefault();
  const text = $('input').value.trim(); if (!text) return;
  $('send').disabled = true;
  try {
    const signature = JSON.stringify({text,room});
    if (pendingSend?.signature !== signature) pendingSend = {signature,id:crypto.randomUUID()};
    const result = await post('send',{text,target:'claude',room,rounds:1,request_id:pendingSend.id});
    pendingSend = null; $('input').value = ''; notice(result.notice || 'Saved on your Raspberry Pi.'); await refresh();
  }
  catch(e) { notice(e.message); $('send').disabled = !!current?.busy; }
};
$('input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('stop').onclick = async () => { try { await post('stop'); notice('Stopping Claude’s reply…'); await refresh(); } catch(e) { notice(e.message); } };
$('new').onclick = async () => { try { room = (await post('new',{request_id:crypto.randomUUID()})).room; localStorage.setItem('threeway-room',room); lastMessages=''; notice(''); await refresh(); } catch(e) { notice(e.message); } };
$('refresh').onclick = async () => { try { await refresh(); notice('Raspberry Pi host refreshed.'); } catch(e) { notice(e.message); } };
$('claude-login').onclick = async () => {
  try { const result = await post('login',{provider:'claude'}); notice(result.notice); await refresh(); }
  catch(e) { notice(e.message); }
};
$('connections-button').onclick = () => {
  if (!native && !current) $('pairing').showModal();
  else $('connections').hidden = !$('connections').hidden;
};
$('about-button').onclick = () => $('about').showModal();
$('export').onclick = async () => {
  try { const result = await api('export'); if (native) { await api('share'); return; } const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'})); const link = document.createElement('a'); link.href=url; link.download='ai-room-conversations.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  catch(e) { notice('Could not export conversations.'); }
};
async function pair(pin) {
  const response = await fetch('/api/session', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
  pairingPrompted = false; $('pairing').close(); notice('Connecting to Raspberry Pi…'); await refresh();
}
$('pairing-form').onsubmit = async event => { event.preventDefault(); try { await pair($('pair-pin').value.trim()); $('pair-pin').value = ''; $('pairing-error').textContent = ''; } catch(e) { $('pairing-error').textContent = e.message; } };

// ---- Voice ----
// Hands-free: no button to hold and no text box. The page listens, notices when
// you stop talking, sends that turn to the Pi (speech recognition, Claude and
// the voice all run there), plays the answer and listens again. The microphone
// is ignored while Claude speaks so the car speakers do not answer themselves.
const VOICE_KEY = 'airoom-voice';
const SAMPLE_RATE = 16000;
const voice = {active:false, state:'idle', stream:null, context:null, source:null, processor:null, chunks:[], preroll:[],
  speaking:false, speechMs:0, silenceMs:0, floor:0.004, levels:[], muted:false, player:null, turn:null};
// Tuned for a car cabin: speech must rise clearly above the running noise
// floor, and a pause of about a second ends the turn.
// The background level is learned, not fixed: the quiet end (15th percentile)
// of the last six seconds. Steady road noise becomes that baseline, and only
// sound clearly above it (a voice) counts as talking.
const VAD = {frameMs:0, startMs:180, endMs:1100, minSpeechMs:350, maxMs:60000, prerollMs:350,
  startRatio:2.1, endRatio:1.9, minLevel:0.008, floorWindowMs:6000, calibrateMs:900};
function voiceChoice() { return localStorage.getItem(VOICE_KEY) || current?.voice?.default || ''; }
let lastVoices = '';
function renderVoices(info) {
  const key = JSON.stringify(info?.voices || []);
  if (key === lastVoices) return;
  lastVoices = key;
  $('voice-choice').replaceChildren(...(info?.voices || []).map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option; }));
  $('voice-choice').value = voiceChoice();
  $('voice-choice').closest('.connection').hidden = !info?.available;
}
$('voice-choice').onchange = () => localStorage.setItem(VOICE_KEY, $('voice-choice').value);
$('voice-preview').onclick = async () => {
  $('voice-preview').disabled = true;
  try { const result = await api('speak',{voice:$('voice-choice').value}); await playAudio(result.audio, result.mime); }
  catch (e) { notice(e.message); }
  finally { $('voice-preview').disabled = false; }
};
function audioPlayer() { if (!voice.player) voice.player = new Audio(); return voice.player; }
function playAudio(base64, mime = 'audio/mpeg') {
  return new Promise(resolve => {
    if (!base64) { resolve(); return; }
    const player = audioPlayer();
    player.onended = player.onerror = () => resolve();
    player.src = `data:${mime};base64,${base64}`;
    player.play().catch(() => resolve());
  });
}
function setVoiceState(state, text) {
  voice.state = state;
  $('voice').dataset.state = state;
  $('voice-state').textContent = text;
}
async function startVoice() {
  if (voice.active) return;
  if (!navigator.mediaDevices?.getUserMedia) { notice('This browser does not let pages use the microphone.'); return; }
  $('voice').hidden = false; showHeard('', false); $('voice-reply').textContent = '';
  setVoiceState('starting','Starting the microphone…');
  // Play something silent inside the tap so later replies are allowed to play.
  audioPlayer().src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; audioPlayer().play().catch(() => {});
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}});
  } catch (e) {
    setVoiceState('error', e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this site, then try again.' : 'No microphone is available here.');
    return;
  }
  const Context = window.AudioContext || window.webkitAudioContext;
  voice.context = new Context();
  await voice.context.resume().catch(() => {});
  voice.source = voice.context.createMediaStreamSource(voice.stream);
  voice.processor = voice.context.createScriptProcessor(2048, 1, 1);
  voice.processor.onaudioprocess = event => hear(event.inputBuffer.getChannelData(0));
  // Road noise is mostly low rumble (tyres, wind) and some hiss. Speech lives
  // roughly between 120 Hz and 5 kHz, so cut below and above before the page
  // judges whether someone is talking and before recording the turn.
  const rumble = voice.context.createBiquadFilter(); rumble.type = 'highpass'; rumble.frequency.value = 120; rumble.Q.value = 0.7;
  const hiss = voice.context.createBiquadFilter(); hiss.type = 'lowpass'; hiss.frequency.value = 5000; hiss.Q.value = 0.7;
  voice.source.connect(rumble); rumble.connect(hiss); hiss.connect(voice.processor); voice.processor.connect(voice.context.destination);
  voice.filters = [rumble, hiss];
  VAD.frameMs = 2048 / voice.context.sampleRate * 1000;
  voice.active = true; setMuted(false);
  try { voice.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  listen();
}
function listen() {
  if (!voice.active) return;
  voice.chunks = []; voice.speaking = false; voice.speechMs = 0; voice.silenceMs = 0;
  setVoiceState(voice.muted ? 'paused' : 'listening', voice.muted ? 'Mic muted. Tap Unmute when you want to talk.' : 'Listening…');
}
// Every ~45 ms of microphone audio: track the noise floor, find the start and
// end of speech, and keep the samples of the turn (plus a little before it).
function hear(samples) {
  if (!voice.active) return;
  let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const level = Math.sqrt(sum / samples.length);
  $('voice-ring').style.setProperty('--level', String(Math.min(1, level * 12)));
  voice.levels.push(level);
  while (voice.levels.length * VAD.frameMs > VAD.floorWindowMs) voice.levels.shift();
  if (voice.state !== 'listening') return;
  const copy = new Float32Array(samples);
  const sorted = [...voice.levels].sort((a, b) => a - b);
  voice.floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  // Still learning the room: keep the pre-roll, start nothing.
  const calibrated = voice.levels.length * VAD.frameMs >= VAD.calibrateMs;
  const loud = calibrated && level > Math.max(VAD.minLevel, voice.floor * (voice.speaking ? VAD.endRatio : VAD.startRatio));
  if (!voice.speaking) {
    voice.preroll.push(copy);
    while (voice.preroll.length * VAD.frameMs > VAD.prerollMs + VAD.startMs) voice.preroll.shift();
    if (loud) voice.speechMs += VAD.frameMs;
    else voice.speechMs = 0;
    if (voice.speechMs >= VAD.startMs) {
      voice.speaking = true; voice.chunks = voice.preroll; voice.preroll = []; voice.silenceMs = 0;
      voice.utterance = crypto.randomUUID(); voice.previewAt = Date.now(); showHeard('', false);
      setVoiceState('hearing','Listening…');
      voice.state = 'listening'; $('voice').dataset.state = 'hearing';
    }
    return;
  }
  voice.chunks.push(copy);
  voice.speechMs += VAD.frameMs;
  voice.silenceMs = loud ? 0 : voice.silenceMs + VAD.frameMs;
  previewSpeech();
  if (voice.silenceMs >= VAD.endMs || voice.chunks.length * VAD.frameMs >= VAD.maxMs) {
    const chunks = voice.chunks; voice.chunks = []; voice.speaking = false;
    if (voice.speechMs - voice.silenceMs < VAD.minSpeechMs) { listen(); return; }
    void sendTurn(chunks);
  }
}
// The shadow box: what the Pi hears so far, refreshed every couple of seconds
// while you talk (one request at a time), then the final words in full.
const PREVIEW_MS = 2000;
function showHeard(text, final) {
  $('voice-heard').textContent = text;
  $('voice-heard').classList.toggle('final', final);
  $('voice-heard').hidden = !text;
}
function previewSpeech() {
  const now = Date.now();
  if (voice.previewing || voice.speechMs < 1000 || now - (voice.previewAt || 0) < PREVIEW_MS) return;
  voice.previewing = true; voice.previewAt = now;
  const utterance = voice.utterance, audio = encodeWav(voice.chunks, voice.context.sampleRate);
  api('hear',{audio}).then(result => {
    if (voice.utterance === utterance && voice.speaking && result.text) showHeard(result.text + ' …', false);
  }).catch(() => {}).finally(() => { voice.previewing = false; });
}
async function sendTurn(chunks) {
  setVoiceState('thinking','Thinking…');
  startThinkingSound();
  const turn = voice.turn = crypto.randomUUID();
  voice.utterance = turn;
  try {
    const heard = (await api('hear',{audio:encodeWav(chunks, voice.context.sampleRate)})).text;
    if (voice.turn !== turn || !voice.active) return;
    if (!heard || !/[a-z0-9]/i.test(heard)) { stopThinkingSound(); showHeard('', false); listen(); return; }
    showHeard(heard, true);
    $('voice-reply').textContent = '';
    const result = await api('voice',{request_id:turn, room, text:heard, voice:voiceChoice()});
    if (voice.turn !== turn || !voice.active) return;
    stopThinkingSound();
    $('voice-reply').textContent = result.reply;
    void refresh();
    setVoiceState('speaking','Claude is speaking. Tap to interrupt.');
    await playAudio(result.audio, result.mime);
  } catch (e) {
    stopThinkingSound();
    if (voice.turn !== turn || !voice.active) return;
    setVoiceState('error', e.message || 'That did not go through.');
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  if (voice.turn === turn) listen();
}
// A soft two-note chime every 1.6 s while Claude works, made in the browser.
function chime() {
  const context = voice.context; if (!context || context.state !== 'running') return;
  const now = context.currentTime;
  for (const [offset, pitch] of [[0, 587.33], [0.16, 880]]) {
    const tone = context.createOscillator(), level = context.createGain();
    tone.type = 'sine'; tone.frequency.value = pitch;
    level.gain.setValueAtTime(0.0001, now + offset);
    level.gain.exponentialRampToValueAtTime(0.07, now + offset + 0.02);
    level.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.35);
    tone.connect(level); level.connect(context.destination);
    tone.start(now + offset); tone.stop(now + offset + 0.4);
  }
}
function startThinkingSound() { stopThinkingSound(); chime(); voice.thinkingTimer = setInterval(chime, 1600); }
function stopThinkingSound() { clearInterval(voice.thinkingTimer); voice.thinkingTimer = null; }
// Mono 16 kHz 16-bit WAV, base64: small enough to send, and every browser can make it.
function encodeWav(chunks, rate) {
  let total = 0; for (const chunk of chunks) total += chunk.length;
  const step = rate / SAMPLE_RATE, length = Math.floor(total / step);
  const view = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0,'RIFF'); view.setUint32(4, 36 + length * 2, true); text(8,'WAVE'); text(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,SAMPLE_RATE,true);
  view.setUint32(28,SAMPLE_RATE*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); text(36,'data'); view.setUint32(40,length*2,true);
  let chunkIndex = 0, offset = 0, position = 0;
  for (let i = 0; i < length; i++) {
    // Average the source samples that fall into this output sample.
    const end = (i + 1) * step; let sum = 0, count = 0;
    while (position < end && chunkIndex < chunks.length) {
      sum += chunks[chunkIndex][offset]; count++; position++;
      if (++offset >= chunks[chunkIndex].length) { chunkIndex++; offset = 0; }
    }
    const sample = Math.max(-1, Math.min(1, count ? sum / count : 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  const bytes = new Uint8Array(view.buffer); let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function stopVoice() {
  voice.active = false; voice.turn = null; stopThinkingSound();
  try { voice.player?.pause(); } catch {}
  try { voice.processor?.disconnect(); voice.source?.disconnect(); for (const filter of voice.filters || []) filter.disconnect(); } catch {}
  for (const track of voice.stream?.getTracks() || []) track.stop();
  voice.context?.close().catch(() => {});
  voice.wakeLock?.release?.().catch?.(() => {});
  Object.assign(voice, {stream:null, context:null, source:null, processor:null, chunks:[], preroll:[], levels:[], wakeLock:null});
  $('voice').hidden = true; setVoiceState('idle','');
  if (current?.busy) post('stop').catch(() => {});
  void refresh();
}
$('voice-end').onclick = stopVoice;
// Tap the orb: interrupt Claude, or stop waiting for a reply, and listen again.
$('voice-orb').onclick = () => {
  if (voice.state === 'speaking') { try { voice.player.pause(); voice.player.onended?.(); } catch {} return; }
  if (voice.state === 'thinking') { voice.turn = null; stopThinkingSound(); post('stop').catch(() => {}); listen(); return; }
  if (voice.state === 'error') listen();
};
// Mute turns the microphone itself off (not just ignored), so road and cabin
// noise cannot start a turn. Claude can still finish what it is saying.
function setMuted(muted) {
  voice.muted = muted;
  for (const track of voice.stream?.getAudioTracks() || []) track.enabled = !muted;
  $('voice-mute').textContent = muted ? '🔇 Mic muted · tap to unmute' : '🎤 Mute mic';
  $('voice-mute').setAttribute('aria-pressed', muted ? 'true' : 'false');
  $('voice-mute').classList.toggle('muted', muted);
  $('voice').classList.toggle('mic-muted', muted);
}
$('voice-mute').onclick = () => {
  setMuted(!voice.muted);
  if (voice.state === 'listening' || voice.state === 'paused' || $('voice').dataset.state === 'hearing') listen();
};
for (const id of ['talk','talk-header','talk-welcome']) $(id).onclick = () => void startVoice();

async function start() {
  if (!native && location.hash) history.replaceState(null,'',location.pathname);
  await refresh();
}
start(); setInterval(() => { if (!document.hidden && !$('pairing').open && !voice.active) refresh(); },3000);
