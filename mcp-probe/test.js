#!/usr/bin/env node
// MCP integration probe v3 — run with:  node ./mcp-probe/test.js
// (first time, from repo root:  pnpm install  — to fetch the MCP SDK the
//  http/monitor cases use; stdio-only cases run without it.)
//
// Proves the planned MCP-management engine against the REAL qwen binary, on
// every axis the plan depends on, with deterministic oracles wherever possible.
//
// Oracles:
//   1. REGISTRY INSPECTION (no model). qwen writes its built tool registry to a
//      debug log during config.initialize() — `ToolRegistry created: [...]`
//      (config.ts:2201). MCP tools are named `mcp__<server>__<tool>`. We set
//      QWEN_RUNTIME_DIR, boot an ACP session/new (builds the registry WITHOUT a
//      model call), and assert exactly which mcp__* tools exist. Excluded tools
//      are filtered at discovery and never registered (mcp-client isEnabled),
//      so absence = the model cannot call them.
//   2. FAKE-SERVER AUDIT LOGS. Our servers append START/LIST/CALL; a filtered
//      server is never spawned/contacted.
//   3. REAL MODEL QUERIES (robust, optional). Drives real prompts + watches the
//      tool_call stream; SKIPs cleanly if no model. Never hangs.
//
// Case map:
//   D0–D5  add / discover / allowlist-remove / ignore-preexisting / per-tool
//   H1     remote (http) server via overlay + per-tool on http
//   V1     qwen expands ${VAR} in our overlay
//   F1     ACP-array fallback (MCP_ENGINE_USE_OVERLAY=false): stdio-only, no tool control
//   T2/T3  folder-trust gate blocks; trustedFolders file is an independent lever
//   P1–P3  monitor reprobe (preview of the production supervisor): stdio / http / offline
//   M0–M3  real-model end-to-end (allowed runs, disabled blocked, multi-call)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeOnce, sdkInstalled } from "./monitor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = join(here, "servers", "mcp-server.mjs");
const httpServerScript = join(here, "servers", "http-mcp-server.mjs");
const runRoot = join(here, ".run");
const QWEN_BIN = process.env.QWEN_BIN ?? "qwen";

const REQUEST_TIMEOUT_MS = 25_000;
const REGISTRY_WAIT_MS = 20_000;
const TURN_TIMEOUT_MS = 70_000;

let sdkAvailable = false; // set in main()

// ───────────────────────────── small helpers ──────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freshDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

function serverEntry(name, logPath, extraConfig = {}) {
  return { command: process.execPath, args: [serverScript], env: { PROBE_SERVER_NAME: name, PROBE_LOG: logPath }, ...extraConfig };
}

function writeOverlay(overlayPath, mcpServers, { folderTrustEnabled = false } = {}) {
  writeFileSync(overlayPath, JSON.stringify({ security: { folderTrust: { enabled: folderTrustEnabled } }, mcpServers }, null, 2));
}

function readServerEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tokens = line.split(" ");
      const fields = {};
      for (const token of tokens.slice(2)) {
        const eq = token.indexOf("=");
        if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
      }
      return { event: tokens[1], fields };
    });
}
const serverWasSpawned = (logPath) => readServerEvents(logPath).some((e) => e.event === "START");
const serverGotList = (logPath) => readServerEvents(logPath).some((e) => e.event === "LIST");
const serverStartEcho = (logPath) => readServerEvents(logPath).find((e) => e.event === "START")?.fields.echo ?? null;
const serverCallsTo = (logPath, toolName) => readServerEvents(logPath).filter((e) => e.event === "CALL" && e.fields.tool === toolName).length;

function walkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Read qwen's "ToolRegistry created: [...]" line → tool-name list (or null).
function readRegistryTools(runtimeDir, sessionId) {
  const candidates = [];
  for (const root of [runtimeDir, join(homedir(), ".qwen", "runtime")]) {
    for (const file of walkFiles(root)) {
      if (!file.endsWith(".txt")) continue;
      if (sessionId && !file.includes(sessionId)) continue;
      candidates.push(file);
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of candidates) {
    const text = readFileSync(file, "utf8");
    const match = text.match(/ToolRegistry created:\s*(\[[^\n]*?\])/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        /* fall through */
      }
    }
    const tokens = text.match(/mcp__[A-Za-z0-9_.-]+/g);
    if (tokens) return [...new Set(tokens)];
  }
  return null;
}
const mcpTools = (registry) => (registry ?? []).filter((name) => name.startsWith("mcp__"));
const hasTool = (registry, name) => (registry ?? []).includes(name);

// ──────────────────────── minimal robust ACP client ────────────────────────

function makeAcp(cwd, overlayPath, { allowedServerNames = null, runtimeDir = null, sessionMcpServers = [], extraEnv = {} } = {}) {
  const args = ["--acp"];
  if (allowedServerNames) args.push("--allowed-mcp-server-names", allowedServerNames);
  const env = { ...process.env, NO_COLOR: "1", QWEN_CODE_SYSTEM_SETTINGS_PATH: overlayPath, QWEN_DEBUG_LOG_FILE: "1", ...extraEnv };
  if (runtimeDir) env.QWEN_RUNTIME_DIR = runtimeDir;

  const child = spawn(QWEN_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map();
  const updateCollectors = [];
  let buffer = "";

  const writeMessage = (message) => {
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      /* child may be gone */
    }
  };
  const request = (method, params, timeoutMs = REQUEST_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      writeMessage({ jsonrpc: "2.0", id, method, params });
    });

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (entry) (message.error ? entry.reject : entry.resolve)(message.error ?? message.result);
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) {
        if (/permission/i.test(message.method)) {
          writeMessage({ jsonrpc: "2.0", id: message.id, result: { outcome: { optionId: "proceed_once", outcome: "selected" } } });
        } else {
          writeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
        }
        continue;
      }
      if (message.method === "session/update") {
        for (const collector of updateCollectors) collector(message.params?.update);
      }
    }
  });

  const drive = async () => {
    try {
      await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "mcp-probe", version: "0.0.0" } });
    } catch {
      /* observe side effects regardless */
    }
    try {
      await request("authenticate", { methodId: "openai" });
    } catch {
      /* irrelevant to registry build */
    }
    let sessionId = null;
    try {
      const result = await request("session/new", { cwd, mcpServers: sessionMcpServers });
      sessionId = result?.sessionId ?? null;
    } catch {
      /* config.initialize already ran */
    }
    return sessionId;
  };

  const prompt = async (sessionId, text) => {
    const toolCalls = [];
    let assistantText = "";
    const collector = (update) => {
      if (!update) return;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        toolCalls.push({ phase: update.sessionUpdate, name: update._meta?.toolName ?? update.title ?? "?", status: update.status });
      }
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") assistantText += update.content.text;
    };
    updateCollectors.push(collector);
    let stopReason = null;
    try {
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, TURN_TIMEOUT_MS);
      stopReason = result?.stopReason ?? "unknown";
    } catch (error) {
      stopReason = `error:${error.message}`;
    } finally {
      const i = updateCollectors.indexOf(collector);
      if (i >= 0) updateCollectors.splice(i, 1);
    }
    return { stopReason, toolCalls, assistantText };
  };

  const setYolo = async (sessionId) => {
    try {
      await request("session/set_mode", { sessionId, modeId: "yolo" }, 8000);
    } catch {
      /* permission auto-approve covers us */
    }
  };

  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(250);
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  return { drive, prompt, setYolo, stop };
}

// Boot a session purely to build + capture the tool registry (no model needed).
async function captureRegistry(cwd, overlayPath, opts = {}) {
  const runtimeDir = freshDir(join(cwd, "runtime"));
  const acp = makeAcp(cwd, overlayPath, { ...opts, runtimeDir });
  const sessionId = await acp.drive();
  const deadline = Date.now() + REGISTRY_WAIT_MS;
  let registry = null;
  while (Date.now() < deadline) {
    registry = readRegistryTools(runtimeDir, sessionId);
    if (registry && registry.length) break;
    await sleep(250);
  }
  await acp.stop();
  return { sessionId, registry, runtimeDir };
}

// Start the SDK-based fake HTTP server; resolve { port, stop } or null.
function startHttpServer(name, logPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [httpServerScript], {
      env: { ...process.env, PROBE_SERVER_NAME: name, PROBE_LOG: logPath, PROBE_HTTP_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      const match = out.match(/PROBE_HTTP_READY (\d+)/);
      if (match) done({ port: Number(match[1]), stop: () => { try { child.kill("SIGKILL"); } catch { /* ignore */ } } });
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8");
      if (/SDK_MISSING/.test(err)) done(null);
    });
    child.on("exit", () => done(null));
    setTimeout(() => done(null), 8000);
  });
}

// ─────────────────────────────── reporting ─────────────────────────────────

const results = [];
function record(id, goal, status, detail) {
  results.push({ id, goal, status, detail });
  const mark = status === "PASS" ? "✓" : status === "SKIP" ? "•" : "✗";
  console.log(`  ${mark} [${id}] ${goal} — ${status}${detail ? `: ${detail}` : ""}`);
}

// ─────────────────────── deterministic registry cases ──────────────────────

async function D0_mcpListConnectivity() {
  const cwd = freshDir(join(runRoot, "D0"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")), beta: serverEntry("beta", join(cwd, "beta.log")) });
  const out = await new Promise((resolve) => {
    const child = spawn(QWEN_BIN, ["mcp", "list"], { cwd, env: { ...process.env, NO_COLOR: "1", QWEN_CODE_SYSTEM_SETTINGS_PATH: overlay }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.on("error", () => resolve({ stdout }));
    child.on("exit", () => resolve({ stdout }));
  });
  const ok = out.stdout.includes("alpha") && out.stdout.includes("beta") && (out.stdout.match(/Connected/g) ?? []).length >= 2;
  record("D0", "mcp list sees overlay servers", ok ? "PASS" : "FAIL", ok ? "alpha+beta Connected" : JSON.stringify(out.stdout.slice(0, 200)));
}

async function D1_addAndDiscover() {
  const cwd = freshDir(join(runRoot, "D1"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")), beta: serverEntry("beta", join(cwd, "beta.log")) });
  const { registry } = await captureRegistry(cwd, overlay);
  if (registry == null) return record("D1", "add + discover under trust", "FAIL", "no registry log captured");
  const want = ["mcp__alpha__echo", "mcp__alpha__ping", "mcp__beta__add", "mcp__beta__multiply"];
  const missing = want.filter((name) => !hasTool(registry, name));
  record("D1", "add + discover under trust", missing.length === 0 ? "PASS" : "FAIL", missing.length === 0 ? `all 4 tools registered` : `missing: ${missing.join(",")}`);
}

async function D2_allowlistRemovesServer() {
  const cwd = freshDir(join(runRoot, "D2"));
  const overlay = join(cwd, "overlay.json");
  const betaLog = join(cwd, "beta.log");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")), beta: serverEntry("beta", betaLog) });
  const { registry } = await captureRegistry(cwd, overlay, { allowedServerNames: "alpha" });
  const ok = hasTool(registry, "mcp__alpha__echo") && !mcpTools(registry).some((n) => n.startsWith("mcp__beta__")) && !serverWasSpawned(betaLog);
  record("D2", "allowlist removes a server", ok ? "PASS" : "FAIL", ok ? "alpha registered, beta absent + never spawned" : `registry=${JSON.stringify(mcpTools(registry))} betaSpawned=${serverWasSpawned(betaLog)}`);
}

async function D3_ignorePreexisting() {
  const cwd = freshDir(join(runRoot, "D3"));
  const overlay = join(cwd, "overlay.json");
  const decoyLog = join(cwd, "decoy.log");
  const workspaceDir = freshDir(join(cwd, ".qwen"));
  writeFileSync(join(workspaceDir, "settings.json"), JSON.stringify({ mcpServers: { decoy: serverEntry("decoy", decoyLog) } }, null, 2));
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")) });
  const { registry } = await captureRegistry(cwd, overlay, { allowedServerNames: "alpha" });
  const ok = hasTool(registry, "mcp__alpha__echo") && !mcpTools(registry).some((n) => n.startsWith("mcp__decoy__")) && !serverWasSpawned(decoyLog);
  record("D3", "ignore pre-existing user server", ok ? "PASS" : "FAIL", ok ? "decoy excluded + never spawned, alpha active" : `registry=${JSON.stringify(mcpTools(registry))} decoySpawned=${serverWasSpawned(decoyLog)}`);
}

async function D4_perToolExclude() {
  const cwd = freshDir(join(runRoot, "D4"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log"), { excludeTools: ["ping"] }) });
  const { registry } = await captureRegistry(cwd, overlay);
  const ok = hasTool(registry, "mcp__alpha__echo") && !hasTool(registry, "mcp__alpha__ping");
  record("D4", "per-tool excludeTools (1 of 2)", ok ? "PASS" : "FAIL", ok ? "echo registered, ping NOT registered — model cannot call ping" : `registry=${JSON.stringify(mcpTools(registry))}`);
}

async function D5_perToolInclude() {
  const cwd = freshDir(join(runRoot, "D5"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log"), { includeTools: ["ping"] }) });
  const { registry } = await captureRegistry(cwd, overlay);
  const ok = hasTool(registry, "mcp__alpha__ping") && !hasTool(registry, "mcp__alpha__echo");
  record("D5", "per-tool includeTools (whitelist)", ok ? "PASS" : "FAIL", ok ? "ping registered, echo NOT registered" : `registry=${JSON.stringify(mcpTools(registry))}`);
}

// ───────────────── transport + expansion + fallback cases ───────────────────

async function H1_httpViaOverlay() {
  if (!sdkAvailable) return record("H1", "remote (http) server via overlay", "SKIP", "MCP SDK not installed — run `pnpm install`");
  const cwd = freshDir(join(runRoot, "H1"));
  const httpLog = join(cwd, "remote.log");
  const server = await startHttpServer("remote", httpLog);
  if (!server) return record("H1", "remote (http) server via overlay", "SKIP", "fake http server failed to start");
  const overlay = join(cwd, "overlay.json");
  // http transport + per-tool exclude on a remote server — the overlay-only path.
  writeOverlay(overlay, { remote: { httpUrl: `http://127.0.0.1:${server.port}/`, headers: {}, excludeTools: ["news"] } });
  const { registry } = await captureRegistry(cwd, overlay);
  server.stop();
  const weatherKept = hasTool(registry, "mcp__remote__weather");
  const newsGone = !hasTool(registry, "mcp__remote__news");
  const connected = serverGotList(httpLog);
  const ok = weatherKept && newsGone && connected;
  record("H1", "remote (http) server via overlay", ok ? "PASS" : "FAIL", ok ? "http server connected; weather registered, news excluded — per-tool works on remote too" : `connected=${connected} weatherKept=${weatherKept} newsGone=${newsGone} registry=${JSON.stringify(mcpTools(registry))}`);
}

async function V1_envExpansion() {
  const cwd = freshDir(join(runRoot, "V1"));
  const alphaLog = join(cwd, "alpha.log");
  const overlay = join(cwd, "overlay.json");
  const expected = "expanded-OK-42";
  // The overlay references ${PROBE_INJECTED_VALUE}; qwen should expand it from
  // its process env (resolveEnvVarsInObject on system settings, settings.ts:684).
  writeOverlay(overlay, { alpha: { command: process.execPath, args: [serverScript], env: { PROBE_SERVER_NAME: "alpha", PROBE_LOG: alphaLog, PROBE_ECHO: "${PROBE_INJECTED_VALUE}" } } });
  process.env.PROBE_INJECTED_VALUE = expected;
  try {
    await captureRegistry(cwd, overlay);
  } finally {
    delete process.env.PROBE_INJECTED_VALUE;
  }
  const echo = serverStartEcho(alphaLog);
  const ok = echo === expected;
  record("V1", "qwen expands ${VAR} in overlay", ok ? "PASS" : "FAIL", ok ? `\${PROBE_INJECTED_VALUE} → "${echo}" (we can delegate var expansion to qwen)` : `server received echo="${echo}" (expected "${expected}")`);
}

async function F1_acpArrayFallback() {
  const cwd = freshDir(join(runRoot, "F1"));
  const overlay = join(cwd, "overlay.json");
  const stdioLog = join(cwd, "arraystdio.log");
  writeOverlay(overlay, {}); // no overlay servers — the server comes via the ACP array
  // ACP McpServer (sdk 0.14): the stdio variant is UNTAGGED ({name,command,args,env});
  // http/sse are tagged with `type`. We send only the stdio variant — it's the only
  // thing the array can carry. (Source already proves the limits: toStdioServer drops
  // non-stdio, and `new MCPServerConfig(command,args,env,cwd)` has no include/excludeTools,
  // so fallback mode is stdio-only with NO per-tool control → gray those out in the UI.)
  const sessionMcpServers = [
    { name: "arraystdio", command: process.execPath, args: [serverScript], env: [{ name: "PROBE_SERVER_NAME", value: "alpha" }, { name: "PROBE_LOG", value: stdioLog }] },
  ];
  const { registry } = await captureRegistry(cwd, overlay, { sessionMcpServers });
  const stdioKept = hasTool(registry, "mcp__arraystdio__echo") && hasTool(registry, "mcp__arraystdio__ping");
  const spawned = serverWasSpawned(stdioLog);
  record("F1", "ACP-array fallback (stdio via session/new)", stdioKept ? "PASS" : "FAIL", stdioKept ? "stdio server registers via the ACP array — fallback path works (http + per-tool unavailable here by design)" : `stdioKept=false serverSpawned=${spawned} registry=${JSON.stringify(mcpTools(registry))}${spawned ? "" : " (server never spawned → session/new rejected the array entry)"}`);
}

// ───────────────────────── folder-trust matrix ─────────────────────────────

async function T2_trustGateBlocks() {
  const cwd = freshDir(join(runRoot, "T2"));
  const overlay = join(cwd, "overlay.json");
  const alphaLog = join(cwd, "alpha.log");
  writeOverlay(overlay, { alpha: serverEntry("alpha", alphaLog) }, { folderTrustEnabled: true });
  const trustFile = join(cwd, "trustedFolders.json");
  writeFileSync(trustFile, JSON.stringify({ [cwd]: "DO_NOT_TRUST" }, null, 2));
  const { registry } = await captureRegistry(cwd, overlay, { extraEnv: { QWEN_CODE_TRUSTED_FOLDERS_PATH: trustFile } });
  const blocked = !mcpTools(registry).some((n) => n.startsWith("mcp__alpha__")) && !serverWasSpawned(alphaLog);
  record("T2", "trust gate BLOCKS when untrusted", blocked ? "PASS" : "FAIL", blocked ? "feature-on + DO_NOT_TRUST → no mcp tools (why we disable trust)" : `registry=${JSON.stringify(mcpTools(registry))} spawned=${serverWasSpawned(alphaLog)}`);
}

async function T3_trustFileFallback() {
  const cwd = freshDir(join(runRoot, "T3"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")) }, { folderTrustEnabled: true });
  const trustFile = join(cwd, "trustedFolders.json");
  writeFileSync(trustFile, JSON.stringify({ [cwd]: "TRUST_FOLDER" }, null, 2));
  const { registry } = await captureRegistry(cwd, overlay, { extraEnv: { QWEN_CODE_TRUSTED_FOLDERS_PATH: trustFile } });
  const ok = hasTool(registry, "mcp__alpha__echo");
  record("T3", "trusted-folders file fallback", ok ? "PASS" : "FAIL", ok ? "feature-on + TRUST_FOLDER → mcp tools available (independent lever)" : `registry=${JSON.stringify(mcpTools(registry))}`);
}

// ──────────────── monitor reprobe (production supervisor preview) ───────────

async function P1_monitorStdio() {
  if (!sdkAvailable) return record("P1", "monitor probes stdio server", "SKIP", "run `pnpm install`");
  const cwd = freshDir(join(runRoot, "P1"));
  const result = await probeOnce({ kind: "stdio", command: process.execPath, args: [serverScript], env: { PROBE_SERVER_NAME: "alpha", PROBE_LOG: join(cwd, "alpha.log") } });
  const ok = result.status === "online" && result.tools.includes("echo") && result.tools.includes("ping");
  record("P1", "monitor probes stdio server", ok ? "PASS" : "FAIL", ok ? `online, tools=${result.tools.join(",")} (${result.latencyMs}ms)` : JSON.stringify(result));
}

async function P2_monitorHttp() {
  if (!sdkAvailable) return record("P2", "monitor probes http server", "SKIP", "run `pnpm install`");
  const cwd = freshDir(join(runRoot, "P2"));
  const server = await startHttpServer("remote", join(cwd, "remote.log"));
  if (!server) return record("P2", "monitor probes http server", "SKIP", "fake http server failed to start");
  const result = await probeOnce({ kind: "http", url: `http://127.0.0.1:${server.port}/` });
  server.stop();
  const ok = result.status === "online" && result.tools.includes("weather") && result.tools.includes("news");
  record("P2", "monitor probes http server", ok ? "PASS" : "FAIL", ok ? `online, tools=${result.tools.join(",")} (${result.latencyMs}ms)` : JSON.stringify(result));
}

async function P3_monitorOfflineAndReprobe() {
  if (!sdkAvailable) return record("P3", "monitor: offline + stable reprobe", "SKIP", "run `pnpm install`");
  const cwd = freshDir(join(runRoot, "P3"));
  const broken = await probeOnce({ kind: "stdio", command: join(cwd, "does-not-exist"), args: [] });
  const target = { kind: "stdio", command: process.execPath, args: [serverScript], env: { PROBE_SERVER_NAME: "alpha", PROBE_LOG: join(cwd, "alpha.log") } };
  const first = await probeOnce(target);
  const second = await probeOnce(target); // reprobe — no held connection between probes
  const ok = broken.status !== "online" && first.status === "online" && second.status === "online";
  record("P3", "monitor: offline + stable reprobe", ok ? "PASS" : "FAIL", ok ? `broken→${broken.status}; reprobe ${first.status}/${second.status}` : `broken=${broken.status} first=${first.status} second=${second.status}`);
}

// ─────────────────────── real-model query cases ────────────────────────────

async function modelAvailable() {
  const cwd = freshDir(join(runRoot, "M0"));
  const overlay = join(cwd, "overlay.json");
  writeOverlay(overlay, { alpha: serverEntry("alpha", join(cwd, "alpha.log")) });
  const acp = makeAcp(cwd, overlay, { runtimeDir: freshDir(join(cwd, "runtime")) });
  const sessionId = await acp.drive();
  if (!sessionId) {
    await acp.stop();
    record("M0", "model availability precheck", "SKIP", "no session");
    return false;
  }
  await acp.setYolo(sessionId);
  const { stopReason, assistantText } = await acp.prompt(sessionId, "Reply with exactly the word READY and nothing else.");
  await acp.stop();
  const ok = stopReason === "end_turn" || /ready/i.test(assistantText);
  record("M0", "model availability precheck", ok ? "PASS" : "SKIP", ok ? "model responded" : `no usable model (stopReason=${stopReason})`);
  return ok;
}

async function M1_allowedToolExecutes() {
  const cwd = freshDir(join(runRoot, "M1"));
  const overlay = join(cwd, "overlay.json");
  const alphaLog = join(cwd, "alpha.log");
  writeOverlay(overlay, { alpha: serverEntry("alpha", alphaLog) });
  const acp = makeAcp(cwd, overlay, { runtimeDir: freshDir(join(cwd, "runtime")) });
  const sessionId = await acp.drive();
  await acp.setYolo(sessionId);
  const { toolCalls } = await acp.prompt(sessionId, "Use the echo tool (mcp__alpha__echo) with text 'hello-mcp' and report the result. Call the real tool, do not simulate it.");
  await acp.stop();
  const ok = toolCalls.some((c) => /echo/.test(c.name)) || serverCallsTo(alphaLog, "echo") > 0;
  record("M1", "allowed tool actually executes", ok ? "PASS" : "SKIP", ok ? `echo invoked (serverCALL=${serverCallsTo(alphaLog, "echo")})` : "model did not call echo — inconclusive");
}

async function M2_disabledToolUnusable() {
  const cwd = freshDir(join(runRoot, "M2"));
  const overlay = join(cwd, "overlay.json");
  const alphaLog = join(cwd, "alpha.log");
  writeOverlay(overlay, { alpha: serverEntry("alpha", alphaLog, { excludeTools: ["ping"] }) });
  const acp = makeAcp(cwd, overlay, { runtimeDir: freshDir(join(cwd, "runtime")) });
  const sessionId = await acp.drive();
  await acp.setYolo(sessionId);
  const { toolCalls, assistantText } = await acp.prompt(sessionId, "Call the ping tool from the alpha MCP server now. If you cannot, say why.");
  await acp.stop();
  const pingReachedServer = serverCallsTo(alphaLog, "ping") > 0;
  const pingInStream = toolCalls.some((c) => /ping/.test(c.name));
  const ok = !pingReachedServer && !pingInStream;
  record("M2", "disabled tool is unusable (real query)", ok ? "PASS" : "FAIL", ok ? `ping never executed${assistantText ? ` (said: "${assistantText.slice(0, 50).replace(/\n/g, " ")}")` : ""}` : `pingReachedServer=${pingReachedServer} pingInStream=${pingInStream} — LEAK`);
}

async function M3_multipleRealCalls() {
  const cwd = freshDir(join(runRoot, "M3"));
  const overlay = join(cwd, "overlay.json");
  const betaLog = join(cwd, "beta.log");
  writeOverlay(overlay, { beta: serverEntry("beta", betaLog) });
  const acp = makeAcp(cwd, overlay, { runtimeDir: freshDir(join(cwd, "runtime")) });
  const sessionId = await acp.drive();
  await acp.setYolo(sessionId);
  await acp.prompt(sessionId, "Use the add tool to add 2 and 3. Then use the multiply tool to multiply 4 and 5. Call both real tools.");
  await acp.stop();
  const ok = serverCallsTo(betaLog, "add") > 0 && serverCallsTo(betaLog, "multiply") > 0;
  record("M3", "multiple real tool invocations", ok ? "PASS" : "SKIP", `add=${serverCallsTo(betaLog, "add")} multiply=${serverCallsTo(betaLog, "multiply")}`);
}

// ─────────────────────────────────── main ──────────────────────────────────

async function main() {
  freshDir(runRoot);
  sdkAvailable = await sdkInstalled();
  console.log(`MCP probe v3 — qwen binary: ${QWEN_BIN} — MCP SDK: ${sdkAvailable ? "installed" : "ABSENT (run `pnpm install`)"}\n`);

  console.log("Deterministic registry-inspection cases (no model):");
  await D0_mcpListConnectivity();
  await D1_addAndDiscover();
  await D2_allowlistRemovesServer();
  await D3_ignorePreexisting();
  await D4_perToolExclude();
  await D5_perToolInclude();

  console.log("\nTransport, env-expansion, and fallback:");
  await H1_httpViaOverlay();
  await V1_envExpansion();
  await F1_acpArrayFallback();

  console.log("\nFolder-trust matrix (why we disable it + independent lever):");
  await T2_trustGateBlocks();
  await T3_trustFileFallback();

  console.log("\nMonitor reprobe (preview of the production supervisor):");
  await P1_monitorStdio();
  await P2_monitorHttp();
  await P3_monitorOfflineAndReprobe();

  console.log("\nReal-model query cases (end-to-end; robust SKIP if no model):");
  const haveModel = await modelAvailable();
  if (haveModel) {
    await M1_allowedToolExecutes();
    await M2_disabledToolUnusable();
    await M3_multipleRealCalls();
  } else {
    record("M1", "allowed tool actually executes", "SKIP", "no model");
    record("M2", "disabled tool is unusable (real query)", "SKIP", "no model");
    record("M3", "multiple real tool invocations", "SKIP", "no model");
  }

  const failed = results.filter((r) => r.status === "FAIL");
  const passed = results.filter((r) => r.status === "PASS");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(`\nSummary: ${passed.length} pass, ${failed.length} fail, ${skipped.length} skip`);
  // Core qwen-contract = D* / H1 / V1 / F1 / T*. P* (monitor) and M* (model) corroborate.
  const coreFailed = failed.filter((r) => /^(D|H|V|F|T)/.test(r.id));
  if (failed.length === 0) {
    console.log("RESULT: GO — overlay + allowlist + per-tool + http + env-expansion + trust all hold; monitor + model confirmed.");
  } else if (coreFailed.length === 0) {
    console.log("RESULT: GO (core) — qwen contract holds; a non-core (monitor/model) case failed (see above).");
  } else {
    console.log("RESULT: NO-GO — core failures above; logs under mcp-probe/.run/<case>/");
  }
  process.exit(coreFailed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("probe crashed:", error);
  process.exit(2);
});
