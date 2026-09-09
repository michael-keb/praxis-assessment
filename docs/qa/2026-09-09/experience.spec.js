// Desired-behavior regression coverage for the 2026-09-09 experience audit.
// The disposable server and persistence layer are real. Screen, microphone,
// speech, and deliberate network failures are synthetic; no real media or
// candidate data is used.
import { test, expect } from '@playwright/test';

const BRIEF = 'QA assigned brief: explain the tradeoffs.';
const OWNER_HEADER = 'X-Assessment-Session';

test.beforeEach(async ({ request }) => {
  const login = await request.post('/api/auth/login', {
    data: { email: 'qa@example.test', password: 'qa-local-only' },
  });
  expect(login.ok()).toBeTruthy();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const surface = page.isClosed()
    ? page.context().pages().find((candidate) => !candidate.isClosed())
    : page;
  if (!surface) return;
  await testInfo.attach('failure-observations', {
    body: JSON.stringify(await surface.evaluate(() => ({
      url: location.href,
      visibleText: document.body?.innerText,
      media: window.qa ? {
        liveMode: window.qa.liveMode(),
        screens: window.qa.screens.map((item) => item.track.readyState),
        microphones: window.qa.microphones.map((item) => item.track.readyState),
        recognizers: window.qa.recognizers.map((item) => ({ stopped: item.stopped, activation: item.activation })),
        sockets: window.qa.sockets.map((item) => ({ readyState: item.readyState, activation: item.activation })),
      } : null,
    })).catch((error) => ({ error: String(error) })), null, 2),
    contentType: 'application/json',
  });
  await surface.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true }).catch(() => {});
});

async function seed(request, overrides = {}) {
  const create = await request.post('/api/admin/assessments', {
    data: {
      title: 'QA ' + test.info().title,
      brief: BRIEF,
      durationMinutes: 15,
      requireLinkedin: false,
      requireUpwork: false,
      requireCv: false,
      requirePortfolio: false,
      ...overrides,
    },
  });
  expect(create.ok()).toBeTruthy();
  const assessment = (await create.json()).assessment;
  const issue = await request.post('/api/admin/codes', {
    data: { count: 1, assessmentId: assessment.id },
  });
  expect(issue.ok()).toBeTruthy();
  const code = (await issue.json()).codes[0];
  return { assessment, code };
}

async function status(request, code, sessionToken) {
  const response = await request.get('/api/assessment/session?case=' + encodeURIComponent(code), {
    headers: sessionToken ? { [OWNER_HEADER]: sessionToken } : undefined,
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function review(request, code) {
  const response = await request.get('/api/admin/sessions/' + code);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function ownerToken(page, code) {
  await expect.poll(() => page.evaluate(
    (key) => localStorage.getItem(key),
    'praxis_owner_' + code,
  )).toMatch(/\S+/);
  return page.evaluate((key) => localStorage.getItem(key), 'praxis_owner_' + code);
}

async function media(page, options = {}) {
  await page.addInitScript(({ screen, micError, browserServiceDenied }) => {
    window.qa = {
      screens: [], microphones: [], recognizers: [], sockets: [],
      screenMode: screen || 'monitor', micError,
      browserServiceDenied: Boolean(browserServiceDenied), activation: 0,
    };
    const q = window.qa;

    navigator.mediaDevices.getDisplayMedia = async () => {
      if (q.screenMode === 'denied') throw new DOMException('synthetic denial', 'NotAllowedError');
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#173d32'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif';
      ctx.fillText('Synthetic QA screen', 40, 80);
      const stream = canvas.captureStream(1);
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...settings(), displaySurface: q.screenMode });
      q.screens.push({ stream, track, canvas });
      return stream;
    };

    navigator.mediaDevices.getUserMedia = async () => {
      if (q.micError) throw new DOMException('synthetic microphone failure', q.micError);
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const track = destination.stream.getAudioTracks()[0];
      q.microphones.push({ context, oscillator, track });
      return destination.stream;
    };

    class Speech {
      constructor() { this.stopped = true; this.activation = 0; q.recognizers.push(this); }
      start() {
        this.stopped = false;
        this.activation = ++q.activation;
        queueMicrotask(() => {
          if (q.browserServiceDenied) {
            this.stopped = true;
            this.onerror?.({ error: 'service-not-allowed' });
            this.onend?.();
          } else this.onstart?.();
        });
      }
      stop() { this.stopped = true; }
      say(text, final = true) {
        const result = [{ transcript: text }];
        result.isFinal = final;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
    }
    window.SpeechRecognition = Speech;
    window.webkitSpeechRecognition = Speech;

    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class {
      constructor(url) {
        if (!String(url).includes('streaming.assemblyai.com')) return new NativeWebSocket(url);
        this.readyState = 0; this.activation = 0; q.sockets.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.activation = ++q.activation;
          this.onopen?.();
        });
      }
      close() { this.readyState = 3; }
      send() {}
      say(text, final = true) {
        this.onmessage?.({ data: JSON.stringify({
          type: 'Turn', transcript: text, end_of_turn: final, turn_is_formatted: final,
        }) });
      }
    };

    q.liveTranscriber = () => [
      ...q.sockets.filter((item) => item.readyState === 1 && typeof item.onmessage === 'function')
        .map((item) => ({ mode: 'assembly', item })),
      ...q.recognizers.filter((item) => !item.stopped && typeof item.onresult === 'function')
        .map((item) => ({ mode: 'browser', item })),
    ].sort((a, b) => b.item.activation - a.item.activation)[0] || null;
    q.liveMode = () => q.liveTranscriber()?.mode || null;
    q.say = (text, final = true) => {
      const live = q.liveTranscriber();
      if (!live) throw new Error('No live synthetic transcription engine');
      live.item.say(text, final);
      return live.mode;
    };
    q.stopScreen = () => {
      const track = q.screens.at(-1)?.track;
      if (!track) return;
      track.stop(); track.dispatchEvent(new Event('ended'));
    };
    q.stopMic = () => {
      const track = q.microphones.at(-1)?.track;
      if (!track) return;
      track.stop(); track.dispatchEvent(new Event('ended'));
    };
    q.disconnect = () => {
      const socket = q.sockets.at(-1);
      if (!socket) return;
      socket.readyState = 3; socket.onclose?.();
    };
  }, options);

  if (options.assembly) {
    const issuedTokens = new Set();
    await page.route('**/api/assessment/session**', async (route) => {
      const response = await route.fetch();
      const payload = await response.json().catch(() => ({}));
      if (payload.sessionToken) issuedTokens.add(payload.sessionToken);
      await route.fulfill({ response });
    });
    await page.route('**/api/assessment/transcribe-token', (route) => {
      let body = {};
      try { body = route.request().postDataJSON(); } catch { /* malformed request */ }
      const header = route.request().headers()['x-assessment-session'];
      if (!body.sessionToken || header !== body.sessionToken || !issuedTokens.has(body.sessionToken)) {
        return route.fulfill({ status: 403, json: { error: 'Invalid synthetic session owner.' } });
      }
      return route.fulfill({ json: { token: 'synthetic-local-token' } });
    });
  }
  page.on('dialog', (dialog) => dialog.accept());
}

async function prepareGate(page, code, name = 'QA Candidate') {
  await page.goto('/assess?case=' + code);
  await page.locator('#g-name').fill(name);
  await page.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
}

async function speak(page, text = 'My microphone works.', final = true) {
  await expect.poll(() => page.evaluate(() => window.qa?.liveMode())).toMatch(/^(assembly|browser)$/);
  return page.evaluate(({ text, final }) => window.qa.say(text, final), { text, final });
}

async function startFromGate(page) {
  await page.getByRole('button', { name: 'Check microphone and start', exact: true }).click();
  return speak(page);
}

async function gate(page, code, name = 'QA Candidate') {
  await prepareGate(page, code, name);
  return startFromGate(page);
}

async function begin(page, request, options = {}) {
  const fixture = options.fixture || await seed(request, options.assessment);
  await media(page, options);
  if (options.clock !== false) await page.clock.install();
  const mode = await gate(page, fixture.code, options.name);
  if (options.assembly) expect(mode).toBe('assembly');
  await expect(page.getByRole('button', { name: 'Submit session', exact: true })).toBeVisible();
  return fixture;
}

async function clickSubmit(page, { waitForSuccess = true } = {}) {
  await page.getByRole('button', { name: 'Submit session', exact: true }).click();
  await page.getByRole('button', { name: /Click again to confirm/ }).click();
  if (waitForSuccess) {
    await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toBeVisible();
  }
}

test('PASS full candidate flow preserves transcript, screen frames, identity and ZIP', async ({ page, request }, testInfo) => {
  const { code } = await begin(page, request, { clock: false });
  await expect(page.locator('.brief-content')).toContainText(BRIEF);
  await speak(page, 'I recommend the simpler design because it is testable.');
  await page.waitForTimeout(2300);
  await clickSubmit(page);
  await page.screenshot({ path: testInfo.outputPath('full-flow-success.png'), fullPage: true });
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  await expect.poll(async () => (await review(request, code)).frames.length).toBeGreaterThan(0);
  const result = await review(request, code);
  expect(result.candidate.name).toBe('QA Candidate');
  expect(result.payload.log.filter((event) => event.type === 'voice').map((event) => event.text))
    .toEqual(['I recommend the simpler design because it is testable.']);
  const zip = await request.get('/api/admin/sessions/' + code + '/zip');
  expect(zip.ok()).toBeTruthy();
  expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');
  await page.request.post('/api/auth/login', { data: { email: 'qa@example.test', password: 'qa-local-only' } });
  await page.goto('/admin/case/' + code);
  await expect(page.getByRole('heading', { name: 'Spoken transcript' })).toBeVisible();
});

for (const screen of ['denied', 'window', 'browser']) {
  test('PASS rejects screen choice ' + screen + ' without using code', async ({ page, request }) => {
    const { code } = await seed(request);
    await media(page, { screen });
    await prepareGate(page, code);
    await page.getByRole('button', { name: 'Check microphone and start', exact: true }).click();
    await expect(page.locator('.error-box')).toContainText(screen === 'denied' ? 'declined' : 'entire screen');
    expect((await status(request, code)).status).toBe('unused');
    await page.evaluate(() => { window.qa.screenMode = 'monitor'; });
    await startFromGate(page);
    await expect(page.locator('.timer')).toBeVisible();
    await clickSubmit(page);
  });
}

test('PASS silent mic times out, releases capture and permits retry', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page); await page.clock.install(); await prepareGate(page, code);
  await page.getByRole('button', { name: 'Check microphone and start', exact: true }).click();
  await expect(page.getByRole('button', { name: /Listening/ })).toBeVisible();
  await page.clock.fastForward(31000);
  await expect(page.locator('.error-box')).toContainText("couldn't hear any words");
  expect((await status(request, code)).status).toBe('unused');
  expect(await page.evaluate(() => window.qa.screens[0].track.readyState)).toBe('ended');
  await startFromGate(page);
  await expect(page.locator('.timer')).toBeVisible();
  await clickSubmit(page);
});

for (const micError of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
  test('PASS handles microphone ' + micError, async ({ page, request }) => {
    const { code } = await seed(request);
    await media(page, { micError }); await prepareGate(page, code);
    await page.getByRole('button', { name: 'Check microphone and start', exact: true }).click();
    await expect(page.locator('.error-box')).toBeVisible();
    expect((await status(request, code)).status).toBe('unused');
    expect(await page.evaluate(() => window.qa.screens[0].track.readyState)).toBe('ended');
  });
}

test('PASS screen interruption pauses timer and spoken check resumes same code', async ({ page, request }) => {
  const { code } = await begin(page, request);
  await page.clock.fastForward(5000);
  await page.evaluate(() => window.qa.stopScreen());
  await expect(page.locator('.timer')).toHaveText('PAUSED');
  await page.clock.fastForward(25000);
  await page.getByRole('button', { name: /screen|microphone/i }).click();
  await speak(page, 'I am back.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), 'praxis_assess_' + code);
  expect(saved.pausedTotal).toBeGreaterThanOrEqual(25000);
  expect(saved.log.filter((event) => event.type === 'unlock')).toHaveLength(1);
  await clickSubmit(page);
});

test('PASS Assembly microphone unplug pauses and recovers with same screen', async ({ page, request }) => {
  await begin(page, request, { assembly: true });
  await page.evaluate(() => window.qa.stopMic());
  await expect(page.getByRole('heading', { name: 'Microphone disconnected' })).toBeVisible();
  await page.getByRole('button', { name: 'Check microphone and continue' }).click();
  await speak(page, 'Reconnected.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => window.qa.screens.length)).toBe(1);
  await clickSubmit(page);
});

test('PASS refresh requires spoken resume and retains prior transcript', async ({ page, request }) => {
  const { code } = await begin(page, request);
  await speak(page, 'Before refresh.'); await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume: share your entire screen' })).toBeVisible();
  await page.getByRole('button', { name: 'Share screen and check microphone' }).click();
  await speak(page, 'Resume check.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await speak(page, 'After refresh.'); await clickSubmit(page);
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  const lines = (await review(request, code)).payload.log
    .filter((event) => event.type === 'voice').map((event) => event.text);
  expect(lines).toEqual(['Before refresh.', 'After refresh.']);
});

test('PASS persisted pageshow keeps the in-memory session paused until a spoken check', async ({ page, request }) => {
  const { code } = await begin(page, request);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.getByRole('heading', { name: 'Resume: share your entire screen' })).toBeVisible();
  const firstPauseStart = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key)).pauseStartedAt, 'praxis_assess_' + code);
  expect(firstPauseStart).toBeGreaterThan(0);
  await page.clock.fastForward(12000);

  const refreshed = page.waitForResponse((response) =>
    response.url().includes('/api/assessment/session?case=') && response.ok());
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await refreshed;
  await expect(page.locator('.timer')).toHaveText('PAUSED');
  await expect(page.locator('.blocked-overlay')).toBeVisible();
  await page.clock.fastForward(3000);
  await page.getByRole('button', { name: /screen|microphone/i }).click();
  await expect(page.locator('.blocked-overlay')).toBeVisible();
  await speak(page, 'Resume after the history-cache return.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  const resumed = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key)), 'praxis_assess_' + code);
  expect(resumed.pauseStartedAt).toBeNull();
  expect(resumed.pausedTotal).toBeGreaterThanOrEqual(15000);
  await clickSubmit(page);
});

for (const reason of ['expired', 'pause_limit']) {
  test('PASS automatic submit on ' + reason, async ({ page, request }) => {
    const { code } = await begin(page, request, { assessment: { durationMinutes: 1 } });
    await speak(page, 'Saved before timeout.');
    if (reason === 'pause_limit') await page.evaluate(() => window.qa.stopScreen());
    await page.clock.fastForward(reason === 'expired' ? 62000 : 302000);
    await expect(page.getByRole('heading', {
      name: reason === 'expired' ? 'Time expired' : 'Pause limit reached',
    })).toBeVisible();
    await expect.poll(async () => (await status(request, code)).endReason).toBe(reason);
  });
}

test('PASS server time prevents a fast browser clock consuming duration or pause budget', async ({ page, request }) => {
  const fixture = await seed(request);
  await media(page);
  await page.clock.install({ time: Date.now() + 10 * 60 * 1000 });
  await gate(page, fixture.code);
  await expect(page.getByRole('button', { name: 'Submit session', exact: true })).toBeVisible();
  await expect(page.locator('.timer')).toHaveText('15:00');

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)),
    'praxis_assess_' + fixture.code);
  expect(saved.clockOffsetMs).toBeLessThan(-9 * 60 * 1000);
  expect(saved.pausedTotal).toBeLessThan(1000);
  expect(saved.pauseStartedAt).toBeNull();
  await clickSubmit(page);
});

for (const mode of ['HTTP 503', 'offline']) {
  test('BUG-01 keeps failed submission pending and recovers after ' + mode, async ({ page, request }, testInfo) => {
    const { code } = await begin(page, request);
    await speak(page, 'A result which must survive.');
    let attempts = 0;
    page.on('request', (candidate) => {
      if (candidate.url().endsWith('/api/assessment') && candidate.method() === 'POST') attempts++;
    });
    if (mode === 'offline') {
      await page.context().setOffline(true);
    } else {
      await page.route('**/api/assessment', (route) => route.fulfill({
        status: 503,
        json: { error: 'Synthetic temporary failure' },
      }));
    }

    await clickSubmit(page, { waitForSuccess: false });
    await expect(page.getByRole('heading', { name: 'Saving your session', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toHaveCount(0);
    await expect.poll(() => attempts).toBeGreaterThan(0);
    expect((await status(request, code)).status).toBe('active');

    if (mode === 'HTTP 503') {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Saving your session', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('saving-http-503.png'), fullPage: true });
      await page.unroute('**/api/assessment');
      await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    } else {
      await page.context().setOffline(false);
      await page.reload();
    }

    await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toBeVisible();
    await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
    const voice = (await review(request, code)).payload.log.filter((event) => event.type === 'voice');
    expect(voice.some((event) => event.text === 'A result which must survive.')).toBeTruthy();
  });
}

test('BUG-02 failed start remains at the gate with the code unused, then retries cleanly', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page);
  await page.route('**/api/assessment/start', (route) => route.abort('internetdisconnected'));
  await prepareGate(page, code, 'Start Retry Candidate');
  await startFromGate(page);
  await expect(page.locator('.error-box')).toContainText(/connect|network|try again/i);
  await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
  await expect(page.locator('.timer')).toHaveCount(0);
  await expect(page.locator('.brief-content')).toHaveCount(0);
  expect((await status(request, code)).status).toBe('unused');

  await page.unroute('**/api/assessment/start');
  await startFromGate(page);
  await expect(page.locator('.timer')).toBeVisible();
  await expect(page.locator('.brief-content')).toContainText(BRIEF);
  await speak(page, 'Answering the assigned task.');
  await clickSubmit(page);
  const result = await review(request, code);
  expect(result.candidate.name).toBe('Start Retry Candidate');
  expect(result.payload.log.some((event) => event.text === 'Answering the assigned task.')).toBeTruthy();
});

test('BUG-02 lost start response retries the committed start with the same owner', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page);
  let committedResponse;
  await page.route('**/api/assessment/start', async (route) => {
    committedResponse = await route.fetch();
    await committedResponse.body();
    await route.abort('internetdisconnected');
  });
  await prepareGate(page, code, 'Committed Start Candidate');
  await startFromGate(page);
  await expect.poll(() => committedResponse?.ok()).toBe(true);
  await expect(page.locator('.error-box')).toContainText(/connect|network|try again/i);
  await expect(page.locator('.timer')).toHaveCount(0);
  const token = await ownerToken(page, code);
  expect((await status(request, code, token)).status).toBe('active');
  expect((await review(request, code)).candidate.name).toBe('Committed Start Candidate');

  await page.unroute('**/api/assessment/start');
  await startFromGate(page);
  await expect(page.locator('.timer')).toBeVisible();
  expect((await review(request, code)).candidate.name).toBe('Committed Start Candidate');
  await clickSubmit(page);
});

test('BUG-03 submitting preserves words still shown as interim', async ({ page, request }) => {
  const { code } = await begin(page, request);
  await speak(page, 'My final recommendation is option B.', false);
  await expect(page.locator('.caption-bar')).toContainText('My final recommendation is option B.');
  await clickSubmit(page);
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  const voice = (await review(request, code)).payload.log.filter((event) => event.type === 'voice');
  expect(voice.some((event) => event.text === 'My final recommendation is option B.')).toBeTruthy();
});

test('BUG-04 exhausted transcription recovery pauses and offers a spoken retry', async ({ page, request }) => {
  await begin(page, request, { assembly: true });
  await page.unroute('**/api/assessment/transcribe-token');
  await page.evaluate(() => {
    window.qa.browserServiceDenied = true;
    window.qa.disconnect();
  });
  await page.clock.fastForward(4000);
  await expect(page.getByRole('heading', { name: 'Transcription disconnected', exact: true })).toBeVisible();
  await expect(page.locator('.timer')).toHaveText('PAUSED');
  await expect(page.getByRole('button', { name: /microphone|connect/i })).toBeVisible();

  await page.evaluate(() => { window.qa.browserServiceDenied = false; });
  await page.route('**/api/assessment/transcribe-token', (route) => route.fulfill({
    json: { token: 'synthetic-reconnect-token' },
  }));
  await page.getByRole('button', { name: /microphone|connect/i }).click();
  await speak(page, 'Transcription is restored.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await clickSubmit(page);
});

test('BUG-05 screen loss while start is pending lands in the recoverable lock', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page);
  let pendingStart;
  await page.route('**/api/assessment/start', (route) => { pendingStart = route; });
  await prepareGate(page, code);
  await page.getByRole('button', { name: 'Check microphone and start', exact: true }).click();
  await speak(page);
  await expect.poll(() => Boolean(pendingStart)).toBe(true);
  await page.evaluate(() => window.qa.stopScreen());
  await pendingStart.continue();

  await expect(page.locator('.blocked-overlay')).toBeVisible();
  await expect(page.locator('.timer')).toHaveText('PAUSED');
  expect(await page.evaluate(() => window.qa.screens.at(-1).track.readyState)).toBe('ended');
  expect((await status(request, code)).status).toBe('active');
  await page.getByRole('button', { name: 'Share screen and check microphone' }).click();
  await speak(page, 'Capture is restored.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await expect(page.locator('.brief-content')).toContainText(BRIEF);
  await clickSubmit(page);
});

test('BUG-06 a code binds one owner, rejects a second owner, and permits owner retry', async ({ browser, page, request }) => {
  const fixture = await seed(request);
  const secondContext = await browser.newContext();
  const first = page;
  const second = await secondContext.newPage();
  await media(first); await media(second);
  try {
    await prepareGate(first, fixture.code, 'QA First Candidate');
    await prepareGate(second, fixture.code, 'QA Second Candidate');
    await startFromGate(first);
    await expect(first.locator('.timer')).toBeVisible();
    const firstToken = await ownerToken(first, fixture.code);
    const firstStatus = await status(request, fixture.code, firstToken);
    expect(firstStatus.status).toBe('active');
    const retry = await request.post('/api/assessment/start', {
      headers: { [OWNER_HEADER]: firstToken },
      data: { caseId: fixture.code, name: 'QA First Candidate', sessionToken: firstToken },
    });
    expect(retry.ok()).toBeTruthy();
    expect((await retry.json()).startedAt).toBe(firstStatus.startedAt);

    await startFromGate(second);
    await expect(second.locator('.error-box')).toContainText(/already|another|in progress|used/i);
    await expect(second.locator('.timer')).toHaveCount(0);
    const secondToken = await ownerToken(second, fixture.code);
    expect(secondToken).not.toBe(firstToken);

    await speak(first, 'First candidate answer.');
    await clickSubmit(first);
    const result = await review(request, fixture.code);
    expect(result.candidate.name).toBe('QA First Candidate');
    expect(result.payload.log.filter((event) => event.type === 'voice').map((event) => event.text))
      .toEqual(['First candidate answer.']);
  } finally {
    await secondContext.close();
  }
});

test('BUG-07 failed frame batch survives reload and is retried', async ({ page, request }) => {
  const { code } = await begin(page, request);
  let failedBody = '';
  await page.route('**/api/assessment/frames', (route) => {
    failedBody = route.request().postDataBuffer()?.toString('latin1') || '';
    return route.abort('internetdisconnected');
  });
  await page.clock.runFor(2500);
  await expect.poll(() => failedBody.length).toBeGreaterThan(0);
  const failedNames = [...failedBody.matchAll(/filename="([^"]+)"/g)].map((match) => match[1]);
  expect(failedNames.length).toBeGreaterThan(0);

  await page.unroute('**/api/assessment/frames');
  const retriedRequest = page.waitForRequest((candidate) =>
    candidate.url().endsWith('/api/assessment/frames') && candidate.method() === 'POST');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume: share your entire screen' })).toBeVisible();
  await retriedRequest;
  await expect.poll(async () => {
    const names = (await review(request, code)).frames;
    return failedNames.every((name) => names.includes(name));
  }).toBeTruthy();

  await page.getByRole('button', { name: 'Share screen and check microphone' }).click();
  await speak(page, 'Resume after upload retry.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await clickSubmit(page);
});

test('BUG-07 success waits for the final recording upload acknowledgement', async ({ page, request }) => {
  const { code } = await begin(page, request, { clock: false });
  const pendingFrames = [];
  await page.route('**/api/assessment/frames', (route) => { pendingFrames.push(route); });
  await page.waitForTimeout(2200);
  await clickSubmit(page, { waitForSuccess: false });
  await expect.poll(() => pendingFrames.length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Saving your session', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toHaveCount(0);

  await page.unroute('**/api/assessment/frames');
  await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toBeVisible();
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  await expect.poll(async () => (await review(request, code)).frames.length).toBeGreaterThan(0);
});

test('BUG-07 an acknowledged frame still permits success when IndexedDB cleanup aborts', async ({ page, request }) => {
  await page.addInitScript(() => {
    const nativeDelete = IDBObjectStore.prototype.delete;
    window.qaRecordingDeleteFailures = 0;
    IDBObjectStore.prototype.delete = function (...args) {
      const pending = nativeDelete.apply(this, args);
      if (this.name === 'frames' && window.qaRecordingDeleteFailures === 0) {
        window.qaRecordingDeleteFailures++;
        this.transaction.abort();
      }
      return pending;
    };
  });

  const { code } = await begin(page, request, { clock: false });
  await expect.poll(() => page.evaluate(() => window.qaRecordingDeleteFailures)).toBe(1);
  await expect.poll(async () => (await review(request, code)).frames.length).toBeGreaterThan(0);
  await clickSubmit(page);
  await expect(page.getByRole('heading', { name: 'Session submitted', exact: true })).toBeVisible();

  const retained = await page.evaluate((caseId) => new Promise((resolve, reject) => {
    const opening = indexedDB.open('praxis-recordings', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const query = opening.result.transaction('frames').objectStore('frames')
        .index('caseId').getAll(caseId);
      query.onerror = () => reject(query.error);
      query.onsuccess = () => resolve(query.result.map((frame) => `f_${frame.t}.jpg`));
    };
  }), code);
  expect(retained.length).toBeGreaterThan(0);
  const savedFrames = (await review(request, code)).frames;
  expect(retained.every((name) => savedFrames.includes(name))).toBeTruthy();
});

test('BUG-08 closing a tab leaves the spoken transcript in the server checkpoint', async ({ page, request }) => {
  const { code } = await begin(page, request, { clock: false });
  await speak(page, 'Checkpoint this before I close.');
  const token = await ownerToken(page, code);
  const context = page.context();
  const login = await context.request.post('/api/auth/login', {
    data: { email: 'qa@example.test', password: 'qa-local-only' },
  });
  expect(login.ok()).toBeTruthy();
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBeTruthy();

  await expect.poll(async () => {
    const checkpoint = (await status(request, code, token)).checkpoint;
    return checkpoint?.log?.some((event) =>
      event.type === 'voice' && event.text === 'Checkpoint this before I close.');
  }).toBeTruthy();
  expect((await status(request, code, token)).status).toBe('active');
  const admin = await context.newPage();
  await admin.goto('/admin/case/' + code);
  await expect(admin.getByRole('status')).toContainText('Saved session in progress');
  await expect(admin.getByRole('heading', { name: 'Spoken transcript' })).toBeVisible();
  await expect(admin.locator('main')).toContainText('Checkpoint this before I close.');
});

test('PASS required files, profile fields and review downloads', async ({ page, request }) => {
  const { code } = await seed(request, {
    requireLinkedin: true, requireUpwork: true, requireCv: true, requirePortfolio: true,
  });
  await media(page);
  await page.goto('/assess?case=' + code);
  await page.locator('#g-name').fill('Upload QA');
  await page.locator('#g-linkedin').fill('https://www.linkedin.com/in/qa');
  await page.locator('#g-upwork').fill('https://www.upwork.com/freelancers/~qa');
  await page.locator('#g-cv').setInputFiles({
    name: 'qa-resume.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% synthetic fixture\n%%EOF'),
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );
  await page.locator('#g-portfolio').setInputFiles({
    name: 'qa-portfolio.png', mimeType: 'image/png', buffer: png,
  });
  await page.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await startFromGate(page);
  await expect(page.locator('.timer')).toBeVisible();
  await clickSubmit(page);
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  const result = await review(request, code);
  expect(result.candidate.cv).toBe('qa-resume.pdf');
  expect(result.portfolio).toEqual(['01.png']);
  expect((await request.get('/api/admin/sessions/' + code + '/cv')).ok()).toBeTruthy();
  expect((await request.get('/api/admin/sessions/' + code + '/portfolio/01.png')).ok()).toBeTruthy();
});

test('PASS invalid links, void link and admin authentication', async ({ page, request }) => {
  await page.goto('/assess');
  await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
  await page.goto('/assess?case=ZZZZZZ');
  await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
  const { code } = await seed(request);
  await request.post('/api/admin/codes/' + code + '/void');
  await page.goto('/assess?case=' + code);
  await expect(page.getByRole('heading', { name: 'This link has been disabled' })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin log in' })).toBeVisible();
  await page.locator('#email').fill('qa@example.test');
  await page.locator('#password').fill('wrong-password');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.locator('.error-box')).toContainText('incorrect');
  await page.locator('#password').fill('qa-local-only');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Issued codes' })).toBeVisible();
});

test('PASS homepage requires a valid code and exercises the Assembly transcription path', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page, { assembly: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Test microphone and transcription' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to assessment' })).toBeDisabled();
  await page.locator('#landing-code').fill(code.toLowerCase());
  await page.getByRole('button', { name: 'Check assessment code', exact: true }).click();
  const micTest = page.getByRole('button', { name: 'Test microphone and transcription' });
  await expect(micTest).toBeEnabled();
  await micTest.click();
  expect(await speak(page, 'The homepage microphone works.')).toBe('assembly');
  await expect(page.getByRole('button', { name: 'Microphone and transcription passed' })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.qa.microphones.every((item) => item.track.readyState === 'ended'))).toBeTruthy();
  await page.getByRole('button', { name: 'Continue to assessment' }).click();
  await expect(page.locator('#g-name')).toBeVisible();
  expect((await status(request, code)).status).toBe('unused');
  await gate(page, code);
  await expect(page.locator('.timer')).toBeVisible();
  await clickSubmit(page);
});

test('PASS Assembly reconnect reuses microphone and resumes transcription', async ({ page, request }) => {
  const { code } = await begin(page, request, { assembly: true });
  await speak(page, 'Before reconnect.');
  await page.evaluate(() => window.qa.disconnect());
  await page.clock.fastForward(4000);
  await expect.poll(() => page.evaluate(() => window.qa.sockets.length)).toBe(2);
  expect(await speak(page, 'After reconnect.')).toBe('assembly');
  await expect(page.locator('.caption-bar')).toContainText('After reconnect.');
  expect(await page.evaluate(() => window.qa.microphones.length)).toBe(1);
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await clickSubmit(page);
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  const voice = (await review(request, code)).payload.log
    .filter((event) => event.type === 'voice').map((event) => event.text);
  expect(voice).toEqual(['Before reconnect.', 'After reconnect.']);
});

test('BUG-09 homepage passes Assembly when browser speech is unavailable', async ({ page, request }) => {
  const { code } = await seed(request);
  await media(page, { assembly: true, browserServiceDenied: true });
  await page.goto('/');
  await page.locator('#landing-code').fill(code);
  await page.getByRole('button', { name: 'Check assessment code', exact: true }).click();
  const micTest = page.getByRole('button', { name: 'Test microphone and transcription' });
  await expect(micTest).toBeEnabled();
  await micTest.click();
  expect(await speak(page, 'Assembly works without browser speech.')).toBe('assembly');
  await expect(page.getByRole('button', { name: 'Microphone and transcription passed' })).toBeVisible();
  expect(await page.evaluate(() => window.qa.recognizers.length)).toBe(0);
  await page.getByRole('button', { name: 'Continue to assessment' }).click();
  await expect(page.locator('#g-name')).toBeVisible();
  expect((await status(request, code)).status).toBe('unused');
});

test('BUG-10 active session keeps its original duration and brief after admin edits', async ({ page, request }) => {
  const { code, assessment } = await begin(page, request);
  await page.clock.fastForward(70000);
  await expect(page.locator('.timer')).toHaveText(/^13:/);
  const update = await request.put('/api/admin/assessments/' + assessment.id, {
    data: {
      title: assessment.title,
      brief: 'Changed task for future candidates.',
      durationMinutes: 1,
      requireLinkedin: false,
      requireUpwork: false,
      requireCv: false,
      requirePortfolio: false,
    },
  });
  expect(update.ok()).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Resume: share your entire screen' })).toBeVisible();
  await page.getByRole('button', { name: 'Share screen and check microphone' }).click();
  await speak(page, 'Resume the original assignment.');
  await expect(page.locator('.blocked-overlay')).toHaveCount(0);
  await expect(page.locator('.timer')).toHaveText(/^13:/);
  await expect(page.locator('.brief-content')).toContainText(BRIEF);
  await expect(page.locator('.brief-content')).not.toContainText('Changed task for future candidates.');
  await clickSubmit(page);
});

test('PASS plain-text brief edit uses an explicit collapsed end-of-document selection', async ({ page, request }) => {
  const { assessment } = await seed(request, {
    brief: 'First line\nSecond line\n\nAnother paragraph.',
  });
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'qa@example.test', password: 'qa-local-only' },
  });
  expect(login.ok()).toBeTruthy();
  await page.goto('/admin');
  await page.getByText(assessment.title, { exact: true }).locator('..')
    .getByRole('button', { name: 'Edit', exact: true }).click();
  const input = page.locator('#a-brief');
  await expect(input.locator('br')).toHaveCount(1);
  await input.click();
  await input.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type(' Updated.');
  await expect(input).toContainText('First line');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#a-brief')).toHaveCount(0);
  await page.getByText(assessment.title, { exact: true }).locator('..')
    .getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.brief-editor-preview');
  await expect(preview.locator('br')).toHaveCount(1);
  await expect(preview.locator('p')).toHaveCount(2);
  await expect(preview).toContainText('Another paragraph. Updated.');
});

test('BUG-11 late screen permission after expiry is stopped without restarting capture', async ({ page, request }) => {
  const { code } = await begin(page, request);
  let frameRequests = 0;
  let tokenRequests = 0;
  page.on('request', (candidate) => {
    if (candidate.url().endsWith('/api/assessment/frames')) frameRequests++;
    if (candidate.url().endsWith('/api/assessment/transcribe-token')) tokenRequests++;
  });
  await page.evaluate(() => {
    window.qa.stopScreen();
    const original = navigator.mediaDevices.getDisplayMedia;
    navigator.mediaDevices.getDisplayMedia = () => new Promise((resolve) => {
      window.qa.releaseScreen = async () => resolve(await original());
    });
  });
  await page.getByRole('button', { name: 'Share screen and check microphone' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.qa.releaseScreen)).toBe('function');
  await page.clock.fastForward(302000);
  await expect(page.getByRole('heading', { name: 'Pause limit reached' })).toBeVisible();
  await expect.poll(async () => (await status(request, code)).status).toBe('submitted');
  const countsBeforeRelease = { frameRequests, tokenRequests };
  const transcribersBeforeRelease = await page.evaluate(() => ({
    sockets: window.qa.sockets.length,
    recognizers: window.qa.recognizers.length,
  }));

  await page.evaluate(() => window.qa.releaseScreen());
  await expect.poll(() => page.evaluate(() => window.qa.screens.at(-1)?.track.readyState)).toBe('ended');
  await page.clock.fastForward(5000);
  await expect(page.getByRole('heading', { name: 'Pause limit reached' })).toBeVisible();
  expect(await page.evaluate(() => window.qa.liveMode())).toBeNull();
  expect(await page.evaluate(() => ({
    sockets: window.qa.sockets.length,
    recognizers: window.qa.recognizers.length,
  }))).toEqual(transcribersBeforeRelease);
  expect({ frameRequests, tokenRequests }).toEqual(countsBeforeRelease);
});
