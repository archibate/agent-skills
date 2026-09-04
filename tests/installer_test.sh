#!/usr/bin/env bash

set -eu
set -o pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/agent-skills-test.XXXXXX")

cleanup() {
    rm -rf -- "$TEST_TMP"
}
trap cleanup EXIT HUP INT TERM

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_file() {
    [ -f "$1" ] || fail "expected file: $1"
}

assert_dir() {
    [ -d "$1" ] || fail "expected directory: $1"
}

assert_link() {
    [ -L "$1" ] || fail "expected symbolic link: $1"
}

assert_not_link() {
    [ ! -L "$1" ] || fail "expected copied content, found symbolic link: $1"
}

assert_link_target() {
    assert_link "$1"
    [ "$(readlink "$1")" = "$2" ] || fail "expected $1 to link to $2"
}

assert_contains() {
    awk -v needle="$2" 'index($0, needle) { found = 1 } END { exit !found }' "$1" ||
        fail "expected '$2' in $1"
}

new_case() {
    CASE_ROOT="$TEST_TMP/$1"
    CASE_HOME="$CASE_ROOT/home"
    CASE_STATE="$CASE_ROOT/state"
    mkdir -p "$CASE_HOME" "$CASE_STATE"
}

run_installer() {
    HOME="$CASE_HOME" XDG_STATE_HOME="$CASE_STATE" NO_COLOR=1 \
        "$ROOT/installer/main.sh" --source-root "$ROOT" "$@"
}

printf '1. catalog validation\n'
NO_COLOR=1 "$ROOT/installer/main.sh" --source-root "$ROOT" --validate >/dev/null

printf '2. core profile and target layout\n'
new_case core
run_installer --profile core --targets codex,claude --yes --skip-deps >/dev/null
assert_file "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"
assert_file "$CASE_HOME/.agents/skills/cpp-hpc-optimization/SKILL.md"
assert_file "$CASE_HOME/.agents/skills/artifact-restraint/SKILL.md"
assert_file "$CASE_HOME/.claude/skills/cpp-oop-style/SKILL.md"
assert_file "$CASE_HOME/.claude/skills/cpp-hpc-optimization/SKILL.md"
assert_file "$CASE_HOME/.claude/skills/artifact-restraint/SKILL.md"
assert_file "$CASE_HOME/.codex/AGENTS.md"
assert_file "$CASE_HOME/.claude/CLAUDE.md"
assert_link_target "$CASE_HOME/.agents/skills/cpp-oop-style" "$ROOT/skills/cpp-oop-style"
assert_link_target "$CASE_HOME/.claude/skills/cpp-hpc-optimization" "$ROOT/skills/cpp-hpc-optimization"
assert_link_target "$CASE_HOME/.agents/skills/artifact-restraint" "$ROOT/skills/artifact-restraint"
assert_contains "$CASE_HOME/.codex/AGENTS.md" '<!-- archibate/agent-skills:begin -->'
assert_contains "$CASE_HOME/.codex/AGENTS.md" '<!-- archibate/agent-skills:end -->'

printf '3. hard dependency closure\n'
new_case closure
run_installer --skills cpp-hpc-optimization --targets codex --yes --skip-deps >/dev/null
assert_dir "$CASE_HOME/.agents/skills/cpp-hpc-optimization"
assert_dir "$CASE_HOME/.agents/skills/cpp-oop-style"
[ ! -e "$CASE_HOME/.codex/AGENTS.md" ] || fail "explicit skill selection unexpectedly installed guidance"

printf '4. managed guidance merge and idempotency\n'
new_case guidance
mkdir -p "$CASE_HOME/.codex"
printf '%s\n' '# Existing personal guidance' > "$CASE_HOME/.codex/AGENTS.md"
run_installer --skills agent-rules --targets codex --yes --skip-deps >/dev/null
assert_contains "$CASE_HOME/.codex/AGENTS.md" '# Existing personal guidance'
assert_contains "$CASE_HOME/.codex/AGENTS.md" '# Agent Behavior Rules'
before=$(cksum "$CASE_HOME/.codex/AGENTS.md")
run_installer --skills agent-rules --targets codex --yes --skip-deps >/dev/null
after=$(cksum "$CASE_HOME/.codex/AGENTS.md")
[ "$before" = "$after" ] || fail "idempotent guidance rerun changed the file"

printf '5. modified skill backup\n'
new_case backup
run_installer --skills cpp-oop-style --targets codex --yes --skip-deps --install-mode copy >/dev/null
assert_not_link "$CASE_HOME/.agents/skills/cpp-oop-style"
printf '%s\n' 'local user edit' >> "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"
run_installer --skills cpp-oop-style --targets codex --yes --skip-deps --install-mode copy >/dev/null
if awk 'index($0, "local user edit") { found = 1 } END { exit !found }' \
    "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"; then
    fail "updated skill retained a local edit instead of restoring source content"
fi
backup_file=""
for candidate in "$CASE_STATE"/archibate-agent-skills/backups/*/*/SKILL.md; do
    [ -f "$candidate" ] && backup_file=$candidate
done
[ -n "$backup_file" ] || fail "modified skill was not backed up"
assert_contains "$backup_file" 'local user edit'

printf '6. malformed managed block stays untouched\n'
new_case malformed
mkdir -p "$CASE_HOME/.config/opencode"
printf '%s\n' 'keep this' '<!-- archibate/agent-skills:begin -->' > "$CASE_HOME/.config/opencode/AGENTS.md"
set +e
run_installer --skills agent-rules --targets opencode --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "malformed marker run returned $status instead of 2"
[ "$(wc -l < "$CASE_HOME/.config/opencode/AGENTS.md")" -eq 2 ] || fail "malformed guidance file changed"

printf '7. content failure rolls back earlier destinations\n'
new_case rollback
mkdir -p "$CASE_HOME/.claude"
printf '%s\n' 'blocking path' > "$CASE_HOME/.claude/skills"
set +e
run_installer --skills cpp-oop-style --targets codex,claude --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "failed transaction returned $status instead of 1"
[ ! -e "$CASE_HOME/.agents/skills/cpp-oop-style" ] || fail "failed transaction left an earlier skill installed"
assert_contains "$CASE_HOME/.claude/skills" 'blocking path'

printf '8. dry run makes no changes\n'
new_case dry-run
run_installer --profile all --targets codex,opencode,claude --yes --skip-deps --dry-run >/dev/null
for path in "$CASE_HOME/.agents" "$CASE_HOME/.claude" "$CASE_HOME/.codex" "$CASE_HOME/.config"; do
    [ ! -e "$path" ] || fail "dry run created $path"
done

printf '9. color output uses real ANSI escapes\n'
new_case color
color_output="$CASE_ROOT/output"
HOME="$CASE_HOME" XDG_STATE_HOME="$CASE_STATE" FORCE_COLOR=1 NO_COLOR='' \
    "$ROOT/installer/main.sh" --source-root "$ROOT" --profile core --targets codex \
    --yes --skip-deps --dry-run > "$color_output"
if awk 'index($0, "\\033[") { found = 1 } END { exit !found }' "$color_output"; then
    fail 'color output contains a literal \033 escape'
fi
escape_character=$(printf '\033')
assert_contains "$color_output" "${escape_character}[1m"

printf '10. curl-pipe bootstrap with a local archive\n'
new_case pipe
payload_root="$CASE_ROOT/payload"
mkdir -p "$payload_root/agent-skills"
cp -R "$ROOT"/. "$payload_root/agent-skills"/
rm -rf -- "$payload_root/agent-skills/.git"
archive="$CASE_ROOT/source.tar.gz"
tar -czf "$archive" -C "$payload_root" agent-skills
HOME="$CASE_HOME" XDG_STATE_HOME="$CASE_STATE" NO_COLOR=1 \
    AGENT_SKILLS_ARCHIVE_URL="file://$archive" \
    bash -s -- --skills cpp-oop-style --targets codex --yes --skip-deps < "$ROOT/install.sh" >/dev/null
assert_file "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"
assert_not_link "$CASE_HOME/.agents/skills/cpp-oop-style"

printf '11. archive sources cannot create disposable links\n'
new_case archive-link
set +e
HOME="$CASE_HOME" XDG_STATE_HOME="$CASE_STATE" NO_COLOR=1 \
    AGENT_SKILLS_ARCHIVE_URL="file://$archive" \
    bash -s -- --skills cpp-oop-style --targets codex --yes --skip-deps \
    --install-mode link < "$ROOT/install.sh" >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "archive link mode returned $status instead of 1"
[ ! -e "$CASE_HOME/.agents/skills/cpp-oop-style" ] || fail "archive link mode installed content"

printf '12. local install.sh reuses the checkout\n'
new_case local-checkout
HOME="$CASE_HOME" XDG_STATE_HOME="$CASE_STATE" NO_COLOR=1 \
    "$ROOT/install.sh" --skills cpp-oop-style --targets codex --yes --skip-deps >/dev/null
assert_link_target "$CASE_HOME/.agents/skills/cpp-oop-style" "$ROOT/skills/cpp-oop-style"

printf '13. rollback restores a pre-existing checkout link\n'
new_case link-rollback
run_installer --skills cpp-oop-style --targets codex --yes --skip-deps >/dev/null
mkdir -p "$CASE_HOME/.claude"
printf '%s\n' 'blocking path' > "$CASE_HOME/.claude/skills"
set +e
run_installer --skills cpp-oop-style --targets codex,claude --yes --skip-deps \
    --install-mode copy >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "link rollback run returned $status instead of 1"
assert_link_target "$CASE_HOME/.agents/skills/cpp-oop-style" "$ROOT/skills/cpp-oop-style"

printf '14. target-specific skills install only for compatible agents\n'
new_case target-compatibility
run_installer --skills fable-advisor --targets codex,claude --yes --skip-deps >/dev/null
assert_file "$CASE_HOME/.agents/skills/fable-advisor/SKILL.md"
[ ! -e "$CASE_HOME/.claude/skills/fable-advisor" ] || fail 'Codex-only skill was installed for Claude'

new_case unsupported-target
set +e
run_installer --skills fable-advisor --targets claude --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "unsupported target returned $status instead of 1"
[ ! -e "$CASE_HOME/.claude/skills/fable-advisor" ] || fail 'unsupported target installed fable-advisor'

printf '15. Scrapling installs with only the uv runtime\n'
scrapling_runtimes=$(awk -F '\t' '$1 == "scrapling" { print $8 }' "$ROOT/installer/catalog.tsv")
[ "$scrapling_runtimes" = uv ] || fail "expected Scrapling runtime checks to be uv, found: $scrapling_runtimes"
new_case scrapling-install
run_installer --skills scrapling --targets codex --yes --skip-deps --install-mode copy >/dev/null
assert_file "$CASE_HOME/.agents/skills/scrapling/scripts/scrapling"
[ -x "$CASE_HOME/.agents/skills/scrapling/scripts/scrapling" ] || fail 'Scrapling launcher is not executable'

printf '16. Scrapling launcher delegates to uvx\n'
new_case scrapling-launcher
mock_bin="$CASE_ROOT/bin"
mock_log="$CASE_ROOT/uvx"
mkdir -p "$mock_bin"
cat > "$mock_bin/uvx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${UV_TOOL_DIR-}" > "$MOCK_UVX_LOG.tool-dir"
printf '%s\n' "$@" > "$MOCK_UVX_LOG.args"
exit "${MOCK_UVX_EXIT:-0}"
EOF
chmod +x "$mock_bin/uvx"

HOME="$CASE_HOME" XDG_CACHE_HOME="$CASE_ROOT/cache" UV_CACHE_DIR= UV_TOOL_DIR= \
    MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/scrapling/scripts/scrapling" extract get https://example.com page.md
[ "$(< "$mock_log.tool-dir")" = "$CASE_ROOT/cache/uv/tools" ] || fail 'Scrapling launcher chose the wrong default UV_TOOL_DIR'
expected_args=$(printf '%s\n' --from 'scrapling[all]>=0.4.14' scrapling extract get https://example.com page.md)
[ "$(< "$mock_log.args")" = "$expected_args" ] || fail 'Scrapling launcher changed forwarded arguments'

custom_tool_dir="$CASE_ROOT/custom-tools"
HOME="$CASE_HOME" UV_TOOL_DIR="$custom_tool_dir" MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/scrapling/scripts/scrapling" browser-install
[ "$(< "$mock_log.tool-dir")" = "$custom_tool_dir" ] || fail 'Scrapling launcher replaced an explicit UV_TOOL_DIR'
expected_args=$(printf '%s\n' --from 'scrapling[all]>=0.4.14' playwright install chromium)
[ "$(< "$mock_log.args")" = "$expected_args" ] || fail 'browser-install invoked the wrong uvx command'

set +e
HOME="$CASE_HOME" MOCK_UVX_EXIT=23 MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/scrapling/scripts/scrapling" --version >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 23 ] || fail "Scrapling launcher returned $status instead of uvx status 23"

set +e
HOME="$CASE_HOME" MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/scrapling/scripts/scrapling" browser-install extra >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "browser-install with extra arguments returned $status instead of 2"

printf 'All installer tests passed.\n'
