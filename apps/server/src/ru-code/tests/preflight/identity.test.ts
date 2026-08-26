// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/namespace-node-imports -- vendored standalone preflight subsystem; keeps its self-contained node-builtin imports
// ru-code: the CLI_PASS_IDENTITY feature — extractIdentityValue (the tolerant KEY= parser),
// probeCliIdentity (path → file → value, every miss spelled out) and resolveCliIdentity (the
// one-liner spawn sites call). The identity file is READ, never executed; a miss of any kind
// must degrade to "no value" so every spawn keeps today's env.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { IDENTITY_KEY } from "@ru-code/branding";

import {
  extractIdentityValue,
  identityEnvRuntime,
  probeCliIdentity,
  resolveCliIdentity,
} from "../../preflight/common/identity.ts";

const KEY = "QWEN_PACKAGE_IDENTITY";

describe("extractIdentityValue", () => {
  it("parses the POSIX shape KEY='VALUE'", () => {
    expect(extractIdentityValue(`#!/bin/sh\n${KEY}='abc-123'\nexec node cli.js "$@"\n`, KEY)).toBe(
      "abc-123",
    );
  });

  it('parses the Windows shape set "KEY=VALUE" with CRLF endings', () => {
    expect(
      extractIdentityValue(`@echo off\r\nset "${KEY}=win.value"\r\nnode cli.js %*\r\n`, KEY),
    ).toBe("win.value");
  });

  it("tolerates unlisted prefixes and quoting (export, SET, double quotes, bare)", () => {
    expect(extractIdentityValue(`export ${KEY}="v1"\n`, KEY)).toBe("v1");
    expect(extractIdentityValue(`SET "${KEY}=v2"\n`, KEY)).toBe("v2");
    expect(extractIdentityValue(`${KEY}=v3\n`, KEY)).toBe("v3");
  });

  it("strips a leading UTF-8 BOM", () => {
    expect(extractIdentityValue(`﻿${KEY}='bom'\n`, KEY)).toBe("bom");
  });

  // The real-world wrapper shape: the assignment SHARES its line with code. A quoted value ends
  // at its closing quote; an unquoted one at the first whitespace — the rest of the line (exec,
  // args, comments) must never bleed into the value.
  it("cuts a same-line assignment at the value's own boundary", () => {
    expect(extractIdentityValue(`${KEY}='id-1' exec node cli.js "$@"\n`, KEY)).toBe("id-1");
    expect(extractIdentityValue(`${KEY}="id-2" && run_the_thing\n`, KEY)).toBe("id-2");
    expect(extractIdentityValue(`${KEY}=id-3 exec cli\n`, KEY)).toBe("id-3");
    expect(extractIdentityValue(`env ${KEY}='id-5' cli --flag\n`, KEY)).toBe("id-5");
  });

  it("rejects the tail of a longer variable name (boundary check)", () => {
    expect(extractIdentityValue(`MY_${KEY}='wrong'\n`, KEY)).toBeUndefined();
    expect(extractIdentityValue(`MY_${KEY}='wrong'\n${KEY}='right'\n`, KEY)).toBe("right");
  });

  it("first non-empty assignment wins", () => {
    expect(extractIdentityValue(`${KEY}='one'\n${KEY}='two'\n`, KEY)).toBe("one");
    expect(extractIdentityValue(`${KEY}=''\n${KEY}='two'\n`, KEY)).toBe("two");
  });

  it("misses cleanly: no key, empty value, empty content", () => {
    expect(extractIdentityValue("#!/bin/sh\nexec node cli.js\n", KEY)).toBeUndefined();
    expect(extractIdentityValue(`${KEY}=''\n`, KEY)).toBeUndefined();
    expect(extractIdentityValue("", KEY)).toBeUndefined();
  });

  it("never expands $VAR/%VAR% — the value is taken literally", () => {
    // The strip removes quotes/whitespace only; shell-active characters survive to the charset
    // guard in probeCliIdentity (below), they are never resolved here.
    expect(extractIdentityValue(`${KEY}='$HOME'\n`, KEY)).toBe("$HOME");
  });
});

describe("probeCliIdentity / resolveCliIdentity", () => {
  let dir: string;
  const table = { darwin: "", linux: "", win32: "" };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ru-code-identity-"));
    writeFileSync(
      join(dir, "identity.sh"),
      `#!/bin/sh\n${IDENTITY_KEY}='id-ok_1'\nexec cli "$@"\n`,
    );
    writeFileSync(join(dir, "identity.cmd"), `@echo off\r\nset "${IDENTITY_KEY}=id.win"\r\n`);
    writeFileSync(join(dir, "no-key.sh"), "#!/bin/sh\nexec cli\n");
    writeFileSync(join(dir, "hostile.sh"), `${IDENTITY_KEY}='$(rm -rf /)'\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("disabled flag → state disabled, no value", () => {
    expect(probeCliIdentity({ enabled: false }).state).toBe("disabled");
    expect(resolveCliIdentity({ enabled: false })).toBeUndefined();
  });

  it("no path configured for the platform → unconfigured", () => {
    expect(
      probeCliIdentity({ enabled: true, paths: table, platform: "linux", env: {} }).state,
    ).toBe("unconfigured");
  });

  it("configured path with no file → file-missing, no value", () => {
    const probe = probeCliIdentity({
      enabled: true,
      paths: { ...table, linux: join(dir, "absent.sh") },
      platform: "linux",
      env: {},
    });
    expect(probe.state).toBe("file-missing");
    expect(
      resolveCliIdentity({
        enabled: true,
        paths: { ...table, linux: join(dir, "absent.sh") },
        platform: "linux",
        env: {},
      }),
    ).toBeUndefined();
  });

  it("reads the POSIX identity file", () => {
    const options = {
      enabled: true,
      paths: { ...table, linux: join(dir, "identity.sh") },
      platform: "linux" as const,
      env: {},
    };
    expect(probeCliIdentity(options)).toEqual({
      state: "ok",
      path: join(dir, "identity.sh"),
      value: "id-ok_1",
    });
    expect(resolveCliIdentity(options)).toBe("id-ok_1");
  });

  it("reads the Windows identity file (CRLF .cmd)", () => {
    const options = {
      enabled: true,
      paths: { ...table, win32: join(dir, "identity.cmd") },
      platform: "win32" as const,
      env: {},
    };
    expect(resolveCliIdentity(options)).toBe("id.win");
  });

  it("file without the key → key-missing, no value", () => {
    const options = {
      enabled: true,
      paths: { ...table, linux: join(dir, "no-key.sh") },
      platform: "linux" as const,
      env: {},
    };
    expect(probeCliIdentity(options).state).toBe("key-missing");
    expect(resolveCliIdentity(options)).toBeUndefined();
  });

  it("shell-active value is rejected by the charset guard (travels into a RAW bash fragment)", () => {
    const options = {
      enabled: true,
      paths: { ...table, linux: join(dir, "hostile.sh") },
      platform: "linux" as const,
      env: {},
    };
    expect(probeCliIdentity(options).state).toBe("key-missing");
    expect(resolveCliIdentity(options)).toBeUndefined();
  });

  it("identityEnvRuntime: registry fragment on a hit, empty object on any miss", () => {
    const hit = {
      enabled: true,
      paths: { ...table, linux: join(dir, "identity.sh") },
      platform: "linux" as const,
      env: {},
    };
    expect(identityEnvRuntime(hit)).toEqual({ PACKAGE_IDENTITY: "id-ok_1" });
    expect(identityEnvRuntime({ enabled: false })).toEqual({});
    expect(identityEnvRuntime({ enabled: true, paths: table, platform: "linux", env: {} })).toEqual(
      {},
    );
  });

  it("RU_CODE_CLI_IDENTITY_PATH overrides the table (tests/dev hook)", () => {
    const options = {
      enabled: true,
      paths: table,
      platform: "linux" as const,
      env: { RU_CODE_CLI_IDENTITY_PATH: join(dir, "identity.sh") },
    };
    expect(resolveCliIdentity(options)).toBe("id-ok_1");
  });
});
