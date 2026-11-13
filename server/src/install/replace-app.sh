#!/bin/bash
# Replaces WF Dashboard.app with a downloaded version (Contracts 39.4), run detached by the server from updates/:
#   replace-app.sh <app pid> <app path> <new app path> [NAME=VALUE ...]
# It waits for the running app to quit (its server has exited), moves the new app into place and opens it with the
# given environment (the port and data directory the app ran with). Output goes to logs/update.log
set -euo pipefail

pid=$1
app=$2
next=$3
shift 3
env_args=()
for pair in "$@"; do
  env_args+=(--env "$pair")
done

printf '[%s] waiting for the app (pid %s) to quit\n' "$(date -u +%FT%TZ)" "$pid"
while kill -0 "$pid" 2>/dev/null; do
  sleep 0.2
done
rm -rf "$app"
mv "$next" "$app"
printf '[%s] replaced %s; opening it\n' "$(date -u +%FT%TZ)" "$app"
# -n: a new instance of this copy, never another running copy with the same bundle id
open -n "${env_args[@]}" "$app"
