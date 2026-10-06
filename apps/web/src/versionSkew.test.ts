import { APP_NAME } from "@ru-code/branding";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_VERSION } from "./branding";
import {
  appendVersionMismatchHint,
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  serverUpdateGuidance,
} from "./versionSkew";

describe("versionSkew", () => {
  it("does not warn when versions match", () => {
    expect(resolveVersionMismatch(APP_VERSION)).toBeNull();
  });

  // ru-code: a skew is never reported — the T3 "Server update available" banner, the reconnect
  // fold and the `npx t3@<version>` action must not appear after an auto-update.
  it("does not warn when the server version differs from the client", () => {
    expect(resolveVersionMismatch("9.9.9")).toBeNull();
  });

  it("does not warn when the server version is missing", () => {
    expect(resolveVersionMismatch(null)).toBeNull();
    expect(resolveVersionMismatch(undefined)).toBeNull();
    expect(resolveVersionMismatch("  ")).toBeNull();
  });

  it("does not warn from config descriptors whose server version differs", () => {
    expect(
      resolveServerConfigVersionMismatch({
        environment: {
          environmentId: EnvironmentId.make("environment-1"),
          label: "Remote",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
          },
        },
      }),
    ).toBeNull();
  });

  it("keys dismissals by environment, client version, and server version", () => {
    const environmentId = EnvironmentId.make("environment-dismissal");
    const key = buildVersionMismatchDismissalKey(environmentId, {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
    });

    expect(key).toBe(`${environmentId}:${APP_VERSION}:9.9.9`);
    expect(isVersionMismatchDismissed(key)).toBe(false);

    dismissVersionMismatch(key);

    expect(isVersionMismatchDismissed(key)).toBe(true);
    expect(
      isVersionMismatchDismissed(
        buildVersionMismatchDismissalKey(environmentId, {
          clientVersion: APP_VERSION,
          serverVersion: "9.9.10",
        }),
      ),
    ).toBe(false);
  });

  it("appends a hint to connection errors when given a mismatch", () => {
    const mismatch = {
      clientVersion: APP_VERSION,
      serverVersion: "9.9.9",
      hint: `Version mismatch. Try syncing the client and server to the same ${APP_NAME} version.`,
    };

    expect(appendVersionMismatchHint("Socket closed.", mismatch)).toBe(
      `Socket closed. Hint: Version mismatch. Try syncing the client and server to the same ${APP_NAME} version.`,
    );
    expect(appendVersionMismatchHint("Socket closed.", resolveVersionMismatch("9.9.9"))).toBe(
      "Socket closed.",
    );
  });

  it("reads desktop-managed update capabilities from config descriptors", () => {
    expect(
      resolveServerSelfUpdateCapability({
        environment: {
          environmentId: EnvironmentId.make("environment-desktop"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "9.9.9",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "desktop-managed",
          },
        },
      }),
    ).toBe("desktop-managed");
    expect(resolveServerSelfUpdateCapability(null)).toBeNull();
  });

  it("matches version-drift guidance to the advertised update path", () => {
    expect(serverUpdateGuidance("respawn", "Remote server")).toBe(
      "Update the Remote server so they stay in sync.",
    );
    expect(serverUpdateGuidance("desktop-managed", "Desktop server")).toBe(
      "Update the desktop app that runs the Desktop server.",
    );
    expect(serverUpdateGuidance(null, "Local server")).toBe(
      "Relaunch the Local server with the copied command to sync them.",
    );
  });
});
