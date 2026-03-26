# Self-hosted Docker deployment (ERP)

## Location

- **`deploy/selfhosted/`** — `docker-compose.yml` (postgres + erp), `deploy.sh`, `README.md`, `.env.example`.

## Flow

1. Configure **`deploy/selfhosted/.env`** (not committed; copy from `.env.example`).
2. Run Supabase or compatible API on host/network; **`SUPABASE_URL`** from ERP container often uses `http://host.docker.internal:54321`.
3. Run **`./deploy.sh`** in `deploy/selfhosted` — builds ERP image, `docker compose up -d`, health check on port 3000.
4. Operator configures **reverse proxy manually** to `http://127.0.0.1:3000`.

## Email

- **`packages/lib/src/resend.server.ts`** — if **`MAIL_HOST`** + **`MAIL_USERNAME`** + **`MAIL_PASSWORD`** are set, **SMTP** (nodemailer) is used; else **Resend** when **`RESEND_API_KEY`** is set.
- **`packages/auth/src/services/verification.server.ts`** — uses **`MAIL_FROM_ADDRESS`** / **`MAIL_FROM_NAME`** when set for verification email `from`.

## Not in repo

- Root **`.env`** for local dev (gitignored).
- Production secrets in **`deploy/selfhosted/.env`** (gitignored).
