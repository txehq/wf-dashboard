# SSH host check (Contracts 31.2), run by sh -s in the remote user's login shell; the arguments are the entry skill
# names of the workflows. Each item prints a line "@@wfd <item> <exit code>" followed by its output; the dashboard
# splits the items by these lines
item() {
  name=$1
  shift
  out=$("$@" 2>&1)
  rc=$?
  printf '@@wfd %s %s\n%s\n' "$name" "$rc" "$out"
}
tool() {
  p=$(command -v "$1" 2>/dev/null)
  if [ -z "$p" ]; then
    printf '@@wfd %s 127\n%s\n' "$1" "$1 is not on PATH: $PATH"
    return
  fi
  out=$("$p" "$2" 2>&1 | head -n 1)
  printf '@@wfd %s 0\n%s\n%s\n' "$1" "$p" "$out"
}
item uname uname -sm
item home printf '%s' "$HOME"
tool claude --version
tool codex --version
tool tmux -V
tool rsync --version
tool curl --version
tool orca --version
# Whether Orca's runtime is running (Contracts 35.6): with orca, print the output of orca status --json. The runtime
# is the ~/.orca that this machine's Orca app deployed over ssh and paired (remoteOrcaUserData in
# server/src/orca/cli.ts)
if command -v orca > /dev/null 2>&1; then
  item orca-status env ORCA_USER_DATA_PATH="$HOME/.orca" orca status --json
fi
for entry in "$@"; do
  if [ -f "$HOME/.claude/skills/$entry/SKILL.md" ]; then
    printf '@@wfd entry 0\n%s\n' "$entry"
  fi
done
