# List the subdirectories of a remote directory (GET /api/ssh-hosts/:id/dirs of Contracts 31.1), run by sh -s; the
# argument is the directory, $HOME when empty. The first line is the resolved absolute path, then one subdirectory name
# per line; a missing directory fails with cd's output
dir=${1:-$HOME}
cd -- "$dir" || exit 1
pwd
find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||'
