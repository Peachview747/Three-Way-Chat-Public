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
      const avatar = document.createElement('span'); avatar.className = 'avatar ' + (m.author === 'user' ? 'you' : m.author); if (m.author === 'claude') avatar.replaceChildren(claudeMark()); else avatar.textContent = {gpt:'G',user:'Y',system:'!'}[m.author];
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
// The Claude Spark mark (official press-kit path), in the text colour.
function claudeMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 94 94'); svg.setAttribute('width', '64%'); svg.setAttribute('height', '64%'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor'); path.setAttribute('d', 'M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z');
  svg.appendChild(path);
  return svg;
}
const SAMPLE_RATE = 16000;
const voice = {active:false, state:'idle', stream:null, context:null, source:null, processor:null, chunks:[], preroll:[],
  speaking:false, speechMs:0, silenceMs:0, floor:0.004, levels:[], muted:false, player:null, turn:null, amp:0};
// Tuned for a car cabin: speech must rise clearly above the running noise
// floor, and a pause of about a second ends the turn.
// The background level is learned, not fixed: the quiet end (15th percentile)
// of the last six seconds. Steady road noise becomes that baseline, and only
// sound clearly above it (a voice) counts as talking.
const VAD = {frameMs:0, startMs:180, endMs:1100, minSpeechMs:350, maxMs:60000, prerollMs:350,
  startRatio:2.1, endRatio:1.9, minLevel:0.008, floorWindowMs:6000, calibrateMs:900};
function voiceChoice() { return localStorage.getItem(VOICE_KEY) || current?.voice?.default || ''; }
// The voice orb: seven bars that rise with the microphone and shrink to dots when it's quiet.
const BARS = 7;
let orbLevel = 0;
function drawVoiceOrb(now) {
  requestAnimationFrame(drawVoiceOrb);
  const canvas = $('voice-bars');
  if (!voice.active || !canvas) return;
  const ctx = canvas.getContext('2d'), size = canvas.width, t = now / 1000;
  let amp = voice.amp;
  if (voice.state === 'thinking' || voice.state === 'speaking') amp = 0.35 + 0.25 * Math.sin(t * 3.2);
  amp = Math.max(0, Math.min(1, amp));
  // Ease toward the target so the bars glide instead of jumping with each audio frame.
  orbLevel += (amp - orbLevel) * 0.12;
  amp = orbLevel;
  const gap = size * 0.05, width = (size * 0.8 - gap * (BARS - 1)) / BARS, maxHeight = size * 0.8;
  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const wave = 0.55 + 0.45 * Math.sin(t * 5 + i * 1.3);
    const height = Math.max(width, maxHeight * amp * wave);
    bars.push([size * 0.1 + i * (width + gap), size / 2 - height / 2, width, height]);
  }
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(217, 138, 99, 0.35)';
  for (const [x, y, w, h] of bars) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, w / 2); else ctx.rect(x, y, w, h);
    ctx.fill();
  }
}
requestAnimationFrame(drawVoiceOrb);
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
  $('voice').hidden = false; showHeard('', false);
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
  voice.amp = Math.min(1, level * 12);
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
    const result = await api('voice',{request_id:turn, room, text:heard, voice:voiceChoice()});
    if (voice.turn !== turn || !voice.active) return;
    stopThinkingSound();
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
