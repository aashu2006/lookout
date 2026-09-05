# Deploying lookout

Backend (api + worker) on Railway, frontend on Vercel. The two halves are
deployed independently and joined by one Vercel rewrite, so the browser only
ever talks to the Vercel origin — same as nginx does in the Docker setup.

Deploy Railway first: you need the api's public domain before the Vercel
rewrite can point anywhere.

---

## Part 1 — Railway (Postgres, Redis, api, worker)

### 1. Create the project and datastores

1. Railway dashboard → **New Project**.
2. **+ Create** → **Database** → **Add PostgreSQL**.
3. **+ Create** → **Database** → **Add Redis**.

Leave both on defaults. They expose `${{Postgres.DATABASE_URL}}` and
`${{Redis.REDIS_URL}}` as reference variables for other services in the project.

### 2. Create the `api` service

1. **+ Create** → **GitHub Repo** → pick this repository.
2. Open the new service → **Settings**:
   - **Service Name**: `api`
   - **Root Directory**: `backend`
   - **Build**: it picks up `backend/railway.json`, which forces the Dockerfile
     builder. No Nixpacks involved.
   - **Deploy → Custom Start Command**:
     ```
     npx prisma migrate deploy && node dist/server.js
     ```
   - **Deploy → Healthcheck Path**: `/health`
3. **Variables** tab → add:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `JWT_SECRET` | output of `openssl rand -base64 32` |
   | `ADMIN_EMAILS` | `admin@lookout.dev` |
   | `LOG_PRETTY` | `false` |
   | `NODE_ENV` | `production` |
   | `REDIS_FAMILY` | `0` — only if Redis fails to connect, see troubleshooting |

   Do **not** set `PORT`. Railway injects it, and the app reads it from the
   environment.

4. **Settings → Networking → Generate Domain**. Note the URL, something like
   `https://api-production-xxxx.up.railway.app`. You need it for Vercel.

Type the reference variables exactly as `${{Postgres.DATABASE_URL}}` and
`${{Redis.REDIS_URL}}`. Railway resolves them at deploy time to the internal
connection strings, credentials included, and the app passes both through to
Prisma and ioredis unmodified.

### 3. Create the `worker` service

Same repo, same Dockerfile, different entry point.

1. **+ Create** → **GitHub Repo** → the same repository again.
2. **Settings**:
   - **Service Name**: `worker`
   - **Root Directory**: `backend`
   - **Deploy → Custom Start Command**:
     ```
     node dist/worker.js
     ```
   - **Healthcheck Path**: leave empty. The worker has no HTTP server; a
     healthcheck would fail it forever.
   - **Networking**: do **not** generate a domain. Nothing should reach it.
3. **Variables**: the same set as `api`, including `JWT_SECRET`. The worker
   imports the same config module, which validates every variable at startup and
   exits if `JWT_SECRET` is missing or shorter than 32 characters — even though
   the worker never signs a token.

`backend/railway.json` deliberately contains only build and restart settings, no
`startCommand` and no `healthcheckPath`. Both services read that same file, and
Railway's config-as-code overrides the dashboard — so a healthcheck path in it
would be applied to the worker too and break its deploys. Start commands stay
per-service in the UI.

### 4. Migrations

The api's start command runs `npx prisma migrate deploy` before booting, so the
schema is applied on first deploy and on every subsequent one. Nothing to do by
hand. Watch the api's deploy logs for `Applying migration ... init`.

The worker starts only after the api is healthy in practice, because Railway
brings services up independently — if the worker wins the race it will retry
against a database whose tables do not exist yet and restart. That resolves
itself; the restart policy is `ON_FAILURE` with 10 retries.

### 5. Seed the demo data (optional)

Once the api deploy is green, in the **api** service: **⋯ menu → Shell** (or
`railway run` locally with the project linked):

```bash
node dist/scripts/seed.js
```

Roughly 6 seconds. Creates `demo@lookout.dev` / `demo1234` (USER) and
`admin@lookout.dev` / `admin1234` (ADMIN), 50 URLs, and 100k checks over 7 days.
Re-run with `--force` to wipe and recreate.

Note that the seeded URLs are `*.lookout-demo.dev` hostnames that do not resolve,
so once the worker starts checking them on schedule their live status becomes
`DNS_FAIL`. The seven days of history behind them stays intact.

---

## Part 2 — Vercel (frontend)

### 1. Point the rewrite at Railway

Edit `frontend/vercel.json` and replace the placeholder host with the api domain
from step 2.4:

```json
{
  "source": "/api/:path*",
  "destination": "https://api-production-xxxx.up.railway.app/api/:path*"
}
```

Keep the `/api` on both sides. The backend mounts every route under `/api`, so
stripping the prefix would 404 everything. Commit and push this change.

Vercel does not support environment variables inside `rewrites`, which is why
this is a literal string in the file rather than something like `$API_URL`.

### 2. Import the project

1. Vercel dashboard → **Add New** → **Project** → import this repository.
2. Configure:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite (detected)
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `dist` (default)
3. **Deploy**. No environment variables are needed: the frontend calls only
   relative `/api/...` paths and the rewrite handles the rest.

If you deployed before editing `vercel.json`, push the edit and **Redeploy**.

### 3. What the rewrites do

- `/api/:path*` → proxied to Railway. Because Vercel proxies this server-side,
  the browser sees a same-origin request, so no CORS preflight is involved.
- `/(.*)` → `/index.html`. Rewrites are evaluated only after a static file
  lookup misses, so built assets still serve normally while client-side routes
  (`/urls/:id`, `/admin/metrics`) fall back to the SPA entry point. Order
  matters: the `/api` rule is first and wins for API paths.

---

## Verification checklist

1. `curl -si https://<api-domain>/health` → `200` with `{"db":"ok","redis":"ok"}`.
   A `503` means one of the datastores is not connected; check the variables.
2. Open the Vercel URL. The login screen renders.
3. Sign up with a new email. You land on the dashboard.
4. Click **Try the sample**. Within a few seconds the table shows
   `https://www.google.com` UP, `https://www.github.com` UP, and
   `https://en.wikipedia.org/saecs/Saweascasce` DOWN with a 404 and
   `HTTP_ERROR`. If rows stay `PENDING`, the worker is not consuming — check its
   logs.
5. Log out, log in as `demo@lookout.dev` / `demo1234` (if you seeded). The
   dashboard shows 50 URLs; open one and switch to the 7d window to confirm the
   rollup data is being read.
6. Log in as `admin@lookout.dev` / `admin1234`. A **Metrics** link appears in the
   nav; `/admin/metrics` shows queue depths and process memory.
7. `curl -si https://<vercel-domain>/api/auth/me` → `401` with an
   `x-request-id` response header, proving the rewrite reaches the api.

---

## Troubleshooting

**Redis will not connect from Railway.** Railway's private network is IPv6-only
and `*.railway.internal` publishes AAAA records only, while ioredis defaults to
IPv4 lookups. Set `REDIS_FAMILY=0` on both `api` and `worker` and redeploy. The
variable is unset by default and changes nothing locally or in Docker Compose.

**The api boots then exits immediately.** Check the deploy log for
`Invalid environment configuration`. The config module validates everything at
startup and exits rather than running half-configured — most often a missing
`JWT_SECRET` or one shorter than 32 characters.

**`/api/...` returns Vercel's 404 page.** The `vercel.json` placeholder was not
replaced, or the destination is missing its `/api` prefix.

**The worker deploy is stuck unhealthy.** It has a healthcheck path set. Clear
it; the worker serves no HTTP.

**Costs.** The worker checks every active URL on its interval, forever. Seeding
100k rows plus 50 URLs on 1–30 minute intervals is a real, continuous workload
on a free tier. Pause URLs or delete the demo user to quiet it down.
