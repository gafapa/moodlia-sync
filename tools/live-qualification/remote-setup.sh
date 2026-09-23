#!/usr/bin/env bash
set -euo pipefail

lab_root=/opt/docker/stacks/moodlia-sync-qualification-20260922a
plugin_commit=117992c343c6397d8b14f1bee87bb7a43414333a

if [[ "$(realpath -m "$lab_root")" != /opt/docker/stacks/moodlia-sync-qualification-20260922a ]]; then
  echo 'Unexpected qualification path.' >&2
  exit 2
fi

# Abort on a shared host that cannot absorb four capped Moodle sites.
available_kib="$(awk '/MemAvailable/ { print $2 }' /proc/meminfo)"
if (( available_kib < 3 * 1024 * 1024 )); then
  echo "Only $((available_kib / 1024)) MiB of memory is available; at least 3072 MiB is required." >&2
  exit 4
fi

install -d -m 700 "$lab_root" "$lab_root/bootstrap" "$lab_root/results" "$lab_root/runner"
cd "$lab_root"

if [[ ! -d plugin/.git ]]; then
  git init -q plugin
  git -C plugin remote add origin https://github.com/gafapa/moodle-local_moodlia.git
fi
git -C plugin fetch -q --depth 1 origin "$plugin_commit"
git -C plugin checkout -q --detach FETCH_HEAD
if [[ "$(git -C plugin rev-parse HEAD)" != "$plugin_commit" ]]; then
  echo 'Unexpected plugin commit.' >&2
  exit 3
fi

if [[ ! -f .env ]]; then
  umask 077
  password="$(openssl rand -base64 36 | tr -dc A-Za-z0-9 | head -c 32)"
  printf 'MOODLE_ADMIN_PASSWORD=%s\n' "$password" > .env
fi

printf 'path=%s\nplugin_commit=%s\n' "$lab_root" "$plugin_commit" > ownership.txt
chmod 600 .env ownership.txt
echo 'qualification-directory-ready'
