// ru-code: pins the Windows browser-launch compat (EXTERNAL_OPEN_WINDOWS). Default "explorer"
// must produce an explorer.exe spawn with NONE of the Node-#51018 trigger combo (detached +
// all-ignore stdio + powershell); the legacy PowerShell launch stays reachable only when the
// constant is flipped, so the test asserts RELATIVE to the constant.

import { EXTERNAL_OPEN_WINDOWS } from "@ru-code/platform-compat/constants";
import { describe, expect, it } from "vite-plus/test";

import { buildWindowsBrowserLaunchCompat } from "../../platform-compat/externalOpenWindows.ts";

const LEGACY_LAUNCH = {
  command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  args: ["-EncodedCommand", "…"],
  options: { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
} as const;

describe("buildWindowsBrowserLaunchCompat", () => {
  it("default method opens via explorer.exe, NOT PowerShell, NOT detached", () => {
    const launch = buildWindowsBrowserLaunchCompat(
      "https://example.com/a?b=1",
      () => LEGACY_LAUNCH,
    );
    if (EXTERNAL_OPEN_WINDOWS === "explorer") {
      expect(launch.command).toBe("explorer.exe");
      expect(launch.args).toEqual(["https://example.com/a?b=1"]);
      // The #51018 trigger is detached:true + stdio ignore + powershell — explorer avoids the
      // engine entirely AND stays non-detached.
      expect(launch.options.detached).toBe(false);
    } else {
      expect(launch).toBe(LEGACY_LAUNCH);
    }
  });

  it("passes the target through verbatim (URLs with query/fragment survive)", () => {
    const target = "http://localhost:5173/path#frag?x=%20y";
    const launch = buildWindowsBrowserLaunchCompat(target, () => LEGACY_LAUNCH);
    if (EXTERNAL_OPEN_WINDOWS === "explorer") {
      expect(launch.args).toEqual([target]);
    }
  });
});
