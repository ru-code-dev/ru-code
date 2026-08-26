// ru-code: Russian display labels for keybinding command ids, shown in Settings →
// Keybindings via commandLabel() (KeybindingsSettings.logic.ts). The command id itself
// (e.g. "chat.new") is the KEY — used for matching, persistence, and conflict detection
// — and stays English everywhere; only the string commandLabel() returns is locale-aware.
// Not dict-scanned: commandLabel() builds its string from data at runtime, not a literal
// node in source, so the AST scanner can't see it. This table is the source of truth
// instead, kept in sync by hand against STATIC_KEYBINDING_COMMANDS in
// packages/contracts/src/keybindings.ts.
export const COMMAND_LABEL_RU: Readonly<Record<string, string>> = {
  "sidebar.toggle": "Боковая панель: Переключить",
  "terminal.toggle": "Терминал: Переключить",
  "terminal.split": "Терминал: Разделить",
  "terminal.splitVertical": "Терминал: Разделить вертикально",
  "terminal.new": "Терминал: Новый",
  "terminal.close": "Терминал: Закрыть",
  "rightPanel.toggle": "Правая панель: Переключить",
  "rightPanel.toggleMaximized": "Правая панель: На весь экран",
  "diff.toggle": "Различия: Переключить",
  "preview.toggle": "Предпросмотр: Переключить",
  "preview.refresh": "Предпросмотр: Обновить",
  "preview.focusUrl": "Предпросмотр: Перейти к адресу",
  "preview.zoomIn": "Предпросмотр: Увеличить",
  "preview.zoomOut": "Предпросмотр: Уменьшить",
  "preview.resetZoom": "Предпросмотр: Сбросить масштаб",
  "commandPalette.toggle": "Палитра команд: Переключить",
  "filePicker.toggle": "Выбор файла: Переключить",
  "projectSearch.toggle": "Поиск по проекту: Переключить",
  "themeEditor.toggle": "Редактор темы: Переключить",
  "composer.stash": "Композер: Схрон",
  "chat.new": "Чат: Новый",
  "chat.newLocal": "Чат: Новый локальный",
  "editor.openFavorite": "Редактор: Открыть избранное",
  "modelPicker.toggle": "Выбор модели: Переключить",
  "modelPicker.jump.1": "Выбор модели: Переход: 1",
  "modelPicker.jump.2": "Выбор модели: Переход: 2",
  "modelPicker.jump.3": "Выбор модели: Переход: 3",
  "modelPicker.jump.4": "Выбор модели: Переход: 4",
  "modelPicker.jump.5": "Выбор модели: Переход: 5",
  "modelPicker.jump.6": "Выбор модели: Переход: 6",
  "modelPicker.jump.7": "Выбор модели: Переход: 7",
  "modelPicker.jump.8": "Выбор модели: Переход: 8",
  "modelPicker.jump.9": "Выбор модели: Переход: 9",
  "thread.previous": "Диалог: Предыдущий",
  "thread.next": "Диалог: Следующий",
  "thread.jump.1": "Диалог: Переход: 1",
  "thread.jump.2": "Диалог: Переход: 2",
  "thread.jump.3": "Диалог: Переход: 3",
  "thread.jump.4": "Диалог: Переход: 4",
  "thread.jump.5": "Диалог: Переход: 5",
  "thread.jump.6": "Диалог: Переход: 6",
  "thread.jump.7": "Диалог: Переход: 7",
  "thread.jump.8": "Диалог: Переход: 8",
  "thread.jump.9": "Диалог: Переход: 9",
};

const RUN_SCRIPT_PREFIX_RU = "Запустить скрипт";

// fallback is the mechanically-derived English label (commandLabel()'s existing
// id.split(".").titleCase().join(": ") logic) — reused here so the "Run Script: "
// case doesn't need to re-derive the script name, and so any future/unknown command
// id still shows something sensible instead of being silently dropped.
export function localizedCommandLabel(
  rawCommand: string,
  fallback: string,
  locale: string,
): string {
  if (locale !== "ru") return fallback;

  const known = COMMAND_LABEL_RU[rawCommand];
  if (known) return known;

  if (rawCommand.startsWith("script.") && rawCommand.endsWith(".run")) {
    const scriptLabel = fallback.slice(fallback.indexOf(": ") + 2);
    return `${RUN_SCRIPT_PREFIX_RU}: ${scriptLabel}`;
  }

  return fallback;
}
