# The agent running in an Orca terminal (Contracts 35.3): find claude or codex processes ($2) whose environment has
# ORCA_TERMINAL_HANDLE set to $1, on this machine (macOS) and on SSH hosts (Linux). Each process found prints a line
# "pid <pid>"; for claude it is followed by "@@session" and the contents of $3/.claude/sessions/<pid>.json ($3 is the
# HOME of the local configuration, holding the sessionId), for codex by "rollout <path>" (the rollout file the process
# has open). Prints nothing when none is found
handle=$1
engine=$2
home=$3
pids=$(pgrep -x "$engine" | tr '\n' ' ')
[ -n "$pids" ] || exit 0
# The processes whose environment carries the handle. Linux reads each one's environ; macOS lists every candidate's
# environment with one ps, whose cost would otherwise grow with the number of agents on the machine
matching() {
  if [ -d /proc ] && [ -r "/proc/self/environ" ]; then
    for pid in $pids; do
      tr '\0' '\n' < "/proc/$pid/environ" 2> /dev/null | grep -qx "ORCA_TERMINAL_HANDLE=$handle" && echo "$pid"
    done
  else
    # shellcheck disable=SC2086
    ps -E -ww -o pid= -o command= -p "$(echo $pids | tr ' ' ',')" |
      awk -v want="ORCA_TERMINAL_HANDLE=$handle" '{ for (i = 2; i <= NF; i++) if ($i == want) { print $1; break } }'
  fi
}
for pid in $(matching); do
  printf 'pid %s\n' "$pid"
  if [ "$engine" = claude ]; then
    file="$home/.claude/sessions/$pid.json"
    if [ -f "$file" ]; then
      printf '@@session\n'
      cat "$file"
      printf '\n'
    fi
  elif [ -d "/proc/$pid/fd" ]; then
    for fd in /proc/"$pid"/fd/*; do
      target=$(readlink "$fd")
      case "$target" in */sessions/*/rollout-*.jsonl) printf 'rollout %s\n' "$target" ;; esac
    done
  else
    lsof -p "$pid" -Fn 2> /dev/null | sed -n 's/^n\(.*\/sessions\/.*\/rollout-.*\.jsonl\)$/rollout \1/p'
  fi
done
