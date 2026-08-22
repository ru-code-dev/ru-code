// ru-code: auto-update settings — «Что нового» card, shown while an update is
// available. §5.3: renders the ACCUMULATED, version-grouped changelog from
// `release.changelog` (every version newer than the installed one, newest-first),
// with a per-version header and the existing colored badges. When the display was
// capped, a trailing «и более ранние изменения…» line is shown.
import { GiftIcon } from "lucide-react";
import { forwardRef } from "react";

import { useAutoUpdate } from "../store/autoUpdateStore";
import type { NoteKind } from "../model";
import { Badge } from "../ui-kit/badge";
import { CopyButton } from "../ui-kit/custom/CopyButton";
import { SettingsSection } from "../ui-kit/layout";

const NOTE_META: Record<
  NoteKind,
  { label: string; variant: "info" | "success" | "warning" | "secondary" }
> = {
  feat: { label: "feature", variant: "info" },
  fix: { label: "fixed", variant: "success" },
  perf: { label: "faster", variant: "warning" },
  ui: { label: "interface", variant: "secondary" },
};

export const ReleaseNotesSection = forwardRef<HTMLDivElement>(function ReleaseNotesSection(_, ref) {
  const state = useAutoUpdate();
  if (state === null || state.release === null) return null;
  const release = state.release;

  return (
    <div id="auto-update-release-notes" ref={ref}>
      <SettingsSection
        icon={<GiftIcon className="size-3.5" />}
        title={`What's new in v${release.version}`}
      >
        <div className="space-y-4 p-4 sm:p-5">
          {release.changelog.map((group) => (
            <div key={group.version} className="space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] font-semibold text-foreground/80">
                  v{group.version}
                </span>
                <span className="h-px flex-1 bg-border/60" />
              </div>
              <ul className="space-y-2.5">
                {group.notes.map((note) => {
                  const meta = note.kind !== null ? NOTE_META[note.kind] : null;
                  return (
                    <li className="flex items-start gap-2.5" key={`${group.version}-${note.text}`}>
                      {meta ? (
                        <Badge className="mt-0.5 shrink-0" size="sm" variant={meta.variant}>
                          {meta.label}
                        </Badge>
                      ) : null}
                      <span className="text-[13px] leading-relaxed text-foreground/90">
                        {note.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {release.changelogTruncated ? (
            <p className="text-xs text-muted-foreground/70">and earlier changes…</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
          <span>
            Released <span className="text-foreground/80">{release.releasedAgo}</span>
          </span>
          <span>
            Size <span className="font-mono text-foreground/80">{release.sizeMb} MB</span>
          </span>
          <span className="flex items-center gap-1">
            sha256{" "}
            <span className="font-mono text-foreground/80">{release.sha256.slice(0, 12)}…</span>
            <CopyButton size="icon-xs" value={release.sha256} variant="ghost" />
          </span>
        </div>
      </SettingsSection>
    </div>
  );
});
