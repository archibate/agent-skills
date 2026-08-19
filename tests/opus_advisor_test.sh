#!/usr/bin/env bash

set -eu
set -o pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/opus-advisor-test.XXXXXX")

cleanup() {
    rm -rf -- "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    awk -v needle="$2" 'index($0, needle) { found = 1 } END { exit !found }' "$1" ||
        fail "expected '$2' in $1"
}

assert_not_contains() {
    if awk -v needle="$2" 'index($0, needle) { found = 1 } END { exit !found }' "$1"; then
        fail "did not expect '$2' in $1"
    fi
}

assert_line() {
    awk -v needle="$2" '$0 == needle { found = 1 } END { exit !found }' "$1" ||
        fail "expected exact line '$2' in $1"
}

assert_not_line() {
    if awk -v needle="$2" '$0 == needle { found = 1 } END { exit !found }' "$1"; then
        fail "did not expect exact line '$2' in $1"
    fi
}

assert_arg_value() {
    awk -v flag="$2" -v expected="$3" '
        $0 == flag { getline; if ($0 == expected) found = 1 }
        END { exit !found }
        ' "$1" || fail "expected $2 argument '$3'"
}

fixture="$TEST_TMP/project"
mock_bin="$TEST_TMP/bin"
mkdir -p "$fixture" "$mock_bin"
git -C "$fixture" init -q

cat >"$mock_bin/claude" <<'MOCK'
#!/usr/bin/env bash
set -eu

printf '%s\n' "$PWD" >"$MOCK_CLAUDE_CWD"
printf '%s\n' "${TMPDIR:-}" >"$MOCK_CLAUDE_TMPDIR"
printf '%s\n' "$@" >"$MOCK_CLAUDE_ARGS"

while [ "$#" -gt 0 ]; do
    if [ "$1" = --settings ]; then
        shift
        printf '%s\n' "$1" >"$MOCK_CLAUDE_SETTINGS"
        break
    fi
    shift
done

case "${MOCK_CLAUDE_BEHAVIOR:-success}" in
    success)
        printf '%s\n' \
            '{"type":"system","subtype":"init","model":"mock-opus"}' \
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read"}]}}' \
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"mock read proof"}]}}' \
            '{"type":"result","is_error":false,"subtype":"success","permission_denials":[],"result":"mock advisory verdict"}'
        ;;
    denied) printf '%s\n' '{"type":"result","is_error":false,"subtype":"success","permission_denials":["Read(/blocked)"],"result":"partial verdict"}' ;;
    noresult) printf '%s\n' '{"type":"system","subtype":"init","model":"mock-opus"}' ;;
    emptyresult) printf '%s\n' '{"type":"result","is_error":false,"subtype":"success","permission_denials":[],"result":""}' ;;
    malicious)
        jq -cn --arg value "a[\$(touch $MOCK_CLAUDE_MARKER)]" \
            '{type:"system", subtype:"thinking_tokens", estimated_tokens:$value}'
        printf '%s\n' '{"type":"result","is_error":false,"subtype":"success","permission_denials":[],"result":"safe"}'
        ;;
    numeric_edge)
        printf '%s\n' \
            '{"type":"system","subtype":"thinking_tokens","estimated_tokens":-5}' \
            '{"type":"system","subtype":"thinking_tokens","estimated_tokens":1e30}' \
            '{"type":"result","is_error":false,"subtype":"success","permission_denials":[],"result":"safe"}'
        ;;
    network_fail)
        printf '%s\n' \
            '{"type":"system","subtype":"init","model":"mock-opus"}' \
            '{"type":"result","is_error":true,"subtype":"success","permission_denials":[],"result":"API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)"}'
        exit 1
        ;;
    fail) exit 7 ;;
    hang)
        trap 'exit 143' TERM
        while :; do sleep 1; done
        ;;
esac
MOCK
chmod +x "$mock_bin/claude"

args_file="$TEST_TMP/args"
cwd_file="$TEST_TMP/cwd"
tmpdir_file="$TEST_TMP/tmpdir"
settings_file="$TEST_TMP/settings"
export MOCK_CLAUDE_ARGS="$args_file"
export MOCK_CLAUDE_CWD="$cwd_file"
export MOCK_CLAUDE_TMPDIR="$tmpdir_file"
export MOCK_CLAUDE_SETTINGS="$settings_file"
export SURPRISE_SERVICE_TOKEN=secret-for-denylist-test

printf '1. successful advisory contract\n'
output=$(
    cd "$fixture"
    PATH="$mock_bin:$PATH" "$ROOT/skills/opus-advisor/scripts/ask-opus" review \
        'Inspect the fixture and return a verdict.' 2>"$TEST_TMP/progress.err"
)
[ "$output" = 'mock advisory verdict' ] || fail "unexpected launcher output: $output"
assert_contains "$TEST_TMP/progress.err" 'started mock-opus'
assert_contains "$TEST_TMP/progress.err" 'using Read'

for expected in --no-session-persistence --verbose; do
    assert_line "$args_file" "$expected"
done
assert_arg_value "$args_file" --model opus
assert_arg_value "$args_file" --effort max
assert_arg_value "$args_file" --permission-mode dontAsk
assert_arg_value "$args_file" --setting-sources ''
assert_arg_value "$args_file" --tools Read,Grep,Glob,Bash
assert_arg_value "$args_file" --allowedTools Read,Grep,Glob,Bash
assert_arg_value "$args_file" --output-format stream-json
for forbidden in --safe-mode --add-dir Edit Write; do
    assert_not_line "$args_file" "$forbidden"
done

scratch=$(cat "$cwd_file")
[ "$scratch" = "$(cat "$tmpdir_file")" ] || fail 'Claude cwd and TMPDIR differ'
case "$scratch" in
    "${TMPDIR:-/tmp}"/opus-advisor.*) ;;
    *) fail "unexpected scratch path: $scratch" ;;
esac
[ ! -e "$scratch" ] || fail 'scratch directory survived a successful run'

jq -e \
    --arg root "$fixture" \
    --arg git_common "$fixture/.git" \
    --arg scratch "$scratch" \
    --arg user_home "$HOME" '
    .sandbox.enabled == true and
    .sandbox.failIfUnavailable == true and
    .sandbox.autoAllowBashIfSandboxed == true and
    .sandbox.allowUnsandboxedCommands == false and
    (.sandbox.filesystem.allowWrite | index($scratch)) != null and
    (.sandbox.filesystem.denyWrite | index($root)) != null and
    (.sandbox.filesystem.denyWrite | index($git_common)) != null and
    (.sandbox.filesystem.denyWrite | index($user_home + "/.npm/_logs")) != null and
    (.sandbox.filesystem.denyWrite | index($user_home + "/.claude/debug")) != null and
    (.sandbox.filesystem.denyWrite | index("/tmp/claude")) != null and
    (.sandbox.filesystem | has("denyRead") | not) and
    .sandbox.network.strictAllowlist == true and
    .sandbox.network.allowedDomains == [] and
    (.sandbox.credentials.envVars | any(.name == "OFOX_API_KEY" and .mode == "deny")) and
    (.sandbox.credentials.envVars | any(.name == "SURPRISE_SERVICE_TOKEN" and .mode == "deny"))
    ' "$settings_file" >/dev/null || fail 'sandbox settings do not match the read-only contract'

assert_contains "$args_file" "Project root: $fixture"
assert_contains "$args_file" 'Inspect the fixture and return a verdict.'

printf '2. nested Claude guard\n'
set +e
CLAUDECODE=1 PATH="$mock_bin:$PATH" "$ROOT/skills/opus-advisor/scripts/ask-opus" review test \
    >"$TEST_TMP/nested.out" 2>"$TEST_TMP/nested.err"
status=$?
set -e
[ "$status" -eq 2 ] || fail "nested guard returned $status"
assert_contains "$TEST_TMP/nested.err" 'refusing to start a nested Claude Code session'

printf '3. invalid timeout\n'
set +e
OPUS_ADVISOR_TIMEOUT_SECONDS=nope PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" consult test \
    >"$TEST_TMP/invalid-timeout.out" 2>"$TEST_TMP/invalid-timeout.err"
status=$?
set -e
[ "$status" -eq 2 ] || fail "invalid timeout returned $status"
assert_contains "$TEST_TMP/invalid-timeout.err" 'must be a positive integer'

printf '4. bounded execution\n'
set +e
MOCK_CLAUDE_BEHAVIOR=hang OPUS_ADVISOR_TIMEOUT_SECONDS=1 PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" gate test \
    >"$TEST_TMP/timeout.out" 2>"$TEST_TMP/timeout.err"
status=$?
set -e
[ "$status" -eq 124 ] || fail "timeout returned $status"
assert_contains "$TEST_TMP/timeout.err" 'exceeded the 1-second timeout'
scratch=$(cat "$cwd_file")
[ ! -e "$scratch" ] || fail 'scratch directory survived a timeout'

printf '5. Claude failure propagation\n'
set +e
MOCK_CLAUDE_BEHAVIOR=fail PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" gate test \
    >"$TEST_TMP/failure.out" 2>"$TEST_TMP/failure.err"
status=$?
set -e
[ "$status" -eq 7 ] || fail "Claude failure returned $status"
assert_contains "$TEST_TMP/failure.err" 'Claude exited with status 7'

printf '6. actionable network failure\n'
set +e
MOCK_CLAUDE_BEHAVIOR=network_fail PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" consult test \
    >"$TEST_TMP/network.out" 2>"$TEST_TMP/network.err"
status=$?
set -e
[ "$status" -eq 1 ] || fail "network failure returned $status"
[ ! -s "$TEST_TMP/network.out" ] || fail 'network failure wrote an advisory result'
assert_contains "$TEST_TMP/network.err" 'Claude error: API Error:'
assert_contains "$TEST_TMP/network.err" 'Run ask-opus outside any active Codex sandbox'
assert_contains "$TEST_TMP/network.err" 'Claude exited with status 1'
scratch=$(cat "$cwd_file")
[ ! -e "$scratch" ] || fail 'scratch directory survived a network failure'

printf '7. permission denial propagation\n'
set +e
MOCK_CLAUDE_BEHAVIOR=denied PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" review test \
    >"$TEST_TMP/denied.out" 2>"$TEST_TMP/denied.err"
status=$?
set -e
[ "$status" -eq 1 ] || fail "permission denial returned $status"
assert_contains "$TEST_TMP/denied.err" 'permission_denials=["Read(/blocked)"]'

printf '8. missing result event\n'
set +e
MOCK_CLAUDE_BEHAVIOR=noresult PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" review test \
    >"$TEST_TMP/noresult.out" 2>"$TEST_TMP/noresult.err"
status=$?
set -e
[ "$status" -eq 1 ] || fail "missing result returned $status"
assert_contains "$TEST_TMP/noresult.err" 'invalid Claude response stream'

printf '9. nonnumeric progress is inert\n'
malicious_marker="$TEST_TMP/arithmetic-injection"
MOCK_CLAUDE_BEHAVIOR=malicious MOCK_CLAUDE_MARKER="$malicious_marker" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" review test >/dev/null 2>"$TEST_TMP/malicious.err"
[ ! -e "$malicious_marker" ] || fail 'stream progress executed arithmetic input'

printf '10. empty result rejection\n'
set +e
MOCK_CLAUDE_BEHAVIOR=emptyresult PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" review test \
    >"$TEST_TMP/empty.out" 2>"$TEST_TMP/empty.err"
status=$?
set -e
[ "$status" -eq 1 ] || fail "empty result returned $status"
assert_contains "$TEST_TMP/empty.err" 'invalid Claude response'

printf '11. numeric progress guard\n'
output=$(MOCK_CLAUDE_BEHAVIOR=numeric_edge PATH="$mock_bin:$PATH" \
    "$ROOT/skills/opus-advisor/scripts/ask-opus" review test 2>"$TEST_TMP/numeric.err")
[ "$output" = safe ] || fail "numeric edge returned unexpected output: $output"

printf 'All opus-advisor tests passed.\n'
