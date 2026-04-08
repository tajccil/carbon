#!/usr/bin/env bash
# Fix Docker failing to pull from public.ecr.aws (Supabase local) due to DNS timeouts
# on 127.0.0.53 (systemd-resolved).
#
# Important: `docker pull` uses the **host** resolver for the registry hostname — it does
# **not** use /etc/docker/daemon.json "dns" (that setting applies to **containers**). So we
# fix systemd-resolved with a drop-in, then refresh Docker + daemon.json.
#
# Usage:
#   sudo bash scripts/fix-docker-dns.sh
#   bash scripts/fix-docker-dns.sh   # may open polkit (pkexec) on desktop Linux
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/scripts/merge-docker-daemon-dns.py"
RESOLVED_DROPIN_SRC="$ROOT/deploy/systemd/resolved.conf.d/99-carbon-public-dns.conf"
RESOLVED_DROPIN_DST="/etc/systemd/resolved.conf.d/99-carbon-public-dns.conf"

if [[ "${EUID:-}" -ne 0 ]]; then
  # pkexec needs a controlling terminal; skip in CI/SSH without -t
  if [[ -t 0 ]] && command -v pkexec >/dev/null 2>&1; then
    echo "Requesting administrator privileges (pkexec)..."
    exec pkexec env DISPLAY="${DISPLAY:-}" bash "$0" "$@"
  fi
  echo "Administrator privileges required. From repo root run once:" >&2
  echo "  sudo bash scripts/fix-docker-dns.sh" >&2
  exit 1
fi

if [[ ! -f "$PY" ]]; then
  echo "Missing $PY" >&2
  exit 1
fi

if [[ ! -f "$RESOLVED_DROPIN_SRC" ]]; then
  echo "Missing $RESOLVED_DROPIN_SRC" >&2
  exit 1
fi

echo "==> Configuring systemd-resolved (fixes docker pull / public.ecr.aws lookup)"
install -d -m 0755 /etc/systemd/resolved.conf.d
install -m 0644 "$RESOLVED_DROPIN_SRC" "$RESOLVED_DROPIN_DST"
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  systemctl restart systemd-resolved
else
  echo "WARN: systemd-resolved not active; host DNS may still be broken." >&2
fi
sleep 2

echo "==> Merging container DNS into /etc/docker/daemon.json (optional but harmless)"
python3 "$PY"

echo "==> Restarting Docker..."
if systemctl is-active --quiet docker 2>/dev/null; then
  systemctl restart docker
else
  service docker restart 2>/dev/null || true
fi

echo "==> Verify (should print IP addresses, not timeout):"
getent ahosts public.ecr.aws 2>/dev/null | head -3 || true
echo ""
echo "Then: npm run db:start"
