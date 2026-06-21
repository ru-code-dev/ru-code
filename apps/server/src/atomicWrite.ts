import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  // ru-fork: optional owner-only perms for secret-bearing files (e.g. the MCP
  // overlay). Omitted ⇒ the process umask default (unchanged behaviour).
  readonly mode?: number;
  readonly dirMode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      if (input.dirMode !== undefined) {
        yield* fs.chmod(targetDirectory, input.dirMode);
      }
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (input.mode !== undefined) {
        yield* fs.chmod(tempPath, input.mode);
      }
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
