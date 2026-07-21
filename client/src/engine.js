/*
 * Praxis assessment session engine — framework-agnostic port of the
 * verified single-file logic. Owns: timer + pause accounting, entire-screen
 * capture enforcement, event log, localStorage persistence/resume, 1fps
 * frame shipping, idle detection, auto-submit (expiry / pause budget).
 * React renders from snapshots via subscribe().
 */

export const DURATION = 15 * 60;          // seconds of assessment time
export const PAUSE_LIMIT = 5 * 60;        // max cumulative paused seconds
const ENDPOINT = "/api/assessment";

export function createEngine(caseId) {
  const STORE_KEY = "praxis_assess_" + caseId;

  let state = {
    startedAt: null,
    candidate: null,        // {name, email, upwork} captured at the gate
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
  let frameQueue = [];
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
  const remaining = () => DURATION - Math.floor(effectiveMs() / 1000);
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
      doneReason: state.doneReason
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
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude"
    };
    // Keep the browser from focus-jumping to a captured tab/window: without
    // this, picking a tab yanks the candidate off the assessment page before
    // they can see the rejection. Chrome/Edge 109+; harmless elsewhere.
    if (typeof window.CaptureController === "function") {
      try {
        const controller = new CaptureController();
        controller.setFocusBehavior("no-focus-change");
        options.controller = controller;
      } catch { /* older browser — picker behaves as before */ }
    }
    return navigator.mediaDevices.getDisplayMedia(options).then((stream) => {
      // The picker still offers tab/window; enforce entire-screen after the fact.
      const track = stream.getVideoTracks()[0];
      const surface = track.getSettings ? track.getSettings().displaySurface : null;
      if (surface && surface !== "monitor") {
        stream.getTracks().forEach((tr) => tr.stop());
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
  function stopSharing() {
    captureStream?.getTracks().forEach((tr) => tr.stop());
    captureStream = null;
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
  }

  function unlockSession(isResume) {
    running = true;
    lastActivity = now();
    if (isResume) logEvent({ type: "resume" });
    startLoops();
    save();
  }

  async function begin(details) {
    // Capture first: the code must only bind once sharing is actually live,
    // otherwise a declined share would burn the code with no session.
    const result = await startCapture();
    if (!result.ok) return result;
    try {
      const res = await fetch(ENDPOINT + "/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, ...details })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        stopSharing();
        return { ok: false, reason: "rejected", message: body?.error || "The code was rejected by the server." };
      }
    } catch {
      /* offline tolerance; server re-validates on submit */
    }
    state.candidate = details;
    state.startedAt = now();
    logEvent({ t: 0, type: "unlock" });
    unlockSession(false);
    setPhase("running");
    return { ok: true };
  }

  async function reshare() {
    const result = await startCapture();
    if (result.ok) { unblock(); return result; }
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
    stopSharing();
    state.log.push({ t: Math.min(tSec(), DURATION), type: "end", reason });
    state.done = true;
    state.doneReason = reason;
    save();

    const payload = JSON.stringify({
      caseId,
      startedAt: state.startedAt,
      zones: state.zones,
      confidence: state.confidence,
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
    attachGlobal();
    if (!caseId || !/^[A-Z0-9]{4,12}$/.test(caseId)) {
      fatal("This link is not valid",
        "The link is missing its access code. Please use the exact link you were sent.");
      return;
    }
    fetch(ENDPOINT + "/session?case=" + encodeURIComponent(caseId))
      .then((res) => res.json())
      .then((info) => {
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
    timers.forEach(clearInterval);
    timers.length = 0;
    detachGlobal();
    observer?.disconnect();
    stopSharing();
  }

  return {
    boot, destroy, snapshot, begin, reshare, finalize, observeBrief,
    setZone, zoneFocus, zoneBlur, zonePaste, zoneCut, setConfidence,
    submit: () => finalize("submitted"),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
