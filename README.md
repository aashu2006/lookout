# lookout

A small uptime monitor. You add some URLs, it checks them on a schedule, and the dashboard shows what's up, what's down, and how fast each one responds.

![Dashboard](docs/screenshots/dashboard.png)

## Live demo

https://lookout-dusky.vercel.app

Log in with `demo@lookout.dev` / `demo1234` to see 20 real URLs with a week of history. `admin@lookout.dev` / `admin1234` also gets the metrics page. Or sign up with your own email and hit **Try the sample**.

The api is on Render's free tier, so if nobody has used it in a while the first load can be slow while it wakes up.

## Stack

- **Backend:** Node 20, Express, Prisma + Postgres, BullMQ + Redis, pino for logs
- **Frontend:** React 18, Vite, Tailwind, recharts
- **Hosting:** Vercel for the frontend, Render for the api and Redis, Supabase for Postgres

## Run it locally

You need Docker.

```bash
cp .env.example .env
# put a JWT_SECRET of 32+ chars in .env, e.g. from: openssl rand -base64 32
docker compose up --build -d
```

Open http://localhost:8080, sign up, and click **Try the sample**. You should see three URLs show up: two UP and one DOWN with a 404.

If you want the demo data too:

```bash
docker compose exec api node dist/scripts/seed.js   # add --force to redo it
```

That creates the same demo and admin logins as the live site. To make your own account an admin, put your email in `ADMIN_EMAILS` in `.env` before starting.

### Running the app outside Docker

Start just Postgres and Redis in Docker, then run each part in its own terminal:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis

cd backend  && cp .env.example .env && npm install && npm run db:migrate && npm run dev
cd backend  && npm run worker
cd frontend && npm install && npm run dev    # http://localhost:5173
```

Tests: `cd backend && npm test`

## How it works

- The api handles auth and CRUD, and puts check jobs on a Redis queue.
- A separate worker process picks those jobs up and actually hits the URLs, so a slow site never slows down the api.
- Each URL gets its own BullMQ scheduler that fires at its interval. When the worker starts it syncs the schedulers with Postgres, so if Redis gets wiped it just rebuilds them.
- A check is UP if the final response (after redirects) is a 2xx. Anything else is DOWN, saved with an error type like `HTTP_ERROR`, `TIMEOUT`, `DNS_FAIL`, `TLS_ERROR` or `CONN_REFUSED`.
- Raw checks are kept for 7 days. They also get rolled up into hourly stats, which are kept forever and power the 7d and 30d charts.
- Every request gets an `x-request-id` that's passed along to the worker, so you can follow one check through the logs of both processes.

![URL detail](docs/screenshots/url-detail.png)

## Deploying

The api deploys to Render from `render.yaml`. Render has no free background workers, so there the worker runs inside the api process (`EMBED_WORKER=true`). `start-hosted.sh` runs the migrations and the seed before starting the api.

For `DATABASE_URL`, use Supabase's **session pooler** URL with `?connection_limit=5` on the end. The direct host is IPv6 only so Render can't reach it, and the transaction pooler breaks `prisma migrate deploy`.

The frontend is on Vercel with `frontend` as the root directory. `frontend/vercel.json` forwards `/api/*` to the Render api, so the browser only ever talks to the Vercel domain.

## API

Everything is under `/api` and uses `Authorization: Bearer <token>`, except signup, login and `/health`.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | anyone | Create an account, returns user and token |
| POST | `/api/auth/login` | anyone | Log in, returns a token |
| GET | `/api/auth/me` | user | Current user |
| GET | `/api/urls` | user | Your URLs with their latest check (`page`, `pageSize`, `status`, `all`) |
| POST | `/api/urls` | user | Add a URL (`url`, optional `intervalSeconds`) |
| POST | `/api/urls/bulk` | user | Add up to 100 URLs at once |
| GET | `/api/urls/:id` | user | One URL |
| PATCH | `/api/urls/:id` | user | Change `intervalSeconds` or `isActive` |
| DELETE | `/api/urls/:id` | user | Delete a URL and its history |
| GET | `/api/urls/:id/checks` | user | Check history, newest first (`limit`, max 500) |
| GET | `/api/urls/:id/stats` | user | Uptime and response times (`window` = 24h, 7d, 30d) |
| POST | `/api/urls/:id/check` | user | Run a check right now |
| POST | `/api/urls/check-all` | user | Queue a check for every active URL (`all` for admins) |
| GET | `/api/dashboard/summary` | user | Up/down counts and 24h uptime |
| GET | `/api/metrics` | admin | Check, queue and process metrics |
| GET | `/health` | anyone | Says whether the db and Redis are reachable |

More screenshots: [bulk import](docs/screenshots/bulk-import.png), [sample](docs/screenshots/sample-input.png), [admin metrics](docs/screenshots/admin-metrics.png).

## License

MIT
