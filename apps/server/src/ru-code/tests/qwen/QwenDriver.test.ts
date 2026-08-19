// ru-code: coverage for the pure, IO-free surface of the QwenDriver:
//   - defaultConfig() decoding (the `enabled: true` default that feeds the
//     `effectiveEnabled = enabled && cliDetected` gate)
//   - static metadata / driverKind / configSchema identity
//
// The full `create(...)` effect is deferred to Phase 3 fake-ACP e2e: it wires
// makeQwenAdapter + makeManagedServerProvider (background refresh fibers that
// spawn `node cli.js --version`) and needs the whole
// ChildProcessSpawner/Crypto/FileSystem/Path/ProviderEventLoggers/ServerConfig
// stack — integration-level, not a unit. The gate's INPUT (`enabled: true`) and
// its snapshot builders (checkQwenProviderStatus / buildInitialQwenProviderSnapshot)
// are covered in QwenProvider.extra.test.ts.
import { describe, expect, it } from "vite-plus/test";
import { QWEN_KIND } from "@ru-code/branding";
import { ProviderDriverKind, QwenSettings } from "@t3tools/contracts";

import { QwenDriver } from "../../qwen/QwenDriver.ts";

describe("QwenDriver.defaultConfig", () => {
  it("decodes the {} default: enabled true, custom profile, empty overrides", () => {
    const config = QwenDriver.defaultConfig();
    expect(config.enabled).toBe(true);
    // ru-code: default profile is the fork ("custom"); the boot-seeded instance uses it.
    expect(config.profile).toBe("custom");
    // ru-code: binaryPath/homePath default EMPTY so the resolver falls back to the
    // profile default (preflight cli.js for the custom fork).
    expect(config.binaryPath).toBe("");
    expect(config.homePath).toBe("");
    expect(config.launchArgs).toBe("");
    expect(config.customModels).toEqual([]);
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    expect(QwenDriver.defaultConfig()).not.toBe(QwenDriver.defaultConfig());
    expect(QwenDriver.defaultConfig()).toEqual(QwenDriver.defaultConfig());
  });
});

describe("QwenDriver static shape", () => {
  it("driverKind is the single CLI kind (qwen)", () => {
    expect(QwenDriver.driverKind).toBe(ProviderDriverKind.make(QWEN_KIND));
  });

  it("advertises multi-instance metadata", () => {
    expect(QwenDriver.metadata.displayName).toBe("Qwen");
    expect(QwenDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("configSchema is the QwenSettings schema", () => {
    expect(QwenDriver.configSchema).toBe(QwenSettings);
  });
});
