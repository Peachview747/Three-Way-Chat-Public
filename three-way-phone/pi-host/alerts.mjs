// Spoken alerts for the portal: every 30 s the Pi checks for finished
// downloads and for trouble (heat, power, a stopped service, no internet,
// a full disk). Open portal pages fetch new alerts, show them and say them
// in Claude's voice. Each problem is announced at most once an hour.
const CHECK_MS = 30_000, REPEAT_MS = 60 * 60_000, OUTAGE_MS = 5 * 60_000, KEEP = 50;

export class Alerts {
  constructor({health, fetcher = globalThis.fetch, now = () => Date.now(), videoPilot = 'http://127.0.0.1:5001'}) {
    this.health = health; this.fetch = fetcher; this.now = now; this.videoPilot = videoPilot;
    this.list = []; this.nextId = 1; this.ready = null; this.lastSaid = new Map(); this.started = new Map();
  }
  start() { const tick = () => this.check().catch(() => {}); setTimeout(tick, 5000); setInterval(tick, CHECK_MS).unref?.(); return this; }
  add(text, kind = 'info') {
    const alert = {id: this.nextId++, at: this.now(), kind, text};
    this.list.push(alert); if (this.list.length > KEEP) this.list.shift();
    return alert;
  }
  since(id) { return {alerts: this.list.filter(alert => alert.id > Number(id || 0)), latest: this.nextId - 1}; }

  // A problem key that is true now: announce once it has lasted `after` ms,
  // then not again for an hour.
  problem(key, active, text, after = 0) {
    if (!active) { this.started.delete(key); return; }
    if (!this.started.has(key)) this.started.set(key, this.now());
    if (this.now() - this.started.get(key) < after) return;
    if (this.lastSaid.has(key) && this.now() - this.lastSaid.get(key) < REPEAT_MS) return;
    this.lastSaid.set(key, this.now());
    this.add(text, 'problem');
  }

  async check() {
    await this.checkDownloads().catch(() => {});
    const h = await this.health();
    const v = h.vitals;
    this.problem('hot', v.temperature >= 80, `Heads up: the Pi is running hot, ${Math.round(v.temperature)} degrees.`);
    this.problem('power', v.power.undervoltageNow, 'Heads up: the Pi is getting low power. Check its power supply.');
    for (const s of h.services) this.problem(`service:${s.id}`, !['active', 'activating', 'reloading'].includes(s.active),
      `Heads up: ${s.label} has stopped on the Pi.`, 60_000);
    this.problem('internet', !h.network.internet, 'Heads up: the Pi has been offline for five minutes.', OUTAGE_MS);
    const data = v.disks.find(disk => disk.path !== '/');
    if (data) this.problem('disk', data.free / data.total < 0.1, `Heads up: the Pi is almost out of space, ${Math.round(data.free / 1e9)} gigabytes left.`);
  }

  async checkDownloads() {
    const response = await this.fetch(`${this.videoPilot}/api/library`, {signal: AbortSignal.timeout(10_000)});
    if (!response.ok) return;
    const ready = (await response.json()).filter(video => video.state === 'ready');
    const ids = new Set(ready.map(video => video.id));
    if (this.ready) {
      const fresh = ready.filter(video => !this.ready.has(video.id));
      if (fresh.length === 1) this.add(`Your video, ${shortTitle(fresh[0].title)}, is ready to watch.`, 'download');
      else if (fresh.length > 1) this.add(`${fresh.length} new videos are ready to watch.`, 'download');
    }
    this.ready = ids;
  }
}

// Long YouTube titles are tiring to hear; keep the first part.
export function shortTitle(title = 'your video') {
  const clean = String(title).replace(/\s*[|(\[].*$/, '').trim() || String(title);
  const words = clean.split(/\s+/);
  return words.length > 10 ? words.slice(0, 10).join(' ') + '…' : clean;
}
