import test from 'node:test';
import assert from 'node:assert/strict';
import {Alerts,shortTitle} from '../alerts.mjs';

const healthy = (over = {}) => ({vitals:{temperature:55,power:{undervoltageNow:false},disks:[{path:'/srv/pi-data',free:50e9,total:90e9}],...over.vitals},
  services:over.services||[{id:'video-pilot',label:'Video Pilot',active:'active'}],network:{internet:true,...over.network}});

test('finished downloads are announced once; the first check only learns what exists', async () => {
  let library = [{id:'a',state:'ready',title:'Old'}];
  const fetcher = async () => ({ok:true,json:async () => library});
  const alerts = new Alerts({health:async () => healthy(),fetcher});
  await alerts.check(); assert.equal(alerts.since(0).alerts.length, 0);
  library = [...library, {id:'b',state:'ready',title:'The FBI Most Valuable Agent | Full Documentary (2026)'}, {id:'c',state:'preparing',title:'Later'}];
  await alerts.check();
  assert.deepEqual(alerts.since(0).alerts.map(a => a.text), ['Your video, The FBI Most Valuable Agent, is ready to watch.']);
  await alerts.check(); assert.equal(alerts.since(0).alerts.length, 1, 'not repeated');
  assert.equal(alerts.since(1).alerts.length, 0); assert.equal(alerts.since(0).latest, 1);
});

test('problems wait for outages, then repeat at most hourly', async () => {
  const clock = {now:0};
  let state = healthy({network:{internet:false},vitals:{temperature:83}});
  const alerts = new Alerts({health:async () => state,fetcher:async () => ({ok:false}),now:() => clock.now});
  await alerts.check();
  assert.deepEqual(alerts.since(0).alerts.map(a => a.text), ['Heads up: the Pi is running hot, 83 degrees.'], 'heat at once, offline only after 5 min');
  clock.now += 5 * 60_000; await alerts.check();
  assert.match(alerts.since(0).alerts.at(-1).text, /offline for five minutes/);
  clock.now += 10 * 60_000; await alerts.check(); assert.equal(alerts.since(0).alerts.length, 2, 'no repeats within the hour');
  clock.now += 60 * 60_000; await alerts.check(); assert.equal(alerts.since(0).alerts.length, 4, 'both again after an hour');
  assert.equal(shortTitle('One two three four five six seven eight nine ten eleven'), 'One two three four five six seven eight nine ten…');
});
