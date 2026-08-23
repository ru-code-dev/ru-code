// @effect-diagnostics nodeBuiltinImport:off - install-flow: executes the emitted wrapper with node.
// ru-code: THE WRAPPER GALLERY. `<appRoot>/cli.js` — the FROZEN launcher every user and every script
// actually runs — is the last thing standing between a broken install and a blank terminal. This
// file executes the REAL emitted source (`makeWrapperSource`, unmodified) against fixture layouts,
// asserts what it prints in each failure mode, and writes <repoRoot>/SPECS/e2e-runs/terminal-cards/wrapper-cards.html so the five
// terminal states can be eyeballed the same way the installer cards are.
//
// Runs under a PTY (`script`), because the wrapper's palette is TTY-gated: captured any other way
// the banners lose their gradient wordmark and the cards would not show what a user sees.
// TEST + GALLERY ONLY — the wrapper source is never touched from here.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { expect, it } from "vite-plus/test";

import { APP_COMMAND, APP_NAME, SUPPORT_CHANNEL_URL } from "@ru-code/branding";

import { VERSION_ENTRY_FILENAME } from "../../auto-update/apply/fetchVersion.ts";
import { VERSIONS_DIRNAME } from "../../auto-update/apply/gc.ts";
import { makePointer, POINTER_FILENAME } from "../../auto-update/apply/pointer.ts";
import { WRAPPER_FILENAME } from "../../auto-update/wrapper/installLayout.ts";
import { makeWrapperSource } from "../../auto-update/wrapper/wrapperSource.ts";
import { ansiToHtml, buildGalleryPage, pool, spawnPtyCommand } from "./galleryHtml.ts";
import { INSTALL_SCRIPT, shq } from "./harness.ts";

// eslint-disable-next-line no-control-regex -- stripping ANSI SGR/CSI escapes needs the ESC byte
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/** What a booted version prints, so a card shows WHICH version the wrapper handed off to. */
const bootMarker = (version: string): string => `[app] boot v${version}`;

interface VersionSpec {
  readonly version: string;
  /** engines.node in the version's package.json — omitted means "no constraint". */
  readonly enginesNode?: string;
  /** Skip writing the entry file, so the pointer resolves to something that is not there. */
  readonly omitEntry?: boolean;
}

/** Lay a version dir down under `appRoot/versions/<v>` exactly as an install would. */
function writeVersion(appRoot: string, spec: VersionSpec): void {
  const dir = NodePath.join(appRoot, VERSIONS_DIRNAME, spec.version);
  NodeFS.mkdirSync(dir, { recursive: true });
  const pkg: Record<string, unknown> = { name: "ru-code", version: spec.version };
  if (spec.enginesNode !== undefined) pkg["engines"] = { node: spec.enginesNode };
  NodeFS.writeFileSync(NodePath.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (spec.omitEntry !== true) {
    NodeFS.writeFileSync(
      NodePath.join(dir, VERSION_ENTRY_FILENAME),
      `process.stdout.write(${JSON.stringify(`${bootMarker(spec.version)}\n`)});\n`,
    );
  }
}

interface WrapperCase {
  readonly label: string;
  /** Build the appRoot layout; returns nothing — the wrapper itself is written by the runner. */
  readonly setup: (appRoot: string) => void;
  readonly check: (out: string, status: number) => void;
}

const cases: WrapperCase[] = [
  {
    label: "1 · здоровый запуск — pointer → versions/1.2.0",
    setup: (appRoot) => {
      writeVersion(appRoot, { version: "1.2.0" });
      NodeFS.writeFileSync(
        NodePath.join(appRoot, POINTER_FILENAME),
        `${JSON.stringify(makePointer("1.2.0", `${VERSIONS_DIRNAME}/1.2.0/${VERSION_ENTRY_FILENAME}`), null, 2)}\n`,
      );
    },
    check: (out, status) => {
      expect(out).toContain(bootMarker("1.2.0"));
      expect(out).not.toContain("установка повреждена");
      expect(status).toBe(0);
    },
  },
  {
    label: "2 · повреждённый pointer → откат на новейшую версию на диске",
    setup: (appRoot) => {
      writeVersion(appRoot, { version: "1.0.0" });
      writeVersion(appRoot, { version: "1.2.0" });
      NodeFS.writeFileSync(NodePath.join(appRoot, POINTER_FILENAME), "{ not json at all\n");
    },
    check: (out, status) => {
      // A corrupt pointer is treated as ABSENT: the newest readable version dir boots instead.
      expect(out).toContain(bootMarker("1.2.0"));
      expect(out).not.toContain(bootMarker("1.0.0"));
      expect(status).toBe(0);
    },
  },
  {
    label: "3 · нет валидного каталога версии → установка повреждена",
    setup: (appRoot) => {
      NodeFS.mkdirSync(NodePath.join(appRoot, VERSIONS_DIRNAME), { recursive: true });
    },
    check: (out, status) => {
      expect(out).toContain("установка повреждена");
      expect(out).toContain("Переустановите приложение");
      expect(out).toContain(APP_COMMAND);
      expect(out).toContain(SUPPORT_CHANNEL_URL);
      expect(status).not.toBe(0);
    },
  },
  {
    label: "4 · Node.js слишком старый (engines.node ≥ 99)",
    setup: (appRoot) => {
      writeVersion(appRoot, { version: "1.2.0", enginesNode: ">=99" });
      NodeFS.writeFileSync(
        NodePath.join(appRoot, POINTER_FILENAME),
        `${JSON.stringify(makePointer("1.2.0", `${VERSIONS_DIRNAME}/1.2.0/${VERSION_ENTRY_FILENAME}`), null, 2)}\n`,
      );
    },
    check: (out, status) => {
      expect(out).toContain("требуется более новая версия Node.js");
      expect(out).toContain("99");
      expect(out).not.toContain(bootMarker("1.2.0")); // it refuses to hand off
      expect(status).not.toBe(0);
    },
  },
  {
    label: "5 · entry, на который указывает pointer, отсутствует",
    setup: (appRoot) => {
      writeVersion(appRoot, { version: "1.2.0", omitEntry: true });
      NodeFS.writeFileSync(
        NodePath.join(appRoot, POINTER_FILENAME),
        `${JSON.stringify(makePointer("1.2.0", `${VERSIONS_DIRNAME}/1.2.0/${VERSION_ENTRY_FILENAME}`), null, 2)}\n`,
      );
    },
    check: (out, status) => {
      expect(out).toContain("установка повреждена");
      // the import failure's first line rides along as the dim technical detail
      expect(out).toContain("ERR_MODULE_NOT_FOUND");
      expect(status).not.toBe(0);
    },
  },
];

it("wrapper: the frozen launcher's five boot states render + assert, and write wrapper-cards.html", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ru-code-wrapper-cards-")),
  );
  try {
    // Guard: needs a PTY (`script`). Skip gracefully where it is unavailable.
    const guard = await spawnPtyCommand(
      root,
      `${shq(NodeProcess.execPath)} -e "process.exit(0)"`,
      {},
    );
    if (guard.raw.length === 0 && guard.status === -1) return;

    const dirs = cases.map((_, i) => {
      const appRoot = NodePath.join(root, `case-${i + 1}`, ".ru-code");
      NodeFS.mkdirSync(appRoot, { recursive: true });
      // The REAL emitted wrapper, with the REAL brand params — nothing about it is stubbed.
      NodeFS.writeFileSync(
        NodePath.join(appRoot, WRAPPER_FILENAME),
        makeWrapperSource({
          appName: APP_NAME,
          appCommand: APP_COMMAND,
          supportUrl: SUPPORT_CHANNEL_URL,
        }),
      );
      cases[i]!.setup(appRoot);
      return appRoot;
    });

    const runs = await pool(cases, 5, (_, i) =>
      spawnPtyCommand(
        dirs[i]!,
        `${shq(NodeProcess.execPath)} ${shq(NodePath.join(dirs[i]!, WRAPPER_FILENAME))}`,
        {},
      ),
    );

    const panels: { label: string; ok: boolean; html: string }[] = [];
    const failures: string[] = [];
    cases.forEach((c, i) => {
      let reason: string | null = null;
      try {
        c.check(strip(runs[i]!.raw), runs[i]!.status);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        failures.push(`${c.label} → ${reason}`);
      }
      panels.push({ label: c.label, ok: reason === null, html: ansiToHtml(runs[i]!.raw) });
    });

    const dest = NodePath.resolve(
      INSTALL_SCRIPT,
      "..",
      "SPECS/e2e-runs/terminal-cards",
      "wrapper-cards.html",
    );
    try {
      NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
      NodeFS.writeFileSync(dest, buildGalleryPage(panels, "Wrapper cards"));
    } catch {
      /* best-effort artifact */
    }

    expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
