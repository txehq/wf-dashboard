# List remote Codex rollouts with their first line (session_meta, with id and cwd), run by sh -s; the arguments are
# directories under CODEX_HOME (sessions, archived_sessions). Each rollout prints three lines: the path, the first
# line (empty while it is not completely written), an empty line
for dir in "$@"; do
  [ -d "$dir" ] || continue
  find "$dir" -type f -name 'rollout-*.jsonl' | while IFS= read -r f; do
    first=''
    if [ "$(head -n 1 "$f" | wc -l)" -eq 1 ]; then first=$(head -n 1 "$f"); fi
    printf '%s\n%s\n\n' "$f" "$first"
  done
done
