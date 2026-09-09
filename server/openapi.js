import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { PORT } from "./config.js";

/* Hand-written spec rather than JSDoc annotations: the surface is small and
   stable, and keeping it in one file makes it reviewable in a single read.
   Served at /api/openapi.json, browsable at /api/docs. */
export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Praxis Assessment API",
    version: "2.0.0",
    description:
      "Assessment platform API.\n\n" +
      "Three surfaces, three auth schemes:\n" +
      "- **`/api/assessment/*`** — candidate-facing. An unused code issues a signed browser-owner token; protected calls send it in `X-Assessment-Session` or the documented body field.\n" +
      "- **`/api/admin/*`** — admin session cookie (`praxis_session`), issued by `POST /api/auth/login`.\n" +
      "- **`/api/integrations/*`** — machine-to-machine, `Authorization: Bearer <EXTENSION_API_KEY>`.\n\n" +
      `The server listens on port ${PORT}, locked to this app by the port registry. ` +
      "Bare `PORT` is never read (the preview/AI harness injects it); override with `ASSESSMENT_PORT`."
  },
  servers: [
    { url: `http://localhost:${PORT}`, description: "Local" },
    { url: "https://{host}", description: "Deployed", variables: { host: { default: "assess.example.com" } } }
  ],
  tags: [
    { name: "auth", description: "Admin sign-in" },
    { name: "assessment", description: "Candidate-facing capture flow (code-gated, no account)" },
    { name: "admin", description: "Admin console — assessments, codes, captured sessions" },
    { name: "integrations", description: "Server-to-server code issuance (Chrome extension)" },
    { name: "system", description: "Health and docs" }
  ],
  components: {
    securitySchemes: {
      sessionCookie: { type: "apiKey", in: "cookie", name: "praxis_session" },
      assessmentSession: {
        type: "apiKey",
        in: "header",
        name: "X-Assessment-Session",
        description: "Signed candidate-browser owner token returned by GET /api/assessment/session while a code is unused. It is scoped to the code's current sessionGeneration, so an admin reset immediately invalidates earlier tokens. JSON and multipart routes also accept the same value in a sessionToken body field."
      },
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "Shared secret from the EXTENSION_API_KEY environment variable."
      }
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          code: { type: "string", description: "Stable machine-readable error code when supplied." },
          recovery: { type: "string", description: "Admin recovery guidance for legacy sessions when supplied." }
        },
        required: ["error"],
        example: { error: "unknown code" }
      },
      Ok: { type: "object", properties: { ok: { type: "boolean", example: true } } },
      Code: {
        type: "string",
        description: "Single-use assessment code — six characters, no 0/O/1/I/L.",
        pattern: "^[A-Z0-9]{6}$",
        example: "K7QM4X"
      },
      CodeStatus: {
        type: "string",
        enum: ["unused", "active", "submitted", "void"],
        description: "unused = issued, not opened; active = candidate started; submitted = payload received; void = revoked."
      },
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          upwork: { type: "string" },
          role: { type: "string", enum: ["admin", "candidate"] }
        }
      },
      GateFields: {
        type: "object",
        properties: {
          linkedin: { type: "boolean" },
          upwork: { type: "boolean" },
          cv: { type: "boolean" },
          portfolio: { type: "boolean" }
        }
      },
      CandidateAssessment: {
        type: "object",
        required: ["title", "brief", "durationSeconds", "gateFields"],
        properties: {
          title: { type: "string" },
          brief: { type: "string", description: "Frozen Markdown brief. Withheld until the caller proves ownership after start." },
          durationSeconds: { type: "integer", minimum: 60 },
          gateFields: { $ref: "#/components/schemas/GateFields" }
        },
        description: "Immutable copy bound at the first successful start. Unassigned codes use Assessment, an empty brief, 900 seconds, and LinkedIn-only gate defaults."
      },
      CandidateAssessmentMetadata: {
        type: "object",
        required: ["title", "durationSeconds", "gateFields"],
        properties: {
          title: { type: "string" },
          durationSeconds: { type: "integer", minimum: 60 },
          gateFields: { $ref: "#/components/schemas/GateFields" }
        },
        description: "Public assessment metadata. The brief is deliberately absent."
      },
      AssessmentCheckpoint: {
        type: "object",
        required: [
          "caseId", "sessionToken", "sessionGeneration", "startedAt", "pausedTotal", "pauseStartedAt",
          "lastSavedAt", "log", "revision", "phase", "elapsedMs"
        ],
        properties: {
          caseId: { $ref: "#/components/schemas/Code" },
          sessionToken: { type: "string", description: "Signed browser-owner token. Removed from the admin representation." },
          sessionGeneration: { type: "integer", minimum: 0, description: "Server generation for this use of the code. The server clamps persisted checkpoints to the token's current generation." },
          startedAt: { type: "integer", format: "int64", description: "Server-issued Unix time in milliseconds; must exactly match the start response." },
          pausedTotal: { type: "integer", format: "int64", minimum: 0, description: "Completed cumulative pause time in milliseconds." },
          pauseStartedAt: { type: "integer", format: "int64", minimum: 0, nullable: true },
          lastSavedAt: { type: "integer", format: "int64", minimum: 0, description: "Browser save time in milliseconds. Expiry also uses a separate server receipt time." },
          log: { type: "array", items: { type: "object", additionalProperties: true } },
          revision: { type: "integer", minimum: 0, description: "Strictly increasing browser-state revision. Revision 0 is the server-created initial checkpoint." },
          phase: { type: "string", enum: ["running", "blocked", "submitting"], description: "submitting remains active until the final endpoint acknowledges it." },
          elapsedMs: { type: "integer", format: "int64", minimum: 0, description: "Completed assessment time excluding pauses. Reaching the frozen duration finalizes with expired." },
          pendingTranscript: { type: "string", description: "Current interim speech, retained if the server must finalize the session." }
        },
        additionalProperties: true
      },
      Assessment: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          brief: { type: "string", description: "Markdown brief shown to the candidate. Supports headings, bold, italics, lists, links and code; plain text and line breaks remain supported." },
          duration_minutes: { type: "integer", minimum: 1 },
          require_linkedin: { type: "boolean" },
          require_upwork: { type: "boolean" },
          require_cv: { type: "boolean" },
          require_portfolio: { type: "boolean" },
          created_at: { type: "string" },
          updated_at: { type: "string" },
          code_count: { type: "integer", description: "Codes issued under this assessment (list endpoint only)." }
        }
      },
      AssessmentInput: {
        type: "object",
        required: ["title", "durationMinutes"],
        properties: {
          title: { type: "string" },
          brief: { type: "string", description: "Brief as Markdown or plain text. The admin rich text editor saves Markdown." },
          durationMinutes: { type: "integer", minimum: 1 },
          requireLinkedin: { type: "boolean", default: true },
          requireUpwork: { type: "boolean", default: false },
          requireCv: { type: "boolean", default: false },
          requirePortfolio: { type: "boolean", default: false }
        }
      },
      CodeRecord: {
        type: "object",
        properties: {
          code: { $ref: "#/components/schemas/Code" },
          status: { $ref: "#/components/schemas/CodeStatus" },
          assessment_id: { type: "integer", nullable: true },
          assessment_title: { type: "string", nullable: true },
          created_at: { type: "string" },
          started_at: { type: "string", nullable: true },
          submitted_at: { type: "string", nullable: true },
          end_reason: { type: "string", nullable: true },
          started_at_ms: { type: "integer", format: "int64", nullable: true },
          final_revision: { type: "integer", nullable: true },
          session_generation: { type: "integer", minimum: 0, description: "Increments on every guarded reset; tokens from earlier generations are rejected." },
          last_reset_request_id: { type: "string", nullable: true },
          reset_at: { type: "string", format: "date-time", nullable: true },
          assessment_snapshot: { type: "string", nullable: true, description: "Internal JSON snapshot frozen at start." },
          session_owner_id: { type: "string", nullable: true, description: "Opaque signed-token owner identifier; null on pre-migration rows." },
          candidate_name: { type: "string", nullable: true },
          candidate_linkedin: { type: "string", nullable: true },
          candidate_email: { type: "string", nullable: true, description: "Legacy — sessions captured before the gate switched to LinkedIn." },
          candidate_upwork: { type: "string", nullable: true },
          frames: { type: "integer", description: "Frame files captured on disk." },
          audio: { type: "integer", description: "Voice-over chunks captured on disk." }
        }
      },
      SessionReset: {
        type: "object",
        required: ["requestId", "fromGeneration", "toGeneration", "fromStatus", "archiveId", "resetAt"],
        properties: {
          requestId: { type: "string" },
          fromGeneration: { type: "integer", minimum: 0 },
          toGeneration: { type: "integer", minimum: 1 },
          fromStatus: { $ref: "#/components/schemas/CodeStatus" },
          archiveId: { type: "string", description: "Directory identifier under the code's persistent evidence archive." },
          resetAt: { type: "string", format: "date-time" }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: "Not signed in / bad API key",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      },
      Forbidden: {
        description: "Not an admin, or the code is unknown/voided",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      },
      NotFound: {
        description: "Not found",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      },
      BadRequest: {
        description: "Validation failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
      }
    },
    parameters: {
      CodePath: {
        name: "code",
        in: "path",
        required: true,
        schema: { $ref: "#/components/schemas/Code" },
        description: "Assessment code (case-insensitive; upper-cased server-side)."
      },
      AssessmentIdPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" }
      }
    }
  },
  paths: {
    "/sendasweet": {
      get: {
        tags: ["system"], summary: "Send a Sweet gallery", security: [],
        description: "Public standalone gifting concept. Assets and maker stores are scoped to /sendasweet.",
        responses: { 200: { description: "Gallery HTML", content: { "text/html": { schema: { type: "string" } } } } }
      }
    },
    "/sendasweet/makers/{slug}": {
      get: {
        tags: ["system"], summary: "Send a Sweet maker storefront", security: [],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", enum: ["cocoa-and-crumb", "butter-and-fold", "sunday-sweet"] } }],
        responses: { 200: { description: "Storefront HTML or React navigation payload" }, 404: { description: "Unknown maker" } }
      }
    },
    "/healthz": {
      get: {
        tags: ["system"],
        summary: "Liveness probe",
        description: "Used by the platform health check; never behind auth or the SPA fallback.",
        security: [],
        responses: {
          200: { description: "Alive", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }
        }
      }
    },
    "/api/openapi.json": {
      get: {
        tags: ["system"],
        summary: "This document",
        security: [],
        responses: { 200: { description: "OpenAPI 3 spec", content: { "application/json": { schema: { type: "object" } } } } }
      }
    },

    /* ---------------- auth ---------------- */
    "/api/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Sign in as admin",
        description: "There is no signup — the admin account is seeded from ADMIN_EMAIL / ADMIN_PASSWORD. Sets the `praxis_session` cookie (7 days).",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: { email: { type: "string", format: "email" }, password: { type: "string", format: "password" } }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Signed in; session cookie set",
            content: { "application/json": { schema: { type: "object", properties: { user: { $ref: "#/components/schemas/User" } } } } }
          },
          401: { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/api/auth/logout": {
      post: {
        tags: ["auth"],
        summary: "Clear the session cookie",
        security: [],
        responses: { 200: { description: "Signed out", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } } }
      }
    },
    "/api/auth/me": {
      get: {
        tags: ["auth"],
        summary: "Current user",
        description: "Returns `{ user: null }` rather than 401 when signed out — the client uses it to decide what to render.",
        security: [{ sessionCookie: [] }],
        responses: {
          200: {
            description: "Current user, or null",
            content: { "application/json": { schema: { type: "object", properties: { user: { allOf: [{ $ref: "#/components/schemas/User" }], nullable: true } } } } }
          }
        }
      }
    },

    /* ---------------- candidate flow ---------------- */
    "/api/assessment/session": {
      get: {
        tags: ["assessment"],
        summary: "Issue an owner token or restore its session",
        description:
          "Public code lookup. Every response includes `sessionGeneration` (`null` for an unknown code). Every lookup of an unused code returns a fresh signed token for that generation and assessment metadata without the brief. The first successful start atomically binds one token. For active/submitted codes, send that token in `X-Assessment-Session`: the owner receives the frozen assessment and latest checkpoint; a missing, competing, or pre-reset token receives `owned: false` with no brief, checkpoint, or candidate identity. Legacy active rows without an owner cannot be claimed and include admin recovery guidance. Unknown and malformed codes both return `{ status: \"unknown\" }`.",
        security: [],
        parameters: [
          { name: "case", in: "query", required: true, schema: { $ref: "#/components/schemas/Code" } },
          { name: "X-Assessment-Session", in: "header", required: false, schema: { type: "string" }, description: "Previously issued owner token when restoring an active/submitted session." }
        ],
        responses: {
          200: {
            description: "Code state, server timing, and data appropriate to the caller's ownership.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { oneOf: [{ $ref: "#/components/schemas/CodeStatus" }, { type: "string", enum: ["unknown"] }] },
                    sessionGeneration: { type: "integer", minimum: 0, nullable: true },
                    owned: { type: "boolean", description: "Present for active/submitted states." },
                    sessionToken: { type: "string", description: "Fresh contender token; present only while unused." },
                    startedAt: { type: "integer", format: "int64", nullable: true },
                    endReason: { type: "string", nullable: true },
                    finalRevision: { type: "integer", nullable: true, description: "Highest final/reconciled payload revision for the owner." },
                    candidateName: { type: "string", nullable: true, description: "Owner only." },
                    serverNow: { type: "integer", format: "int64" },
                    checkpointReceivedAt: { type: "integer", format: "int64", nullable: true },
                    pauseDeadlineAt: { type: "integer", format: "int64", nullable: true },
                    checkpoint: { allOf: [{ $ref: "#/components/schemas/AssessmentCheckpoint" }], nullable: true, description: "Owner only." },
                    error: { type: "string", description: "Legacy-session explanation when applicable." },
                    errorCode: { type: "string", enum: ["legacy_owner_unavailable"] },
                    recovery: { type: "string" },
                    assessment: {
                      nullable: true,
                      oneOf: [
                        { $ref: "#/components/schemas/CandidateAssessmentMetadata" },
                        { $ref: "#/components/schemas/CandidateAssessment" }
                      ],
                      description: "Public metadata for unused/non-owner calls; the full frozen assessment for an owner."
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/assessment/start": {
      post: {
        tags: ["assessment"],
        summary: "Unlock a code and bind the candidate's details to it",
        description:
          "Requires the signed contender token from `/session` in the body or `X-Assessment-Session`. The first successful call atomically binds that owner, candidate identity, a server `startedAt`, the immutable assessment, and revision-0 checkpoint. Same-token retries return those exact values; another token gets 409. Tokens from a prior reset generation get `session_generation_mismatch` and must reload the same link. LinkedIn/Upwork accept HTTP(S) URLs on the exact bare or www host, or the same host without a scheme (normalized to HTTPS); authinfo, whitespace, wrong hosts, malformed URLs, and empty paths are rejected. Which fields are required comes from the pre-start `gateFields`; send multipart when a CV or portfolio is required.",
        security: [{ assessmentSession: [] }],
        parameters: [
          { name: "X-Assessment-Session", in: "header", required: false, schema: { type: "string" }, description: "May be supplied here, in sessionToken, or identically in both places." }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["caseId", "name"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  sessionToken: { type: "string" },
                  name: { type: "string", maxLength: 120 },
                  linkedin: { type: "string", description: "Required when gateFields.linkedin is true. Bare linkedin.com/www.linkedin.com profile paths are normalized to HTTPS." },
                  upwork: { type: "string", description: "Required when gateFields.upwork is true. Bare upwork.com/www.upwork.com profile paths are normalized to HTTPS." }
                }
              }
            },
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "name"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  sessionToken: { type: "string" },
                  name: { type: "string", maxLength: 120 },
                  linkedin: { type: "string" },
                  upwork: { type: "string" },
                  cv: { type: "string", format: "binary", description: "Required when the assessment's gateFields.cv is true." },
                  portfolio: {
                    type: "array",
                    items: { type: "string", format: "binary" },
                    description: "1–10 JPG/PNG/WebP images. Required when the assessment's gateFields.portfolio is true."
                  }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Started or idempotently restored",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                status: { type: "string", enum: ["active"] },
                sessionGeneration: { type: "integer", minimum: 0 },
                owned: { type: "boolean", enum: [true] },
                startedAt: { type: "integer", format: "int64" },
                assessment: { $ref: "#/components/schemas/CandidateAssessment" },
                checkpoint: { $ref: "#/components/schemas/AssessmentCheckpoint" },
                serverNow: { type: "integer", format: "int64" },
                checkpointReceivedAt: { type: "integer", format: "int64" },
                pauseDeadlineAt: { type: "integer", format: "int64" }
              }
            } } }
          },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          409: { description: "Another browser owns the code, the row is legacy, or the assessment is already submitted.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/assessment/checkpoint": {
      post: {
        tags: ["assessment"],
        summary: "Persist the latest candidate state",
        description:
          "Owner-only durable checkpoint. Revisions must increase; equal/older deliveries are acknowledged with `accepted: false`, while newer revisions cannot move elapsed, paused, or save timing backward. The server stores its own receipt time, finalizes at the remaining five-minute pause budget even after restart, and finalizes immediately as `expired` when elapsedMs reaches the frozen duration. A submitting checkpoint does not itself complete a manual submission.",
        security: [{ assessmentSession: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AssessmentCheckpoint" } } } },
        responses: {
          200: {
            description: "Checkpoint accepted/ignored, or deadline finalization completed",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                status: { $ref: "#/components/schemas/CodeStatus" },
                sessionGeneration: { type: "integer", minimum: 0 },
                accepted: { type: "boolean" },
                revision: { type: "integer", nullable: true },
                startedAt: { type: "integer", format: "int64" },
                endReason: { type: "string", nullable: true },
                serverNow: { type: "integer", format: "int64" },
                checkpointReceivedAt: { type: "integer", format: "int64", nullable: true },
                pauseDeadlineAt: { type: "integer", format: "int64", nullable: true }
              }
            } } }
          },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          409: { description: "Not started, wrong owner, or legacy owner unavailable.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/assessment/transcribe-token": {
      post: {
        tags: ["assessment"],
        summary: "Mint a short-lived AssemblyAI streaming token",
        description: "Requires a valid contender token while unused (for microphone preflight) and the bound owner token once active. Returns 404 when AssemblyAI is not configured.",
        security: [{ assessmentSession: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["caseId"],
            properties: { caseId: { $ref: "#/components/schemas/Code" }, sessionToken: { type: "string" } }
          } } }
        },
        responses: {
          200: { description: "Streaming token", content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          409: { description: "A different browser owns the active code, or legacy ownership is unavailable.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          404: { description: "Transcription service is not configured", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          502: { description: "Transcription provider unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/assessment": {
      post: {
        tags: ["assessment"],
        summary: "Submit the final payload",
        description:
          "Requires an active bound owner; unused codes are rejected. Candidate identity and startedAt come from the server. A same-owner retry after a normal submission is acknowledged without rewriting payload.json. If the server already finalized a deadline from a checkpoint, a higher-revision final may add evidence marked late while the server cutoff/endReason remains authoritative; equal/older evidence returns 409 unless it is an idempotent retry of an already reconciled revision.",
        security: [{ assessmentSession: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AssessmentCheckpoint" }
            }
          }
        },
        responses: {
          200: { description: "Durably stored, reconciled, or idempotently acknowledged", content: { "application/json": { schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              acknowledged: { type: "boolean" },
              duplicate: { type: "boolean" },
              reconciled: { type: "boolean" },
              status: { type: "string", enum: ["submitted"] },
              endReason: { type: "string" },
              revision: { type: "integer" },
              lateEvidenceEvents: { type: "integer" }
            }
          } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          409: {
            description: "Not started, wrong/legacy owner, or non-newer evidence after server deadline finalization",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
          }
        }
      }
    },
    "/api/assessment/frames": {
      post: {
        tags: ["assessment"],
        summary: "Upload a batch of 1fps screen frames",
        description: "Owner-only for active and submitted sessions, so an acknowledged submission may still drain queued recordings. Max 120 files per request, 4 MB each. Filenames must match `[A-Za-z0-9._-]{1,64}.(jpg|jpeg|png)`; anything else is skipped, so check `saved`.",
        security: [{ assessmentSession: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "frames"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  sessionToken: { type: "string" },
                  frames: { type: "array", items: { type: "string", format: "binary" } }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Accepted",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, saved: { type: "integer" }, status: { type: "string", enum: ["active", "submitted"] } } } } }
          },
          403: { $ref: "#/components/responses/Forbidden" },
          409: { description: "A different browser owns the session, or legacy ownership is unavailable.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/assessment/audio": {
      post: {
        tags: ["assessment"],
        summary: "Upload voice-over chunks",
        description: "Owner-only for active and submitted sessions. Max 8 files per request, 16 MB each. Filenames must match `[A-Za-z0-9._-]{1,80}.(webm|ogg|m4a|mp4|mp3)`.",
        security: [{ assessmentSession: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "audio"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  sessionToken: { type: "string" },
                  audio: { type: "array", items: { type: "string", format: "binary" } }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Accepted",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, saved: { type: "integer" }, status: { type: "string", enum: ["active", "submitted"] } } } } }
          },
          403: { $ref: "#/components/responses/Forbidden" },
          409: { description: "A different browser owns the session, or legacy ownership is unavailable.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },

    /* ---------------- admin ---------------- */
    "/api/admin/assessments": {
      get: {
        tags: ["admin"],
        summary: "List assessments",
        responses: {
          200: {
            description: "Newest-updated first, each with its issued-code count",
            content: { "application/json": { schema: { type: "object", properties: { assessments: { type: "array", items: { $ref: "#/components/schemas/Assessment" } } } } } }
          },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      },
      post: {
        tags: ["admin"],
        summary: "Create an assessment",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AssessmentInput" } } } },
        responses: {
          200: { description: "Created", content: { "application/json": { schema: { type: "object", properties: { assessment: { $ref: "#/components/schemas/Assessment" } } } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      }
    },
    "/api/admin/assessments/{id}": {
      parameters: [{ $ref: "#/components/parameters/AssessmentIdPath" }],
      get: {
        tags: ["admin"],
        summary: "Get one assessment",
        responses: {
          200: { description: "Found", content: { "application/json": { schema: { type: "object", properties: { assessment: { $ref: "#/components/schemas/Assessment" } } } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      },
      put: {
        tags: ["admin"],
        summary: "Replace an assessment",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/AssessmentInput" } } } },
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: { type: "object", properties: { assessment: { $ref: "#/components/schemas/Assessment" } } } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      },
      delete: {
        tags: ["admin"],
        summary: "Delete an assessment",
        description: "Refused with 409 once codes have been issued under it — void those first.",
        responses: {
          200: { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" },
          409: { description: "Codes already issued", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/admin/codes": {
      get: {
        tags: ["admin"],
        summary: "List every code with capture counts",
        responses: {
          200: { description: "Newest first", content: { "application/json": { schema: { type: "object", properties: { codes: { type: "array", items: { $ref: "#/components/schemas/CodeRecord" } } } } } } },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      },
      post: {
        tags: ["admin"],
        summary: "Issue codes in bulk",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  count: { type: "integer", minimum: 1, maximum: 200, default: 1 },
                  assessmentId: { type: "integer", nullable: true, description: "Omit for a code with no brief attached." }
                }
              }
            }
          }
        },
        responses: {
          200: { description: "Issued", content: { "application/json": { schema: { type: "object", properties: { codes: { type: "array", items: { $ref: "#/components/schemas/Code" } } } } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      }
    },
    "/api/admin/codes/{code}/void": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      post: {
        tags: ["admin"],
        summary: "Void a code",
        description: "Irreversible. A voided code is refused at the gate and for all uploads.",
        responses: {
          200: { description: "Voided", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/api/admin/codes/{code}/reset": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      post: {
        tags: ["admin"],
        summary: "Archive a session and reuse its code",
        description:
          "Moves all current files into a persistent, generation-stamped archive and stores the prior code/checkpoint metadata there before clearing candidate, timing, ownership, snapshot, final-revision, and checkpoint state. The code and assessment_id are preserved and status becomes unused. `expectedGeneration` is required and `expectedStatus` can guard the reviewed status. A globally unique `requestId` makes a lost-response retry idempotent; a reused ID for another code, stale generation, or changed status returns 409 without changing evidence.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            required: ["requestId", "expectedGeneration"],
            properties: {
              requestId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
              expectedGeneration: { type: "integer", minimum: 0 },
              expectedStatus: { $ref: "#/components/schemas/CodeStatus" }
            }
          } } }
        },
        responses: {
          200: { description: "Reset applied or idempotently replayed", content: { "application/json": { schema: {
            type: "object",
            required: ["ok", "idempotent", "code", "reset"],
            properties: {
              ok: { type: "boolean", enum: [true] },
              idempotent: { type: "boolean" },
              code: { $ref: "#/components/schemas/CodeRecord" },
              reset: { $ref: "#/components/schemas/SessionReset" }
            }
          } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" },
          409: { description: "Generation/status changed, archive path exists, or requestId belongs to another code.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          500: { description: "Reset/archive failed and prior state was retained.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }
        }
      }
    },
    "/api/admin/sessions/{code}": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      get: {
        tags: ["admin"],
        summary: "Full captured session",
        description: "Code record, candidate details, latest redacted checkpoint (including the in-progress transcript), submitted/server-finalized payload when present, capture filenames, and reset history. The checkpoint never includes its bearer sessionToken.",
        responses: {
          200: {
            description: "Session",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    code: { $ref: "#/components/schemas/CodeRecord" },
                    candidate: {
                      type: "object",
                      nullable: true,
                      properties: { name: { type: "string" }, linkedin: { type: "string" }, email: { type: "string", description: "Legacy sessions only." }, upwork: { type: "string" } }
                    },
                    payload: { type: "object", nullable: true, additionalProperties: true },
                    checkpoint: {
                      type: "object",
                      nullable: true,
                      description: "Latest AssessmentCheckpoint with sessionToken removed.",
                      additionalProperties: true
                    },
                    frames: { type: "array", items: { type: "string" } },
                    audio: { type: "array", items: { type: "string" } },
                    resets: { type: "array", items: { $ref: "#/components/schemas/SessionReset" } }
                  }
                }
              }
            }
          },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/api/admin/sessions/{code}/frames/{name}": {
      parameters: [
        { $ref: "#/components/parameters/CodePath" },
        { name: "name", in: "path", required: true, schema: { type: "string" }, description: "Filename from the session's `frames` array." }
      ],
      get: {
        tags: ["admin"],
        summary: "Fetch one frame image",
        responses: {
          200: { description: "Image", content: { "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/png": { schema: { type: "string", format: "binary" } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { description: "Unknown code or filename (empty body)" }
        }
      }
    },
    "/api/admin/sessions/{code}/audio/{name}": {
      parameters: [
        { $ref: "#/components/parameters/CodePath" },
        { name: "name", in: "path", required: true, schema: { type: "string" }, description: "Filename from the session's `audio` array." }
      ],
      get: {
        tags: ["admin"],
        summary: "Fetch one voice-over chunk",
        responses: {
          200: { description: "Audio", content: { "audio/webm": { schema: { type: "string", format: "binary" } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { description: "Unknown code or filename (empty body)" }
        }
      }
    },
    "/api/admin/sessions/{code}/zip": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      get: {
        tags: ["admin"],
        summary: "Download the whole session as a zip",
        description: "The current files and metadata plus every retained reset archive for this code.",
        responses: {
          200: { description: "Zip archive", content: { "application/zip": { schema: { type: "string", format: "binary" } } } },
          403: { $ref: "#/components/responses/Forbidden" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      }
    },

    /* ---------------- integrations ---------------- */
    "/api/integrations/ping": {
      get: {
        tags: ["integrations"],
        summary: "Verify the API key",
        description: "Used by the extension's Options page to confirm the key and host are right.",
        security: [{ apiKey: [] }],
        responses: {
          200: { description: "Key accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          401: { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/api/integrations/codes": {
      post: {
        tags: ["integrations"],
        summary: "Issue a single code and its candidate link",
        description:
          "Candidate name/LinkedIn are NOT accepted here — the platform captures them itself when the candidate opens the link (see `/api/assessment/start`).",
        security: [{ apiKey: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { assessmentId: { type: "integer", nullable: true } } }
            }
          }
        },
        responses: {
          200: {
            description: "Issued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    code: { $ref: "#/components/schemas/Code" },
                    url: { type: "string", format: "uri", example: "https://assess.example.com/assess?case=K7QM4X" }
                  }
                }
              }
            }
          },
          400: { $ref: "#/components/responses/BadRequest" },
          401: { $ref: "#/components/responses/Unauthorized" }
        }
      }
    },
    "/api/integrations/codes/{code}": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      get: {
        tags: ["integrations"],
        summary: "Funnel status for a code",
        description: "Narrower than the admin view on purpose: no internal IDs, no end_reason.",
        security: [{ apiKey: [] }],
        responses: {
          200: {
            description: "Status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    code: { $ref: "#/components/schemas/Code" },
                    status: { $ref: "#/components/schemas/CodeStatus" },
                    candidateName: { type: "string", nullable: true },
                    startedAt: { type: "string", nullable: true },
                    submittedAt: { type: "string", nullable: true }
                  }
                }
              }
            }
          },
          401: { $ref: "#/components/responses/Unauthorized" },
          404: { $ref: "#/components/responses/NotFound" }
        }
      }
    }
  }
};

/* Admin routes are the common case, so make the cookie the default scheme;
   public and API-key routes override it with their own `security`. */
openapiSpec.security = [{ sessionCookie: [] }];

export const docsRouter = Router();

docsRouter.get("/openapi.json", (req, res) => res.json(openapiSpec));
docsRouter.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    customSiteTitle: "Praxis Assessment API",
    swaggerOptions: { persistAuthorization: true, docExpansion: "list" }
  })
);
