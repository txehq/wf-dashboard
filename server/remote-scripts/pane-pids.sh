#!/bin/sh
# Boot time of this host and whether each of the given pids is running, for the Orca pane processes of Contracts 35.3
# (W117). A process recorded as started before the boot time cannot be the one holding that pid now.
# Usage: pane-pids.sh <pid>...
set -eu
PATH=/usr/sbin:/sbin:/usr/bin:/bin:$PATH
export PATH

if [ -r /proc/stat ]; then
  awk '/^btime /{print "boot " $2; exit}' /proc/stat
else
  # sysctl prints "{ sec = 1793623335, usec = 993164 } ..."; the first field after = is the boot second
  sysctl -n kern.boottime | awk -F'[=,]' '{gsub(/[^0-9]/, "", $2); print "boot " $2}'
fi

for pid in "$@"; do
  if ps -p "$pid" -o pid= >/dev/null 2>&1; then
    echo "alive $pid"
  else
    echo "gone $pid"
  fi
done
