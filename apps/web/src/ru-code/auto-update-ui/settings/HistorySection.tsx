// ru-code: auto-update settings — «История проверок»: last checks with result + latency.
import { GitBranchIcon, GlobeIcon, HistoryIcon } from "lucide-react";

import { useAutoUpdate } from "../store/autoUpdateStore";
import type { SourceKind, CheckEntry } from "../model";
import { Badge } from "../ui-kit/badge";
import { SettingsSection } from "../ui-kit/layout";

const SOURCE_ICON: Record<SourceKind, typeof GlobeIcon> = {
  web: GlobeIcon,
  git: GitBranchIcon,
};

function ResultBadge({ result }: { result: CheckEntry["result"] }) {
  switch (result) {
    case "update":
      return (
        <Badge size="sm" variant="info">
          update found
        </Badge>
      );
    case "up-to-date":
      return (
        <Badge size="sm" variant="success">
          up to date
        </Badge>
      );
    case "error":
      return (
        <Badge size="sm" variant="error">
          failure
        </Badge>
      );
  }
}

export function HistorySection() {
  const state = useAutoUpdate();
  if (state === null || state.history.length === 0) return null;

  return (
    <SettingsSection icon={<HistoryIcon className="size-3.5" />} title="Check history">
      <ul>
        {state.history.map((entry) => {
          const Icon = SOURCE_ICON[entry.source];
          return (
            <li
              className="flex items-center gap-3 border-t border-border/60 px-4 py-2.5 first:border-t-0 sm:px-5"
              // The raw instant, never the rendered label: the label is localized and changes with
              // the clock, so keying on it remounted every row at the «только что» → «Сегодня»
              // boundary and collided for two same-minute rows.
              key={`${String(entry.atMs)}-${entry.source}-${entry.result}`}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="w-[7.5rem] shrink-0 text-xs text-muted-foreground">{entry.at}</span>
              <ResultBadge result={entry.result} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/75">
                {entry.detail}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                {entry.latencyMs === null ? "—" : `${entry.latencyMs} ms`}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
