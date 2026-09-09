**Assessment end-to-end audit — 9 September 2026**

**Fix status:** The findings below describe the original failures. All 11 now have implementation fixes and corrected-behavior regression tests; see the [fix and validation record](FIXES.md). The commands below now run regression assertions that require the corrected behavior.

11 distinct user-facing bugs were reproduced, including against the Chrome setup and microphone reconnect changes from thread `thr_nvymyzhrf3`. The highest priorities are false submission confirmation, lost assessment evidence, two candidates sharing one result, and capture restarting after submission.

Testing used an isolated copy of the application, a real Express server and SQLite database, synthetic candidates, and Chromium. Screen frames were real JPEGs generated from a synthetic canvas. Microphone streams, speech results, service failures and network interruptions were controlled test inputs. Physical microphone hardware, native permission dialogs, live speech recognition accuracy and the deployed site were **not** verified. No production data was used.

**Confirmed bugs**

1. **BUG-01 · High — “Session submitted” appears even when nothing was saved.**

   Start an assessment, speak, then submit while offline or while the submission endpoint returns HTTP 503. The candidate sees success and permission to close the tab; the server remains `active` with `payload: null`. Restoring connectivity and reloading still shows success without retrying. Both variants reproduced. `finalize()` marks local state done without checking the response, and boot trusts that local flag. Completion needs an acknowledged, retryable submission with a pending state until it is saved.

   [Screenshot](evidence/experience-BUG-01-false-su-bf17a-fline-no-recovery-on-reload.png) · [Submission code](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:755) · [Reload behavior](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:899)

2. **BUG-02 · High — A failed start request starts the timer on the wrong task.**

   Pass the microphone check, but drop `POST /api/assessment/start` before it reaches the server. The page starts the timer and displays the generic “Create something from nothing” brief instead of the assigned task. The code remains `unused`. Submitting after connectivity returns is accepted, with a null candidate name and no captured identity. Startup catches the network error and continues, while the submission endpoint accepts unused codes. Start must succeed before the task runs, and submit must require a properly started session.

   [Observations](evidence/observations.json) · [Startup](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:654) · [Submission endpoint](/Users/mk/Documents/Apps/Assessment-upload/server/assessment.js:152)

3. **BUG-03 · High — The candidate’s last spoken answer can disappear.**

   Speak a sentence that appears in live captions, then submit before the recognizer marks it final. “My final recommendation is option B.” was visible immediately before submission; the saved result contained zero voice events. Finalization stops transcription and clears interim text before collecting the result. Because raw audio is deliberately not kept, that answer cannot be recovered from a recording. Stop should preserve pending words or finish the recognizer’s finalization before assembling the payload.

   [Observations](evidence/observations.json) · [Final-only logging](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:422) · [Finalization](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:755)

4. **BUG-04 · High — Failed transcription recovery leaves the timer running without a working transcript.**

   Start through AssemblyAI, disconnect its socket, fail the replacement token request, and have the browser speech fallback reject startup. After another 55 seconds, the timer read `14:01`, the microphone track had ended, and the page still invited the candidate to talk. There was no pause overlay or reconnect button. The normal reconnect path passes; failure of both transcription paths is the broken branch. Exhausted recovery needs to pause the session and expose a usable retry action.

   [Screenshot](evidence/experience-BUG-04-connecti-88a8e-microphone-recovery-control.png) · [Reconnect path](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:257)

5. **BUG-05 · High — Losing screen sharing during the start request bypasses the lock.**

   Pass the microphone check, delay the start response, and stop sharing while that response is pending. When the response arrives, the assessment runs with the screen track already `ended`; no pause overlay appears. Capture is checked before the request, and the track-ended handler only blocks an already running session. Capture must be checked again after the asynchronous start response, with a recoverable lock if it disappeared.

   [Screenshot](evidence/experience-BUG-05-screen-d-6820b-g-does-not-pause-assessment.png) · [Startup](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:654)

6. **BUG-06 · High — Two candidates can run the same single-use code and mix identity with answers.**

   Open the same unused link in two browsers before either starts. Enter different names, then finish both startup checks. Both get a full running session. The second browser’s answer was saved under the first candidate’s name; both browsers later showed successful submission. The server treats every start of an active code as a valid resume without checking ownership. Bind starts and resume requests to one server-issued session owner, and reject the competing start.

   [Observations](evidence/observations.json) · [Unconditional active-code resume](/Users/mk/Documents/Apps/Assessment-upload/server/assessment.js:59)

7. **BUG-07 · High — Screen recordings are silently lost on failed uploads or immediate closure after success.**

   Fail a frame upload, restore connectivity, and finish. Frames `f_1.jpg` and `f_2.jpg` never reappeared; only later frames were saved. Separately, delay the final frame upload and close the tab when instructed by the success screen: the result became `submitted` with zero frames, despite a queued 9,255-byte upload. The queue is removed before acknowledgement, errors are swallowed, and completion does not wait for recordings. Persist and retry unsaved batches and verify required uploads before displaying completion.

   [Observations](evidence/observations.json) · [Frame uploader](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:798)

8. **BUG-08 · High — Closing the browser prevents automatic submission and leaves the reviewer without the transcript.**

   Start, speak, and close the tab before submitting. The transcript exists only in that browser’s local storage; the admin receives no payload. One test session was still `active`, with no payload or frames, 340 seconds after starting and approximately 338 seconds after closing—beyond the five-minute pause budget. Reopening the original browser can trigger recovery, but the server never finalizes the abandoned session by itself. Server-side checkpoints and expiry handling are needed to retain and finish the result when the candidate does not return.

   [Timed server evidence](evidence/abandoned-session.json) · [Recovery only on boot](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:899) · [Status endpoint](/Users/mk/Documents/Apps/Assessment-upload/server/assessment.js:38)

9. **BUG-09 · Medium — The homepage can reject a microphone setup that works in the assessment.**

   When AssemblyAI is configured but Chrome’s speech service cannot start, the homepage’s mandatory test fails and permanently disables Continue until that separate service works. Opening the candidate link directly successfully starts and saves a transcript through AssemblyAI under the same simulated service conditions. The homepage uses only browser speech recognition; the assessment prefers AssemblyAI. Preflight should validate the transcription path the actual assessment will use.

   [Screenshot](evidence/experience-BUG-09-homepage-46989-rowser-speech-service-fails.png) · [Homepage recognizer](/Users/mk/Documents/Apps/Assessment-upload/client/src/components/ChromeMicSetup.jsx:70) · [Continue gate](/Users/mk/Documents/Apps/Assessment-upload/client/src/main.jsx:72)

10. **BUG-10 · High — Editing an assessment can unexpectedly expire an active candidate’s timer.**

    Start a 15-minute assessment and work for 70 seconds. Change the admin duration to one minute, then reload the candidate page. The candidate goes from `13:50` remaining to “Time expired” and automatic submission. Brief and duration are read from the current editable assessment instead of a snapshot bound to the started session. Preserve the task and time allowance for active sessions when an admin edits the template.

    [Screenshot](evidence/experience-BUG-10-editing--3312f--their-assessment-on-reload.png) · [Live assessment lookup](/Users/mk/Documents/Apps/Assessment-upload/server/assessment.js:25)

11. **BUG-11 · High — A late reconnect permission grant restarts capture after submission.**

    Stop sharing, click reconnect, and leave the screen picker pending until the pause budget expires. After automatic submission, grant the pending screen request and speak. The page remains on “Pause limit reached”, but the screen track and speech recognizer are live again. This is an active capture leak; the test did not establish that additional frames or words were uploaded. Resume checks `destroyed`, but not `finalized`, after awaiting permission. Every delayed capture result must be discarded and stopped once the session ends.

    [Observations](evidence/observations.json) · [Resume path](/Users/mk/Documents/Apps/Assessment-upload/client/src/engine.js:734)

**What was verified**

31 browser scenarios completed: 18 working-flow checks and 13 successful reproductions of the 11 bugs above. The audit deliberately asserts that each reported defect occurs; a green BUG scenario means the defect was reproduced, not that the application is fixed. The latest engine suite passed all 16 tests, and the production build passed.

Working flows included homepage preflight and code entry; screen denial and wrong-window rejection with retry; silent, denied, missing and busy microphone handling; normal screen and microphone reconnects; refresh and transcript recovery; timer and pause-limit submission while the page remains open; required profile/CV/portfolio inputs; candidate identity; transcript and JPEG persistence; admin login and review; and ZIP download. The [successful synthetic ZIP](evidence/synthetic-success.zip) was opened and checked for the candidate, transcript, end event, frame files and code record.

The existing six-case brief-formatting suite passed five cases. Its plain-text editing case failed after its select-all/arrow sequence replaced the existing content with “Updated.” A separate check with an explicitly collapsed end-of-document cursor preserved both paragraphs and the line break after save/reopen. That test interaction failure is not counted as a confirmed product formatting bug.

The source was re-snapshotted after the earlier thread’s Chrome/reconnect edits; the final tested application files matched the workspace. [Source hashes](evidence/source-snapshot.json), [browser results for the 30-case batch](evidence/browser-results.json), [observations including the separately run deadline case](evidence/observations.json), and [engine test output](evidence/engine-tests.txt) are retained. This audit adds documentation and diagnostics; it does not apply product fixes.

**Reproduce locally**

From the repository root, run:

```sh
npx playwright test --config docs/qa/2026-09-09/playwright.config.js
```

The [configuration](playwright.config.js) builds the app and starts a [disposable test server](start-server.mjs) on port 18125. It refuses to reuse an existing server, overrides credentials and data paths, and leaves production data untouched. The [regression scenarios](experience.spec.js) use synthetic screen/microphone inputs. Results are written under `test-results/`. The original diagnostic assertions have been converted into desired-behavior assertions and expanded to cover recovery edge cases.
