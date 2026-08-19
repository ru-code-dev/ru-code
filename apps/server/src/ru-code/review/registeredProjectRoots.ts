/**
 * ru-code: the fork's multi-project model lets a project live at ANY path,
 * while the port's ReviewService guard only trusts cwds under the server's
 * single workspace root / worktrees dir (the one-workspace t3 world). Every
 * externally-located project therefore lost the diff panel: the guard
 * rejected its cwd. A cwd inside a REGISTERED project root is exactly as
 * trusted as the workspace root — the same registry the ACP session spawn
 * already works from.
 *
 * The ProjectionSnapshotQuery dependency is OPTIONAL (`Effect.serviceOption`):
 * without it (upstream tests, minimal harnesses) the check degrades to the
 * port's original behavior — fail closed, reject. Query failures also fail
 * closed.
 *
 * @module ru-code/review/registeredProjectRoots
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface RegisteredProjectRootCheckDeps<CanonicalizeError> {
  /** ReviewService's own canonicalizer (realPath with NotFound tolerance). */
  readonly canonicalizePath: (value: string) => Effect.Effect<string, CanonicalizeError>;
  /** ReviewService's own containment test. */
  readonly isWithinRoot: (candidate: string, root: string) => boolean;
}

/**
 * Build the check inside ReviewService's `make`. The returned function takes
 * the ALREADY-canonicalized candidate cwd and answers whether it lies within
 * any registered project's workspace root.
 */
export const makeIsCwdWithinRegisteredProjectRoot = <CanonicalizeError>(
  deps: RegisteredProjectRootCheckDeps<CanonicalizeError>,
) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);

    return (canonicalCandidate: string): Effect.Effect<boolean> =>
      Option.match(snapshotQuery, {
        onNone: () => Effect.succeed(false),
        onSome: (query) =>
          query.getShellSnapshot().pipe(
            Effect.flatMap((snapshot) =>
              Effect.gen(function* () {
                for (const project of snapshot.projects) {
                  const projectRoot = yield* deps
                    .canonicalizePath(project.workspaceRoot)
                    .pipe(Effect.orElseSucceed(() => null));
                  if (projectRoot !== null && deps.isWithinRoot(canonicalCandidate, projectRoot)) {
                    return true;
                  }
                }
                return false;
              }),
            ),
            Effect.orElseSucceed(() => false),
          ),
      });
  });
