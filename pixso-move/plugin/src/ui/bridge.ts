import { useEffect } from "react";

import type { CodeToUi, UiToCode } from "../shared/messages.ts";

// True only inside the real plugin iframe (the host is a different window).
// In the local dev server the UI runs top-level, so we must not post to ourselves.
const inPlugin = typeof window !== "undefined" && window.parent !== window;

// Post a message to the sandbox. Pixso forwards iframe postMessage to code's onmessage.
export const postToCode = (message: UiToCode): void => {
  if (inPlugin) parent.postMessage({ pluginMessage: message }, "*");
};

// Subscribe to sandbox -> UI messages (unwrapping the `pluginMessage` envelope) and
// forward each to the dispatcher (the pure reducer turns them into state).
export const useBridge = (onMessage: (message: CodeToUi) => void): void => {
  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      const data = event.data as { pluginMessage?: CodeToUi } | null;
      const message = data?.pluginMessage;
      if (message) onMessage(message);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);
};
