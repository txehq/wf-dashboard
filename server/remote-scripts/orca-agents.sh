# Every agent running in an Orca terminal on this machine (Contracts 40.2): the claude or codex processes ($1) whose
# environment carries ORCA_TERMINAL_HANDLE. Each one prints a line "agent <pid> <handle>"; for claude it is followed by
# "@@session" and the contents of $2/.claude/sessions/<pid>.json ($2 is the HOME of the local configuration, holding
# the sessionId), for codex by "rollout <path>" (the rollout file the process has open). Prints nothing when none runs
engine=$1
home=$2
pids=$(pgrep -x "$engine" | tr '\n' ' ')
[ -n "$pids" ] || exit 0
# shellcheck disable=SC2086
ps -E -ww -o pid= -o command= -p "$(echo $pids | tr ' ' ',')" |
  awk '{ for (i = 2; i <= NF; i++) if ($i ~ /^ORCA_TERMINAL_HANDLE=/) { print $1, substr($i, 22); break } }' |
  while read -r pid handle; do
    printf 'agent %s %s\n' "$pid" "$handle"
    if [ "$engine" = claude ]; then
      file="$home/.claude/sessions/$pid.json"
      if [ -f "$file" ]; then
        printf '@@session\n'
        cat "$file"
        printf '\n'
      fi
    else
      lsof -p "$pid" -Fn 2> /dev/null | sed -n 's/^n\(.*\/sessions\/.*\/rollout-.*\.jsonl\)$/rollout \1/p'
    fi
  done
