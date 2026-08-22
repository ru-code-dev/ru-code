// ru-code: asserts the user-facing preflight strings are non-empty and that the
// entries built from constants actually interpolate those constants (so a
// version bump in constants.ts propagates into the "please update" copy).
import { describe, expect, it } from "vite-plus/test";

import { CLI_PROFILES, DEFAULT_CLI_PROFILE_ID } from "@ru-code/branding";

import { CLI_MIN_VERSION, NODE_ENGINE_RANGE } from "../../preflight/common/constants.ts";
import { MESSAGES } from "../../preflight/common/messages.ts";

// ru-code: preflight labels the CLI-status lines with the default profile name.
const CLI_LABEL = CLI_PROFILES[DEFAULT_CLI_PROFILE_ID].name;

describe("MESSAGES", () => {
  it("every entry is a non-empty string", () => {
    for (const [key, value] of Object.entries(MESSAGES)) {
      expect(typeof value, key).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it("status entries carry the {found} placeholder for the caller to fill", () => {
    expect(MESSAGES.NODE_OK).toContain("{found}");
    expect(MESSAGES.GIT_OK).toContain("{found}");
    expect(MESSAGES.CLI_OK).toContain("{found}");
    expect(MESSAGES.NODE_LOW).toContain("{found}");
  });

  it("NODE_LOW embeds the engine range from constants", () => {
    expect(MESSAGES.NODE_LOW).toContain(NODE_ENGINE_RANGE);
  });

  it("CLI_LOW embeds the min version and the CLI label to update", () => {
    expect(MESSAGES.CLI_LOW).toContain(CLI_MIN_VERSION);
    expect(MESSAGES.CLI_LOW).toContain(CLI_LABEL);
  });

  it("CLI_TOO_SLOW references the CLI label", () => {
    expect(MESSAGES.CLI_TOO_SLOW).toContain(CLI_LABEL);
  });
});
