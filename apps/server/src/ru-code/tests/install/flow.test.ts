// ru-code: FULL end-to-end flows — the real installer (main) run as a subprocess against a fake
// preflight + fake release, everything sandboxed. Covers the happy install (starter OFF by
// default), the --keep-source variant, the today-equivalent starter-ON install, the fatal-node
// fix card, crash rollback (verify fails → nothing left behind but the log), uninstall, and the
// missing-archive path. The redesigned installer shows cards on STDOUT and logs detail to the
// $HOME log; assertions target those surfaces.

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  readLog,
  runInstaller,
  writeFakePreflight,
  writeFakeRelease,
} from "./harness.ts";

describe("install flow — happy path", () => {
  it("installs the bin, wires PATH, removes the clone, and logs (starter OFF by default)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        appBin: "ru-code",
        nodeOk: "1",
      });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/.version")).toBe(true);
      expect(sb.exists("app/.ru-code/bin/ru-code")).toBe(true);
      expect(sb.read("home/.bashrc")).toContain(sb.path("app/.ru-code/bin"));
      // starter is OFF by default now → no Project
      expect(sb.exists("app/.ru-code/Project")).toBe(false);
      // clone removed on success; success card on screen
      expect(sb.exists("ru-code")).toBe(false);
      expect(r.all).toContain("установлен ·");
      // log written at $HOME and copied into the app dir on success
      expect(readLog(sb)).toContain("install");
      expect(sb.exists("app/.ru-code/install.log")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("keeps the clone dir under --keep-source", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, args: ["--keep-source"] });

      expect(r.status).toBe(0);
      expect(sb.exists("ru-code")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it("with starter enabled, seeds <appRoot>/Project (parity with the pre-redesign flow)", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      writeFakeRelease(sb);
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight, env: { INSTALL_CREATE_STARTER_PROJECT: "true" } });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/Project/.git")).toBe(true);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install flow — refusal + rollback", () => {
  it("shows the node fix card and installs nothing when Node is out of range", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, nodeOk: "0", status: 1 });
      writeFakeRelease(sb);

      const r = runInstaller(sb, { preflight });

      expect(r.status).not.toBe(0);
      // friendly fix card (not a raw log dump), no support ask for a user-fixable condition
      expect(r.all).toContain("Node.js");
      expect(r.all).toContain("nodejs.org");
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("tears down the bin and scrubs PATH when verify fails mid-install — log survives", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot, nodeOk: "1" });
      writeFakeRelease(sb, { cliVersionExit: 1 }); // cli.js --version fails → verify dies
      sb.write("home/.bashrc", "# shell\n");

      const r = runInstaller(sb, { preflight });

      expect(r.status).not.toBe(0);
      expect(sb.exists("app/.ru-code/bin")).toBe(false); // rolled back
      expect(sb.read("home/.bashrc")).not.toContain(".ru-code/bin"); // PATH scrubbed
      expect(readLog(sb)).not.toBe(""); // log preserved (lives at $HOME, outside the app dir)
    } finally {
      sb.cleanup();
    }
  });

  it("no bundle present → REC(package) (exit 1), nothing installed", () => {
    const sb = makeSandbox();
    try {
      const preflight = writeFakePreflight(sb, { ourRoot: sb.appRoot });
      // no writeFakeRelease → dist-bundle is empty

      const r = runInstaller(sb, { preflight });

      expect(r.status).toBe(1);
      expect(r.all).toContain("Дистрибутив не найден");
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });
});

describe("install flow — uninstall", () => {
  it("stops, removes the bin, and scrubs the rc", () => {
    const sb = makeSandbox();
    try {
      sb.write("app/.ru-code/bin/cli.js", "process.exit(0);\n");
      sb.write("app/.ru-code/bin/.version", "1\n");
      sb.write("home/.bashrc", `export PATH="${sb.path("app/.ru-code/bin")}:$PATH"\n# keep this\n`);
      writeFakeRelease(sb); // uninstall extracts the bundle to get the (bundled) preflight resolver
      const preflight = writeFakePreflight(sb, {
        ourRoot: sb.appRoot,
        appBin: "ru-code",
        nodeOk: "1",
      });

      const r = runInstaller(sb, { preflight, args: ["--uninstall", "--keep-source"] });

      expect(r.status).toBe(0);
      expect(sb.exists("app/.ru-code/bin")).toBe(false);
      const rc = sb.read("home/.bashrc");
      expect(rc).not.toContain(".ru-code/bin");
      expect(rc).toContain("# keep this");
      expect(r.all).toContain("удалён");
    } finally {
      sb.cleanup();
    }
  });
});
