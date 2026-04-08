# Self-hosted ERP (Docker, production)

See the repository overview in **`docs/DEPLOYMENT.md`**.

Run the Carbon **ERP** container with a local **Postgres** volume, bind **port 3000**, and supply secrets via **`.env`**. This path does **not** use AWS/SST; you operate Docker and your own reverse proxy.

## What you run

| Piece | Role |
|--------|------|
| **`docker-compose.yml`** | `postgres` (persistent volume) + `erp` (built from `apps/erp/Dockerfile`) on network **`carbon_selfhosted`**; only **`erp` port 3000** is published to the host (Postgres is internal). |
| **`docker-compose.supabase-network.yml`** (optional) | Merges with the file above so **`erp`** also joins your Supabase CLI Docker network — use **`SUPABASE_SERVER_URL=http://<kong-container>:8000`** (see comments in that file). |
| **Supabase-compatible API** | Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. The app uses `@supabase/supabase-js`; plain Postgres alone is not enough. Typical setup: **Supabase on the host** (`supabase start`) or [self-hosted Supabase Docker](https://supabase.com/docs/guides/self-hosting/docker). |
| **Reverse proxy** | **You configure manually** (Apache, nginx, Caddy, etc.) — TLS and domain. Forward to `http://127.0.0.1:3000`. |

### `supabase start` fails pulling from `public.ecr.aws` (DNS timeout on `127.0.0.53`)

**`docker pull`** uses the **host** DNS stack (systemd-resolved at `127.0.0.53`). The **`dns`** field in **`/etc/docker/daemon.json`** applies to **containers**, not to the daemon’s registry lookups — so fixing only `daemon.json` often **does not** stop `lookup public.ecr.aws on 127.0.0.53` during pulls.

From the **repo root**, run the full fix (systemd-resolved drop-in + daemon.json merge + restarts):

```bash
sudo npm run fix:docker-dns
# or: sudo bash scripts/fix-docker-dns.sh
```

That installs **`deploy/systemd/resolved.conf.d/99-carbon-public-dns.conf`**, restarts **`systemd-resolved`**, merges **`/etc/docker/daemon.json`**, and restarts Docker. Then **`npm run db:start`** again.

**Manual equivalent:**

```bash
sudo cp deploy/systemd/resolved.conf.d/99-carbon-public-dns.conf /etc/systemd/resolved.conf.d/
sudo systemctl restart systemd-resolved
sudo bash scripts/fix-docker-dns.sh
```

**If you cannot fix DNS:** use [hosted Supabase](https://supabase.com/dashboard) and set **`SUPABASE_URL`**, **`SUPABASE_SERVER_URL`**, and keys in **`deploy/selfhosted/.env`** to your project URL (no local `supabase start`).

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

**Account creation** uses the **Supabase Auth HTTP API** (`auth.admin.createUser`), not a direct TCP connection to the compose `postgres` service. If signup fails, fix **`SUPABASE_URL` / `SUPABASE_SERVER_URL`** and connectivity to Kong first. **`SUPABASE_DB_URL`** must also be reachable from the **ERP** container (not `127.0.0.1` unless that truly resolves to Supabase’s Postgres from inside Docker — prefer `host.docker.internal` or the DB container hostname on a shared network).

**Optional — Supabase in Docker on the same host:** after `supabase start`, attach ERP to the Supabase network and point the server at Kong:

```bash
docker compose -f docker-compose.yml -f docker-compose.supabase-network.yml up -d
```

Set **`SUPABASE_SERVER_URL=http://supabase_kong_carbon-database:8000`** (confirm the Kong container name with `docker ps`). Adjust **`docker-compose.supabase-network.yml`** if your Supabase project uses a different network name (`docker network ls`).

### “Failed to create user account” / `ECONNREFUSED` after email OTP

Server-side signup calls Supabase Auth (`auth.admin.createUser`) using **`getSupabaseClientUrl()`** in `@carbon/auth`. Typical causes:

1. **`SUPABASE_URL` still uses `http://127.0.0.1:54321` or `localhost`** — Inside the ERP container that points at the container itself, not the host. Prefer `http://host.docker.internal:54321` in **`deploy/selfhosted/.env`**, or set **`SUPABASE_SERVER_URL=http://host.docker.internal:54321`** explicitly (server-only; `SUPABASE_URL` can stay as the browser-facing URL).

2. **Supabase API listens only on `127.0.0.1` on the host** — Traffic from Docker arrives on the bridge IP, not loopback, so the connection can be **refused** even with `host.docker.internal`. Fix one of:
   - Use a **hosted** Supabase project and set `SUPABASE_URL` / `SUPABASE_SERVER_URL` to `https://<project>.supabase.co`.
   - Or adjust local Supabase so the gateway accepts connections from the Docker bridge (see [Supabase CLI config](https://supabase.com/docs/guides/local-development/cli/config) — expose/bind the API appropriately for your OS), or run the **official Supabase Docker stack** on the same Docker network as ERP.

3. **Rebuild the ERP image** after changing `@carbon/auth` or env — `docker compose build erp && docker compose up -d erp`.

**Sanity check from the host** (Supabase up, keys loaded):

```bash
docker compose --env-file .env exec erp curl -fsS "http://host.docker.internal:54321/auth/v1/health"
```

You should get JSON, not “Connection refused”. Apache/nginx in front of **ERP** (port 3000) does not affect this outbound call.

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

### Postgres container unhealthy

1. **Logs** — `docker compose --env-file .env logs postgres` (from `deploy/selfhosted`). Look for auth errors, disk full, or “database files are incompatible”.
2. **First boot** — An empty volume needs time to init; the compose file uses a **`start_period`** so health checks do not fail immediately.
3. **Password / volume mismatch** — If you **changed `POSTGRES_PASSWORD`** after Postgres already initialized the volume, the old data no longer matches. Either restore the old password or **reset the volume** (destroys data):

   ```bash
   docker compose --env-file .env down
   docker volume ls | grep carbon_postgres   # note the full name, e.g. deploy_selfhosted_carbon_postgres_data
   docker volume rm <that_name>
   docker compose --env-file .env up -d
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
