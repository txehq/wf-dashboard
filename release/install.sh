#!/bin/bash
# Installs wf-dashboard @VERSION@ for this user (Contracts 39.3). Run it as:
#   gh release download --repo txehq/wf-dashboard --pattern install.sh --output - | bash
# It installs under ~/Library/Application Support/wf-dashboard/ (app/<version>/, current, data/), starts the LaunchAgent
# dev.engapp.wf-dashboard through your login shell, and serves http://127.0.0.1:7317.
# To try it beside another install, these override the defaults:
#   WFD_INSTALL_ROOT     the install directory
#   WFD_INSTALL_LABEL    the LaunchAgent label
#   WFD_INSTALL_PORT     the port
#   WFD_INSTALL_TARBALL  a local wf-dashboard-<version>-darwin-arm64.tar.gz instead of the Release asset
#   WFD_INSTALL_NO_OPEN  set to 1 to not open the browser
set -euo pipefail

main() {
  local version='@VERSION@'
  local repo=txehq/wf-dashboard
  local root="${WFD_INSTALL_ROOT:-$HOME/Library/Application Support/wf-dashboard}"
  local label="${WFD_INSTALL_LABEL:-dev.engapp.wf-dashboard}"
  local port="${WFD_INSTALL_PORT:-7317}"
  local tarball="${WFD_INSTALL_TARBALL:-}"
  local asset="wf-dashboard-$version-darwin-arm64.tar.gz"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local domain
  domain="gui/$(id -u)"
  local url="http://127.0.0.1:$port"
  local out

  say "Installing wf-dashboard $version into $root"

  # Platform and prerequisites (39.1): each failure shows the command's own output and how to fix it
  [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] ||
    fail "This package runs on macOS on Apple Silicon; this machine is $(uname -sm)." \
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
  # The service starts through your login shell, as a terminal does: it must find the same tools there
  out=$("$SHELL" -l -i -c 'for t in gh claude wf; do command -v "$t" >/dev/null || echo "wfd-missing: $t"; done' </dev/null 2>&1) ||
    fail "Your login shell $SHELL -l -i failed:"$'\n'"$out" "Fix the error in your shell configuration (~/.zshrc for zsh)."
  out=$(printf '%s\n' "$out" | sed -n 's/^wfd-missing: //p' | tr '\n' ' ')
  [[ -z "$out" ]] ||
    fail "Your login shell ($SHELL -l -i) does not find: $out" \
      "Add the directories of these commands to PATH in your shell configuration (~/.zshrc for zsh), then run the install again."

  # Reinstalling: stop this install's own service first, so its port is free again
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    say "Stopping the running service $label"
    launchctl bootout "$domain/$label"
    wait_port_free "$port"
  fi
  out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1) && {
    fail "Port $port is already in use:"$'\n'"$out" \
      "Stop the program listening on $port (for example a dashboard started from the repository with pnpm start), then run the install again."
  }

  # The package: app/<version>/ is extracted, checked with its own Node, and current points at it
  mkdir -p "$root/app" "$root/data" "$root/logs" "$root/downloads"
  if [[ -z "$tarball" ]]; then
    local downloads="$root/downloads/$version"
    rm -rf "$downloads"
    mkdir -p "$downloads"
    say "Downloading $asset"
    gh release download "v$version" --repo "$repo" --pattern "$asset" --dir "$downloads"
    tarball="$downloads/$asset"
  fi
  local staging="$root/app/.staging-$version"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tarball" -C "$staging" --strip-components 1
  out=$("$staging/bin/node" -p 'require(process.argv[1]).version' "$staging/release.json")
  [[ "$out" == "$version" ]] || fail "$tarball contains version $out, not $version." \
    "Download the matching package, or use the install.sh of version $out."
  say "Checking native modules with the bundled Node"
  "$staging/bin/node" "$staging/server/dist/install/check-native.js"
  rm -rf "$root/app/$version"
  mv "$staging" "$root/app/$version"
  ln -sfn "app/$version" "$root/current"
  rm -rf "$root/downloads"

  # txe-workflow: the service uses WFD_TXE_WORKFLOW or ~/Project/txe/txe-workflow; with neither, a clone next to data/
  local txe=""
  if [[ -z "${WFD_TXE_WORKFLOW:-}" && ! -d "$HOME/Project/txe/txe-workflow" ]]; then
    txe="$root/txe-workflow"
    if [[ ! -d "$txe/.git" ]]; then
      say "Cloning txehq/txe-workflow into $txe"
      gh repo clone txehq/txe-workflow "$txe"
    fi
  fi

  # The LaunchAgent: launchd reads no shell configuration, so the service runs inside your login shell
  local command
  command=$(printf 'exec env WFD_INSTALL_ROOT=%q WFD_DATA_DIR=%q WFD_PORT=%q' "$root" "$root/data" "$port")
  [[ -z "$txe" ]] || command+=$(printf ' WFD_TXE_WORKFLOW=%q' "$txe")
  command+=$(printf ' %q %q --web %q' "$root/current/bin/node" "$root/current/server/dist/main.js" "$root/current/web/dist")
  mkdir -p "$(dirname "$plist")"
  rm -f "$plist"
  plutil -create xml1 "$plist"
  plutil -insert Label -string "$label" "$plist"
  plutil -insert ProgramArguments -array "$plist"
  local i=0 arg
  for arg in "$SHELL" -l -i -c "$command"; do
    plutil -insert "ProgramArguments.$i" -string "$arg" "$plist"
    i=$((i + 1))
  done
  plutil -insert WorkingDirectory -string "$root/current/server" "$plist"
  plutil -insert RunAtLoad -bool true "$plist"
  plutil -insert KeepAlive -bool true "$plist"
  plutil -insert StandardOutPath -string "$root/logs/server.log" "$plist"
  plutil -insert StandardErrorPath -string "$root/logs/server.log" "$plist"
  printf 'label=%q\nport=%q\n' "$label" "$port" >"$root/install.env"
  launchctl bootstrap "$domain" "$plist"

  say "Waiting for the dashboard to answer on $url"
  local tries=0
  until curl -fsS --max-time 2 "$url/api/health" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if ((tries > 120)); then
      # A service that does not start is not left restarting in the background
      launchctl bootout "$domain/$label"
      fail "The service did not answer $url/api/health within 2 minutes and was stopped. Last lines of $root/logs/server.log:"$'\n'"$(tail -n 40 "$root/logs/server.log")" \
        "Fix the error above, then run the install again."
    fi
    sleep 1
  done

  say "wf-dashboard $version is running at $url"
  say "Data: $root/data"
  say "Logs: $root/logs/server.log"
  say "Uninstall: \"$root/current/uninstall.sh\""
  [[ "${WFD_INSTALL_NO_OPEN:-}" == 1 ]] || open "$url"
}

say() { printf '%s\n' "$1"; }

fail() {
  printf '\nwf-dashboard install failed: %s\n' "$1" >&2
  printf 'Fix: %s\n' "$2" >&2
  exit 1
}

wait_port_free() {
  local tries=0
  while lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; do
    tries=$((tries + 1))
    ((tries <= 30)) || fail "Port $1 is still in use 30 seconds after stopping the service:"$'\n'"$(lsof -nP -iTCP:"$1" -sTCP:LISTEN)" \
      "Stop the program listening on $1, then run the install again."
    sleep 1
  done
}

main "$@"
