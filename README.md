# lookout

URL health and observability platform. Monitors URLs on a schedule, records status and latency, aggregates uptime, and exposes a real-time dashboard with structured logging and request tracing.

![Dashboard](docs/screenshots/dashboard.png)

## Live demo

| | |
| --- | --- |
| App | <!-- TODO: Vercel URL --> `https://REPLACE-ME.vercel.app` |
| API health | <!-- TODO: Railway URL --> `https://REPLACE-ME.up.railway.app/health` |

Sign in as `demo@lookout.dev` / `demo1234` for the seeded dataset (50 URLs, 100k
checks over 7 days), or `admin@lookout.dev` / `admin1234` for the admin view with
the metrics page. Signing up creates an empty account; **Try the sample** fills it.

The frontend is on Vercel and the api and worker are on Railway, with Postgres
and Redis alongside them. Deployment steps are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Quick start

Prerequisites: Docker and Docker Compose.

```bash
cp .env.example .env
# JWT_SECRET must be at least 32 characters:
openssl rand -base64 32          # paste the output into JWT_SECRET in .env

docker compose up --build -d
```

Open <http://localhost:8080>, sign up, and click **Try the sample**. Within a few seconds the table shows the three sample URLs checked: two UP, one DOWN with a 404.

Optional — seed 100k checks across 50 URLs for the scale demo (about 6 seconds):

```bash
docker compose exec api node dist/scripts/seed.js
# re-run over existing demo data with: ... seed.js --force
```

It creates `demo@lookout.dev` / `demo1234` (USER) and `admin@lookout.dev` / `admin1234` (ADMIN). To make the admin view reachable for accounts you create yourself, set `ADMIN_EMAILS` in `.env` before starting.

Local development without app containers, in three terminals:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
cd backend  && cp .env.example .env && npm install && npm run db:migrate && npm run dev
cd backend  && npm run worker
cd frontend && npm install && npm run dev      # http://localhost:5173, proxies /api to :4000
```

## What it does

| Requirement | What was built | Where |
| --- | --- | --- |
| Authentication | Email/password signup and login, bcryptjs (cost 12), stateless JWT bearer tokens, `requireAuth` re-loads the user from the DB on every request | `backend/src/modules/auth/` |
| Monitoring engine | Native `fetch` checker with a per-check timeout, redirect following, and a seven-value error taxonomy | `backend/src/modules/checks/checker.ts`, `classifyError.ts` |
| Concurrency and scheduling | BullMQ job scheduler per URL at its own interval; worker concurrency cap; inline semaphore for batch checks | `backend/src/queue/`, `backend/src/worker.ts` |
| Database | Postgres 16 via Prisma; four tables; hourly rollups and 7-day retention on raw checks | `backend/prisma/schema.prisma`, `backend/src/modules/stats/` |
| UI | React SPA: dashboard with live summary and table, per-URL detail with charts, admin metrics | `frontend/src/pages/` |
| Logging | pino structured JSON, per-request levels, correlation IDs spanning API and worker | `backend/src/logger.ts`, `backend/src/app.ts` |

Bonuses implemented: role-based access (USER/ADMIN), Redis-backed queue with background workers, real-time dashboard via polling, structured JSON logs, per-route log levels, correlation IDs across processes, an admin metrics endpoint, retries with exponential backoff, Dockerized deployment behind nginx, GitHub Actions CI, auth rate limiting, and uptime/percentile aggregation.

Not built: WebSockets (polling instead), email or webhook alerting, and multi-tenancy beyond per-user ownership with an admin override.

## Architecture

```
                    ┌──────────────────────────────────────────┐
  browser ────────▶ │ nginx  :8080                             │
                    │  · serves the built SPA                  │
                    │  · proxies /api ──────────────┐          │
                    └───────────────────────────────┼──────────┘
                                                    ▼
                              ┌──────────────────────────────┐
                              │ api (express)  :4000         │
                              │  · REST + auth               │
                              │  · enqueues checks           │
                              └────┬────────────────────┬────┘
                                   │                    │
                          reads/writes            enqueue jobs
                                   │                    │
                                   ▼                    ▼
                         ┌──────────────────┐   ┌──────────────┐
                         │ postgres  :5432  │   │ redis  :6379 │
                         └──────────────────┘   └──────┬───────┘
                                   ▲                   │ consume
                                   │                   ▼
                                   │        ┌────────────────────────┐
                                   └────────┤ worker                 │
                                 writes     │  · checks queue        │
                                 checks     │  · maintenance queue   │
                                            └────────────────────────┘
```

- The api and worker are separate processes built from the same image, with the command overridden. The API never constructs a `Worker`, so a slow site cannot affect HTTP latency, and checks keep running while the API restarts.
- Each URL gets one BullMQ job scheduler keyed `url:<id>`, firing at that URL's interval.
- Postgres is the source of truth for what should be scheduled. On boot the worker reconciles: every active URL gets a scheduler, and any scheduler without a matching active URL is removed. A flushed Redis or a crash mid-write heals on the next start.
- Manual checks ("Check now") go through the same queue with priority 1, so a person waiting jumps ahead of the scheduled backlog. The API waits up to 15s for the result and returns 202 with a job id if the worker is slower than that.
- A second `maintenance` queue runs the hourly rollup every 5 minutes and retention pruning every 24 hours.
- A DOWN result is a **successful** job. Only infrastructure faults (Postgres unreachable, URL row deleted) throw and retry with exponential backoff. Retrying a down site would hammer it three times per interval and write three DOWN rows, inflating the outage in the history.
- Latency is measured as time-to-headers: `fetch` settles when response headers arrive, the timer stops, and the body is cancelled without reading it. That measures server responsiveness rather than page weight.

## Data model and query design

Four tables: `users`, `urls`, `checks`, `url_stats_hourly`.

`checks` is the table that grows without bound, so its primary key is a `bigint` identity rather than a UUID, and it carries `(url_id, checked_at DESC)` — the shape of every read path: latest N checks for one URL, and the latest single check per URL. A second index on `checked_at` alone serves retention pruning and rollup windows.

`url_stats_hourly` exists so that dashboard reads stay flat as history accumulates. The 24h window reads raw `checks` in 15-minute buckets, because that resolution cannot be recovered from hourly aggregates. The 7d and 30d windows read only `url_stats_hourly` and never touch raw checks. Raw checks are pruned after 7 days (`CHECK_RETENTION_DAYS`) in batches of 10,000; hourly aggregates are kept.

### Latest check per URL

The dashboard needs the newest check for every URL, which is the hottest read in the app. The obvious formulation is `DISTINCT ON (url_id) ... ORDER BY url_id, checked_at DESC`. It *does* use `checks_url_id_checked_at_idx`, but only to read it in order: it walks every entry for the scoped URLs and discards all but the first of each group. Measured at 60 URLs / 120k checks:

| Query | Time | Index rows scanned | Buffers |
| --- | --- | --- | --- |
| `DISTINCT ON (url_id)` | 50.4 ms | 120,009 | 121,237 |
| `LEFT JOIN LATERAL ... LIMIT 1` | 0.51 ms | 60 seeks | 240 |

The lateral form is used. Its cost scales with the number of URLs, not the number of checks. `EXPLAIN (ANALYZE, BUFFERS)` on the seeded dataset (100,007 checks, 53 URLs):

```
Nested Loop Left Join  (actual time=0.058..0.670 rows=50 loops=1)
  Buffers: shared hit=202
  ->  Seq Scan on urls u  (rows=50)
  ->  Limit  (actual time=0.013..0.013 rows=1 loops=50)
        ->  Index Scan using checks_url_id_checked_at_idx on checks c
              Index Cond: (url_id = u.id)
Execution Time: 0.698 ms
```

Measured at 100k checks: dashboard summary 45 ms; per-URL stats 24h 12 ms, 7d 13 ms, 30d 10 ms. The seed writes 100k rows in about 5s (`createMany`, batches of 5,000) and rolls up 169 hours into roughly 8,400 aggregate rows in under 350 ms.

![URL detail](docs/screenshots/url-detail.png)

## Health check engine

A check is **UP** when the final response status (after following redirects) is 200–299. Anything else is **DOWN**, with the status code recorded. Thrown errors are classified from `err.cause.code`, which is where undici puts the underlying socket failure:

| Error type | Verified against |
| --- | --- |
| `HTTP_ERROR` | `https://en.wikipedia.org/saecs/Saweascasce` → 404 |
| `DNS_FAIL` | `https://this-domain-does-not-exist-lookout.invalid` → ENOTFOUND |
| `CONN_REFUSED` | `http://127.0.0.1:9999` → ECONNREFUSED |
| `TLS_ERROR` | `https://expired.badssl.com` → CERT_HAS_EXPIRED |
| `INVALID_URL` | `http://127.0.0.1:1` → see note below |
| `TIMEOUT` | local server that never responds, with `timeoutMs: 500` |
| `UNKNOWN` | anything unrecognised, with the code kept in the message |

`http://127.0.0.1:1` reports `INVALID_URL`, not `CONN_REFUSED`. Port 1 is on the WHATWG fetch blocked-ports list, so undici rejects the request before opening a socket — nothing was refused by a peer, and the error carries no code. Reporting it as a connection refusal would be a lie about what happened.

Concurrency: the worker processes up to `CHECK_CONCURRENCY` (default 10) jobs at once. The API's batch path uses a small inline semaphore with the same cap rather than a dependency. Seven real checks against live sites completed concurrently in about 800 ms.

Tests: 25 unit tests, no network access. 20 cover every branch of the error classifier using hand-built error objects with the right `name`/`cause.code`; 5 cover the checker against a local HTTP server on a random port with `/ok`, `/slow`, `/500`, and `/redirect` routes, plus a bound-then-released port for a genuine ECONNREFUSED.

![Sample input](docs/screenshots/sample-input.png)

## Observability

Logs are pino JSON on stdout (pretty-printed only in development, via `LOG_PRETTY`). Request logs are `info`, 4xx are `warn`, 5xx and thrown errors are `error`, and `/health` is `debug` so the container healthcheck polling every 10 seconds does not drown out everything else.

Every request gets an `x-request-id`: the incoming header is honoured if present, otherwise one is minted, and it is echoed back on the response. The request logger is held in an `AsyncLocalStorage`, so `getLogger()` anywhere in the service layer returns a child already carrying `reqId` without threading a logger through every signature. Manual jobs carry the `reqId` in their job data, and the worker rebuilds the same context — so one trace spans two processes:

```json
api    {"level":30,"reqId":"trace-demo-1788472726","jobId":"7","urlId":"fc61f728…","trigger":"manual","msg":"check job enqueued"}
worker {"level":40,"reqId":"trace-demo-1788472726","jobId":"7","trigger":"manual","url":"https://en.wikipedia.org/saecs/Saweascasce","status":"DOWN","statusCode":404,"responseMs":146,"errorType":"HTTP_ERROR","msg":"check failed"}
api    {"level":30,"reqId":"trace-demo-1788472726","res":{"statusCode":200},"responseTime":160,"msg":"request completed"}
```

`GET /api/metrics` (ADMIN only) reports last-hour check totals, failures, failure rate, average and p95 latency, checks per minute, BullMQ queue depths (waiting/active/completed/failed/delayed), and process uptime and memory.

![Admin metrics](docs/screenshots/admin-metrics.png)

## Security notes

- Passwords hashed with bcryptjs at cost 12. bcryptjs (pure JS) rather than native bcrypt so the image needs no compile toolchain.
- Login runs a bcrypt comparison against a fixed dummy hash when the email is not found, so response timing does not reveal whether an account exists. Wrong email and wrong password return the same 401.
- JWTs are verified and the user is re-loaded from the database on every authenticated request, so a deleted user cannot keep using a valid token.
- A URL owned by another user returns **404, not 403**, so the API does not leak which URLs exist.
- Rate limiting on `/api/auth` (20 requests per 15 minutes per IP), `helmet` security headers, and CORS restricted to a configured origin.
- URL normalization rejects embedded credentials (`user:pass@`) and any scheme other than http/https.
- The api and worker containers run as a non-root user (`USER node`). Only the frontend publishes a port; Postgres, Redis, and the API stay on the internal network.
- `passwordHash` is never returned by any endpoint; responses go through a `toPublicUser()` helper.

Tradeoff: the JWT is stored in `localStorage` and sent as a bearer token. That is simple and immune to CSRF, but it is readable by any XSS on the page. In production I would move to an httpOnly, Secure, SameSite cookie with a short-lived access token and refresh-token rotation, which needs CSRF protection in exchange.

## Design decisions and tradeoffs

- **Prisma 6, pinned.** Prisma 7 removes `url` from the schema datasource and requires driver adapters plus a config file; the npm `latest` tag was an 8.0 release candidate. Pinned to the stable 6.x line rather than reworking the data layer around a brand-new major.
- **`relationJoins` preview left off.** Prisma's default strategy issues one extra batched query per page for `lastCheck`, which is not N+1 and is good enough. Enabling a preview feature for a true lateral join was not worth the stability cost.
- **Node's native `fetch`, no axios.** Node 20 has it built in; one less dependency, and undici's error causes are exactly what the classifier needs.
- **GET, not HEAD.** Many servers reject or mishandle HEAD and would be reported down while perfectly healthy. The body is cancelled immediately, so the cost is one round trip either way.
- **Polling, not WebSockets.** A 5-second poll meets the "real-time dashboard" requirement and avoids reconnect logic, backpressure, and connection-state bugs. `usePolling` pauses while the tab is hidden.
- **BullMQ, not `setInterval`.** Gives persistence across restarts, retries with backoff, priorities, and a scheduler model that survives a crash — all of which a hand-rolled timer loop would have to reimplement.
- **The first check on create was removed.** `upsertJobScheduler` fires its first job immediately, so explicitly enqueuing a manual check on top wrote two near-identical rows per URL.
- **Tailwind and recharts only.** No component or form library; the UI is small enough that a design system would be more code than it saves.
- **Retention deletes in batches of 10,000.** A single `DELETE` over a neglected table holds locks and bloats WAL; batching keeps each statement short.
- **The Prisma CLI is a runtime dependency.** The api container runs `prisma migrate deploy` on startup, so the CLI has to survive `npm ci --omit=dev`.

## How AI was used

I planned this in a conversation with Claude: we settled the stack, then wrote a 10-step plan with one detailed prompt per step — fixed versions, explicit scope limits, and a verification list to run before each commit. Claude Code implemented each step; I reviewed the diff, ran the verification, made the commit, and only then moved on.

It earned its place on measurements, not typing. In step 7 I specified `DISTINCT ON` for the latest-check-per-URL query and asked it to confirm the index was used. It benchmarked both forms, showed `DISTINCT ON` scanning all 120,009 index rows in 50.4 ms against 0.51 ms for a lateral join, and switched the implementation. A comment I asked for in step 4 claimed Prisma compiled a relation include into a lateral join; the query log showed a batched `IN`, so it was corrected rather than left to mislead. It also found that `http://127.0.0.1:1` can never report CONN_REFUSED (port 1 is on the fetch blocked-ports list), that `upsertJobScheduler` fires immediately and was causing a duplicate first check, and that an nginx `proxy_pass` with a trailing slash would strip the `/api` prefix and 404 every route.

The plan constrained it as often: pinning Prisma 6 and React 18 against newer defaults, stripping generator scaffolding, holding each step to its scope.

Three bugs surfaced only because verification was mandatory: a `z.coerce.boolean()` on `LOG_PRETTY` that made `"false"` true and crashed the production image on boot; a missing `ORDER BY` tiebreaker that reshuffled the dashboard when a row was paused; and a chart that drew nothing for a single-point series.

One honest failure: in step 7 a cleanup query run during verification was too broad and deleted real rows. Nothing shipped, but it is why seed data is kept separate from what a demo runs against.

## Project structure

```
backend/src/
  modules/auth/     signup, login, JWT middleware, requireRole
  modules/urls/     CRUD, bulk import, URL normalization, ownership rules
  modules/checks/   fetch checker, error classifier, check service and routes
  modules/stats/    hourly rollup, retention, stats queries, dashboard, metrics
  queue/            Redis connection, checks queue, per-URL job schedulers
  scripts/          seed
  middleware/       zod validation, async handler
  types/            Express Request augmentation
  app.ts server.ts worker.ts config.ts db.ts logger.ts errors.ts

frontend/src/
  api/              fetch wrapper, ApiError, response types
  auth/             AuthContext, RequireAuth
  components/       layout, toasts, status pill, cards, buttons
  hooks/            usePolling
  pages/            AuthPage, Dashboard, UrlDetail, AdminMetrics
  utils/            relative and absolute time formatting
```

## API reference

All routes are prefixed `/api`. Auth is a bearer token: `Authorization: Bearer <token>`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | — | Create an account, returns user and token |
| POST | `/api/auth/login` | — | Exchange credentials for a token |
| GET | `/api/auth/me` | user | Current user |
| GET | `/api/urls` | user | Paginated URLs with their latest check (`page`, `pageSize`, `status`, `all`) |
| POST | `/api/urls` | user | Add a URL (`url`, optional `intervalSeconds`) |
| POST | `/api/urls/bulk` | user | Import up to 100 URLs, returns created and skipped with reasons |
| GET | `/api/urls/:id` | user | One URL |
| PATCH | `/api/urls/:id` | user | Update `intervalSeconds` or `isActive` |
| DELETE | `/api/urls/:id` | user | Delete a URL and its history |
| GET | `/api/urls/:id/checks` | user | Check history, newest first (`limit`, max 500) |
| GET | `/api/urls/:id/stats` | user | Aggregates and time series (`window` = 24h, 7d, 30d) |
| POST | `/api/urls/:id/check` | user | Run a check now; 200 with the result, or 202 with a job id |
| POST | `/api/urls/check-all` | user | Enqueue a check for every active URL, returns 202 |
| GET | `/api/dashboard/summary` | user | Fleet counts and 24h uptime (`all` for admins) |
| GET | `/api/metrics` | admin | Check, queue, and process metrics |
| GET | `/health` | — | Liveness with `db` and `redis` status; 503 if either is down |

![Bulk import](docs/screenshots/bulk-import.png)

## License

MIT. See [LICENSE](LICENSE).
