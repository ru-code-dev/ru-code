# ============================================================================
# Outcome helpers — logic SETS state, then renders + exits (never printf ad-hoc).
# ============================================================================
fail_recommendation() {          # reason  → BLOCKED_RECOMMENDATION (exit 1)
  stop_animator
  [ -n "${CURRENT_PHASE:-}" ] && FAILED_PHASE="$CURRENT_PHASE"
  STATE=BLOCKED_RECOMMENDATION
  recommend "$1" true
  local rc=0; render_outcome || rc=$?; exit "$rc"
}
fail_crash() {                   # reason  → BLOCKED_CRASH (exit 2, trap rolls back)
  stop_animator
  [ -n "${CURRENT_PHASE:-}" ] && FAILED_PHASE="$CURRENT_PHASE"
  STATE=BLOCKED_CRASH
  recommend "$1" true
  local rc=0; render_outcome || rc=$?; exit "$rc"
}

# ============================================================================
# OS + args
# ============================================================================
detect_os() {
  case "$(uname -s)" in
    Linux*) OS="linux" ;;
    Darwin*) OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    *) fail_recommendation os ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      # ru-code: validated HERE, at the boundary, because this value becomes APP_ROOT and therefore
      # the parent of the tree `remove_bin` deletes. A relative path silently failed remove_bin's
      # pattern much later and surfaced as the generic crash card with no hint the flag caused it;
      # `$HOME` and the filesystem root are never install targets.
      --install-dir)
        [ $# -ge 2 ] || fail_recommendation usage
        case "$2" in
          /*) ;;
          *) error "Путь --install-dir должен быть абсолютным: $2"; fail_recommendation usage ;;
        esac
        case "$2" in
          /|/home|/Users|"$HOME") error "Недопустимый --install-dir: $2"; fail_recommendation usage ;;
        esac
        INSTALL_DIR="$2"; shift 2 ;;
      --uninstall) DO_UNINSTALL=true; shift ;;
      --keep-source) KEEP_SOURCE=true; shift ;;
      --help|-h) usage; exit 0 ;;
      *) fail_recommendation usage ;;
    esac
  done
}

# ============================================================================
# Single-instance lock ($HOME, stale-safe, portable: mkdir + PID — no flock on macOS)
# ============================================================================
acquire_lock() {
  local pid
  # ru-code: a lock dir with no pid inside is NOT a lock. If the pid write fails we tear our own
  # dir down and proceed lock-less, because the alternative is worse than either: the next run
  # reads an empty pid, concludes the lock is stale, deletes a LIVE owner's lock and takes it.
  if mkdir "$LOCKFILE" 2>/dev/null; then
    if printf '%s\n' "$$" > "$LOCKFILE/pid" 2>/dev/null; then
      LOCK_ACQUIRED=1; return 0
    fi
    rm -rf "$LOCKFILE" 2>/dev/null || true
    log "lock: could not record the pid ($LOCKFILE) — proceeding without lock"
    return 0
  fi
  pid=$(cat "$LOCKFILE/pid" 2>/dev/null || printf '')
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    fail_recommendation busy
  fi
  # stale lock (dead PID) → reclaim
  rm -rf "$LOCKFILE" 2>/dev/null || true
  if mkdir "$LOCKFILE" 2>/dev/null; then
    if printf '%s\n' "$$" > "$LOCKFILE/pid" 2>/dev/null; then
      LOCK_ACQUIRED=1; return 0
    fi
    rm -rf "$LOCKFILE" 2>/dev/null || true
    log "lock: could not record the pid after reclaim — proceeding without lock"
    return 0
  fi
  # ru-code: losing THIS mkdir usually means another run reclaimed the stale lock first — it is now
  # the live owner, so this run is `busy`, exactly as it would have been one line earlier. The
  # unconditional "proceed without lock" that used to be here let BOTH racers past, which is the one
  # situation the lock exists to prevent (two concurrent destructive runs, see the concurrency
  # tests).
  #
  # But `busy` is only correct when someone is genuinely there. The `rm -rf` above is
  # `|| true`-guarded and can fail silently — a lock directory this user cannot delete (created by
  # an earlier `sudo bash install`, so root-owned) reaches exactly this point too, and answering
  # `busy` for it would tell every future run to "wait for the other install" FOREVER, naming
  # nothing the user could act on. So the pid is re-read: a live owner is `busy`, anything else is
  # an unusable lock and falls through to the no-lock path, which is the same outcome HEAD gave.
  pid=$(cat "$LOCKFILE/pid" 2>/dev/null || printf '')
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    fail_recommendation busy
  fi
  if [ -d "$LOCKFILE" ]; then
    log "lock: $LOCKFILE exists, holds no live pid and could not be removed — proceeding without lock"
    return 0
  fi
  # $HOME unwritable — best-effort: proceed without a lock rather than block the install.
  log "lock: could not acquire ($LOCKFILE) — proceeding without lock"
  return 0
}
release_lock() {
  [ "$LOCK_ACQUIRED" = 1 ] && rm -rf "$LOCKFILE" 2>/dev/null || true
  LOCK_ACQUIRED=0
}

# ============================================================================
# Bootstrap — co-located clone, or standalone REMOTE_URL download → identical layout
# ============================================================================
bootstrap() {
  local dir
  if dir=$(cd "./$REPO_NAME" 2>/dev/null && pwd); then
    BUNDLE_DIR="$dir"; SOURCE_DIR="$dir"
  else
    [ -n "$REMOTE_URL" ] || fail_recommendation package
    case "$REMOTE_URL" in https://*) ;; *) fail_recommendation insecure ;; esac
    command_exists curl || fail_recommendation downloader
    download_bundle
    dir=$(cd "./$REPO_NAME" 2>/dev/null && pwd) || fail_recommendation network
    BUNDLE_DIR="$dir"; SOURCE_DIR="$dir"
  fi
  resolve_local_bundle
}

curl_fetch() {                   # url dest — curl's OWN --max-time bounds it (no watchdog)
  curl --fail --location --silent --show-error \
    --max-time "$DOWNLOAD_TIMEOUT" --retry 2 -o "$2" "$1" >/dev/null 2>&1
}

# Standalone: REMOTE_URL is a DIRECT link to a `<APP_COMMAND>-<VERSION>.tgz` bundle (preflight is
# bundled inside it). Download it into the fresh clone dir; the version comes from the filename, and
# extract+validate is the integrity backstop (a truncated download fails validation → crash).
download_bundle() {
  DOWNLOADED=1
  local dest="./$REPO_NAME" name
  name=$(basename "$REMOTE_URL")
  case "$name" in "$APP_COMMAND"-*.tgz) ;; *) fail_recommendation package ;; esac
  mkdir -p "$dest/dist-bundle" 2>/dev/null || fail_recommendation network
  curl_fetch "$REMOTE_URL" "$dest/dist-bundle/$name" || fail_recommendation network
  [ -s "$dest/dist-bundle/$name" ] || fail_recommendation network
}

resolve_local_bundle() {
  local dir="$BUNDLE_DIR" count
  shopt -s nullglob
  local list=( "$dir"/dist-bundle/*.tgz )
  shopt -u nullglob
  count=${#list[@]}
  [ "$count" -ge 1 ] || fail_recommendation package
  [ "$count" -le 1 ] || fail_crash corrupt   # exactly one bundle by contract
  ARCHIVE_PATH="${list[0]}"
  parse_bundle_version "$ARCHIVE_PATH"
  info "Дистрибутив: $ARCHIVE_PATH (версия $APP_VERSION)"
}

# Bundle version = FILENAME (APP_COMMAND has a dash and versions may too — strip prefix+suffix only).
parse_bundle_version() {
  local f="$1"
  f="${f##*/}"; f="${f#"$APP_COMMAND-"}"; APP_VERSION="${f%.tgz}"
  [ -n "$APP_VERSION" ] || fail_crash corrupt
}

remove_source_dir() {
  [ -n "$SOURCE_DIR" ] || return 0
  local dir="$SOURCE_DIR"
  SOURCE_DIR=""
  [ "$KEEP_SOURCE" = false ] || { info "Исходный каталог сохранён: $dir"; return 0; }
  case "$dir" in
    /|/home|/Users|"$HOME") warn "Отказ удалять: $dir"; return 0 ;;
  esac
  rm -rf "$dir" 2>/dev/null && info "Исходный каталог удалён: $dir" || true
}

# tar + a fresh extract temp INSIDE the clone (OS temp may be write-blocked). Shared by main and
# do_uninstall, so the "unpack setup" lives in one place.
prep_temp() {
  command_exists tar || fail_recommendation tar
  TEMP_DIR="$SOURCE_DIR/.install-tmp"
  rm -rf "$TEMP_DIR" 2>/dev/null || true
  mkdir -p "$TEMP_DIR" 2>/dev/null || fail_crash crash
}

# ============================================================================
# node floor (bash) + preflight (node, NO NODE_FLAGS)
# ============================================================================
check_node_floor() {
  # ru-code: prefer the CLI-SHIPPED node runtime (fixed per-OS path, injected at build time from
  # preflight's NODE_BIN_PATHS) over the OS node. Found+runnable ⇒ it becomes $NODE_PATH for the
  # WHOLE flow (preflight, warm-up, the generated wrapper/env.sh launcher, launch_app) — the OS
  # node is then not required at all. Missing/broken ⇒ the pre-existing OS-node flow, unchanged.
  local shipped=""
  case "$OS" in
    darwin)  shipped="@@SHIPPED_NODE_DARWIN@@" ;;
    linux)   shipped="@@SHIPPED_NODE_LINUX@@" ;;
    windows) shipped="@@SHIPPED_NODE_WIN32@@" ;;
  esac
  if [ -n "$shipped" ] && [ -f "$shipped" ]; then
    local sv
    sv=$("$shipped" -v 2>/dev/null | sed 's/^v//')
    if [ -n "$sv" ]; then
      local sm
      sm=$(printf '%s' "$sv" | cut -d. -f1)
      case "$sm" in ''|*[!0-9]*) sm=0 ;; esac
      if [ "$sm" -ge "$NODE_MIN_MAJOR" ]; then
        NODE_PATH="$shipped"
        log "node: shipped runtime $shipped (v$sv)"
        return 0
      fi
      log "node: shipped runtime $shipped is v$sv (< $NODE_MIN_MAJOR) — falling back to OS node"
    else
      log "node: shipped runtime present at $shipped but not runnable — falling back to OS node"
    fi
  fi
  command_exists node || fail_recommendation node-install
  local v
  v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  case "$v" in ''|*[!0-9]*) v=0 ;; esac
  [ "$v" -ge "$NODE_MIN_MAJOR" ] || fail_recommendation node-update
  NODE_PATH="$(command -v node 2>/dev/null || printf 'node')"
  log "node: OS runtime $NODE_PATH"
}

# The preflight ships INSIDE the bundle (extracted into the clone by phase_prepare), so we run the
# EXTRACTED copy. No timeout wrapper — the preflight self-bounds every probe (it kills its own
# node/git/cli spawns); the only way it "hangs" is a genuine crash, which surfaces as no OUR_ROOT.
run_preflight() {
  local script out rc=0
  script="${RU_CODE_PREFLIGHT:-$EXTRACTED_DIR/$PREFLIGHT_BASENAME}"
  [ -f "$script" ] || fail_crash crash

  out=$("$NODE_PATH" "$(to_node_path "$script")") || rc=$?
  PREFLIGHT_STATUS="$rc"

  APP_ROOT=$(printf '%s\n' "$out" | grep '^OUR_ROOT=' | head -n 1 | cut -d'=' -f2- || true)
  APP_BIN=$(printf '%s\n'  "$out" | grep '^APP_BIN='  | head -n 1 | cut -d'=' -f2- || true)
  NODE_OK=$(printf '%s\n'  "$out" | grep '^NODE_OK='  | head -n 1 | cut -d'=' -f2- || true)
  CLI_JS=$(printf '%s\n'   "$out" | grep '^CLI_JS='   | head -n 1 | cut -d'=' -f2- || true)
  CLI_SPAWN_KIND=$(printf '%s\n' "$out" | grep '^CLI_SPAWN_KIND=' | head -n 1 | cut -d'=' -f2- || true)
  CLI_IDENTITY=$(printf '%s\n' "$out" | grep '^CLI_IDENTITY=' | head -n 1 | cut -d'=' -f2- || true)
  CONFIG_DIR=$(printf '%s\n' "$out" | grep '^CONFIG_DIR=' | head -n 1 | cut -d'=' -f2- || true)
  CONFIG_DIR_ALT=$(printf '%s\n' "$out" | grep '^CONFIG_DIR_ALT=' | head -n 1 | cut -d'=' -f2- || true)
  LEGACY_ROOT=$(printf '%s\n' "$out" | grep '^LEGACY_ROOT=' | head -n 1 | cut -d'=' -f2- || true)
  CHECK_NODE=$(printf '%s\n' "$out" | grep '^CHECK_NODE=' | head -n 1 | cut -d'=' -f2- || true)
  CHECK_GIT=$(printf '%s\n'  "$out" | grep '^CHECK_GIT='  | head -n 1 | cut -d'=' -f2- || true)
  CHECK_CLI=$(printf '%s\n'  "$out" | grep '^CHECK_CLI='  | head -n 1 | cut -d'=' -f2- || true)
  CHECK_CLI_KIND=$(printf '%s\n' "$out" | grep '^CHECK_CLI_KIND=' | head -n 1 | cut -d'=' -f2- || true)

  APP_ROOT="${APP_ROOT//\\//}"
  LEGACY_ROOT="${LEGACY_ROOT//\\//}"
  [ -n "$INSTALL_DIR" ] && APP_ROOT="${INSTALL_DIR//\\//}"
  [ -n "$APP_ROOT" ] || fail_crash crash    # no path / process error / timeout

  BIN_DIR="${APP_ROOT}/bin"
  APP_DIR_NAME=$(basename "$APP_ROOT")
}

# Apply the installer's per-check fatality policy to the preflight facts. Populates RECOMMENDATIONS
# (blocking flag per *_FATAL); returns 1 if any policy-fatal check failed.
apply_check_policy() {
  local blocked=0
  if [ "${CHECK_NODE:-ok}" = fail ]; then
    recommend node-update "$NODE_FATAL"; [ "$NODE_FATAL" = true ] && blocked=1
  fi
  if [ "${CHECK_GIT:-ok}" = fail ]; then
    recommend git "$GIT_FATAL"; [ "$GIT_FATAL" = true ] && blocked=1
  fi
  if [ "${CHECK_CLI:-ok}" = fail ]; then
    case "${CHECK_CLI_KIND:-missing}" in
      missing)
        # qwen bin absent → matters ONLY if the CLI is required; not-required + missing = skip (N/A).
        if [ "$CLI_FATAL" = true ]; then recommend cli-install true; blocked=1; fi
        ;;
      broken)
        recommend cli-broken "$CLI_FATAL"; [ "$CLI_FATAL" = true ] && blocked=1
        ;;
      slow)
        recommend cli-slow "$CLI_FATAL"; [ "$CLI_FATAL" = true ] && blocked=1
        ;;
      *)
        # old + anything unknown → qwen present but OLD → warn always; STOP (block) when required.
        recommend cli-update "$CLI_FATAL"; [ "$CLI_FATAL" = true ] && blocked=1
        ;;
    esac
  fi
  [ "$blocked" = 0 ]
}

# qwen bin present but its profile dir was never created (installed, never run) → fire it once so the
# profile exists before the app first spawns it. BEST-EFFORT, NON-FATAL, LOG-ONLY: the screen shows
# only the generic phase already animating; every outcome (created / still missing / timed out) is
# logged and swallowed. All platforms; independent of CLI_FATAL. Runs REAL qwen (may hit auth/network
# and simply get bg-killed at the timeout having created nothing — that is fine). No `with_timeout`:
# a targeted background watchdog kills just this one pid.
warm_up_cli() {
  [ "$PERFORM_CLI_WARM_UP" = true ] || return 0
  [ -n "$CLI_JS" ] || return 0                                   # bin not detected → nothing to warm
  [ -n "$CONFIG_DIR" ] && [ -d "$CONFIG_DIR" ] && return 0       # profile already exists → skip
  log "warm-up: run [${CLI_SPAWN_KIND:-node}] $CLI_JS -p test (profile dir missing: $CONFIG_DIR)"
  # ru-code: env prefix and MCP-off flags are GENERATED from the branding CLI registry
  # (scripts/build-installer.ts) — the same rows the app injects on every spawn. Without the
  # profile dir the warm-up creates nothing (or the wrong dir); without the allowlist flag the CLI
  # connects and awaits every MCP server the user configured before it does any work.
  # The invoke kind comes from the preflight's CLI_SPAWN_KIND (the app's ONE dispatcher, so bash
  # can never disagree with it): node/"" = the historic node line; cmd|direct = run the bin itself
  # (git-bash launches a .cmd through cmd.exe on its own; a POSIX script runs via its shebang).
  # The identity value (CLI_PASS_IDENTITY) is exported under the registry-baked name only when
  # present — never written as an empty variable. `exec` keeps $pid = the CLI itself, so the
  # watchdog's TERM still hits the real process, and bash exports the assignment prefix across it.
  (
    [ -n "$CLI_IDENTITY" ] && export @@CLI_IDENTITY_ENV_NAME@@="$CLI_IDENTITY"
    case "$CLI_SPAWN_KIND" in
      cmd|direct) @@CLI_WARM_UP_ENV@@ exec "$CLI_JS" @@CLI_MCP_OFF_ARGS@@ -p "test" ;;
      *) @@CLI_WARM_UP_ENV@@ exec "$NODE_PATH" $NODE_FLAGS "$CLI_JS" @@CLI_MCP_OFF_ARGS@@ -p "test" ;;
    esac
  ) >>"$LOGFILE" 2>&1 &
  local pid=$!
  ( sleep "$CLI_WARM_UP_TIMEOUT"; kill -TERM "$pid" 2>/dev/null || true ) &
  local killer=$!
  wait "$pid" 2>/dev/null || true
  kill -TERM "$killer" 2>/dev/null || true                       # stop the watchdog if qwen exited first
  wait "$killer" 2>/dev/null || true
  local d
  for d in "$CONFIG_DIR" "$CONFIG_DIR_ALT"; do
    [ -n "$d" ] && [ -d "$d" ] && log "warm-up: profile created at $d"
  done
  return 0
}

# ============================================================================
# Version check + action decision (§2)
# ============================================================================
read_installed_version() {
  INSTALLED_VERSION=""; WAS_INSTALLED=0
  [ -n "$BIN_DIR" ] && [ -f "$BIN_DIR/$ENTRY_JS" ] || return 0
  local v
  v=$("$NODE_PATH" $NODE_FLAGS "$BIN_DIR/$ENTRY_JS" --version 2>/dev/null) || return 0
  # Effect's CLI prints `<name> v<version>` (e.g. "ru-code v1.1.2"), so extract the bare semver
  # rather than deleting whitespace — otherwise "ru-code v1.1.2" never equals the bundle "1.1.2"
  # and every run falsely reads as an update. Handles bare / v-prefixed / pre-release forms too.
  # `grep -m1` = first match only; `|| v=""` so a no-match (grep exit 1) can't trip `set -e`.
  v=$(printf '%s' "$v" | grep -m1 -oE '[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?') || v=""
  [ -n "$v" ] || return 0
  INSTALLED_VERSION="$v"; WAS_INSTALLED=1; OLD_APP_PRESENT=1
}

decide_action() {
  read_installed_version
  if [ "$WAS_INSTALLED" = 1 ]; then
    if [ "$INSTALLED_VERSION" = "$APP_VERSION" ]; then
      ACTION=""; STATE=ALREADY_INSTALLED; return 0
    fi
    ACTION=update
  else
    ACTION=install
  fi
  return 0
}

# ============================================================================
# Confirmed stop (update only) — checks the exit code (daemon exits non-zero if it survived)
# ============================================================================
confirmed_stop() {
  [ "$NODE_OK" = "1" ] || return 0
  [ -n "$BIN_DIR" ] && [ -f "$BIN_DIR/$ENTRY_JS" ] || return 0
  info "Остановка приложения: $BIN_DIR"
  # The daemon self-bounds its shutdown (SIGTERM → drain → SIGKILL) and exits non-zero if it
  # survived — so we just call it directly and trust its exit code. No external timeout needed.
  local rc=0
  "$NODE_PATH" $NODE_FLAGS "$BIN_DIR/$ENTRY_JS" stop >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then return 1; fi   # survived
  WAS_RUNNING=1
  return 0
}

# ============================================================================
# stop / remove (preserved verbatim — equivalence-critical guards)
# ============================================================================
# rc scrub + PATH write live in their own part (25-rc-path.sh) — that logic is safety-critical and
# has its own law suite; everything here is process/directory teardown.
stop_daemon_at() {
  local bin="$1"
  [ "$NODE_OK" = "1" ] || return 0
  [ -n "$bin" ] && [ -f "$bin/$ENTRY_JS" ] || return 0
  info "Остановка приложения: $bin"
  "$NODE_PATH" $NODE_FLAGS "$bin/$ENTRY_JS" stop >/dev/null 2>&1 || true
}
stop_old() {
  stop_daemon_at "$BIN_DIR"
  if [ -n "${LEGACY_ROOT:-}" ]; then stop_daemon_at "$LEGACY_ROOT/bin"; fi
}

remove_bin() {
  [ -n "$BIN_DIR" ] && [ -d "$BIN_DIR" ] || return 0
  # A refused delete is an unexpected safety trip → crash (exit 2), not a silent exit-1.
  [ -n "$APP_DIR_NAME" ] || { error "Защита: имя каталога приложения не определено."; fail_crash crash; }
  # ru-code: the suffix test alone is TAUTOLOGICAL — BIN_DIR is "$APP_ROOT/bin" and APP_DIR_NAME is
  # basename "$APP_ROOT", so every absolute path satisfies it. `--install-dir "$HOME"` therefore
  # resolved to `rm -rf "$HOME/bin"`, destroying a near-universal user-scripts directory from one
  # mistyped flag, under a guard whose own message promises it refuses suspicious paths. These are
  # the refusals `remove_source_dir` and `remove_legacy_root` have carried all along.
  case "$BIN_DIR" in
    /|/home|/Users|"$HOME"|"$HOME"/bin)
      error "Защита: отказ удалять системный путь: $BIN_DIR"; fail_crash crash ;;
  esac
  case "$BIN_DIR" in
    */"$APP_DIR_NAME"/bin) ;;
    *) error "Защита: отказ удалять подозрительный путь: $BIN_DIR"; fail_crash crash ;;
  esac
  info "Удаление старой установки: $BIN_DIR"
  rm -rf "$BIN_DIR"
}

remove_legacy_root() {
  [ -n "${LEGACY_ROOT:-}" ] && [ -d "$LEGACY_ROOT" ] || return 0
  case "$LEGACY_ROOT" in
    */work/*) warn "Отказ удалять: $LEGACY_ROOT — это целевой каталог установки (work), не легаси"; return 0 ;;
  esac
  [ -n "$APP_DIR_NAME" ] || { warn "Отказ удалять: имя каталога приложения не определено"; return 0; }
  case "$LEGACY_ROOT" in
    /|/home|/Users|"$HOME") warn "Отказ удалять: $LEGACY_ROOT"; return 0 ;;
  esac
  case "$LEGACY_ROOT" in
    */"$APP_DIR_NAME") ;;
    *) warn "Отказ удалять подозрительный LEGACY_ROOT: $LEGACY_ROOT"; return 0 ;;
  esac
  info "Удаление старой установки в домашнем каталоге: $LEGACY_ROOT"
  rm -rf "$LEGACY_ROOT" 2>/dev/null || true
}

# ============================================================================
# Archive -> copy -> wrapper -> verify (preserved verbatim)
# ============================================================================
# ru-code: the bundle root is the directory holding the POINTER (`current.json`) — the marker of a
# complete <bin> tree. It is either the extract dir itself or one level deep (`package/`). Anchoring
# on the pointer (not on cli.js) is deliberate: `cli.js` exists BOTH at the root (the wrapper) and
# inside every versions/<v>, so a name search could pick the wrong root.
extract_archive() {
  local extract_dir="${TEMP_DIR}/extracted" nested
  mkdir -p "$extract_dir"
  info "Распаковка архива..."
  tar xzf "$ARCHIVE_PATH" -C "$extract_dir" 2>/dev/null || fail_crash corrupt
  if [ -f "$extract_dir/$POINTER_JSON" ]; then EXTRACTED_DIR="$extract_dir"; return; fi
  # ru-code: `|| true` because `head -1` closes the pipe as soon as it has its line, so `find` can
  # die on SIGPIPE — and under `set -o pipefail` that failure becomes the whole substitution's,
  # tripping errexit on a path that actually succeeded. Only one match is possible at this depth
  # today, which is the only reason it has not fired.
  nested=$(find "$extract_dir" -maxdepth 2 -name "$POINTER_JSON" -type f 2>/dev/null | head -1 || true)
  [ -n "$nested" ] || fail_crash corrupt
  EXTRACTED_DIR="$(dirname "$nested")"
}

# The archive must be a complete install: wrapper + pointer + the version payload the bundle
# filename promised. Anything missing is a corrupt bundle — never a partial copy onto the machine.
validate_archive() {
  local missing=0 part payload="$VERSIONS_DIR/$APP_VERSION"
  for part in "$ENTRY_JS" "$POINTER_JSON" "$payload/$ENTRY_JS" "$payload/package.json" \
              "$payload/client" "$payload/node_modules"; do
    [ -e "$EXTRACTED_DIR/$part" ] || { error "В архиве отсутствует: $part"; missing=1; }
  done
  [ "$missing" -eq 0 ] || fail_crash corrupt
}

# Copy the extracted tree into <bin> VERBATIM — the bundle already is the installed layout, so
# there is no per-file knowledge here. The install-time preflight is the one thing dropped (it ran
# from the extract dir and has no runtime role), and `.version` is appended as the copy-completed
# sentinel.
install_files() {
  info "Установка: $BIN_DIR"
  mkdir -p "$BIN_DIR"
  cp -R "$EXTRACTED_DIR/." "$BIN_DIR/"
  rm -f "$BIN_DIR/$PREFLIGHT_BASENAME"
  printf '%s\n' "$INSTALL_VERSION" > "$BIN_DIR/$INSTALL_VERSION_FILE"
}

# The PATH shim `<bin>/<APP_BIN>` — a 4-line sh launcher for `node <bin>/cli.js`. Distinct from the
# app's own frozen launcher (also `cli.js`): this one only carries the node flags and is rewritten by
# every install; the frozen one resolves which version to boot.
# The cli.js path is a NODE argument: on Windows the runtime `dirname "$0"` form is a POSIX path
# node.exe misreads when Git Bash path translation is off, so the ABSOLUTE node-form path is baked
# instead (the wrapper is rewritten by every install — baking loses nothing). POSIX keeps the
# relocatable dirname form, byte-identical to before.
create_wrapper() {
  local node_quoted cli_arg
  node_quoted=$(printf "'%s'" "$(printf '%s' "$NODE_PATH" | sed "s/'/'\\\\''/g")")
  if [ "$OS" = "windows" ]; then
    cli_arg=$(printf "'%s'" "$(printf '%s' "$(to_node_path "$BIN_DIR/$ENTRY_JS")" | sed "s/'/'\\\\''/g")")
  else
    cli_arg="\"\$(dirname \"\$0\")/${ENTRY_JS}\""
  fi
  cat > "$BIN_DIR/$APP_BIN" <<WRAPPER
#!/bin/sh
if [ -x ${node_quoted} ] || [ -f ${node_quoted} ]; then
  exec ${node_quoted} ${NODE_FLAGS} ${cli_arg} "\$@"
fi
exec node ${NODE_FLAGS} ${cli_arg} "\$@"
WRAPPER
  chmod +x "$BIN_DIR/$APP_BIN"
}

verify_app() {
  "$NODE_PATH" $NODE_FLAGS "$BIN_DIR/$ENTRY_JS" --version >/dev/null 2>&1 \
    || fail_crash crash
}

create_and_init_starter_project() {
  local proj="${APP_ROOT}/Project"
  command_exists git || { warn "git не найден — стартовый проект пропущен."; return 0; }
  [ -d "$proj/.git" ] && { info "Стартовый проект уже существует: $proj"; return 0; }
  mkdir -p "$proj" 2>/dev/null || { warn "Не удалось создать стартовый проект: $proj"; return 1; }
  (
    cd "$proj" || exit 1
    git init -q 2>/dev/null || exit 1
    git config user.email "dev@${APP_SLUG}.local" 2>/dev/null || true
    git config user.name "$APP_DISPLAY_NAME" 2>/dev/null || true
    git config commit.gpgsign false 2>/dev/null || true
    printf '# %s\n' "$APP_DISPLAY_NAME" > README.md 2>/dev/null || true
    git add -A 2>/dev/null || true
    git commit -q -m "Первый коммит" 2>/dev/null || exit 1
  ) && { info "Стартовый проект создан: $proj"; return 0; } \
    || { warn "Стартовый проект инициализирован не полностью: $proj"; return 1; }
}

do_uninstall() {
  ACTION=uninstall
  check_node_floor
  # The path resolver (preflight) ships INSIDE the bundle, so locate + extract it to run it — the
  # cloned repo still carries dist-bundle/. Extract goes into the clone (OS temp may be blocked).
  bootstrap
  prep_temp
  extract_archive
  run_preflight
  read_installed_version
  stop_old
  remove_bin
  remove_legacy_root
  clean_rc
  STATE=UNINSTALLED
}
