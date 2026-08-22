# ============================================================================
# Phases (each wrapped by run_phase; the bar animates while they run)
# ============================================================================
# Phase prepare (Распаковка): unpack the bundle INTO the clone dir (OS temp may be write-blocked).
# The bundled preflight rides along. Extract only — validation waits until we know install vs update
# (below), so a missing-member bundle reports the honest «не обновлён» header. Non-destructive.
phase_prepare() {
  extract_archive
}

# Phase env (Проверка окружения): run the EXTRACTED preflight, apply the fatality policy. The bash
# node-floor + tar were already checked before extract. Still non-destructive (deferred removal, §9).
phase_checks() {
  run_preflight
  apply_check_policy || return 1
  warm_up_cli   # best-effort, non-fatal, log-only; creates qwen's profile before COMMIT
  return 0
}

# Phase copy (bar 55→85) — the minimal destructive window. Validate (now that the action is known,
# so a bad package keeps the honest header) → confirmed stop → remove old → install new.
phase_commit() {
  validate_archive
  if [ "$ACTION" = update ]; then
    confirmed_stop || fail_recommendation stop-failed
  fi
  remove_bin
  OLD_APP_PRESENT=0
  COMMITTED=1
  install_files
  create_wrapper
  # Scrub any prior/stale PATH lines BEFORE appending the fresh one (add_path only appends), so a
  # re-install/update leaves exactly one entry — the OLD `clean_old → add_path` contract. Runs after
  # the new bin is installed, so it never orphans a working app. No-op on a first install.
  clean_rc
  add_path || note path
  return 0
}

# Phase verify (bar 80→100): prove the new app runs, then optional starter + orphan cleanup.
phase_verify() {
  verify_app
  if [ "$CREATE_STARTER_PROJECT" = "true" ]; then
    create_and_init_starter_project || note starter
  fi
  remove_legacy_root
  return 0
}

# Start the installed app and REPORT what happened. The launcher is asked for a machine-readable
# answer (`--json`): in that mode it prints exactly ONE line on stdout and no banner —
#   {"ok":true,"url":"…","version":"…","pid":…}   |   {"ok":false,"error":"…","log":"…/daemon.log"}
#
# Why this shape:
#   · stdin from /dev/null — the documented install is `cat ru-code/install | bash`, so the script
#     itself is on stdin; the app inherited that pipe and it closed the moment the installer ended;
#   · NO `setsid`, NO `&` — setsid forks, so `$!` is a process that exits instantly, the wait breaks,
#     and the launcher's output lands AFTER the shell prompt (the reported "stuck terminal"). The
#     server child is spawned `detached` with its own log fds, so it survives us regardless and
#     never holds this stdout: the capture always closes on its own;
#   · NO timeout — the launcher is internally bounded, and §3.2 makes Ctrl+C the safe escape;
#   · NO redirect to a file — output stays a captured string; stderr already flows to the journal.
launch_app() {
  local entry="$BIN_DIR/$ENTRY_JS" wrapper="$BIN_DIR/$APP_BIN" line=""
  # NODE-DIRECT, never the sh wrapper. On machines where executing a script from <bin> is
  # denied («command not allowed») the wrapper is exactly the file that gets blocked, while
  # `node cli.js` runs — the same argv shape verify_app has already proven seconds earlier
  # (and the same shape the daemon itself uses to spawn its server child). The wrapper stays
  # a fallback only for the impossible case of a vanished NODE_PATH.
  if [ -f "$entry" ] && [ -n "$NODE_PATH" ]; then
    # `--json` is the ONLY flag the installer passes: since §3.4 the browser always opens, so
    # there is no caller-supplied argv left to forward (and no `"$@"` to expand under `set -u`).
    # NODE_FLAGS is word-split on purpose — same as verify_app.
    log "launch: $NODE_PATH $NODE_FLAGS $entry --json"
    printf '\n  %sЗапускаю приложение — подождите…%s\n' "$DIM" "$NC"
    line=$("$NODE_PATH" $NODE_FLAGS "$entry" --json </dev/null) || true
  elif [ -x "$wrapper" ]; then
    log "launch (wrapper fallback): $wrapper --json"
    printf '\n  %sЗапускаю приложение — подождите…%s\n' "$DIM" "$NC"
    line=$("$wrapper" --json </dev/null) || true
  else
    # Never silent: a "successful" install that starts nothing and says nothing is the worst
    # outcome — the user concludes the app is broken. Falls through to the classic card (state 4).
    log "launch skipped: $entry missing and $wrapper not executable"
    printf '\n  %s\n' "Не удалось запустить приложение автоматически: $wrapper" >&1
    printf '  %s\n' "Запустите вручную: $APP_BIN" >&1
    render_cta_pill
    return 0
  fi
  log "launch result: $line"

  # Parse ONLY `ok` and `url` — NEVER `error`. That field is free-form English text straight from a
  # failure, and a quote or a newline inside it is exactly where a shell parser breaks; the real
  # message belongs in daemon.log, which the failure banner points at. Extraction is plain bash
  # pattern matching: no eval, no node, no sed dialect to trip over on macOS/Git Bash.
  case "$line" in *'"ok":true'*|*'"ok": true'*) LAUNCH_OK=1 ;; *) LAUNCH_OK=0 ;; esac
  LAUNCH_URL=""
  case "$line" in
    *'"url":"'*)
      LAUNCH_URL="${line#*\"url\":\"}"      # everything after the opening quote
      LAUNCH_URL="${LAUNCH_URL%%\"*}"       # …up to the closing one
      ;;
  esac

  if [ "$LAUNCH_OK" = 1 ]; then render_launch_started; else render_launch_failed; fi
  return 0
}

# Ctrl+C AFTER the install is complete means «stop waiting for the app», never «undo the install» —
# armed on the same line that sets INSTALL_FINAL, so rollback is already disabled when it can fire.
launch_interrupted() {
  stop_animator
  render_launch_interrupted
  exit 0
}

# ============================================================================
# Exit trap — rollback (keeps the log), always remove the clone dir, release the lock
# ============================================================================
on_exit() {
  local status=$?
  stop_animator
  [ -n "${TEMP_DIR:-}" ] && rm -rf "$TEMP_DIR" 2>/dev/null || true
  remove_source_dir            # §0: clone dir removed on EVERY exit (success / fail / Ctrl-C)
  # ru-code: INSTALL_FINAL=1 means the install is COMPLETE and its card is drawn — the only thing
  # that can still fail is the launch, and a failed launch must never delete a working install.
  if [ "$status" -ne 0 ] && [ "$COMMITTED" = 1 ] && [ "${INSTALL_FINAL:-0}" != 1 ]; then
    # Roll back a partial new bin from an interrupted/failed COMMIT. Inline the path guard here
    # (never call remove_bin, whose guard-failure path would re-enter fail_crash inside the trap).
    case "${BIN_DIR:-}" in */"${APP_DIR_NAME:-__}"/bin) [ -d "$BIN_DIR" ] && rm -rf "$BIN_DIR" 2>/dev/null ;; esac
    clean_rc 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ "$CARD_SHOWN" != 1 ] && [ "${INTERRUPTED:-0}" != 1 ]; then
    STATE=BLOCKED_CRASH; recommend crash true; render_outcome || true
    status=2                   # an unexpected fallback crash is exit 2, not the inherited code
  fi
  release_lock
  return "$status"
}

finish() {                     # STATE already set → render + exit with the mapped code
  local rc=0
  render_outcome || rc=$?
  exit "$rc"
}

# ============================================================================
# main — the driver (§6)
# ============================================================================
main() {
  # LOG INIT — FIRST, so every flow is journaled and rewritten each run.
  : > "$LOGFILE" 2>/dev/null || LOGFILE="$(mktemp 2>/dev/null || echo /dev/null)"
  log "=== ${APP_DISPLAY_NAME} install ==="
  log "date:  $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
  log "os:    $(uname -a 2>/dev/null || true)"
  log "shell: ${SHELL:-}  bash: ${BASH_VERSION:-}"
  log "node:  $(command -v node 2>/dev/null || echo none)"
  log "pwd:   $(pwd)"
  log "args:  $*"
  exec 2>>"$LOGFILE"

  trap 'on_exit' EXIT
  trap 'INTERRUPTED=1; exit 130' INT
  trap 'INTERRUPTED=1; exit 143' TERM

  detect_os
  parse_args "$@"

  if [ "$OS" = "windows" ] && [ -z "${MSYSTEM:-}" ]; then
    fail_recommendation gitbash
  fi

  [ "$TTY" = 1 ] && banner   # live header above the progress bar; non-TTY stays quiet until the card

  # ru-code: LOCK FIRST — before ANY step that touches the clone dir. The documented invocation is
  # `git clone <repo> ru-code && cat ru-code/install | bash`, so two runs started from the same
  # directory share ONE clone dir, which is also SOURCE_DIR: the tree the winner extracts into and
  # copies FROM. Taking the lock earlier is what makes the loser harmless — it exits with SOURCE_DIR
  # still empty, so `remove_source_dir`'s own `[ -n "$SOURCE_DIR" ]` guard turns the teardown into a
  # no-op and the winner's tree survives. (release_lock is already LOCK_ACQUIRED-gated, so a loser
  # never releases the winner's lock.) Everything above this line — arg parsing, the OS/Git-Bash
  # rejection — touches nothing shared, which is why it stays outside.
  # Uninstall is covered too: do_uninstall bootstraps, extracts and deletes <bin>, so running it
  # against a live install was the same race with a worse ending.
  acquire_lock

  # Uninstall is its own terminal path (needs no bundle).
  if [ "$DO_UNINSTALL" = true ]; then
    do_uninstall
    finish
  fi

  # BOOTSTRAP — co-located clone or standalone REMOTE_URL download; locate the bundle + its version.
  bootstrap
  [ "$DOWNLOADED" = 1 ] && PHASE_LEDGER="${PHASE_LEDGER} download"

  # Prerequisites for extract + the bundled preflight. prep_temp ensures tar + a fresh extract dir
  # INSIDE the clone ($TMPDIR may be write-blocked; the clone is provably writable, removed on exit).
  check_node_floor
  prep_temp

  # PREPARE (extract+validate, non-destructive) → ENV (the extracted preflight + policy).
  run_phase prepare 0 30 "Распаковка"          phase_prepare
  if ! run_phase env 30 55 "Проверка окружения" phase_checks; then
    STATE=BLOCKED_RECOMMENDATION
    finish
  fi

  # ACTION DECISION — install / update / already-installed.
  decide_action
  if [ "$STATE" = ALREADY_INSTALLED ]; then
    remove_source_dir
    cp "$LOGFILE" "$APP_ROOT/$LOG_BASENAME" 2>/dev/null || true
    finish
  fi

  # COMMIT (destructive window) → VERIFY.
  run_phase copy   55 85  "Копирование"       phase_commit
  run_phase verify 85 100 "Проверка запуска"  phase_verify

  # ru-code: THE line (§3.2) — the install is COMPLETE and VERIFIED here, at `phase_verify`'s
  # success, which is the moment rollback stops being correct. It used to sit ~10 lines lower,
  # after `remove_source_dir` (an `rm -rf` over a git checkout plus a 34 MB tarball), the log copy
  # and the whole outcome card — with the INT/TERM traps still armed and COMMITTED=1. A Ctrl+C in
  # that window ran the rollback branch on a SUCCESSFUL update: the new install deleted, the old
  # one already gone, the PATH entries stripped, and nothing printed at all (INTERRUPTED=1
  # suppresses the fallback card). From here Ctrl+C means «stop waiting for the app», never «undo
  # the install».
  INSTALL_FINAL=1; trap 'launch_interrupted' INT

  # POST.
  remove_source_dir
  cp "$LOGFILE" "$APP_ROOT/$LOG_BASENAME" 2>/dev/null || true
  STATE=SUCCESS
  local rc=0
  render_outcome || rc=$?

  # The installer ALWAYS launches with the browser. The old `--no-browser` branch keyed off
  # WAS_RUNNING, which only means «`stop` returned 0» — and the daemon exits 0 when nothing was
  # running (confirmed_stop), so it fired even for users with no tab open. Accepted cost: updating
  # with a tab already open yields a second tab. (The IN-APP update path still passes --no-browser;
  # that one knows a tab exists.) A failed stop never gets here — phase_commit aborts first.
  local do_launch=0
  if [ "$ACTION" = update ] && [ "$WAS_RUNNING" = 1 ] && [ "$RESTART_AFTER_UPDATE" = "true" ]; then
    do_launch=1
  fi
  if [ "$ACTION" = install ] && [ "$START_AFTER_INSTALL" = "true" ]; then
    do_launch=1
  fi
  if [ "$do_launch" = 1 ]; then
    launch_app                 # renders launch banner 1, 2 or (missing shim) 4
  else
    render_cta_pill            # banner 4: the launch did not run — the classic card
  fi
  exit "$rc"
}

# ru-code: the test suite sources this file to exercise individual functions in a sandbox
# (fake HOME + fake preflight + temp dirs). RU_CODE_INSTALL_NO_MAIN=1 loads the function
# definitions without running the installer. Default (unset) = normal run.
[ "${RU_CODE_INSTALL_NO_MAIN:-}" = "1" ] || main "$@"
