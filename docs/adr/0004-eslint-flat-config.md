# Real-Time Collaborative Code Editor — System Architecture (FINAL)

**Status:** FINAL — approved for implementation. Any structural change from this point requires a new ADR in `docs/adr/` explaining the reason.
**Audience:** Senior/Staff engineering portfolio review.
**Scope:** Architecture only. No code in this document.
**Revision:** v2 — incorporates three approved refinements over v1: (1) added `packages/shared-contracts`, (2) restructured `apps/api` module internals for explicit Clean Architecture layering, (3) reserved `apps/api/src/observability/`. All other v1 decisions are unchanged.

---

## 1. High-Level System Architecture

The system is built as a **modular monolith with two intentionally separated deployables**, not a full microservices mesh. This is a deliberate trade-off, explained in Section 11 — premature microservices add operational cost without demonstrating extra engineering skill, but the one boundary that *must* be separate (untrusted code execution) is separated for security reasons.

```
                                   ┌────────────────────┐
                                   │      Browser        │
                                   │  React + TS Client  │
                                   │  (Yjs doc + Monaco)  │
                                   └──────────┬──────────┘
                                              │ HTTPS (REST)  +  WSS (collab)
                                              ▼
                                   ┌────────────────────┐
                                   │   Load Balancer /    │
                                   │   Reverse Proxy      │
                                   └──────────┬──────────┘
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                 ┌───────────────┐   ┌───────────────┐    ┌───────────────┐
                 │  API Instance  │   │  API Instance  │    │  API Instance  │
                 │  (Fastify +    │   │  (Fastify +    │    │  (Fastify +    │
                 │   WS Gateway)  │   │   WS Gateway)  │    │   WS Gateway)  │
                 └───────┬────────┘   └───────┬────────┘    └───────┬────────┘
                         │                    │                    │
              ┌──────────┴─────────┬──────────┴─────────┬──────────┘
              ▼                    ▼                     ▼
     ┌─────────────────┐  ┌────────────────┐   ┌────────────────────┐
     │   PostgreSQL      │  │     Redis       │   │  BullMQ Queue        │
     │  (source of truth)│  │ (pub/sub, cache,│   │  (backed by Redis)   │
     │                    │  │  rate limiting) │   │                      │
     └─────────────────┘  └────────────────┘   └──────────┬──────────┘
                                                             ▼
                                                  ┌────────────────────┐
                                                  │  Execution Worker    │
                                                  │  Service (isolated)  │
                                                  │  spawns ephemeral    │
                                                  │  Docker containers   │
                                                  └────────────────────┘
```

**Key architectural properties:**
- Any API instance can serve any client — no sticky sessions required. Cross-instance real-time fan-out is handled via **Redis pub/sub**, not in-memory state.
- The **execution worker** is a separate deployable with a separate trust boundary. It never shares a process, container, or host filesystem with the API layer.
- PostgreSQL is the single source of truth for durable state (users, rooms, CRDT snapshots, execution history). Redis holds only ephemeral/derived state — losing Redis should degrade the system, not corrupt it.

---

## 2. Technology Choices & Justification

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | End-to-end type safety, shared DTOs between FE/BE via a shared package. |
| Frontend framework | React + Vite | Fast dev loop, huge ecosystem, standard expectation at target companies. |
| Editor component | Monaco Editor (`y-monaco` binding) | Same engine as VS Code — instantly recognizable to interviewers; mature Yjs binding exists. CodeMirror 6 is lighter and has a more native Yjs binding (`y-codemirror.next`) and is noted as a valid alternative if bundle size becomes a concern. |
| Client state | Zustand | Minimal boilerplate vs Redux; Yjs itself is the source of truth for document state, Zustand only holds UI/session state — avoids duplicating state ownership. |
| CRDT engine | **Yjs** | See ADR-0002 in Section 11. Decentralized sync, no central transform server, mature ecosystem (`y-websocket`, `y-indexeddb`, `y-monaco`, awareness protocol for presence). |
| Backend framework | Fastify | Lower overhead than Express, built-in JSON schema validation, plugin/encapsulation model that naturally supports clean architecture and DI. |
| WS transport | Raw `ws` + Yjs sync/awareness protocols, custom multiplexed envelope | Full control over the wire protocol; a stronger engineering story than wrapping Socket.IO. Socket.IO noted as a simpler fallback trade-off. |
| DI container | Awilix | Lightweight, explicit registration, no decorators/reflection metadata required (unlike tsyringe/InversifyJS) — keeps the codebase readable. |
| ORM | Prisma | Type-safe queries, migrations, strong DX. Raw SQL via `$queryRaw` reserved for hot paths if profiling demands it. |
| Validation | Zod | Shared schemas between frontend and backend (`packages/shared-schemas`), single source of truth for input shape. |
| Database | PostgreSQL | Relational integrity for users/rooms/membership; `bytea` columns for Yjs binary snapshots; strong tooling. |
| Cache/pub-sub/queue backend | Redis | One infrastructure primitive serving four distinct roles (Section 9) — deliberate reuse, not four separate systems. |
| Job queue | BullMQ | Redis-backed, supports retries, concurrency control, delayed jobs, and dashboards — needed for execution job backpressure. |
| Code execution sandbox | Docker (ephemeral containers, cgroup + seccomp + no-network) | Reasonable isolation bar for v1; documented upgrade path to gVisor/Firecracker (Section 11). |
| Auth | JWT (access + rotating refresh tokens) + optional OAuth (GitHub/Google) | Stateless access tokens for scale; rotation + reuse detection for refresh tokens gives revocation without full session-store lookups on every request. |
| Monorepo tooling | pnpm workspaces + Turborepo | Shared packages, incremental/cached builds across `apps/*`. |
| Testing | Vitest/Jest, Supertest, Playwright, custom CRDT convergence tests | Layered pyramid; convergence tests are a differentiator most portfolio projects skip. |
| Logging | Pino | Structured JSON logs, low overhead, production-standard. |
| Local infra | Docker Compose | Full stack (`postgres`, `redis`, `api`, `execution-worker`, `web`) runnable with one command on Windows/VS Code. |

---

## 3. Complete Folder Structure (FINAL)

```
collab-code-editor/
├── apps/
│   ├── web/                              # React + TypeScript frontend
│   │   ├── src/
│   │   │   ├── app/                      # App shell, routing, providers, layout
│   │   │   ├── features/
│   │   │   │   ├── auth/                 # Login/register/OAuth UI + hooks
│   │   │   │   ├── rooms/                # Room list, create/join, settings
│   │   │   │   ├── editor/               # Monaco + Yjs binding, editor panel
│   │   │   │   ├── presence/             # Cursors, avatars, selection UI
│   │   │   │   └── execution/            # Run panel, output console
│   │   │   ├── components/               # Shared/dumb, reusable UI components
│   │   │   ├── hooks/                    # Cross-feature reusable hooks
│   │   │   ├── lib/                      # api client, ws client, yjs provider setup
│   │   │   ├── store/                    # Zustand stores
│   │   │   ├── types/                    # FE-only types (re-exports shared-types)
│   │   │   ├── styles/
│   │   │   ├── main.tsx
│   │   │   └── App.tsx
│   │   ├── public/
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   ├── api/                              # Node.js REST + WebSocket backend
│   │   ├── src/
│   │   │   ├── modules/                  # One folder per bounded context; every module follows the same internal Clean Architecture layout
│   │   │   │   ├── auth/
│   │   │   │   │   ├── controllers/
│   │   │   │   │   │   └── auth.controller.ts              # HTTP request/response shaping only
│   │   │   │   │   ├── services/
│   │   │   │   │   │   └── auth.service.ts                 # Business logic; depends on interfaces, not concrete repos
│   │   │   │   │   ├── repositories/
│   │   │   │   │   │   └── auth.repository.ts               # Concrete data access (implements an interface below)
│   │   │   │   │   ├── interfaces/
│   │   │   │   │   │   └── auth-repository.interface.ts     # Port the service depends on (Dependency Inversion)
│   │   │   │   │   ├── dto/
│   │   │   │   │   │   └── auth.dto.ts                      # Module-internal request/response DTOs
│   │   │   │   │   ├── schemas/
│   │   │   │   │   │   └── auth.schema.ts                   # Zod validation for this module's routes
│   │   │   │   │   ├── types/
│   │   │   │   │   │   └── auth.types.ts                    # Module-internal types not shared elsewhere
│   │   │   │   │   ├── tests/
│   │   │   │   │   │   └── auth.service.test.ts
│   │   │   │   │   └── auth.routes.ts                       # Maps HTTP paths → controller (module entrypoint)
│   │   │   │   ├── users/                # same internal layout as auth/
│   │   │   │   ├── rooms/                # same internal layout as auth/
│   │   │   │   ├── documents/            # same internal layout as auth/
│   │   │   │   ├── execution/            # same internal layout as auth/ — job creation, status endpoints
│   │   │   │   └── collaboration/        # same internal layout as auth/ — WS gateway module glue
│   │   │   ├── websocket/
│   │   │   │   ├── ws-server.ts
│   │   │   │   ├── ws-auth.middleware.ts
│   │   │   │   ├── yjs-connection.handler.ts
│   │   │   │   ├── presence.handler.ts
│   │   │   │   └── redis-adapter.ts      # cross-instance fan-out
│   │   │   ├── observability/            # Reserved for Phase 8 — architectural placeholder only, not implemented yet
│   │   │   │   ├── metrics/
│   │   │   │   ├── tracing/
│   │   │   │   └── health/
│   │   │   ├── core/                     # Cross-cutting concerns
│   │   │   │   ├── container.ts          # Awilix DI container
│   │   │   │   ├── config.ts             # env parsing/validation
│   │   │   │   ├── logger.ts
│   │   │   │   ├── errors/               # error taxonomy + base classes
│   │   │   │   └── constants.ts
│   │   │   ├── infrastructure/
│   │   │   │   ├── database/
│   │   │   │   │   └── prisma.client.ts
│   │   │   │   ├── redis/
│   │   │   │   │   └── redis.client.ts
│   │   │   │   └── queue/
│   │   │   │       └── bullmq.client.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.middleware.ts
│   │   │   │   ├── error-handler.middleware.ts
│   │   │   │   ├── rate-limit.middleware.ts
│   │   │   │   └── validate.middleware.ts
│   │   │   ├── routes/
│   │   │   │   └── index.ts              # route aggregation
│   │   │   ├── app.ts                    # Fastify app assembly (no listen)
│   │   │   └── server.ts                 # entrypoint (listen + graceful shutdown)
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── e2e/
│   │   ├── Dockerfile
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── execution-worker/                 # Isolated code execution service
│       ├── src/
│       │   ├── queue/
│       │   │   └── execution.consumer.ts
│       │   ├── docker/
│       │   │   ├── container-runner.ts
│       │   │   ├── resource-limits.ts
│       │   │   └── image-registry.ts
│       │   ├── runtimes/
│       │   │   ├── runtime.interface.ts
│       │   │   ├── node.runtime.ts
│       │   │   └── python.runtime.ts
│       │   ├── core/                     # config, logger (mirrors api/core)
│       │   └── server.ts                 # health/readiness endpoint only
│       ├── docker-images/
│       │   ├── base/Dockerfile
│       │   ├── node/Dockerfile
│       │   └── python/Dockerfile
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── shared-contracts/                 # Cross-app communication contracts: API request/response DTOs, WS event contracts, shared enums, command/event payloads
│   ├── shared-types/                     # Generic, communication-agnostic TS utility types (Result<T>, Paginated<T>, branded IDs, etc.)
│   ├── shared-schemas/                   # Zod runtime validation schemas (FE forms + BE request validation), aligned with shared-contracts
│   ├── config/                           # shared eslint/tsconfig/prettier base
│   └── logger/                           # shared logging utility (optional)
│
├── infrastructure/
│   ├── docker/
│   │   ├── docker-compose.yml            # base services (postgres, redis)
│   │   ├── docker-compose.dev.yml        # dev overrides (all apps, hot reload)
│   │   └── docker-compose.prod.yml       # production composition
│   ├── k8s/                              # later-phase, optional
│   └── scripts/
│       ├── setup.sh
│       └── seed-db.ts
│
├── docs/
│   ├── architecture.md                   # this document
│   ├── adr/                              # Architectural Decision Records
│   │   ├── 0001-modular-monolith-vs-microservices.md
│   │   ├── 0002-yjs-vs-ot.md
│   │   ├── 0003-docker-execution-isolation.md
│   │   └── ...
│   ├── api-spec/                         # OpenAPI spec
│   └── diagrams/
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
├── .env.example
├── pnpm-workspace.yaml
├── turbo.json
├── package.json
├── tsconfig.base.json
├── eslint.config.mjs
├── .prettierrc
├── .gitignore
└── README.md
```

---

## 4. Folder Responsibilities

| Path | Responsibility |
|---|---|
| `apps/web` | All UI. No business logic beyond presentation/orchestration — auth rules, RBAC checks, and execution constraints are enforced server-side and only mirrored client-side for UX. |
| `apps/api` | REST + WebSocket gateway. Owns auth, room/document CRUD, RBAC enforcement, CRDT persistence, job submission. Structured as **controller → service → repository** per module (Separation of Concerns). |
| `apps/api/src/modules/*` | Each module is a bounded context, internally structured for Clean Architecture: `controllers/` (request/response shaping) → `services/` (business logic) → `repositories/` (data access) → `interfaces/` (ports the services depend on, enabling Dependency Inversion) → `dto/`, `schemas/`, `types/` (module-local contracts and validation) → `tests/`. `*.routes.ts` stays at the module root as the single entrypoint. Wiring between a service and its concrete repository happens via `core/container.ts`. |
| `apps/api/src/websocket` | Everything related to the real-time transport: connection auth, Yjs sync/awareness handling, and the Redis-based fan-out adapter that lets any instance broadcast to any client. |
| `apps/api/src/observability` | Reserved placeholder for metrics, tracing, and health/readiness checks (Phase 8). Present in the structure now so modules can later depend on its interfaces without a restructure; deliberately unimplemented until Phase 8. |
| `apps/api/src/core` | Cross-cutting infrastructure-agnostic concerns: config loading/validation, logging, DI container, error hierarchy. |
| `apps/api/src/infrastructure` | Concrete adapters to external systems (Postgres via Prisma, Redis, BullMQ). Swappable behind interfaces — this is where SOLID's Dependency Inversion Principle is enforced in practice. |
| `apps/execution-worker` | Consumes execution jobs from the queue and runs them inside locked-down, ephemeral Docker containers. Deliberately has **no** access to the primary database beyond writing job results, and no access to user session/auth internals. |
| `packages/shared-contracts` | Single source of truth for cross-app **communication contracts**: REST request/response DTOs, WebSocket event payload shapes (the type-`2` JSON events from Section 6), shared enums (roles, job statuses), and command/event payloads. Both `apps/api` and `apps/web` import from here — this is what prevents FE/BE drift. |
| `packages/shared-types` | Generic, communication-agnostic TypeScript utility types used across apps (e.g. `Result<T, E>`, `Paginated<T>`, branded ID types) — not tied to any specific API/WS contract. |
| `packages/shared-schemas` | Zod runtime-validation schemas imported by both API (server-side validation) and web (form validation), kept aligned with the shapes defined in `shared-contracts` — DRY validation logic. |
| `infrastructure/docker` | All environment compositions. Dev, and prod differ only in build target and env injection, not in service topology. |
| `docs/adr` | Every non-trivial decision gets a short ADR: context, decision, consequences. This is what "frozen unless justified" means in practice. |

---

## 5. Database Schema Overview (PostgreSQL)

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Account records | `id`, `email` (unique), `password_hash` (nullable if OAuth-only), `name`, `avatar_url`, `oauth_provider`, `oauth_id`, `created_at`, `updated_at` |
| `refresh_tokens` | Rotating refresh tokens for revocation/reuse-detection | `id`, `user_id` (FK), `token_hash`, `expires_at`, `revoked_at`, `created_at` |
| `rooms` | A collaborative session container | `id`, `name`, `slug` (unique), `owner_id` (FK → users), `default_language`, `is_public`, `created_at`, `updated_at`, `archived_at` |
| `room_members` | Membership + RBAC role | `id`, `room_id` (FK), `user_id` (FK), `role` (`owner` \| `editor` \| `viewer`), `joined_at`. Unique constraint on `(room_id, user_id)`. |
| `documents` | A file within a room (rooms can hold multiple files) | `id`, `room_id` (FK), `title`, `path`, `created_at`, `updated_at` |
| `document_snapshots` | Periodic compacted Yjs state | `id`, `document_id` (FK), `state_vector` (`bytea`), `snapshot` (`bytea`), `version`, `created_at` |
| `document_updates` | Append-only Yjs update log since the last snapshot | `id`, `document_id` (FK), `update` (`bytea`), `client_id`, `created_at` |
| `execution_jobs` | Code execution history | `id`, `room_id` (FK), `user_id` (FK), `document_id` (FK), `language`, `status` (`queued`\|`running`\|`completed`\|`failed`\|`timeout`), `stdin`, `stdout`, `stderr`, `exit_code`, `started_at`, `completed_at`, `duration_ms` |
| `audit_logs` | Security/ops trail | `id`, `actor_id` (FK), `action`, `resource_type`, `resource_id`, `metadata` (`jsonb`), `created_at` |

**Relationships:** `users` 1—N `rooms` (owner); `rooms` N—N `users` via `room_members`; `rooms` 1—N `documents`; `documents` 1—N `document_snapshots` / `document_updates`; `rooms` 1—N `execution_jobs`.

**Indexing strategy:** unique `(room_id, user_id)` on `room_members`; index on `documents(room_id)`; composite index `(document_id, created_at)` on `document_updates` for efficient replay-since-snapshot; index `(room_id, created_at)` on `execution_jobs` for history views; index `user_id` on `refresh_tokens`.

**CRDT persistence pattern:** rather than storing one giant ever-growing Yjs document, updates are appended to `document_updates` in real time (cheap writes) and periodically compacted into a new row in `document_snapshots` (background job), after which older `document_updates` rows are pruned. On reconnect, a client is caught up by loading the latest snapshot plus any updates after it.

---

## 6. WebSocket Event Architecture

**Transport:** one WebSocket connection per client per room (`/ws/rooms/:roomId`), authenticated at handshake time. A single connection carries three kinds of messages, distinguished by a leading type byte in the frame (mirroring the pattern used by `y-websocket`, extended with a third type):

| Type tag | Payload | Purpose |
|---|---|---|
| `0` | Binary — Yjs sync protocol (`sync-step-1`, `sync-step-2`, `update`) | Document content synchronization |
| `1` | Binary — Yjs awareness protocol | Live cursors, selections, user color/name (ephemeral, never persisted) |
| `2` | JSON — application events | Room lifecycle, execution status, notifications |

**Application-level event taxonomy (type `2`):**

| Event | Direction | Purpose |
|---|---|---|
| `room:join` / `room:leave` | client → server | Explicit membership signaling on top of the raw connection |
| `room:user-joined` / `room:user-left` | server → clients | Broadcast membership changes |
| `room:members-update` | server → clients | Full member list refresh (roles, online status) |
| `execution:submit` | client → server | Request a code run (also available as REST `POST /rooms/:id/execute`) |
| `execution:queued` / `execution:started` | server → clients | Job lifecycle status |
| `execution:output` | server → clients | Streamed stdout/stderr chunks |
| `execution:completed` / `execution:failed` | server → clients | Final result |
| `error` | server → client | Structured error envelope (code, message) |

**Contract ownership:** the concrete TypeScript payload shapes for every type-`2` application event (and the Yjs-adjacent envelope typing) are defined once in `packages/shared-contracts` and imported by both `apps/api` and `apps/web` — the server and client can never silently drift on what an event looks like.

**Horizontal scaling (multi-instance fan-out):** each API instance holds only the WS connections physically attached to it. When an instance receives a Yjs update or an application event for room `R`, it (a) applies it locally, (b) persists asynchronously, and (c) publishes it to a Redis pub/sub channel `room:{R}:events`. Every instance subscribes to channels for rooms it currently has local connections for, and re-emits incoming messages to its local sockets. This makes the WS layer stateless from the load balancer's perspective — no sticky sessions required.

---

## 7. Docker Execution Architecture

**Flow:**
1. Client sends `execution:submit` (or REST) with `language`, `code`, `stdin`.
2. API validates: language allow-list, code size cap, per-user/per-room rate limit (Redis-backed). Creates an `execution_jobs` row (`status=queued`) and enqueues a BullMQ job.
3. The **execution-worker** service (separate deployable) picks the job up.
4. Worker launches an **ephemeral** container from a pre-built minimal image:
   - `--rm` — destroyed immediately after the run
   - `--network none` — no network access at all
   - `--memory=128m --cpus=0.5 --pids-limit=64` — hard resource ceilings
   - `--read-only` root filesystem, with a size-capped `tmpfs` mount for scratch space
   - runs as a **non-root** user inside the container
   - a restrictive **seccomp** profile limiting available syscalls
   - a wall-clock timeout enforced by the worker wrapper (kills the container if exceeded)
   - stdout/stderr captured with a hard byte cap (prevents log-bomb style resource abuse)
5. Worker writes the result back to `execution_jobs` and publishes the result on the room's Redis channel so the owning API instance can forward it to the client over the existing WS connection.

**Isolation boundary:** the execution worker runs on infrastructure separated from the API/DB (separate host or VM), and its access to the Docker daemon is the *only* privileged capability it holds — it has no database credentials beyond a narrow write path for job results, and no access to auth internals.

**Documented trade-off:** cgroups + seccomp + no-network is a reasonable isolation bar for a portfolio project, but it is **not** kernel-level isolation. The architecture explicitly earmarks **gVisor, Kata Containers, or Firecracker microVMs** (the approach used by AWS Lambda and CodeSandbox) as the production-grade next step — see ADR-0003. Building that from day one would be over-engineering for this project's actual risk profile (YAGNI), but knowing the gap and naming the upgrade path is itself the senior-engineering signal.

---

## 8. Authentication Architecture

- **Registration:** email + password (Argon2id hashing) or OAuth (GitHub/Google).
- **Login:** issues a short-lived **access JWT** (~15 min) and a long-lived **refresh token** (7–30 days), the latter stored as an `httpOnly`, `Secure`, `SameSite=Strict` cookie.
- **Refresh token rotation:** every refresh issues a new token and invalidates the old one; the hash is stored in `refresh_tokens`. If a **revoked** token is presented again, all tokens for that user are revoked and the session is force-logged-out — this reuse-detection is what turns "JWT auth" into a defensible senior-level design.
- **WebSocket auth:** the client obtains a short-lived, single-use WS ticket via an authenticated REST call, or presents the access token during the WS handshake; the server validates it before upgrading the connection and attaches the resolved user identity to the socket context.
- **Authorization (RBAC):** room-scoped roles — `owner`, `editor`, `viewer` — stored in `room_members`. Enforced via a reusable guard (e.g. `requireRoomRole('editor')`) applied uniformly to REST routes and WS event handlers, so the rule is defined once and used everywhere (DRY).
- **CSRF:** since the refresh token lives in an `httpOnly` cookie, the refresh endpoint is protected with `SameSite=Strict` plus a double-submit token.
- **Rate limiting:** login/register endpoints are rate-limited per IP and per account via Redis to blunt brute-force attempts.
- **Deferred to later phases (explicitly, not silently dropped):** email verification, password-reset flow, 2FA.

---

## 9. Redis Usage

Redis is used deliberately for **four distinct roles** on one infrastructure primitive, rather than reaching for four separate systems:

1. **Pub/Sub fan-out** — cross-instance broadcast of Yjs updates and application events (Section 6).
2. **Queue backing store (via BullMQ)** — execution job queue, retries, concurrency limits, delayed jobs.
3. **Ephemeral presence cache** — `presence:{roomId}:{userId}` keys with short TTLs, refreshed on heartbeat; gives presence continuity across reconnects/instance restarts without ever touching Postgres.
4. **Rate limiting & revocation cache** — sliding-window counters for auth/execution endpoints, and a fast revoked-token lookup to avoid a DB hit on every request.

**Design rule:** Redis never holds anything that is the *only* copy of truth. If Redis is flushed, the system degrades (presence resets, rate limits reset) but no user data is lost — durable state always lives in PostgreSQL.

---

## 10. Development Roadmap

| Phase | Focus |
|---|---|
| 0 | Monorepo scaffold (pnpm + Turborepo), shared tsconfig/eslint/prettier, CI skeleton, `docker-compose` with Postgres + Redis only, this architecture doc committed. |
| 1 | Auth & user foundation: schema, Fastify skeleton, DI container, register/login/refresh/logout, password hashing, JWT issuance, unit + integration tests. |
| 2 | Rooms & persistence foundation: rooms/room_members/documents schema, REST CRUD, RBAC middleware, React app shell + auth pages + room list/create UI. |
| 3 | Real-time collaboration core: WS server, Yjs sync integration, awareness/presence, Monaco+Yjs binding on the frontend — single-instance collaborative editing working end to end. |
| 4 | CRDT persistence: snapshot/update tables, compaction strategy, reconnect/resync logic. |
| 5 | Horizontal scaling of the WS layer: Redis pub/sub adapter, multi-instance local verification via `docker-compose --scale`. |
| 6 | Secure code execution: execution_jobs schema, BullMQ queue, execution-worker service, Docker sandboxing, submit/stream/result flow, frontend execution panel. |
| 7 | Presence polish: live cursors with user colors, selection highlighting, avatar list, typing indicators, connection-status UX. |
| 8 | Production hardening: implement the reserved `apps/api/src/observability/` layer (metrics, tracing, health/readiness probes), structured logging, centralized error taxonomy, rate limiting everywhere, security headers, CORS policy, secrets management. |
| 9 | Testing & quality: coverage targets, CRDT convergence test suite, E2E flows via Playwright, WS load testing (k6/Artillery). |
| 10 | Deployment & DevOps: multi-stage production Dockerfiles, `docker-compose.prod`, CI/CD (GitHub Actions), deployment target, monitoring. |
| 11 | Interview presentation polish: architecture diagrams, ADRs, demo recording, "how would you scale this to 1M users" write-up, documented trade-offs, seed/demo mode. |

---

## 11. Key Architectural Decisions & Trade-offs

- **Modular monolith + one separated deployable, not full microservices.** A team of one building a portfolio project gets more credit for correctly *not* over-engineering than for a service mesh nobody asked for. The one boundary drawn — code execution — is drawn for a real security reason, not for resume-driven design. *(ADR-0001)*
- **Yjs over Operational Transformation.** CRDTs need no central sequencing/transform authority, are simpler to reason about under network partitions, and have a mature ecosystem (`y-websocket`, `y-indexeddb`, `y-monaco`, awareness protocol). Trade-off: Yjs documents accumulate tombstone metadata over a long lifetime — mitigated with the snapshot/compaction strategy in Section 5. *(ADR-0002)*
- **Docker + cgroups/seccomp/no-network, not Firecracker, for v1 execution isolation.** Strong enough isolation to demonstrate real security awareness, without building a microVM platform for a project whose actual threat exposure doesn't yet justify it. The gap is named explicitly rather than hidden. *(ADR-0003)*
- **Prisma over raw SQL by default.** Optimizes for velocity and type safety; the escape hatch (`$queryRaw`) is documented for the rare hot path that needs it, rather than pre-optimizing everywhere.
- **Fastify over Express.** Schema validation and plugin encapsulation are built in, which pairs naturally with the DI/clean-architecture goals — at the (accepted) cost of a smaller ecosystem than Express.
- **Single multiplexed WS connection over separate connections/namespaces.** Fewer connections to authenticate and manage per client, at the cost of implementing a small framing protocol — a deliberate, demonstrable piece of systems design rather than an off-the-shelf abstraction.
- **Presence lives in Yjs awareness + Redis relay, never in Postgres.** Presence is inherently ephemeral; persisting it would be scope creep with no product value (YAGNI). Redis is a relay, not a store of record.
- **Refresh-token rotation with reuse detection**, rather than plain long-lived refresh tokens — a small addition that meaningfully raises the security bar and is a strong interview talking point.
- **`shared-contracts` split out from `shared-types` / `shared-schemas`.** Keeps three concerns from blurring: *what* the wire contract looks like (`shared-contracts`), *how* it's validated at runtime (`shared-schemas`), and *generic* helper types with no communication semantics (`shared-types`). Avoids the common anti-pattern where a single "shared types" package quietly becomes a dumping ground for everything.
- **Per-module `interfaces/` folders inside `apps/api`.** Makes Dependency Inversion physically visible in the tree rather than implied by convention — a service imports from its own module's `interfaces/`, never directly from another module's `repositories/`. This keeps module boundaries enforced by folder structure, not just discipline, and costs nothing at this scale (a handful of extra folders per module).
- **`apps/api/src/observability/` reserved but empty.** Naming the folder now avoids a later restructure once metrics/tracing/health are actually implemented in Phase 8, without pulling forward the work itself (YAGNI still applies to the *implementation*, not to the *placeholder*).

---

## 12. Freeze Notice — FINAL

This is the final, approved architecture. Relative to the first draft, exactly three refinements were incorporated:
1. `packages/shared-contracts` added as the dedicated home for cross-app communication contracts (DTOs, WS event payloads, shared enums, command/event payloads), with `shared-types` and `shared-schemas` scoped down to avoid overlap.
2. Every `apps/api/src/modules/*` module restructured into `controllers/`, `services/`, `repositories/`, `interfaces/`, `dto/`, `schemas/`, `types/`, `tests/` for explicit Clean Architecture layering and visible Dependency Inversion.
3. `apps/api/src/observability/{metrics,tracing,health}` reserved as an architectural placeholder for Phase 8 — structure only, no implementation.

No other decision from the original document changed.

The **folder structure (Section 3)** and the **architecture (Sections 1–11)** are now frozen for implementation. No renaming, reorganizing, or structural changes will be made without first writing a short ADR in `docs/adr/` stating: context, the change, and the consequences. This document should be saved at `docs/architecture.md` in the repository as the canonical reference.

Next step: reply **"Continue"** to begin file-by-file implementation, starting from Phase 0.