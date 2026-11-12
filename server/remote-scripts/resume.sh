# Resume of a remote session (Contracts 31.3, 14.5), run by sh -s. Arguments: mode (check, apply, apply-diverged), the
# remote session file, the target configuration's projects/<dir>, the session id. check prints what would happen:
# missing (no file), resume (the target already has this copy or an identical one), copy (none in the target), sync
# (the target's copy is its beginning), diverged (the copies diverged); sync and diverged are followed by two lines,
# the target path and its byte count. apply does it; apply-diverged first keeps the target's copy renamed to
# <id>.jsonl.diverged-<time>, then copies. The same-named directory of subagents and tool-results is copied along, and
# extra files in the target are kept
mode=$1 src=$2 dir=$3 id=$4
tgt="$dir/$id.jsonl"
srcdir="${src%.jsonl}"
action() {
  if [ ! -f "$src" ]; then echo missing; return; fi
  if [ "$src" = "$tgt" ]; then echo resume; return; fi
  if [ ! -f "$tgt" ]; then echo copy; return; fi
  if cmp -s "$src" "$tgt"; then echo resume; return; fi
  size=$(wc -c < "$tgt" | tr -d ' ')
  if head -c "$size" "$src" | cmp -s - "$tgt"; then printf 'sync\n%s\n%s\n' "$tgt" "$size"; return; fi
  printf 'diverged\n%s\n%s\n' "$tgt" "$size"
}
a=$(action)
case "$mode" in
  check) printf '%s\n' "$a"; exit 0 ;;
  apply) case "$a" in diverged*) echo "The copies diverged: $tgt" >&2; exit 1 ;; esac ;;
  apply-diverged) case "$a" in diverged*) mv "$tgt" "$tgt.diverged-$(date -u +%Y%m%dT%H%M%SZ)" ;; esac ;;
esac
case "$a" in
  missing) echo "Session file not found: $src" >&2; exit 1 ;;
  resume) ;;
  *)
    mkdir -p "$dir"
    cp "$src" "$tgt"
    if [ -d "$srcdir" ]; then mkdir -p "$dir/$id" && cp -R "$srcdir/." "$dir/$id/"; fi
    ;;
esac
printf '%s\n' "$tgt"
