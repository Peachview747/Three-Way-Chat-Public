'use strict';
const $ = id => document.getElementById(id);
let paired = false, busy = false, lastMessages = '';
function credentials(link) {
  const url = new URL(link);
  if (url.origin !== location.origin) throw new Error('Use the link for this website.');
  const params = new URLSearchParams(url.hash.slice(1));
  if (!params.get('room') || !params.get('key')) throw new Error('The private link is incomplete.');
  return { room: params.get('room'), key: params.get('key') };
}
async function call(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Connection failed.'); error.status = response.status; throw error; }
  return data;
}
async function pair(link) {
  await call('/api/session', credentials(link)); $('pair-link').value = ''; await refresh();
}
function render(state) {
  paired = true;
  $('pair-card').hidden = true; $('logout').hidden = false;
  $('status').textContent = state.connected ? 'iPhone connected' : 'iPhone is offline';
  $('dot').classList.toggle('connected', state.connected);
  $('detail').textContent = state.connected ? 'Messages can travel between the app and this website.' : 'Open Three Way on the iPhone and tap Connect.';
  $('text').disabled = !state.connected; $('send').disabled = !state.connected || busy;
  $('send-note').textContent = state.connected ? 'Saved when the connection accepts it.' : 'Connect the iPhone app to send.';
  $('empty').hidden = state.messages.length > 0;
  const signature = JSON.stringify(state.messages);
  if (signature === lastMessages) return;
  lastMessages = signature; $('messages').replaceChildren();
  for (const message of state.messages) {
    const row = document.createElement('article'); row.className = 'message ' + message.source;
    const title = document.createElement('strong'); title.textContent = message.source === 'iphone' ? 'Your iPhone' : 'Your browser';
    const time = document.createElement('time'); time.dateTime = message.created; time.textContent = new Date(message.created).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const text = document.createElement('p'); text.textContent = message.text;
    row.append(title, time, text); $('messages').append(row);
  }
}
async function refresh() {
  if (busy) return;
  try { render(await call('/api/state')); $('error').textContent = ''; }
  catch (error) {
    $('dot').classList.remove('connected'); $('text').disabled = true; $('send').disabled = true;
    if (error.status === 401) {
      paired = false; $('pair-card').hidden = false; $('logout').hidden = true;
      $('status').textContent = 'Pair this browser'; $('detail').textContent = 'Use the private website link shared from the iPhone app.';
      $('messages').replaceChildren(); lastMessages = ''; $('empty').hidden = false;
    } else { $('status').textContent = 'Connection interrupted'; $('detail').textContent = 'Checking the website connection…'; $('error').textContent = error.message; }
  }
}
$('pair-form').addEventListener('submit', async event => { event.preventDefault(); try { await pair($('pair-link').value.trim()); } catch (error) { $('error').textContent = error.message; } });
$('composer').addEventListener('submit', async event => {
  event.preventDefault(); if (!paired || busy || !$('text').value.trim()) return;
  $('error').textContent = '';
  busy = true; $('send').disabled = true;
  // Keep the ID on an uncertain network failure so an explicit retry is idempotent.
  const text = $('text').value.trim();
  if ($('text').dataset.pendingText !== text) { $('text').dataset.pendingText = text; $('text').dataset.pendingId = crypto.randomUUID(); }
  try { await call('/api/message', { id: $('text').dataset.pendingId, text }); $('text').value = ''; delete $('text').dataset.pendingText; delete $('text').dataset.pendingId; }
  catch (error) { $('error').textContent = error.message; }
  finally { busy = false; }
  const failure = $('error').textContent; await refresh(); if (failure) $('error').textContent = failure;
});
$('refresh').addEventListener('click', () => { void refresh(); });
$('logout').addEventListener('click', async () => { try { await call('/api/logout', {}); await refresh(); } catch (error) { $('error').textContent = error.message; } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden && paired) void refresh(); }, 5000);
const initialLink = location.href;
// The fragment is never sent to Cloudflare and is removed before other requests.
history.replaceState(null, '', location.pathname);
if (new URL(initialLink).hash) pair(initialLink).catch(error => { $('error').textContent = error.message; });
else void refresh();
