#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo 'Install requires root.' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v journalctl >/dev/null
command -v flock >/dev/null
install -m 0755 "$root/scripts/cleanup-hub-disk.sh" /usr/local/sbin/agent-hub-disk-cleanup
install -d /usr/local/libexec/agent-hub
install -m 0755 "$root/scripts/trim-docker-logs.py" /usr/local/libexec/agent-hub/trim-docker-logs.py
install -m 0644 "$root/ops/agent-hub-disk-cleanup.service" /etc/systemd/system/
install -m 0644 "$root/ops/agent-hub-disk-cleanup.timer" /etc/systemd/system/
install -d /etc/systemd/journald.conf.d
install -m 0644 "$root/ops/agent-hub-journald.conf" /etc/systemd/journald.conf.d/agent-hub.conf
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now agent-hub-disk-cleanup.timer
systemctl start agent-hub-disk-cleanup.service
systemctl list-timers agent-hub-disk-cleanup.timer --no-pager
