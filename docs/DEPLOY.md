# Deploying lookout

The api and worker go on Railway. The frontend goes on Vercel. They are deployed
separately and joined by one Vercel rewrite, so the browser only ever talks to
the Vercel domain, the same way nginx works in the Docker setup.

Do Railway first. You need the api's domain before the Vercel rewrite has
anywhere to point.

---

## Part 1: Railway (Postgres, Redis, api, worker)

### 1. Create the project and datastores

1. Railway dashboard → **New Project**.
2. **+ Create** → **Database** → **Add PostgreSQL**.
3. **+ Create** → **Database** → **Add Redis**.

Leave both on defaults. They expose `${{Postgres.DATABASE_URL}}` and
`${{Redis.REDIS_URL}}` for other services in the project to use.

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
   | `REDIS_FAMILY` | `0`, only if Redis fails to connect. See troubleshooting |

   Do **not** set `PORT`. Railway sets it, and the app reads it from the
   environment.

4. **Settings → Networking → Generate Domain**. Save the URL, something like
   `https://api-production-xxxx.up.railway.app`. Vercel needs it.

Type the two reference variables exactly as `${{Postgres.DATABASE_URL}}` and
`${{Redis.REDIS_URL}}`. Railway swaps in the real connection strings at deploy
time, and the app hands them to Prisma and ioredis unchanged.

### 3. Create the `worker` service

Same repo, same Dockerfile, different start command.

1. **+ Create** → **GitHub Repo** → the same repository again.
2. **Settings**:
   - **Service Name**: `worker`
   - **Root Directory**: `backend`
   - **Deploy → Custom Start Command**:
     ```
     node dist/worker.js
     ```
   - **Healthcheck Path**: leave empty. The worker has no HTTP server, so a
     healthcheck would fail forever.
   - **Networking**: do **not** generate a domain. Nothing should reach it.
3. **Variables**: the same list as `api`, including `JWT_SECRET`. The worker
   loads the same config file, which checks every variable at startup and exits
   if `JWT_SECRET` is missing or under 32 characters, even though the worker
   never signs a token.

`backend/railway.json` holds only build and restart settings, no `startCommand`
and no `healthcheckPath`. Both services read that one file, and Railway's config
file wins over the dashboard, so a healthcheck path in it would also apply to the
worker and break its deploys. Start commands stay per service in the UI.

### 4. Migrations

The api runs `npx prisma migrate deploy` before it boots, so the schema is
applied on the first deploy and every one after. Watch the api's deploy log for
`Applying migration ... init`.

Railway starts services independently. If the worker comes up before the
migrations finish it will fail against missing tables and restart. It sorts
itself out, since the restart policy is `ON_FAILURE` with 10 retries.

### 5. Seed the demo data (optional)

Once the api deploy is green, open the **api** service, then **⋯ menu → Shell**,
or use `railway run` locally with the project linked:

```bash
node dist/scripts/seed.js
```

About 3 seconds. It creates `demo@lookout.dev` / `demo1234` (USER) and
`admin@lookout.dev` / `admin1234` (ADMIN), 20 real public URLs, and 40,320 checks
over 7 days at the same 5 minute interval the worker uses. Add `--force` to wipe
and recreate.

Sixteen URLs are healthy hosts. Four always fail, one per error type: a 404 path,
an expired certificate, a missing domain, and a 503 endpoint. So live checks
agree with the seeded history instead of contradicting it.

The seed writes URL rows straight to the database, so it also reconciles the
BullMQ schedulers before exiting. A running worker picks up the new URLs on its
own and no restart is needed. Its log line reads `reconciled job schedulers`.

---

## Part 1, free alternative: Render and Supabase

Railway has no free plan once the trial ends. This setup costs nothing and needs
no card: the api on Render's free web service, Redis on Render's free Key Value,
Postgres on Supabase. `render.yaml` at the repo root describes the Render side.

Two things differ from Railway:

- Render has no free background workers, so the worker runs inside the api
  process (`EMBED_WORKER=true`). A slow check can now share a CPU with a request.
- Render's free plan has no shell, so `backend/start-hosted.sh` runs the
  migrations and, with `SEED_ON_BOOT=true`, the seed before starting the api. The
  seed skips itself once the demo user exists.

### 1. Supabase (Postgres)

1. [supabase.com](https://supabase.com) → **New project**. Region **Southeast
   Asia (Singapore)**, the same region `render.yaml` uses. Save the database
   password.
2. **Connect** → **Session pooler** → copy the URI. It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`.
3. Put the password in and add `?connection_limit=5` to the end.

Use the session pooler, not the direct connection and not the transaction
pooler. The direct host is IPv6 only and Render cannot reach it. The transaction
pooler on port 6543 breaks `prisma migrate deploy`. The connection limit keeps
Prisma under the pooler's 15 connection cap.

### 2. Render (api, worker, Redis)

1. [render.com](https://render.com) → **New** → **Blueprint** → pick this
   repository. It reads `render.yaml` and proposes `lookout-api` and
   `lookout-redis`.
2. It asks for `DATABASE_URL`. Paste the Supabase string from step 1.
3. **Apply**. The first deploy builds the image, migrates, seeds, and starts.
   Watch the log for `seed complete` and `embedded worker started`.
4. Copy the service URL, something like `https://lookout-api.onrender.com`, and
   use it as the rewrite destination in Part 2.

### 3. Keep it awake

A free Render service sleeps after 15 minutes without an incoming request, and a
sleeping worker checks nothing. Add a free monitor at
[uptimerobot.com](https://uptimerobot.com) that requests
`https://<render-domain>/health` every 5 minutes. One service running all month
fits inside Render's 750 free hours.

### Limits

- Free Key Value has no persistence. If Render restarts it, the schedulers are
  gone until the api restarts and reconciles them. **Manual Deploy → Restart
  service** fixes it.
- Supabase pauses a free project after a week with no activity. The worker's
  checks count as activity, so this only happens if the api has been down.

---

## Part 2: Vercel (frontend)

### 1. Point the rewrite at Railway

Open `frontend/vercel.json` and replace the placeholder host with the api domain
from step 2.4:

```json
{
  "source": "/api/:path*",
  "destination": "https://api-production-xxxx.up.railway.app/api/:path*"
}
```

Keep `/api` on both sides. The backend serves every route under `/api`, so
dropping the prefix would 404 everything. Commit and push.

Vercel does not allow environment variables inside `rewrites`, which is why the
domain is written out in full instead of something like `$API_URL`.

### 2. Import the project

1. Vercel dashboard → **Add New** → **Project** → import this repository.
2. Configure:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite (detected)
   - **Build Command**: `npm run build` (default)
   - **Output Directory**: `dist` (default)
3. **Deploy**. No environment variables needed. The frontend only calls relative
   `/api/...` paths and the rewrite does the rest.

If you deployed before editing `vercel.json`, push the edit and **Redeploy**.

### 3. What the rewrites do

- `/api/:path*` goes to Railway. Vercel proxies it server side, so the browser
  sees a same origin request and there is no CORS preflight.
- `/(.*)` goes to `/index.html`. Rewrites only run after a static file lookup
  misses, so built assets still load, while routes like `/urls/:id` and
  `/admin/metrics` fall back to the app. Order matters: the `/api` rule is listed
  first and wins for API paths.

---

## Verification checklist

1. `curl -si https://<api-domain>/health` → `200` with `{"db":"ok","redis":"ok"}`.
   A `503` means Postgres or Redis is not connected. Check the variables.
2. Open the Vercel URL. The login screen loads.
3. Sign up with a new email. You land on the dashboard.
4. Click **Try the sample**. Within a few seconds the table shows
   `https://www.google.com` UP, `https://www.github.com` UP, and
   `https://en.wikipedia.org/saecs/Saweascasce` DOWN with a 404 and
   `HTTP_ERROR`. If rows stay `PENDING`, the worker is not picking up jobs. Check
   its logs.
5. Log out, log in as `demo@lookout.dev` / `demo1234` if you seeded. The
   dashboard shows 20 URLs: 16 UP and 4 DOWN, with failures spread across
   `HTTP_ERROR`, `TLS_ERROR` and `DNS_FAIL`. No healthy host should show
   `DNS_FAIL`. If they all do, the worker cannot resolve DNS. Open one URL and
   switch to the 7d window to confirm the rollup data is being read.
6. Log in as `admin@lookout.dev` / `admin1234`. A **Metrics** link appears in the
   nav, and `/admin/metrics` shows queue depths and process memory.
7. `curl -si https://<vercel-domain>/api/auth/me` → `401` with an
   `x-request-id` response header. That proves the rewrite reaches the api.

---

## Troubleshooting

**Redis will not connect from Railway.** Railway's private network is IPv6 only
and `*.railway.internal` publishes AAAA records only, while ioredis looks up IPv4
by default. Set `REDIS_FAMILY=0` on both `api` and `worker` and redeploy. The
variable is unset by default and changes nothing locally or in Docker.

**The api boots then exits straight away.** Look for
`Invalid environment configuration` in the deploy log. The config file checks
everything at startup and exits rather than running half configured. Usually it
is a missing `JWT_SECRET`, or one under 32 characters.

**`/api/...` returns Vercel's 404 page.** The `vercel.json` placeholder was never
replaced, or the destination is missing its `/api` prefix.

**The worker deploy is stuck unhealthy.** It has a healthcheck path set. Clear
it. The worker serves no HTTP.

**Costs.** The worker checks every active URL on its interval, forever. The seed
adds 20 URLs on a 5 minute interval, roughly 5,760 checks a day. That is small
but constant on a free tier. Pause URLs or delete the demo user to quiet it down.
