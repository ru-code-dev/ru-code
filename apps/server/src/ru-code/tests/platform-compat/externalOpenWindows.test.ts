// ru-code: pins the Windows browser-launch compat (EXTERNAL_OPEN_WINDOWS). Default "cmd-start"
// must produce a `cmd.exe /d /s /c start "" <url>` spawn (start = true ShellExecute, so the
// pairing `#token=…` fragment reaches the browser — explorer.exe drops it) with NONE of the
// Node-#51018 trigger combo (detached + all-ignore stdio + powershell); the explorer and legacy
// PowerShell launches stay reachable only when the constant is flipped, so the test asserts
// RELATIVE to the constant.

import { EXTERNAL_OPEN_WINDOWS } from "@ru-code/platform-compat/constants";
import { describe, expect, it } from "vite-plus/test";

import { buildWindowsBrowserLaunchCompat } from "../../platform-compat/externalOpenWindows.ts";

const LEGACY_LAUNCH = {
  command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  args: ["-EncodedCommand", "…"],
  options: { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
} as const;

describe("buildWindowsBrowserLaunchCompat", () => {
  it("default method opens via cmd start, NOT PowerShell, NOT detached", () => {
    const target = "https://example.com/a?b=1";
    const launch = buildWindowsBrowserLaunchCompat(target, () => LEGACY_LAUNCH);
    if (EXTERNAL_OPEN_WINDOWS === "cmd-start") {
      expect(launch.command).toBe("cmd.exe");
      // The empty "" arg is start's window-title slot — a quoted url must not be eaten as title.
      expect(launch.args).toEqual(["/d", "/s", "/c", "start", "", target]);
      // The #51018 trigger is detached:true + stdio ignore + powershell — cmd avoids the
      // engine entirely AND stays non-detached.
      expect(launch.options.detached).toBe(false);
    } else if (EXTERNAL_OPEN_WINDOWS === "explorer") {
      expect(launch.command).toBe("explorer.exe");
      expect(launch.args).toEqual([target]);
      expect(launch.options.detached).toBe(false);
    } else {
      expect(launch).toBe(LEGACY_LAUNCH);
    }
  });

  it("passes the target through verbatim (URLs with query/fragment survive)", () => {
    const target = "http://localhost:5173/path#frag?x=%20y";
    const launch = buildWindowsBrowserLaunchCompat(target, () => LEGACY_LAUNCH);
    if (EXTERNAL_OPEN_WINDOWS === "cmd-start") {
      expect(launch.args[launch.args.length - 1]).toBe(target);
    } else if (EXTERNAL_OPEN_WINDOWS === "explorer") {
      expect(launch.args).toEqual([target]);
    }
  });
});
