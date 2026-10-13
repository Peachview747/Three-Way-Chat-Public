'use strict';
let pendingSend = null, room = localStorage.getItem('threeway-room') || '', target = 'both', current = null, lastMessages = '', lastRooms = '', fetching = false;
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
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('The host did not respond.')); }, 15000);
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
function label(author) { return {user:'You',gpt:'GPT',claude:'Claude',system:'Room notice'}[author] || author; }
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
    $('room-title').textContent = state.rooms.find(r => r.id === room)?.title || 'Your shared room'; lastRooms = roomsKey;
  }
  for (const p of ['gpt','claude']) {
    $(p+'-status').textContent = state.connections[p].label;
    document.querySelector('[data-provider="'+p+'"]').classList.toggle('ready',state.connections[p].ready);
    $(p+'-login').hidden = state.connections[p].ready;
    $(p+'-login').disabled = state.busy || state.login_busy;
  }
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
      if (m.status !== 'complete') { const status = document.createElement('span'); status.className = 'status '+m.status; status.textContent = {working:'Replying',interrupted:'Stopped',error:'Incomplete',saved:'Saved on Pi'}[m.status] || m.status; heading.append(status); }
      const text = document.createElement('div'); text.className = 'message-text'; text.textContent = m.text || (m.status === 'working' ? 'Thinking…' : 'No reply saved.');
      content.append(heading,text); article.append(avatar,content); $('messages').append(article);
    }
    if (nearBottom || !lastMessages) $('chat').scrollTop = $('chat').scrollHeight;
    lastMessages = messagesKey;
  }
  $('send').disabled = state.busy || state.login_busy;
  $('stop').hidden = !state.busy;
  $('input').disabled = state.busy;
  $('new').disabled = state.busy;
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
    const signature = JSON.stringify({text,target,room,rounds:Number($('rounds').value)});
    if (pendingSend?.signature !== signature) pendingSend = {signature,id:crypto.randomUUID()};
    const result = await post('send',{text,target,room,rounds:Number($('rounds').value),request_id:pendingSend.id});
    pendingSend = null; $('input').value = ''; notice(result.notice || 'Saved on your Raspberry Pi.'); await refresh();
  }
  catch(e) { notice(e.message); $('send').disabled = !!current?.busy; }
};
$('input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
for (const button of document.querySelectorAll('[data-target]')) button.onclick = () => {
  target = button.dataset.target;
  for (const b of document.querySelectorAll('[data-target]')) b.classList.toggle('selected',b === button);
  $('rounds-label').hidden = target !== 'discuss';
  $('send-hint').textContent = {both:'Ask ChatGPT and Claude.',gpt:'Ask ChatGPT.',claude:'Ask Claude.',discuss:'Let ChatGPT and Claude discuss this for the selected rounds.'}[target];
};
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('input').value = button.dataset.prompt; $('input').focus(); };
$('stop').onclick = async () => { try { await post('stop'); notice('Stopping the current reply and remaining turns…'); await refresh(); } catch(e) { notice(e.message); } };
$('new').onclick = async () => { try { room = (await post('new',{request_id:crypto.randomUUID()})).room; localStorage.setItem('threeway-room',room); lastMessages=''; notice(''); await refresh(); } catch(e) { notice(e.message); } };
$('refresh').onclick = async () => { try { await refresh(); notice('Raspberry Pi host refreshed.'); } catch(e) { notice(e.message); } };
for (const provider of ['gpt','claude']) $(provider+'-login').onclick = async () => {
  try { const result = await post('login',{provider}); notice(result.notice); await refresh(); }
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
async function start() {
  if (!native && location.hash) history.replaceState(null,'',location.pathname);
  await refresh();
}
start(); setInterval(() => { if (!document.hidden && !$('pairing').open) refresh(); },3000);
