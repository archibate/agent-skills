#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
command=$(jq -r '.tool_input.command // ""' <<<"$input")

[ -z "$command" ] && exit 0

if grep -qF 'BYPASS_SLEEP_BABYSIT_CHECK' <<<"$command"; then
    exit 0
fi

# Normalize newlines/spaces
normalized=$(echo "$command" | tr '\n' ' ' | tr -s ' ')

# Detect: sleep N (&&|;|||) babysit (log|status|wait|list)
if ! echo "$normalized" | grep -qE 'sleep[[:space:]]+[0-9]+[[:space:]]*(&&|;|\|\|)[[:space:]]*babysit[[:space:]]+(log|status|wait|list)\b'; then
    exit 0
fi

# Pull the task name if present (--name=foo or --name foo)
name=$(echo "$normalized" | grep -oE -- '--name[= ][^ ]+' | head -1 | sed -E 's/^--name[= ]//; s/^["'\''"]//; s/["'\''"]$//' || true)

{
    printf 'Blocked: sleeping to poll babysit task status is an anti-pattern.\n'
    printf 'babysit tasks notify you on terminal status via <task-notification>.\n\n'
    if [ -n "$name" ]; then
        printf 'To get notified when "%s" finishes:\n' "$name"
        printf '  Bash(command: "babysit wait --name=%s", run_in_background: true)\n\n' "$name"
        printf 'To stream its log live:\n'
        printf '  Bash(command: "babysit log --follow --name=%s", run_in_background: true)\n' "$name"
    else
        printf 'To get notified on completion:\n'
        printf '  Bash(command: "babysit wait --name=<task>", run_in_background: true)\n'
    fi
    printf '\nIf you really must sleep+poll, add comment `BYPASS_SLEEP_BABYSIT_CHECK` to the command.\n'
} >&2

exit 2
