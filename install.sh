#!/usr/bin/env bash

set -eu
set -o pipefail

REPOSITORY="archibate/agent-skills"
DEFAULT_REF="master"
REF="${AGENT_SKILLS_REF:-$DEFAULT_REF}"
BOOTSTRAP_TMP=""

die() {
    printf 'agent-skills: %s\n' "$*" >&2
    exit 1
}

# shellcheck disable=SC2329  # invoked through traps
cleanup() {
    if [ -n "$BOOTSTRAP_TMP" ] && [ -d "$BOOTSTRAP_TMP" ]; then
        rm -rf -- "$BOOTSTRAP_TMP"
    fi
}

trap cleanup EXIT HUP INT TERM

args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
    case "${args[$i]}" in
        --ref)
            i=$((i + 1))
            [ "$i" -lt "${#args[@]}" ] || die "--ref requires a value"
            REF="${args[$i]}"
            ;;
        --ref=*)
            REF="${args[$i]#--ref=}"
            ;;
    esac
    i=$((i + 1))
done

case "$REF" in
    ""|*..*|*[!A-Za-z0-9._/-]*) die "invalid ref: $REF" ;;
esac

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ "$SCRIPT_SOURCE" != "bash" ] && [ -f "$SCRIPT_SOURCE" ]; then
    SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$SCRIPT_SOURCE")" && pwd -P)
    if [ -x "$SCRIPT_DIR/installer/main.sh" ]; then
        exec "$SCRIPT_DIR/installer/main.sh" --source-root "$SCRIPT_DIR" "$@"
    fi
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

BOOTSTRAP_TMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-skills.XXXXXX") || die "cannot create a temporary directory"
ARCHIVE="$BOOTSTRAP_TMP/source.tar.gz"
ARCHIVE_URL="${AGENT_SKILLS_ARCHIVE_URL:-https://codeload.github.com/$REPOSITORY/tar.gz/$REF}"

printf 'Fetching %s@%s...\n' "$REPOSITORY" "$REF" >&2
if [ -n "${AGENT_SKILLS_ARCHIVE_URL:-}" ]; then
    curl -fsSL --retry 3 --retry-delay 1 -o "$ARCHIVE" "$ARCHIVE_URL"
else
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 -o "$ARCHIVE" "$ARCHIVE_URL"
fi

if ! tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
    case "$entry" in
        /*|../*|*/../*) exit 1 ;;
    esac
done; then
    die "archive contains an unsafe path"
fi

ARCHIVE_ROOT=$(tar -tzf "$ARCHIVE" | awk -F/ 'NR == 1 { print $1 }')
[ -n "$ARCHIVE_ROOT" ] || die "archive is empty"
tar -xzf "$ARCHIVE" -C "$BOOTSTRAP_TMP"
SOURCE_ROOT="$BOOTSTRAP_TMP/$ARCHIVE_ROOT"
[ -x "$SOURCE_ROOT/installer/main.sh" ] || die "archive does not contain installer/main.sh"
[ -f "$SOURCE_ROOT/installer/catalog.tsv" ] || die "archive does not contain installer/catalog.tsv"

set +e
"$SOURCE_ROOT/installer/main.sh" --source-root "$SOURCE_ROOT" "$@"
status=$?
set -e
exit "$status"
