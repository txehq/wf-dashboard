# The beginning of remote session files (title, start time and working directory are read from it, Contracts 31.6),
# run by sh -s; the arguments are the maximum bytes to read and the files. Two lines per file: "@@wfd <path>" and the
# beginning in base64
max=$1
shift
for f in "$@"; do
  printf '@@wfd %s\n' "$f"
  head -c "$max" "$f" | base64 | tr -d '\n'
  printf '\n'
done
