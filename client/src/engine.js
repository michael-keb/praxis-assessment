/*
 * Praxis assessment session engine — framework-agnostic port of the
 * verified single-file logic. Owns: timer + pause accounting, entire-screen
 * capture enforcement, event log, localStorage persistence/resume, 1fps
 * frame shipping, idle detection, auto-submit (expiry / pause budget).
 * React renders from snapshots via subscribe().
 */

import { createRecordingStore } from './recording-store.js';

export const DEFAULT_DURATION = 15 * 60;  // seconds; used until the code's assessment duration is known
export const PAUSE_LIMIT = 5 * 60;        // max cumulative paused seconds
const ENDPOINT = "/api/assessment";

export function createEngine(caseId, { preflightOnly = false, recordingStore } = {}) {
  const STORE_KEY = "praxis_assess_" + caseId;
  const OWNER_KEY = "praxis_owner_" + caseId;
  const recordings = recordingStore || createRecordingStore(caseId);
  let duration = DEFAULT_DURATION;        // overridden from the assessment's duration once /session resolves

  let state = {
    startedAt: null,
    candidate: null,        // {name, linkedin} captured at the gate
    pausedTotal: 0,
    pauseStartedAt: null,
    lastSavedAt: null,
    zones: { 1: "", 2: "", 3: "", 4: "" },
    confidence: null,
    log: [],
    done: false,
    doneReason: null,
    sessionToken: null,
    revision: 0,
    pendingSubmission: false,
    startPending: false,
    pendingTranscript: "",
    finishedAt: null,
    clockOffsetMs: 0,
  };

  let phase = "loading";  // loading | gate | running | blocked | submitting | done | fatal
  let fatalInfo = null;   // {title, text}
  let blockedTitle = "";
  let running = false;
  let finalized = false;
  let tabAway = false;
  let currentZone = null;
  let lastActivity = Date.now();
  let idleSince = null;
  let briefWasHidden = false;
  let lastReground = 0;
  let anyZoneTouched = false;
  let captureStream = null;
  let recognition = null;      // Web Speech API session (fallback engine)
  let ws = null;               // AssemblyAI streaming socket (primary engine)
  let audioCtx = null;         // feeds PCM16 from the mic into the socket
  let processor = null;
  let micStream = null;        // the ONE mic stream this page holds (assembly mode)
  let transcribing = false;    // should a transcription engine be running
  let micLive = false;         // an engine is actually live (UI indicator)
  let micCheck = "idle";       // idle | checking | passed
  let finishMicCheck = null;
  let transcriptionGeneration = 0;
  let connecting = false;
  let destroyed = false;
  let captureGeneration = 0;
  let bootGeneration = 0;
  let reconnecting = false;
  let reconnectTimer = null;
  let reconnectDeadline = null;
  let submissionError = "";
  let submissionPromise = null;
  let frameUpload = null;
  let frameRestore = null;
  let checkpointPromise = null;
  let checkpointTimer = null;
  let checkpointDirty = false;
  let clockOffsetMs = 0;
  const frameWrites = new Set();
  const requests = new Set();
  let interim = "";            // in-flight words, not yet finalized
  let silentLogged = false;    // mic heard nothing for a while (banner + log event)
  let transcriptTail = [];     // last few finalized lines, for the on-screen captions
  let frameQueue = [];
  let assessmentMeta = null;   // {title, brief} from the code's assigned assessment, if any
  const timers = [];
  const listeners = new Set();

  const captureVideo = document.createElement("video");
  captureVideo.muted = true;
  const captureCanvas = document.createElement("canvas");

  /* ---------------- time ---------------- */
  const now = () => Date.now() + clockOffsetMs;
  function syncClock(serverNow) {
    if (Number.isSafeInteger(serverNow)) clockOffsetMs = serverNow - Date.now();
  }
  function effectiveMs() {
    if (!state.startedAt) return 0;
    const mark = state.pauseStartedAt || state.finishedAt || now();
    return Math.max(0, mark - state.startedAt - state.pausedTotal);
  }
  const tSec = () => Math.floor(effectiveMs() / 1000);
  const remaining = () => duration - Math.floor(effectiveMs() / 1000);
  const pausedMsTotal = () =>
    state.pausedTotal + (state.pauseStartedAt ? now() - state.pauseStartedAt : 0);

  /* ---------------- persistence + log ---------------- */
  function save() {
    if (preflightOnly) return;
    if (!state.startedAt && !state.startPending) return;
    const stored = load();
    if (stored?.sessionToken && stored.sessionToken !== state.sessionToken && (stored.startedAt || stored.startPending)) return;
    state.lastSavedAt = now();
    state.clockOffsetMs = clockOffsetMs;
    state.pendingTranscript = running && micCheck !== "checking" ? interim : state.pendingTranscript;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; }
  }
  function logEvent(ev) {
    if (ev.t === undefined) ev.t = tSec();
    state.log.push(ev);
    save();
    scheduleCheckpoint();
  }

  function headers(json = false) {
    return { ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(state.sessionToken ? { 'X-Assessment-Session': state.sessionToken } : {}) };
  }
  async function request(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); requests.delete(controller); }
  }
  function rememberOwner(token) {
    const stored = load();
    if (stored?.sessionToken && stored.sessionToken !== token && (stored.startedAt || stored.startPending)) {
      throw new Error('This assessment is already being started in another tab. Return to that tab or reload this link to resume it.');
    }
    state.sessionToken = token;
    state.startPending = true;
    try { localStorage.setItem(OWNER_KEY, token); } catch {}
    save();
  }
  function checkpointPayload() {
    state.revision = (Number(state.revision) || 0) + 1;
    save();
    return { ...state, caseId, elapsedMs: effectiveMs(), pendingFrames: frameQueue.length,
      phase: finalized ? 'submitting' : state.pauseStartedAt ? 'blocked' : 'running' };
  }
  function scheduleCheckpoint() {
    if (preflightOnly || !state.startedAt || state.done || destroyed || finalized) return;
    checkpointDirty = true;
    if (checkpointTimer) return;
    checkpointTimer = setTimeout(() => { checkpointTimer = null; void checkpoint(); }, 150);
  }
  async function checkpoint({ keepalive = false } = {}) {
    if (preflightOnly || !state.startedAt || !state.sessionToken || state.done) return;
    if (checkpointPromise && !keepalive) { checkpointDirty = true; return checkpointPromise; }
    checkpointDirty = false;
    const body = JSON.stringify(checkpointPayload());
    const send = async () => {
      try {
        const res = await request(ENDPOINT + '/checkpoint', {
          method: 'POST', headers: headers(true), body,
          ...(keepalive && new Blob([body]).size < 60000 ? { keepalive: true } : {}),
        });
        if (!res.ok) return;
        const info = await res.json().catch(() => ({}));
        if (info.status === 'submitted' && running && !finalized && !destroyed) finalize(info.endReason || 'pause_limit');
      } catch { /* The next checkpoint or final retry sends the full durable draft. */ }
    };
    if (keepalive) return send();
    checkpointPromise = send();
    try { await checkpointPromise; }
    finally {
      checkpointPromise = null;
      if (checkpointDirty) scheduleCheckpoint();
    }
  }
  function commitPendingVoice() {
    const text = (interim || state.pendingTranscript || '').trim();
    if (text && state.startedAt && micCheck !== 'checking') {
      state.log.push({ type: 'voice', t: Math.min(tSec(), duration), text, interim: true });
    }
    interim = '';
    state.pendingTranscript = '';
  }

  /* ---------------- notifications ----------------
     useSyncExternalStore needs a STABLE snapshot reference between
     emits — rebuild the cached object only when something changed. */
  function buildSnapshot() {
    return {
      phase,
      fatal: fatalInfo,
      blockedTitle,
      caseId,
      remaining: remaining(),
      pauseBudgetLeft: PAUSE_LIMIT - Math.floor(pausedMsTotal() / 1000),
      zones: { ...state.zones },
      confidence: state.confidence,
      doneReason: state.doneReason,
      submissionError,
      pendingFrames: frameQueue.length,
      reconnecting,
      micLive,
      micCheck,
      screenLive: screenLive(),
      micSilent: silentLogged,
      transcript: { tail: [...transcriptTail], interim },
      assessment: assessmentMeta,
      duration
    };
  }
  let cachedSnapshot = buildSnapshot();
  function emit() {
    cachedSnapshot = buildSnapshot();
    listeners.forEach((fn) => fn());
  }
  const snapshot = () => cachedSnapshot;

  function setPhase(next) { phase = next; emit(); }
  function fatal(title, text) { fatalInfo = { title, text }; setPhase("fatal"); }

  /* ---------------- capture (entire screen required) ---------------- */
  function startCapture() {
    const generation = ++captureGeneration;
    if (destroyed || finalized) return Promise.resolve({ ok: false, reason: 'cancelled' });
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.resolve({ ok: false, reason: "unsupported",
        message: "This browser does not support screen sharing. Use Google Chrome on a computer." });
    }
    const options = {
      video: { frameRate: 1, displaySurface: "monitor" },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "include"
    };
    // Chrome/Edge 109+: Conditional Focus. Setting no-focus-change before the
    // picker AND again synchronously when the promise resolves (required —
    // Chrome finalizes focus in that microtask) keeps the assessment tab
    // focused when the candidate wrongly picks a tab/window, so they see the
    // rejection instead of being yanked away.
    let controller = null;
    if (typeof window.CaptureController === "function") {
      try {
        controller = new CaptureController();
        controller.setFocusBehavior("no-focus-change");
        options.controller = controller;
      } catch {
        controller = null;
      }
    }
    return navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
      if (destroyed || finalized || generation !== captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return { ok: false, reason: 'cancelled' };
      }
      const track = stream.getVideoTracks()[0];
      const surface = track.getSettings ? track.getSettings().displaySurface : null;

      // Must run in this same turn — before yielding — or Chrome steals focus.
      if (controller && (surface === "browser" || surface === "window")) {
        try { controller.setFocusBehavior("no-focus-change"); } catch { /* already finalized / monitor */ }
      }

      // Picker still offers tab/window; reject anything that isn't the whole screen.
      if (surface && surface !== "monitor") {
        stream.getTracks().forEach((tr) => tr.stop());
        try { window.focus(); } catch { /* ignore */ }
        const what = surface === "browser" ? "a browser tab" : "a window";
        return { ok: false, reason: "wrong_surface_" + surface,
          message: `You shared ${what} — this assessment requires your entire screen. Try again and choose “Entire Screen”.` };
      }
      captureStream = stream;
      captureVideo.srcObject = stream;
      captureVideo.play().catch(() => {});
      track.addEventListener("ended", () => {
        if (captureStream !== stream) return;
        captureStream = null;
        if (running && !finalized) {
          logEvent({ type: "capture_declined", reason: "stopped" });
          block("Screen sharing stopped");
        }
      });
      return { ok: true };
    }).catch(() => ({ ok: false, reason: "denied",
      message: "Screen sharing was declined. The assessment cannot run without it." }));
  }
  function screenLive() { return !!captureStream?.getVideoTracks().some((track) => track.readyState === "live"); }
  function stopSharing() {
    captureGeneration++;
    captureStream?.getTracks().forEach((tr) => tr.stop());
    captureStream = null;
  }

  /* ---------------- live transcription (thinking aloud) ----------------
     Web Speech API, NOT MediaRecorder — deliberately the ONLY microphone
     consumer this page holds. Holding a recording stream alongside a
     recognizer (or alongside whatever audio software the candidate runs)
     is how mic contention and dead audio happen; one consumer, and the
     on-screen captions make any wrong-device problem immediately visible
     to the candidate themselves. Finalized lines land in the event log as
     {type:"voice", t, text} — the payload carries the full transcript. */
  let lastHeardAt = 0; // last time ANY words (interim or final) arrived

  function stopTranscription() {
    if (running && micCheck !== 'checking') commitPendingVoice();
    transcriptionGeneration++;
    transcribing = false;
    clearTimeout(reconnectTimer);
    clearTimeout(reconnectDeadline);
    reconnectTimer = reconnectDeadline = null;
    reconnecting = false;
    finishMicCheck?.({ ok: false, message: "Microphone check cancelled. You can try again when ready." });
    if (recognition) recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    try { recognition?.stop(); } catch { /* already stopped */ }
    recognition = null;
    teardownAssembly();
    interim = "";
    if (micLive) { micLive = false; emit(); }
  }

  /* Close the streaming socket and audio graph. Leave the mic stream alone
     unless the caller asks to stop it — stopping the track is what Chrome
     reports as a disconnect, which used to lock a healthy session whenever
     AssemblyAI dropped and we tried to reconnect. */
  function disconnectAssemblyTransport() {
    clearTimeout(muteTimer);
    try { processor?.disconnect(); } catch { /* not connected */ }
    processor = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
      ws = null;
    }
    try { audioCtx?.close(); } catch { /* already closed */ }
    audioCtx = null;
  }
  function teardownAssembly() {
    disconnectAssemblyTransport();
    micStream?.getTracks().forEach((tr) => tr.stop());
    micStream = null;
  }

  /* ---------------- primary engine: AssemblyAI Universal-Streaming ----------
     One mic stream → PCM16 over a websocket → partial words for the captions,
     formatted end-of-turn sentences into the log. The server mints short-lived
     tokens (the API key never reaches this page). Any failure to start falls
     back to the browser engine below; a mid-session drop reconnects, and if
     that fails, falls back too — a session never dies over transcription. */
  async function mintStreamToken() {
    try {
      const r = await request(ENDPOINT + "/transcribe-token", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ caseId, sessionToken: state.sessionToken })
      }, 8000);
      if (!r.ok) return null;
      return (await r.json()).token || null;
    } catch {
      return null;
    }
  }

  function transcriptionFailed(reason) {
    if (!running || finalized || destroyed) return;
    logEvent({ type: 'transcript_error', error: reason });
    stopTranscription();
    block('Transcription disconnected');
  }
  function scheduleAssemblyReconnect() {
    if (!transcribing || finalized || destroyed || reconnecting) return;
    reconnecting = true;
    micLive = false;
    const generation = transcriptionGeneration;
    logEvent({ type: "transcript_reconnect" });
    emit();
    reconnectDeadline = setTimeout(() => {
      if (generation === transcriptionGeneration) transcriptionFailed('Transcription did not reconnect.');
    }, 18000);
    reconnectTimer = setTimeout(async () => {
      try {
        if (!transcribing || finalized || destroyed || generation !== transcriptionGeneration) return;
        disconnectAssemblyTransport();
        const again = await startAssemblyTranscription();
        if (generation !== transcriptionGeneration || finalized || destroyed) return;
        if (!again.ok && transcribing && !finalized) {
          logEvent({ type: "transcript_error", error: "assembly reconnect failed — falling back to browser engine" });
          teardownAssembly();
          const fallback = await startBrowserTranscription();
          if (generation !== transcriptionGeneration || finalized || destroyed) return;
          if (!fallback.ok) transcriptionFailed('The transcription services could not reconnect.');
        }
      } catch {
        if (generation === transcriptionGeneration) transcriptionFailed('The transcription connection failed.');
      } finally {
        if (generation === transcriptionGeneration) {
          reconnecting = false;
          clearTimeout(reconnectDeadline);
          emit();
        }
      }
    }, 2500);
  }

  async function ensureMicStream(generation) {
    if (micStream?.getAudioTracks().some((track) => track.readyState === "live")) {
      return { ok: true };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
      if (generation !== transcriptionGeneration || destroyed || finalized) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, reason: "cancelled" };
      }
      micStream = stream;
      stream.getAudioTracks().forEach((track) => watchMicTrack(track, generation));
      return { ok: true };
    } catch (err) {
      return micError(err);
    }
  }

  async function startAssemblyTranscription() {
    const generation = transcriptionGeneration;
    const token = await mintStreamToken();
    if (generation !== transcriptionGeneration || destroyed || finalized) return { ok: false, reason: "cancelled" };
    if (!token) return { ok: false, reason: "no_token" };

    const mic = await ensureMicStream(generation);
    if (!mic.ok) return mic;

    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: 16000 });
    await audioCtx.resume();
    if (generation !== transcriptionGeneration || destroyed || finalized) return { ok: false, reason: "cancelled" };
    const rate = Math.round(audioCtx.sampleRate); // browser may not honour 16k — tell AAI what we actually have
    const source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    return new Promise((resolve) => {
      let settled = false;
      const ready = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => ready({ ok: false, reason: 'ws_timeout' }), 8000);
      ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate=${rate}&format_turns=true&token=${encodeURIComponent(token)}`
      );
      const socket = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (generation !== transcriptionGeneration || destroyed || finalized || !transcribing || socket !== ws) {
          socket.close();
          ready({ ok: false, reason: 'cancelled' });
          return;
        }
        processor.onaudioprocess = (e) => {
          if (!transcribing || !ws || ws.readyState !== 1) return;
          const f32 = e.inputBuffer.getChannelData(0);
          const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(i16.buffer);
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        micLive = true;
        lastHeardAt = now();
        emit();
        if (!settled) { logEvent({ type: "transcript_started", engine: "assemblyai" }); ready({ ok: true }); }
      };

      ws.onmessage = (evt) => {
        if (generation !== transcriptionGeneration || destroyed || finalized || !transcribing || socket !== ws) return;
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.type !== "Turn") return;
        const text = (msg.transcript || "").trim();
        if (!text) return;
        lastHeardAt = now();
        confirmMicrophone(text);
        if (msg.end_of_turn && msg.turn_is_formatted) {
          if (running && micCheck !== "checking") logEvent({ type: "voice", text });
          transcriptTail = [...transcriptTail, text].slice(-4);
          interim = "";
        } else if (!msg.end_of_turn) {
          interim = text;
        } else {
          // Keep an unformatted final turn until the formatted result arrives.
          interim = text;
        }
        save();
        scheduleCheckpoint();
        emit();
      };

      ws.onerror = () => {
        ready({ ok: false, reason: "ws_error" });
      };
      ws.onclose = () => {
        if (generation !== transcriptionGeneration || destroyed || finalized || socket !== ws) return;
        if (!settled) { ready({ ok: false, reason: "ws_closed" }); return; }
        if (transcribing && !finalized) scheduleAssemblyReconnect();
        else if (!micStream?.getAudioTracks().some((track) => track.readyState === "live")) {
          micLive = false;
          emit();
        }
      };
    });
  }

  /* Orchestrator: AssemblyAI when the server offers tokens, else the
     browser's own recognizer. A declined mic fails begin() either way. */
  async function startTranscription() {
    if (destroyed || finalized) return { ok: false, reason: 'cancelled' };
    const generation = transcriptionGeneration;
    transcribing = true;
    const primary = await startAssemblyTranscription();
    if (generation !== transcriptionGeneration || destroyed || finalized) return { ok: false, reason: "cancelled" };
    if (primary.ok) return primary;
    if (primary.reason === "mic_denied") { transcribing = false; return primary; }
    teardownAssembly();
    const probe = await probeMicDevice();
    if (generation !== transcriptionGeneration || destroyed || finalized) return { ok: false, reason: "cancelled" };
    if (!probe.ok) { transcribing = false; return probe; }
    return startBrowserTranscription();
  }

  /* ---------------- fallback engine: Web Speech API ---------------- */
  function startBrowserTranscription() {
    const generation = transcriptionGeneration;
    if (destroyed || finalized) return Promise.resolve({ ok: false, reason: 'cancelled' });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      return Promise.resolve({ ok: false, reason: "unsupported_sr",
        message: "This browser does not support live transcription. Use Google Chrome on a computer." });
    }
    return new Promise((resolve) => {
      recognition = new SR();
      const recognizer = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      transcribing = true;
      let settled = false;
      let restartDeadline = null;
      const ready = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => ready({ ok: false, reason: 'sr_timeout',
        message: 'Live transcription did not connect. Check your connection and try again.' }), 8000);
      const current = () => generation === transcriptionGeneration && !destroyed && !finalized && recognizer === recognition;

      recognition.onstart = () => {
        if (!current()) { try { recognizer.stop(); } catch {} ready({ ok: false, reason: 'cancelled' }); return; }
        clearTimeout(restartDeadline);
        micLive = true;
        lastHeardAt = now();
        emit();
        if (!settled) { logEvent({ type: "transcript_started" }); ready({ ok: true }); }
      };
      recognition.onresult = (ev) => {
        if (!current() || !transcribing) return;
        lastHeardAt = now();
        interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const text = (r[0]?.transcript || "").trim();
          if (!text) continue;
          confirmMicrophone(text);
          if (r.isFinal) {
            if (running && micCheck !== "checking") logEvent({ type: "voice", text });
            transcriptTail = [...transcriptTail, text].slice(-4);
          } else {
            interim += (interim ? " " : "") + text;
          }
        }
        save();
        scheduleCheckpoint();
        emit();
      };
      recognition.onerror = (ev) => {
        if (!current()) return;
        micLive = false;
        emit();
        if (finishMicCheck && ev.error !== "no-speech") {
          finishMicCheck({ ok: false, message: "We couldn't hear you through live transcription. Check microphone permission, unmute your mic, and check your connection, then try again." });
        }
        // Permission refusals fail the start; transient errors (no-speech,
        // network hiccups) are logged and ridden out via the auto-restart.
        if (!settled && ev.error !== 'no-speech') {
          transcribing = false;
          ready({ ok: false, reason: "mic_denied",
            message: "Microphone access was declined. The assessment needs you to talk through your thinking." });
          return;
        }
        if (ev.error && ev.error !== "no-speech" && running && !finalized) {
          logEvent({ type: "transcript_error", error: String(ev.error) });
        }
        if (settled && (ev.error === "audio-capture" || ev.error === "not-allowed" || ev.error === "service-not-allowed")) {
          micLost(ev.error);
        } else if (ev.error && ev.error !== 'no-speech' && running) {
          transcriptionFailed('Live transcription lost its connection.');
        }
      };
      // Chrome ends continuous sessions after silence — restart for as long
      // as the session wants a transcript.
      recognition.onend = () => {
        if (!current()) return;
        micLive = false;
        emit();
        if (transcribing && !finalized) {
          clearTimeout(restartDeadline);
          restartDeadline = setTimeout(() => {
            if (current() && transcribing && !micLive) transcriptionFailed('Live transcription did not restart.');
          }, 8000);
          try { recognizer.start(); } catch { transcriptionFailed('Live transcription could not restart.'); }
        } else {
          micLive = false;
          emit();
        }
      };
      try {
        recognition.start();
      } catch {
        if (!settled) {
          transcribing = false;
          ready({ ok: false, reason: "sr_failed", message: "Could not start live transcription. Try another browser." });
        }
      }
    });
  }

  /* getUserMedia failures are not all "declined". Tell the candidate what is
     actually wrong so they can fix it. Every branch keeps reason "mic_denied"
     so startTranscription() stops here instead of trying the browser engine. */
  function micError(err) {
    const name = err?.name || "";
    let message;
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      message = "No microphone was found. Plug in or enable a microphone or headset, then try again. The assessment cannot run without one.";
    } else if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
      message = "Your microphone could not be started — another app (Zoom, Teams, Meet, a recorder) is probably using it. Close that app, then try again.";
    } else if (name === "SecurityError") {
      message = "Microphone access is blocked on this page. Open the exact https:// link you were sent, not a copy.";
    } else {
      message = "Microphone access was declined. Allow the microphone for this site (the lock or camera icon in the address bar), then try again. The assessment needs you to talk through your thinking.";
    }
    return { ok: false, reason: "mic_denied", kind: name || "unknown", message };
  }

  /* The browser engine (Web Speech API) opens its own mic and never reports
     WHY it failed. Probe the device first so a missing or busy microphone
     fails with a clear message instead of a 30s silent-check timeout. */
  async function probeMicDevice() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: "mic_denied", kind: "unsupported",
        message: "This browser cannot access a microphone. Use Google Chrome on a computer." };
    }
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      probe.getTracks().forEach((track) => track.stop());
      return { ok: true };
    } catch (err) {
      return micError(err);
    }
  }

  /* Mic gone mid-session (unplugged, permission revoked, muted for good):
     treat it exactly like a stopped screen share — pause and lock until the
     candidate reconnects and passes the spoken check again. */
  let muteTimer = null;
  function micLost(reason) {
    if (!running || phase !== "running" || finalized) return;
    logEvent({ type: "mic_lost", reason });
    stopTranscription();
    block(reason === "muted" ? "Microphone muted" : "Microphone disconnected");
  }
  function watchMicTrack(track, generation) {
    track.addEventListener("ended", () => {
      if (generation !== transcriptionGeneration) return;
      micLive = false;
      finishMicCheck?.({ ok: false, message: "Your microphone disconnected. Reconnect it and try again." });
      emit();
      micLost("ended");
    });
    track.addEventListener("mute", () => {
      if (generation !== transcriptionGeneration) return;
      clearTimeout(muteTimer);
      muteTimer = setTimeout(() => {
        if (generation !== transcriptionGeneration || !track.muted) return;
        micLost("muted");
      }, 8000);
    });
    track.addEventListener("unmute", () => clearTimeout(muteTimer));
  }

  // A connection or permission grant is insufficient: require actual words
  // from the same transcription engine that will be used for the assessment.
  function confirmMicrophone(text) {
    const liveInput = !micStream || micStream.getAudioTracks().some((track) =>
      track.readyState === "live" && track.enabled !== false && !track.muted);
    if (text.trim() && micLive && transcribing && liveInput) finishMicCheck?.({ ok: true });
  }

  async function checkMicrophone() {
    if (destroyed || finalized) return { ok: false, reason: 'cancelled' };
    stopTranscription();
    micCheck = "checking";
    transcriptTail = [];
    interim = "";
    emit();
    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => finishMicCheck?.({ ok: false,
        message: "We couldn't hear any words. Allow microphone access, unmute your microphone, check the input selected in your browser or system settings, then try again and speak a full sentence. " +
          (running ? "Your assessment is still paused." : "Your assessment has not started.") }), 30000);
      finishMicCheck = (value) => {
        clearTimeout(timeout);
        finishMicCheck = null;
        resolve(value);
      };
      const finish = finishMicCheck;
      startTranscription().then((value) => {
        if (!value.ok && finishMicCheck === finish) finish(value);
      }).catch(() => {
        if (finishMicCheck === finish) finish({ ok: false,
          message: "Could not connect your microphone. Check your microphone and connection, then try again." });
      });
    });
    micCheck = result.ok ? "passed" : "idle";
    if (!result.ok) stopTranscription();
    emit();
    return result;
  }

  async function testMicrophone() {
    if (!preflightOnly || connecting || destroyed || finalized) return { ok: false, message: 'A microphone check is already in progress.' };
    connecting = true;
    micCheck = 'idle';
    transcriptTail = [];
    interim = '';
    emit();
    try {
      const response = await request(ENDPOINT + '/session?case=' + encodeURIComponent(caseId));
      const session = await response.json().catch(() => ({}));
      if (destroyed) return { ok: false, reason: 'cancelled' };
      if (!response.ok || session.status !== 'unused' || !session.sessionToken) {
        return { ok: false, message: 'This access code is not available for a microphone test. Check your code or reopen the assessment you already started.' };
      }
      state.sessionToken = session.sessionToken;
      const result = await checkMicrophone();
      const heard = [...transcriptTail, interim].filter(Boolean);
      stopTranscription();
      transcriptTail = heard;
      emit();
      return result;
    } catch {
      stopTranscription();
      return { ok: false, message: destroyed ? 'Microphone check cancelled.' : 'Could not connect. Check your connection and retry the microphone test.' };
    } finally { connecting = false; }
  }

  /* Nothing heard for a while during a running session: the candidate has a
     wrong default mic, a muted headset, or another app holding the device.
     Make it THEIR screen's problem (banner via snapshot) and the assessor's
     record (log event) — never silently produce an empty transcript. */
  const MIC_SILENT_AFTER_MS = 45_000;
  function micSilenceCheck() {
    if (!running || finalized || phase !== "running" || !micLive) return;
    const quiet = now() - lastHeardAt > MIC_SILENT_AFTER_MS;
    if (quiet && !silentLogged) {
      silentLogged = true;
      logEvent({ type: "mic_silent", after: Math.round(MIC_SILENT_AFTER_MS / 1000) });
      emit();
    } else if (!quiet && silentLogged) {
      silentLogged = false;
      emit();
    }
  }

  /* ---------------- block / pause ---------------- */
  function block(title) {
    if (phase === "blocked" || !running || finalized) return;
    stopTranscription();
    state.pauseStartedAt = now();
    logEvent({ type: "capture_blocked" });
    blockedTitle = title || "Screen sharing stopped";
    setPhase("blocked");
    void checkpoint();
  }
  function unblock() {
    if (phase !== "blocked") return;
    if (state.pauseStartedAt) {
      state.pausedTotal += now() - state.pauseStartedAt;
      state.pauseStartedAt = null;
    }
    logEvent({ type: "capture_restored", pausedTotal: Math.round(state.pausedTotal / 1000) });
    lastActivity = now();
    setPhase("running");
    void checkpoint();
  }

  /* ---------------- ticking ---------------- */
  function tick() {
    if (finalized) return;
    if (phase === "blocked") {
      if (PAUSE_LIMIT - Math.floor(pausedMsTotal() / 1000) <= 0) { finalize("pause_limit"); return; }
      emit();
      return;
    }
    if (phase === "running") {
      if (remaining() <= 0) { finalize("expired"); return; }
      emit();
    }
  }

  /* ---------------- session lifecycle ---------------- */
  function startLoops() {
    timers.push(setInterval(tick, 500));
    timers.push(setInterval(idleCheck, 1000));
    timers.push(setInterval(save, 4000));
    timers.push(setInterval(grabFrame, 1000));
    timers.push(setInterval(flushFrames, 15000));
    timers.push(setInterval(() => { void checkpoint(); }, 1000));
    timers.push(setInterval(micSilenceCheck, 2000));
  }
  function stopLoops() {
    timers.forEach(clearInterval);
    timers.length = 0;
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
  }

  function unlockSession(isResume) {
    running = true;
    lastActivity = now();
    if (isResume) logEvent({ type: "resume" });
    startLoops();
    save();
  }

  async function begin(details) {
    if (connecting || phase !== "gate" || destroyed) return { ok: false, message: "A connection check is already in progress." };
    connecting = true;
    try { return await beginChecked(details); }
    finally { connecting = false; }
  }

  async function beginChecked(details) {
    // Screen + mic first: the code must only bind once capture is actually live,
    // otherwise a declined share would burn the code with no session.
    const screen = await startCapture();
    if (!screen.ok) return screen;
    if (destroyed) { stopSharing(); return { ok: false }; }
    try { await restoreFrames(); }
    catch {
      stopSharing();
      return { ok: false, message: 'Could not save recordings in this browser. Enable site storage in Chrome and make sure your device has free space, then retry.' };
    }
    const mic = await checkMicrophone();
    if (!mic.ok) {
      stopSharing();
      stopTranscription();
      return mic;
    }
    if (!captureStream?.getVideoTracks().some((track) => track.readyState === "live") || !micLive) {
      stopSharing();
      stopTranscription();
      return { ok: false, message: "Your screen or microphone disconnected during the check. Please connect them and try again. Your assessment has not started." };
    }
    try {
      if (!state.sessionToken) throw new Error('Missing session owner.');
      // Keep the owner before the request: if its response is lost, a retry is
      // the same start, not a new candidate claiming the code.
      rememberOwner(state.sessionToken);
      let res;
      const portfolioFiles = details.portfolioFiles || [];
      if (details.cvFile || portfolioFiles.length) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        fd.append("sessionToken", state.sessionToken);
        fd.append("name", details.name);
        if (details.linkedin) fd.append("linkedin", details.linkedin);
        if (details.upwork) fd.append("upwork", details.upwork);
        if (details.cvFile) fd.append("cv", details.cvFile, details.cvFile.name);
        for (const file of portfolioFiles) fd.append("portfolio", file, file.name);
        res = await request(ENDPOINT + "/start", { method: "POST", headers: headers(), body: fd });
      } else {
        res = await request(ENDPOINT + "/start", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            caseId,
            sessionToken: state.sessionToken,
            name: details.name,
            linkedin: details.linkedin,
            upwork: details.upwork,
          }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        stopSharing();
        stopTranscription();
        return { ok: false, reason: "rejected", message: body?.error || "The code was rejected by the server." };
      }
      // The brief is withheld until start — it arrives with this response.
      const body = await res.json().catch(() => null);
      if (!body?.ok || !body.assessment) throw new Error('The start was not acknowledged.');
      if (destroyed || finalized) { stopSharing(); stopTranscription(); return { ok: false, reason: 'cancelled' }; }
      syncClock(body.serverNow);
      assessmentMeta = body.assessment;
      duration = assessmentMeta.durationSeconds || duration;
      const started = typeof body.startedAt === 'number' ? body.startedAt : Date.parse(body.startedAt);
      state.startedAt = Number.isFinite(started) ? started : now();
      // Until the acknowledged brief is visible, this time is paused. This
      // also preserves the original start when retrying a lost response.
      state.pausedTotal = Math.max(0, now() - state.startedAt);
      state.revision = Math.max(state.revision || 0, body.checkpoint?.revision || 0);
    } catch (error) {
      stopSharing();
      stopTranscription();
      micCheck = 'idle';
      emit();
      return { ok: false, reason: 'connection', message: error.message?.includes('another tab') ? error.message : "Couldn't start your assessment. Check your connection and try again. Your brief and timer have not started." };
    }
    // Persist only what serializes — the File object stays out of localStorage.
    state.candidate = {
      name: details.name,
      linkedin: details.linkedin || null,
      upwork: details.upwork || null,
      cv: details.cvFile?.name || null,
      portfolio: (details.portfolioFiles || []).map((f) => f.name),
    };
    state.finishedAt = null;
    state.startPending = false;
    transcriptTail = [];
    interim = "";
    logEvent({ t: 0, type: "unlock" });
    unlockSession(false);
    setPhase("running");
    // Capture can end while the start request is in flight. The code is now
    // owned, so lock this same session instead of losing it or starting over.
    if (!screenLive() || !micLive) block(!screenLive() ? 'Screen sharing stopped' : 'Microphone disconnected');
    else void checkpoint();
    return { ok: true };
  }

  async function reshare() {
    if (connecting || destroyed || finalized || phase !== 'blocked') return { ok: false, message: "This session cannot reconnect right now." };
    connecting = true;
    try { return await reshareChecked(); }
    finally { connecting = false; }
  }

  async function reshareChecked() {
    const result = screenLive() ? { ok: true } : await startCapture();
    if (result.ok) {
      if (destroyed || finalized || phase !== 'blocked') { stopSharing(); return { ok: false, reason: 'cancelled' }; }
      const mic = await checkMicrophone();
      if (destroyed || finalized || phase !== 'blocked') { stopSharing(); stopTranscription(); return { ok: false, reason: 'cancelled' }; }
      if (!mic.ok) {
        stopSharing();
        return mic;
      }
      if (!captureStream?.getVideoTracks().some((track) => track.readyState === "live") || !micLive) {
        stopSharing();
        stopTranscription();
        return { ok: false, message: "Your screen or microphone disconnected. Please try again." };
      }
      unblock();
      return result;
    }
    logEvent({ type: "capture_declined", reason: result.reason });
    return result;
  }

  function finalize(reason) {
    if (finalized) return;
    commitPendingVoice();
    finalized = true;
    running = false;
    stopLoops();
    if (state.pauseStartedAt) {
      state.pausedTotal += now() - state.pauseStartedAt;
      state.pauseStartedAt = null;
    }
    state.finishedAt = now();
    stopTranscription();
    stopSharing();
    state.log.push({ t: Math.min(tSec(), duration), type: "end", reason });
    state.done = false;
    state.pendingSubmission = true;
    state.doneReason = reason;
    save();
    setPhase('submitting');
    timers.push(setInterval(() => { void retrySubmit(); }, 5000));
    void retrySubmit();
  }

  async function retrySubmit() {
    if (submissionPromise || destroyed || !state.pendingSubmission || state.done) return submissionPromise;
    submissionError = '';
    emit();
    submissionPromise = (async () => {
      try {
        await restoreFrames();
        await Promise.all([...frameWrites]);
        // A durable server draft protects the transcript even if large image
        // uploads are interrupted. Only final acknowledgement enables Done.
        await checkpoint();
        if (!(await flushFrames())) throw new Error('Your recording has not finished uploading.');
        const res = await request(ENDPOINT, {
          method: 'POST', headers: headers(true), body: JSON.stringify(checkpointPayload()),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.ok !== true) throw new Error(out.error || 'The server has not confirmed your submission.');
        if (destroyed) return;
        state.done = true;
        state.doneReason = out.endReason || state.doneReason;
        state.pendingSubmission = false;
        state.pendingTranscript = '';
        stopLoops();
        save();
        setPhase('done');
      } catch (error) {
        if (!destroyed) {
          submissionError = `${error.message || 'Your session could not be saved.'} Keep this tab open and retry when your connection is back.`;
          save();
          emit();
        }
      } finally { submissionPromise = null; }
    })();
    return submissionPromise;
  }

  /* ---------------- frames ---------------- */
  function restoreFrames() {
    if (!frameRestore) frameRestore = recordings.list().then(saved => {
      const existing = new Set(frameQueue.map(frame => frame.id));
      frameQueue.push(...saved.filter(frame => !existing.has(frame.id)).map(frame => ({ ...frame, persisted: true })));
      frameQueue.sort((a, b) => a.t - b.t);
    }).catch(error => { frameRestore = null; throw error; });
    return frameRestore;
  }
  function grabFrame() {
    if (!running || phase !== "running" || !captureStream || !captureVideo.videoWidth) return;
    const scale = Math.min(1, 1280 / captureVideo.videoWidth);
    captureCanvas.width = Math.round(captureVideo.videoWidth * scale);
    captureCanvas.height = Math.round(captureVideo.videoHeight * scale);
    captureCanvas.getContext("2d").drawImage(captureVideo, 0, 0, captureCanvas.width, captureCanvas.height);
    const t = tSec();
    const saving = new Promise(resolve => captureCanvas.toBlob(resolve, 'image/jpeg', 0.55)).then(async blob => {
      if (!blob) return;
      const frame = { id: `${caseId}:f_${t}.jpg`, t, blob, persisted: false };
      if (frameQueue.some(existing => existing.id === frame.id)) return;
      frameQueue.push(frame);
      try { await recordings.put(frame); frame.persisted = true; }
      catch {
        if (!finalized && !destroyed) block('Recording storage interrupted');
      }
      emit();
    });
    frameWrites.add(saving);
    void saving.finally(() => { frameWrites.delete(saving); if (!destroyed) void flushFrames(); });
  }
  async function flushFrames() {
    if (frameUpload) return frameUpload;
    if (destroyed) return false;
    frameUpload = (async () => {
      try {
        await restoreFrames();
        await Promise.all([...frameWrites]);
        while (frameQueue.length) {
          if (destroyed) return false;
          const batch = frameQueue.slice(0, 30);
          for (const frame of batch) {
            if (!frame.persisted) { await recordings.put(frame); frame.persisted = true; }
          }
          const fd = new FormData();
          fd.append('caseId', caseId);
          fd.append('sessionToken', state.sessionToken || '');
          batch.forEach(frame => fd.append('frames', frame.blob, `f_${frame.t}.jpg`));
          const res = await request(ENDPOINT + '/frames', { method: 'POST', headers: headers(), body: fd });
          const out = await res.json().catch(() => ({}));
          if (!res.ok || out.ok !== true || out.saved !== batch.length) return false;
          const acknowledged = new Set(batch.map(frame => frame.id));
          frameQueue = frameQueue.filter(frame => !acknowledged.has(frame.id));
          // The server already has these frames. A failed local cleanup may
          // cause an idempotent re-upload after reload, but must never block
          // submission of evidence that has been safely received.
          await recordings.remove(batch.map(frame => frame.id)).catch(() => {});
          emit();
        }
        return true;
      } catch { return false; }
      finally { frameUpload = null; }
    })();
    return frameUpload;
  }

  /* ---------------- interaction events (from React handlers) ---------------- */
  function setZone(zone, value) {
    state.zones[zone] = value;
    emit();
  }
  function zoneFocus(zone) { currentZone = zone; anyZoneTouched = true; logEvent({ type: "focus", zone }); }
  function zoneBlur(zone) { if (currentZone === zone) currentZone = null; logEvent({ type: "blur", zone }); }
  function zonePaste(zone, chars) { logEvent({ type: "paste", zone, chars }); }
  function zoneCut(zone, chars) { logEvent({ type: "cut", zone, chars }); }
  function setConfidence(value) {
    state.confidence = value;
    logEvent({ type: "confidence", value });
    emit();
  }

  /* ---------------- global listeners ---------------- */
  function goAway() {
    if (!running || tabAway) return;
    tabAway = true;
    idleSince = null;
    logEvent({ type: "blur_tab" });
  }
  function comeBack() {
    if (!running || !tabAway) return;
    tabAway = false;
    lastActivity = now();
    logEvent({ type: "return_tab" });
  }
  function activity() {
    if (!running) return;
    if (idleSince) {
      logEvent({
        t: Math.max(0, Math.floor((idleSince - state.startedAt - state.pausedTotal) / 1000)),
        type: "idle",
        dur: Math.round((now() - idleSince) / 1000),
        zone: currentZone
      });
      idleSince = null;
    }
    lastActivity = now();
  }
  function idleCheck() {
    if (!running || tabAway || phase === "blocked" || idleSince) return;
    if (now() - lastActivity >= 8000) idleSince = lastActivity;
  }
  let mmThrottle = 0;
  const onMouseMove = () => {
    const n = now();
    if (n - mmThrottle > 400) { mmThrottle = n; activity(); }
  };
  const onVisibility = () => { document.hidden ? goAway() : comeBack(); };
  const onBeforeUnload = (e) => {
    if (running || state.pendingSubmission) { e.preventDefault(); e.returnValue = ""; }
  };
  const onPageHide = () => {
    if (!state.startedAt || state.done || preflightOnly) return;
    if (running && !finalized) block('Resume: share your entire screen');
    save();
    void checkpoint({ keepalive: true });
  };
  const onPageShow = (event) => {
    if (event.persisted && !destroyed) void boot();
  };
  const onOnline = () => {
    if (destroyed) return;
    if (state.pendingSubmission) void retrySubmit();
    else if (phase === 'fatal' && fatalInfo?.retryable) void boot();
    else { void checkpoint(); void flushFrames(); }
  };
  const activityEvents = ["keydown", "mousedown", "input", "scroll", "touchstart"];

  function attachGlobal() {
    activityEvents.forEach((ev) => window.addEventListener(ev, activity, { passive: true, capture: true }));
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", goAway);
    window.addEventListener("focus", comeBack);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
  }
  function detachGlobal() {
    activityEvents.forEach((ev) => window.removeEventListener(ev, activity, { capture: true }));
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", goAway);
    window.removeEventListener("focus", comeBack);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
  }

  /* reground: brief scrolled back into view mid-task */
  let observer = null;
  function observeBrief(el) {
    if (!el || !("IntersectionObserver" in window)) return;
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!running) return;
        if (!en.isIntersecting) { briefWasHidden = true; return; }
        if (briefWasHidden && anyZoneTouched && now() - lastReground > 5000) {
          lastReground = now();
          logEvent({ type: "reground" });
        }
      });
    }, { threshold: 0.15 });
    observer.observe(el);
  }

  /* ---------------- boot ---------------- */
  function proceedLocally(saved) {
    if (!saved?.startedAt) { setPhase('gate'); return; }
    state = { ...state, ...saved };
    state.sessionToken ||= readOwner();
    // Older versions marked done before an acknowledgement. Re-submit with
    // the owner rather than trusting a local completion flag.
    if (state.done || state.pendingSubmission) {
      finalized = true;
      running = false;
      state.done = false;
      state.pendingSubmission = true;
      setPhase('submitting');
      timers.push(setInterval(() => { void retrySubmit(); }, 5000));
      void retrySubmit();
      return;
    }
    // Fold time-while-closed into pause (closed tab == not sharing).
    const awaySince = state.pauseStartedAt || state.lastSavedAt || now();
    state.pausedTotal += Math.max(0, now() - awaySince);
    state.pauseStartedAt = null;
    // Preserve the last partial sentence at its original assessment time,
    // after excluding the time spent away from the page.
    commitPendingVoice();
    if (Math.floor(state.pausedTotal / 1000) >= PAUSE_LIMIT) { running = true; finalize("pause_limit"); return; }
    if (remaining() <= 0) { running = true; finalize("expired"); return; }
    unlockSession(true);
    block("Resume: share your entire screen");  // capture needs a fresh gesture
  }

  function readOwner() {
    try { return localStorage.getItem(OWNER_KEY) || load()?.sessionToken || null; } catch { return null; }
  }
  async function boot() {
    if (preflightOnly) return;
    destroyed = false;
    const generation = ++bootGeneration;
    stopLoops();
    // A page restored from the back/forward cache keeps this engine object.
    // Re-enter through loading so its old blocked phase cannot skip the new
    // pause after the time away has been folded into the saved state.
    running = false;
    stopTranscription();
    stopSharing();
    setPhase('loading');
    attachGlobal();
    if (!caseId || !/^[A-Z0-9]{4,12}$/.test(caseId)) {
      fatal("This link is not valid",
        "The link is missing its access code. Please use the exact link you were sent.");
      return;
    }
    const local = load();
    clockOffsetMs = Number.isFinite(local?.clockOffsetMs) ? local.clockOffsetMs : 0;
    state.sessionToken = readOwner();
    try {
        const res = await request(ENDPOINT + '/session?case=' + encodeURIComponent(caseId), { headers: headers() });
        if (!res.ok) throw new Error('Session status is unavailable.');
        const info = await res.json();
        if (destroyed || generation !== bootGeneration) return;
        // Once started, retain this browser's established clock basis across
        // reloads so an individual response cannot rewind elapsed time.
        if (!local?.startedAt) syncClock(info.serverNow);
        assessmentMeta = info.assessment || null;
        duration = assessmentMeta?.durationSeconds || DEFAULT_DURATION;
        if (info.status === "unknown") {
          fatal("This link is not valid",
            "The access code was not recognised. Please use the exact link you were sent, or contact the person who invited you.");
        } else if (info.status === "void") {
          fatal("This link has been disabled",
            "This assessment code is no longer active. Contact the person who invited you for a new link.");
        } else if (info.status === "submitted") {
          if (info.owned && state.sessionToken) {
            state = { ...state, ...(info.checkpoint || {}), ...(local || {}), sessionToken: state.sessionToken };
            state.revision = Math.max(Number(state.revision || 0), Number(info.finalRevision || 0));
            state.doneReason = info.endReason || state.doneReason || 'submitted';
            await restoreFrames();
            if (destroyed || generation !== bootGeneration) return;
            const unsentDraft = local?.startedAt && !local.done && (
              Number(local.revision || 0) > Number(info.checkpoint?.revision || 0) ||
              (local.log || []).length > (info.checkpoint?.log || []).length ||
              (local.pendingTranscript || '') !== (info.checkpoint?.pendingTranscript || '')
            );
            if (unsentDraft && !state.pendingSubmission) {
              // The server may have enforced the pause limit while this
              // browser was offline. Preserve its newer local evidence too.
              state.pauseStartedAt ||= state.lastSavedAt || now();
              finalized = false;
              finalize(info.endReason || 'pause_limit');
              return;
            }
            if (frameQueue.length || state.pendingSubmission || (local?.done && !info.checkpoint)) {
              finalized = true;
              state.done = false;
              state.pendingSubmission = true;
              setPhase('submitting');
              timers.push(setInterval(() => { void retrySubmit(); }, 5000));
              void retrySubmit();
              return;
            }
          }
          state.doneReason = info.endReason || state.doneReason || 'submitted';
          state.done = true;
          state.pendingSubmission = false;
          finalized = true;
          save();
          setPhase('done');
        } else if (info.status === 'active' && info.owned !== true) {
          fatal("This assessment is already in progress",
            info.error || "This code was started on another device or browser. Open it in the browser where you started, or contact the person who invited you.");
        } else if (info.status === 'active') {
          const checkpoint = info.checkpoint;
          const saved = local?.startedAt && Number(local.revision || 0) >= Number(checkpoint?.revision || 0)
            ? local : checkpoint || local;
          if (!saved?.startedAt) {
            fatal('Could not restore this session', 'Your saved session could not be loaded. Please retry or contact the person who invited you.');
            return;
          }
          proceedLocally({ ...saved, sessionToken: state.sessionToken });
        } else if (info.status === 'unused' && info.sessionToken) {
          // Do not overwrite another tab's active local draft until this
          // attempt actually owns a start. Keep this token in memory for now.
          state.sessionToken = local?.startPending && state.sessionToken ? state.sessionToken : info.sessionToken;
          setPhase('gate');
        } else {
          throw new Error('The session response was incomplete.');
        }
    } catch {
      if (destroyed || generation !== bootGeneration) return;
      if (local?.startedAt && local.sessionToken && (local.pendingSubmission || local.done)) {
        proceedLocally(local);
      } else {
        fatalInfo = { title: 'Could not connect', text: 'Check your internet connection and retry. Your assessment will not start until the server confirms it.', retryable: true };
        setPhase('fatal');
      }
    }
  }

  function destroy() {
    // React navigation should checkpoint too; a browser close uses pagehide.
    if (running && !finalized && !preflightOnly) onPageHide();
    destroyed = true;
    bootGeneration++;
    if (preflightOnly) requests.forEach(controller => controller.abort());
    stopLoops();
    detachGlobal();
    observer?.disconnect();
    stopTranscription();
    stopSharing();
  }

  return {
    boot, destroy, snapshot, begin, reshare, finalize, observeBrief, testMicrophone, retrySubmit,
    setZone, zoneFocus, zoneBlur, zonePaste, zoneCut, setConfidence,
    submit: () => finalize("submitted"),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
