**Assessment experience fixes — 9 September 2026**

All 11 defects in the [original audit](REPORT.md) have implementation fixes and regression coverage. The original audit evidence is retained separately from the corrected-behavior test results.

| Audit issue | Corrected behavior |
| --- | --- |
| BUG-01 · False submission success | Stopping capture enters **Saving your session**. Completion requires acknowledgement of both recordings and the final result. Network/HTTP failures remain pending, expose **Retry saving**, and recover on reconnect or reload. |
| BUG-02 · Failed start runs the wrong task | A failed or unacknowledged start stays at the gate. The brief and timer are revealed only after the server confirms the owned start. A committed start with a lost response retries idempotently with its original identity and time. Unused codes cannot submit. |
| BUG-03 · Last spoken words disappear | Pending words are retained on pause, submission, reload and server expiry, with an interim marker when recognition had not finished. |
| BUG-04 · Failed speech recovery keeps running | Exhausted AssemblyAI/browser recovery pauses the session and offers a fresh spoken check. A browser recognizer that silently fails to restart also reaches this recovery state. |
| BUG-05 · Screen loss during start bypasses lock | The engine rechecks live screen and microphone state after the start response. If either disappeared, the same owned session opens paused and recoverable. |
| BUG-06 · Two candidates share a result | The first start atomically binds a signed browser owner, candidate identity and assessment snapshot. Other owners cannot start, resume, submit, upload or access private checkpoint data. Same-owner retries preserve the original identity. |
| BUG-07 · Failed uploads lose screen frames | Unacknowledged frames persist in IndexedDB. Failed batches remain queued across reload, and completion waits for the final server acknowledgement. Local cleanup failure cannot block an already accepted recording; any retained local copy can be uploaded again safely. |
| BUG-08 · Browser closure loses the result | Full transcript checkpoints are saved to SQLite and shown to admins as a draft. A server sweep enforces the remaining pause budget even after a restart. Newer evidence arriving after server finalization is retained and marked late, preserving the original cutoff and end reason. |
| BUG-09 · Homepage tests a different speech service | The homepage validates the code, obtains its own signed preflight token and uses the assessment engine's AssemblyAI-first/browser-fallback path. Editing the code or retesting invalidates the previous pass; cancellation releases resources. |
| BUG-10 · Admin edits change an active task | Title, brief, duration and required fields are frozen at the first successful start. Template edits affect future starts; the active session restores its original snapshot. |
| BUG-11 · Late permission restarts capture after submission | Generation and lifecycle checks discard and stop delayed screen/microphone grants and obsolete speech callbacks after finalization or navigation. |

The reviewer page now shows saved draft transcript data, and ZIP exports include the latest checkpoint with its bearer token removed. The API documentation describes owner tokens, checkpoints, idempotent starts, protected uploads and late evidence. The engine also aligns the initial clock to the server, so a fast computer clock does not consume the candidate's pause allowance.

**Verification**

The full browser suite passed **35/35**, with no failures, skips or flaky retries. All **6/6** brief-formatting scenarios and **27/27** engine/server checks passed (18 engine lifecycle checks and nine disposable real-HTTP server checks). The production build and diff checks passed. After constraining the retry button's width during visual review, the focused HTTP 503 submission scenario passed again.

[Full browser results](fix-evidence/browser-results.json) · [Verification and source hashes](fix-evidence/verification.json) · [Saving/retry screenshot](fix-evidence/saving-http-503.png) · [Acknowledged submission screenshot](fix-evidence/session-submitted.png)

Run from the repository root:

```sh
npm test
npm run test:experience
npm run test:briefs
```

The browser suites build the app and start disposable servers on ports 18125 and 18124. They use synthetic candidates, screen frames, microphone streams, speech events and network failures. Server tests cover concurrent starts, monotonic checkpoints, missing/competing tokens, expiry, process restart, legacy sessions, late retries and API documentation. Physical microphone hardware, native Chrome permission dialogs, live recognition accuracy and the deployed site were not tested.

**Deployment consideration**

At validation time, these changes had not been deployed. Existing active sessions from before owner tokens were introduced cannot be safely assigned a new owner during migration. Let them finish before deploying; if an interrupted legacy session needs to continue, review its evidence, void the old code and issue a replacement. Existing submitted evidence stays available to admins. Preserve the database and JWT secret across restarts.
