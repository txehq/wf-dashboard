#!/bin/bash
# Installs WF Dashboard @VERSION@ for this user (Contracts 39.3). Run it as:
#   gh release download --repo txehq/wf-dashboard --pattern install.sh --output - | bash
# It puts WF Dashboard.app in /Applications and opens it; the app runs the dashboard on http://127.0.0.1:7317 with its
# data in ~/Library/Application Support/wf-dashboard/data/.
# To try it beside another install, these override the defaults:
#   WFD_INSTALL_APP        where the app goes
#   WFD_INSTALL_PORT       the port
#   WFD_INSTALL_DATA_DIR   the data directory (logs/, updates/ and the txe-workflow clone go next to it)
#   WFD_INSTALL_ZIP        a local WF-Dashboard-<version>-arm64.zip instead of the Release asset
#   WFD_INSTALL_OLD_LABEL  the LaunchAgent of a 0.1.0 install to remove
set -euo pipefail

main() {
  local version='@VERSION@'
  local repo=txehq/wf-dashboard
  local app="${WFD_INSTALL_APP:-/Applications/WF Dashboard.app}"
  local port="${WFD_INSTALL_PORT:-7317}"
  local data="${WFD_INSTALL_DATA_DIR:-$HOME/Library/Application Support/wf-dashboard/data}"
  local zip="${WFD_INSTALL_ZIP:-}"
  local old_label="${WFD_INSTALL_OLD_LABEL:-dev.engapp.wf-dashboard}"
  local root
  root=$(dirname "$data")
  local asset="WF-Dashboard-$version-arm64.zip"
  local url="http://127.0.0.1:$port"
  local out

  say "Installing WF Dashboard $version into $app"

  # Platform and prerequisites (39.1): each failure shows the command's own output and how to fix it
  [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] ||
    fail "WF Dashboard runs on macOS on Apple Silicon; this machine is $(uname -sm)." \
      "Install on a Mac with an Apple Silicon (M-series) chip."
  command -v gh >/dev/null ||
    fail "gh (GitHub CLI) is not on PATH." \
      "brew install gh && gh auth login --hostname github.com --git-protocol https --web"
  out=$(gh auth status 2>&1) ||
    fail "gh auth status failed:"$'\n'"$out" \
      "gh auth login --hostname github.com --git-protocol https --web"
  local login
  login=$(gh api user --jq .login 2>&1) || fail "gh api user failed:"$'\n'"$login" \
    "gh auth login --hostname github.com --git-protocol https --web"
  out=$(gh api user/memberships/orgs/txehq --jq .state 2>&1) || true
  [[ "$out" == active ]] ||
    fail "GitHub account $login is not an active member of txehq: $out" \
      "Ask a txehq admin to invite $login, accept the invitation at https://github.com/orgs/txehq/invitation, or log in with a member account: gh auth login --hostname github.com --web"
  out=$(claude --version 2>&1) ||
    fail "claude --version failed:"$'\n'"$out" \
      "Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash"
  out=$(wf --version 2>&1) ||
    fail "wf --version failed:"$'\n'"$out" \
      "Install the Magi workflow: follow the Install section of https://github.com/txehq/txe-workflow"
  # The app starts the server through your login shell, as a terminal does: it must find the same tools there
  out=$("$SHELL" -l -i -c 'for t in gh claude wf; do command -v "$t" >/dev/null || echo "wfd-missing: $t"; done' </dev/null 2>&1) ||
    fail "Your login shell $SHELL -l -i failed:"$'\n'"$out" "Fix the error in your shell configuration (~/.zshrc for zsh)."
  out=$(printf '%s\n' "$out" | sed -n 's/^wfd-missing: //p' | tr '\n' ' ')
  [[ -z "$out" ]] ||
    fail "Your login shell ($SHELL -l -i) does not find: $out" \
      "Add the directories of these commands to PATH in your shell configuration (~/.zshrc for zsh), then run the install again."

  # A 0.1.0 install (a LaunchAgent serving app/<version> through current) is stopped and removed; data/ stays
  local domain
  domain="gui/$(id -u)"
  if launchctl print "$domain/$old_label" >/dev/null 2>&1; then
    say "Stopping and removing the 0.1.0 service $old_label"
    launchctl bootout "$domain/$old_label"
  fi
  rm -f "$HOME/Library/LaunchAgents/$old_label.plist"
  rm -rf "$root/app" "$root/downloads" "$root/current" "$root/current.next" "$root/install.env"

  # Reinstalling: quit the app this install replaces, which stops its server
  quit_app "$app"
  out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1) && {
    fail "Port $port is already in use:"$'\n'"$out" \
      "Stop the program listening on $port (for example a dashboard started from the repository with pnpm start), then run the install again."
  }

  # The app: extracted next to the data, checked with its own Node, then moved into place
  mkdir -p "$data" "$root/logs"
  local staging="$root/updates/install-$version"
  rm -rf "$staging"
  mkdir -p "$staging"
  if [[ -z "$zip" ]]; then
    say "Downloading $asset"
    gh release download "v$version" --repo "$repo" --pattern "$asset" --dir "$staging"
    zip="$staging/$asset"
  fi
  ditto -x -k "$zip" "$staging"
  local package="$staging/WF Dashboard.app/Contents/Resources/server"
  out=$("$package/bin/node" -p 'require(process.argv[1]).version' "$package/release.json")
  [[ "$out" == "$version" ]] || fail "$zip contains version $out, not $version." \
    "Download the matching app, or use the install.sh of version $out."
  say "Checking native modules with the bundled Node"
  "$package/bin/node" "$package/server/dist/install/check-native.js"
  out=$({ mkdir -p "$(dirname "$app")" && rm -rf "$app" && mv "$staging/WF Dashboard.app" "$app"; } 2>&1) ||
    fail "Cannot put the app at $app:"$'\n'"$out" \
      "Make $(dirname "$app") writable for $(id -un) (an administrator can: sudo chown $(id -un) \"$(dirname "$app")\"), then run the install again."
  rm -rf "$staging"

  # txe-workflow: the server uses WFD_TXE_WORKFLOW or ~/Project/txe/txe-workflow; with neither, a clone next to data/
  if [[ -z "${WFD_TXE_WORKFLOW:-}" && ! -d "$HOME/Project/txe/txe-workflow" && ! -d "$root/txe-workflow/.git" ]]; then
    say "Cloning txehq/txe-workflow into $root/txe-workflow"
    gh repo clone txehq/txe-workflow "$root/txe-workflow"
  fi

  say "Opening $app"
  open --env "WFD_PORT=$port" --env "WFD_DATA_DIR=$data" "$app"
  local tries=0
  until curl -fsS --max-time 2 "$url/api/health" >/dev/null 2>&1; do
    tries=$((tries + 1))
    ((tries <= 120)) ||
      fail "WF Dashboard did not answer $url/api/health within 2 minutes. Its window shows the error; the last lines of $root/logs/server.log:"$'\n'"$(tail -n 40 "$root/logs/server.log" 2>&1)" \
        "Fix the error above, then open WF Dashboard again."
    sleep 1
  done

  say "WF Dashboard $version is running at $url"
  say "Data: $data"
  say "Logs: $root/logs"
  say "Uninstall: \"$app/Contents/Resources/uninstall.sh\""
}

say() { printf '%s\n' "$1"; }

fail() {
  printf '\nWF Dashboard install failed: %s\n' "$1" >&2
  printf 'Fix: %s\n' "$2" >&2
  exit 1
}

# Quits the app at the given path when it is running (it asks first when a run or an interactive process is running)
quit_app() {
  local pid
  pid=$(lsof -t "$1/Contents/MacOS/WF Dashboard" 2>/dev/null | head -n 1) || true
  [[ -n "$pid" ]] || return 0
  say "Quitting the running WF Dashboard"
  osascript -e "tell application \"$1\" to quit" >/dev/null
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
  done
}

main "$@"
