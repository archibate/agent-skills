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
for skill in artifact-restraint e2e-side-effect-safety; do
    catalog_entry=$(awk -F '\t' -v skill="$skill" '$1 == skill { print $4 ":" $5 }' "$ROOT/installer/catalog.tsv")
    [ "$catalog_entry" = alignment:no ] || fail "$skill should be an optional alignment skill, found: $catalog_entry"
done

printf '2. core profile and target layout\n'
new_case core
run_installer --profile core --targets codex,claude --yes --skip-deps >/dev/null
assert_file "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"
assert_file "$CASE_HOME/.agents/skills/cpp-hpc-optimization/SKILL.md"
[ ! -e "$CASE_HOME/.agents/skills/artifact-restraint" ] || fail "non-default skill installed by core profile"
assert_link_target "$CASE_HOME/.agents/skills/e2e-side-effect-safety" "$ROOT/skills/e2e-side-effect-safety"
assert_file "$CASE_HOME/.claude/skills/cpp-oop-style/SKILL.md"
assert_file "$CASE_HOME/.claude/skills/cpp-hpc-optimization/SKILL.md"
assert_file "$CASE_HOME/.codex/AGENTS.md"
assert_file "$CASE_HOME/.claude/CLAUDE.md"
assert_link_target "$CASE_HOME/.agents/skills/cpp-oop-style" "$ROOT/skills/cpp-oop-style"
assert_link_target "$CASE_HOME/.claude/skills/cpp-hpc-optimization" "$ROOT/skills/cpp-hpc-optimization"
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
run_installer --skills monitor-wakeup --targets codex,claude,pi --yes --skip-deps >/dev/null
assert_file "$CASE_HOME/.codex/skills/monitor-wakeup/SKILL.md"
assert_link_target "$CASE_HOME/.codex/skills/monitor-wakeup" "$ROOT/skills-codex/monitor-wakeup"
[ ! -e "$CASE_HOME/.agents/skills/monitor-wakeup" ] || fail 'Codex-only skill leaked into the shared skills directory'
[ ! -e "$CASE_HOME/.claude/skills/monitor-wakeup" ] || fail 'Codex-only skill was installed for Claude'
[ ! -e "$CASE_HOME/.pi/agent/skills/monitor-wakeup" ] || fail 'Codex-only skill was installed for Pi'

new_case unsupported-target
set +e
run_installer --skills monitor-wakeup --targets claude --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "unsupported target returned $status instead of 1"
[ ! -e "$CASE_HOME/.claude/skills/monitor-wakeup" ] || fail 'unsupported target installed monitor-wakeup'

printf '15. Pi target shares the agents skills directory\n'
new_case pi
run_installer --profile core --targets pi --yes --skip-deps >/dev/null
assert_file "$CASE_HOME/.agents/skills/cpp-oop-style/SKILL.md"
assert_file "$CASE_HOME/.agents/skills/cpp-hpc-optimization/SKILL.md"
assert_link_target "$CASE_HOME/.agents/skills/cpp-oop-style" "$ROOT/skills/cpp-oop-style"
assert_file "$CASE_HOME/.pi/agent/AGENTS.md"
assert_contains "$CASE_HOME/.pi/agent/AGENTS.md" '<!-- archibate/agent-skills:begin -->'
[ ! -e "$CASE_HOME/.claude" ] || fail 'Pi-only install created Claude files'

printf '15b. Pi honors PI_CODING_AGENT_DIR for guidance\n'
new_case pi-agent-dir
PI_CODING_AGENT_DIR="$CASE_ROOT/custom-agent" run_installer --skills agent-rules --targets pi --yes --skip-deps >/dev/null
assert_file "$CASE_ROOT/custom-agent/AGENTS.md"
[ ! -e "$CASE_HOME/.pi" ] || fail 'Pi guidance ignored PI_CODING_AGENT_DIR'

printf '15c. Codex-only skill is rejected for Pi\n'
new_case pi-unsupported-target
set +e
run_installer --skills monitor-wakeup --targets pi --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "Pi unsupported target returned $status instead of 1"
[ ! -e "$CASE_HOME/.agents/skills/monitor-wakeup" ] || fail 'unsupported Pi target installed monitor-wakeup'

printf '16. web-fetch anti-bot launcher delegates to uvx\n'
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
    "$ROOT/skills/web-fetch/scripts/scrapling" extract get https://example.com page.md
[ "$(< "$mock_log.tool-dir")" = "$CASE_ROOT/cache/uv/tools" ] || fail 'Scrapling launcher chose the wrong default UV_TOOL_DIR'
expected_args=$(printf '%s\n' --from 'scrapling[all]>=0.4.14' scrapling extract get https://example.com page.md)
[ "$(< "$mock_log.args")" = "$expected_args" ] || fail 'Scrapling launcher changed forwarded arguments'

custom_tool_dir="$CASE_ROOT/custom-tools"
HOME="$CASE_HOME" UV_TOOL_DIR="$custom_tool_dir" MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/web-fetch/scripts/scrapling" browser-install
[ "$(< "$mock_log.tool-dir")" = "$custom_tool_dir" ] || fail 'Scrapling launcher replaced an explicit UV_TOOL_DIR'
expected_args=$(printf '%s\n' --from 'scrapling[all]>=0.4.14' playwright install chromium)
[ "$(< "$mock_log.args")" = "$expected_args" ] || fail 'browser-install invoked the wrong uvx command'

set +e
HOME="$CASE_HOME" MOCK_UVX_EXIT=23 MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/web-fetch/scripts/scrapling" --version >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 23 ] || fail "Scrapling launcher returned $status instead of uvx status 23"

set +e
HOME="$CASE_HOME" MOCK_UVX_LOG="$mock_log" PATH="$mock_bin:$PATH" \
    "$ROOT/skills/web-fetch/scripts/scrapling" browser-install extra >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "browser-install with extra arguments returned $status instead of 2"

printf '17. Pi extensions install and satisfy hard dependencies\n'
new_case pi-extensions
run_installer --skills pi-subagents --targets pi --yes --skip-deps >/dev/null
assert_dir "$CASE_HOME/.pi/agent/extensions/jobs"
assert_file "$CASE_HOME/.pi/agent/extensions/jobs/index.ts"
assert_link_target "$CASE_HOME/.pi/agent/extensions/jobs" "$ROOT/extensions-pi/jobs"
assert_link_target "$CASE_HOME/.pi/agent/skills/pi-subagents" "$ROOT/skills-pi/pi-subagents"
[ ! -e "$CASE_HOME/.pi/agent/extensions/scratchpad" ] || fail 'unrequested extension was installed'
[ ! -e "$CASE_HOME/.agents/skills/pi-subagents" ] || fail 'Pi-only skill leaked into the shared skills directory'

new_case pi-extension-copy
run_installer --skills scratchpad --targets pi --yes --skip-deps --install-mode copy >/dev/null
assert_file "$CASE_HOME/.pi/agent/extensions/scratchpad/index.ts"
assert_not_link "$CASE_HOME/.pi/agent/extensions/scratchpad"
[ ! -e "$CASE_HOME/.pi/agent/extensions/scratchpad/node_modules" ] || fail 'copied extension kept node_modules'

new_case pi-extension-unsupported-target
set +e
run_installer --skills jobs --targets codex --yes --skip-deps >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "extension on codex returned $status instead of 1"
[ ! -e "$CASE_HOME/.codex/skills/jobs" ] || fail 'extension installed for codex'

printf '18. web skills install independently; fetch keeps backends optional\n'
for skill in web-search web-fetch; do
    new_case "$skill"
    run_installer --skills "$skill" --targets codex,claude --yes --skip-deps --install-mode copy >/dev/null
    assert_contains "$CASE_HOME/.agents/skills/$skill/SKILL.md" "name: $skill"
    assert_contains "$CASE_HOME/.claude/skills/$skill/SKILL.md" "name: $skill"
    assert_not_link "$CASE_HOME/.agents/skills/$skill"
    web_runtimes=$(awk -F '\t' -v skill="$skill" '$1 == skill { print $8 }' "$ROOT/installer/catalog.tsv")
    if [ "$skill" = web-fetch ]; then
        [ "$web_runtimes" = curl,node-npx ] || fail "expected web-fetch runtime checks to be curl,node-npx, found: $web_runtimes"
        assert_file "$CASE_HOME/.agents/skills/$skill/references/jina.md"
        assert_file "$CASE_HOME/.agents/skills/$skill/references/ssrn.md"
        assert_file "$CASE_HOME/.agents/skills/$skill/references/scrapling.md"
        assert_file "$CASE_HOME/.agents/skills/$skill/references/scrapling-LICENSE.txt"
        [ -x "$CASE_HOME/.agents/skills/$skill/scripts/scrapling" ] || fail 'copied anti-bot launcher is not executable'
        assert_file "$CASE_HOME/.claude/skills/$skill/references/scrapling.md"
        [ -x "$CASE_HOME/.claude/skills/$skill/scripts/scrapling" ] || fail 'copied Claude anti-bot launcher is not executable'
        [ -x "$CASE_HOME/.agents/skills/$skill/scripts/fetch_zhihu.py" ] || fail 'copied web-fetch script is not executable'
    else
        for runtime in uv jina-cli jina-key; do
            case ",$web_runtimes," in
                *,$runtime,*) ;;
                *) fail "$skill is missing runtime check $runtime" ;;
            esac
        done
        assert_file "$CASE_HOME/.agents/skills/$skill/references/academic-research.md"
        [ -x "$CASE_HOME/.agents/skills/$skill/scripts/dedup_images.py" ] || fail 'copied web-search script is not executable'
    fi
done

printf '19. anti-bot backend is not a standalone skill\n'
new_case backend-only
set +e
run_installer --skills scrapling --targets codex --yes --skip-deps --dry-run > "$CASE_ROOT/output" 2>&1
status=$?
set -e
[ "$status" -eq 1 ] || fail "standalone anti-bot skill selection returned $status instead of 1"
assert_contains "$CASE_ROOT/output" 'unknown skill or guidance item: scrapling'

printf '20. execution safety accompanies global guidance for every target\n'
new_case execution-safety
run_installer --skills agent-rules --targets codex,opencode,claude,pi --yes --skip-deps >/dev/null
assert_link_target "$CASE_HOME/.agents/skills/e2e-side-effect-safety" "$ROOT/skills/e2e-side-effect-safety"
assert_link_target "$CASE_HOME/.claude/skills/e2e-side-effect-safety" "$ROOT/skills/e2e-side-effect-safety"
for guidance in "$CASE_HOME/.codex/AGENTS.md" "$CASE_HOME/.config/opencode/AGENTS.md" \
    "$CASE_HOME/.claude/CLAUDE.md" "$CASE_HOME/.pi/agent/AGENTS.md"; do
    assert_contains "$guidance" 'Before nontrivial execution tests or E2E:'
    assert_contains "$guidance" 'verified non-disturbing, agent-owned isolation'
    assert_contains "$guidance" 'Keep test writes and config overrides in an isolated scratchpad or workspace'
    assert_contains "$guidance" 'does not authorize test-only mutations of global configs or shared services'
    assert_contains "$guidance" 'verified agent-private desktop'
done

printf 'All installer tests passed.\n'
