// ru-code: auto-update FEATURE — the release fixture server.
//
// A real local HTTP host that serves a real manifest and a real tarball, so the web update source
// under test is exercised end to end rather than stubbed. Its `requests` log is what lets a spec
// assert the NEGATIVE ("zero tarball requests when the release is refused"), which is usually the
// more valuable half.
//
// It also proves the address derivation: the manifest carries NO url, so the server answers on
// `releaseTarballName(version)` — if the app ever derived a different name, every install spec
// would 404 here.
//
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeHttp from "node:http";

import { releaseTarballName } from "../../../branding/src/index.ts";

import { type Prepared, VERSION_B } from "../../harness/artifacts.ts";
import { cleanups } from "../../harness/primitives.ts";

// ── fixture release server ───────────────────────────────────────────────────────────────────
export interface FixtureState {
  base: string;
  version: string;
  sha: string;
  minNode: string;
  tarball: Buffer;
  readonly requests: Array<string>;
}
export interface Fixture {
  readonly url: string;
  readonly state: FixtureState;
  readonly close: () => Promise<void>;
}
export function startFixture(state: FixtureState): Promise<Fixture> {
  return new Promise((resolve) => {
    const server = NodeHttp.createServer((req, res) => {
      const url = req.url ?? "";
      state.requests.push(url);
      if (url.startsWith("/manifest.json")) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            version: state.version,
            sha256: state.sha,
            minNode: state.minNode,
            sizeBytes: state.tarball.byteLength,
            releasedAt: null,
          }),
        );
        return;
      }
      // The manifest carries NO address: the app asks for the sibling named by the shared
      // `releaseTarballName` convention. Serving that exact name is what proves the derivation.
      if (url.startsWith(`/${releaseTarballName(state.version)}`)) {
        res.setHeader("content-length", state.tarball.byteLength);
        res.end(state.tarball);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const url = `http://127.0.0.1:${String(port)}`;
      state.base = url;
      const close = (): Promise<void> => new Promise((done) => server.close(() => done()));
      cleanups.push(close);
      resolve({ url, state, close });
    });
  });
}
export const freshFixtureState = (prepared: Prepared): FixtureState => ({
  base: "",
  version: VERSION_B,
  sha: prepared.cleanSha,
  minNode: ">=18",
  tarball: prepared.cleanTarball,
  requests: [],
});
