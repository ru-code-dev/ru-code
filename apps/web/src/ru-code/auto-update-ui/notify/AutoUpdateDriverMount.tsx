// ru-code: the ONE mount of the auto-update driver + the relative-time / SW-mirror sync.
//
// Why it is its own component at the app root instead of a hook inside the sidebar pill:
// the pill lives in `SidebarChromeFooter`, which the sidebar renders only in the NON-settings
// branch (`isOnSettings ? <SettingsSidebarNav/> : (… <SidebarChromeFooter/>)`). So on `/settings/*`
// — including `/settings/auto-update`, the only screen with an install button — the pill unmounts
// and every job below silently stopped:
//   · the /healthz restart poll, so a tab that pressed «Установить» never returned to the new
//     version by itself and the hero's «Перезапуск… N с» counter climbed forever;
//   · the restart handover and the update-marker CLEAR, whose single owner this is;
//   · the SW mirror re-assert;
//   · the shared one-second tick, so every relative time on the settings page froze.
// Mounting here makes "app-wide", which the driver's own contract already assumed, actually true.
//
// It renders nothing. Keeping it a component (rather than a hook called from the root view) keeps
// the root's own render out of the one-second tick's re-render path: only this leaf re-renders.
//
// EXACTLY ONE of these may exist. Two mounts would mean two /healthz polls, two toast decisions
// and two `window.location.reload()` racing each other — which is why the pill no longer calls
// these hooks and is now a pure renderer.

import { useAutoUpdate, useAutoUpdateMirrorSync } from "../store/autoUpdateStore";
import { useAutoUpdateDriver } from "./autoUpdateDriver";

export function AutoUpdateDriverMount() {
  const state = useAutoUpdate();
  useAutoUpdateMirrorSync();
  useAutoUpdateDriver(state);
  return null;
}
