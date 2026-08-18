import {
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detailFromCause, firstNonEmptyLine } from "./SourceControlProviderDiscovery.ts";
// ru-code[HEAVY]: hosting-provider discovery is disabled (see below); the registry is
// still wired elsewhere (GitManager / SourceControlRepositoryService) for PR ops.
// import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable?: string;
  readonly versionArgs?: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
};

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable?: string;
  readonly implemented: boolean;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  // ru-code[HEAVY]: Jujutsu is hidden from the UI (was a "coming soon" row) and no
  // `jj --version` probe runs. Restore this entry to bring it back.
  // {
  //   kind: "jj",
  //   label: "Jujutsu",
  //   executable: "jj",
  //   versionArgs: ["--version"],
  //   implemented: false,
  //   installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  // },
];

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  {
    readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
  }
>()("t3/sourceControl/SourceControlDiscovery") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  // ru-code[HEAVY]: registry lookup removed here — hosting-provider availability probes
  // (GitHub/GitLab/Azure/Bitbucket) are disabled. Restore the yield + the
  // `sourceControlProviders.discover` call below to re-enable.
  // const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const probe = <Kind extends VcsDriverKind>(
    input: DiscoveryProbe & { readonly kind: Kind },
  ): Effect.Effect<DiscoveryProbeResult<Kind>> => {
    const executable = input.executable;
    const versionArgs = input.versionArgs;

    if (!executable || !versionArgs) {
      return Effect.succeed({
        kind: input.kind,
        label: input.label,
        implemented: input.implemented,
        status: "missing" as const,
        version: Option.none<string>(),
        installHint: input.installHint,
        detail: Option.some(input.installHint),
      } satisfies DiscoveryProbeResult<Kind>);
    }

    return process
      .run({
        operation: "source-control.discovery.probe",
        command: executable,
        args: versionArgs,
        cwd: config.cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.map(
          (result) =>
            ({
              kind: input.kind,
              label: input.label,
              executable,
              implemented: input.implemented,
              status: "available" as const,
              version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
                firstNonEmptyLine(result.stderr),
              ),
              installHint: input.installHint,
              detail: Option.none<string>(),
            }) satisfies DiscoveryProbeResult<Kind>,
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: input.kind,
            label: input.label,
            executable,
            implemented: input.implemented,
            status: "missing" as const,
            version: Option.none<string>(),
            installHint: input.installHint,
            detail: detailFromCause(cause),
          } satisfies DiscoveryProbeResult<Kind>),
        ),
      );
  };

  return SourceControlDiscovery.of({
    discover: Effect.all({
      versionControlSystems: Effect.all(
        VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
        { concurrency: "unbounded" },
      ),
      // ru-code[HEAVY]: hosting providers disabled — empty list hides the UI section and
      // skips every gh/glab/az/Bitbucket probe. Restore `sourceControlProviders.discover`.
      sourceControlProviders: Effect.succeed(
        [] as SourceControlDiscoveryResult["sourceControlProviders"],
      ),
    }),
  });
});

export const layer = Layer.effect(SourceControlDiscovery, make);
