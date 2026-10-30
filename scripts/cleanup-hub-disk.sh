#!/usr/bin/env bash
# Fixed allowlist only: journals, disposable package caches, Docker json logs.
# Never remove Hub state, credentials, task/command history, or rollback backups.
set -Eeuo pipefail

mode=${1:---dry-run}
if [[ $# -gt 1 || ( "$mode" != --apply && "$mode" != --dry-run ) ]]; then
  echo 'Usage: cleanup-hub-disk.sh [--dry-run|--apply]' >&2
  exit 2
fi

run() {
  printf 'cleanup:'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$mode" == --apply ]]; then "$@"; fi
}

if [[ "$mode" == --apply ]]; then
  [[ $EUID -eq 0 ]] || { echo 'Apply requires root.' >&2; exit 1; }
  exec 9>/run/lock/agent-hub-disk-cleanup.lock
  flock -n 9 || { echo 'Cleanup is already running.'; exit 0; }
fi

echo "Disk cleanup mode: $mode"
df -h /
run journalctl --rotate
run journalctl --vacuum-size=200M --vacuum-time=14d
if command -v dnf >/dev/null 2>&1; then
  run dnf clean all
fi
if [[ -f /usr/local/libexec/agent-hub/trim-docker-logs.py ]]; then
  run python3 /usr/local/libexec/agent-hub/trim-docker-logs.py
fi
df -h /
if [[ "$mode" == --apply ]]; then
  used=$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
  if (( used >= 85 )); then
    echo "Disk is still ${used}% full after allowlisted cleanup; inspect or expand storage. No business data was removed." >&2
    exit 1
  fi
fi
