#!/usr/bin/env bash
#
# setup-mac.sh — provisions a fresh Mac to run Warp (this app).
#
# Installs, in order: Homebrew (if missing), Xcode Command Line Tools (best
# effort — only needed if a native module has to compile from source),
# Node.js, the Claude Code CLI, then runs `npm install` and the DB init
# script inside this project. Every step is its own function that reports
# ok/failed/skipped — one failure doesn't kill the run; it's recorded and
# the script moves on, then prints a summary at the end.
#
# There is no separate "database server" to install. This app uses SQLite
# via better-sqlite3 — a file (data.db), not a service. The only reason a
# C compiler toolchain might be needed at all is if npm can't find a
# prebuilt better-sqlite3 binary for your exact Node/macOS/arch combo and
# has to build it from source — see run_npm_install below, which only
# reaches for Xcode Command Line Tools if npm's own output shows that's
# actually why it failed, rather than always installing them up front.
#
# KNOWN GAP THIS SCRIPT WORKS AROUND: claude-runner.js's claudeBin() only
# checks three fixed paths — /opt/homebrew/bin/claude, /usr/local/bin/claude,
# and ~/.claude/local/claude. Claude Code's own native installer
# (curl -fsSL https://claude.ai/install.sh | bash) actually places the
# binary at ~/.local/bin/claude, which matches NONE of those — the app
# would silently fail to find it. This script prefers `brew install --cask
# claude-code` for exactly that reason (it lands in one of the paths the
# app already checks); if it has to fall back to the native installer, it
# sets CLAUDE_BIN so the app can still find it (claudeBin() honors that
# env var first, before its own hardcoded list).
#
# Usage:
#   ./setup-mac.sh                  # project path defaults to this script's own folder
#   ./setup-mac.sh /path/to/project

set -uo pipefail   # deliberately not -e — one step failing must not abort the rest

# ============================================================
# SMALL HELPERS
# ============================================================

PROJECT_PATH="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; GRAY=$'\033[90m'; RESET=$'\033[0m'

STEP_NAMES=()
STEP_STATUSES=()

say_step() { printf '\n%s==> %s%s\n' "$CYAN" "$1" "$RESET"; }
say_ok()   { printf '  %sOK%s  %s\n' "$GREEN" "$RESET" "$1"; }
say_skip() { printf '  %s--%s  %s\n' "$YELLOW" "$RESET" "$1"; }
say_fail() { printf '  %s!!%s  %s\n' "$RED" "$RESET" "$1"; }
say_info() { printf '  %s\n' "$1"; }

# Runs one step function; records ok/failed/skipped for the final summary.
# $1=display name  $2="required"|"optional"  $3=function name to call
run_step() {
    local name="$1" mode="$2" fn="$3"
    say_step "$name"
    if "$fn"; then
        say_ok "$name"
        STEP_NAMES+=("$name"); STEP_STATUSES+=("OK")
        return 0
    fi
    if [ "$mode" = "optional" ]; then
        say_skip "$name"
        STEP_NAMES+=("$name"); STEP_STATUSES+=("SKIPPED")
    else
        say_fail "$name"
        STEP_NAMES+=("$name"); STEP_STATUSES+=("FAILED")
    fi
    return 1
}

# ============================================================
# 0. SANITY CHECK
# ============================================================

if [ ! -f "$PROJECT_PATH/package.json" ]; then
    say_fail "No package.json found under '$PROJECT_PATH'."
    say_info "Pass a path as the first argument, or run this script from the project root."
    exit 1
fi

printf '\nSetting up Warp in: %s\n' "$PROJECT_PATH"

# ============================================================
# 1. HOMEBREW
# ============================================================

step_homebrew() {
    if command -v brew >/dev/null 2>&1; then
        say_info "already installed: $(brew --version | head -1)"
        return 0
    fi
    say_info "installing Homebrew (this asks for your password once)..."
    # NONINTERACTIVE=1 is the documented flag for a script-driven install —
    # without it the installer waits on a RETURN keypress that never comes
    # here and the step hangs.
    if ! NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
        return 1
    fi
    # Homebrew's own installer prints the exact eval line for this, but a
    # freshly-installed brew isn't on PATH in this shell yet either way.
    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
    command -v brew >/dev/null 2>&1
}

run_step "Homebrew" "required" step_homebrew || {
    say_fail "Without Homebrew the rest of this script has no reliable install path — stopping."
    exit 1
}

# ============================================================
# 2. XCODE COMMAND LINE TOOLS — best effort. Only genuinely required if
#    better-sqlite3 has to compile from source (no matching prebuilt
#    binary); most of the time this is a no-op because it's already there.
# ============================================================

step_xcode_clt() {
    if xcode-select -p >/dev/null 2>&1; then
        say_info "already installed: $(xcode-select -p)"
        return 0
    fi
    say_info "triggering the Command Line Tools installer — a GUI dialog will pop up;"
    say_info "click Install there, then come back here. Waiting up to 10 minutes..."
    xcode-select --install >/dev/null 2>&1
    local waited=0
    while ! xcode-select -p >/dev/null 2>&1; do
        sleep 15
        waited=$((waited + 15))
        if [ "$waited" -ge 600 ]; then
            say_info "still not installed after 10 minutes — not waiting any longer."
            return 1
        fi
    done
    return 0
}

run_step "Xcode Command Line Tools" "optional" step_xcode_clt

# ============================================================
# 3. NODE.JS — Claude Code's own npm-install path wants Node 22+; this
#    app has no engines field pinning a version, so the same one covers both.
# ============================================================

step_node() {
    if command -v node >/dev/null 2>&1; then
        local ver major
        ver="$(node --version)"
        major="$(echo "$ver" | tr -d 'v' | cut -d. -f1)"
        say_info "already installed: $ver"
        if [ "$major" -lt 22 ]; then
            say_info "${YELLOW}Node $ver is older than the recommended 22 — Claude Code's npm-based${RESET}"
            say_info "${YELLOW}install path in particular wants 22+. Not replacing it automatically${RESET}"
            say_info "${YELLOW}(that can break other projects pinned to this version) — upgrade by${RESET}"
            say_info "${YELLOW}hand if the Claude Code install step below fails because of it.${RESET}"
        fi
        return 0
    fi
    brew install node || return 1
    command -v node >/dev/null 2>&1
}

run_step "Node.js" "required" step_node

# ============================================================
# 4. CLAUDE CODE CLI — Homebrew first (lands where claudeBin() already
#    looks), native installer as the fallback (needs the CLAUDE_BIN
#    workaround — see this file's header comment).
# ============================================================

# The exact three paths claude-runner.js's claudeBin() checks, in the same
# order — mirrored here so this script can tell whether an install actually
# landed somewhere the app will find on its own.
claude_bin_app_would_find() {
    for c in "/opt/homebrew/bin/claude" "/usr/local/bin/claude" "$HOME/.claude/local/claude"; do
        if [ -x "$c" ]; then echo "$c"; return 0; fi
    done
    return 1
}

step_claude() {
    if command -v claude >/dev/null 2>&1; then
        say_info "already installed: $(claude --version 2>/dev/null || echo 'version check failed')"
    else
        say_info "trying Homebrew (lands where the app already looks for it)..."
        if brew install --cask claude-code 2>&1 | tee /tmp/warp-setup-claude-brew.log; then
            :
        else
            say_info "${YELLOW}Homebrew cask install failed — falling back to the native installer${RESET}"
            if ! curl -fsSL https://claude.ai/install.sh | bash; then
                say_info "native installer failed too — trying npm as a last resort"
                npm install -g @anthropic-ai/claude-code || return 1
            fi
        fi
    fi

    if ! command -v claude >/dev/null 2>&1; then
        # Homebrew/npm both put things on PATH immediately in most setups;
        # the native installer's ~/.local/bin is the one that often isn't yet.
        export PATH="$HOME/.local/bin:$PATH"
    fi
    command -v claude >/dev/null 2>&1 || return 1

    local found
    if found="$(claude_bin_app_would_find)"; then
        say_info "found at a path the app already knows: $found"
        return 0
    fi

    # Installed, but not where claudeBin() looks (this is exactly the
    # ~/.local/bin/claude case the native installer produces) — set
    # CLAUDE_BIN so the app can still find it.
    local resolved
    resolved="$(command -v claude)"
    say_info "${YELLOW}claude is at $resolved, which claudeBin() doesn't check — setting CLAUDE_BIN.${RESET}"
    export CLAUDE_BIN="$resolved"
    local profile="$HOME/.zshrc"
    if ! grep -q "^export CLAUDE_BIN=" "$profile" 2>/dev/null; then
        printf '\nexport CLAUDE_BIN="%s"\n' "$resolved" >> "$profile"
        say_info "added to $profile (open a new terminal, or 'source $profile', to pick it up elsewhere)"
    fi
    return 0
}

run_step "Claude Code CLI" "required" step_claude

# ============================================================
# 5. npm install — with reactive recovery for the one native module
#    (better-sqlite3) that can require a C toolchain to build from source
#    if no prebuilt binary matches this Node/macOS/arch combination.
# ============================================================

run_npm_install() {
    local attempt=1 max_attempts=3 output
    while [ "$attempt" -le "$max_attempts" ]; do
        say_info "npm install (attempt $attempt of $max_attempts)..."
        output="$(cd "$PROJECT_PATH" && npm install 2>&1)"
        local status=$?
        echo "$output"

        if [ "$status" -eq 0 ]; then
            return 0
        fi

        if echo "$output" | grep -qiE "find Python|Python was not found|gyp ERR!.*Python"; then
            say_info "${YELLOW}Detected: node-gyp can't find Python. Installing via Homebrew...${RESET}"
            brew install python3
            attempt=$((attempt + 1)); continue
        fi

        if echo "$output" | grep -qiE "xcrun|xcode-select|Command Line Tools"; then
            say_info "${YELLOW}Detected: node-gyp needs Xcode Command Line Tools. Triggering that installer...${RESET}"
            xcode-select --install >/dev/null 2>&1
            say_info "a GUI dialog just opened — click Install, then this will retry once you're done."
            local waited=0
            while ! xcode-select -p >/dev/null 2>&1 && [ "$waited" -lt 600 ]; do
                sleep 15; waited=$((waited + 15))
            done
            attempt=$((attempt + 1)); continue
        fi

        if echo "$output" | grep -qiE "ENOTFOUND|ETIMEDOUT|ECONNRESET|network"; then
            say_info "${YELLOW}Detected a network error — waiting 5s and retrying.${RESET}"
            sleep 5
            attempt=$((attempt + 1)); continue
        fi

        if echo "$output" | grep -qi "EBADENGINE"; then
            say_info "${GRAY}(an EBADENGINE warning appeared too, but that alone doesn't fail the install)${RESET}"
        fi

        say_info "npm install failed for a reason this script doesn't recognize — see the output above."
        return 1
    done

    say_info "npm install still failing after $max_attempts attempts."
    return 1
}

run_step "npm install (project dependencies)" "required" run_npm_install

# ============================================================
# 6. INITIALIZE THE LOCAL DATABASE — a file (data.db), not a service. See
#    scripts/init-db.mjs's own header for why this has to run once, by
#    itself, before anything else touches the DB.
# ============================================================

step_init_db() {
    (cd "$PROJECT_PATH" && node scripts/init-db.mjs)
}

run_step "Initialize data.db" "required" step_init_db

# ============================================================
# 7. gong.env — cannot be scripted (it's a Gong session cookie + CX Portal
#    token, both secrets only you can supply). Just flag whether it exists.
# ============================================================

step_gong_env() {
    if [ -f "$PROJECT_PATH/gong.env" ]; then
        say_info "found: $PROJECT_PATH/gong.env"
        return 0
    fi
    say_info "gong.env does not exist yet. Create it and fill in GONG_HOST / GONG_COOKIE at"
    say_info "minimum — see README.md's Setup section for the full field list. The app will"
    say_info "not start without it (gong.js's loadConfig() throws if it's missing)."
    return 1
}

run_step "gong.env present" "optional" step_gong_env

# ============================================================
# SUMMARY
# ============================================================

printf '\n%s========================================%s\n' "$GRAY" "$RESET"
printf ' Summary\n'
printf '%s========================================%s\n' "$GRAY" "$RESET"
failed_count=0
for i in "${!STEP_NAMES[@]}"; do
    status="${STEP_STATUSES[$i]}"
    color="$GREEN"
    [ "$status" = "SKIPPED" ] && color="$YELLOW"
    [ "$status" = "FAILED" ] && { color="$RED"; failed_count=$((failed_count + 1)); }
    printf '  %s%-45s %s%s\n' "$color" "${STEP_NAMES[$i]}" "$status" "$RESET"
done

echo
if [ "$failed_count" -gt 0 ]; then
    printf '%s%d step(s) failed%s — fix those and re-run this script; already-satisfied steps are skipped automatically.\n' "$RED" "$failed_count" "$RESET"
else
    printf '%sAll required steps completed.%s\n' "$GREEN" "$RESET"
fi

echo
echo "Still needed by hand, always:"
echo "  - Run 'claude' once and complete the browser login — there is no way to script an OAuth flow."
echo "  - Fill in gong.env if the step above flagged it missing (README.md's Setup table)."
echo "  - Open a new terminal (or 'source ~/.zshrc') before running npm scripts, so PATH/CLAUDE_BIN pick up anything this script just added."
echo
echo "Then: npm run dev   (http://127.0.0.1:7878)"

exit 0
