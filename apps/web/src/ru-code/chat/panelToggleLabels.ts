// ru-code: hand-seam. The right-panel toggle's aria-label/tooltip interpolate a live
// agent count with an English singular/plural word chosen inline
// (`liveAgentCount === 1 ? "agent" : "agents"`) — a raw literal nested inside a ternary
// inside an interpolation slot, so the AST dict scanner can't see it (same class of gap
// as the keybinding conflict-suffix case). Russian also needs a three-form plural
// (агент/агента/агентов), which a binary dict entry can't express anyway — hence Lp.
import { L, Lp, LT } from "@ru-code/localization";

function agentPluralWord(count: number): string {
  return Lp(count, ["agent", "agents"], ["агент", "агента", "агентов"]);
}

export function rightPanelToggleAriaLabel(liveAgentCount: number): string {
  if (liveAgentCount === 0) return L("Toggle right panel", "Переключить правую панель");
  return LT("Toggle right panel, {0} {1} working", "Переключить правую панель — работает {0} {1}", [
    liveAgentCount,
    agentPluralWord(liveAgentCount),
  ]);
}

export function rightPanelToggleTooltip(
  rightPanelShortcutLabel: string | null,
  liveAgentCount: number,
): string {
  const shortcut = rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : "";
  if (liveAgentCount === 0) {
    return LT("Toggle right panel{0}", "Переключить правую панель{0}", [shortcut]);
  }
  return LT(
    "Toggle right panel{0} · {1} {2} working",
    "Переключить правую панель{0} · работает {1} {2}",
    [shortcut, liveAgentCount, agentPluralWord(liveAgentCount)],
  );
}
