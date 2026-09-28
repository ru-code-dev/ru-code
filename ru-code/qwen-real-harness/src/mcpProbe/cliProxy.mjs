// ru-code (S94 probe): the CLI the app spawns INSTEAD of qwen — a transparent recorder in front of
// the REAL qwen bundle.
//
// The app points `RU_CODE_CLI_JS` here and spawns `node cliProxy.mjs <argv>` exactly as it would
// spawn qwen (its own spawn builder, env, cwd, overlay file). This proxy then:
//
//   1. records what the app handed over: argv, cwd, the relevant env, and the BYTES of the settings
//      file named by QWEN_CODE_SYSTEM_SETTINGS_PATH — at exec, after `initialize`, just BEFORE the
//      app receives the `session/new` and `session/prompt` answers (the app deletes the file once
//      the start settles, so "after" must be taken before the app hears it), and on every change a
//      50 ms stat watch sees (qwen rewriting it, the app deleting it);
//   2. runs the real qwen (`PROBE_REAL_QWEN_CLI`) as its child with the SAME argv/env/cwd plus
//      `QWEN_DEBUG_LOG_FILE=1`, and tees the ACP wire both ways, line by line, with timestamps;
//   3. asks qwen's own status methods (`qwen/status/...`) with ids of its own (`probe-*`) at set
//      offsets after `session/new` and after every prompt answer — their answers are recorded and
//      never reach the app;
//   4. only when a knob asks for it: holds the app's `session/prompt` (and everything queued after
//      it) until `PROBE_HOLD_PROMPT_MS` after `session/new` was answered, or applies an explicit
//      transform (`PROBE_TRANSFORM`, JSON) to the settings file / argv / cwd / ACP params. Every
//      transform is recorded with the bytes before and after — the baseline sets none.
//
// Non-ACP invocations (`--version`, `-p`) are recorded and then run with inherited stdio.
//
// Env (all optional except the first two):
//   PROBE_REAL_QWEN_CLI   the real bundle's dist/cli.js
//   PROBE_LOG_DIR         where each invocation gets its own `proc-<ms>-<pid>/` directory
//   PROBE_HOLD_PROMPT_MS  see 4.
//   PROBE_STATUS_AT_MS    comma list of offsets (ms) after the `session/new` answer (default 1000,40000)
//   PROBE_CHILD_ENV_JSON  extra env for the qwen child, e.g. {"QWEN_CODE_LEGACY_MCP_BLOCKING":"1"}
//   PROBE_TRANSFORM       JSON: { settingsMerge?, serverMerge?, deleteSettingsKeys?, deleteServerKeys?,
//                                 dropAllowedFlag?, channel?: "acp", setModeOverride?, childCwd? }
//                         (setModeOverride rewrites the app's per-turn approval-mode call;
//                          renameServers {oldKey: newKey} renames overlay keys AND allowlist tokens)
//   PROBE_SERVER_ROLES    JSON {role: marker}: the overlay entry whose JSON contains `marker` is that
//                         role's server. The key the APP gave it is recorded in `roles.json`, and every
//                         `{{key:<role>}}` inside PROBE_TRANSFORM is replaced by it — so a knob can name
//                         a server qwen will see without knowing how the app keys it.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const REAL_CLI = process.env["PROBE_REAL_QWEN_CLI"];
const LOG_ROOT = process.env["PROBE_LOG_DIR"];
if (!REAL_CLI || !LOG_ROOT) {
  process.stderr.write("cliProxy: PROBE_REAL_QWEN_CLI and PROBE_LOG_DIR are required\n");
  process.exit(1);
}

const bornAt = Date.now();
const procDir = NodePath.join(LOG_ROOT, `proc-${String(bornAt)}-${String(process.pid)}`);
NodeFS.mkdirSync(procDir, { recursive: true });

const appendJsonl = (name, row) => {
  try {
    NodeFS.appendFileSync(NodePath.join(procDir, name), `${JSON.stringify(row)}\n`);
  } catch {
    /* evidence, never a failure source */
  }
};
const stamp = () => ({ at: new Date().toISOString(), ms: Date.now() });

/** End this process the way qwen ended, so the app sees the same death (a signal, or a code). */
const exitLikeChild = (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
};

const args = process.argv.slice(2);
const isAcp = args.includes("--acp");
const settingsPath = process.env["QWEN_CODE_SYSTEM_SETTINGS_PATH"];

const parseJson = (raw, fallback) => {
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const serverRoles = parseJson(process.env["PROBE_SERVER_ROLES"], {});
const childEnvExtra = parseJson(process.env["PROBE_CHILD_ENV_JSON"], {});
const holdPromptMs = Number(process.env["PROBE_HOLD_PROMPT_MS"] ?? "0") || 0;
const statusOffsets = (process.env["PROBE_STATUS_AT_MS"] ?? "1000,40000")
  .split(",")
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value) && value >= 0);

// ── the settings file: bytes + stat, on demand and on every change ─────────────────────────────
const snapshotSettings = (label) => {
  const row = { ...stamp(), label, path: settingsPath ?? null };
  if (!settingsPath) {
    appendJsonl("settings.jsonl", { ...row, exists: false, reason: "no env" });
    return null;
  }
  try {
    const stat = NodeFS.statSync(settingsPath);
    const bytes = NodeFS.readFileSync(settingsPath);
    const snapshot = {
      ...row,
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      mode: (stat.mode & 0o777).toString(8),
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf8"),
    };
    appendJsonl("settings.jsonl", snapshot);
    return snapshot;
  } catch (error) {
    appendJsonl("settings.jsonl", { ...row, exists: false, reason: String(error?.code ?? error) });
    return null;
  }
};

const RELEVANT_ENV = /^(QWEN|OPENAI|GEMINI|NODE_|HOME$|DEBUG|T3CODE|RU_CODE|CLI_|TERM$|CI$)/;
const envSelected = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => RELEVANT_ENV.test(name) && !name.startsWith("PROBE_"),
  ),
);

// ── the app's server keys, by role (what the app wrote, before any transform) ─────────────────
const roleKeys = (() => {
  try {
    const servers = JSON.parse(NodeFS.readFileSync(settingsPath ?? "", "utf8")).mcpServers ?? {};
    return Object.fromEntries(
      Object.entries(serverRoles).flatMap(([role, marker]) => {
        const found = Object.entries(servers).find(([, entry]) =>
          JSON.stringify(entry).includes(marker),
        );
        return found ? [[role, found[0]]] : [];
      }),
    );
  } catch {
    return {};
  }
})();
NodeFS.writeFileSync(NodePath.join(procDir, "roles.json"), `${JSON.stringify(roleKeys)}\n`);
const transform = JSON.parse(
  JSON.stringify(parseJson(process.env["PROBE_TRANSFORM"], {})).replaceAll(
    /\{\{key:(\w+)\}\}/g,
    (token, role) => roleKeys[role] ?? token,
  ),
);

// ── transforms (knobs only; the baseline has none) ─────────────────────────────────────────────
const applySettingsTransform = () => {
  const touchesFile =
    transform.settingsMerge !== undefined ||
    transform.serverMerge !== undefined ||
    transform.deleteSettingsKeys !== undefined ||
    transform.deleteServerKeys !== undefined ||
    transform.renameServers !== undefined ||
    transform.channel === "acp";
  if (!touchesFile || !settingsPath || !NodeFS.existsSync(settingsPath)) return undefined;
  const before = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
  const after = structuredClone(before);
  for (const key of transform.deleteSettingsKeys ?? []) {
    const path = key.split(".");
    let cursor = after;
    for (const segment of path.slice(0, -1)) cursor = cursor?.[segment];
    if (cursor && typeof cursor === "object") delete cursor[path[path.length - 1]];
  }
  if (transform.settingsMerge !== undefined) {
    const merge = (target, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          target[key] = target[key] && typeof target[key] === "object" ? target[key] : {};
          merge(target[key], value);
        } else {
          target[key] = value;
        }
      }
    };
    merge(after, transform.settingsMerge);
  }
  let movedServers = null;
  if (transform.renameServers !== undefined && after.mcpServers) {
    after.mcpServers = Object.fromEntries(
      Object.entries(after.mcpServers).map(([name, entry]) => [
        transform.renameServers[name] ?? name,
        entry,
      ]),
    );
  }
  for (const [name, entry] of Object.entries(after.mcpServers ?? {})) {
    for (const key of transform.deleteServerKeys ?? []) delete entry[key];
    if (transform.serverMerge !== undefined) Object.assign(entry, transform.serverMerge);
    after.mcpServers[name] = entry;
  }
  if (transform.channel === "acp") {
    movedServers = after.mcpServers ?? {};
    delete after.mcpServers;
  }
  NodeFS.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600 });
  appendJsonl("transforms.jsonl", { ...stamp(), kind: "settings", transform, before, after });
  return movedServers;
};

const toAcpServers = (servers) =>
  Object.entries(servers ?? {}).map(([name, entry]) =>
    entry.command !== undefined
      ? {
          name,
          command: entry.command,
          args: entry.args ?? [],
          env: Object.entries(entry.env ?? {}).map(([envName, value]) => ({
            name: envName,
            value: String(value),
          })),
        }
      : {
          type: "http",
          name,
          url: entry.httpUrl ?? entry.url,
          headers: Object.entries(entry.headers ?? {}).map(([headerName, value]) => ({
            name: headerName,
            value: String(value),
          })),
        },
  );

// ── record the invocation ──────────────────────────────────────────────────────────────────────
NodeFS.writeFileSync(
  NodePath.join(procDir, "meta.json"),
  `${JSON.stringify(
    {
      ...stamp(),
      pid: process.pid,
      ppid: process.ppid,
      argv: args,
      cwd: process.cwd(),
      isAcp,
      realCli: REAL_CLI,
      envSelected,
      envKeys: Object.keys(process.env).sort(),
      holdPromptMs,
      statusOffsets,
      childEnvExtra,
      transform,
    },
    null,
    2,
  )}\n`,
);
snapshotSettings("exec");

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PROBE_")),
);
childEnv["QWEN_DEBUG_LOG_FILE"] = "1";
Object.assign(childEnv, childEnvExtra);

let childArgs = [...args];
if (transform.dropAllowedFlag === true) {
  const index = childArgs.indexOf("--allowed-mcp-server-names");
  if (index >= 0) childArgs.splice(index, 2);
  appendJsonl("transforms.jsonl", { ...stamp(), kind: "argv", before: args, after: childArgs });
}
if (transform.renameServers !== undefined) {
  const index = childArgs.indexOf("--allowed-mcp-server-names");
  if (index >= 0 && index + 1 < childArgs.length) {
    const before = [...childArgs];
    childArgs[index + 1] = childArgs[index + 1]
      .split(",")
      .map((token) => transform.renameServers[token] ?? token)
      .join(",");
    appendJsonl("transforms.jsonl", { ...stamp(), kind: "argv-rename", before, after: childArgs });
  }
}
const childCwd = typeof transform.childCwd === "string" ? transform.childCwd : process.cwd();

if (!isAcp) {
  const child = NodeChildProcess.spawn(process.execPath, [REAL_CLI, ...childArgs], {
    cwd: childCwd,
    env: childEnv,
    stdio: "inherit",
  });
  appendJsonl("lifecycle.jsonl", { ...stamp(), event: "child-spawned", childPid: child.pid });
  child.on("exit", (code, signal) => {
    appendJsonl("lifecycle.jsonl", { ...stamp(), event: "child-exit", code, signal });
    snapshotSettings("child-exit");
    exitLikeChild(code, signal);
  });
} else {
  const applied = applySettingsTransform();
  const movedServers = applied ?? null;
  // The bytes qwen actually gets once a knob changed the file (undefined ⇒ nothing applied).
  if (applied !== undefined) snapshotSettings("transformed");

  // Watch the file: qwen rewriting it, the app deleting it — each with its bytes.
  let lastSignature = null;
  const watch = setInterval(() => {
    let signature;
    try {
      const stat = NodeFS.statSync(settingsPath ?? "");
      signature = `${String(stat.mtimeMs)}:${String(stat.size)}:${String(stat.ino)}`;
    } catch {
      signature = "absent";
    }
    if (signature !== lastSignature) {
      if (lastSignature !== null)
        snapshotSettings(`watch-change (${lastSignature} -> ${signature})`);
      lastSignature = signature;
    }
  }, 50);
  watch.unref();

  const child = NodeChildProcess.spawn(process.execPath, [REAL_CLI, ...childArgs], {
    cwd: childCwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  appendJsonl("lifecycle.jsonl", {
    ...stamp(),
    event: "child-spawned",
    childPid: child.pid,
    childCwd,
    childArgs,
  });

  const wire = (dir, line, parsed, note) =>
    appendJsonl("wire.jsonl", { ...stamp(), dir, ...(note ? { note } : {}), msg: parsed ?? line });

  // — app → qwen —
  const pendingAppCalls = new Map(); // id → method
  let sessionNewAnsweredAt = null;
  let queueBlockedUntil = 0;
  const queue = [];
  let releaseTimer = null;
  const toChild = (text) => child.stdin.write(`${text}\n`);
  const flushQueue = () => {
    releaseTimer = null;
    while (queue.length > 0) {
      if (Date.now() < queueBlockedUntil) {
        releaseTimer = setTimeout(flushQueue, queueBlockedUntil - Date.now());
        return;
      }
      const item = queue.shift();
      wire("app->qwen", item.text, item.parsed, item.note);
      toChild(item.text);
    }
  };

  let inBuffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    inBuffer += chunk;
    let newline = inBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = inBuffer.slice(0, newline);
      inBuffer = inBuffer.slice(newline + 1);
      newline = inBuffer.indexOf("\n");
      if (line.trim() === "") continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      let text = line;
      let note;
      if (parsed && typeof parsed.method === "string" && parsed.id !== undefined) {
        pendingAppCalls.set(parsed.id, parsed.method);
      }
      // The bytes qwen is about to read: `session/new|load` is where it loads settings
      // (settings-cache miss → loadSettings), so snapshot them as the call leaves the app.
      if (parsed?.method === "session/new" || parsed?.method === "session/load") {
        snapshotSettings(`app sends ${parsed.method}`);
      }
      if (parsed?.method === "session/new" && transform.channel === "acp" && movedServers) {
        const originalServers = parsed.params?.mcpServers ?? [];
        parsed.params = { ...parsed.params, mcpServers: toAcpServers(movedServers) };
        text = JSON.stringify(parsed);
        note = "transformed: settings mcpServers moved into session/new.mcpServers";
        appendJsonl("transforms.jsonl", {
          ...stamp(),
          kind: "acp-session-new",
          before: originalServers,
          after: parsed.params.mcpServers,
        });
      }
      // The app pushes the approval mode per turn as `session/set_config_option {configId:"mode"}`
      // (older builds: `session/set_mode {modeId}`); the override rewrites whichever arrives.
      const isModeCall =
        parsed?.method === "session/set_mode" ||
        (parsed?.method === "session/set_config_option" && parsed.params?.configId === "mode");
      if (isModeCall && typeof transform.setModeOverride === "string") {
        const key = parsed.method === "session/set_mode" ? "modeId" : "value";
        const before = parsed.params?.[key];
        parsed.params = { ...parsed.params, [key]: transform.setModeOverride };
        text = JSON.stringify(parsed);
        note = `transformed: ${key} ${String(before)} -> ${transform.setModeOverride}`;
        appendJsonl("transforms.jsonl", {
          ...stamp(),
          kind: "acp-set-mode",
          before,
          after: transform.setModeOverride,
        });
      }
      if (parsed?.method === "session/prompt" && holdPromptMs > 0 && sessionNewAnsweredAt) {
        const until = sessionNewAnsweredAt + holdPromptMs;
        if (until > queueBlockedUntil && until > Date.now()) {
          queueBlockedUntil = until;
          appendJsonl("lifecycle.jsonl", {
            ...stamp(),
            event: "prompt-held",
            releaseAtMs: until,
            holdPromptMs,
          });
          note = `held until ${new Date(until).toISOString()}`;
        }
      }
      queue.push({ text, parsed, note });
      if (releaseTimer === null) flushQueue();
    }
  });
  process.stdin.on("end", () => {
    appendJsonl("lifecycle.jsonl", { ...stamp(), event: "app-stdin-end" });
    child.stdin.end();
  });

  // — qwen → app —
  let probeSeq = 0;
  const probePending = new Map(); // id → { method, params, label, sentAt }
  const sendProbe = (label, method, params) => {
    probeSeq += 1;
    const id = `probe-${String(probeSeq)}`;
    probePending.set(id, { method, params, label, sentAt: Date.now() });
    const payload = { jsonrpc: "2.0", id, method, params };
    wire("probe->qwen", null, payload);
    toChild(JSON.stringify(payload));
  };
  let sessionId = null;
  let serverNames = [];
  const readServerNames = () => {
    const snapshot = (() => {
      try {
        return JSON.parse(NodeFS.readFileSync(settingsPath ?? "", "utf8"));
      } catch {
        return null;
      }
    })();
    const fromFile = Object.keys(snapshot?.mcpServers ?? {});
    const fromMoved = Object.keys(movedServers ?? {});
    const names = [...new Set([...fromFile, ...fromMoved])];
    if (names.length > 0) serverNames = names;
  };
  const askStatus = (label) => {
    sendProbe(label, "qwen/status/workspace/mcp", {});
    sendProbe(label, "qwen/status/workspace/tools", {});
    for (const serverName of serverNames) {
      sendProbe(label, "qwen/status/workspace/mcp/tools", { serverName });
    }
    if (sessionId !== null) {
      // The per-tool lists need `detail: true` (qwen acpAgent.ts:7441 reads params.detail;
      // `showDetails` is ignored, which is why the first runs got showDetails:false back).
      sendProbe(label, "qwen/status/session/context_usage", { sessionId, detail: true });
    }
  };

  let outBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outBuffer += chunk;
    let newline = outBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = outBuffer.slice(0, newline);
      outBuffer = outBuffer.slice(newline + 1);
      newline = outBuffer.indexOf("\n");
      if (line.trim() === "") continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      const id = parsed?.id;
      if (typeof id === "string" && probePending.has(id)) {
        const pending = probePending.get(id);
        probePending.delete(id);
        wire("qwen->probe", line, parsed);
        appendJsonl("probes.jsonl", {
          ...stamp(),
          label: pending.label,
          method: pending.method,
          params: pending.params,
          durationMs: Date.now() - pending.sentAt,
          ...(parsed.error ? { error: parsed.error } : { result: parsed.result }),
        });
        continue;
      }
      const isAnswer = parsed && parsed.method === undefined && id !== undefined;
      const answered = isAnswer ? pendingAppCalls.get(id) : undefined;
      if (isAnswer) pendingAppCalls.delete(id);
      if (answered === "initialize") snapshotSettings("before-app-hears initialize answer");
      if (answered === "session/new" || answered === "session/load") {
        snapshotSettings(`before-app-hears ${answered} answer`);
        sessionId = parsed.result?.sessionId ?? sessionId;
        sessionNewAnsweredAt = Date.now();
        readServerNames();
        for (const offset of statusOffsets) {
          setTimeout(() => askStatus(`+${String(offset)}ms after ${answered}`), offset).unref();
        }
      }
      if (answered === "session/prompt") {
        snapshotSettings("before-app-hears session/prompt answer");
        setTimeout(() => askStatus("after session/prompt answer"), 300).unref();
      }
      wire("qwen->app", line, parsed);
      process.stdout.write(`${line}\n`);
    }
  });

  // qwen's stderr: forwarded to the app as is; recorded (the bytes, capped at 4 MiB so a flood
  // cannot fill the disk) and timed — `stderr-bytes.jsonl` gets per chunk {ms, total} (bytes qwen
  // wrote so far) and `pending` (bytes this process still holds for the app, i.e. what the APP has
  // not read yet: Node queues an unread pipe in the writer's memory, it does not block).
  const STDERR_LOG_CAP = 4 * 1024 * 1024;
  let stderrTotal = 0;
  child.stderr.on("data", (chunk) => {
    const logged = Math.max(0, Math.min(chunk.length, STDERR_LOG_CAP - stderrTotal));
    stderrTotal += chunk.length;
    try {
      if (logged > 0)
        NodeFS.appendFileSync(NodePath.join(procDir, "stderr.log"), chunk.subarray(0, logged));
    } catch {
      /* evidence only */
    }
    process.stderr.write(chunk);
    appendJsonl("stderr-bytes.jsonl", {
      ms: Date.now(),
      total: stderrTotal,
      pending: process.stderr.writableLength,
    });
  });

  const forward = (signal) => () => {
    appendJsonl("lifecycle.jsonl", { ...stamp(), event: `proxy-got-${signal}` });
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGHUP", forward("SIGHUP"));

  child.on("exit", (code, signal) => {
    appendJsonl("lifecycle.jsonl", { ...stamp(), event: "child-exit", code, signal });
    snapshotSettings("child-exit");
    exitLikeChild(code, signal);
  });
}
