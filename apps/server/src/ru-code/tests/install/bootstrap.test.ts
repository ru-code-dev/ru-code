// @effect-diagnostics nodeBuiltinImport:off - install-flow: builds bundle fixtures on disk.
// ru-code: standalone bootstrap (§0) — when there is no co-located ./ru-code clone and REMOTE_URL
// is set (a DIRECT https URL to a <APP_COMMAND>-<VERSION>.tgz bundle), the installer downloads that
// ONE file into ./ru-code and proceeds (the preflight ships inside the bundle). A non-https
// REMOTE_URL → REC(insecure). curl is stubbed (no network).

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  makeSandbox,
  makeShimDir,
  pathWith,
  runInstaller,
  writeFakeRelease,
  type Sandbox,
} from "./harness.ts";

/** A stubbed `curl` that copies a local bundle fixture to curl's -o destination. */
function stubCurl(sb: Sandbox, tgzPath: string): string {
  return makeShimDir(sb, {
    curl: `
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    --max-time|--retry) shift 2 ;;
    --*) shift ;;
    *) shift ;;
  esac
done
cp "${tgzPath}" "$dest"
`,
  });
}

describe("install bootstrap (standalone REMOTE_URL)", () => {
  it("downloads the bundle .tgz from a direct REMOTE_URL and installs (preflight bundled inside)", () => {
    const sb = makeSandbox();
    try {
      const tgz = writeFakeRelease(sb, { version: "0.13.1" }); // bundle carries a sandbox preflight
      NodeFS.copyFileSync(tgz, sb.path("bundle.tgz"));
      NodeFS.rmSync(sb.cloneDir, { recursive: true, force: true }); // no co-located clone → go remote

      const shim = stubCurl(sb, sb.path("bundle.tgz"));
      const r = runInstaller(sb, {
        args: ["--keep-source"],
        env: { REMOTE_URL: "https://example.test/ru-code-0.13.1.tgz", PATH: pathWith(shim) },
      });

      expect(r.status).toBe(0);
      expect(sb.exists("ru-code/dist-bundle/ru-code-0.13.1.tgz")).toBe(true); // downloaded
      expect(sb.exists("app/.ru-code/bin/cli.js")).toBe(true); // installed
      expect(r.all).toContain("установлен · 0.13.1");
    } finally {
      sb.cleanup();
    }
  });

  it("non-https REMOTE_URL → REC(insecure) (exit 1), nothing downloaded", () => {
    const sb = makeSandbox();
    try {
      NodeFS.rmSync(sb.cloneDir, { recursive: true, force: true });
      const r = runInstaller(sb, { env: { REMOTE_URL: "http://example.test/ru-code-0.13.1.tgz" } });
      expect(r.status).toBe(1);
      expect(r.all).toContain("Небезопасный источник");
      expect(sb.exists("ru-code")).toBe(false);
    } finally {
      sb.cleanup();
    }
  });

  it("no clone and empty REMOTE_URL → REC(package) (exit 1)", () => {
    const sb = makeSandbox();
    try {
      NodeFS.rmSync(sb.cloneDir, { recursive: true, force: true });
      const r = runInstaller(sb, {}); // REMOTE_URL defaults to the empty injected value
      expect(r.status).toBe(1);
      expect(r.all).toContain("Дистрибутив не найден");
    } finally {
      sb.cleanup();
    }
  });
});
