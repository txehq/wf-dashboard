#!/bin/bash
# Uninstalls WF Dashboard (Contracts 39.3): quits the app (which stops its server), removes the login item (the app in
# /Applications only; a copy elsewhere never set it) and the app; data/ stays. Run it as:
#   "/Applications/WF Dashboard.app/Contents/Resources/uninstall.sh"
# The app is the one holding this script. It finds the app's server by the bundled node binary and the data directory
# from the app, which remembers the one it ran with; WFD_INSTALL_DATA_DIR names another data directory.
set -euo pipefail

main() {
  local app
  app=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local binary="$app/Contents/MacOS/WF Dashboard"
  local node="$app/Contents/Resources/server/bin/node"

  # The app quits after stopping its server; it asks first when a run or an interactive process is running. SIGTERM
  # reaches this copy only: an Apple event to the app's path can reach another copy with the same bundle id
  local pid
  pid=$(lsof -t "$binary" 2>/dev/null | head -n 1) || true
  if [[ -n "$pid" ]]; then
    printf 'Quitting WF Dashboard\n'
    kill "$pid"
    while kill -0 "$pid" 2>/dev/null; do
      sleep 0.2
    done
  fi
  # A server of this app still running (its app ended without stopping it)
  local server
  for server in $(lsof -t "$node" 2>/dev/null || true); do
    printf 'Stopping the server (pid %s)\n' "$server"
    kill "$server"
    while kill -0 "$server" 2>/dev/null; do
      sleep 0.2
    done
  done

  # The app prints the data directory it uses as its last line
  local data
  if [[ -n "${WFD_INSTALL_DATA_DIR:-}" ]]; then
    data=$(WFD_DATA_DIR="$WFD_INSTALL_DATA_DIR" "$binary" --unregister-login-item | tail -n 1)
  else
    data=$("$binary" --unregister-login-item | tail -n 1)
  fi
  local root
  root=$(dirname "$data")
  rm -rf "$app"

  printf 'Removed %s.\n' "$app"
  printf 'Your data stays in %s; logs are in %s.\n' "$data" "$root/logs"
  if [[ -d "$root/txe-workflow" ]]; then
    printf 'The txe-workflow clone the install made stays in %s.\n' "$root/txe-workflow"
  fi
}

main "$@"
