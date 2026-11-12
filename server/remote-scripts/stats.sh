# Size and modification time (seconds) of remote session files, run by sh -s; the argument is a directory (its *.jsonl
# are listed) or files after --. One line per file: "<bytes> <mtime> <path>"
stat_line() {
  size=$(wc -c < "$1" | tr -d ' ')
  mtime=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1")
  printf '%s %s %s\n' "$size" "$mtime" "$1"
}
if [ "$1" = "--" ]; then
  shift
  for f in "$@"; do [ -f "$f" ] && stat_line "$f"; done
else
  for f in "$1"/*.jsonl; do [ -f "$f" ] && stat_line "$f"; done
fi
exit 0
