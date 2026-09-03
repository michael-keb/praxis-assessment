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
      "- **`/api/assessment/*`** — public. The candidate holds a single-use code; there are no candidate accounts.\n" +
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
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "Shared secret from the EXTENSION_API_KEY environment variable."
      }
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
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
      Assessment: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          brief: { type: "string", description: "Markdown-ish brief shown to the candidate." },
          duration_minutes: { type: "integer", minimum: 1 },
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
          brief: { type: "string" },
          durationMinutes: { type: "integer", minimum: 1 }
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
          candidate_name: { type: "string", nullable: true },
          candidate_linkedin: { type: "string", nullable: true },
          candidate_email: { type: "string", nullable: true, description: "Legacy — sessions captured before the gate switched to LinkedIn." },
          candidate_upwork: { type: "string", nullable: true },
          frames: { type: "integer", description: "Frame files captured on disk." },
          audio: { type: "integer", description: "Voice-over chunks captured on disk." }
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
        summary: "Check a code before anything starts",
        description: "Public. Returns `{ status: \"unknown\" }` for codes that do not exist — deliberately indistinguishable from a malformed code.",
        security: [],
        parameters: [
          { name: "case", in: "query", required: true, schema: { $ref: "#/components/schemas/Code" } }
        ],
        responses: {
          200: {
            description: "Code state and assessment title/duration. The brief itself is only included once the code is `active` — an unused code never leaks the task.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { oneOf: [{ $ref: "#/components/schemas/CodeStatus" }, { type: "string", enum: ["unknown"] }] },
                    startedAt: { type: "string", nullable: true },
                    endReason: { type: "string", nullable: true },
                    candidateName: { type: "string", nullable: true },
                    assessment: {
                      type: "object",
                      nullable: true,
                      properties: {
                        title: { type: "string" },
                        brief: { type: "string", description: "Only present while the code is active." },
                        durationSeconds: { type: "integer" }
                      }
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
          "First call flips the code to `active` and stores the identity. Calling again while active is a no-op resume — the stored details are never overwritten. The response carries the full assessment (including the brief) — this is where the brief is first released to the candidate. Multipart: the candidate's CV is uploaded here, at the gate — the one surface where candidates will hand over a document.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "name", "upwork", "cv"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  name: { type: "string", maxLength: 120 },
                  upwork: { type: "string", description: "Must be a URL on upwork.com.", example: "https://www.upwork.com/freelancers/~01abc" },
                  cv: { type: "string", format: "binary", description: "PDF or Word (.pdf/.doc/.docx), max 8 MB. Stored as cv.<ext> in the case directory." }
                }
              }
            }
          }
        },
        responses: {
          200: { description: "Started (or resumed)", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      }
    },
    "/api/assessment/": {
      post: {
        tags: ["assessment"],
        summary: "Submit the final payload",
        description:
          "First submission wins; a second returns 409. Candidate identity is taken from what the server stored at `/start` — anything in the body claiming otherwise is ignored. Stored as `payload.json` under the code's directory.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["caseId"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  log: {
                    type: "array",
                    description: "Event log. The last `end` event supplies the code's end_reason.",
                    items: { type: "object", properties: { type: { type: "string" }, reason: { type: "string" } } }
                  }
                },
                additionalProperties: true
              }
            }
          }
        },
        responses: {
          200: { description: "Stored", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          400: { $ref: "#/components/responses/BadRequest" },
          403: { $ref: "#/components/responses/Forbidden" },
          409: {
            description: "Already submitted",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
          }
        }
      }
    },
    "/api/assessment/frames": {
      post: {
        tags: ["assessment"],
        summary: "Upload a batch of 1fps screen frames",
        description: "Max 120 files per request, 4 MB each. Filenames must match `[A-Za-z0-9._-]{1,64}.(jpg|jpeg|png)`; anything else is silently skipped, so check `saved`.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "frames"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  frames: { type: "array", items: { type: "string", format: "binary" } }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Accepted",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, saved: { type: "integer" } } } } }
          },
          403: { $ref: "#/components/responses/Forbidden" }
        }
      }
    },
    "/api/assessment/audio": {
      post: {
        tags: ["assessment"],
        summary: "Upload voice-over chunks",
        description: "Max 8 files per request, 16 MB each. Filenames must match `[A-Za-z0-9._-]{1,80}.(webm|ogg|m4a|mp4|mp3)`.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["caseId", "audio"],
                properties: {
                  caseId: { $ref: "#/components/schemas/Code" },
                  audio: { type: "array", items: { type: "string", format: "binary" } }
                }
              }
            }
          }
        },
        responses: {
          200: {
            description: "Accepted",
            content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, saved: { type: "integer" } } } } }
          },
          403: { $ref: "#/components/responses/Forbidden" }
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
    "/api/admin/sessions/{code}": {
      parameters: [{ $ref: "#/components/parameters/CodePath" }],
      get: {
        tags: ["admin"],
        summary: "Full captured session",
        description: "Code record, candidate details, submitted payload, and the frame/audio filenames (frames sorted by their `f_<n>` index).",
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
                    frames: { type: "array", items: { type: "string" } },
                    audio: { type: "array", items: { type: "string" } }
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
        description: "Everything on disk for the code, plus `code-record.json`.",
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
          "Candidate name/LinkedIn/Upwork URL are NOT accepted here — the platform captures them itself when the candidate opens the link (see `/api/assessment/start`).",
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
