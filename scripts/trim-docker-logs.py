#!/usr/bin/env python3
"""Bound only Docker json-file logs; leave containers, images and volumes intact.

Uses copy/truncate semantics: retain a compressed 4 MiB tail before truncating
logs above 64 MiB. As with logrotate copytruncate, concurrent log lines are not
guaranteed lossless. Archives are root-only and one per container.
"""
import gzip
import os
import pathlib
import re
import stat


def trim_log(path, archive_dir, limit=64 * 1024 * 1024, tail_bytes=4 * 1024 * 1024):
    path = pathlib.Path(path)
    if not re.fullmatch(r"[a-f0-9]{64}-json\.log", path.name):
        return 0
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= limit:
            return 0
        os.lseek(fd, max(0, info.st_size - tail_bytes), os.SEEK_SET)
        tail = os.read(fd, tail_bytes)
        archive_dir = pathlib.Path(archive_dir)
        archive_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        archive = archive_dir / (path.name + ".tail.gz")
        temporary = archive.with_suffix(".tmp")
        with open(temporary, "wb") as target:
            os.chmod(temporary, 0o600)
            with gzip.GzipFile(fileobj=target, mode="wb") as compressed:
                compressed.write(tail)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, archive)
        os.ftruncate(fd, 0)
        return info.st_size
    finally:
        os.close(fd)


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("Docker log trimming requires root")
    for log in pathlib.Path("/var/lib/docker/containers").glob("*/*-json.log"):
        released = trim_log(log, "/var/log/agent-hub-log-tails")
        if released:
            print(f"Trimmed Docker json log {log.parent.name[:12]}: {released} bytes; compressed tail retained")
