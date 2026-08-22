// ru-code: the `--json` launch contract the installer reads. Two builders, one line
// each, JSON.stringify only — so the shapes cannot drift between the launcher's
// branches and hostile characters in a url or a message cannot break the line.
// The installer reads `ok` (and `url` on success) and NOTHING else; these tests pin
// the exact key set and order so a silent rename is caught here, not in a shell.

import { describe, expect, it } from "vite-plus/test";

import { formatLaunchFailureJson, formatLaunchSuccessJson } from "@ru-code/daemon/launchReport";

const parse = (line: string): Record<string, unknown> => {
  expect(line).not.toContain("\n");
  return JSON.parse(line) as Record<string, unknown>;
};

describe("daemon launch report (--json)", () => {
  it("success is ONE line with exactly {ok,url,version,pid}", () => {
    const line = formatLaunchSuccessJson({
      url: "http://127.0.0.1:7777/?pair=abc",
      version: "1.2.3",
      pid: 4242,
    });
    expect(line).toBe(
      '{"ok":true,"url":"http://127.0.0.1:7777/?pair=abc","version":"1.2.3","pid":4242}',
    );
    const parsed = parse(line);
    expect(Object.keys(parsed)).toEqual(["ok", "url", "version", "pid"]);
    expect(parsed).toEqual({
      ok: true,
      url: "http://127.0.0.1:7777/?pair=abc",
      version: "1.2.3",
      pid: 4242,
    });
  });

  it("both launcher success branches produce the identical shape", () => {
    // The ready branch reports the tokenized pairing url + the spawned child pid;
    // the already-running branch reports the plain origin + the recorded pid. Same
    // builder ⇒ same keys, same order, same types — the installer cannot tell them
    // apart, which is the point. (launch.ts routes both through one `emitSuccess`;
    // the reuse branch is exercised end-to-end in launch.test.ts.)
    const ready = parse(
      formatLaunchSuccessJson({
        url: "http://127.0.0.1:7777/?pair=abc",
        version: "1.2.3",
        pid: 4242,
      }),
    );
    const alreadyRunning = parse(
      formatLaunchSuccessJson({ url: "http://127.0.0.1:7777", version: "1.2.3", pid: 99 }),
    );
    expect(Object.keys(alreadyRunning)).toEqual(Object.keys(ready));
    expect(alreadyRunning.ok).toBe(true);
    expect(typeof alreadyRunning.url).toBe("string");
    expect(typeof alreadyRunning.pid).toBe("number");
  });

  it("failure is ONE line with exactly {ok,error,log}", () => {
    const line = formatLaunchFailureJson({
      error: "Port 7777 is busy.",
      log: "/home/user/.ru-code/userdata/daemon.log",
    });
    expect(line).toBe(
      '{"ok":false,"error":"Port 7777 is busy.","log":"/home/user/.ru-code/userdata/daemon.log"}',
    );
    const parsed = parse(line);
    expect(Object.keys(parsed)).toEqual(["ok", "error", "log"]);
    expect(parsed).toEqual({
      ok: false,
      error: "Port 7777 is busy.",
      log: "/home/user/.ru-code/userdata/daemon.log",
    });
  });

  it("a localized (Russian) failure message survives the round trip", () => {
    const parsed = parse(
      formatLaunchFailureJson({ error: "Порт 7777 занят.", log: "/tmp/daemon.log" }),
    );
    expect(parsed.error).toBe("Порт 7777 занят.");
    expect(parsed.ok).toBe(false);
  });

  it("quotes, newlines and backslashes round-trip unharmed — still ONE line", () => {
    const hostile = 'http://127.0.0.1:7777/?pair="a\\b"\nSHOULD-NOT-BE-A-SECOND-LINE\ttab';
    const line = formatLaunchSuccessJson({ url: hostile, version: 'v"1\\2', pid: 7 });
    expect(line.split("\n")).toHaveLength(1);
    const parsed = parse(line);
    expect(parsed.url).toBe(hostile);
    expect(parsed.version).toBe('v"1\\2');

    const failure = formatLaunchFailureJson({
      error: 'spawn failed: "/bin/sh"\nexit 1',
      log: "C:\\Users\\u\\.ru-code\\daemon.log",
    });
    expect(failure.split("\n")).toHaveLength(1);
    const parsedFailure = parse(failure);
    expect(parsedFailure.error).toBe('spawn failed: "/bin/sh"\nexit 1');
    expect(parsedFailure.log).toBe("C:\\Users\\u\\.ru-code\\daemon.log");
  });
});
