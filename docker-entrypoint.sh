#!/bin/sh
# Runs the app as an unprivileged user (PUID:PGID, 1000:1000 by default).
#
# Started as root, the default, it first hands the folders the app writes to that
# user, since older images ran as root and left root-owned files there. Started
# with --user (or user: in compose), it runs the app as that user directly, and
# those folders must already be writable by it.
set -e

if [ "$(id -u)" = "0" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    for dir in "${NOTES_DIR:-/app/data}" "${PLUGINS_DIR:-/app/plugins}"; do
        mkdir -p "$dir"
        # Only what isn't theirs yet, so a big vault isn't rewritten on every start.
        # A read-only mount or a root-squashed NFS share can't be changed: say so and go on.
        find "$dir" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null \
            || echo "warning: could not give $dir to $PUID:$PGID; the app may not be able to write there" >&2
    done
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
fi

exec "$@"
