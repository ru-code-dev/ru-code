// ru-code: app-level presentation choices for the extended chat view.
import type { TasksPinMode } from "@smart-tools/qwen-cli-extended-chat/web";

/**
 * Where the per-turn «Задачи» block lives while scrolling a turn:
 * - "inline"   — the in-flow row only;
 * - "floating" — the in-flow row PLUS a pinned overlay showing the currently
 *   reviewed turn's lists once its tasks row scrolls off the top.
 */
export const EXTENDED_CHAT_TASKS_PIN_MODE: TasksPinMode = "floating";
