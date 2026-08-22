// @effect-diagnostics nodeBuiltinImport:off - install-flow: removes a sandbox fixture dir on disk.
// ru-code: bundle resolution — resolve_local_bundle picks the single co-located tarball and
// parse_bundle_version derives the version from the FILENAME (§0). Exactly one bundle by contract:
// zero → REC(package); more than one → CRASH(corrupt). Dashed APP_COMMAND / pre-release versions.

import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { makeSandbox, sourceEval } from "./harness.ts";

describe("install resolve_local_bundle", () => {
  it("resolves the single tarball and parses its version from the filename", () => {
    const sb = makeSandbox();
    try {
      sb.write("ru-code/dist-bundle/ru-code-0.13.1.tgz", "x");
      const r = sourceEval(
        sb,
        `BUNDLE_DIR=${sb.cloneDir}; resolve_local_bundle; echo "A=$ARCHIVE_PATH"; echo "V=$APP_VERSION"`,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("ru-code-0.13.1.tgz");
      expect(r.stdout).toContain("V=0.13.1");
    } finally {
      sb.cleanup();
    }
  });

  it("parse_bundle_version strips the APP_COMMAND- prefix and .tgz — keeps dashed pre-release versions", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(
        sb,
        `parse_bundle_version /a/b/ru-code-1.2.0-rc.3.tgz; echo "V=$APP_VERSION"`,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("V=1.2.0-rc.3");
    } finally {
      sb.cleanup();
    }
  });

  it("zero bundles → REC(package), non-zero exit", () => {
    const sb = makeSandbox();
    try {
      const r = sourceEval(sb, `BUNDLE_DIR=${sb.cloneDir}; resolve_local_bundle`);
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("Дистрибутив не найден");
    } finally {
      sb.cleanup();
    }
  });

  it("more than one bundle → CRASH(corrupt), exit 2 (contract is exactly one)", () => {
    const sb = makeSandbox();
    try {
      sb.write("ru-code/dist-bundle/ru-code-1.0.0.tgz", "x");
      sb.write("ru-code/dist-bundle/ru-code-1.2.0.tgz", "x");
      const r = sourceEval(sb, `BUNDLE_DIR=${sb.cloneDir}; resolve_local_bundle`);
      expect(r.status).toBe(2);
      expect(r.all).toContain("Пакет повреждён");
    } finally {
      sb.cleanup();
    }
  });

  it("bootstrap fails with REC(package) when the clone dir is absent and no REMOTE_URL", () => {
    const sb = makeSandbox();
    try {
      NodeFS.rmSync(sb.cloneDir, { recursive: true, force: true });
      const r = sourceEval(sb, `TEMP_DIR=$(mktemp -d); bootstrap`);
      expect(r.status).not.toBe(0);
      expect(r.all).toContain("Дистрибутив не найден");
    } finally {
      sb.cleanup();
    }
  });
});
