// @effect-diagnostics nodeBuiltinImport:off -- a gate that shells out to a generator script, not runtime code
// ru-code v2 (v1 finding H1): the OTHER half of the theme guard.
//
// `@smart-tools/plugin-sdk/tailwind/theme.css` is a copy of this app's `@theme inline` block, and
// it lives in a different repository — so v1 kept the two in sync with a comment and no test
// anywhere, and a token renamed here silently broke every plugin's colours. The copy is generated
// now (`apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs`) and the SDK's own test refuses a hand-edit of it;
// this test is the half only the APP can run: does the generated file still describe the block
// `src/index.css` has TODAY.
//
// It runs the generator's own `--check` mode rather than re-implementing the extraction, so there
// is exactly one definition of "the block" and this test cannot drift from the writer.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const WEB_ROOT = NodePath.resolve(import.meta.dirname, "../../../..");
const SCRIPT = NodePath.join(WEB_ROOT, "src/ru-code/plugins/scripts/gen-plugin-theme.mjs");

describe("plugin SDK tailwind theme", () => {
  it("is in sync with this app's `@theme inline` block", () => {
    let output = "";
    try {
      output = NodeChildProcess.execFileSync(process.execPath, [SCRIPT, "--check"], {
        encoding: "utf8",
      });
    } catch (error) {
      const failure = error as { readonly stderr?: string; readonly stdout?: string };
      throw new Error(
        "The plugin SDK's tailwind/theme.css no longer matches apps/web/src/index.css.\n" +
          "Run `node apps/web/src/ru-code/plugins/scripts/gen-plugin-theme.mjs` and commit the SDK file.\n" +
          `${failure.stderr ?? ""}${failure.stdout ?? ""}`,
        { cause: error },
      );
    }
    expect(output).toContain("up to date");
  });
});
