#!/bin/bash
# Uninstalls wf-dashboard (Contracts 39.3): stops and removes the LaunchAgent and app/; data/ stays. Run it as:
#   "$HOME/Library/Application Support/wf-dashboard/current/uninstall.sh"
# The install directory is the one holding this script's current/; the label comes from its install.env.
# WFD_INSTALL_ROOT and WFD_INSTALL_LABEL override both.
set -euo pipefail

main() {
  local root
  root="${WFD_INSTALL_ROOT:-$(cd -L "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -L)}"
  local label=""
  if [[ -f "$root/install.env" ]]; then
    # shellcheck source=/dev/null
    source "$root/install.env"
  fi
  label="${WFD_INSTALL_LABEL:-${label:-dev.engapp.wf-dashboard}}"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local domain
  domain="gui/$(id -u)"

  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    printf 'Stopping the service %s\n' "$label"
    launchctl bootout "$domain/$label"
  fi
  rm -f "$plist"
  rm -rf "$root/app" "$root/downloads"
  rm -f "$root/current" "$root/current.next" "$root/install.env"

  printf 'Removed the service %s (%s) and %s.\n' "$label" "$plist" "$root/app"
  printf 'Your data stays in %s; logs are in %s.\n' "$root/data" "$root/logs"
  if [[ -d "$root/txe-workflow" ]]; then
    printf 'The txe-workflow clone the install made stays in %s.\n' "$root/txe-workflow"
  fi
}

main "$@"
