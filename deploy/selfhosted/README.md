# Self-hosted ERP (Docker, production)

See the repository overview in **`docs/DEPLOYMENT.md`**.

Run the Carbon **ERP** container with a local **Postgres** volume, bind **port 3000**, and supply secrets via **`.env`**. This path does **not** use AWS/SST; you operate Docker and your own reverse proxy.

## What you run

| Piece | Role |
|--------|------|
| **`docker-compose.yml`** | `postgres` (persistent volume) + `erp` (built from `apps/erp/Dockerfile`) |
| **Supabase-compatible API** | Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. The app uses `@supabase/supabase-js`; plain Postgres alone is not enough. Typical setup: **Supabase on the host** (`supabase start`) or [self-hosted Supabase Docker](https://supabase.com/docs/guides/self-hosting/docker). |
| **Reverse proxy** | **You configure manually** (Apache, nginx, Caddy, etc.) — TLS and domain. Forward to `http://127.0.0.1:3000`. |

## Production configuration (`.env`)

Copy the template and edit:

```bash
cd deploy/selfhosted
cp .env.example .env
```

**Do not paste only the repo root `.env` here** unless you add the **`POSTGRES_USER`**, **`POSTGRES_PASSWORD`**, and **`POSTGRES_DB`** lines — the root dev file often omits them. The Postgres service reads **`deploy/selfhosted/.env`** (next to `docker-compose.yml`), so those variables must exist in **this** file.

You can run `docker compose` from the repository root with `-f deploy/selfhosted/docker-compose.yml`; compose loads **`deploy/selfhosted/.env`** for the stack without requiring matching variables in the root `.env`.

### Required

- **`SESSION_SECRET`** — `openssl rand -base64 16`
- **`NODE_ENV=production`**
- **`DOMAIN`**, **`ERP_URL`**, **`MES_URL`**, **`VERCEL_URL`** — public HTTPS URLs (proxy must send `X-Forwarded-Proto: https` so the app knows it is secure).
- **`POSTHOG_*`** — analytics (required by app config).
- **`SUPABASE_URL`**, **`SUPABASE_ANON_KEY`**, **`SUPABASE_SERVICE_ROLE_KEY`**
- **`SUPABASE_DB_URL`** — direct Postgres URL for server-side SQL (often the same DB Supabase uses; see below).
- **`POSTGRES_*`** / compose DB — must match **`SUPABASE_DB_URL`** if this compose Postgres is your canonical DB.

### Email (verification codes, invites via `sendEmail`)

Carbon sends mail through **`@carbon/lib`** (`packages/lib/src/resend.server.ts`):

1. **SMTP (recommended for self-hosted)** — set **`MAIL_HOST`**, **`MAIL_USERNAME`**, **`MAIL_PASSWORD`**, and usually **`MAIL_PORT=587`**, **`MAIL_ENCRYPTION=tls`**. Set **`MAIL_FROM_ADDRESS`** and **`MAIL_FROM_NAME`** (optional **`APP_NAME`**; `MAIL_FROM_NAME` may contain `${APP_NAME}`).
2. **Resend** — if SMTP is **not** configured, set **`RESEND_API_KEY`** and **`RESEND_DOMAIN`** instead.

Use **`DISABLE_EMAIL=true`** only to disable all outbound email (e.g. maintenance).

### Redis (login rate limits, etc.)

**`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`** — required for routes that import `@carbon/kv` (e.g. login). Use [Upstash](https://upstash.com) or compatible REST API.

### Background jobs (optional)

**`TRIGGER_*`** — needed when features call Trigger.dev. Deploy workers separately (`packages/jobs`) per your Trigger.dev project.

### Supabase URL from inside the ERP container

If Supabase runs **on the host** (e.g. port `54321`), use:

`SUPABASE_URL=http://host.docker.internal:54321`

The compose file already sets `extra_hosts: host.docker.internal:host-gateway`. Copy keys from `supabase status`.

**Database consistency:** Prefer **one** Postgres: either the DB bundled with your Supabase stack, or this compose `postgres` service wired to Supabase (advanced). Avoid two unrelated databases.

---

## Deploy script

From **`deploy/selfhosted`** (after `.env` exists and Supabase/your API is up):

```bash
chmod +x deploy.sh
./deploy.sh
```

- **`./deploy.sh`** — build ERP image, `docker compose up -d`, wait for `/health`.
- **`./deploy.sh --no-build`** — restart without rebuilding (faster after the image exists).
- **`DEPLOY_ENV_FILE=/path/to/.env ./deploy.sh`** — alternate env file path.

You then **configure your reverse proxy** to `http://127.0.0.1:3000` (see below). The script does not configure TLS or DNS.

### Manual equivalent

```bash
docker compose --env-file .env build erp
docker compose --env-file .env up -d
curl -fsS http://127.0.0.1:3000/health
```

---

## Reverse proxy (manual)

ERP listens on **`0.0.0.0:3000`**. Terminate TLS on the proxy and forward to **`http://127.0.0.1:3000`**.

Example (Apache) — enable `ssl`, `proxy`, `proxy_http`, `headers`:

```apache
<VirtualHost *:443>
    ServerName carbon.example.com

    SSLEngine on
    SSLCertificateFile /path/to/fullchain.pem
    SSLCertificateKeyFile /path/to/privkey.pem

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "443"

    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/
</VirtualHost>
```

Add HTTP → HTTPS on port 80 as needed.

---

## Data persistence

Postgres data: Docker volume **`carbon_postgres_data`**. Back it up with your normal volume/DB backup process.

---

## Health check

```bash
curl -fsS http://127.0.0.1:3000/health
```

---

## Updates

After `git pull`:

```bash
./deploy.sh
# or
docker compose --env-file .env build --no-cache erp
docker compose --env-file .env up -d erp
```

Run database migrations through your usual process (Supabase CLI, CI, or `SUPABASE_DB_URL`); they are **not** run automatically by this compose file.
