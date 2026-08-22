# FROZEN ORACLE — do not edit, do not "improve", do not keep in sync with the shipped code.
#
# This is the rc-file logic exactly as it shipped before the PATH-persistence rework
# (ru-code/installer/parts/25-rc-path.sh), lifted verbatim from commit 2c9d4a38a
# `ru-code/installer/parts/30-core.sh` lines 287-315 and 415-491, with every name prefixed
# `legacy_` so both generations can be sourced into one shell and run over the same input.
#
# Its ONLY purpose is the differential proof in rcEquivalence.test.ts: for every rc-file shape that
# holds NO glued line, the new logic must produce byte-identical output and the same exit code. When
# this file and the new code disagree anywhere else, that difference has to be a DOCUMENTED delta or
# the change is a regression.
#
# It is deliberately kept as dead code: editing it to match a new behavior would destroy the only
# evidence we have of what the old behavior actually was.

legacy_rc_files() {
  printf '%s\n' \
    "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.bash_login" \
    "$HOME/.profile" "$HOME/.zshrc" "$HOME/.zprofile"
  [ -n "${ZDOTDIR:-}" ] && [ "$ZDOTDIR" != "$HOME" ] && printf '%s\n' "$ZDOTDIR/.zshrc"
}

legacy_clean_rc() {
  [ -n "$APP_DIR_NAME" ] || return 0
  local rc
  while IFS= read -r rc; do
    [ -f "$rc" ] || continue
    grep -qF -e "/$APP_DIR_NAME/bin" -e "# $APP_BIN v" "$rc" 2>/dev/null || continue
    grep -vF -e "/$APP_DIR_NAME/bin" -e "# $APP_BIN v" "$rc" > "$rc.tmp" 2>/dev/null || true
    if [ -s "$rc.tmp" ]; then
      cp "$rc" "$rc.bak" 2>/dev/null || true
      if mv "$rc.tmp" "$rc" 2>/dev/null; then
        info "Очищено $rc (резервная копия: $rc.bak)"
      else
        rm -f "$rc.tmp"; warn "Нет прав на изменение $rc — пропущен"
      fi
    else
      rm -f "$rc.tmp"; warn "Очистка $rc пропущена (пустой результат) — проверьте вручную"
    fi
  done < <(legacy_rc_files)
}

legacy_to_msys_path() {
  local p="$1"
  if [[ "$p" =~ ^([A-Za-z]):/(.*)$ ]]; then
    local drive; drive=$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')
    printf '/%s/%s' "$drive" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$p"
  fi
}

legacy_login_rc() {
  local f
  for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -f "$f" ] && { printf '%s' "$f"; return; }
  done
  printf '%s' "$HOME/.profile"
}

legacy_write_line() {
  [ -n "$1" ] || return 1
  if grep -qsF "$PATH_BIN" "$1" 2>/dev/null; then
    log "PATH: строка уже присутствует в $1 — пропуск"
    return 0
  fi
  local existed=false; [ -f "$1" ] && existed=true
  mkdir -p "$(dirname "$1")" 2>/dev/null || true
  if printf '%s\n' "$PATH_LINE" >> "$1" 2>/dev/null; then
    [ "$existed" = true ] && log "PATH: дописано в $1" || log "PATH: создан $1, строка добавлена"
    return 0
  fi
  log "PATH: НЕТ ПРАВ на запись $1 — пропущен"
  return 1
}

legacy_add_path() {
  PATH_BIN="$BIN_DIR"
  [ "$OS" = "windows" ] && PATH_BIN="$(legacy_to_msys_path "$BIN_DIR")"
  PATH_LINE="export PATH=\"${PATH_BIN}:\$PATH\""
  local ok=0 total=0 login zdot

  total=$((total + 1)); legacy_write_line "$HOME/.bashrc" && ok=$((ok + 1))

  login="$(legacy_login_rc)"; log "PATH: login-файл = $login"
  total=$((total + 1)); legacy_write_line "$login" && ok=$((ok + 1))

  total=$((total + 1)); legacy_write_line "$HOME/.zshrc" && ok=$((ok + 1))
  zdot="${ZDOTDIR:-}"
  if [ -n "$zdot" ] && [ "$zdot" != "$HOME" ]; then
    total=$((total + 1)); legacy_write_line "$zdot/.zshrc" && ok=$((ok + 1))
  else
    log "PATH: ZDOTDIR не задан или равен HOME — \$ZDOTDIR/.zshrc пропущен"
  fi

  export PATH="$PATH_BIN:$PATH"

  log "PATH: записано целей $ok из $total"
  if [ "$ok" -gt 0 ]; then
    info "PATH настроен"
    return 0
  fi
  warn "Не удалось записать PATH ни в один файл оболочки"
  return 1
}
