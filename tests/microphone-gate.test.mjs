import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../client/src/engine.js';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const details = { name: 'Mic test' };

async function harness(t, { assembly = false, micDenied = false, pendingMic = false, micThrow = null, worklet = false } = {}) {
  const originals = new Map();
  const put = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const store = new Map(), deadlines = new Map(), intervals = new Map(), requests = [], recognizers = [], sockets = [], screens = [], taps = [];
  let seq = 0, releaseMic, clockOffset = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + clockOffset;
  class WorkletNode {
    constructor(ctx, name) { this.name = name; this.port = { onmessage: null, close() {} }; taps.push(this); }
    connect() {}
    disconnect() {}
    chunk(rms = 0.1) { this.port.onmessage?.({ data: { pcm: new ArrayBuffer(3200), rms } }); }
  }
  if (worklet) put('AudioWorkletNode', WorkletNode);
  const track = () => ({ readyState: 'live', getSettings: () => ({ displaySurface: 'monitor' }),
    addEventListener(type, fn) { this[type] = fn; }, stop() { this.readyState = 'ended'; } });
  const micTrack = track();
  const mic = { getTracks: () => [micTrack], getAudioTracks: () => [micTrack] };
  class SR {
    constructor() { recognizers.push(this); }
    start() { this.onstart?.(); }
    stop() { this.stopped = true; }
    say(text) { const result = [{ transcript: text }]; result.isFinal = true;
      this.onresult?.({ resultIndex: 0, results: [result] }); }
  }
  class WS {
    constructor(url) { this.url = String(url || ''); sockets.push(this); this.readyState = 1; this.sent = []; }
    close() { this.closed = true; }
    send(data) { this.sent.push(data); }
    heartbeat() { this.onmessage?.({ data: JSON.stringify({ type: 'Heartbeat' }) }); }
    say(text) { this.onmessage?.({ data: JSON.stringify({ type: 'Turn', transcript: text, end_of_turn: false }) }); }
    turn(text, extra = {}) {
      this.onmessage?.({ data: JSON.stringify({
        type: 'Turn', transcript: text, end_of_turn: true, turn_is_formatted: false, ...extra,
      }) });
    }
  }
  class AC {
    sampleRate = 16000;
    state = 'running';
    resume() { this.resumed = true; this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    audioWorklet = worklet ? { addModule: async (url) => { this.moduleUrl = String(url); } } : undefined;
  }
  put('window', { SpeechRecognition: SR, AudioContext: AC, addEventListener() {}, removeEventListener() {} });
  put('document', { hidden: false, createElement: () => ({ play: () => Promise.resolve() }), addEventListener() {}, removeEventListener() {} });
  put('localStorage', { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) });
  put('navigator', { mediaDevices: {
    getDisplayMedia: async () => { const tr = track(); screens.push(tr); return { getTracks: () => [tr], getVideoTracks: () => [tr] }; },
    getUserMedia: async () => {
      if (micDenied) throw micThrow || new Error('denied');
      if (pendingMic) return new Promise(resolve => { releaseMic = () => resolve(mic); });
      return mic;
    }
  } });
  put('WebSocket', WS);
  put('setTimeout', (fn, ms) => { const id = ++seq; deadlines.set(id, { fn, ms }); return id; });
  put('clearTimeout', id => deadlines.delete(id));
  put('setInterval', (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms }); return id; });
  put('clearInterval', id => intervals.delete(id));
  put('fetch', async (url) => {
    requests.push(url);
    if (url.includes('/session?')) return { ok: true, json: async () => ({ status: 'unused', sessionToken: 'unit-test-owner' }) };
    if (url.endsWith('/transcribe-token')) return { ok: assembly, json: async () => ({ token: 'test' }) };
    return { ok: true, json: async () => ({ ok: true, startedAt: Date.now(), assessment: { title: 'Hidden brief', durationSeconds: 900 } }) };
  });
  // These tests isolate microphone lifecycle; browser regressions exercise
  // the real IndexedDB recording store and HTTP ownership protocol.
  const engine = createEngine('TEST01', { recordingStore: {
    list: async () => [], put: async () => {}, remove: async () => {},
  } });
  t.after(() => {
    engine.destroy();
    Date.now = realNow;
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
  });
  engine.boot();
  await flush();
  return { engine, recognizers, sockets, screens, micTrack, store, taps,
    releaseMic: () => releaseMic(),
    advance: ms => { clockOffset += ms; },
    watchdogTick: () => [...intervals.values()].find(timer => timer.ms === 2000)?.fn(),
    logged: type => JSON.parse(store.get('praxis_assess_TEST01')).log.filter(event => event.type === type),
    starts: () => requests.filter(url => url.endsWith('/start')).length,
    timeout: () => [...deadlines.values()].find(timer => timer.ms === 30000).fn(),
    speechRestartTimeout: () => [...deadlines.values()].find(timer => timer.ms === 8000)?.fn(),
    reconnectTick: () => [...deadlines.values()].find(timer => timer.ms === 2500)?.fn() };
}

test('browser startup and empty results do not start; spoken words unlock using the same recognizer', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  assert.equal(h.engine.snapshot().micCheck, 'checking');
  assert.equal(h.engine.snapshot().phase, 'gate');
  assert.equal(h.starts(), 0);
  h.recognizers[0].say('  ');
  await flush();
  assert.equal(h.starts(), 0);
  h.recognizers[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.equal(h.starts(), 1);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.engine.snapshot().transcript.tail.length, 0);
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.equal(saved.log.filter(event => event.type === 'voice').length, 0);
});

test('silent microphone times out without consuming the code, releases resources, and can retry', async t => {
  const h = await harness(t);
  const first = h.engine.begin(details);
  await flush();
  assert.equal((await h.engine.begin(details)).ok, false);
  h.timeout();
  assert.equal((await first).ok, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.screens[0].readyState, 'ended');
  assert.equal(h.recognizers[0].stopped, true);
  const retry = h.engine.begin(details);
  await flush();
  h.recognizers[0].say('late obsolete result');
  assert.equal(h.starts(), 0);
  h.recognizers[1].say('Ready now');
  assert.equal((await retry).ok, true);
});

test('browser audio-capture failure fails promptly and cleans up', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.recognizers[0].onerror({ error: 'audio-capture' });
  assert.equal((await begin).ok, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.screens[0].readyState, 'ended');
});

test('screen disconnected during the voice check cannot start the assessment', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.screens[0].stop();
  h.screens[0].ended();
  h.recognizers[0].say('Ready');
  assert.equal((await begin).ok, false);
  assert.equal(h.starts(), 0);
});

test('AssemblyAI socket opening is insufficient; actual transcription is required', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  assert.equal(h.starts(), 0);
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.equal(h.starts(), 1);
  assert.equal(h.micTrack.readyState, 'live');
  assert.equal(h.recognizers.length, 0);
});

test('microphone permission denial does not consume the code', async t => {
  const h = await harness(t, { assembly: true, micDenied: true });
  assert.equal((await h.engine.begin(details)).ok, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.screens[0].readyState, 'ended');
});

test('late permission grant after timeout releases the mic and cannot start', async t => {
  const h = await harness(t, { assembly: true, pendingMic: true });
  const begin = h.engine.begin(details);
  await flush();
  h.timeout();
  assert.equal((await begin).ok, false);
  h.releaseMic();
  await flush();
  assert.equal(h.micTrack.readyState, 'ended');
  assert.equal(h.sockets.length, 0);
  assert.equal(h.starts(), 0);
});

test('destroy during check cancels startup', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.engine.destroy();
  assert.equal((await begin).ok, false);
  assert.equal(h.starts(), 0);
});

test('resuming requires a fresh spoken check before unpausing', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.recognizers[0].say('Ready');
  await begin;
  h.screens[0].stop();
  h.screens[0].ended();
  assert.equal(h.engine.snapshot().phase, 'blocked');
  const resume = h.engine.reshare();
  await flush();
  assert.equal(h.engine.snapshot().phase, 'blocked');
  h.recognizers[1].say('Ready again');
  assert.equal((await resume).ok, true);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.starts(), 1);
});

test('a silent browser speech restart pauses the session and permits a fresh spoken retry', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.recognizers[0].say('Ready');
  await begin;
  h.recognizers[0].start = () => {}; // service accepts restart but never connects
  h.recognizers[0].onend();
  assert.equal(h.engine.snapshot().micLive, false);
  h.speechRestartTimeout();
  assert.equal(h.engine.snapshot().phase, 'blocked');
  assert.equal(h.engine.snapshot().blockedTitle, 'Transcription disconnected');
  assert.equal(h.recognizers[0].stopped, true);
  const resume = h.engine.reshare();
  await flush();
  h.recognizers[1].say('Ready again');
  assert.equal((await resume).ok, true);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.starts(), 1);
});

test('reopening a server-finalized session saves newer local words before showing completion', async t => {
  const h = await harness(t);
  const begin = h.engine.begin(details);
  await flush();
  h.recognizers[0].say('Ready');
  await begin;
  const checkpoint = JSON.parse(h.store.get('praxis_assess_TEST01'));
  const partial = [{ transcript: 'The final offline recommendation' }];
  partial.isFinal = false;
  h.recognizers[0].onresult({ resultIndex: 0, results: [partial] });
  const finalBodies = [];
  globalThis.fetch = async (url, options) => {
    if (url.includes('/session?')) return { ok: true, json: async () => ({
      status: 'submitted', owned: true, endReason: 'pause_limit', checkpoint,
      assessment: { title: 'Hidden brief', durationSeconds: 900 },
    }) };
    if (url === '/api/assessment') finalBodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, status: 'submitted', endReason: 'pause_limit' }) };
  };
  await h.engine.boot();
  await flush();
  assert.equal(finalBodies.length, 1);
  assert.ok(finalBodies[0].log.some(event => event.type === 'voice' && event.text === 'The final offline recommendation'));
  assert.equal(h.engine.snapshot().phase, 'done');
  assert.equal(h.engine.snapshot().doneReason, 'pause_limit');
  assert.equal(h.screens[0].readyState, 'ended');
  assert.equal(h.recognizers[0].stopped, true);
});

test('a delayed final acknowledgement from before reset cannot complete the fresh attempt', async t => {
  const h = await harness(t);
  const first = h.engine.begin(details);
  await flush();
  h.recognizers[0].say('Ready');
  await first;
  h.recognizers[0].say('Evidence from the prior attempt');
  const originalFetch = globalThis.fetch;
  let releaseFinal;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/session?')) return { ok: true, json: async () => ({
      status: 'unused', sessionGeneration: 1, sessionToken: 'fresh-owner',
      assessment: { title: 'Fresh brief', durationSeconds: 900 },
    }) };
    if (url === '/api/assessment') return { ok: true, json: () => new Promise(resolve => { releaseFinal = resolve; }) };
    return originalFetch(url, options);
  };
  h.engine.submit();
  await flush();
  assert.equal(typeof releaseFinal, 'function');
  await h.engine.boot();
  assert.equal(h.engine.snapshot().phase, 'gate');
  assert.equal(h.engine.snapshot().sessionGeneration, 1);
  assert.equal(h.store.has('praxis_assess_TEST01'), false);
  h.micTrack.readyState = 'live';
  const second = h.engine.begin(details);
  await flush();
  h.recognizers.at(-1).say('Ready for the fresh attempt');
  assert.equal((await second).ok, true);
  releaseFinal({ ok: true, endReason: 'submitted' });
  await flush();
  assert.equal(h.engine.snapshot().phase, 'running');
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.equal(saved.sessionGeneration, 1);
  assert.equal(saved.sessionToken, 'fresh-owner');
  assert.equal(saved.done, false);
  assert.equal(saved.log.some(event => event.text === 'Evidence from the prior attempt'), false);
});

test('a delayed start response from before reset cannot unlock or replace the fresh attempt', async t => {
  const h = await harness(t);
  const originalFetch = globalThis.fetch;
  let reset = false, releaseStart;
  globalThis.fetch = async (url, options) => {
    if (reset && url.includes('/session?')) return { ok: true, json: async () => ({
      status: 'unused', sessionGeneration: 1, sessionToken: 'fresh-owner',
      assessment: { title: 'Fresh brief', durationSeconds: 900 },
    }) };
    if (!reset && url.endsWith('/start')) return { ok: true, json: () => new Promise(resolve => { releaseStart = resolve; }) };
    return originalFetch(url, options);
  };
  const first = h.engine.begin({ name: 'Prior candidate' });
  await flush();
  h.recognizers[0].say('Ready');
  await flush();
  assert.equal(typeof releaseStart, 'function');
  reset = true;
  await h.engine.boot();
  assert.equal(h.engine.snapshot().phase, 'gate');
  h.micTrack.readyState = 'live';
  const second = h.engine.begin({ name: 'Fresh candidate' });
  await flush();
  h.recognizers.at(-1).say('Ready again');
  assert.equal((await second).ok, true);
  releaseStart({ ok: true, startedAt: Date.now() - 600000, assessment: { title: 'Old brief', durationSeconds: 60 } });
  assert.equal((await first).ok, false);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.engine.snapshot().duration, 900);
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.equal(saved.candidate.name, 'Fresh candidate');
  assert.equal(saved.sessionGeneration, 1);
  assert.equal(saved.sessionToken, 'fresh-owner');
});

test('reloading a fresh generation keeps its owned draft and established server clock', async t => {
  const h = await harness(t);
  const serverNow = Date.now() - 600000;
  const checkpoint = {
    sessionGeneration: 1, sessionToken: 'fresh-owner', startedAt: serverNow - 2000,
    lastSavedAt: serverNow, clockOffsetMs: -600000, pausedTotal: 0, pauseStartedAt: null,
    revision: 4, candidate: { name: 'Fresh candidate' },
    log: [{ type: 'voice', t: 1, text: 'Keep this current attempt' }],
  };
  h.store.set('praxis_assess_TEST01', JSON.stringify(checkpoint));
  h.store.set('praxis_owner_TEST01', 'fresh-owner');
  globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('/session?') ? {
    status: 'active', owned: true, sessionGeneration: 1, serverNow, checkpoint,
    assessment: { title: 'Fresh brief', durationSeconds: 900 },
  } : { ok: true, status: 'active' } });
  await h.engine.boot();
  assert.equal(h.engine.snapshot().phase, 'blocked');
  assert.ok(h.engine.snapshot().remaining >= 897);
  assert.ok(h.engine.snapshot().pauseBudgetLeft >= 299);
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.equal(saved.sessionGeneration, 1);
  assert.equal(saved.sessionToken, 'fresh-owner');
  assert.ok(saved.log.some(event => event.text === 'Keep this current attempt'));
});

test('AssemblyAI open but silent times out and stops the mic and socket', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.timeout();
  assert.equal((await begin).ok, false);
  assert.equal(h.starts(), 0);
  assert.equal(h.micTrack.readyState, 'ended');
  assert.equal(h.sockets[0].closed, true);
});

test('disconnected microphone fails the check promptly', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  h.micTrack.stop();
  h.micTrack.ended();
  assert.equal((await begin).ok, false);
  assert.equal(h.starts(), 0);
});

test('muted input cannot pass using a delayed transcription response', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  h.micTrack.muted = true;
  h.sockets[0].say('Earlier words');
  await flush();
  assert.equal(h.starts(), 0);
  h.timeout();
  assert.equal((await begin).ok, false);
});

test('no microphone device fails fast with a specific message, even on the browser engine path', async t => {
  const h = await harness(t, { micDenied: true, micThrow: Object.assign(new Error('nf'), { name: 'NotFoundError' }) });
  const result = await h.engine.begin(details);
  assert.equal(result.ok, false);
  assert.match(result.message, /No microphone was found/);
  assert.equal(h.recognizers.length, 0);
  assert.equal(h.starts(), 0);
  assert.equal(h.screens[0].readyState, 'ended');
});

test('microphone in use by another app is reported as such', async t => {
  const h = await harness(t, { assembly: true, micDenied: true, micThrow: Object.assign(new Error('busy'), { name: 'NotReadableError' }) });
  const result = await h.engine.begin(details);
  assert.equal(result.ok, false);
  assert.match(result.message, /another app/);
  assert.equal(h.starts(), 0);
});

test('AssemblyAI socket drop reconnects without pausing or stopping the mic', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.equal(h.engine.snapshot().phase, 'running');
  h.sockets[0].onclose();
  await flush();
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.micTrack.readyState, 'live');
  const pending = h.reconnectTick();
  await flush();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onopen();
  await pending;
  await flush();
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.micTrack.readyState, 'live');
});

test('AssemblyAI records unformatted end-of-turn speech and upgrades the same turn when formatting arrives', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.match(h.sockets[0].url, /min_end_of_turn_silence_when_confident=1000/);
  assert.match(h.sockets[0].url, /max_turn_silence=2800/);
  h.sockets[0].turn('Build the copy trade engine', { turn_order: 1 });
  let saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  const first = saved.log.filter(event => event.type === 'voice');
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'Build the copy trade engine');
  assert.equal(first[0].interim, true);
  h.sockets[0].turn('Build the copy-trade engine.', { turn_order: 1, turn_is_formatted: true });
  saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  const upgraded = saved.log.filter(event => event.type === 'voice');
  assert.equal(upgraded.length, 1);
  assert.equal(upgraded[0].text, 'Build the copy-trade engine.');
  assert.equal(upgraded[0].interim, undefined);
  h.sockets[0].turn('Next I will lock the follower row', { turn_order: 2 });
  saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  const voice = saved.log.filter(event => event.type === 'voice').map(event => event.text);
  assert.deepEqual(voice, [
    'Build the copy-trade engine.',
    'Next I will lock the follower row',
  ]);
});

test('a later AssemblyAI turn does not discard an earlier unformatted final', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  h.sockets[0].turn('First requirement is idempotency', { turn_order: 4 });
  h.sockets[0].say('partial of the next thought');
  h.sockets[0].turn('Then I handle concurrent trades', { turn_order: 5 });
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.deepEqual(saved.log.filter(event => event.type === 'voice').map(event => event.text), [
    'First requirement is idempotency',
    'Then I handle concurrent trades',
  ]);
});

test('microphone lost mid-session pauses the assessment; recovery re-checks the mic without a new screen pick', async t => {
  const h = await harness(t, { assembly: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.equal(h.engine.snapshot().phase, 'running');
  h.micTrack.ended();
  assert.equal(h.engine.snapshot().phase, 'blocked');
  assert.equal(h.engine.snapshot().blockedTitle, 'Microphone disconnected');
  assert.equal(h.engine.snapshot().screenLive, true);
  const saved = JSON.parse(h.store.get('praxis_assess_TEST01'));
  assert.equal(saved.log.some(event => event.type === 'mic_lost'), true);
  h.micTrack.readyState = 'live'; // a real getUserMedia hands back a fresh track; the harness reuses one
  const resume = h.engine.reshare();
  await flush();
  assert.equal(h.screens.length, 1);
  assert.equal(h.engine.snapshot().phase, 'blocked');
  h.sockets[1].onopen();
  await flush();
  h.sockets[1].say('Back again');
  assert.equal((await resume).ok, true);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.starts(), 1);
});

test('AudioWorklet tap streams PCM to AssemblyAI and asks for heartbeats and longer turn silence', async t => {
  const h = await harness(t, { assembly: true, worklet: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  assert.equal(h.taps.length, 1);
  assert.equal(h.taps[0].name, 'praxis-pcm-tap');
  assert.match(h.sockets[0].url, /min_turn_silence=1000/);
  assert.match(h.sockets[0].url, /session_heartbeat=true/);
  h.taps[0].chunk();
  h.taps[0].chunk();
  assert.equal(h.sockets[0].sent.length, 2);
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  assert.equal(h.logged('transcript_started')[0].audio, 'worklet');
});

test('audio_health records PCM flow while the tab is hidden', async t => {
  const h = await harness(t, { assembly: true, worklet: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  globalThis.document.hidden = true;
  h.taps[0].chunk(0.05);
  h.taps[0].chunk(0.05);
  h.taps[0].chunk(0.05);
  for (let i = 0; i < 15; i++) h.watchdogTick();
  const health = h.logged('audio_health');
  assert.equal(health.length, 1);
  assert.equal(health[0].chunks, 3);
  assert.equal(health[0].hidden, true);
  assert.equal(health[0].engine, 'worklet');
  assert.equal(health[0].level, -26);
  assert.equal(h.logged('audio_stalled').length, 0);
});

test('a silent audio graph is rebuilt without pausing the session or dropping the mic', async t => {
  const h = await harness(t, { assembly: true, worklet: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  h.taps[0].chunk();
  h.advance(16000);
  h.watchdogTick();
  assert.equal(h.logged('audio_stalled').length, 1);
  assert.equal(h.logged('transcript_reconnect').length, 1);
  assert.equal(h.engine.snapshot().phase, 'running');
  assert.equal(h.micTrack.readyState, 'live');
  const pending = h.reconnectTick();
  await flush();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onopen();
  await pending;
  await flush();
  assert.equal(h.taps.length, 2);
  h.taps[1].chunk();
  assert.equal(h.sockets[1].sent.length, 1);
  assert.equal(h.engine.snapshot().phase, 'running');
});

test('a socket that stops heartbeating is reconnected even though audio is still flowing', async t => {
  const h = await harness(t, { assembly: true, worklet: true });
  const begin = h.engine.begin(details);
  await flush();
  h.sockets[0].onopen();
  await flush();
  h.sockets[0].say('My microphone is working');
  assert.equal((await begin).ok, true);
  h.advance(25000);
  h.taps[0].chunk();
  h.watchdogTick();
  assert.equal(h.logged('transcript_stalled').length, 0, 'no heartbeat seen yet: quiet server is not suspicious');
  h.sockets[0].heartbeat();
  h.advance(21000);
  h.taps[0].chunk();
  h.watchdogTick();
  assert.equal(h.logged('transcript_stalled').length, 1);
  assert.equal(h.logged('transcript_reconnect').length, 1);
  assert.equal(h.engine.snapshot().phase, 'running');
});
