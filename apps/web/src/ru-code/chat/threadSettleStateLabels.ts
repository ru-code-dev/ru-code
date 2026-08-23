// ru-code: Russian display labels for the settled/snoozed thread-state pair used in the
// "This thread is settled/snoozed" system message (ChatView.tsx). Mirrors the
// THREAD_STATUS_LABEL_RU convention (apps/web/src/components/Sidebar.logic.ts) rather than
// inventing a new one: the English union stays logic, Russian is a bilingual seam consumed via
// L(...) at the call site.
export const THREAD_SETTLE_STATE_LABEL_RU: Record<"settled" | "snoozed", string> = {
  settled: "завершён",
  snoozed: "отложен",
};
