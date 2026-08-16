#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
LAUNCHER="$ROOT/skills/opus-advisor/scripts/ask-opus"
REAL_CLAUDE=$(command -v claude || true)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/opus-advisor-smoke.XXXXXX")
READ_TOKEN="read-$RANDOM-$$"
BASH_TOKEN="bash-$RANDOM-$$"
SECRET_TOKEN="secret-$RANDOM-$$"
READ_FIXTURE="$TEST_TMP/read-token"
DENIED_PATH="$TEST_TMP/bash-write-must-fail"
DEFAULT_DENIED_PATH="$HOME/.npm/_logs/opus-advisor-probe-$RANDOM-$$"
STREAM_FILE="$TEST_TMP/response.ndjson"
EFFECTIVE_ARGS_FILE="$TEST_TMP/effective-args"

cleanup() {
    rm -f -- "$DEFAULT_DENIED_PATH"
    rm -rf -- "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

if [[ -z "$REAL_CLAUDE" || ! -x "$REAL_CLAUDE" ]]; then
    printf 'opus-advisor smoke test: claude is required\n' >&2
    exit 127
fi
for dependency in curl jq; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf 'opus-advisor smoke test: %s is required\n' "$dependency" >&2
        exit 127
    fi
done

mkdir -p "$TEST_TMP/bin"
printf '%s\n' "$READ_TOKEN" >"$READ_FIXTURE"

cat >"$TEST_TMP/bin/claude" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

args=("$@")
for ((i = 0; i < ${#args[@]}; ++i)); do
    case "${args[i]}" in
        --model) args[i + 1]=haiku ;;
        --effort) args[i + 1]=low ;;
    esac
done

printf '%s\n' "${args[@]}" >"${SMOKE_ARGS_FILE:?}"
"${REAL_CLAUDE:?}" "${args[@]}" | tee "${SMOKE_STREAM_FILE:?}"
SHIM
chmod +x "$TEST_TMP/bin/claude"

curl -sS --connect-timeout 3 --max-time 5 -o /dev/null https://example.com || {
    printf 'opus-advisor smoke test: host network control could not reach example.com\n' >&2
    exit 1
}

printf -v BASH_COMMAND_TO_TEST 'if : > %s 2>/dev/null; then write_blocked=0; else write_blocked=1; fi; if : > %s 2>/dev/null; then default_write_blocked=0; else default_write_blocked=1; fi; printf "%%s\\n" %s >"$TMPDIR/bash-proof"; bash_proof=$(cat "$TMPDIR/bash-proof"); if ! curl -fsS --connect-timeout 3 --max-time 5 https://example.com >/dev/null 2>&1; then network_blocked=1; else network_blocked=0; fi; if [[ -z ${OPUS_ADVISOR_BOUNDARY_SECRET+x} ]]; then credential_blocked=1; else credential_blocked=0; fi; printf "WRITE_BLOCKED=%%s\\nDEFAULT_WRITE_BLOCKED=%%s\\nBASH=%%s\\nNETWORK_BLOCKED=%%s\\nCREDENTIAL_BLOCKED=%%s\\n" "$write_blocked" "$default_write_blocked" "$bash_proof" "$network_blocked" "$credential_blocked"' \
    "$DENIED_PATH" "$DEFAULT_DENIED_PATH" "$BASH_TOKEN"
printf -v REQUEST '%s\n%s\n%s\n%s' \
    'Launcher smoke test. Perform both tool calls, then report that they finished.' \
    "Use Read, not Bash, to read: $READ_FIXTURE" \
    "Use Bash once to run exactly: $BASH_COMMAND_TO_TEST" \
    'Do not skip either tool call.'

set +e
OUTPUT=$(
    REAL_CLAUDE="$REAL_CLAUDE" \
        SMOKE_STREAM_FILE="$STREAM_FILE" \
        SMOKE_ARGS_FILE="$EFFECTIVE_ARGS_FILE" \
        OPUS_ADVISOR_BOUNDARY_SECRET="$SECRET_TOKEN" \
        OPUS_ADVISOR_TIMEOUT_SECONDS=${OPUS_ADVISOR_TIMEOUT_SECONDS:-90} \
        PATH="$TEST_TMP/bin:$PATH" \
        "$LAUNCHER" consult "$REQUEST"
)
STATUS=$?
set -e

if (( STATUS != 0 )); then
    printf 'opus-advisor smoke test: launcher exited with status %s\n' "$STATUS" >&2
    exit "$STATUS"
fi
if [[ -e "$DENIED_PATH" ]]; then
    printf 'opus-advisor smoke test: Bash wrote outside its scratch directory\n' >&2
    exit 1
fi
if [[ -e "$DEFAULT_DENIED_PATH" ]]; then
    printf 'opus-advisor smoke test: Bash wrote to a denied Claude default path\n' >&2
    exit 1
fi
if ! awk '
    $0 == "--model" { getline; model = ($0 == "haiku") }
    $0 == "--effort" { getline; effort = ($0 == "low") }
    END { exit !(model && effort) }
    ' "$EFFECTIVE_ARGS_FILE"; then
    printf 'opus-advisor smoke test: wrapper did not select Haiku at low effort\n' >&2
    exit 1
fi

if ! jq -se --arg read_token "$READ_TOKEN" --arg bash_token "$BASH_TOKEN" '
    ([.[] | select(.type == "assistant") | .message.content[]? |
      select(.type == "tool_use" and .name == "Read") | .id]) as $read_ids |
    ([.[] | select(.type == "assistant") | .message.content[]? |
      select(.type == "tool_use" and .name == "Bash") | .id]) as $bash_ids |
    any(.[];
        .type == "user" and
        any(.message.content[]?;
            .type == "tool_result" and
            ((.tool_use_id as $id | $read_ids | index($id)) != null) and
            (.content | tostring | contains($read_token)))) and
    any(.[];
        .type == "user" and
        any(.message.content[]?;
            .type == "tool_result" and .is_error == false and
            ((.tool_use_id as $id | $bash_ids | index($id)) != null) and
            (.content | tostring | contains("WRITE_BLOCKED=1")) and
            (.content | tostring | contains("DEFAULT_WRITE_BLOCKED=1")) and
            (.content | tostring | contains("BASH=" + $bash_token)) and
            (.content | tostring | contains("NETWORK_BLOCKED=1")) and
            (.content | tostring | contains("CREDENTIAL_BLOCKED=1"))))
    ' "$STREAM_FILE" >/dev/null; then
    printf 'opus-advisor smoke test: tool evidence did not prove the security boundary\n%s\n' "$OUTPUT" >&2
    exit 1
fi

printf 'opus-advisor smoke test passed (Haiku/low): native Read, scratch-only Bash, blocked Bash network and credentials\n'
