# Carbon deployment guide

This document describes how Carbon is deployed in practice. The monorepo supports **two main approaches**: **managed AWS (SST + ECS)** used by upstream CI, and **self-hosted Docker** for running ERP (and optionally MES) on your own infrastructure.

---

## Architecture at a glance

| Component | Role |
|-------------|------|
| **ERP / MES** | React Router apps (`apps/erp`, `apps/mes`), production build served on **port 3000** in containers. |
| **Supabase** | Auth, PostgREST, Realtime, Storage — the app talks to **`SUPABASE_URL`** with anon/service keys; **plain Postgres alone is not a drop-in replacement** for the HTTP API. |
| **Postgres** | Backing database (often the same instance Supabase manages, or linked for `SUPABASE_DB_URL`). |
| **Upstash Redis** | Used by `@carbon/kv` (e.g. login rate limits). REST URL + token. |
| **Email** | Outbound mail via **SMTP** (`MAIL_*`) or **Resend** (`RESEND_*`) — see `packages/lib/src/resend.server.ts`. |
| **Trigger.dev** | Background jobs in `packages/jobs` (optional until you use those features). |

---

## Path 1: AWS (SST, ECS, ECR) — CI-driven

**When to use:** Production deployments aligned with the project’s GitHub Actions and AWS account.

**Flow (high level):**

1. **Build** — On push to `main` (paths under `apps/erp`, `apps/mes`, `packages/`), CI builds Docker images from `apps/erp/Dockerfile` and `apps/mes/Dockerfile`, tags them, and **pushes to Amazon ECR** (`linux/amd64`).
2. **Deploy** — A second job runs `npm run -w ci ci:deploy`, which drives **SST** (`npx sst deploy --stage prod` per workspace configuration in `ci/`), targeting **ECS** on a VPC with load balancers, TLS (ACM), WAF, etc.

**Key files:**

- `.github/workflows/deploy.yml` — build + deploy pipeline.
- `sst.config.ts` — VPC, cluster, ERP/MES services, env wiring.
- `ci/src/deploy.ts` — workspace-aware deploy orchestration.

**Secrets / configuration:** AWS credentials, ECR, Supabase, certificates (`CERT_ARN_*`), and the same class of app env vars as in `.env.example` (session, integrations, etc.). Exact mapping is environment-specific.

**Further detail:** Internal notes in `llm/cache/sst-deployment-infrastructure.md` (SST resources, ports, health checks).

---

## Path 2: Self-hosted Docker (ERP + Compose)

**When to use:** You run Docker on a VM or bare metal, terminate TLS with your own reverse proxy, and manage secrets yourself.

**Documentation:** **`deploy/selfhosted/README.md`** — step-by-step for `.env`, `docker-compose.yml`, **`deploy.sh`**, health checks, and manual proxy to `http://127.0.0.1:3000`.

**Quick reference:**

```bash
cd deploy/selfhosted
cp .env.example .env   # edit secrets
./deploy.sh              # build erp image, up -d, wait for /health
```

You must still provide a **Supabase-compatible API** reachable from the ERP container (commonly `http://host.docker.internal:54321` if Supabase runs on the same host). TLS and DNS are **not** configured by the compose file; you point Apache, nginx, or Caddy at the app port.

---

## Environment variables (production)

Use the root **`.env.example`** as the checklist. Highlights:

| Area | Variables |
|------|-----------|
| **Core** | `SESSION_SECRET`, `NODE_ENV`, `DOMAIN`, `ERP_URL`, `MES_URL`, `VERCEL_URL` (public base URL even off Vercel). |
| **Supabase** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`. |
| **PostHog** | `POSTHOG_API_HOST`, `POSTHOG_PROJECT_PUBLIC_KEY` (required by app config). |
| **Redis** | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. |
| **Email** | **SMTP:** `MAIL_HOST`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_PORT`, `MAIL_ENCRYPTION`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `APP_NAME` — or **Resend:** `RESEND_API_KEY`, `RESEND_DOMAIN`. Optional: `DISABLE_EMAIL`, `DISABLE_RESEND`. |
| **Jobs** | `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL`, `TRIGGER_PROJECT_ID` (if using Trigger.dev). |
| **Other** | Novu, Stripe, OAuth providers, etc., per features you enable. |

Never commit real `.env` files; copy from `.env.example` on each environment.

---

## Database migrations

Migrations live under `packages/database`. They are **not** automatically applied by the self-hosted `deploy.sh` script. Plan migrations as part of your release process (Supabase CLI, CI job, or controlled `SUPABASE_DB_URL` access).

---

## Health checks

- **ERP / MES:** `GET /health` — JSON + DB connectivity probe (used by ECS in AWS and useful after self-hosted deploy).

---

## Verification after deploy

1. **`curl -fsS https://your-domain/health`** (or `http://127.0.0.1:3000/health` behind the proxy) returns **200**.
2. **Login / signup** flows work (Redis + email + Supabase auth).
3. **Trigger.dev** tasks (if used): project deployed and `TRIGGER_*` env matches.

---

## Related links

| Topic | Location |
|--------|----------|
| Self-hosted Docker (detailed) | `deploy/selfhosted/README.md` |
| Self-hosted env template | `deploy/selfhosted/.env.example` |
| Local development | Root `README.md` |
| SST / AWS cache notes | `llm/cache/sst-deployment-infrastructure.md` |

---

## Docker images

| App | Dockerfile | Container port |
|-----|------------|----------------|
| ERP | `apps/erp/Dockerfile` | **3000** |
| MES | `apps/mes/Dockerfile` | **3000** (`PORT=3000`; map host port as needed) |

Build context is always the **repository root** (same as CI).
