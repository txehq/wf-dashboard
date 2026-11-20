# The Orca-related lines of the session records on this host (Contracts 40.1, 40.2), run by sh -s. $1 is HOME, $2 the
# record files read before, one per line as "<bytes> <lines> <path>". Every main record (a Claude Code project's
# <session>.jsonl, a Codex rollout in sessions/ or archived_sessions/) prints "@@file <engine> <bytes> <lines>
# <mtime> <path>". One that changed is followed by "@@meta {...}" with its cwd (and a rollout's id) when it is read
# from its first line, then by the complete lines it gained that hold one of the strings below
# (server/src/live/orca-sessions.ts parses the same ones). A subagent's record prints "@@agent <agent id> <session id>".
# The first read of a host returns tens of megabytes: the whole output goes gzipped, in base64
home=$1
known=$2

records() {
  if [ -d "$home/.claude/projects" ]; then
    find "$home/.claude/projects" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' | sed 's/^/claude /'
  fi
  for dir in "$home/.codex/sessions" "$home/.codex/archived_sessions"; do
    if [ -d "$dir" ]; then find "$dir" -type f -name 'rollout-*.jsonl' | sed 's/^/codex /'; fi
  done
}

# One record: its size, line count and modification time, and what it gained since it was read
record() {
  engine=$1
  file=$2
  size=$(wc -c < "$file" | tr -d ' ')
  mtime=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")
  before=$(printf '%s\n' "$known" | awk -v p="$file" '{ b = $1; l = $2; sub(/^[0-9]+ [0-9]+ /, ""); if ($0 == p) { print b, l; exit } }')
  if [ -z "$before" ]; then
    obytes=-1
    olines=0
  else
    obytes=${before% *}
    olines=${before#* }
  fi
  if [ "$size" = "$obytes" ]; then
    printf '@@file %s %s %s %s %s\n' "$engine" "$size" "$olines" "$mtime" "$file"
    return
  fi
  # A record that shrank was rewritten: read it from its first line again
  if [ "$size" -lt "$obytes" ]; then olines=0; fi
  lines=$(wc -l < "$file" | tr -d ' ')
  printf '@@file %s %s %s %s %s\n' "$engine" "$size" "$lines" "$mtime" "$file"
  if [ "$olines" -eq 0 ]; then
    if [ "$engine" = codex ]; then
      first=$(head -n 1 "$file")
      cwd=$(printf '%s\n' "$first" | grep -o '"cwd":"[^"]*"' | head -n 1)
      id=$(printf '%s\n' "$first" | grep -o '"id":"[^"]*"' | head -n 1)
    else
      cwd=$(grep -m 1 -o '"cwd":"[^"]*"' "$file" | head -n 1)
      id=''
    fi
    printf '@@meta {%s}\n' "$(printf '%s\n%s\n' "$cwd" "$id" | grep -v '^$' | paste -s -d, -)"
  fi
  tail -n +"$((olines + 1))" "$file" | head -n "$((lines - olines))" |
    grep -E -e '(ctx|run|task)_[0-9a-f]{8}' -e '--from term_' -e '"SendMessage"' || true
}

scan() {
  records | while read -r engine file; do record "$engine" "$file"; done
  if [ -d "$home/.claude/projects" ]; then
    find "$home/.claude/projects" -path '*/subagents/agent-*.jsonl' -type f | while read -r file; do
      agent=$(basename "$file" .jsonl)
      session=$(basename "$(dirname "$(dirname "$file")")")
      printf '@@agent %s %s\n' "${agent#agent-}" "$session"
    done
  fi
}

scan | gzip -c | base64 | tr -d '\n'
