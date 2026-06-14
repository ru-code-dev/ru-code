/**
 * Shared, controlled form state for a server's transport TEMPLATE (command/args/url/
 * headers with `${NAME}` holes). Secrets and per-project params live in the separate
 * `vars` block — not here. Timeout is a server-level field, also separate. Kept in one
 * place so the catalog dialog and the per-project dialog agree on fields + parsing (DRY).
 */

import type { McpProjectBinding, McpServerConfig, McpTransport, McpVar } from "../types";
import { parseHeaderLines } from "./addMcpParsing";

/** Editable, string-based mirror of an {@link McpServerConfig} template. */
export interface ServerConfigDraft {
  readonly transport: McpTransport;
  readonly command: string;
  readonly argsText: string;
  readonly httpUrl: string;
  readonly headersText: string;
}

/** Default connect/probe timeout (seconds) — placeholder when the field is empty. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

export const EMPTY_DRAFT: ServerConfigDraft = {
  transport: "stdio",
  command: "",
  argsText: "",
  httpUrl: "",
  headersText: "",
};

export function recordToLines(record: Readonly<Record<string, string>>, separator: string): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

/** Build an editable template draft from an existing config. */
export function draftFromConfig(config: McpServerConfig): ServerConfigDraft {
  if (config.transport === "stdio") {
    return {
      ...EMPTY_DRAFT,
      transport: "stdio",
      command: config.command,
      argsText: config.args.join(" "),
    };
  }
  return {
    ...EMPTY_DRAFT,
    transport: "http",
    httpUrl: config.httpUrl,
    headersText: recordToLines(config.headers, ": "),
  };
}

export type DraftResult = { ok: true; config: McpServerConfig } | { ok: false; error: string };

/** Validate + convert a template draft into a config, or return a user-facing error. */
export function configFromDraft(draft: ServerConfigDraft): DraftResult {
  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (command.length === 0) {
      return { ok: false, error: "Укажите команду для локального сервера." };
    }
    return {
      ok: true,
      config: {
        transport: "stdio",
        command,
        args: draft.argsText.split(/\s+/u).filter(Boolean),
      },
    };
  }
  const httpUrl = draft.httpUrl.trim();
  if (httpUrl.length === 0) {
    return { ok: false, error: "Укажите URL для удалённого сервера." };
  }
  return { ok: true, config: { transport: "http", httpUrl, headers: parseHeaderLines(draft.headersText) } };
}

// ── timeout (server-level / per-project) ─────────────────────────────────────
export type TimeoutResult = { ok: true; timeoutMs: number | undefined } | { ok: false; error: string };

/** Existing ms → the seconds field text (empty when unset). */
export function timeoutTextFromMs(timeoutMs: number | undefined): string {
  return timeoutMs !== undefined ? String(Math.round(timeoutMs / 1000)) : "";
}

/** Parse the seconds field → ms (or undefined when empty ⇒ inherit/default). */
export function parseTimeout(timeoutText: string): TimeoutResult {
  const trimmed = timeoutText.trim();
  if (trimmed.length === 0) {
    return { ok: true, timeoutMs: undefined };
  }
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 1) {
    return { ok: false, error: "Таймаут должен быть числом не меньше 1 секунды." };
  }
  return { ok: true, timeoutMs: Math.round(seconds) * 1000 };
}

// ── vars validation + warnings ───────────────────────────────────────────────
const VAR_NAME_PATTERN = /^[A-Z0-9_]+$/u;
const BUILTIN_VAR = "PROJECT_CWD";
// Matches a `${NAME}` hole; `$$` is an escape and never captures a name.
const TEMPLATE_REF_PATTERN = /\$\$|\$\{([A-Z0-9_]+)\}/gu;
// A `$` followed by a word char in a VALUE — qwen would try to expand it (§D12).
const VALUE_DOLLAR_PATTERN = /\$\{?[A-Za-z_]/u;

/** Hard errors that block saving. Returns the first problem, or ok. */
export function validateVars(vars: ReadonlyArray<McpVar>): { ok: true } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const variable of vars) {
    const name = variable.name.trim();
    if (name.length === 0) {
      return { ok: false, error: "У переменной должно быть имя." };
    }
    if (!VAR_NAME_PATTERN.test(name)) {
      return { ok: false, error: `Имя «${name}»: только заглавные латинские буквы, цифры и _.` };
    }
    if (name === BUILTIN_VAR) {
      return { ok: false, error: `«${BUILTIN_VAR}» — встроенная переменная, выберите другое имя.` };
    }
    if (seen.has(name)) {
      return { ok: false, error: `Переменная «${name}» объявлена дважды.` };
    }
    seen.add(name);
  }
  return { ok: true };
}

/** Every `${NAME}` referenced by the template (excludes `$$` escapes / `${PROJECT_CWD}`). */
function templateRefs(draft: ServerConfigDraft): Set<string> {
  const haystack =
    draft.transport === "stdio"
      ? `${draft.command} ${draft.argsText}`
      : `${draft.httpUrl} ${draft.headersText}`;
  const refs = new Set<string>();
  for (const match of haystack.matchAll(TEMPLATE_REF_PATTERN)) {
    const name = match[1];
    if (name !== undefined && name !== BUILTIN_VAR) {
      refs.add(name);
    }
  }
  return refs;
}

/**
 * Soft warnings (don't block saving): template refs to undeclared vars, and var
 * values that contain `$NAME`/`${…}` (qwen re-expands the overlay literally, §D12).
 */
export function varWarnings(draft: ServerConfigDraft, vars: ReadonlyArray<McpVar>): string[] {
  const declared = new Set(vars.map((variable) => variable.name.trim()).filter(Boolean));
  const warnings: string[] = [];
  for (const ref of templateRefs(draft)) {
    if (!declared.has(ref)) {
      warnings.push(`Шаблон ссылается на необъявленную переменную «${ref}».`);
    }
  }
  for (const variable of vars) {
    if (!variable.secret && VALUE_DOLLAR_PATTERN.test(variable.value)) {
      warnings.push(
        `Значение «${variable.name}» содержит «$…» — оно может быть искажено при подстановке.`,
      );
    }
  }
  return warnings;
}

// ── catalog-edit impact (AMEND-2: warn-on-impact modal) ──────────────────────
/** Structured impact of a catalog edit on the projects already using the server. */
export interface EditImpact {
  /** Per-project var names being removed that some project had already filled. */
  readonly removedVars: ReadonlyArray<{ readonly name: string; readonly projects: ReadonlyArray<string> }>;
  /** Projects newly knocked «требует настройки» by a brand-new required var with no value. */
  readonly newRequiredProjects: ReadonlyArray<string>;
}

/**
 * Describe how a catalog server edit affects the projects bound to it; `null` when non-disruptive
 * (so the dialog can save silently). Two disruptions are surfaced: removing a per-project var that a
 * project already supplied a value for, and adding a brand-new required var that no project can have
 * filled yet. Needs a project id→name resolver for human-readable copy.
 */
export function describeEditImpact(
  server: { readonly id: string; readonly vars: readonly McpVar[] },
  nextVars: readonly McpVar[],
  bindings: readonly McpProjectBinding[],
  projectName: (projectId: string) => string,
): EditImpact | null {
  const nextNames = new Set(nextVars.map((variable) => variable.name));
  const serverBindings = bindings.filter((binding) => binding.serverId === server.id);
  const removedVars = server.vars
    .filter((variable) => variable.perProject && !nextNames.has(variable.name))
    .map((variable) => ({
      name: variable.name,
      projects: serverBindings
        .filter((binding) => variable.name in binding.varValues)
        .map((binding) => projectName(binding.projectId)),
    }))
    .filter((removed) => removed.projects.length > 0);
  const newRequired = nextVars.filter(
    (variable) =>
      variable.required &&
      variable.value.trim().length === 0 &&
      !server.vars.some((existing) => existing.name === variable.name),
  );
  const newRequiredProjects =
    newRequired.length > 0 && serverBindings.length > 0
      ? serverBindings.map((binding) => projectName(binding.projectId))
      : [];
  return removedVars.length > 0 || newRequiredProjects.length > 0
    ? { removedVars, newRequiredProjects }
    : null;
}
