# The Claude Code processes' session files under $1/.claude/sessions (Contracts 40.1): each one's contents on a line
# of its own (Claude Code writes them as one line of JSON), naming the session and the name other sessions know it by
dir="$1/.claude/sessions"
[ -d "$dir" ] || exit 0
for file in "$dir"/*.json; do
  [ -f "$file" ] || continue
  cat "$file"
  printf '\n'
done
