// ru-fork: advanced chat mode — one merged tool step (call + result + telemetry).
// Header: tool name · status · duration. Body: command/args, diff (collapsed,
// with +/- diffStat), result variants, and a visible reason for cancel/error.
import { getFiletypeFromFileName, parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { TranscriptPart, TranscriptToolDisplay } from "@t3tools/contracts";
import { createTwoFilesPatch } from "diff";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Badge } from "~/components/ui/badge";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { ADVANCED_CHAT_PENDING_PREVIEW, ADVANCED_CHAT_RICH_DIFF } from "~/ru-fork/config";

import { Disclosure, JsonBlock } from "./transcriptVisuals";
import type { ToolStep, ToolStepStatus } from "./transcriptFlow";

type BadgeVariant = "secondary" | "success" | "error" | "info";

const STATUS_META: Record<ToolStepStatus, { label: string; variant: BadgeVariant }> = {
  success: { label: "успешно", variant: "success" },
  error: { label: "ошибка", variant: "error" },
  cancelled: { label: "отменено", variant: "secondary" },
  running: { label: "выполняется", variant: "info" },
};

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

function diffStatLabel(diffStat: unknown): ReactNode {
  if (typeof diffStat !== "object" || diffStat === null) return null;
  const stat = diffStat as Record<string, unknown>;
  const added = typeof stat["model_added_lines"] === "number" ? stat["model_added_lines"] : 0;
  const removed = typeof stat["model_removed_lines"] === "number" ? stat["model_removed_lines"] : 0;
  if (added === 0 && removed === 0) return null;
  return (
    <span className="flex items-center gap-1.5 font-mono text-[0.7rem]">
      <span className="text-success">+{added}</span>
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

/** Raw fallback: the unified patch text, Shiki-highlighted, behind a disclosure. */
function RawDiffView({
  patch,
  fileName,
  diffStat,
  cwd,
}: {
  patch: string;
  fileName: string;
  diffStat: unknown;
  cwd: string | undefined;
}) {
  return (
    <Disclosure
      label={<code className="font-mono text-xs text-foreground">{fileName || "diff"}</code>}
      meta={
        diffStatLabel(diffStat) ?? (
          <Badge variant="outline" size="sm">
            diff
          </Badge>
        )
      }
    >
      <ChatMarkdown text={`\`\`\`diff\n${patch}\n\`\`\``} cwd={cwd} />
    </Disclosure>
  );
}

/** Rich renderer: parse the unified patch and render @pierre/diffs FileDiff
 *  (clean gutter, native collapse, theme-aware). Falls back to RawDiffView when
 *  the patch can't be parsed. The diff worker pool is provided by the route. */
function FileDiffView({
  patch,
  fileName,
  diffStat,
  cwd,
}: {
  patch: string;
  fileName: string;
  diffStat: unknown;
  cwd: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(true);
  const files = useMemo(() => {
    const trimmed = patch.trim();
    if (trimmed.length === 0) return null;
    try {
      const parsed = parsePatchFiles(trimmed, `transcript:${fileName}:${trimmed.length}`).flatMap(
        (entry) => entry.files,
      );
      return parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }, [patch, fileName]);

  if (!files) {
    return <RawDiffView patch={patch} fileName={fileName} diffStat={diffStat} cwd={cwd} />;
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((fileDiff, index) => (
        <FileDiff
          key={`${fileName}-${index}`}
          fileDiff={fileDiff}
          renderHeaderPrefix={() => (
            <button
              type="button"
              aria-label={collapsed ? "Развернуть diff" : "Свернуть diff"}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10"
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((value) => !value);
              }}
            >
              {collapsed ? (
                <ChevronRightIcon className="size-4" />
              ) : (
                <ChevronDownIcon className="size-4" />
              )}
            </button>
          )}
          options={{
            collapsed,
            diffStyle: "unified",
            lineDiffType: "none",
            overflow: "wrap",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
          }}
        />
      ))}
    </div>
  );
}

/** Render a unified patch with the rich renderer or the raw fallback per flag. */
function DiffBody(props: {
  patch: string;
  fileName: string;
  diffStat: unknown;
  cwd: string | undefined;
}) {
  return ADVANCED_CHAT_RICH_DIFF ? <FileDiffView {...props} /> : <RawDiffView {...props} />;
}

const TODO_ICON: Record<string, ReactNode> = {
  completed: <CheckCircle2Icon className="size-3.5 text-success" />,
  in_progress: <CircleDashedIcon className="size-3.5 text-info" />,
  pending: <CircleIcon className="size-3.5 text-muted-foreground" />,
};

function DisplayView({
  display,
  cwd,
}: {
  display: TranscriptToolDisplay;
  cwd: string | undefined;
}) {
  switch (display.kind) {
    case "text":
      return display.text.trim().length === 0 ? null : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed text-foreground">
          {display.text}
        </pre>
      );
    case "file_diff":
      return (
        <DiffBody
          patch={display.fileDiff}
          fileName={display.fileName}
          diffStat={display.diffStat}
          cwd={cwd}
        />
      );
    case "todo_list":
      return (
        <ul className="flex flex-col gap-1">
          {display.todos.map((todo) => (
            <li key={todo.id || todo.content} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0">
                {TODO_ICON[todo.status] ?? TODO_ICON["pending"]}
              </span>
              <span
                className={cn(
                  "min-w-0 break-words",
                  todo.status === "completed"
                    ? "text-muted-foreground line-through"
                    : "text-foreground",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      );
    case "plan_summary":
      return (
        <div className="flex flex-col gap-2">
          {display.rejected ? (
            <Badge variant="error" size="sm">
              план отклонён
            </Badge>
          ) : null}
          {display.message.trim().length > 0 ? (
            <ChatMarkdown text={display.message} cwd={cwd} />
          ) : null}
          {display.plan.trim().length > 0 ? (
            <div className="rounded-md border border-border/60 bg-muted/30 p-2">
              <ChatMarkdown text={display.plan} cwd={cwd} />
            </div>
          ) : null}
        </div>
      );
    case "task_execution":
      return (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" size="sm">
              {display.subagentName || "подагент"}
            </Badge>
            <Badge variant="outline" size="sm">
              {display.status}
            </Badge>
          </div>
          {display.taskDescription.trim().length > 0 ? (
            <p className="break-words text-sm text-foreground">{display.taskDescription}</p>
          ) : null}
          {display.result && display.result.trim().length > 0 ? (
            <ChatMarkdown text={display.result} cwd={cwd} />
          ) : null}
          {display.toolCalls && display.toolCalls.length > 0 ? (
            <Disclosure
              label="Вызовы инструментов подагента"
              meta={
                <Badge variant="outline" size="sm">
                  {display.toolCalls.length}
                </Badge>
              }
            >
              <JsonBlock value={display.toolCalls} />
            </Disclosure>
          ) : null}
        </div>
      );
    case "mcp_progress": {
      const ratio =
        display.total && display.total > 0
          ? Math.min(1, Math.max(0, display.progress / display.total))
          : null;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{display.message ?? "выполнение"}</span>
            <span className="font-mono">
              {display.progress}
              {display.total !== undefined ? ` / ${display.total}` : ""}
            </span>
          </div>
          {ratio !== null ? (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${ratio * 100}%` }}
              />
            </div>
          ) : null}
        </div>
      );
    }
    case "ansi":
      return (
        <Disclosure label="Вывод терминала">
          <JsonBlock value={display.raw} />
        </Disclosure>
      );
    case "unknown":
      return (
        <Disclosure
          label="Результат"
          meta={
            <Badge variant="outline" size="sm">
              raw
            </Badge>
          }
        >
          <JsonBlock value={display.raw} />
        </Disclosure>
      );
  }
}

function responsePreview(
  parts: ReadonlyArray<TranscriptPart>,
): { preview: string; value: unknown } | null {
  for (const part of parts) {
    if (part.kind !== "function_response") continue;
    const response = part.response;
    const output =
      typeof response === "string"
        ? response
        : typeof response === "object" &&
            response !== null &&
            typeof (response as Record<string, unknown>)["output"] === "string"
          ? ((response as Record<string, unknown>)["output"] as string)
          : undefined;
    const preview = (output ?? JSON.stringify(response) ?? "").replace(/\s+/g, " ").trim();
    return {
      preview: preview.length > 80 ? `${preview.slice(0, 80)}…` : preview,
      value: output ?? response,
    };
  }
  return null;
}

type FilePreview =
  | {
      readonly kind: "diff";
      readonly fileName: string;
      readonly patch: string;
      readonly replaceAll: boolean;
    }
  | {
      readonly kind: "content";
      readonly fileName: string;
      readonly content: string;
      readonly language: string;
    };

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function baseName(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/** Wrap `content` in a fence longer than any backtick run inside it, so a file
 *  that itself contains ``` blocks (e.g. a Markdown doc) can't close it early. */
function codeFence(content: string, language: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}

/** A pending edit/write_file — recorded function_call with no result yet — gets
 *  a preview of what WILL be applied. `edit`/`replace` (qwen ToolNames: `edit`,
 *  legacy alias `replace`) → an old→new diff synthesized from the call args;
 *  `write_file` → the proposed content as a code block. null for everything else
 *  and for already-completed steps (DisplayView owns those). */
function buildFilePreview(step: ToolStep): FilePreview | null {
  if (step.display !== undefined) return null;
  if (typeof step.args !== "object" || step.args === null) return null;
  const args = step.args as Record<string, unknown>;
  const filePath = asText(args["file_path"]) ?? "";
  const fileName = filePath ? baseName(filePath) : "файл";

  if (step.name === "edit" || step.name === "replace") {
    const before = asText(args["old_string"]) ?? "";
    const after = asText(args["new_string"]) ?? "";
    const patch = createTwoFilesPatch(fileName, fileName, before, after);
    return { kind: "diff", fileName, patch, replaceAll: args["replace_all"] === true };
  }
  if (step.name === "write_file") {
    const content = asText(args["content"]);
    if (content === undefined) return null;
    return { kind: "content", fileName, content, language: getFiletypeFromFileName(fileName) };
  }
  return null;
}

const HEAVY_ARG_KEYS: ReadonlySet<string> = new Set(["content", "old_string", "new_string"]);

/** Drop the large text fields from edit/write_file args so the JSON disclosure
 *  shows only the small ones (file_path, replace_all); the body/diff is rendered
 *  on its own, never as escaped JSON. Other tools keep their full args. */
function compactArgs(name: string, args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  if (name !== "edit" && name !== "replace" && name !== "write_file") return args;
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!HEAVY_ARG_KEYS.has(key)) compact[key] = value;
  }
  return compact;
}

function isRenderableArgs(args: unknown): boolean {
  if (args === undefined) return false;
  if (typeof args === "object" && args !== null) return Object.keys(args).length > 0;
  return true;
}

function FilePreviewView({ preview, cwd }: { preview: FilePreview; cwd: string | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="info" size="sm">
          предпросмотр
        </Badge>
        <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">
          {preview.fileName}
        </code>
        {preview.kind === "diff" && preview.replaceAll ? (
          <Badge variant="secondary" size="sm">
            ко всем совпадениям
          </Badge>
        ) : null}
      </div>
      {preview.kind === "diff" ? (
        <DiffBody
          patch={preview.patch}
          fileName={preview.fileName}
          diffStat={undefined}
          cwd={cwd}
        />
      ) : (
        <Disclosure
          label="Содержимое файла"
          meta={
            <Badge variant="outline" size="sm">
              {`${preview.content.split("\n").length} стр.`}
            </Badge>
          }
        >
          <ChatMarkdown text={codeFence(preview.content, preview.language)} cwd={cwd} />
        </Disclosure>
      )}
    </div>
  );
}

export function ToolStepCard({ step, cwd }: { step: ToolStep; cwd: string | undefined }) {
  const status = STATUS_META[step.status];
  const duration = formatDuration(step.durationMs);
  const response = responsePreview(step.response);
  const filePreview = useMemo(
    () => (ADVANCED_CHAT_PENDING_PREVIEW ? buildFilePreview(step) : null),
    [step],
  );
  const argsForDisplay = useMemo(() => compactArgs(step.name, step.args), [step.name, step.args]);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
        {step.command !== undefined ? (
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <code className="min-w-0 break-all font-mono text-xs font-medium text-foreground">
          {step.name || "инструмент"}
        </code>
        <Badge variant={status.variant} size="sm">
          {status.label}
        </Badge>
        {duration ? (
          <span className="ml-auto font-mono text-[0.7rem] text-muted-foreground">{duration}</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 p-2.5">
        {step.command !== undefined ? (
          <pre className="overflow-x-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs text-foreground">
            <span className="text-muted-foreground">$ </span>
            {step.command}
          </pre>
        ) : isRenderableArgs(argsForDisplay) ? (
          <Disclosure label="Аргументы">
            <JsonBlock value={argsForDisplay} />
          </Disclosure>
        ) : null}

        {filePreview ? <FilePreviewView preview={filePreview} cwd={cwd} /> : null}

        {step.error ? (
          <div className="flex items-start gap-1.5 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive-foreground dark:bg-destructive/16">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{step.error}</span>
          </div>
        ) : null}

        {step.display ? <DisplayView display={step.display} cwd={cwd} /> : null}

        {response && response.preview.length > 0 ? (
          <Disclosure
            label="Ответ"
            meta={
              <span className="max-w-[16rem] truncate font-mono text-[0.7rem] text-muted-foreground">
                {response.preview}
              </span>
            }
          >
            <JsonBlock value={response.value} />
          </Disclosure>
        ) : null}
      </div>
    </div>
  );
}
