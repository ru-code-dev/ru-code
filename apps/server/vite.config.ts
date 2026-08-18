import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import { ruCodeLocalizationPlugin } from "@ru-code/localization/build"; // ru-code: bilingual build transform
import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import packageJson from "./package.json" with { type: "json" };

// The bundle used to inline only workspace packages, leaving every third-party
// runtime dep external. External deps must exist on the real filesystem (the WSL
// backend runs plain `wsl.exe -- node`, which cannot read inside an asar), so the
// desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to
// support 20 native binaries. NSIS install time tracks file count, not bytes.
//
// Inverted here — bundle everything except the packages that genuinely cannot be
// inlined. See scripts/lib/cli-external-packages.ts for what earns an exemption.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

// ru-code: the ONLY deps that cannot be inlined into cli.js — native N-API
// modules (they load a platform `.node`) plus the Bun runtime builtins. In the
// release bundle everything else (effect, provider SDKs, shiki, react-dom, …) is
// bundled INTO cli.js; these ship as prebuilt node_modules (see prepare-release).
const RELEASE_NATIVE_PACKAGES = [
  "node-pty",
  "@ff-labs/fff-node",
  "ffi-rs",
  "msgpackr-extract",
  "bufferutil",
  "utf-8-validate",
];

export function isReleaseExternal(id: string): boolean {
  if (id === "bun" || id.startsWith("bun:")) return true;
  return RELEASE_NATIVE_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`));
}

// External matchers for the release bundle: the natives (+ subpaths) and Bun
// builtins. Everything else is force-bundled via alwaysBundle.
const RELEASE_NEVER_BUNDLE: RegExp[] = [
  /^bun(:|$)/,
  ...RELEASE_NATIVE_PACKAGES.map(
    (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`),
  ),
];

// prepare-release sets RU_CODE_RELEASE_BUNDLE=1 → self-contained cli.js: bundle
// every JS dep, externalize only the natives + Bun builtins. Default build keeps
// the normal (thin) externalization for dev / desktop / npx.
const releaseBundle = process.env.RU_CODE_RELEASE_BUNDLE === "1";

// Release: bundle EVERY JS dep into cli.js (alwaysBundle everything that is not a
// native / Bun builtin); the natives stay external and ship as prebuilt
// node_modules (see prepare-release). Default: thin externalization for dev /
// desktop / npx. Same `deps` shape vite-plus honors in both branches.
const packDeps = releaseBundle
  ? { alwaysBundle: /[\s\S]/, neverBundle: RELEASE_NEVER_BUNDLE, onlyBundle: false as const }
  : { alwaysBundle: shouldBundleCliDependency, onlyBundle: false as const };

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";

export default mergeConfig(
  baseConfig,
  defineConfig({
    // ru-code: inject Russian translations into server display strings at build time.
    plugins: [ruCodeLocalizationPlugin()],
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      // ru-code: the top-level Vite `plugins` above only runs under Vite (the web build).
      // `vp pack` bundles the server via tsdown/rolldown, which reads its plugins from
      // THIS pack config — so the localization transform must be wired here too, or every
      // server-side display string ships English. See ru-code/localization/build/verifyBuild.mjs
      // for the gate that fails the build if any translation is missing from the bundle.
      plugins: [ruCodeLocalizationPlugin()],
      deps: {
        // Both halves are required. `alwaysBundle` forces the JS dependencies in
        // (declared deps are external by default, which is what this change is
        // undoing). `neverBundle` forces the native packages out: returning
        // false from `alwaysBundle` only means "no opinion", so a transitive
        // dependency would still be bundled — which silently inlined
        // msgpackr-extract and its loader, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
