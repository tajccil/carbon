#!/usr/bin/env python3
"""
Merge public DNS servers into /etc/docker/daemon.json for **containers**.

Note: `docker pull` / dockerd registry lookups use the **host** resolver (systemd-resolved),
not this file — use scripts/fix-docker-dns.sh which also installs systemd-resolved DNS.

Run with: sudo python3 scripts/merge-docker-daemon-dns.py
"""
from __future__ import annotations

import json
import os
import sys

DEFAULT_DNS = ("1.1.1.1", "8.8.8.8", "9.9.9.9")
PATH = "/etc/docker/daemon.json"


def main() -> int:
    if os.geteuid() != 0:
        print("Run with sudo.", file=sys.stderr)
        return 1

    data: dict = {}
    if os.path.exists(PATH):
        with open(PATH, encoding="utf-8") as f:
            data = json.load(f)

    dns = list(data.get("dns") or [])
    for d in DEFAULT_DNS:
        if d not in dns:
            dns.append(d)
    data["dns"] = dns

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"Updated {PATH} with dns: {dns}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
