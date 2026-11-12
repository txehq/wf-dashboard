# Create a folder in a remote directory (POST /api/ssh-hosts/:id/dirs of Contracts 34.1), run by sh -s; the arguments
# are the parent directory and the name. Not recursive. Prints the new folder's absolute path on success; when it
# already exists, prints its absolute path and exits 3; failures of cd and mkdir fail with their output
cd -- "$1" || exit 1
base=$(pwd)
case "$base" in
  /) target="/$2" ;;
  *) target="$base/$2" ;;
esac
if [ -e "$2" ] || [ -L "$2" ]; then
  printf '%s\n' "$target"
  exit 3
fi
mkdir -- "$2" || exit 1
printf '%s\n' "$target"
