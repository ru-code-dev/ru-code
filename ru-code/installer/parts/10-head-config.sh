#!/usr/bin/env bash
# ru-code: GENERATED FILE — do not edit `install` directly.
# Authored as parts in ru-code/installer/parts/*.sh; assembled by scripts/build-installer.ts
# (`pnpm build:installer`). The drift-guard test fails if `install` ≠ the assembled output.
#
# Installer / updater / uninstaller. Every run performs exactly ONE action (install / update /
# uninstall) and ends in exactly ONE terminal state, drawn by a single `render_outcome`. The logic
# never prints to the screen ad-hoc — it only SETS (ACTION, STATE, RECOMMENDATIONS[], facts…); the
# renderer draws it; everything else (OS info, every step, subprocess output) goes to the journal.
# Full spec: INSTALLER/specs.md.
#
# Portability: this runs on macOS (bash 3.2), Linux, and Git Bash for Windows — so NO bash-4+
# syntax (no `declare -A`, `${v,,}`, `mapfile`, `&>>`, namerefs, `wait -n`, globstar). See §1a.
#
# Usage:
#   bash ru-code/install                         # from the parent of a cloned ./ru-code
#   cat ru-code/install | bash                   # same, piped
#   curl -fsSL <REMOTE_URL>/install | bash       # standalone (needs REMOTE_URL baked in)
#   bash ru-code/install --uninstall
#   ./install --help

set -euo pipefail

# ============================================================================
# CONFIG (injected at build time from scripts/build-installer.ts — 0 hardcoded)
# ============================================================================
# Brand
APP_DISPLAY_NAME="@@APP_DISPLAY_NAME@@"   # display name, e.g. "Ru Code"
REPO_NAME="@@REPO_NAME@@"                 # git repo / clone dir the installer cd's into (git clone <repo>)
APP_SLUG="@@APP_SLUG@@"                   # on-disk identity slug: log/lock filenames + starter git email
APP_COMMAND="@@APP_COMMAND@@"             # bundle filename prefix, e.g. "ru-code" (may contain '-')
ENTRY_JS="cli.js"                         # <bin>/cli.js — the FROZEN wrapper users and shims launch
PREFLIGHT_BASENAME="preflight.mjs"
# ru-code: the bundle IS the installed <bin> tree — the wrapper + this pointer + versions/<v>/.
# The installer copies it verbatim; the in-app updater adds another versions/<v> and rewrites the
# pointer. Names mirror apps/server/src/ru-code/auto-update/apply/{pointer,gc}.ts.
POINTER_JSON="current.json"
VERSIONS_DIR="versions"
# ru-code: the app's own log, relative to APP_ROOT — the server child is spawned with its stdout and
# stderr pointed at it (ru-code/daemon/src/spawn.ts + paths.ts, beside `server-runtime.json` in the
# state dir). The ONLY place a failed launch's real error text lives, so the failure banner names it.
DAEMON_LOG_REL="userdata/daemon.log"

# Runtime
NODE_FLAGS="@@NODE_FLAGS@@"               # our app is ALWAYS run with these; the preflight is NOT
NODE_ENGINE_RANGE="@@NODE_ENGINE_RANGE@@" # exact range (checked by the preflight)
NODE_MIN_MAJOR="@@NODE_MIN_MAJOR@@"       # coarse bash floor (checked before the preflight)
CLI_MIN_VERSION="@@CLI_MIN_VERSION@@"     # minimum CLI-engine (dependency) version

# Written to <bin>/.version — an INSTALL-FORMAT marker (copy-completed sentinel), NOT the app version.
INSTALL_VERSION="@@INSTALL_VERSION@@"
INSTALL_VERSION_FILE=".version"

# Distribution: standalone source = a DIRECT https URL to a `<APP_COMMAND>-<VERSION>.tgz` bundle
# (same naming as the local one, so the version comes from the filename). Empty = co-located only.
# The preflight ships INSIDE that bundle, so there is nothing else to fetch.
REMOTE_URL="${REMOTE_URL:-@@REMOTE_URL@@}"

# Download timeout (seconds) — curl's OWN --max-time (no hand-rolled watchdog). Every OTHER step is
# self-bounded by its callee: the preflight kills its own probes, `stop` has the daemon's drain budget.
DOWNLOAD_TIMEOUT="${INSTALL_DOWNLOAD_TIMEOUT:-@@DOWNLOAD_TIMEOUT@@}"

# Journal: captures EVERYTHING; the screen shows only cards. Lives at $HOME (outside the app dir)
# so a rollback never removes it; truncated at the very start of main; copied into
# <appRoot>/install.log on success.
LOGFILE="${RU_CODE_INSTALL_LOG:-$HOME/.$APP_SLUG-install.log}"
LOG_BASENAME="install.log"
LOCKFILE="$HOME/.$APP_SLUG-install.lock"

# Check fatality policy: "true" = a failed check BLOCKS; "false" = warn & continue.
NODE_FATAL="${INSTALL_NODE_FATAL:-@@NODE_FATAL@@}"
GIT_FATAL="${INSTALL_GIT_FATAL:-@@GIT_FATAL@@}"
CLI_FATAL="${INSTALL_CLI_FATAL:-@@CLI_FATAL@@}"

# Optional steps (env-overridable).
CREATE_STARTER_PROJECT="${INSTALL_CREATE_STARTER_PROJECT:-@@CREATE_STARTER_PROJECT@@}"
# Launcher persistence mode: "true" → each rc file gets ONE guarded line sourcing <bin>/env.sh
# (a PATH guard + a shell FUNCTION launcher with install-time-baked paths); "false" → the classic
# `export PATH="<bin>:$PATH"` line. The rc scrub recognises BOTH shapes in BOTH modes, so switching
# either way converges in one install and uninstall always cleans up. See 25-rc-path.sh.
USE_RC_SOURCED_LAUNCHER="${INSTALL_USE_RC_SOURCED_LAUNCHER:-@@USE_RC_SOURCED_LAUNCHER@@}"
START_AFTER_INSTALL="${INSTALL_START_AFTER:-@@START_AFTER_INSTALL@@}"
RESTART_AFTER_UPDATE="${INSTALL_RESTART_AFTER_UPDATE:-@@RESTART_AFTER_UPDATE@@}"

# CLI warm-up: when qwen's bin is present but its profile dir was never created (installed, never
# run), fire it once (best-effort, NON-FATAL, LOG-ONLY) to create the profile before COMMIT. All
# platforms; independent of CLI_FATAL. Timeout (seconds) bounds the one-shot; the bin is bg-killed.
PERFORM_CLI_WARM_UP="${INSTALL_PERFORM_CLI_WARM_UP:-@@PERFORM_CLI_WARM_UP@@}"
CLI_WARM_UP_TIMEOUT="${INSTALL_CLI_WARM_UP_TIMEOUT:-@@CLI_WARM_UP_TIMEOUT@@}"

# Hints / placeholders (author-filled) — bodies for the §10 message table.
CLI_INSTALL_HINT="@@CLI_INSTALL_HINT@@"
CLI_UPDATE_HINT="@@CLI_UPDATE_HINT@@"
PACKAGE_MISSING_HINT="@@PACKAGE_MISSING_HINT@@"
DOWNLOAD_FAILED_HINT="@@DOWNLOAD_FAILED_HINT@@"

# Contacts / credits (placeholders).
CREDITS_AUTHOR_FIO="@@CREDITS_AUTHOR_FIO@@"
CATALOG_URL="@@CATALOG_URL@@"             # catalog "like" link, shown in the credits box
SUPPORT_CHAT_URL="@@SUPPORT_CHAT_URL@@"   # credits box + crash block
AUTHOR_EMAIL="@@AUTHOR_EMAIL@@"           # credits box + crash block

# Presentation: cyan→violet wordmark gradient, "r;g;b".
GRADIENT_FROM="@@GRADIENT_FROM@@"
GRADIENT_TO="@@GRADIENT_TO@@"
BOX_INNER=63

# ============================================================================
# State (the renderer contract — logic SETS these; render_outcome draws them)
# ============================================================================
OS=""
ACTION=""                 # install | update | uninstall
STATE=""                  # SUCCESS | ALREADY_INSTALLED | BLOCKED_RECOMMENDATION | BLOCKED_CRASH | UNINSTALLED
RECOMMENDATIONS=()        # entries "reason|blocking" (blocking = true|false)
APP_VERSION=""            # available version = bundle FILENAME
INSTALLED_VERSION=""      # currently-installed app version (live --version)
WAS_INSTALLED=0           # 1 if a runnable app was present at start
OLD_APP_PRESENT=0         # starts =WAS_INSTALLED; flips to 0 the instant remove_bin runs in COMMIT
WAS_RUNNING=0             # 1 if the app was running and confirmed stopped (drives relaunch)
COMMITTED=0               # 1 once remove_bin ran — gates rollback teardown
# ru-code: 1 once the install is COMPLETE and its outcome card has been drawn. Set at exactly ONE
# line in main(), never inside render_outcome (which also serves blocked/crashed/already-installed
# runs — those must keep their rollback). From that line on the only thing left is the launch, so
# on_exit must never tear down a finished install and Ctrl+C means «stop waiting», not «abort».
INSTALL_FINAL=0
LAUNCH_OK=0               # 1 when the launcher answered `{"ok":true,…}`
LAUNCH_URL=""             # the pairing url from that same line (the ONLY other field we parse)

TEMP_DIR=""
EXTRACTED_DIR=""
ARCHIVE_PATH=""           # resolved local bundle tarball
INSTALL_DIR=""            # --install-dir override
DO_UNINSTALL=false
KEEP_SOURCE=false
DOWNLOADED=0              # 1 if we fetched the bundle (adds the "Загрузка" phase)
SOURCE_DIR=""             # the ./$REPO_NAME clone dir — removed on EVERY exit
BUNDLE_DIR=""             # dir holding preflight.mjs + dist-bundle/
NODE_PATH=""
LOCK_ACQUIRED=0

# Resolved by the node preflight (no brand literals live in this script):
APP_ROOT=""               # OUR_ROOT — the app folder, e.g. .../.ru-code
APP_BIN=""                # the command / wrapper name
APP_DIR_NAME=""           # basename(APP_ROOT), drives rc cleanup
LEGACY_ROOT=""            # orphaned {home}/.<app> to delete after relocation
NODE_OK=""                # 1 if node is compatible (gates the old app's `stop`)
BIN_DIR=""                # APP_ROOT/bin
CLI_JS=""                 # qwen bin (`node <CLI_JS>`); "" when qwen isn't detected
CONFIG_DIR=""             # qwen profile dir (primary) — the warm-up target
CONFIG_DIR_ALT=""         # Linux-relocation alternative profile dir (else ""); warm-up re-check only
PREFLIGHT_STATUS=1        # 0 only when the environment is compatible
# Per-check facts emitted by the preflight (ok|fail); policy applied by apply_check_policy.
CHECK_NODE=""
CHECK_GIT=""
CHECK_CLI=""
CHECK_CLI_KIND=""         # missing | old | ok — picks cli-install vs cli-update

# Presentation bookkeeping.
FAILED_PHASE=""           # key of the phase that failed (gets ✗ in the final frame)
CURRENT_PHASE=""          # key of the phase currently running (so a mid-bar fail can mark it)
PHASE_LEDGER=""           # "env download prepare copy verify" that were reached (space list)
CARD_SHOWN=0              # 1 once render_outcome ran — suppresses the trap's fallback crash card
ANIM_PID=""               # progress animator subprocess, killed on phase end / exit
INTERRUPTED=0             # 1 on INT/TERM — suppresses the fallback crash card on user cancel

command_exists() { command -v "$1" >/dev/null 2>&1; }
