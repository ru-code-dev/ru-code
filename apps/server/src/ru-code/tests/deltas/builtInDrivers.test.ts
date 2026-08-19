// ru-code delta coverage: src/provider/builtInDrivers.ts
//
// The fork temporarily limits the built-in driver registry to qwen + opencode
// (all other drivers' imports / BuiltInDriversEnv members / BUILT_IN_DRIVERS
// entries are commented out — builtInDrivers.ts:23,40,54). This asserts the
// exported `BUILT_IN_DRIVERS` array membership matches exactly those two.
//
// (`BuiltInDriversEnv` is a compile-time type union with no runtime value, so
// its "exactly qwen + opencode" shape is verified by tsgo, not here.)

import { assert, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../../../provider/builtInDrivers.ts";
import { OpenCodeDriver } from "../../../provider/Drivers/OpenCodeDriver.ts";
import { QwenDriver } from "../../qwen/QwenDriver.ts";

it("BUILT_IN_DRIVERS ships exactly qwen + opencode", () => {
  assert.strictEqual(BUILT_IN_DRIVERS.length, 2);
  assert.include(BUILT_IN_DRIVERS, OpenCodeDriver);
  assert.include(BUILT_IN_DRIVERS, QwenDriver);
});

it("BUILT_IN_DRIVERS driver kinds are exactly [opencode, qwen] in source order", () => {
  const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
  assert.deepStrictEqual(kinds, [OpenCodeDriver.driverKind, QwenDriver.driverKind]);
});

it("BUILT_IN_DRIVERS excludes the commented-out claude/codex/cursor/grok drivers", () => {
  const kinds = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind));
  for (const excluded of ["claude", "codex", "cursor", "grok"]) {
    assert.notInclude(kinds, excluded);
  }
});
