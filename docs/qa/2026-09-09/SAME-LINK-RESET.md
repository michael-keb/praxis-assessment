**Same-link assessment resets — 9 September 2026**

A candidate could complete the required details but leave Start disabled by pasting a LinkedIn profile without `https://`. The gate now accepts a bare LinkedIn or Upwork profile host, normalizes it to HTTPS, and explains invalid values beside the field. The server validates the parsed host and stores the canonical URL.

Admins can now reset an attempt while preserving its exact code and assessment assignment. `POST /api/admin/codes/:code/reset` requires an idempotent `requestId` and the reviewed `expectedGeneration`; callers can also supply `expectedStatus` to prevent resetting an attempt whose status changed. The original files, code metadata and checkpoint are archived on the persistent data disk before candidate, timing, ownership and submission state are cleared. Reset archives are included in the admin session ZIP.

Each reset increments `sessionGeneration`. Older owner tokens can no longer write to that code. Reloading the same URL clears prior local completion/start-pending state and separates old recording frames from the new attempt. Late responses from the earlier attempt cannot unlock or complete the fresh attempt. Existing generation-0 sessions, including tokens issued before generations were introduced, remain compatible.

**Verification**

- 41/41 browser experience scenarios passed, including full same-link start/submit/reset/start, persisted page restore, legacy local state, old-frame isolation and profile validation.
- 35/35 engine/server tests passed, including late asynchronous responses, valid reset-generation reloads with clock skew, evidence preservation, rollback, old-token rejection and idempotent retries after a fresh owner starts.
- 6/6 brief-formatting browser tests and the production build passed.
- Independent client review found no actionable blockers.
- Before deployment, 15 live code lookups covered unused, active, submitted and void states; none exposed the assessment brief. The two affected records were inspected and backed up privately, and backup ZIP integrity was verified.

[Test results and source hashes](reset-evidence/verification.json)

Browser tests use synthetic microphones, screen frames, speech and network failures. They do not establish physical microphone compatibility or live transcription accuracy. Production candidate data and backups are kept outside the public repository. The production reset and post-deployment evidence are recorded privately with the operational backups.
