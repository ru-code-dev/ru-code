// ru-code: the "running for" uptime formatter used in the daemon banner.

import { describe, expect, it } from "vite-plus/test";

import { formatDuration } from "@ru-code/daemon/duration";

describe("daemon formatDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats minutes + seconds", () => {
    expect(formatDuration(3 * 60_000 + 5_000)).toBe("3m 5s");
  });

  it("formats hours + minutes", () => {
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
  });

  it("formats days + hours", () => {
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
  });

  it("clamps negatives and non-finite to 0s", () => {
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
