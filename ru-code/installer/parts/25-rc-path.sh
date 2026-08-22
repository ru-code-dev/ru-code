# ============================================================================
# PATH persistence — the shell rc files. SAFETY-CRITICAL.
# ============================================================================
# This part owns the ONLY mechanism by which `<APP_BIN>` becomes runnable in a new terminal: ONE
# line of ours inside the user's shell rc files. There is no registry write, no /etc/profile.d drop,
# no symlink into /usr/local/bin — if the line here is wrong or inert, the user gets "command not
# found" from an install that reported success.
#
# That line has TWO generations, selected by USE_RC_SOURCED_LAUNCHER (baked at build time):
#
#   "false" (classic)   export PATH="<bin>:$PATH"
#   "true"  (sourced)   [ -f "<bin>/env.sh" ] && . "<bin>/env.sh"
#
# In sourced mode the volatile logic lives in `<bin>/env.sh` (written by write_env_file on every
# install): a duplicate-proof PATH prepend plus a shell FUNCTION named `<APP_BIN>` that runs
# `node <bin>/cli.js` directly, every path resolved and BAKED at install time. A function is
# resolved by the shell before any PATH lookup, so launching never executes the wrapper FILE — which
# is what makes the command work in environments where running a user-writable script file is not
# permitted while `node <file>` is. The rc line itself stays immutable; env.sh is the only thing a
# reinstall has to update, and it dies with <bin> on uninstall (remove_bin), needing no rc edit.
#
# The SCRUB recognises BOTH generations ALWAYS, in BOTH modes — every removal is keyed on the
# `/$APP_DIR_NAME/bin` marker, never on the current switch value — so flipping the switch either way
# converges every rc file in one install, and uninstall cleans up whichever shape is present.
#
# It edits files that belong to the user and that their login depends on, so it is built as a state
# machine with two guarantees and nothing left to chance.
#
# GUARANTEE 1 — ONE PURE RENDERER. There is no "append" step and no "scrub" step that could disagree.
# `rc_render` maps a file's bytes to the bytes it should have, and every write goes through it:
#
#     rc_render(content, want_line) =
#         drop our export spans, character-exactly; when a line vanishes entirely, also drop the ONE
#         blank separator line we ourselves wrote in front of it
#       + terminate the last line (a text file ends with a newline)
#       + append (blank separator, unless the file is empty) + our line   [only when want_line=1]
#
# Because the result is a pure function of the file's NON-ours content, three laws hold BYTE-EXACTLY,
# and rcLaws.test.ts asserts all three over every corpus shape:
#
#     render(render(x)) == render(x)              nothing can accumulate — not blank lines, not
#                                                 duplicate exports, no matter how many installs run
#     render(x, 0)      == x, modulo a final \n   install→uninstall gives the user their bytes back
#     render(any older shape) == render(canonical) any prior layout converges in ONE pass: the
#                                                 pre-fix glued form, a stale path from a relocated
#                                                 root, the legacy `# <APP_BIN> v…` marker, two copies
#
# GUARANTEE 2 — WE NEVER REPLACE A FILE. The write truncates the existing inode (`cat staged > "$rc"`)
# instead of renaming a temp file over it. Measured difference on a user's rc:
#
#                     symlink            inode      mode        hardlinks
#     rename (mv)     destroyed          replaced   600 -> 644  2 -> 1
#     in place (>)    intact, writes     preserved  preserved   preserved
#                     through to target
#
# The rename form silently widened permissions and, for the very common `~/.bashrc -> ~/dotfiles/…`
# setup, severed the link and left our stale line behind in the dotfiles repo. In-place writing cannot
# do either. What rename bought — never exposing a half-written file — is covered instead by staging
# the bytes first (so a full disk fails before the target is touched), keeping `<rc>.bak`, and
# verifying the result byte-for-byte afterwards.
#
# A file we cannot write is SKIPPED with a warning, never forced: no chmod, no unlink, no fallback to
# rename. Read-only means read-only.
#
# Portability: macOS ships bash 3.2 with BSD userland, so the text handling uses ZERO external text
# tools — pure bash parameter expansion, no sed/awk/GNU-only grep flags, no arrays, no bash-4 syntax.
# `cmp` is the one exception and it is byte-comparison, not a text dialect, so it behaves identically
# everywhere. rcLaws.test.ts asserts this statically on this file.
#
# Full background: SPECS/todo/add path-problems.md.

# Superset of every file add_path can write/create — same list on all platforms so uninstall scrubs
# whatever was created, leaving no orphaned PATH line. `$ZDOTDIR/.zshrc` is appended only when ZDOTDIR
# points elsewhere (add_path writes it in that case too).
rc_files() {
  printf '%s\n' \
    "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.bash_login" \
    "$HOME/.profile" "$HOME/.zshrc" "$HOME/.zprofile"
  [ -n "${ZDOTDIR:-}" ] && [ "$ZDOTDIR" != "$HOME" ] && printf '%s\n' "$ZDOTDIR/.zshrc"
}

# ----------------------------------------------------------------------------
# Pure string logic — no filesystem, no subprocess
# ----------------------------------------------------------------------------

# The two markers that make a line ours. Identical to the pair rc_dirty greps the FILE for, so the
# per-line pass can never disagree with the file-level pre-check.
rc_line_has_marker() {
  case "$1" in
    *"/$APP_DIR_NAME/bin"*) return 0 ;;
    *"# $APP_BIN v"*) return 0 ;;
  esac
  return 1
}

# Excise EVERY occurrence of our export span from one line and print what remains.
#
# The span is bounded, not guessed: it starts at `export PATH="` and ends at the FIRST `:$PATH"` after
# it, and it counts as ours only when the path between the two contains `/$APP_DIR_NAME/bin`. That
# makes the match independent of the CURRENT bin dir, so a stale line from an earlier install (a
# different home, a relocated root, an --install-dir run) is scrubbed just as reliably.
#
# Someone else's PATH export on the same line is reassembled byte-for-byte and scanning continues, so
# a line holding both survives with only our part gone.
#
# Bash 3.2 note: `${v%%"$pat"*}` / `${v#*"$pat"}` are literal (non-glob) because the pattern is
# quoted — no regex, no external tool, so BSD vs GNU cannot matter.
rc_strip_our_span() {
  local rest="$1" out="" head tail_after inner
  local open='export PATH="' close=':$PATH"'
  while :; do
    case "$rest" in
      *"$open"*) ;;
      *) break ;;
    esac
    head="${rest%%"$open"*}"                  # text before this occurrence
    tail_after="${rest#*"$open"}"             # text after the opening token
    case "$tail_after" in
      *"$close"*) ;;
      *) break ;;                             # unterminated — not our shape, leave the rest alone
    esac
    inner="${tail_after%%"$close"*}"          # the path between the tokens
    case "$inner" in
      *"/$APP_DIR_NAME/bin"*)
        out="$out$head"                        # ours → drop [open..close]
        ;;
      *)
        out="$out$head$open$inner$close"       # not ours → keep verbatim
        ;;
    esac
    rest="${tail_after#*"$close"}"
  done
  printf '%s' "$out$rest"
}

# Excise EVERY occurrence of our SOURCED-generation span from one line and print what remains.
#
# The span is `[ -f "<path>" ] && . "<path>"` — both paths byte-identical and containing
# `/$APP_DIR_NAME/bin` — exactly what rc_source_line composes. Same properties as
# rc_strip_our_span: bounded by literal tokens (never guessed), independent of the CURRENT bin dir
# (a stale line from a relocated root or an --install-dir run is scrubbed just as reliably), and a
# foreign guard on the same line (someone else's `[ -f … ] && . …`) is reassembled byte-for-byte.
rc_strip_source_span() {
  local rest="$1" out="" head after path1 mid_after path2
  local open='[ -f "' mid='" ] && . "' close='"'
  while :; do
    case "$rest" in
      *"$open"*) ;;
      *) break ;;
    esac
    head="${rest%%"$open"*}"                  # text before this occurrence
    after="${rest#*"$open"}"                  # text after the opening token
    case "$after" in
      *"$mid"*) ;;
      *) break ;;                             # no middle token — not our shape, leave the rest alone
    esac
    path1="${after%%"$mid"*}"                 # the guarded path
    mid_after="${after#*"$mid"}"
    case "$mid_after" in
      *"$close"*) ;;
      *) break ;;                             # unterminated — not our shape
    esac
    path2="${mid_after%%"$close"*}"           # the sourced path
    if [ "$path1" = "$path2" ]; then
      case "$path1" in
        *"/$APP_DIR_NAME/bin"*)
          out="$out$head"                      # ours → drop the whole [open..close] span
          rest="${mid_after#*"$close"}"
          continue
          ;;
      esac
    fi
    # Not ours: emit through this opening token and rescan the remainder, so a later occurrence on
    # the same line is still found.
    out="$out$head$open"
    rest="$after"
  done
  printf '%s' "$out$rest"
}

# Is a string empty or only whitespace? Drives both "the line was wholly ours → drop it" (so an
# INDENTED line of ours disappears exactly like an unindented one) and separator retraction.
rc_is_blank() {
  case "$1" in
    '') return 0 ;;
    *[![:space:]]*) return 1 ;;
    *) return 0 ;;
  esac
}

# ----------------------------------------------------------------------------
# The renderer — the single source of truth for what an rc file should contain
# ----------------------------------------------------------------------------
# Prints the rendered bytes for $1 to stdout. $2 = 1 to include our line, 0 to leave it out
# (uninstall). Read-only: it never touches the filesystem.
#
# One deferred line ("pending") is what implements separator retraction without arrays: when our line
# is dropped, the blank line in front of it has not been committed yet, so discarding it is exact and
# cannot reach any further back. Only a line WE wrote can be retracted this way, because our writes
# are the only ones that put a blank line immediately before our export.
#
# Committing every line with a trailing newline is also what terminates a final unterminated line —
# the normalization that makes the fixpoint law hold for the no-trailing-newline files this whole part
# exists for.
#
# `while IFS= read -r line || [ -n "$line" ]` is mandatory: without the `|| [ -n … ]` bash drops a
# final line that has no newline, which is the same data loss in a different disguise.
rc_render() {
  local file="$1" want="$2"
  local line stripped emit out="" pending="" has_pending=0 dropped
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      dropped=0; emit="$line"
      if rc_line_has_marker "$line"; then
        # BOTH generations are excised, always — the switch never gates the scrub.
        stripped="$(rc_strip_our_span "$line")"
        stripped="$(rc_strip_source_span "$stripped")"
        if [ "$stripped" = "$line" ]; then
          dropped=1                            # marker we cannot parse → historic whole-line delete
        elif rc_is_blank "$stripped"; then
          dropped=1                            # the line was wholly ours
        else
          emit="$stripped"                     # ours was glued onto content we must keep
        fi
      fi
      if [ "$dropped" = 1 ]; then
        # Retract our own separator, and only ours: it is the uncommitted line directly above.
        if [ "$has_pending" = 1 ] && rc_is_blank "$pending"; then has_pending=0; fi
        continue
      fi
      if [ "$has_pending" = 1 ]; then out="$out$pending
"; fi
      pending="$emit"; has_pending=1
    done < "$file"
  fi
  if [ "$has_pending" = 1 ]; then out="$out$pending
"; fi
  if [ "$want" = 1 ]; then
    if [ -z "$out" ]; then
      out="$PATH_LINE
"
    else
      out="$out
$PATH_LINE
"
    fi
  fi
  printf '%s' "$out"
}

# ----------------------------------------------------------------------------
# The writer — stage, compare, write IN PLACE, verify
# ----------------------------------------------------------------------------
# Bring $1 to its rendered form ($2 = want_line). Returns 0 when the file ends up correct (including
# when it already was), 1 when it could not be written — and in that case the file is untouched.
#
# Staging first is deliberate: rendering into `<rc>.tmp` proves the bytes and the free space exist
# BEFORE the real file is opened for truncation, so the only failure that can reach the rc file is a
# write error on bytes already known to fit. `cmp` then makes an unchanged file a true no-op — we do
# not rewrite, do not back up, and do not touch mtime when there is nothing to change.
# RC_APPLY_CHANGED is set by every rc_apply call: 1 when the file was rewritten, 0 when it already
# held exactly the rendered bytes. Callers log from this instead of re-deriving the answer, so the
# message can never disagree with what happened on disk.
RC_APPLY_CHANGED=0

rc_apply() {
  local rc="$1" want="$2" staged="$1.tmp" backup="$1.bak"
  RC_APPLY_CHANGED=0
  [ -n "$rc" ] || return 1

  if ! rc_render "$rc" "$want" > "$staged" 2>/dev/null; then
    rm -f "$staged" 2>/dev/null || true
    log "PATH: не удалось подготовить содержимое для $rc"
    return 1
  fi

  if cmp -s "$staged" "$rc" 2>/dev/null; then
    rm -f "$staged" 2>/dev/null || true
    return 0                                   # already exactly right — touch nothing
  fi
  RC_APPLY_CHANGED=1

  cp "$rc" "$backup" 2>/dev/null || true       # missing file → nothing to back up

  # IN PLACE: truncate and rewrite the SAME inode. Follows a symlink to its target, so a dotfiles
  # setup keeps its link; keeps mode and hardlinks, which a rename would silently change.
  if ! cat "$staged" > "$rc" 2>/dev/null; then
    rm -f "$staged" 2>/dev/null || true
    log "PATH: НЕТ ПРАВ на запись $rc — пропущен"
    return 1
  fi

  # Verify the bytes that actually landed. A mismatch here means the write was truncated (a full disk
  # is the realistic cause), so put the original back from the backup we just took.
  if ! cmp -s "$staged" "$rc" 2>/dev/null; then
    cat "$backup" > "$rc" 2>/dev/null || true
    rm -f "$staged" 2>/dev/null || true
    log "PATH: запись в $rc не подтвердилась — файл восстановлен из $backup"
    return 1
  fi

  rm -f "$staged" 2>/dev/null || true
  return 0
}

# Does this file currently carry any of our bytes? Used only to decide whether a scrub has anything to
# do, so an untouched file is never rewritten or backed up.
rc_dirty() {
  grep -qF -e "/$APP_DIR_NAME/bin" -e "# $APP_BIN v" "$1" 2>/dev/null
}

# ----------------------------------------------------------------------------
# Scrub (uninstall, and the pre-write pass over files add_path does not target)
# ----------------------------------------------------------------------------
# Render every rc file WITHOUT our line. User content is preserved to the byte — a line our export had
# been glued onto keeps its own text, and only the blank separator we wrote is removed with it.
clean_rc() {
  [ -n "$APP_DIR_NAME" ] || return 0
  local rc
  while IFS= read -r rc; do
    [ -f "$rc" ] || continue
    rc_dirty "$rc" || continue
    if rc_apply "$rc" 0; then
      info "Очищено $rc (резервная копия: $rc.bak)"
    else
      warn "Нет прав на изменение $rc — пропущен"
    fi
  done < <(rc_files)
}

# ----------------------------------------------------------------------------
# Write
# ----------------------------------------------------------------------------
to_msys_path() {
  local p="$1"
  if [[ "$p" =~ ^([A-Za-z]):/(.*)$ ]]; then
    local drive; drive=$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')
    printf '/%s/%s' "$drive" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$p"
  fi
}

# ----------------------------------------------------------------------------
# Sourced-launcher generation (USE_RC_SOURCED_LAUNCHER=true)
# ----------------------------------------------------------------------------
# Single-quote $1 for a POSIX shell — each embedded ' becomes '\''. Pure bash (this part bans sed),
# bash 3.2 safe.
rc_shq() {
  local v="$1" sq="'"
  printf "'%s'" "${v//$sq/$sq\\$sq$sq}"
}

# The ONE rc line of the sourced generation, for the env.sh at $1. Guarded, so an rc that outlives
# the install (or a not-yet-written env.sh) is a silent no-op — never an error at shell startup.
rc_source_line() {
  printf '[ -f "%s" ] && . "%s"' "$1" "$1"
}

# The env.sh body, printed to stdout. Everything is resolved NOW and baked as a literal — never
# $HOME (BIN_DIR can live under a relocated root or an --install-dir), never a runtime lookup:
#   · a duplicate-proof PATH prepend (case guard — sourcing twice never stacks entries);
#   · a function named $APP_BIN running `node <bin>/cli.js` with the baked node path, falling back
#     to `node` from PATH when that binary is gone (node was moved/upgraded between installs).
# `command` bypasses any same-named alias/function without executing any script FILE; only "$@" is
# deferred. Consumes $PATH_BIN (shell-form bin dir, MSYS-converted on Windows), $NODE_PATH,
# $NODE_FLAGS, $ENTRY_JS, $APP_BIN, $APP_DISPLAY_NAME.
rc_env_content() {
  local node_q cli_q
  node_q="$(rc_shq "$NODE_PATH")"
  cli_q="$(rc_shq "$PATH_BIN/$ENTRY_JS")"
  printf '%s\n' \
    "# $APP_DISPLAY_NAME — окружение оболочки. Перезаписывается установщиком; подключается из rc-файлов." \
    'case ":$PATH:" in' \
    "  *\":${PATH_BIN}:\"*) ;;" \
    "  *) export PATH=\"${PATH_BIN}:\$PATH\" ;;" \
    'esac' \
    "$APP_BIN() {" \
    "  if [ -f ${node_q} ]; then" \
    "    command ${node_q} ${NODE_FLAGS} ${cli_q} \"\$@\"" \
    '  else' \
    "    command node ${NODE_FLAGS} ${cli_q} \"\$@\"" \
    '  fi' \
    '}'
}

# Write <bin>/env.sh: stage → write → byte-verify, same discipline as rc_apply (though env.sh is OUR
# file in OUR freshly-created dir, a truncated write would turn every new shell's guard line into a
# broken source). Returns 1 on any failure so add_path can fall back to the classic PATH line —
# a launcher that degrades beats one that half-installs.
write_env_file() {
  local env_file="$BIN_DIR/env.sh" staged="$BIN_DIR/env.sh.tmp"
  [ -n "$BIN_DIR" ] && [ -d "$BIN_DIR" ] || return 1
  # Journal the baked node path; a vanished binary is the first thing to check when the function
  # falls back to `node` from PATH.
  if [ ! -f "$NODE_PATH" ]; then
    log "env.sh: node по пути $NODE_PATH не найден — функция будет использовать node из PATH"
  fi
  if ! rc_env_content > "$staged" 2>/dev/null; then
    rm -f "$staged" 2>/dev/null || true
    log "env.sh: не удалось подготовить содержимое"
    return 1
  fi
  [ -s "$staged" ] || { rm -f "$staged" 2>/dev/null || true; return 1; }
  if ! cat "$staged" > "$env_file" 2>/dev/null; then
    rm -f "$staged" 2>/dev/null || true
    log "env.sh: НЕТ ПРАВ на запись $env_file"
    return 1
  fi
  if ! cmp -s "$staged" "$env_file" 2>/dev/null; then
    rm -f "$staged" "$env_file" 2>/dev/null || true
    log "env.sh: запись в $env_file не подтвердилась"
    return 1
  fi
  rm -f "$staged" 2>/dev/null || true
  chmod 644 "$env_file" 2>/dev/null || true
  log "env.sh: записан $env_file (node: $NODE_PATH)"
  return 0
}

# Which file a LOGIN bash reads: the FIRST existing of these three (bash stops at the first it finds
# and never reads the rest). If none exist we create `.profile` — never `.bash_profile`, which would
# then MASK an existing `.profile` for every other tool. Prints the chosen path.
login_rc() {
  local f
  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -f "$f" ] && { printf '%s' "$f"; return; }
  done
  printf '%s' "$HOME/.profile"
}

# Is our export present in $1 as a line of its OWN? The post-write truth check: what is logged and
# returned reflects the file as it now reads, never printf's exit code (the field failure logged
# «дописано» for a line no shell could use).
#
# A trailing CR is tolerated: rc files edited on Windows are CRLF, and a `\r`-terminated copy of our
# line is byte-different from ours while being functionally identical to the shell.
rc_has_our_line() {
  [ -f "$1" ] || return 1
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ "$line" = "$PATH_LINE" ] && return 0
  done < "$1"
  return 1
}

# Ensure our PATH line is present in $1, creating the file if missing. Idempotent by construction: the
# renderer produces the same bytes the file already has, so `rc_apply` no-ops. Returns 0 only when the
# line is VERIFIED readable as its own line afterwards.
write_line() {
  [ -n "$1" ] || return 1
  local existed=false; [ -f "$1" ] && existed=true
  # Create the parent dir if needed (e.g. a $ZDOTDIR that does not exist yet); harmless no-op for the
  # $HOME rc files.
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  rc_apply "$1" 1 || return 1
  if ! rc_has_our_line "$1"; then
    log "PATH: запись в $1 не подтвердилась — строка не найдена после записи"
    return 1
  fi
  if [ "$RC_APPLY_CHANGED" = 0 ]; then
    log "PATH: строка уже присутствует в $1 — пропуск"
  elif [ "$existed" = true ]; then
    log "PATH: дописано в $1"
  else
    log "PATH: создан $1, строка добавлена"
  fi
  return 0
}

# Persist the launch command by writing OUR ONE LINE into the files the user's shells actually
# read: .bashrc (non-login bash), the login-bash file (login_rc), and .zshrc (+ the ZDOTDIR one when
# set) for zsh. Files are CREATED when missing. Non-fatal: returns 1 only when NOT ONE target could be
# written, so the caller records a ⚠(path) note and the install still succeeds. Per-file detail goes to
# the log; the screen gets a single stable line.
#
# PATH_LINE is "the line we own", whatever its generation: the classic export by default, the
# guarded env.sh source when USE_RC_SOURCED_LAUNCHER=true AND env.sh was verifiably written — a
# failed env.sh write degrades to the classic line, so PATH persistence never hinges on the new
# file. Everything downstream (rc_render's append, rc_has_our_line's verify) keys on PATH_LINE and
# is generation-blind.
add_path() {
  PATH_BIN="$BIN_DIR"
  [ "$OS" = "windows" ] && PATH_BIN="$(to_msys_path "$BIN_DIR")"
  PATH_LINE="export PATH=\"${PATH_BIN}:\$PATH\""
  if [ "${USE_RC_SOURCED_LAUNCHER:-false}" = "true" ]; then
    if write_env_file; then
      PATH_LINE="$(rc_source_line "$PATH_BIN/env.sh")"
    else
      log "env.sh: запись не удалась — используется классическая строка PATH"
    fi
  fi
  local ok=0 total=0 login zdot

  total=$((total + 1)); write_line "$HOME/.bashrc" && ok=$((ok + 1))

  login="$(login_rc)"; log "PATH: login-файл = $login"
  total=$((total + 1)); write_line "$login" && ok=$((ok + 1))

  total=$((total + 1)); write_line "$HOME/.zshrc" && ok=$((ok + 1))
  zdot="${ZDOTDIR:-}"
  if [ -n "$zdot" ] && [ "$zdot" != "$HOME" ]; then
    total=$((total + 1)); write_line "$zdot/.zshrc" && ok=$((ok + 1))
  else
    log "PATH: ZDOTDIR не задан или равен HOME — \$ZDOTDIR/.zshrc пропущен"
  fi

  # Make the command usable in THIS installer process (warm-up / verify / start-after-install).
  export PATH="$PATH_BIN:$PATH"

  log "PATH: записано целей $ok из $total"
  if [ "$ok" -gt 0 ]; then
    info "PATH настроен"
    return 0
  fi
  warn "Не удалось записать PATH ни в один файл оболочки"
  return 1
}
