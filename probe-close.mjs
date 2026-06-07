// Probe: does Node's ChildProcess "close" event fire when the direct child
// exits but a backgrounded grandchild keeps the stdout pipe open?
//
// This is the exact mechanism behind the hypothesis that `runProcess`
// (which settles only on "close") hangs forever. If CLOSE never fires here,
// the hang reproduces; if CLOSE fires fast, the hypothesis does NOT hold on
// this platform/shell and we need a different explanation.
//
// Run:  node probe-close.mjs
// Safe: uses short sleeps; exits itself after a few seconds.

import { spawn } from "node:child_process";

function probe(label, shArgs, waitMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("/bin/sh", ["-c", shArgs], { stdio: "pipe" });
    let exited = false;
    let closed = false;
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.once("exit", (code) => {
      exited = true;
      console.log(`  [${label}] +${Date.now() - t0}ms exit  (code=${code})`);
    });
    child.once("close", (code) => {
      closed = true;
      console.log(`  [${label}] +${Date.now() - t0}ms CLOSE (code=${code})`);
    });
    setTimeout(() => {
      const verdict = closed
        ? "close fired -> runProcess WOULD resolve (no hang)"
        : "close NEVER fired despite exit -> runProcess WOULD HANG";
      console.log(`  [${label}] after ${waitMs}ms: exit=${exited} close=${closed}  => ${verdict}\n`);
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, waitMs);
  });
}

console.log(`node ${process.version} on ${process.platform}\n`);

console.log("A) backgrounded orphan holds stdout, parent exits ('sleep 30 & exit 0'):");
await probe("orphan", "sleep 30 & exit 0");

console.log("B) foreground child holds stdout, never exits ('exec sleep 30'):");
await probe("foreground", "exec sleep 30");

console.log("C) clean command, no lingering child ('echo hi'):");
await probe("clean", "echo hi");

console.log("Done. (A) is the orphan/grandchild case that mirrors the Windows daemon-holds-pipe scenario.");
