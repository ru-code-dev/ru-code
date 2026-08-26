// ru-code: the effective-identity resolver is the heart of the CLI-profile feature.
// Each provider instance's { bin, dir, name, artifact } is derived from
// (profile × per-instance settings × boot preflight). These tests pin the exact
// resolution for multiple instances side-by-side across config combinations, and
// prove the resolved bin drives the right spawn shape (`node <cli.js>` vs a direct
// command). See specs/cli-profiles.md.
import { describe, expect, it } from "vite-plus/test";
import { QwenSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildQwenSpawnBaseEnv,
  formatQwenModelId,
  resolveCliProfileSettings,
  resolveDefaultAuthMethod,
  resolveModelAuthMethod,
  type CliPreflight,
} from "../../qwen/profileResolver.ts";
import { buildCliSpawn, isJsEntry } from "@ru-code/qwen/spawn";
import { CLI_HOME_ENV_VAR, resolveCliProfile } from "@ru-code/branding";

const decode = Schema.decodeSync(QwenSettings);
// A realistic boot preflight: a fork's detected cli.js + its config dir.
const PREFLIGHT: CliPreflight = {
  cliJs: "/home/u/.qwen/bin/cli.js",
  cliConfigDir: "/home/u/.qwen",
};

describe("resolveCliProfileSettings — profile × settings × preflight", () => {
  it("custom profile, no overrides → preflight bin+dir, Custom Code branding", () => {
    const r = resolveCliProfileSettings(decode({ profile: "custom" }), PREFLIGHT);
    expect(r.profile.id).toBe("custom");
    expect(r.name).toBe("Custom Code");
    expect(r.artifact).toBe("CUSTOM_CODE");
    // null profile defaults → fall back to the preflight-detected values.
    expect(r.bin).toBe("/home/u/.qwen/bin/cli.js");
    expect(r.dir).toBe("/home/u/.qwen");
  });

  it("qwen profile, no overrides → `qwen` command + ~/.qwen, Qwen Code branding", () => {
    const r = resolveCliProfileSettings(decode({ profile: "qwen" }), PREFLIGHT);
    expect(r.name).toBe("Qwen Code");
    expect(r.artifact).toBe("QWEN");
    expect(r.bin).toBe("qwen"); // literal profile default (a PATH command, not preflight)
    expect(r.dir).toBe("~/.qwen");
  });

  it("omitted profile decodes to the default (custom)", () => {
    const r = resolveCliProfileSettings(decode({}), PREFLIGHT);
    expect(r.profile.id).toBe("custom");
    expect(r.name).toBe("Custom Code");
    expect(r.bin).toBe("/home/u/.qwen/bin/cli.js");
  });

  it("binaryPath overrides the bin default for either profile, leaving branding intact", () => {
    const forkOverride = resolveCliProfileSettings(
      decode({ profile: "custom", binaryPath: "/usr/local/bin/fork-cli.js" }),
      PREFLIGHT,
    );
    expect(forkOverride.bin).toBe("/usr/local/bin/fork-cli.js");
    expect(forkOverride.name).toBe("Custom Code");

    const qwenOverride = resolveCliProfileSettings(
      decode({ profile: "qwen", binaryPath: "/opt/qwen/cli.js" }),
      PREFLIGHT,
    );
    expect(qwenOverride.bin).toBe("/opt/qwen/cli.js");
    expect(qwenOverride.name).toBe("Qwen Code");
    expect(qwenOverride.artifact).toBe("QWEN");
  });

  it("homePath overrides the dir default for either profile", () => {
    const fork = resolveCliProfileSettings(
      decode({ profile: "custom", homePath: "/data/fork-home" }),
      PREFLIGHT,
    );
    expect(fork.dir).toBe("/data/fork-home");
    const qwen = resolveCliProfileSettings(
      decode({ profile: "qwen", homePath: "/data/qwen-home" }),
      PREFLIGHT,
    );
    expect(qwen.dir).toBe("/data/qwen-home");
  });

  it("blank/whitespace overrides fall back to the profile default (never the empty string)", () => {
    const r = resolveCliProfileSettings(
      decode({ profile: "qwen", binaryPath: "   ", homePath: "" }),
      PREFLIGHT,
    );
    expect(r.bin).toBe("qwen");
    expect(r.dir).toBe("~/.qwen");
  });

  it("three instances side-by-side resolve independently", () => {
    const forkDefault = resolveCliProfileSettings(decode({ profile: "custom" }), PREFLIGHT);
    const stockQwen = resolveCliProfileSettings(
      decode({ profile: "qwen", binaryPath: "/opt/qwen/cli.js" }),
      PREFLIGHT,
    );
    const secondFork = resolveCliProfileSettings(
      decode({ profile: "custom", binaryPath: "/opt/fork2/cli.js", homePath: "/opt/fork2/home" }),
      PREFLIGHT,
    );
    expect([forkDefault.bin, stockQwen.bin, secondFork.bin]).toEqual([
      "/home/u/.qwen/bin/cli.js",
      "/opt/qwen/cli.js",
      "/opt/fork2/cli.js",
    ]);
    expect([forkDefault.name, stockQwen.name, secondFork.name]).toEqual([
      "Custom Code",
      "Qwen Code",
      "Custom Code",
    ]);
    expect([forkDefault.artifact, stockQwen.artifact]).toEqual(["CUSTOM_CODE", "QWEN"]);
    expect(secondFork.dir).toBe("/opt/fork2/home");
  });

  it("when preflight detected nothing, custom falls back to empty bin (app still boots)", () => {
    const noPreflight: CliPreflight = { cliJs: "", cliConfigDir: "/home/u/.qwen" };
    const r = resolveCliProfileSettings(decode({ profile: "custom" }), noPreflight);
    expect(r.bin).toBe(""); // nothing to spawn until the user sets binaryPath
    // …and a user-set path recovers it:
    const fixed = resolveCliProfileSettings(
      decode({ profile: "custom", binaryPath: "/manual/cli.js" }),
      noPreflight,
    );
    expect(fixed.bin).toBe("/manual/cli.js");
  });
});

describe("resolveDefaultAuthMethod — session-start auth (override ?? profile default)", () => {
  it("falls back to the profile default when unset (custom → openai, qwen → qwen-oauth)", () => {
    expect(resolveDefaultAuthMethod(decode({ profile: "custom" }))).toBe("openai");
    expect(resolveDefaultAuthMethod(decode({ profile: "qwen" }))).toBe("qwen-oauth");
  });

  it("a valid per-instance override wins over the profile default", () => {
    expect(resolveDefaultAuthMethod(decode({ profile: "qwen", defaultAuthMethod: "openai" }))).toBe(
      "openai",
    );
    expect(
      resolveDefaultAuthMethod(decode({ profile: "custom", defaultAuthMethod: "anthropic" })),
    ).toBe("anthropic");
  });

  it("an unknown/blank override is ignored (falls back to the profile default)", () => {
    expect(resolveDefaultAuthMethod(decode({ profile: "qwen", defaultAuthMethod: "bogus" }))).toBe(
      "qwen-oauth",
    );
    expect(resolveDefaultAuthMethod(decode({ profile: "custom", defaultAuthMethod: "" }))).toBe(
      "openai",
    );
  });
});

describe("resolveModelAuthMethod — per-model auth appended at setModel", () => {
  it("a built-in model uses its own profile-declared auth method", () => {
    // Model-agnostic: take an ACTUAL built-in from the custom profile and assert the
    // resolver returns THAT model's declared authMethod — never a hardcoded slug/auth.
    const builtIn = resolveCliProfile("custom").models[0];
    expect(builtIn).toBeDefined();
    expect(resolveModelAuthMethod(decode({ profile: "custom" }), builtIn!.slug)).toBe(
      builtIn!.authMethod,
    );
  });

  it("a custom model uses its stored authMethod when it is a known id", () => {
    const settings = decode({
      profile: "qwen",
      customModels: [{ slug: "my-model", authMethod: "anthropic" }],
    });
    expect(resolveModelAuthMethod(settings, "my-model")).toBe("anthropic");
  });

  it("a custom model with a blank/unknown authMethod falls back to the instance default", () => {
    const blank = decode({
      profile: "qwen",
      customModels: [{ slug: "m1", authMethod: "" }],
    });
    // qwen profile default is qwen-oauth…
    expect(resolveModelAuthMethod(blank, "m1")).toBe("qwen-oauth");
    // …and a per-instance defaultAuthMethod override drives the fallback.
    const withDefault = decode({
      profile: "qwen",
      defaultAuthMethod: "openai",
      customModels: [{ slug: "m1", authMethod: "" }],
    });
    expect(resolveModelAuthMethod(withDefault, "m1")).toBe("openai");
  });

  it("an unknown slug falls back to the instance default auth method", () => {
    expect(resolveModelAuthMethod(decode({ profile: "custom" }), "not-a-model")).toBe("openai");
  });
});

describe("formatQwenModelId — the ACP model-id wire format", () => {
  it("encodes as `${slug}(${authMethod})` (matches qwen's formatAcpModelId)", () => {
    expect(formatQwenModelId("qwen3-coder-plus", "openai")).toBe("qwen3-coder-plus(openai)");
    expect(formatQwenModelId("custom-x", "anthropic")).toBe("custom-x(anthropic)");
    expect(formatQwenModelId("m", "qwen-oauth")).toBe("m(qwen-oauth)");
  });

  // The exact composition QwenAdapter.sendTurn uses to build the setModel value:
  // formatQwenModelId(model, resolveModelAuthMethod(settings, model)). The wire
  // test (qwenAuthWire) proves this string is transmitted verbatim to qwen.
  it("composes the wire value the adapter dispatches for built-in / custom / fallback", () => {
    const encode = (settings: Parameters<typeof resolveModelAuthMethod>[0], slug: string) =>
      formatQwenModelId(slug, resolveModelAuthMethod(settings, slug));
    // built-in model of the custom profile → its own auth (derived from the registry)
    const customBuiltIn = resolveCliProfile("custom").models[0]!;
    expect(encode(decode({ profile: "custom" }), customBuiltIn.slug)).toBe(
      `${customBuiltIn.slug}(${customBuiltIn.authMethod})`,
    );
    // custom model with an explicit auth
    const withCustom = decode({
      profile: "qwen",
      customModels: [{ slug: "x", authMethod: "anthropic" }],
    });
    expect(encode(withCustom, "x")).toBe("x(anthropic)");
    // unknown slug on stock qwen → falls back to the instance default (qwen-oauth)
    expect(encode(decode({ profile: "qwen" }), "unknown")).toBe("unknown(qwen-oauth)");
  });
});

describe("resolved bin → spawn shape (node vs direct command)", () => {
  it("isJsEntry recognizes .js/.mjs/.cjs, rejects bare commands", () => {
    expect(isJsEntry("/opt/cli.js")).toBe(true);
    expect(isJsEntry("/opt/cli.mjs")).toBe(true);
    expect(isJsEntry("/opt/cli.cjs")).toBe(true);
    expect(isJsEntry("qwen")).toBe(false);
    expect(isJsEntry("/usr/local/bin/qwen")).toBe(false);
  });

  it("a resolved cli.js path spawns via node", () => {
    const r = resolveCliProfileSettings(decode({ profile: "custom" }), PREFLIGHT);
    const spawn = buildCliSpawn(r.bin, ["--acp"]);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/home/u/.qwen/bin/cli.js", "--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("the `qwen` command default spawns directly (no node wrapper)", () => {
    const r = resolveCliProfileSettings(decode({ profile: "qwen" }), PREFLIGHT);
    const spawn = buildCliSpawn(r.bin, ["--acp"]);
    expect(spawn.command).toBe("qwen");
    expect(spawn.args).toEqual(["--acp"]);
    expect(spawn.shell).toBe(false);
  });

  it("a native-binary override (no .js) spawns directly", () => {
    const r = resolveCliProfileSettings(
      decode({ profile: "qwen", binaryPath: "/usr/local/bin/qwen" }),
      PREFLIGHT,
    );
    const spawn = buildCliSpawn(r.bin, ["--acp"]);
    expect(spawn.command).toBe("/usr/local/bin/qwen");
    expect(spawn.args).toEqual(["--acp"]);
  });

  it("a user-set .js override on the qwen profile spawns via node", () => {
    const r = resolveCliProfileSettings(
      decode({ profile: "qwen", binaryPath: "/opt/qwen/cli.js" }),
      PREFLIGHT,
    );
    const spawn = buildCliSpawn(r.bin, ["--acp"]);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/opt/qwen/cli.js", "--acp"]);
  });
});

// ru-code: QWEN_HOME injection — the ONE base env every qwen spawn (ACP cold,
// warm slot, textgen, version probe) is built from in QwenDriver.create.
describe("buildQwenSpawnBaseEnv — QWEN_HOME injection", () => {
  it("injects the preflight CLI profile dir as QWEN_HOME", () => {
    const env = buildQwenSpawnBaseEnv("/home/u/.qwen", { PATH: "/usr/bin" });
    expect(env[CLI_HOME_ENV_VAR]).toBe("/home/u/.qwen");
    expect(env["PATH"]).toBe("/usr/bin"); // base env preserved
  });

  it("wins over an inherited shell QWEN_HOME", () => {
    const env = buildQwenSpawnBaseEnv("/home/u/.qwen", {
      [CLI_HOME_ENV_VAR]: "/somewhere/else",
    });
    expect(env[CLI_HOME_ENV_VAR]).toBe("/home/u/.qwen");
  });

  it("an empty/blank dir injects nothing and returns the base env untouched", () => {
    const base = { PATH: "/usr/bin" };
    expect(buildQwenSpawnBaseEnv("", base)).toBe(base);
    expect(buildQwenSpawnBaseEnv("   ", base)).toBe(base);
    expect(buildQwenSpawnBaseEnv("", base)[CLI_HOME_ENV_VAR]).toBeUndefined();
  });

  it("does not mutate the provided base env", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    buildQwenSpawnBaseEnv("/home/u/.qwen", base);
    expect(base[CLI_HOME_ENV_VAR]).toBeUndefined();
  });
});
