// ru-code: the MCP manager's settings section (auto-recheck cadence). Server-owned
// settings: read from the primary server settings atom, written through the shared
// server-settings patch command (deep-merged server-side; 0 = that transport is probed
// only once — on a manual recheck or a config change).

import { useAtomValue } from "@effect/atom-react";
import { L } from "@ru-code/localization";

import { Input } from "~/components/ui/input";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { serverEnvironment, primaryServerSettingsAtom } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

export function McpSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const mcpSettings = useAtomValue(primaryServerSettingsAtom).mcp;
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, "mcp settings change");

  const setMcpRecheckMinutes = (
    field: "recheckLocalMinutes" | "recheckRemoteMinutes",
    raw: string,
  ) => {
    const minutes = Number(raw);
    if (environmentId !== null && Number.isFinite(minutes) && minutes >= 0) {
      void persistSettings({
        environmentId,
        input: { patch: { mcp: { [field]: Math.round(minutes) } } },
      });
    }
  };

  return (
    <SettingsSection title={L("MCP servers", "MCP-серверы")}>
      <SettingsRow
        title={L("Recheck local (min)", "Перепроверка локальных (мин)")}
        description={L(
          "How often to recheck the status of the active project's local (stdio) MCP servers. 0 — check only once.",
          "Как часто перепроверять статус локальных (stdio) MCP-серверов активного проекта. 0 — проверять только один раз.",
        )}
        control={
          <Input
            type="number"
            min={0}
            className="w-full sm:w-28"
            aria-label={L(
              "Local MCP recheck interval (minutes)",
              "Интервал перепроверки локальных MCP (минуты)",
            )}
            value={String(mcpSettings.recheckLocalMinutes)}
            onChange={(event) => setMcpRecheckMinutes("recheckLocalMinutes", event.target.value)}
          />
        }
      />
      <SettingsRow
        title={L("Recheck remote (min)", "Перепроверка удалённых (мин)")}
        description={L(
          "How often to recheck the status of the active project's remote (HTTP) MCP servers. 0 — check only once.",
          "Как часто перепроверять статус удалённых (HTTP) MCP-серверов активного проекта. 0 — проверять только один раз.",
        )}
        control={
          <Input
            type="number"
            min={0}
            className="w-full sm:w-28"
            aria-label={L(
              "Remote MCP recheck interval (minutes)",
              "Интервал перепроверки удалённых MCP (минуты)",
            )}
            value={String(mcpSettings.recheckRemoteMinutes)}
            onChange={(event) => setMcpRecheckMinutes("recheckRemoteMinutes", event.target.value)}
          />
        }
      />
    </SettingsSection>
  );
}
