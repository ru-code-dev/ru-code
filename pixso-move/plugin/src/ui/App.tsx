import { useCallback, useEffect, useReducer } from "react";

import { sendToServer } from "./api.ts";
import { postToCode, useBridge } from "./bridge.ts";
import { showSuccess } from "./components/Toaster.tsx";
import { MainScreen } from "./screens/MainScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { initialState, reduce } from "./state/reducer.ts";
import { applyTheme } from "./theme.ts";
import type { CodeToUi } from "../shared/messages.ts";
import type { Settings } from "./state/types.ts";

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const { settings } = state;

  const onMessage = useCallback(
    (message: CodeToUi): void => {
      dispatch(message);
      if (message.type === "settings-loaded") {
        applyTheme(message.settings.themeName, message.settings.themeMode);
        return;
      }
      if (message.type !== "collected") return;
      void sendToServer(settings, {
        designerId: settings.designerId,
        rootName: message.rootName,
        nodesJson: message.nodesJson,
        preview: message.preview,
      }).then((result) => {
        dispatch({ type: "send-result", result });
        if (result.ok) showSuccess("Дизайн успешно отправлен");
      });
    },
    [settings],
  );
  useBridge(onMessage);

  const needsPreview = state.selectionVerdict.ok && state.preview === null;
  useEffect(() => {
    if (needsPreview) postToCode({ type: "request-preview" });
  }, [needsPreview]);

  const onSend = useCallback((): void => {
    if (settings.designerId.length === 0) {
      dispatch({ type: "open-settings" });
      return;
    }
    dispatch({ type: "send-start" });
    postToCode({ type: "collect-and-send-meta" });
  }, [settings.designerId]);

  // Every settings change is real-time: apply the theme live and persist the
  // whole blob to clientStorage (via the sandbox). No save button.
  const onChange = useCallback((next: Settings): void => {
    applyTheme(next.themeName, next.themeMode);
    dispatch({ type: "edit-settings", settings: next });
    postToCode({ type: "save-settings", settings: next });
  }, []);

  if (state.screen === "settings") {
    return (
      <SettingsScreen
        settings={settings}
        onChange={onChange}
        onBack={() => dispatch({ type: "close-settings" })}
      />
    );
  }
  return (
    <MainScreen
      state={state}
      onOpenSettings={() => dispatch({ type: "open-settings" })}
      onSend={onSend}
    />
  );
}
