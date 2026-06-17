/**
 * Pixso Move (ru-fork) — public surface.
 *
 * A left-nav entry ("Макеты Pixso") toggles a right panel that reads a designer's macets from
 * the pixso-move server: a preview gallery → node detail (preview + JSON + LLM result blocks)
 * → settings. Isolated here to keep the impact on the wider web app minimal.
 */

export { PixsoNavGroup } from "./components/PixsoNavGroup";
export { PixsoPanel } from "./components/PixsoPanel";
export { usePixsoStore } from "./store";
