// @effect-diagnostics nodeBuiltinImport:off - install-flow: renders installer PTY captures to HTML.
// ru-code: turns a raw ANSI terminal capture (from a real PTY run of the installer) into colored
// HTML, and assembles a gallery page. Ported from scratchpad/ansi2html.py; no external deps so it
// runs inside vitest. Handles SGR reset/bold/dim, 3/4-bit + 256 + truecolor (fg & bg), collapses \r,
// drops other CSI. Used by matrix.gallery.test.ts to write install-cards.html on every run.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { INSTALL_SCRIPT, shq, type Sandbox } from "./harness.ts";

type RGB = readonly [number, number, number];

const BASE16: ReadonlyArray<RGB> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 85, 85],
  [80, 250, 123],
  [241, 250, 140],
  [92, 92, 255],
  [255, 121, 198],
  [139, 233, 253],
  [255, 255, 255],
];

const xterm256 = (n: number): RGB => {
  if (n < 16) return BASE16[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const c = n - 16;
  const conv = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
  return [conv(Math.floor(c / 36)), conv(Math.floor((c % 36) / 6)), conv(c % 6)];
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface SgrState {
  fg: RGB | null;
  bg: RGB | null;
  bold: boolean;
  dim: boolean;
}

const styleOf = (st: SgrState): string => {
  const css: string[] = [];
  if (st.fg) css.push(`color:rgb(${st.fg.join(",")})`);
  if (st.bg) css.push(`background:rgb(${st.bg.join(",")})`);
  if (st.bold) css.push("font-weight:700");
  if (st.dim) css.push("opacity:.6");
  return css.join(";");
};

// eslint-disable-next-line no-control-regex -- ANSI parsing requires matching the ESC (0x1b) byte
const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/y;

export const ansiToHtml = (rawIn: string): string => {
  // Collapse CR (progress bar redraws) to the last write per physical line; drop `script` header.
  let raw = rawIn.replace(/\r\n/g, "\n");
  raw = raw
    .split("\n")
    .map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r") + 1) : l))
    .filter((l) => !l.startsWith("Script "))
    .join("\n");

  const out: string[] = [];
  const st: SgrState = { fg: null, bg: null, bold: false, dim: false };
  let open = false;
  const close = (): void => {
    if (open) {
      out.push("</span>");
      open = false;
    }
  };
  const openSpan = (): void => {
    close();
    const s = styleOf(st);
    out.push(s ? `<span style="${s}">` : "<span>");
    open = true;
  };

  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "\x1b" && raw[i + 1] === "[") {
      CSI.lastIndex = i;
      const m = CSI.exec(raw);
      if (m) {
        if (m[2] === "m") {
          const nums = m[1]!
            .split(";")
            .filter((x) => x !== "")
            .map(Number);
          const list = nums.length ? nums : [0];
          for (let j = 0; j < list.length; j++) {
            const n = list[j]!;
            if (n === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false });
            else if (n === 1) st.bold = true;
            else if (n === 2) st.dim = true;
            else if (n === 22) st.bold = st.dim = false;
            else if (n >= 30 && n <= 37) st.fg = xterm256(n - 30);
            else if (n >= 90 && n <= 97) st.fg = xterm256(n - 90 + 8);
            else if (n >= 40 && n <= 47) st.bg = xterm256(n - 40);
            else if (n === 39) st.fg = null;
            else if (n === 49) st.bg = null;
            else if (n === 38 || n === 48) {
              const target = n === 38 ? "fg" : "bg";
              if (list[j + 1] === 5) {
                st[target] = xterm256(list[j + 2]!);
                j += 2;
              } else if (list[j + 1] === 2) {
                st[target] = [list[j + 2]!, list[j + 3]!, list[j + 4]!];
                j += 4;
              }
            }
          }
          openSpan();
        }
        i = CSI.lastIndex;
        continue;
      }
    }
    if (raw[i] === "\x1b") {
      i += 1;
      continue;
    }
    out.push(esc(raw[i]!));
    i += 1;
  }
  close();
  return out.join("").replace(/^\n+/, "").replace(/\n+$/, "");
};

/** Run the installer under a PTY (`script`) so the capture keeps truecolor. Async → parallelizable. */
export const spawnPtyCase = (
  sandbox: Sandbox,
  opts: {
    readonly preflight?: string;
    readonly env?: Record<string, string>;
    readonly args?: ReadonlyArray<string>;
  },
): Promise<{ readonly status: number; readonly raw: string }> => {
  const rawFile = NodePath.join(sandbox.root, "pty.raw");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sandbox.home,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // ru-code: BASE ENV — the launch is OFF by default for gallery runs. `install-cards.html` is a
    // pure INSTALLER-output matrix: every success case would otherwise reach `launch_app`, wait for
    // the launcher's JSON line, and mix launch banners into cards that are about install outcomes.
    // The launch has its own gallery (launch.gallery.test.ts → launch-cards.html), which overrides
    // this by passing INSTALL_START_AFTER in `opts.env`.
    INSTALL_START_AFTER: "false",
    ...(opts.preflight ? { RU_CODE_PREFLIGHT: opts.preflight } : {}),
    ...opts.env,
  };
  const args = (opts.args ?? ["--keep-source"]).map(shq).join(" ");
  const inner = `cd ${shq(sandbox.root)} && bash ${shq(INSTALL_SCRIPT)} ${args}`;
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("script", ["-qec", inner, rawFile], {
      env,
      timeout: 60_000,
    });
    child.on("close", (code) => {
      let raw = "";
      try {
        raw = NodeFS.readFileSync(rawFile, "utf8");
      } catch {
        raw = "";
      }
      resolve({ status: code ?? -1, raw });
    });
    child.on("error", () => resolve({ status: -1, raw: "" }));
  });
};

/** Bounded-concurrency map (PTY spawns are cheap but not free). */
export const pool = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
};

/**
 * Run an ARBITRARY command under a PTY (`script`) and return its capture — same mechanism as
 * `spawnPtyCase`, but for galleries whose subject is not the installer (the frozen wrapper).
 */
export const spawnPtyCommand = (
  workDir: string,
  command: string,
  env: Record<string, string>,
): Promise<{ readonly status: number; readonly raw: string }> => {
  const rawFile = NodePath.join(workDir, "pty.raw");
  const inner = `cd ${shq(workDir)} && ${command}`;
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("script", ["-qec", inner, rawFile], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", ...env },
      timeout: 60_000,
    });
    child.on("close", (code) => {
      let raw = "";
      try {
        raw = NodeFS.readFileSync(rawFile, "utf8");
      } catch {
        raw = "";
      }
      resolve({ status: code ?? -1, raw });
    });
    child.on("error", () => resolve({ status: -1, raw: "" }));
  });
};

export const buildGalleryPage = (
  panels: ReadonlyArray<{ readonly label: string; readonly ok: boolean; readonly html: string }>,
  title = "Install cards",
): string => {
  const cards = panels
    .map(
      (p, i) =>
        `<section class="panel"><div class="tt"><span class="n">${String(i + 1).padStart(2, "0")}</span> ` +
        `<span class="${p.ok ? "ok" : "bad"}">${p.ok ? "PASS" : "FAIL"}</span> ${esc(p.label)}</div>` +
        `<pre class="term">${p.html}</pre></section>`,
    )
    .join("");
  return (
    `<!doctype html><meta charset="utf-8"><title>${esc(title.toLowerCase())}</title><style>` +
    `body{margin:0;background:#161b22;color:#c9d1d9;font-family:system-ui,sans-serif}` +
    `h1{padding:16px 20px;margin:0;font-size:15px;color:#8b949e;border-bottom:1px solid #30363d}` +
    `.wrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:16px;padding:16px}` +
    `.panel{border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#0d1117}` +
    `.tt{padding:8px 12px;font:600 12px system-ui;color:#c9d1d9;background:#161b22;border-bottom:1px solid #30363d}` +
    `.tt .n{display:inline-block;min-width:22px;color:#8b949e}` +
    `.tt .ok{color:#3fb950}.tt .bad{color:#f85149}` +
    `pre.term{margin:0;padding:14px 16px;background:#0d1117;color:#c9d1d9;` +
    `font:12.5px/1.4 "SF Mono",Menlo,Consolas,monospace;white-space:pre;overflow-x:auto}` +
    `</style><h1>${esc(title)} — ${panels.length} combinations</h1>` +
    `<div class="wrap">${cards}</div>`
  );
};
