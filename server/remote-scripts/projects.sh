# The second column of the Sessions import (Contracts 31.6): the session count of each project directory under the
# remote Claude Code projects directory and its newest session file (the dashboard reads the working directory from
# its beginning), run by sh -s; the argument is the projects directory. Two lines per project:
# "@@wfd <session count> <dir>" and the newest file
dir=$1
[ -d "$dir" ] || exit 0
for d in "$dir"/*/; do
  [ -d "$d" ] || continue
  d=${d%/}
  n=$(find "$d" -maxdepth 1 -type f -name '*.jsonl' | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] || continue
  newest=$(ls -t "$d"/*.jsonl | head -n 1)
  printf '@@wfd %s %s\n%s\n' "$n" "$d" "$newest"
done
