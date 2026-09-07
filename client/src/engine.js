/*
 * Praxis assessment session engine — framework-agnostic port of the
 * verified single-file logic. Owns: timer + pause accounting, entire-screen
 * capture enforcement, event log, localStorage persistence/resume, 1fps
 * frame shipping, idle detection, auto-submit (expiry / pause budget).
 * React renders from snapshots via subscribe().
 */

export const DEFAULT_DURATION = 15 * 60;  // seconds; used until the code's assessment duration is known
export const PAUSE_LIMIT = 5 * 60;        // max cumulative paused seconds
const ENDPOINT = "/api/assessment";

export function createEngine(caseId) {
  const STORE_KEY = "praxis_assess_" + caseId;
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
    doneReason: null
  };

  let phase = "loading";  // loading | gate | running | blocked | done | fatal
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
  const now = () => Date.now();
  function effectiveMs() {
    if (!state.startedAt) return 0;
    const mark = state.pauseStartedAt || now();
    return Math.max(0, mark - state.startedAt - state.pausedTotal);
  }
  const tSec = () => Math.floor(effectiveMs() / 1000);
  const remaining = () => duration - Math.floor(effectiveMs() / 1000);
  const pausedMsTotal = () =>
    state.pausedTotal + (state.pauseStartedAt ? now() - state.pauseStartedAt : 0);

  /* ---------------- persistence + log ---------------- */
  function save() {
    state.lastSavedAt = now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; }
  }
  function logEvent(ev) {
    if (ev.t === undefined) ev.t = tSec();
    state.log.push(ev);
    save();
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
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return Promise.resolve({ ok: false, reason: "unsupported",
        message: "This browser does not support screen sharing. Use a current version of Chrome, Edge, or Firefox." });
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
    transcriptionGeneration++;
    transcribing = false;
    finishMicCheck?.({ ok: false, message: "Microphone check cancelled. You can try again when ready." });
    if (recognition) recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    try { recognition?.stop(); } catch { /* already stopped */ }
    recognition = null;
    teardownAssembly();
    interim = "";
    if (micLive) { micLive = false; emit(); }
  }

  function teardownAssembly() {
    clearTimeout(muteTimer);
    try { processor?.disconnect(); } catch { /* not connected */ }
    processor = null;
    if (ws) ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    try { audioCtx?.close(); } catch { /* already closed */ }
    audioCtx = null;
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
      const r = await fetch(ENDPOINT + "/transcribe-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId })
      });
      if (!r.ok) return null;
      return (await r.json()).token || null;
    } catch {
      return null;
    }
  }

  let reconnecting = false;
  function scheduleAssemblyReconnect() {
    if (!transcribing || finalized || reconnecting) return;
    reconnecting = true;
    micLive = false;
    emit();
    const generation = transcriptionGeneration;
    setTimeout(async () => {
      reconnecting = false;
      if (!transcribing || finalized || generation !== transcriptionGeneration) return;
      teardownAssembly();
      const again = await startAssemblyTranscription();
      if (generation !== transcriptionGeneration) return;
      if (!again.ok && transcribing && !finalized) {
        logEvent({ type: "transcript_error", error: "assembly reconnect failed — falling back to browser engine" });
        const fallback = await startBrowserTranscription();
        if (!fallback.ok) logEvent({ type: "transcript_error", error: "browser fallback also failed" });
      }
    }, 2500);
  }

  async function startAssemblyTranscription() {
    const generation = transcriptionGeneration;
    const token = await mintStreamToken();
    if (generation !== transcriptionGeneration) return { ok: false, reason: "cancelled" };
    if (!token) return { ok: false, reason: "no_token" };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
      if (generation !== transcriptionGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, reason: "cancelled" };
      }
      micStream = stream;
      stream.getAudioTracks().forEach((track) => watchMicTrack(track, generation));
    } catch (err) {
      return micError(err);
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: 16000 });
    await audioCtx.resume();
    if (generation !== transcriptionGeneration) return { ok: false, reason: "cancelled" };
    const rate = Math.round(audioCtx.sampleRate); // browser may not honour 16k — tell AAI what we actually have
    const source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    return new Promise((resolve) => {
      let settled = false;
      ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate=${rate}&format_turns=true&token=${encodeURIComponent(token)}`
      );
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
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
        if (!settled) { settled = true; logEvent({ type: "transcript_started", engine: "assemblyai" }); resolve({ ok: true }); }
      };

      ws.onmessage = (evt) => {
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
        }
        emit();
      };

      ws.onerror = () => {
        if (!settled) { settled = true; resolve({ ok: false, reason: "ws_error" }); }
      };
      ws.onclose = () => {
        if (!settled) { settled = true; resolve({ ok: false, reason: "ws_closed" }); return; }
        if (transcribing && !finalized) scheduleAssemblyReconnect();
        else { micLive = false; emit(); }
      };
    });
  }

  /* Orchestrator: AssemblyAI when the server offers tokens, else the
     browser's own recognizer. A declined mic fails begin() either way. */
  async function startTranscription() {
    const generation = transcriptionGeneration;
    transcribing = true;
    const primary = await startAssemblyTranscription();
    if (generation !== transcriptionGeneration) return { ok: false, reason: "cancelled" };
    if (primary.ok) return primary;
    if (primary.reason === "mic_denied") { transcribing = false; return primary; }
    teardownAssembly();
    const probe = await probeMicDevice();
    if (generation !== transcriptionGeneration) return { ok: false, reason: "cancelled" };
    if (!probe.ok) { transcribing = false; return probe; }
    return startBrowserTranscription();
  }

  /* ---------------- fallback engine: Web Speech API ---------------- */
  function startBrowserTranscription() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      return Promise.resolve({ ok: false, reason: "unsupported_sr",
        message: "This browser does not support live transcription. Use a current version of Chrome or Edge." });
    }
    return new Promise((resolve) => {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      transcribing = true;
      let settled = false;

      recognition.onstart = () => {
        micLive = true;
        lastHeardAt = now();
        emit();
        if (!settled) { settled = true; logEvent({ type: "transcript_started" }); resolve({ ok: true }); }
      };
      recognition.onresult = (ev) => {
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
        emit();
      };
      recognition.onerror = (ev) => {
        micLive = false;
        emit();
        if (finishMicCheck && ev.error !== "no-speech") {
          finishMicCheck({ ok: false, message: "We couldn't hear you through live transcription. Check microphone permission, unmute your mic, and check your connection, then try again." });
        }
        // Permission refusals fail the start; transient errors (no-speech,
        // network hiccups) are logged and ridden out via the auto-restart.
        if (!settled && (ev.error === "not-allowed" || ev.error === "service-not-allowed")) {
          settled = true;
          transcribing = false;
          resolve({ ok: false, reason: "mic_denied",
            message: "Microphone access was declined. The assessment needs you to talk through your thinking." });
          return;
        }
        if (ev.error && ev.error !== "no-speech" && running && !finalized) {
          logEvent({ type: "transcript_error", error: String(ev.error) });
        }
        if (settled && (ev.error === "audio-capture" || ev.error === "not-allowed" || ev.error === "service-not-allowed")) {
          micLost(ev.error);
        }
      };
      // Chrome ends continuous sessions after silence — restart for as long
      // as the session wants a transcript.
      recognition.onend = () => {
        micLive = false;
        emit();
        if (transcribing && !finalized) {
          try { recognition.start(); } catch { /* restarting too fast — the next tick's watchdog catches a dead mic */ }
        } else {
          micLive = false;
          emit();
        }
      };
      try {
        recognition.start();
      } catch {
        if (!settled) {
          settled = true;
          transcribing = false;
          resolve({ ok: false, reason: "sr_failed", message: "Could not start live transcription. Try another browser." });
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
        message: "This browser cannot access a microphone. Use a current version of Chrome or Edge." };
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
    state.pauseStartedAt = now();
    logEvent({ type: "capture_blocked" });
    blockedTitle = title || "Screen sharing stopped";
    setPhase("blocked");
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
    timers.push(setInterval(micSilenceCheck, 2000));
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
      let res;
      const portfolioFiles = details.portfolioFiles || [];
      if (details.cvFile || portfolioFiles.length) {
        const fd = new FormData();
        fd.append("caseId", caseId);
        fd.append("name", details.name);
        if (details.linkedin) fd.append("linkedin", details.linkedin);
        if (details.upwork) fd.append("upwork", details.upwork);
        if (details.cvFile) fd.append("cv", details.cvFile, details.cvFile.name);
        for (const file of portfolioFiles) fd.append("portfolio", file, file.name);
        res = await fetch(ENDPOINT + "/start", { method: "POST", body: fd });
      } else {
        res = await fetch(ENDPOINT + "/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caseId,
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
      if (body?.assessment) {
        assessmentMeta = body.assessment;
        duration = assessmentMeta.durationSeconds || duration;
      }
    } catch {
      /* offline tolerance; server re-validates on submit */
    }
    // Persist only what serializes — the File object stays out of localStorage.
    state.candidate = {
      name: details.name,
      linkedin: details.linkedin || null,
      upwork: details.upwork || null,
      cv: details.cvFile?.name || null,
      portfolio: (details.portfolioFiles || []).map((f) => f.name),
    };
    state.startedAt = now();
    transcriptTail = [];
    interim = "";
    logEvent({ t: 0, type: "unlock" });
    unlockSession(false);
    setPhase("running");
    return { ok: true };
  }

  async function reshare() {
    if (connecting || destroyed) return { ok: false, message: "A connection check is already in progress." };
    connecting = true;
    try { return await reshareChecked(); }
    finally { connecting = false; }
  }

  async function reshareChecked() {
    const result = screenLive() ? { ok: true } : await startCapture();
    if (result.ok) {
      if (destroyed) { stopSharing(); return { ok: false }; }
      const mic = await checkMicrophone();
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
    finalized = true;
    running = false;
    if (state.pauseStartedAt) {
      state.pausedTotal += now() - state.pauseStartedAt;
      state.pauseStartedAt = null;
    }
    stopTranscription();
    stopSharing();
    flushFrames();
    state.log.push({ t: Math.min(tSec(), duration), type: "end", reason });
    state.done = true;
    state.doneReason = reason;
    save();

    const payload = JSON.stringify({
      caseId,
      startedAt: state.startedAt,
      pausedTotal: state.pausedTotal,
      log: state.log
    });
    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true
    }).catch(() => {
      try { navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: "application/json" })); } catch {}
    });
    setPhase("done");
  }

  /* ---------------- frames ---------------- */
  function grabFrame() {
    if (!running || phase !== "running" || !captureStream || !captureVideo.videoWidth) return;
    const scale = Math.min(1, 1280 / captureVideo.videoWidth);
    captureCanvas.width = Math.round(captureVideo.videoWidth * scale);
    captureCanvas.height = Math.round(captureVideo.videoHeight * scale);
    captureCanvas.getContext("2d").drawImage(captureVideo, 0, 0, captureCanvas.width, captureCanvas.height);
    const t = tSec();
    captureCanvas.toBlob((blob) => { if (blob) frameQueue.push({ t, blob }); }, "image/jpeg", 0.55);
  }
  function flushFrames() {
    if (!frameQueue.length) return;
    const batch = frameQueue.splice(0, frameQueue.length);
    const fd = new FormData();
    fd.append("caseId", caseId);
    batch.forEach((f) => fd.append("frames", f.blob, `f_${f.t}.jpg`));
    fetch(ENDPOINT + "/frames", { method: "POST", body: fd }).catch(() => {});
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
    if (running && !finalized) { e.preventDefault(); e.returnValue = ""; }
  };
  const activityEvents = ["keydown", "mousedown", "input", "scroll", "touchstart"];

  function attachGlobal() {
    activityEvents.forEach((ev) => window.addEventListener(ev, activity, { passive: true, capture: true }));
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", goAway);
    window.addEventListener("focus", comeBack);
    window.addEventListener("beforeunload", onBeforeUnload);
  }
  function detachGlobal() {
    activityEvents.forEach((ev) => window.removeEventListener(ev, activity, { capture: true }));
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", goAway);
    window.removeEventListener("focus", comeBack);
    window.removeEventListener("beforeunload", onBeforeUnload);
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
  function proceedLocally() {
    const saved = load();
    if (!saved || !saved.startedAt) { setPhase("gate"); return; }
    state = saved;
    if (state.done) { setPhase("done"); return; }
    // Fold time-while-closed into pause (closed tab == not sharing).
    const awaySince = state.pauseStartedAt || state.lastSavedAt || now();
    state.pausedTotal += Math.max(0, now() - awaySince);
    state.pauseStartedAt = null;
    if (Math.floor(state.pausedTotal / 1000) >= PAUSE_LIMIT) { running = true; finalize("pause_limit"); return; }
    if (remaining() <= 0) { running = true; finalize("expired"); return; }
    unlockSession(true);
    block("Resume: share your entire screen");  // capture needs a fresh gesture
  }

  function boot() {
    destroyed = false;
    attachGlobal();
    if (!caseId || !/^[A-Z0-9]{4,12}$/.test(caseId)) {
      fatal("This link is not valid",
        "The link is missing its access code. Please use the exact link you were sent.");
      return;
    }
    fetch(ENDPOINT + "/session?case=" + encodeURIComponent(caseId))
      .then((res) => res.json())
      .then((info) => {
        assessmentMeta = info.assessment || null;
        duration = assessmentMeta?.durationSeconds || DEFAULT_DURATION;
        if (info.status === "unknown") {
          fatal("This link is not valid",
            "The access code was not recognised. Please use the exact link you were sent, or contact the person who invited you.");
        } else if (info.status === "void") {
          fatal("This link has been disabled",
            "This assessment code is no longer active. Contact the person who invited you for a new link.");
        } else if (info.status === "submitted") {
          const saved = load();
          if (saved?.done) state = saved;
          state.doneReason = state.doneReason || "submitted";
          setPhase("done");
        } else if (info.status === "active" && !load()) {
          fatal("This assessment is already in progress",
            "This code was started on another device or browser. An assessment can only run where it was started.");
        } else {
          proceedLocally();
        }
      })
      .catch(() => proceedLocally()); // offline: POSTs re-validate later
  }

  function destroy() {
    destroyed = true;
    timers.forEach(clearInterval);
    timers.length = 0;
    detachGlobal();
    observer?.disconnect();
    stopTranscription();
    stopSharing();
  }

  return {
    boot, destroy, snapshot, begin, reshare, finalize, observeBrief,
    setZone, zoneFocus, zoneBlur, zonePaste, zoneCut, setConfidence,
    submit: () => finalize("submitted"),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
