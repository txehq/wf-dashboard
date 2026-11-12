#!/bin/bash
# Uninstalls WF Dashboard (Contracts 39.3): quits the app (which stops its server), removes the login item and the app;
# data/ stays. Run it as:
#   "/Applications/WF Dashboard.app/Contents/Resources/uninstall.sh"
# The app is the one holding this script. WFD_INSTALL_PORT and WFD_INSTALL_DATA_DIR name the port and data directory of
# an install made with the same overrides.
set -euo pipefail

main() {
  local app
  app=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local port="${WFD_INSTALL_PORT:-7317}"
  local data="${WFD_INSTALL_DATA_DIR:-$HOME/Library/Application Support/wf-dashboard/data}"
  local root
  root=$(dirname "$data")
  local binary="$app/Contents/MacOS/WF Dashboard"
  local node="$app/Contents/Resources/server/bin/node"

  # The app quits after stopping its server; it asks first when a run or an interactive process is running
  local pid
  pid=$(lsof -t "$binary" 2>/dev/null | head -n 1) || true
  if [[ -n "$pid" ]]; then
    printf 'Quitting WF Dashboard\n'
    osascript -e "tell application \"$app\" to quit" >/dev/null
    while kill -0 "$pid" 2>/dev/null; do
      sleep 0.2
    done
  fi
  # A server of this app still listening (its app ended without stopping it)
  local listener
  for listener in $(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    if [[ "$(ps -o command= -p "$listener")" == "$node "* ]]; then
      printf 'Stopping the server (pid %s)\n' "$listener"
      kill "$listener"
      while kill -0 "$listener" 2>/dev/null; do
        sleep 0.2
      done
    fi
  done

  WFD_DATA_DIR="$data" "$binary" --unregister-login-item
  rm -rf "$app"

  printf 'Removed %s and its login item.\n' "$app"
  printf 'Your data stays in %s; logs are in %s.\n' "$data" "$root/logs"
  if [[ -d "$root/txe-workflow" ]]; then
    printf 'The txe-workflow clone the install made stays in %s.\n' "$root/txe-workflow"
  fi
}

main "$@"
