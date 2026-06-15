// ru-fork: advanced chat mode — shared visual primitives for the transcript view.
// Theme-safe (semantic tokens only), nothing truncated: heavy content goes into
// a <Disclosure> (collapsed) so everything is reachable without clamping.
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

/** Collapsible section with a chevron + label and an optional right-aligned meta slot. */
export function Disclosure({
  label,
  meta,
  defaultOpen = false,
  tone = "muted",
  children,
}: {
  label: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  tone?: "muted" | "default";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-border/60">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent/50",
          tone === "muted" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 break-words">{label}</span>
        {meta ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{meta}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/60 px-2 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Monospace JSON / text block. Horizontal scroll only (never clips vertically). */
export function JsonBlock({ value }: { value: unknown }) {
  const text = (() => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  })();
  return (
    <pre className="overflow-x-auto rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

/** Copy-to-clipboard icon button, matching the chat bubble affordance. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Скопировать"
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}
