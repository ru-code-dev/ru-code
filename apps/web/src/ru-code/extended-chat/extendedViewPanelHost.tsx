// ru-code: the registry entry's mount for the extended view's detail panel (sync-wave R1/R7).
// Thin by construction: the panel component, its chrome and everything it renders live in the
// PACKAGE, and the timeline publishes the content — so this file passes the host's `mode` and
// `onClose` through and nothing else. The panel needs no ports of its own: the ones the
// timeline was given ride along in the publication.
import type { DiffPanelMode } from "@smart-tools/qwen-cli-ui-kit";

import { ExtendedViewPanel } from "./extendedChatHost";

export function ExtendedViewPanelHost({
  mode,
  onClose,
}: {
  mode: DiffPanelMode;
  onClose: () => void;
}) {
  return <ExtendedViewPanel mode={mode} onClose={onClose} />;
}
