# ============================================================================
# Palette + terminal capability
# ============================================================================
# UI (banner / bar / cards) is TTY-gated on STDOUT. Diagnostics (info/warn/error/die) are plain and
# go to STDERR — which `main` redirects into the journal, so the screen stays clean.
if [ -t 1 ]; then TTY=1; else TTY=0; fi
# 24-bit gradient needs a truecolor terminal (macOS Terminal.app is 256-colour only). Degrade to a
# plain bold wordmark otherwise. All colour stays behind the TTY gate.
case "${COLORTERM:-}" in
  truecolor|24bit) TRUECOLOR=1 ;;
  *) TRUECOLOR=0 ;;
esac
if [ "$TTY" = 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  AMBER=$'\033[38;5;214m'; MAGENTA=$'\033[0;35m'; CYAN=$'\033[0;36m'
  DIM=$'\033[2m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; AMBER=''; MAGENTA=''; CYAN=''; DIM=''; BOLD=''; NC=''
  TRUECOLOR=0
fi

# A UTF-8 locale for measuring box width — Cyrillic is 1 column/char, but `wc -m` counts CHARACTERS
# only under a UTF-8 locale (bytes otherwise → the right border drifts). Reuse the current locale if
# it's UTF-8, else adopt the first available UTF-8 one. Best-effort ("" = leave measurement as-is).
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8|*utf8|*UTF8) UTF8_LOCALE="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" ;;
  *) UTF8_LOCALE=""
     for _loc in C.UTF-8 en_US.UTF-8 C.utf8; do
       if locale -a 2>/dev/null | grep -qi "^${_loc}$"; then UTF8_LOCALE="$_loc"; break; fi
     done ;;
esac

log() {
  local ts
  ts=$(date -u '+%H:%M:%S' 2>/dev/null || echo '--:--:--')
  printf '[%s] %s\n' "$ts" "$*" >>"$LOGFILE" 2>/dev/null || true
}
info()  { printf '[INFO] %s\n' "$*" >&2; }
warn()  { printf '[WARN] %s\n' "$*" >&2; }
error() { printf '[ERROR] %s\n' "$*" >&2; }
die()   { error "$*"; exit 1; }

usage() {
  cat <<USAGE
${APP_DISPLAY_NAME} — установка / обновление / удаление.

Использование:
  bash ${REPO_NAME}/install                     # из родительского каталога клона
  cat ${REPO_NAME}/install | bash               # то же, через конвейер
  bash ${REPO_NAME}/install --uninstall         # удалить
  ./install --keep-source                       # не удалять каталог клона
  ./install --help
USAGE
}

# ============================================================================
# Gradient wordmark (ported from ru-code/daemon/src/paint.ts)
# ============================================================================
# One cyan→violet sweep. MODE=fg → foreground wordmark (spaces pass through); MODE=bg → background
# pill (white-bold text on the ramp, the SUCCESS CTA). gradient()/gradient_bg() wrap it. TTY+truecolor
# gated by the callers. `fg`/`bg` below are literal mode strings, not the fg/fb colour channels.
gradient_sweep() {
  local mode="$1" text="$2" fr fgc fb tr tgc tb2 n i ch r g b span
  IFS=';' read -r fr fgc fb <<<"$GRADIENT_FROM"
  IFS=';' read -r tr tgc tb2 <<<"$GRADIENT_TO"
  n=${#text}; span=$(( n > 1 ? n - 1 : 1 ))
  for (( i = 0; i < n; i++ )); do
    ch="${text:i:1}"
    if [ "$mode" = fg ] && [ "$ch" = " " ]; then printf ' '; continue; fi
    r=$(( fr + (tr - fr) * i / span ))
    g=$(( fgc + (tgc - fgc) * i / span ))
    b=$(( fb + (tb2 - fb) * i / span ))
    if [ "$mode" = bg ]; then printf '\033[1;97;48;2;%d;%d;%dm%s\033[0m' "$r" "$g" "$b" "$ch"
    else printf '\033[1;38;2;%d;%d;%dm%s\033[0m' "$r" "$g" "$b" "$ch"; fi
  done
}
gradient()    { gradient_sweep fg "$1"; }
gradient_bg() { gradient_sweep bg "$1"; }

# `▸ Ru Code` — green arrow + gradient wordmark on a truecolor TTY, plain bold otherwise.
brand_wordmark() {
  if [ "$TTY" = 1 ] && [ "$TRUECOLOR" = 1 ]; then
    printf '%s▸%s %s' "$GREEN" "$NC" "$(gradient "$APP_DISPLAY_NAME")"
  elif [ "$TTY" = 1 ]; then
    printf '%s▸%s %s%s%s' "$GREEN" "$NC" "$BOLD" "$APP_DISPLAY_NAME" "$NC"
  else
    printf '> %s' "$APP_DISPLAY_NAME"
  fi
}

banner() { printf '\n  %s\n\n' "$(brand_wordmark)"; }

# ============================================================================
# Progress bar (phase-driven) + phase runner
# ============================================================================
draw_bar() {
  local pct="$1" label="$2" width=24 filled empty i bar=""
  filled=$(( pct * width / 100 )); empty=$(( width - filled ))
  for (( i = 0; i < filled; i++ )); do bar="${bar}▓"; done
  for (( i = 0; i < empty;  i++ )); do bar="${bar}░"; done
  # \r + clear-to-EOL first, so a shorter redraw never leaves stale glyphs behind (artifact fix).
  printf '\r\033[K  %s%s%s  %-22s %s%3d%%%s' "$CYAN" "$bar" "$NC" "$label" "$DIM" "$pct" "$NC"
}

# Kill a running bar animator and clear its row. Safe to call anytime (idempotent).
stop_animator() {
  [ -n "${ANIM_PID:-}" ] || return 0
  kill "$ANIM_PID" 2>/dev/null || true
  wait "$ANIM_PID" 2>/dev/null || true
  ANIM_PID=""
  [ "$TTY" = 1 ] && printf '\r\033[K'
  return 0
}

# run_phase KEY FROM TO LABEL CMD...  — runs CMD in the FOREGROUND (so its globals persist) while a
# background animator eases ONE bar line FROM→TO-1. The single line morphs across phases; on success
# it snaps to TO and stays (next phase continues the same line); the FINAL card owns the ✓/✗ summary
# (§4 phase ticks). Non-TTY is quiet — no per-phase output, so nothing scrolls or leaves artifacts.
# CURRENT_PHASE lets a mid-bar fail_* stop the animator and tag THIS phase before it renders + exits.
run_phase() {
  local key="$1" from="$2" to="$3" label="$4"; shift 4
  PHASE_LEDGER="${PHASE_LEDGER} ${key}"
  CURRENT_PHASE="$key"
  if [ "$TTY" != 1 ]; then
    local rc=0
    "$@" || rc=$?
    [ "$rc" -ne 0 ] && FAILED_PHASE="$key"
    CURRENT_PHASE=""
    return "$rc"
  fi
  ( p="$from"; while :; do draw_bar "$p" "$label"; if [ "$p" -lt $(( to - 1 )) ]; then p=$(( p + 1 )); fi; sleep 0.08; done ) &
  ANIM_PID=$!
  local rc=0
  "$@" || rc=$?
  stop_animator
  if [ "$rc" -eq 0 ]; then
    draw_bar "$to" "$label"     # snap this phase to full; stays on the one line
  else
    FAILED_PHASE="$key"         # line already cleared by stop_animator; the card shows the ✗
  fi
  CURRENT_PHASE=""
  return "$rc"
}

# ============================================================================
# Box primitives (double-rule ╔═╗) — colour set by the caller via BOX_COLOR.
# ============================================================================
BOX_COLOR=""   # set to $CYAN / $AMBER / $RED before a box group
box_top()    { local i; printf '  %s╔' "${BOLD}${BOX_COLOR}"; for ((i=0;i<BOX_INNER;i++)); do printf '═'; done; printf '╗%s\n' "$NC"; }
box_bottom() { local i; printf '  %s╚' "${BOLD}${BOX_COLOR}"; for ((i=0;i<BOX_INNER;i++)); do printf '═'; done; printf '╝%s\n' "$NC"; }
box_line() {
  local content="$1" visible esc len pad
  esc=$'\033'
  visible=$(printf '%s' "$content" | sed "s/${esc}\[[0-9;]*m//g")
  len=$(printf '%s' "$visible" | LC_ALL="$UTF8_LOCALE" wc -m | tr -d ' ')
  pad=$((BOX_INNER - len)); [ "$pad" -lt 0 ] && pad=0
  printf '  %s║%s%s%*s%s║%s\n' "${BOLD}${BOX_COLOR}" "$NC" "$content" "$pad" "" "${BOLD}${BOX_COLOR}" "$NC"
}
box_blank() { box_line ""; }
box_wrap() {
  local text="$1" width=$((BOX_INNER - 4)) line="" word
  for word in $text; do
    if [ -z "$line" ]; then line="$word"
    elif [ $(( ${#line} + 1 + ${#word} )) -le "$width" ]; then line="$line $word"
    else box_line "  $line"; line="$word"; fi
  done
  [ -n "$line" ] && box_line "  $line"
}
cmd_row() {
  local width="$1" cmd="$2" desc="$3"
  printf "    ${CYAN}%s${NC}%*s${DIM}%s${NC}\n" "$cmd" $(( width - ${#cmd} )) "" "$desc"
}

# ============================================================================
# §10 message table — per-reason title / body (case functions, NOT declare -A: bash 3.2).
# ============================================================================
title_for() {
  case "$1" in
    busy)         printf '%s' "Установка уже выполняется" ;;
    insecure)     printf '%s' "Небезопасный источник" ;;
    os)           printf '%s' "Система не поддерживается" ;;
    usage)        printf '%s' "Не удалось разобрать параметры" ;;
    gitbash)      printf '%s' "Нужен Git Bash" ;;
    package)      printf '%s' "Дистрибутив не найден" ;;
    downloader)   printf '%s' "Нужен curl" ;;
    network)      printf '%s' "Не удалось скачать дистрибутив" ;;
    node-install) printf '%s' "Node.js не установлен" ;;
    node-update)  printf '%s' "Обновите Node.js" ;;
    tar)          printf '%s' "Не найдена программа «tar»" ;;
    git)          printf '%s' "Требуется Git" ;;
    cli-install)  printf '%s' "CLI-движок не установлен" ;;
    cli-update)   printf '%s' "Обновите CLI-движок" ;;
    stop-failed)  printf '%s' "Не удалось остановить приложение" ;;
    path)         printf '%s' "PATH не настроен" ;;
    starter)      printf '%s' "Стартовый проект не создан" ;;
    corrupt)      printf '%s' "Пакет повреждён" ;;
    crash)        printf '%s' "Что-то пошло не так" ;;
    *)            printf '%s' "Ошибка" ;;
  esac
}
body_for() {
  case "$1" in
    busy)         printf '%s' "Дождитесь завершения другой установки и повторите." ;;
    insecure)     printf '%s' "Адрес загрузки должен начинаться с https://." ;;
    os)           printf '%s' "Поддерживаются Linux, macOS, Windows (Git Bash). Обнаружено: $(uname -s 2>/dev/null || echo '?')." ;;
    usage)        printf '%s' "Проверьте команду. Справка: ./install --help." ;;
    gitbash)      printf '%s' "На Windows запускайте через Git Bash: https://git-scm.com/downloads" ;;
    package)      printf '%s' "$PACKAGE_MISSING_HINT" ;;
    downloader)   printf '%s' "Установите curl и повторите." ;;
    network)      printf '%s' "$DOWNLOAD_FAILED_HINT" ;;
    node-install) printf '%s' "Установите LTS: https://nodejs.org/ и запустите заново." ;;
    node-update)  printf '%s' "Нужна версия $NODE_ENGINE_RANGE. LTS: https://nodejs.org/" ;;
    tar)          printf '%s' "Установите tar и повторите." ;;
    git)          printf '%s' "Установите: https://git-scm.com/downloads" ;;
    cli-install)  printf '%s' "$CLI_INSTALL_HINT" ;;
    cli-update)   printf '%s' "Нужна версия ≥ $CLI_MIN_VERSION. $CLI_UPDATE_HINT" ;;
    stop-failed)  printf '%s' "Закройте работающее приложение и повторите установку." ;;
    path)         printf '%s' "Добавьте вручную: export PATH=\"$BIN_DIR:\$PATH\"" ;;
    starter)      printf '%s' "Приложение создаст его при первом запуске." ;;
    corrupt)      printf '%s' "Попробуйте ещё раз; если повторяется — пришлите журнал (см. ниже)." ;;
    crash)        printf '%s' "Мы сохранили журнал с деталями установки." ;;
    *)            printf '%s' "" ;;
  esac
}

# ============================================================================
# Renderer — logic sets state; render_outcome draws §4. Nothing else prints to the screen.
# ============================================================================
PHASE_ORDER="download prepare env copy verify"
phase_label() {
  case "$1" in
    download) printf '%s' "Загрузка" ;; prepare) printf '%s' "Распаковка" ;;
    env) printf '%s' "Проверка окружения" ;; copy) printf '%s' "Копирование" ;;
    verify) printf '%s' "Проверка запуска" ;;
  esac
}
verb_text() {
  case "$ACTION" in
    uninstall) printf 'Удаление' ;; update) printf 'Обновление' ;;
    install)   printf 'Установка' ;; *) printf 'Проверка' ;;
  esac
}
status_header() {
  case "$STATE" in
    SUCCESS)
      if [ "$ACTION" = update ]; then printf 'обновлён · %s → %s' "$INSTALLED_VERSION" "$APP_VERSION"
      else printf 'установлен · %s' "$APP_VERSION"; fi ;;
    ALREADY_INSTALLED) printf 'уже установлен · %s' "$INSTALLED_VERSION" ;;
    UNINSTALLED) printf 'удалён' ;;
    *)  # blocked
      if [ "$OLD_APP_PRESENT" = 1 ] && [ "$ACTION" = update ]; then
        printf 'не обновлён · осталась версия %s' "$INSTALLED_VERSION"
      elif [ -z "$ACTION" ]; then
        # Blocked/crashed before the action was determined (e.g. a corrupt bundle) — we never touched
        # any existing install, so don't falsely claim «не установлен».
        printf 'установка не завершена'
      else printf 'не установлен'; fi ;;
  esac
}

# add a recommendation: recommend REASON BLOCKING(true|false)
recommend() { RECOMMENDATIONS[${#RECOMMENDATIONS[@]}]="$1|$2"; }
# note REASON — a NON-BLOCKING (⚠) recommendation for a best-effort step that failed but must not
# abort the run (e.g. a read-only rc → PATH not written, or the optional starter). Called as
# `step || note REASON`; without this a missing command under `set -e` would crash + roll back.
note() { recommend "$1" false; }

render_recommendation() {
  local reason="$1" blocking="$2" tint="$AMBER" git_suffix=""
  [ "$blocking" = true ] && tint="$AMBER"
  printf '\n  %s⚠%s  %s%s%s\n' "$tint" "$NC" "$BOLD" "$(title_for "$reason")" "$NC"
  if [ "$reason" = git ] && [ "$blocking" != true ]; then git_suffix=" — создание проектов недоступно"; fi
  printf '      %s%s%s%s\n' "$DIM" "$(body_for "$reason")" "$git_suffix" "$NC"
}

# No box — the crash detail reads as plain lines: red error title, white body, dim journal (full
# real path, never truncated), cyan support links. Color carries meaning; text stays readable.
render_crash_block() {
  local reason="$1"
  printf '\n  %s%s%s\n' "${BOLD}${RED}" "$(title_for "$reason")" "$NC"
  printf '  %s\n' "$(body_for "$reason")"
  printf '\n  %sЖурнал:%s  %s\n' "$BOLD" "$NC" "$LOGFILE"
  printf '\n  Пришлите этот файл в поддержку:\n'
  # ru-code: an EMPTY support URL prints no chat row at all (same rule the SW pages apply to
  # SUPPORT_CHANNEL_URL) — a bullet pointing at nothing is worse than one row less.
  if [ -n "$SUPPORT_CHAT_URL" ]; then
    printf '    %s•%s Чат:   %s%s%s\n' "$DIM" "$NC" "$CYAN" "$SUPPORT_CHAT_URL" "$NC"
  fi
  printf '    %s•%s Email: %s%s%s\n' "$DIM" "$NC" "$CYAN" "$AUTHOR_EMAIL" "$NC"
}

# ru-code: the support row shared by the launch banners. Silent when the URL is empty.
render_support_line() {
  [ -n "$SUPPORT_CHAT_URL" ] || return 0
  printf '\n  %sЧат поддержки:%s %s%s%s\n' "$DIM" "$NC" "$CYAN" "$SUPPORT_CHAT_URL" "$NC"
}

# The command as the user should type it: gradient wordmark on a truecolor TTY, bold otherwise.
app_cmd_text() {
  if [ "$TTY" = 1 ] && [ "$TRUECOLOR" = 1 ]; then gradient "$APP_BIN"
  else printf '%s%s%s' "$BOLD" "$APP_BIN" "$NC"; fi
}

# Green-bordered CTA block: white instruction line + a `> ru-code` prompt where the command is the
# gradient WORDMARK foreground (no background pill).
render_cta_pill() {
  local cmd; cmd="$(app_cmd_text)"
  printf '\n'
  BOX_COLOR="$GREEN"; box_top
  box_line "  Перезапустите терминал и выполните команду:"
  box_blank
  box_line "  ${GREEN}>${NC} ${cmd}"
  BOX_COLOR="$GREEN"; box_bottom
}

# ============================================================================
# The four LAUNCH banners (§3.5) — drawn AFTER the outcome card + credits, because starting the app
# is the installer's final, isolated step. Exactly one of these renders per successful install:
#   1 render_launch_started      the launcher answered {"ok":true,…}   (a browser that failed to
#                                open is STILL this state — the link is the fallback)
#   2 render_launch_failed       it answered {"ok":false} or nothing   (its English `error` text is
#                                NEVER shown — that lives in daemon.log)
#   3 render_launch_interrupted  Ctrl+C while we waited
#   4 render_cta_pill            the launch did not run at all (classic card, above)
# Same box/colour vocabulary as the success card: a box carries the short copy, plain lines below
# carry the things that must never be clipped by a border (urls, absolute paths).
# ============================================================================
render_launch_started() {
  local cmd; cmd="$(app_cmd_text)"
  printf '\n'
  BOX_COLOR="$GREEN"; box_top
  box_line "  ${BOLD}${GREEN}Запущено${NC}"
  box_blank
  if [ -n "$LAUNCH_URL" ]; then
    box_line "  Если браузер не открылся — откройте ссылку:"
  else
    box_line "  Приложение работает."
  fi
  BOX_COLOR="$GREEN"; box_bottom
  if [ -n "$LAUNCH_URL" ]; then printf '    %s%s%s\n' "$CYAN" "$LAUNCH_URL" "$NC"; fi
  printf '\n  %sУправление приложением:%s\n' "$DIM" "$NC"
  printf '    %s>%s %s\n' "$GREEN" "$NC" "$cmd"
}

render_launch_failed() {
  local cmd; cmd="$(app_cmd_text)"
  printf '\n'
  BOX_COLOR="$RED"; box_top
  box_line "  ${BOLD}${RED}Ошибка${NC}"
  box_blank
  box_line "  Приложение установлено, но не удалось его запустить."
  BOX_COLOR="$RED"; box_bottom
  printf '\n  %sЗапустите вручную:%s\n' "$DIM" "$NC"
  printf '    %s>%s %s\n' "$GREEN" "$NC" "$cmd"
  printf '\n  %sЖурнал приложения:%s %s\n' "$BOLD" "$NC" "$APP_ROOT/$DAEMON_LOG_REL"
  render_support_line
}

render_launch_interrupted() {
  local cmd; cmd="$(app_cmd_text)"
  printf '\n'
  BOX_COLOR="$AMBER"; box_top
  box_line "  ${BOLD}Прервано${NC}"
  box_blank
  box_line "  Ожидание прервано — возможно, приложение уже запущено."
  BOX_COLOR="$AMBER"; box_bottom
  printf '\n  %sПроверить и запустить:%s\n' "$DIM" "$NC"
  printf '    %s>%s %s\n' "$GREEN" "$NC" "$cmd"
  render_support_line
}

render_commands() {
  local width=$(( ${#APP_BIN} + 12 ))
  printf '\n  %s── Полезные команды ───────────────────────%s\n' "$DIM" "$NC"
  cmd_row "$width" "$APP_BIN --fg"        "запустить в этом окне"
  cmd_row "$width" "$APP_BIN restart"     "перезапустить"
  cmd_row "$width" "$APP_BIN stop"        "остановить"
  cmd_row "$width" "$APP_BIN --version"   "версия"
}

render_direct_run() {
  printf '\n  %sЕсли команда «%s» не найдена  запустите напрямую:%s\n' "$DIM" "$APP_BIN" "$NC"
  # ru-code: name the ACTUAL resolved node ($NODE_PATH — shipped runtime when detected, else the
  # OS node), so the printed command matches what the wrapper/launcher really execute.
  printf '    %s"%s" %s "%s/%s"%s\n' "$CYAN" "${NODE_PATH:-node}" "$NODE_FLAGS" "$BIN_DIR" "$ENTRY_JS" "$NC"
  printf '\n  %sКаталог приложения: %s%s\n' "$DIM" "$APP_ROOT" "$NC"
}

render_log_line() { printf '\n  %sЖурнал: %s%s\n' "$DIM" "$LOGFILE" "$NC"; }

render_credits() {
  printf '\n'
  BOX_COLOR="$CYAN"; box_top
  box_line "  ${BOLD}${APP_DISPLAY_NAME}${NC} ${DIM}·${NC} ${CYAN}MIT License${NC}"
  box_blank
  box_line "  Хобби-проект — делаю для души, в свободное время."
  box_blank
  box_line "  ${DIM}Автор:${NC}     ${CREDITS_AUTHOR_FIO}"
  box_line "  ${DIM}Контакт:${NC}   ${CYAN}${AUTHOR_EMAIL}${NC}"
  box_blank
  box_line "  Буду рад лайку в каталоге:"
  box_line "  ${CYAN}${CATALOG_URL}${NC}"
  # ru-code: no support URL configured → the row (and its spacer) disappear entirely, rather than
  # showing an empty label. Same rule as swPages.ts applies to SUPPORT_CHANNEL_URL.
  if [ -n "$SUPPORT_CHAT_URL" ]; then
    box_blank
    box_line "  ${DIM}Чат поддержки:${NC}  ${CYAN}${SUPPORT_CHAT_URL}${NC}"
  fi
  BOX_COLOR="$CYAN"; box_bottom
  printf '\n'
}

# The one renderer. Draws the always-frame + the state-specific middle, returns the exit code.
render_outcome() {
  CARD_SHOWN=1
  [ "$TTY" = 1 ] && printf '\r\033[K'   # wipe the single progress-bar line before the card
  # Border carries the severity color; status TEXT stays readable (green on success, white on a
  # blocked/crash state — never tinted to match the alarm border).
  local border="$CYAN" tint="$GREEN" entry reason blocking rc=0
  case "$STATE" in
    SUCCESS|ALREADY_INSTALLED|UNINSTALLED) border="$CYAN"; tint="$GREEN"; rc=0 ;;
    BLOCKED_RECOMMENDATION) border="$AMBER"; tint=""; rc=1 ;;
    BLOCKED_CRASH) border="$RED"; tint=""; rc=2 ;;
  esac

  # 1. Header — only when a TTY did NOT already print the live banner during install (avoids a
  # second wordmark). Non-TTY runs never showed one, so the card carries it.
  [ "$TTY" = 1 ] || banner
  # 2. Action line + phase ticks
  render_phase_frame
  # 3. Status box (§3 header — status text only; the brand is the header, the command is the pill)
  printf '\n'
  BOX_COLOR="$border"; box_top
  box_line "  ${BOLD}${tint}$(status_header)${NC}"
  BOX_COLOR="$border"; box_bottom

  # 4. State-specific middle
  case "$STATE" in
    SUCCESS)
      # ru-code: NO render_cta_pill here — on the success path the «перезапустите терминал» card is
      # the LAUNCH's state-4 banner (the launch did not run), so main draws it BELOW the credits,
      # where the other three launch banners land. ALREADY_INSTALLED never reaches the launch and
      # therefore keeps its card in place, above the credits.
      for entry in ${RECOMMENDATIONS[@]+"${RECOMMENDATIONS[@]}"}; do
        reason="${entry%%|*}"; blocking="${entry##*|}"
        [ "$blocking" = false ] && render_recommendation "$reason" false
      done
      render_commands
      render_direct_run ;;
    ALREADY_INSTALLED)
      render_cta_pill
      render_commands
      render_direct_run ;;
    BLOCKED_RECOMMENDATION)
      for entry in ${RECOMMENDATIONS[@]+"${RECOMMENDATIONS[@]}"}; do
        reason="${entry%%|*}"; blocking="${entry##*|}"
        [ "$blocking" = true ] && render_recommendation "$reason" true
      done
      render_log_line
      printf '\n  %sИсправьте и запустите установку заново.%s\n' "$DIM" "$NC" ;;
    BLOCKED_CRASH)
      # render_crash_block already prints the journal line (next to «пришлите этот файл»), so no
      # separate render_log_line here — that would double it.
      for entry in ${RECOMMENDATIONS[@]+"${RECOMMENDATIONS[@]}"}; do
        reason="${entry%%|*}"; render_crash_block "$reason"; break
      done ;;
    UNINSTALLED) : ;;
  esac

  # 5. Credits (always)
  render_credits
  return "$rc"
}

render_phase_frame() {
  local key label mark
  printf '  %s%s…%s\n' "$BOLD" "$(verb_text)" "$NC"
  for key in $PHASE_ORDER; do
    case " $PHASE_LEDGER " in *" $key "*) ;; *) continue ;; esac
    label="$(phase_label "$key")"
    if [ "$key" = "$FAILED_PHASE" ]; then mark="${RED}✗${NC}"; else mark="${GREEN}✓${NC}"; fi
    printf '     %s %s\n' "$mark" "$label"
    # ru-code: right after «Распаковка», surface the detected version as its own ✓ step.
    if [ "$key" = prepare ] && [ "$key" != "$FAILED_PHASE" ] && [ -n "${APP_VERSION:-}" ]; then
      printf '     %s Обнаружена версия %s\n' "${GREEN}✓${NC}" "$APP_VERSION"
    fi
  done
}
