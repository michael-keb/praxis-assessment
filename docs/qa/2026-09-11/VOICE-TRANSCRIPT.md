# Backend Engineer voice transcript — diagnosis, fix, remaining

**Date:** 11 Sep 2026  
**Production:** https://assessments.praxis-au.com  
**Assessment:** Backend Engineer - Remote (id 7, 15 minutes)  
**Symptom:** Only a few spoken lines are captured. Screen recording (1 fps frames) is fine.

This is **live transcription**, not an audio file. The product never keeps the microphone recording. What reviewers see is the `voice` event log. If those events are missing, the speech is gone.

---

## Production evidence

Pulled from admin session payloads. AssemblyAI started in every Backend Engineer session (`transcript_started` / `engine: assemblyai`). `audio` count is 0 on all of them — expected.

| Code | Candidate | Frames | Voice lines | Words | What actually landed |
|---|---|---|---|---|---|
| `M5BFVH` | Changhao Liu | 432 | 1 | 9 | Mic-check sentence only |
| `B9UMB8` | Junjing Yu | 245 | 2 | 12 | Mic check + “Part of the.” |
| `FJARCF` | Jax El Antaki | 779 | 7 | 55 | Mic check, then almost nothing until the end. 15 tab switches. `mic_lost` mid-session |
| `QB2B4J` | Bing Yan | 786 | 24 | 132 | Mic check, ~11 minutes of silence, short wrap-up |
| `NVC3SA` | Ming Yuan Chen | 784 | 39 | 151 | Sparse fragments, five `mic_silent` gaps, last ~5 minutes empty |
| `4GJHMG` | Thang Doan | 882 | 95 | 315 | Many split words (`Does.` / `N't.`) |
| `M99MZ5` | eddie lim | 783 | 101 | 381 | Same split-word pattern, 18 tab switches |

Same day, Manual Tester sessions that **stay on the assessment page** and talk in paragraphs:

| Code | Candidate | Voice lines | Words |
|---|---|---|---|
| `CXQYFA` | Nitish Kumar Gupta | 27 | 735 |
| `SQUSQM` | R Lekshmi Raj | 103 | 2171 |
| `8WQMUR` | Vemaiah Gari Sai Charitha | 40 | 1004 |

Backend engineers leave the tab to code. Testers stay on the page. The loss correlates with the tab being covered.

Existing Backend Engineer transcripts **cannot be recovered**. There is no audio to re-transcribe.

---

## Diagnosis — what the first pass got wrong

The earlier version of this note named three stacked root causes. Two of them do not hold up against how Chrome and AssemblyAI actually behave, and the “fix” for the third targeted a parameter the API no longer has.

### ✗ “Echo cancellation ate the voice”

The claim was that the old graph played the live microphone out of the speakers, so echo cancellation subtracted the candidate's own voice. It did not. A `ScriptProcessorNode` outputs whatever its handler writes into `outputBuffer`, and the handler never wrote anything, so the node output digital silence. Connecting it to the destination made it *run*; it did not make it *audible*. Echo cancellation had no reference to subtract. The gain-0 node added in the first pass changes nothing here (it is kept only because a node must reach the destination to be rendered at all).

### ✗ “Chrome suspended the AudioContext in the background”

Chrome does not suspend an `AudioContext` because a tab is hidden. What Chrome does to hidden tabs is throttle **timers**, and this page is exempt from the aggressive 1-per-minute throttling because it holds an open WebSocket. The 1 fps frames (783 in 15 minutes) prove the timers kept firing while the tab was covered. Resume-on-visibility is kept as cheap insurance for real suspensions (device change, Bluetooth profile switch, Safari), but it cannot be the production cause, and under the old code voice *did* come back when candidates returned to the tab (Bing Yan's wrap-up), which a stuck-suspended context would not allow.

### ✗ Turn-silence parameter did nothing

The first pass sent `min_end_of_turn_silence_when_confident=1000`. AssemblyAI's current streaming API calls this `min_turn_silence`, and its docs say unrecognised query parameters are **ignored, not rejected**. So the word-splitting fix silently did nothing. Both spellings are now sent.

### ✓ The log kept only formatted end-of-turn (real, but small)

The old handler waited for the formatted final and parked the unformatted one in a single `interim` string. If the socket dropped between the two, the turn was lost. This is a real bug and is fixed, but it cannot produce a 1-line session on its own: the formatted final normally follows the unformatted one within a second.

### What the old logs cannot tell us

In the old engine a 45-second stretch with **no** `Turn` messages logs `mic_silent`. That fires identically whether the candidate was silent or the audio never reached AssemblyAI. Conversely, a long stretch with no `voice` lines and no `mic_silent` means partials *were* arriving and finals never reached the log. There was no instrumentation to separate these. The Backend sessions are consistent with a mix of: candidates genuinely coding in silence, audio dropping in the covered tab, and one device loss (`mic_lost` on FJARCF).

Two mechanisms remain plausible for loss while the tab is covered, and the fix below closes both without needing to know which dominated:

1. **`ScriptProcessorNode` is main-thread bound and drops input when the page is busy.** In a background tab the renderer main thread is deprioritised, and this page does canvas draw + JPEG encode + IndexedDB write + upload every second on that same thread. The deprecated node has a hard deadline per buffer; miss it and the audio is discarded.
2. **A dead socket looked identical to a quiet candidate.** After a network change or laptop sleep, Chrome can take minutes to notice a half-open WebSocket. PCM kept being written into it; nothing came back; `mic_silent` was logged; no reconnect happened.

To settle which sessions were which, run the new diagnostic (below) against the seven codes. It could not be run from the coding session that wrote this note because logging in to production with the admin credentials was blocked by the tool's permission policy.

---

## The fix (local, committed, not deployed)

Goal: transcription keeps running regardless of tab visibility, focus, main-thread load, or a silently dead socket, and the admin log shows whether audio was flowing.

| Change | Where |
|---|---|
| **AudioWorklet capture.** PCM16 conversion runs on the audio rendering thread in 100 ms chunks and is posted to the page; late delivery only delays the send, it never drops audio. `ScriptProcessor` remains as a fallback if the worklet cannot load. `transcript_started` records which one (`audio: worklet|processor`). | `PCM_TAP_SOURCE`, `loadPcmTap`, `buildPcmTap` |
| **Heartbeats + socket watchdog.** `session_heartbeat=true` makes AssemblyAI send a frame every 5 s. 20 s without any frame (only once a heartbeat has been seen) logs `transcript_stalled` and reconnects. | `micSilenceCheck`, WebSocket URL |
| **Audio watchdog.** 15 s without a PCM chunk from the graph logs `audio_stalled` and rebuilds the graph + socket. The mic stream is kept, so no re-check, no pause. | `micSilenceCheck` |
| **Health telemetry.** Every 30 s while running: `audio_health {engine, chunks, level, ctx, hidden}`. `chunks` is PCM chunks sent in the window (~300 expected for the worklet), `level` an average dB figure (−100 is digital silence, speech −35…−15), `hidden` whether the tab was covered. | `micSilenceCheck` |
| **Turn parameters under the current names.** `min_turn_silence=1000` (plus the old spelling), `max_turn_silence=2800`, `end_of_turn_confidence_threshold=0.7`. | WebSocket URL |
| Unformatted end-of-turn logged immediately; a formatted turn with the same `turn_order` replaces that line; a later turn never deletes the previous one. | `applyAssemblyTurn` |
| `commitPendingVoice()` before reconnect teardown. | `scheduleAssemblyReconnect` |
| Resume a suspended/interrupted context on hide/show/blur/focus and each watchdog tick. | `keepAudioGraphAlive` |
| Diagnostic script for production sessions. | `scripts/voice-diagnose.mjs` |

Tests (`tests/microphone-gate.test.mjs`): worklet path streams PCM and asks for heartbeats; `audio_health` counts chunks while hidden; a silent graph is rebuilt without pausing or dropping the mic; a socket that stops heartbeating reconnects while audio is still flowing; unformatted → formatted upgrade; a later turn keeps the earlier final.

`npm test` — **41/41 passed.** `vite build` — clean.

Files in this change: `client/src/engine.js`, `tests/microphone-gate.test.mjs`, `scripts/voice-diagnose.mjs`, this note. Unrelated dirty files (Send a Sweet, Dockerfile, README, `server/index.js`) are left alone.

---

## Diagnostic

```bash
node scripts/voice-diagnose.mjs M5BFVH B9UMB8 FJARCF QB2B4J NVC3SA 4GJHMG M99MZ5
```

or `--assessment Backend` for every Backend Engineer code. Per session it prints time hidden, words captured while hidden vs visible, every transport event, the longest stretch with neither words nor a `mic_silent` warning, and — for sessions recorded after this deploy — average PCM chunks and level per 30 s while hidden vs visible. That last column is the direct answer to “was audio flowing while they were in the editor”.

---

## Remaining

### Blocked / cannot do

- **Recover today's sparse transcripts.** No audio was stored.

### Needed for the fix to matter

- [ ] Push `main` (Render auto-deploys `praxis-assessment`; Docker build takes several minutes). Use Homebrew git, the shim on PATH cannot push.
- [ ] Confirm Render serves the new bundle: a fresh session's `transcript_started` event must carry `audio: "worklet"`.
- [ ] Live dry run as a Backend Engineer: pass the mic check, switch to an editor, think aloud for several minutes, come back, submit. In `/admin` expect continuous `voice` lines and `audio_health` rows with `hidden: true` and `chunks` in the hundreds.
- [ ] Run the diagnostic against the seven old codes so the “silent candidate vs lost audio” question is answered with data rather than inference.
- [ ] `npm run test:experience` (Playwright) against this change.

### Follow-ups

- [ ] Domain keyterms (`keyterms_prompt`) if technical vocabulary is still garbled.
- [ ] Browser Speech fallback still has Chrome background-tab limits; AssemblyAI is primary.
- [ ] Product decision: keep a compressed audio backup (Opus at 24 kbps is ~2.7 MB per 15 minutes) so a failed live transcript can be rebuilt. Needs a consent-copy change.

---

## How to verify after deploy

1. Issue a Backend Engineer code.
2. Start, pass the mic check, then **immediately switch to another app** and talk through a solution for several minutes.
3. Switch back, submit.
4. Admin review should show continuous `voice` lines for the time in the editor, not only the opening sentence.
5. `audio_health` rows during that time should show `hidden: true`, `chunks` around 300, `level` in the −40…−15 range while talking.
6. Words should appear as sentences, not `Does.` / `N't.` fragments.
7. `blur_tab` / `return_tab` may still appear — that is fine. No `audio_stalled` or `transcript_stalled` should appear unless the network actually dropped.

If a dry run still shows `chunks` near 300 while hidden but few `voice` lines, the loss is on AssemblyAI's side or in end-of-turn handling, not in capture. If `chunks` is 0 or `level` is −100 while hidden, the loss is in capture and the `audio_stalled` rebuild should be visible in the log.
