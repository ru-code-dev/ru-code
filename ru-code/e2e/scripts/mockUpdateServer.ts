// ru-code: e2e harness — the mock WEB update source (auto-update CASE 2/1 specs).
//
// A dependency-free (node builtins only) control-file-driven HTTP server that
// mirrors the fixture server in
// apps/server/src/ru-code/tests/auto-update/updateEngineLive.test.ts. It serves:
//   · GET /manifest.json  — behaviour switched by MOCK_UPDATE_CONTROL_FILE `mode`:
//       "release"      → 200 a v2 manifest (version/sha256/minNode/sizeBytes)
//       "notfound"     → 404 (an answered http-404 fail; source is NOT paused)
//       "unauthorized" → 401 (answered auth fail; two of these pause the source)
//       "invalid"      → 200 with a non-JSON body (answered invalid-manifest fail)
//       "gonetarball"  → 200 the SAME valid manifest, but the tarball route 404s: the check
//                        succeeds and the PRESS fails mid-run — the live-repro shape
//                        (a manifest pointing at a file that is not there)
//   · GET /changelog.json — 404 (best-effort sibling; its absence is not an error)
//   · GET /<app>-<version>.tgz — the prebuilt tarball bytes (cli.js + __checksums.json)
//
// It is NOT the desktop static server (scripts/mock-update-server.ts): that one
// serves a fixed directory for the desktop-artifact tests and has no per-request
// control or 401/counter. This harness server is switched per-spec by rewriting
// the control file (the same idiom as the fake-ACP control file) and records a
// monotonic request counter into MOCK_UPDATE_REQUESTS_FILE so a spec can assert
// "a paused source made zero requests". Binds port 0 and writes the chosen port
// to MOCK_UPDATE_PORT_FILE so bootApp can wire RU_CODE_UPDATE_WEB_URL first.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { releaseTarballName } from "../../branding/src/index.ts";

const controlFile = process.env["MOCK_UPDATE_CONTROL_FILE"] ?? "";
const requestsFile = process.env["MOCK_UPDATE_REQUESTS_FILE"] ?? "";
const portFile = process.env["MOCK_UPDATE_PORT_FILE"] ?? "";
const tarballFile = process.env["MOCK_UPDATE_TARBALL_FILE"] ?? "";

type Mode = "release" | "notfound" | "unauthorized" | "invalid" | "gonetarball";

interface Control {
  readonly mode: Mode;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly minNode: string;
}

const DEFAULT_CONTROL: Control = {
  mode: "notfound",
  version: "999.0.0",
  sha256: "",
  sizeBytes: 0,
  minNode: ">=18",
};

function readControl(): Control {
  try {
    const raw = JSON.parse(NodeFS.readFileSync(controlFile, "utf8")) as Partial<Control>;
    return { ...DEFAULT_CONTROL, ...raw };
  } catch {
    return DEFAULT_CONTROL;
  }
}

let requestCount = 0;
function record(path: string): void {
  requestCount += 1;
  try {
    NodeFS.writeFileSync(requestsFile, JSON.stringify({ count: requestCount, last: path }));
  } catch {
    // best-effort — the counter is a test convenience, never load-bearing for the app
  }
}

const server = NodeHttp.createServer((req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?", 1)[0] ?? "/";
  record(path);
  const control = readControl();

  if (path.startsWith("/manifest.json")) {
    if (control.mode === "notfound") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (control.mode === "unauthorized") {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Basic realm="mock"');
      res.end("unauthorized");
      return;
    }
    if (control.mode === "invalid") {
      res.setHeader("content-type", "application/json");
      res.end("}{ this is not json");
      return;
    }
    // release / gonetarball — the manifest itself is identical and valid; only the
    // tarball route differs, so the CHECK succeeds and the PRESS is what fails.
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        version: control.version,
        sha256: control.sha256,
        minNode: control.minNode,
        sizeBytes: control.sizeBytes,
        releasedAt: null,
      }),
    );
    return;
  }

  if (path.startsWith("/changelog.json")) {
    res.statusCode = 404;
    res.end("no changelog");
    return;
  }

  // The manifest has no address — the app derives `<manifest dir>/<releaseTarballName(version)>`.
  if (path.startsWith(`/${releaseTarballName(control.version)}`)) {
    if (control.mode === "gonetarball") {
      res.statusCode = 404;
      res.end("no tarball here");
      return;
    }
    try {
      const buffer = NodeFS.readFileSync(tarballFile);
      res.setHeader("content-type", "application/gzip");
      res.setHeader("content-length", buffer.byteLength);
      res.end(buffer);
    } catch {
      res.statusCode = 500;
      res.end("tarball unavailable");
    }
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  NodeFS.writeFileSync(portFile, String(port));
});
