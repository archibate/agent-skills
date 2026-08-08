#!/usr/bin/env bash

set -u
set -o pipefail

BEGIN_MARKER="<!-- archibate/agent-skills:begin -->"
END_MARKER="<!-- archibate/agent-skills:end -->"

SOURCE_ROOT=""
SOURCE_KIND="archive"
INSTALL_MODE="auto"
EFFECTIVE_INSTALL_MODE="copy"
PROFILE=""
TARGET_ARG=""
SKILL_ARG=""
ASSUME_YES=0
SKIP_DEPS=0
DRY_RUN=0
NO_COLOR_VALUE="${NO_COLOR:-}"
VALIDATE_ONLY=0
INTERACTIVE=0
TTY_OPEN=0
INCOMPLETE=0
BACKUP_ROOT=""

ITEM_IDS=()
ITEM_KINDS=()
ITEM_SOURCES=()
ITEM_GROUPS=()
ITEM_DEFAULTS=()
ITEM_REQUIRES=()
ITEM_RECOMMENDS=()
ITEM_RUNTIMES=()
ITEM_LABELS=()
SELECTED=()
TARGET_IDS=("codex" "opencode" "claude")
TARGET_LABELS=("Codex" "OpenCode" "Claude Code")
TARGET_SELECTED=(0 0 0)
RUNTIME_IDS=()
RUNTIME_SELECTED=()
RUNTIME_INSTALLABLE=()
RUNTIME_HEAVY=()
RUNTIME_MESSAGES=()
CHANGE_DESTINATIONS=()
CHANGE_BACKUPS=()
CHANGE_ORIGINALS=()

MENU_TITLE=""
MENU_HINT=""
MENU_ALLOW_EMPTY=0
MENU_LABELS=()
MENU_SELECTED=()

RED=""
GREEN=""
YELLOW=""
BLUE=""
BOLD=""
DIM=""
RESET=""

usage() {
    cat <<'EOF'
Install 小彭老师技能全家桶.

Usage:
  install.sh [OPTIONS]

Options:
  --profile core|all              Initial skill selection
  --targets codex,opencode,claude Target agents
  --skills ID,ID                  Explicit skill/guidance selection
  --install-mode auto|link|copy   Reuse a Git checkout or copy skill files
  --ref REF                       Git branch, tag, or commit (bootstrap option)
  --skip-deps                     Do not offer runtime dependency installation
  --dry-run                       Show actions without changing files
  --yes                           Accept the preview noninteractively
  --no-color                      Disable ANSI colors
  --validate                      Validate the catalog and exit
  -h, --help                      Show this help

Examples:
  curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/archibate/agent-skills/master/install.sh | \
    bash -s -- --profile core --targets codex,opencode --yes
  git clone --depth 1 https://github.com/archibate/agent-skills.git && \
    cd agent-skills && ./install.sh
EOF
}

die() {
    printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
    exit 1
}

warn() {
    printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2
}

info() {
    printf '%s==>%s %s\n' "$BLUE" "$RESET" "$*"
}

cleanup_terminal() {
    if [ "$TTY_OPEN" -eq 1 ]; then
        printf '\033[?25h%s' "$RESET" >&4
        exec 3<&-
        exec 4>&-
        TTY_OPEN=0
    fi
}

trap cleanup_terminal EXIT HUP INT TERM

contains_csv() {
    needle=$1
    haystack=$2
    case ",$haystack," in
        *,$needle,*) return 0 ;;
        *) return 1 ;;
    esac
}

item_index() {
    local wanted=$1
    local idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        if [ "${ITEM_IDS[$idx]}" = "$wanted" ]; then
            printf '%s\n' "$idx"
            return 0
        fi
        idx=$((idx + 1))
    done
    return 1
}

target_index() {
    local wanted=$1
    local idx=0
    while [ "$idx" -lt "${#TARGET_IDS[@]}" ]; do
        if [ "${TARGET_IDS[$idx]}" = "$wanted" ]; then
            printf '%s\n' "$idx"
            return 0
        fi
        idx=$((idx + 1))
    done
    return 1
}

runtime_known() {
    case "$1" in
        curl|uv|node-npx|node22|chrome-browser|chrome-debug|context7-key|jina-cli|jina-key|agent-browser-cli|agent-browser-runtime|lark-auth|scrapling-cli|scrapling-runtime) return 0 ;;
        *) return 1 ;;
    esac
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --source-root)
                [ "$#" -ge 2 ] || die "--source-root requires a value"
                SOURCE_ROOT=$2
                shift 2
                ;;
            --profile)
                [ "$#" -ge 2 ] || die "--profile requires a value"
                PROFILE=$2
                shift 2
                ;;
            --profile=*) PROFILE=${1#--profile=}; shift ;;
            --targets)
                [ "$#" -ge 2 ] || die "--targets requires a value"
                TARGET_ARG=$2
                shift 2
                ;;
            --targets=*) TARGET_ARG=${1#--targets=}; shift ;;
            --skills)
                [ "$#" -ge 2 ] || die "--skills requires a value"
                SKILL_ARG=$2
                shift 2
                ;;
            --skills=*) SKILL_ARG=${1#--skills=}; shift ;;
            --install-mode)
                [ "$#" -ge 2 ] || die "--install-mode requires a value"
                INSTALL_MODE=$2
                shift 2
                ;;
            --install-mode=*) INSTALL_MODE=${1#--install-mode=}; shift ;;
            --ref)
                [ "$#" -ge 2 ] || die "--ref requires a value"
                shift 2
                ;;
            --ref=*) shift ;;
            --skip-deps) SKIP_DEPS=1; shift ;;
            --dry-run) DRY_RUN=1; shift ;;
            --yes) ASSUME_YES=1; shift ;;
            --no-color) NO_COLOR_VALUE=1; shift ;;
            --validate) VALIDATE_ONLY=1; shift ;;
            -h|--help) usage; exit 0 ;;
            --) shift; break ;;
            *) die "unknown option: $1" ;;
        esac
    done
}

setup_colors() {
    if [ -z "$NO_COLOR_VALUE" ] && { [ -n "${FORCE_COLOR:-}" ] || [ -t 1 ] || [ -w /dev/tty ]; }; then
        RED=$'\033[31m'
        GREEN=$'\033[32m'
        YELLOW=$'\033[33m'
        BLUE=$'\033[34m'
        BOLD=$'\033[1m'
        DIM=$'\033[2m'
        RESET=$'\033[0m'
    fi
}

load_catalog() {
    catalog="$SOURCE_ROOT/installer/catalog.tsv"
    [ -f "$catalog" ] || die "missing catalog: $catalog"

    tab=$(printf '\t')
    while IFS="$tab" read -r id kind source group default requires recommends runtimes label extra; do
        case "$id" in
            ""|'#'*) continue ;;
        esac
        [ -z "${extra:-}" ] || die "catalog row for $id has too many fields"
        [ -n "$label" ] || die "catalog row for $id has too few fields"
        ITEM_IDS[${#ITEM_IDS[@]}]=$id
        ITEM_KINDS[${#ITEM_KINDS[@]}]=$kind
        ITEM_SOURCES[${#ITEM_SOURCES[@]}]=$source
        ITEM_GROUPS[${#ITEM_GROUPS[@]}]=$group
        ITEM_DEFAULTS[${#ITEM_DEFAULTS[@]}]=$default
        ITEM_REQUIRES[${#ITEM_REQUIRES[@]}]=$requires
        ITEM_RECOMMENDS[${#ITEM_RECOMMENDS[@]}]=$recommends
        ITEM_RUNTIMES[${#ITEM_RUNTIMES[@]}]=$runtimes
        ITEM_LABELS[${#ITEM_LABELS[@]}]=$label
        SELECTED[${#SELECTED[@]}]=0
    done < "$catalog"
}

validate_id_list() {
    local owner=$1
    local relation=$2
    local values=$3
    local value
    local parts=()
    [ "$values" != "-" ] || return 0
    IFS=, read -r -a parts <<< "$values"
    for value in "${parts[@]}"; do
        item_index "$value" >/dev/null || die "$owner has unknown $relation: $value"
    done
}

visit_required() {
    local node=$1
    local path=$2
    local idx deps dep
    local parts=()
    case ",$path," in
        *,$node,*) die "hard dependency cycle: $path,$node" ;;
    esac
    idx=$(item_index "$node") || die "unknown dependency node: $node"
    deps=${ITEM_REQUIRES[$idx]}
    [ "$deps" != "-" ] || return 0
    IFS=, read -r -a parts <<< "$deps"
    for dep in "${parts[@]}"; do
        visit_required "$dep" "${path:+$path,}$node"
    done
}

validate_catalog() {
    [ "${#ITEM_IDS[@]}" -gt 0 ] || die "catalog is empty"
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        id=${ITEM_IDS[$idx]}
        case "$id" in
            *[!a-z0-9-]*|""|-*|*-) die "invalid item id: $id" ;;
        esac
        other=$((idx + 1))
        while [ "$other" -lt "${#ITEM_IDS[@]}" ]; do
            [ "$id" != "${ITEM_IDS[$other]}" ] || die "duplicate item id: $id"
            other=$((other + 1))
        done
        case "${ITEM_KINDS[$idx]}" in skill|guidance) ;; *) die "$id has invalid kind" ;; esac
        case "${ITEM_DEFAULTS[$idx]}" in yes|no) ;; *) die "$id has invalid default" ;; esac
        source="$SOURCE_ROOT/${ITEM_SOURCES[$idx]}"
        [ -e "$source" ] || die "$id source does not exist: ${ITEM_SOURCES[$idx]}"
        if [ "${ITEM_KINDS[$idx]}" = "skill" ]; then
            [ -f "$source/SKILL.md" ] || die "$id source has no SKILL.md"
            skill_name=$(awk '/^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); print; exit }' "$source/SKILL.md")
            [ "$skill_name" = "$id" ] || die "$id does not match SKILL.md name: $skill_name"
        fi
        validate_id_list "$id" "dependency" "${ITEM_REQUIRES[$idx]}"
        validate_id_list "$id" "recommendation" "${ITEM_RECOMMENDS[$idx]}"
        runtimes=${ITEM_RUNTIMES[$idx]}
        if [ "$runtimes" != "-" ]; then
            runtime_parts=()
            IFS=, read -r -a runtime_parts <<< "$runtimes"
            for runtime in "${runtime_parts[@]}"; do
                runtime_known "$runtime" || die "$id has unknown runtime check: $runtime"
            done
        fi
        idx=$((idx + 1))
    done

    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        visit_required "${ITEM_IDS[$idx]}" ""
        idx=$((idx + 1))
    done

    for skill_dir in "$SOURCE_ROOT"/skills/*; do
        [ -f "$skill_dir/SKILL.md" ] || continue
        basename_value=${skill_dir##*/}
        item_index "$basename_value" >/dev/null || die "skill missing from catalog: $basename_value"
    done
}

detect_source_kind() {
    local worktree_root
    SOURCE_KIND=archive
    [ -e "$SOURCE_ROOT/.git" ] || return 0
    command -v git >/dev/null 2>&1 || return 0
    worktree_root=$(git -C "$SOURCE_ROOT" rev-parse --show-toplevel 2>/dev/null) || return 0
    worktree_root=$(CDPATH='' cd -- "$worktree_root" && pwd -P) || return 0
    [ "$worktree_root" = "$SOURCE_ROOT" ] && SOURCE_KIND=checkout
}

resolve_install_mode() {
    case "$INSTALL_MODE" in
        auto)
            if [ "$SOURCE_KIND" = checkout ]; then
                EFFECTIVE_INSTALL_MODE=link
            else
                EFFECTIVE_INSTALL_MODE=copy
            fi
            ;;
        link)
            [ "$SOURCE_KIND" = checkout ] || die "--install-mode link requires a complete Git checkout"
            EFFECTIVE_INSTALL_MODE=link
            ;;
        copy) EFFECTIVE_INSTALL_MODE=copy ;;
        *) die "invalid install mode: $INSTALL_MODE (expected auto, link, or copy)" ;;
    esac
}

open_tty() {
    [ -r /dev/tty ] && [ -w /dev/tty ] || return 1
    exec 3</dev/tty
    exec 4>/dev/tty
    TTY_OPEN=1
    INTERACTIVE=1
    return 0
}

menu_draw() {
    cursor=$1
    printf '\033[2J\033[H\033[?25l' >&4
    printf '%s%s%s\n\n' "$BOLD" "$MENU_TITLE" "$RESET" >&4
    idx=0
    while [ "$idx" -lt "${#MENU_LABELS[@]}" ]; do
        if [ "$idx" -eq "$cursor" ]; then pointer='›'; else pointer=' '; fi
        if [ "${MENU_SELECTED[$idx]}" -eq 1 ]; then mark='●'; else mark='○'; fi
        printf ' %s %s %s\n' "$pointer" "$mark" "${MENU_LABELS[$idx]}" >&4
        idx=$((idx + 1))
    done
    printf '\n%s%s%s\n' "$DIM" "$MENU_HINT" "$RESET" >&4
}

menu_run() {
    [ "${#MENU_LABELS[@]}" -gt 0 ] || return 0
    cursor=0
    while :; do
        menu_draw "$cursor"
        key=''
        IFS= read -r -s -n 1 -u 3 key || return 1
        case "$key" in
            '')
                selected_count=0
                for value in "${MENU_SELECTED[@]}"; do
                    selected_count=$((selected_count + value))
                done
                if [ "$selected_count" -gt 0 ] || [ "$MENU_ALLOW_EMPTY" -eq 1 ]; then
                    return 0
                fi
                ;;
            j) cursor=$(((cursor + 1) % ${#MENU_LABELS[@]})) ;;
            k) cursor=$(((cursor + ${#MENU_LABELS[@]} - 1) % ${#MENU_LABELS[@]})) ;;
            q) return 1 ;;
            ' ')
                MENU_SELECTED[cursor]=$((1 - MENU_SELECTED[cursor]))
                ;;
            $'\033')
                sequence=''
                IFS= read -r -s -n 2 -u 3 sequence || true
                case "$sequence" in
                    '[A') cursor=$(((cursor + ${#MENU_LABELS[@]} - 1) % ${#MENU_LABELS[@]})) ;;
                    '[B') cursor=$(((cursor + 1) % ${#MENU_LABELS[@]})) ;;
                esac
                ;;
        esac
    done
}

detect_targets() {
    [ -n "$TARGET_ARG" ] || {
        command -v codex >/dev/null 2>&1 && TARGET_SELECTED[0]=1
        command -v opencode >/dev/null 2>&1 && TARGET_SELECTED[1]=1
        command -v claude >/dev/null 2>&1 && TARGET_SELECTED[2]=1
        return 0
    }

    TARGET_SELECTED=(0 0 0)
    target_parts=()
    IFS=, read -r -a target_parts <<< "$TARGET_ARG"
    for target in "${target_parts[@]}"; do
        idx=$(target_index "$target") || die "unknown target: $target"
        TARGET_SELECTED[idx]=1
    done
}

select_targets_interactively() {
    MENU_TITLE="Choose target agents"
    MENU_HINT="↑/↓ or j/k move · Space toggle · Enter continue · q cancel"
    MENU_ALLOW_EMPTY=0
    MENU_LABELS=("${TARGET_LABELS[@]}")
    MENU_SELECTED=("${TARGET_SELECTED[@]}")
    if ! menu_run; then
        die "installation cancelled"
    fi
    TARGET_SELECTED=("${MENU_SELECTED[@]}")
}

initial_selection() {
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        SELECTED[idx]=0
        idx=$((idx + 1))
    done

    if [ -n "$SKILL_ARG" ]; then
        skill_parts=()
        IFS=, read -r -a skill_parts <<< "$SKILL_ARG"
        for id in "${skill_parts[@]}"; do
            idx=$(item_index "$id") || die "unknown skill or guidance item: $id"
            SELECTED[idx]=1
        done
        return 0
    fi

    case "${PROFILE:-core}" in
        core)
            idx=0
            while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
                [ "${ITEM_DEFAULTS[$idx]}" = yes ] && SELECTED[idx]=1
                idx=$((idx + 1))
            done
            ;;
        all)
            idx=0
            while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do SELECTED[idx]=1; idx=$((idx + 1)); done
            ;;
        *) die "unknown profile: $PROFILE" ;;
    esac
}

resolve_required() {
    changed=1
    while [ "$changed" -eq 1 ]; do
        changed=0
        idx=0
        while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
            if [ "${SELECTED[$idx]}" -eq 1 ] && [ "${ITEM_REQUIRES[$idx]}" != "-" ]; then
                required_parts=()
                IFS=, read -r -a required_parts <<< "${ITEM_REQUIRES[$idx]}"
                for dep in "${required_parts[@]}"; do
                    dep_idx=$(item_index "$dep") || die "unknown dependency: $dep"
                    if [ "${SELECTED[$dep_idx]}" -eq 0 ]; then
                        SELECTED[dep_idx]=1
                        changed=1
                    fi
                done
            fi
            idx=$((idx + 1))
        done
    done
}

select_items_interactively() {
    MENU_TITLE="Choose your loadout"
    MENU_HINT="Core items are preselected · hard dependencies are restored automatically"
    MENU_ALLOW_EMPTY=0
    MENU_LABELS=()
    MENU_SELECTED=()
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        MENU_LABELS[${#MENU_LABELS[@]}]="${ITEM_LABELS[$idx]}  ${DIM}${ITEM_IDS[$idx]}${RESET}"
        MENU_SELECTED[${#MENU_SELECTED[@]}]=${SELECTED[$idx]}
        idx=$((idx + 1))
    done
    if ! menu_run; then die "installation cancelled"; fi
    SELECTED=("${MENU_SELECTED[@]}")
    resolve_required
}

select_recommendations_interactively() {
    REC_IDS=()
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        if [ "${SELECTED[$idx]}" -eq 1 ] && [ "${ITEM_RECOMMENDS[$idx]}" != "-" ]; then
            recommendation_parts=()
            IFS=, read -r -a recommendation_parts <<< "${ITEM_RECOMMENDS[$idx]}"
            for rec in "${recommendation_parts[@]}"; do
                rec_idx=$(item_index "$rec") || continue
                if [ "${SELECTED[$rec_idx]}" -eq 0 ] && ! contains_csv "$rec" "$(IFS=,; printf '%s' "${REC_IDS[*]:-}")"; then
                    REC_IDS[${#REC_IDS[@]}]=$rec
                fi
            done
        fi
        idx=$((idx + 1))
    done
    [ "${#REC_IDS[@]}" -gt 0 ] || return 0

    MENU_TITLE="Optional companions"
    MENU_HINT="Recommendations improve coverage but are never forced"
    MENU_ALLOW_EMPTY=1
    MENU_LABELS=()
    MENU_SELECTED=()
    for rec in "${REC_IDS[@]}"; do
        rec_idx=$(item_index "$rec")
        MENU_LABELS[${#MENU_LABELS[@]}]="${ITEM_LABELS[$rec_idx]}  ${DIM}$rec${RESET}"
        MENU_SELECTED[${#MENU_SELECTED[@]}]=0
    done
    if ! menu_run; then die "installation cancelled"; fi
    idx=0
    while [ "$idx" -lt "${#REC_IDS[@]}" ]; do
        if [ "${MENU_SELECTED[$idx]}" -eq 1 ]; then
            rec_idx=$(item_index "${REC_IDS[$idx]}")
            SELECTED[rec_idx]=1
        fi
        idx=$((idx + 1))
    done
    resolve_required
}

runtime_add() {
    local runtime=$1
    local existing
    if [ "${#RUNTIME_IDS[@]}" -gt 0 ]; then
        for existing in "${RUNTIME_IDS[@]}"; do
            [ "$existing" != "$runtime" ] || return 0
        done
    fi
    RUNTIME_IDS[${#RUNTIME_IDS[@]}]=$runtime
}

collect_runtimes() {
    RUNTIME_IDS=()
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        if [ "${SELECTED[$idx]}" -eq 1 ] && [ "${ITEM_RUNTIMES[$idx]}" != "-" ]; then
            runtime_parts=()
            IFS=, read -r -a runtime_parts <<< "${ITEM_RUNTIMES[$idx]}"
            for runtime in "${runtime_parts[@]}"; do runtime_add "$runtime"; done
        fi
        idx=$((idx + 1))
    done
}

node_major() {
    command -v node >/dev/null 2>&1 || return 1
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

chrome_available() {
    for candidate in google-chrome google-chrome-stable chromium chromium-browser chrome; do
        command -v "$candidate" >/dev/null 2>&1 && return 0
    done
    return 1
}

npm_global_writable() {
    command -v npm >/dev/null 2>&1 || return 1
    prefix=$(npm config get prefix 2>/dev/null) || return 1
    case "$prefix" in
        "$HOME"|"$HOME"/*) return 0 ;;
    esac
    [ -d "$prefix" ] && [ -w "$prefix" ]
}

runtime_probe() {
    runtime=$1
    RUNTIME_PROBE_INSTALLABLE=0
    RUNTIME_PROBE_HEAVY=0
    case "$runtime" in
        curl)
            command -v curl >/dev/null 2>&1 && return 0
            RUNTIME_PROBE_MESSAGE="curl is missing (install it with your OS package manager)"
            ;;
        uv)
            command -v uv >/dev/null 2>&1 && return 0
            RUNTIME_PROBE_INSTALLABLE=1
            RUNTIME_PROBE_MESSAGE="Install uv in your user account"
            ;;
        node-npx)
            if command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then return 0; fi
            RUNTIME_PROBE_MESSAGE="Node.js and npx are missing"
            ;;
        node22)
            major=$(node_major 2>/dev/null || printf '0')
            if [ "$major" -ge 22 ] 2>/dev/null; then return 0; fi
            RUNTIME_PROBE_MESSAGE="Node.js 22+ is required (found ${major:-none})"
            ;;
        chrome-browser)
            chrome_available && return 0
            RUNTIME_PROBE_MESSAGE="Chrome or Chromium is missing"
            ;;
        chrome-debug)
            RUNTIME_PROBE_MESSAGE="Chrome remote debugging must be enabled manually"
            ;;
        context7-key)
            [ -n "${CONTEXT7_API_KEY:-}" ] && return 0
            RUNTIME_PROBE_MESSAGE="CONTEXT7_API_KEY is not set"
            ;;
        jina-cli)
            command -v jina >/dev/null 2>&1 && return 0
            RUNTIME_PROBE_INSTALLABLE=1
            RUNTIME_PROBE_MESSAGE="Install jina-cli with uv"
            ;;
        jina-key)
            [ -n "${JINA_API_KEY:-}" ] && return 0
            RUNTIME_PROBE_MESSAGE="JINA_API_KEY is not set"
            ;;
        agent-browser-cli)
            command -v agent-browser >/dev/null 2>&1 && return 0
            if npm_global_writable || command -v cargo >/dev/null 2>&1 || command -v brew >/dev/null 2>&1; then
                RUNTIME_PROBE_INSTALLABLE=1
            fi
            RUNTIME_PROBE_MESSAGE="Install the agent-browser CLI"
            ;;
        agent-browser-runtime)
            RUNTIME_PROBE_INSTALLABLE=1
            RUNTIME_PROBE_HEAVY=1
            RUNTIME_PROBE_MESSAGE="Download the agent-browser Chrome runtime"
            ;;
        lark-auth)
            RUNTIME_PROBE_MESSAGE="Lark authentication must be completed manually"
            ;;
        scrapling-cli)
            command -v scrapling >/dev/null 2>&1 && return 0
            RUNTIME_PROBE_INSTALLABLE=1
            RUNTIME_PROBE_MESSAGE="Install scrapling[all] with uv"
            ;;
        scrapling-runtime)
            RUNTIME_PROBE_INSTALLABLE=1
            RUNTIME_PROBE_HEAVY=1
            RUNTIME_PROBE_MESSAGE="Download Scrapling browser dependencies"
            ;;
    esac
    return 1
}

prepare_runtime_choices() {
    RUNTIME_SELECTED=()
    RUNTIME_INSTALLABLE=()
    RUNTIME_HEAVY=()
    RUNTIME_MESSAGES=()
    kept_ids=()
    [ "${#RUNTIME_IDS[@]}" -gt 0 ] || return 0
    for runtime in "${RUNTIME_IDS[@]}"; do
        if runtime_probe "$runtime"; then
            continue
        fi
        kept_ids[${#kept_ids[@]}]=$runtime
        RUNTIME_INSTALLABLE[${#RUNTIME_INSTALLABLE[@]}]=$RUNTIME_PROBE_INSTALLABLE
        RUNTIME_HEAVY[${#RUNTIME_HEAVY[@]}]=$RUNTIME_PROBE_HEAVY
        RUNTIME_MESSAGES[${#RUNTIME_MESSAGES[@]}]=$RUNTIME_PROBE_MESSAGE
        if [ "$RUNTIME_PROBE_INSTALLABLE" -eq 1 ] && [ "$RUNTIME_PROBE_HEAVY" -eq 0 ]; then
            RUNTIME_SELECTED[${#RUNTIME_SELECTED[@]}]=1
        else
            RUNTIME_SELECTED[${#RUNTIME_SELECTED[@]}]=0
        fi
    done
    RUNTIME_IDS=("${kept_ids[@]}")
}

runtime_command() {
    case "$1" in
        uv) printf '%s' "curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
        jina-cli) printf '%s' "uv tool install jina-cli --with 'httpx[socks]'" ;;
        agent-browser-cli)
            if npm_global_writable; then printf '%s' "npm install -g agent-browser"
            elif command -v cargo >/dev/null 2>&1; then printf '%s' "cargo install agent-browser"
            else printf '%s' "brew install agent-browser"; fi
            ;;
        agent-browser-runtime) printf '%s' "agent-browser install" ;;
        scrapling-cli) printf '%s' "uv tool install 'scrapling[all]>=0.4.2'" ;;
        scrapling-runtime) printf '%s' "scrapling install --force" ;;
        *) printf '%s' "manual setup" ;;
    esac
}

select_runtime_actions_interactively() {
    [ "$SKIP_DEPS" -eq 0 ] || return 0
    installable_count=0
    if [ "${#RUNTIME_INSTALLABLE[@]}" -gt 0 ]; then
        for value in "${RUNTIME_INSTALLABLE[@]}"; do installable_count=$((installable_count + value)); done
    fi
    [ "$installable_count" -gt 0 ] || return 0

    MENU_TITLE="Set up missing runtime tools"
    MENU_HINT="Lightweight user installs are preselected · browser downloads are opt-in"
    MENU_ALLOW_EMPTY=1
    MENU_LABELS=()
    MENU_SELECTED=()
    map_indices=()
    idx=0
    while [ "$idx" -lt "${#RUNTIME_IDS[@]}" ]; do
        if [ "${RUNTIME_INSTALLABLE[$idx]}" -eq 1 ]; then
            map_indices[${#map_indices[@]}]=$idx
            MENU_LABELS[${#MENU_LABELS[@]}]="${RUNTIME_MESSAGES[$idx]}  ${DIM}$(runtime_command "${RUNTIME_IDS[$idx]}")${RESET}"
            MENU_SELECTED[${#MENU_SELECTED[@]}]=${RUNTIME_SELECTED[$idx]}
        fi
        idx=$((idx + 1))
    done
    if ! menu_run; then die "installation cancelled"; fi
    idx=0
    while [ "$idx" -lt "${#map_indices[@]}" ]; do
        original=${map_indices[$idx]}
        RUNTIME_SELECTED[original]=${MENU_SELECTED[$idx]}
        idx=$((idx + 1))
    done
}

runtime_index() {
    local wanted=$1
    local idx=0
    while [ "$idx" -lt "${#RUNTIME_IDS[@]}" ]; do
        if [ "${RUNTIME_IDS[$idx]}" = "$wanted" ]; then
            printf '%s\n' "$idx"
            return 0
        fi
        idx=$((idx + 1))
    done
    return 1
}

select_runtime_prerequisite() {
    local runtime=$1
    local prerequisite=$2
    local runtime_idx prerequisite_idx
    runtime_idx=$(runtime_index "$runtime") || return 0
    [ "${RUNTIME_SELECTED[$runtime_idx]}" -eq 1 ] || return 0
    prerequisite_idx=$(runtime_index "$prerequisite") || return 0
    if [ "${RUNTIME_INSTALLABLE[$prerequisite_idx]}" -eq 1 ]; then
        RUNTIME_SELECTED[prerequisite_idx]=1
    fi
}

resolve_runtime_action_dependencies() {
    select_runtime_prerequisite jina-cli uv
    select_runtime_prerequisite scrapling-cli uv
    select_runtime_prerequisite agent-browser-runtime agent-browser-cli
    select_runtime_prerequisite scrapling-runtime scrapling-cli
    select_runtime_prerequisite scrapling-runtime uv
}

selected_target_count() {
    count=0
    for value in "${TARGET_SELECTED[@]}"; do count=$((count + value)); done
    printf '%s\n' "$count"
}

selected_item_count() {
    count=0
    for value in "${SELECTED[@]}"; do count=$((count + value)); done
    printf '%s\n' "$count"
}

print_preview() {
    printf '\n%s%sInstallation preview%s\n' "$BOLD" "$BLUE" "$RESET"
    printf '  Targets: '
    first=1
    idx=0
    while [ "$idx" -lt "${#TARGET_IDS[@]}" ]; do
        if [ "${TARGET_SELECTED[$idx]}" -eq 1 ]; then
            [ "$first" -eq 1 ] || printf ', '
            printf '%s' "${TARGET_LABELS[$idx]}"
            first=0
        fi
        idx=$((idx + 1))
    done
    printf '\n  Content:\n'
    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        [ "${SELECTED[$idx]}" -eq 0 ] || printf '    %s %s\n' '•' "${ITEM_IDS[$idx]}"
        idx=$((idx + 1))
    done
    printf '  Source: %s (%s)\n' "$SOURCE_ROOT" "$SOURCE_KIND"
    if [ "$EFFECTIVE_INSTALL_MODE" = link ]; then
        printf '  Skill files: link to source checkout\n'
    else
        printf '  Skill files: copy into agent directories\n'
    fi
    if [ "${#RUNTIME_IDS[@]}" -gt 0 ]; then
        printf '  Runtime setup:\n'
        idx=0
        while [ "$idx" -lt "${#RUNTIME_IDS[@]}" ]; do
            if [ "${RUNTIME_INSTALLABLE[$idx]}" -eq 1 ] && [ "${RUNTIME_SELECTED[$idx]}" -eq 1 ] && [ "$SKIP_DEPS" -eq 0 ]; then
                printf '    %s %s\n' '•' "$(runtime_command "${RUNTIME_IDS[$idx]}")"
            else
                printf '    %s %s\n' '!' "${RUNTIME_MESSAGES[$idx]}"
            fi
            idx=$((idx + 1))
        done
    fi
    printf '  Backups: %s\n\n' "$BACKUP_ROOT"
}

confirm_preview() {
    [ "$ASSUME_YES" -eq 0 ] || return 0
    printf 'Install this loadout? [y/N] ' >&4
    answer=''
    IFS= read -r -u 3 answer || return 1
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

same_directory() {
    [ -d "$1" ] && [ -d "$2" ] || return 1
    left=$(CDPATH='' cd -- "$1" && pwd -P) || return 1
    right=$(CDPATH='' cd -- "$2" && pwd -P) || return 1
    [ "$left" = "$right" ]
}

record_change() {
    CHANGE_DESTINATIONS[${#CHANGE_DESTINATIONS[@]}]=$1
    CHANGE_BACKUPS[${#CHANGE_BACKUPS[@]}]=$2
    CHANGE_ORIGINALS[${#CHANGE_ORIGINALS[@]}]=$3
}

copy_path() {
    local source=$1
    local destination=$2
    if [ -L "$source" ]; then
        cp -P "$source" "$destination"
    elif [ -d "$source" ]; then
        cp -R "$source" "$destination"
    else
        cp "$source" "$destination"
    fi
}

remove_managed_path() {
    path=$1
    case "$path" in
        "$HOME"/*) ;;
        *) warn "refusing to remove rollback path outside HOME: $path"; return 1 ;;
    esac
    if [ -d "$path" ] && [ ! -L "$path" ]; then
        rm -rf -- "$path"
    else
        rm -f -- "$path"
    fi
}

rollback_content() {
    [ "${#CHANGE_DESTINATIONS[@]}" -gt 0 ] || return 0
    warn "rolling back installed content"
    idx=$((${#CHANGE_DESTINATIONS[@]} - 1))
    while [ "$idx" -ge 0 ]; do
        destination=${CHANGE_DESTINATIONS[$idx]}
        backup=${CHANGE_BACKUPS[$idx]}
        original=${CHANGE_ORIGINALS[$idx]}
        remove_managed_path "$destination" || true
        if [ "$original" -eq 1 ]; then
            copy_path "$backup" "$destination" || warn "could not restore $destination"
        fi
        idx=$((idx - 1))
    done
}

install_staged_path() {
    local stage=$1
    local destination=$2
    local parent=${destination%/*}
    local backup_name backup_path old original
    [ "$parent" != "$destination" ] || parent=.
    backup_name=$(printf '%s' "$destination" | tr '/' '_')
    mkdir -p "$BACKUP_ROOT"
    backup_path=""
    original=0

    if [ -e "$destination" ] || [ -L "$destination" ]; then
        original=1
        backup_path="$BACKUP_ROOT/$backup_name"
        copy_path "$destination" "$backup_path" || return 1
        old="$parent/.agent-skills-old.$$.$backup_name"
        mv "$destination" "$old" || return 1
        if mv "$stage" "$destination"; then
            if [ -d "$old" ] && [ ! -L "$old" ]; then rm -rf -- "$old"; else rm -f -- "$old"; fi
        else
            mv "$old" "$destination" || true
            return 1
        fi
    else
        mv "$stage" "$destination" || return 1
    fi
    record_change "$destination" "$backup_path" "$original"
}

copy_directory() {
    local source=$1
    local destination=$2
    local parent=${destination%/*}
    local stage
    [ "$parent" != "$destination" ] || parent=.
    mkdir -p "$parent"

    if [ -d "$destination" ] && [ ! -L "$destination" ] && diff -qr "$source" "$destination" >/dev/null 2>&1; then
        printf 'skip\t%s\n' "$destination"
        return 0
    fi

    stage=$(mktemp -d "$parent/.agent-skills-stage.XXXXXX") || return 1
    if ! cp -R "$source"/. "$stage"/; then
        rm -rf -- "$stage"
        return 1
    fi
    install_staged_path "$stage" "$destination" || { rm -rf -- "$stage"; return 1; }
    printf 'install\t%s\n' "$destination"
}

link_directory() {
    local source=$1
    local destination=$2
    local parent=${destination%/*}
    local stage_root stage
    [ "$parent" != "$destination" ] || parent=.
    mkdir -p "$parent"

    if [ -L "$destination" ] && same_directory "$source" "$destination"; then
        printf 'skip\t%s (linked to source checkout)\n' "$destination"
        return 0
    fi

    stage_root=$(mktemp -d "$parent/.agent-skills-stage.XXXXXX") || return 1
    stage="$stage_root/skill"
    if ! ln -s "$source" "$stage"; then
        rm -rf -- "$stage_root"
        return 1
    fi
    if ! install_staged_path "$stage" "$destination"; then
        rm -rf -- "$stage_root"
        return 1
    fi
    rmdir "$stage_root" || return 1
    printf 'link\t%s -> %s\n' "$destination" "$source"
}

materialize_skill() {
    local source=$1
    local destination=$2
    if [ ! -L "$destination" ] && same_directory "$source" "$destination"; then
        printf 'skip\t%s (source checkout)\n' "$destination"
    elif [ "$EFFECTIVE_INSTALL_MODE" = link ]; then
        link_directory "$source" "$destination"
    else
        copy_directory "$source" "$destination"
    fi
}

build_guidance_file() {
    source=$1
    destination=$2
    output=$3
    begin_count=0
    end_count=0
    if [ -f "$destination" ]; then
        begin_count=$(awk -v marker="$BEGIN_MARKER" '$0 == marker { count++ } END { print count + 0 }' "$destination")
        end_count=$(awk -v marker="$END_MARKER" '$0 == marker { count++ } END { print count + 0 }' "$destination")
    fi
    if [ "$begin_count" -ne "$end_count" ] || [ "$begin_count" -gt 1 ]; then
        return 2
    fi

    if [ "$begin_count" -eq 0 ]; then
        if [ -f "$destination" ] && [ -s "$destination" ]; then
            cp "$destination" "$output" || return 1
            printf '\n' >> "$output"
        else
            : > "$output"
        fi
        {
            printf '%s\n' "$BEGIN_MARKER"
            awk '{ print }' "$source"
            printf '%s\n' "$END_MARKER"
        } >> "$output"
        return 0
    fi

    awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v payload="$source" '
        $0 == begin {
            print begin
            while ((getline line < payload) > 0) print line
            close(payload)
            skipping = 1
            next
        }
        $0 == end {
            skipping = 0
            print end
            next
        }
        !skipping { print }
    ' "$destination" > "$output"
}

install_guidance() {
    source=$1
    destination=$2
    parent=${destination%/*}
    if [ -e "$destination" ] && [ ! -f "$destination" ] && [ ! -L "$destination" ]; then
        warn "guidance destination is not a regular file: $destination"
        return 1
    fi
    mkdir -p "$parent"
    stage=$(mktemp "$parent/.agent-skills-guidance.XXXXXX") || return 1
    build_guidance_file "$source" "$destination" "$stage"
    status=$?
    if [ "$status" -eq 2 ]; then
        rm -f -- "$stage"
        warn "managed block markers are malformed in $destination; left unchanged"
        INCOMPLETE=1
        return 0
    elif [ "$status" -ne 0 ]; then
        rm -f -- "$stage"
        return 1
    fi

    if [ -f "$destination" ] && cmp -s "$stage" "$destination"; then
        rm -f -- "$stage"
        printf 'skip\t%s\n' "$destination"
        return 0
    fi

    install_staged_path "$stage" "$destination" || { rm -f -- "$stage"; return 1; }
    printf 'install\t%s\n' "$destination"
}

guidance_destination() {
    case "$1" in
        codex) printf '%s/.codex/AGENTS.md\n' "$HOME" ;;
        opencode) printf '%s/.config/opencode/AGENTS.md\n' "$HOME" ;;
        claude) printf '%s/.claude/CLAUDE.md\n' "$HOME" ;;
    esac
}

install_content() {
    shared_skills=0
    [ "${TARGET_SELECTED[0]}" -eq 1 ] && shared_skills=1
    [ "${TARGET_SELECTED[1]}" -eq 1 ] && shared_skills=1

    idx=0
    while [ "$idx" -lt "${#ITEM_IDS[@]}" ]; do
        if [ "${SELECTED[$idx]}" -eq 1 ] && [ "${ITEM_KINDS[$idx]}" = skill ]; then
            source="$SOURCE_ROOT/${ITEM_SOURCES[$idx]}"
            if [ "$shared_skills" -eq 1 ]; then
                destination="$HOME/.agents/skills/${ITEM_IDS[$idx]}"
                materialize_skill "$source" "$destination" || return 1
            fi
            if [ "${TARGET_SELECTED[2]}" -eq 1 ]; then
                destination="$HOME/.claude/skills/${ITEM_IDS[$idx]}"
                materialize_skill "$source" "$destination" || return 1
            fi
        fi
        idx=$((idx + 1))
    done

    rules_idx=$(item_index agent-rules)
    if [ "${SELECTED[$rules_idx]}" -eq 1 ]; then
        source="$SOURCE_ROOT/${ITEM_SOURCES[$rules_idx]}"
        target_idx=0
        while [ "$target_idx" -lt "${#TARGET_IDS[@]}" ]; do
            if [ "${TARGET_SELECTED[$target_idx]}" -eq 1 ]; then
                destination=$(guidance_destination "${TARGET_IDS[$target_idx]}")
                install_guidance "$source" "$destination" || return 1
            fi
            target_idx=$((target_idx + 1))
        done
    fi
}

refresh_user_path() {
    for directory in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
        case ":$PATH:" in *:"$directory":*) ;; *) PATH="$directory:$PATH" ;; esac
    done
    export PATH
}

run_runtime_action() {
    runtime=$1
    case "$runtime" in
        uv)
            curl -LsSf https://astral.sh/uv/install.sh | sh
            refresh_user_path
            ;;
        jina-cli)
            refresh_user_path
            command -v uv >/dev/null 2>&1 || return 1
            uv tool install jina-cli --with 'httpx[socks]'
            ;;
        agent-browser-cli)
            if npm_global_writable; then npm install -g agent-browser
            elif command -v cargo >/dev/null 2>&1; then cargo install agent-browser
            elif command -v brew >/dev/null 2>&1; then brew install agent-browser
            else return 1; fi
            ;;
        agent-browser-runtime)
            command -v agent-browser >/dev/null 2>&1 || return 1
            agent-browser install
            ;;
        scrapling-cli)
            refresh_user_path
            command -v uv >/dev/null 2>&1 || return 1
            uv tool install 'scrapling[all]>=0.4.2'
            ;;
        scrapling-runtime)
            refresh_user_path
            command -v scrapling >/dev/null 2>&1 || return 1
            scrapling install --force
            ;;
        *) return 1 ;;
    esac
}

install_runtime_dependencies() {
    [ "$SKIP_DEPS" -eq 0 ] || return 0
    order="uv jina-cli agent-browser-cli agent-browser-runtime scrapling-cli scrapling-runtime"
    for runtime in $order; do
        idx=0
        while [ "$idx" -lt "${#RUNTIME_IDS[@]}" ]; do
            if [ "${RUNTIME_IDS[$idx]}" = "$runtime" ] && [ "${RUNTIME_INSTALLABLE[$idx]}" -eq 1 ] && [ "${RUNTIME_SELECTED[$idx]}" -eq 1 ]; then
                info "$(runtime_command "$runtime")"
                if ! run_runtime_action "$runtime"; then
                    warn "runtime setup failed: ${RUNTIME_MESSAGES[$idx]}"
                    INCOMPLETE=1
                fi
            fi
            idx=$((idx + 1))
        done
    done

    idx=0
    while [ "$idx" -lt "${#RUNTIME_IDS[@]}" ]; do
        if [ "${RUNTIME_INSTALLABLE[$idx]}" -eq 0 ] || [ "${RUNTIME_SELECTED[$idx]}" -eq 0 ]; then
            warn "${RUNTIME_MESSAGES[$idx]}"
            INCOMPLETE=1
        fi
        idx=$((idx + 1))
    done
}

main() {
    parse_args "$@"
    setup_colors
    [ -n "$SOURCE_ROOT" ] || die "internal error: source root not provided"
    SOURCE_ROOT=$(CDPATH='' cd -- "$SOURCE_ROOT" && pwd -P) || die "invalid source root"
    load_catalog
    validate_catalog
    if [ "$VALIDATE_ONLY" -eq 1 ]; then
        printf 'catalog valid: %s items\n' "${#ITEM_IDS[@]}"
        return 0
    fi
    detect_source_kind
    resolve_install_mode

    BACKUP_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/archibate-agent-skills/backups/$(date '+%Y%m%dT%H%M%S')-$$"
    detect_targets
    initial_selection
    resolve_required

    if [ "$ASSUME_YES" -eq 0 ]; then
        open_tty || die "interactive mode requires /dev/tty; pass --yes with --targets and a profile or skill list"
        [ -n "$TARGET_ARG" ] || select_targets_interactively
        [ -n "$SKILL_ARG" ] || select_items_interactively
        select_recommendations_interactively
    fi

    [ "$(selected_target_count)" -gt 0 ] || die "select at least one target agent"
    [ "$(selected_item_count)" -gt 0 ] || die "select at least one skill or guidance item"
    if [ "$ASSUME_YES" -eq 1 ] && [ -z "$TARGET_ARG" ] && [ "$(selected_target_count)" -eq 0 ]; then
        die "--yes requires --targets when no supported agent is detected"
    fi

    collect_runtimes
    prepare_runtime_choices
    if [ "$INTERACTIVE" -eq 1 ]; then select_runtime_actions_interactively; fi
    resolve_runtime_action_dependencies
    print_preview
    if [ "$INTERACTIVE" -eq 1 ] && ! confirm_preview; then die "installation cancelled"; fi
    cleanup_terminal

    if [ "$DRY_RUN" -eq 1 ]; then
        info "dry run complete; no files changed"
        return 0
    fi

    info "Installing selected content"
    if ! install_content; then
        rollback_content
        die "content installation failed"
    fi
    install_runtime_dependencies

    if [ "$INCOMPLETE" -eq 1 ]; then
        warn "content installed, but runtime setup is incomplete"
        return 2
    fi
    printf '%sInstalled successfully.%s Start a new agent session if the skills are not detected immediately.\n' "$GREEN" "$RESET"
    return 0
}

main "$@"
