#!/usr/bin/env node
// ru-code: the release build's door into the app's own install-layout module.
//
// `scripts/prepare-release.ts` must ship a bundle that IS an installed `bin/` tree, but it lives in
// a different TS project and cannot import `apps/server/src/**` (composite projects reject the deep
// import). So it shells out to this tiny CLI instead, and the layout stays defined in exactly ONE
// place — `../src/ru-code/auto-update/wrapper/installLayout.ts`.
//
//   node scripts/emitBundleLayout.ts paths                  → {"wrapper","pointer","versionsDir","entry"}
//   node scripts/emitBundleLayout.ts write <bundleRoot> <version>
//                                                           → writes the wrapper + pointer there
//
// `write` assumes the payload is already staged at <bundleRoot>/<versionsDir>/<version>/.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { layoutNames, writeLauncher } from "../src/ru-code/auto-update/wrapper/installLayout.ts";

const [mode, bundleRoot, version] = process.argv.slice(2);

const usage: () => never = () => {
  process.stderr.write(
    "usage: emitBundleLayout.ts paths | emitBundleLayout.ts write <bundleRoot> <version>\n",
  );
  process.exit(2);
};

if (mode === "paths") {
  process.stdout.write(`${JSON.stringify(layoutNames)}\n`);
} else if (mode === "write") {
  if (bundleRoot === undefined || version === undefined) usage();
  const target = version;
  await Effect.runPromise(
    writeLauncher({ appRoot: bundleRoot, version: target }).pipe(
      Effect.tap((wrapperPath) =>
        Effect.sync(() => {
          process.stdout.write(
            `[emitBundleLayout] ${wrapperPath} + ${layoutNames.pointer} -> ` +
              `${layoutNames.versionsDir}/${target}/${layoutNames.entry}\n`,
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
} else {
  usage();
}
