/**
 * ru-code (V2-21, V2-43): the operator's opt-out list — `<stateDir>/plugins/disabled.json`.
 *
 * WHY it exists. A user plugin is switched off by deleting its folder. A SHIPPED plugin cannot be:
 * it lives inside the version payload, so deleting it breaks `__checksums.json` and it comes back
 * with the next install or update anyway — correctly, because the shipped set is the app's, not the
 * user's. There still has to be a supported way to say "not this one".
 *
 * WHY HERE. `<stateDir>` is written by NEITHER release channel — the installer only deletes
 * `<APP_ROOT>/bin`, the updater only touches `versions/`, `updates/` and `current.json` — so an
 * opt-out recorded here survives every install, every update and every rollback by construction,
 * which is exactly the property the shipped set needs and a marker file inside the plugin folder
 * (it dies with the version) or a CLI flag (a new surface, and useless before the first boot)
 * cannot give. One shared file rather than one marker per plugin (D-d): the question an operator
 * asks is "what is switched off here", and that answer should be one `cat`.
 *
 * It applies to BOTH roots. A user plugin is far easier to disable by deleting it, but a list that
 * silently ignored half the plugins would be a worse surface than no list at all.
 *
 * V2-43 — IT SWITCHES ON AS WELL AS OFF. A manifest may ship a plugin disabled (`"enabled": false`),
 * so the file needs a way to say "yes, this one" and not only "no, not this one". The shape grew a
 * second, optional array rather than changing the first: `{ "disabled": [...], "enabled": [...] }`,
 * so every file V2-21 ever wrote is still valid and still means exactly what it meant. The
 * Settings ▸ Plugins switch writes ONE entry per id — turning a plugin off puts it in `disabled`
 * and takes it out of `enabled`, and vice versa — so the two lists cannot disagree unless the file
 * was hand-edited. If they do, `disabled` wins and the host says so: "off" is the only reading of
 * an ambiguous file that cannot run code somebody asked it not to.
 *
 * FAILURE POSTURE. Missing, unreadable, not JSON, wrong shape ⇒ the EMPTY set. Never a throw and
 * never a partial guess: this file is hand-edited, and a typo in it must not be able to take the
 * app down or — worse — disable something the operator did not name. "Nothing is disabled" is the
 * only safe reading of a file we cannot understand, and the operator is told in the log.
 *
 * @module ru-code/plugins/disabled
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import { PLUGINS_DIR_NAME } from "./paths.ts";

/** The file name, under `<stateDir>/plugins/`. */
export const DISABLED_PLUGINS_FILENAME = "disabled.json";

/**
 * What a disabled plugin's status row says.
 *
 * Deliberately plain and deliberately not a path: `PluginStatus.error` is served by
 * `GET /plugins/manifests.json` unauthenticated (A12 finding R1-M2), and this is the one skip
 * reason that is not a fault at all — the web loader renders it in a toast, so it reads as an
 * answer rather than as an accusation.
 */
export const DISABLED_BY_OPERATOR = "disabled by the operator";

/** What a manifest-disabled plugin's status row says (V2-43). Same posture: an answer, not a fault. */
export const DISABLED_BY_MANIFEST = "disabled by the manifest";

/**
 * `{ "disabled": ["analytics"], "enabled": ["project-settings"] }`.
 *
 * Ids are plain strings, NOT `PluginId`: a single typo'd entry must cost that entry, not the whole
 * file. An id that matches no folder is simply inert. `enabled` is OPTIONAL so that every file
 * written before V2-43 still decodes and still means what it meant.
 */
const DisabledPluginsFile = Schema.Struct({
  disabled: Schema.Array(Schema.String),
  enabled: Schema.optional(Schema.Array(Schema.String)),
});

const decodeDisabledPluginsFile = Schema.decodeUnknownExit(
  Schema.fromJsonString(DisabledPluginsFile),
);

/** `<stateDir>/plugins/disabled.json`. */
export const disabledPluginsPath: Effect.Effect<
  string,
  never,
  ServerConfig.ServerConfig | Path.Path
> = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(serverConfig.stateDir, PLUGINS_DIR_NAME, DISABLED_PLUGINS_FILENAME);
});

/** What the file says, as two sets. Both empty when there is no file, or none that can be read. */
export interface PluginEnablementFile {
  /** Ids the user switched OFF. Beats everything, including an explicit `enabled` entry. */
  readonly disabled: ReadonlySet<string>;
  /** Ids the user switched ON, which beats a manifest that ships the plugin off (V2-43). */
  readonly enabled: ReadonlySet<string>;
}

const EMPTY_ENABLEMENT: PluginEnablementFile = Object.freeze({
  disabled: new Set<string>(),
  enabled: new Set<string>(),
});

/** Trimmed, blanks dropped — the file is hand-edited and a trailing space is not a different id. */
const idSet = (ids: ReadonlyArray<string> | undefined): ReadonlySet<string> =>
  new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));

/**
 * What the user has said about each plugin. Empty when there is no list, or none that can be read.
 *
 * Nothing is normalised beyond trimming: `PLUGIN_ID_PATTERN` is lowercase-only, so an entry that
 * differs in case is a different string and matches nothing, which is the honest answer.
 */
export const readPluginEnablement: Effect.Effect<
  PluginEnablementFile,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* disabledPluginsPath;

  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  // No file is the overwhelmingly common case and is not worth a log line: nothing was decided.
  if (raw === null) return EMPTY_ENABLEMENT;

  const decoded = decodeDisabledPluginsFile(raw);
  if (decoded._tag === "Failure") {
    yield* Effect.logWarning("ru-code plugins: disabled.json could not be read, ignoring it", {
      file,
    });
    return EMPTY_ENABLEMENT;
  }

  const disabled = idSet(decoded.value.disabled);
  const enabled = idSet(decoded.value.enabled);
  if (disabled.size > 0 || enabled.size > 0) {
    yield* Effect.logInfo("ru-code plugins: the user's own switches", {
      file,
      disabled: [...disabled],
      enabled: [...enabled],
    });
  }
  const both = [...enabled].filter((id) => disabled.has(id));
  if (both.length > 0) {
    yield* Effect.logWarning(
      "ru-code plugins: disabled.json lists the same id as both disabled and enabled; disabled wins",
      { file, ids: both },
    );
  }
  return { disabled, enabled };
}).pipe(Effect.withSpan("plugins.readPluginEnablement"));

/** The ids the operator switched off — the V2-21 reader, kept for callers that only ask that. */
export const readDisabledPlugins: Effect.Effect<
  ReadonlySet<string>,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> = readPluginEnablement.pipe(Effect.map((file) => file.disabled));

/**
 * May this plugin run, and if not, what does its row say? `null` means it runs (V2-43).
 *
 * The whole resolution order, as one pure function, in the order a user would state it:
 *  1. they switched it OFF — off, whatever the manifest says;
 *  2. they switched it ON — on, even if the manifest ships it off;
 *  3. neither — the manifest decides, and its default is on.
 */
export const pluginSkipReason = (
  file: PluginEnablementFile,
  id: string,
  enabledByManifest: boolean,
): string | null => {
  if (file.disabled.has(id)) return DISABLED_BY_OPERATOR;
  if (file.enabled.has(id)) return null;
  return enabledByManifest ? null : DISABLED_BY_MANIFEST;
};

/**
 * One switch, applied to what the file says. PURE — the whole write rule, testable without a disk.
 *
 * ONE ENTRY PER ID, in exactly one list: turning a plugin off puts its id in `disabled` and takes it
 * out of `enabled`, turning it on does the reverse. That is what makes "last writer wins" true for
 * rapid toggles (the file is rewritten whole, atomically) and what keeps the two lists from ever
 * disagreeing unless a human edits the file by hand.
 */
export const applyPluginSwitch = (
  file: PluginEnablementFile,
  id: string,
  enabled: boolean,
): PluginEnablementFile => {
  const disabled = new Set(file.disabled);
  const enabledIds = new Set(file.enabled);
  disabled.delete(id);
  enabledIds.delete(id);
  if (enabled) enabledIds.add(id);
  else disabled.add(id);
  return { disabled, enabled: enabledIds };
};

/** The file's JSON body, ids sorted so two equal states are the same bytes. */
const enablementJson = (file: PluginEnablementFile): string =>
  `${JSON.stringify({ disabled: [...file.disabled].toSorted(), enabled: [...file.enabled].toSorted() }, null, 2)}\n`;

/**
 * THE single writer of `disabled.json`, owned by this module — the only module that writes it.
 *
 * An atomic write makes a READER safe; it does nothing for two WRITERS. `writePluginSwitch` is a
 * read-modify-write over the whole file, and the Settings page puts two of them on the wire at
 * once by design: it disables only the row it is waiting on (`busyId` is a single slot), so a user
 * who flips a second plugin before the first answer comes back has two `plugin.setEnabled` calls
 * in flight. Unsynchronised, the second read the state from BEFORE the first write and its write
 * erased the first user's switch — measured, alpha+beta together left only `"beta"` in the file
 * and `alpha` read back as still on (S40 F1).
 *
 * One permit, taken around the READ and the WRITE together, so the switches apply in arrival order
 * and each one reads the file the previous one left. `makeUnsafe` rather than `Semaphore.make`
 * because the mutex is a property of the FILE, which is a module-level fact here — the file path
 * is derived per call from `ServerConfig` and nothing else in this module holds state, so there is
 * no layer to hang it on and one process must have exactly one of these.
 */
const switchWriteLock = Semaphore.makeUnsafe(1);

/**
 * Record the user's switch for one plugin, and answer with what the file says afterwards.
 *
 * ATOMIC (`writeFileStringAtomically`: a temp file in the same directory, then a rename), so a
 * reader — this process's next boot, or a human with `cat` — can never see half a file however fast
 * the switches are flipped. Read-modify-write, so a hand-edited entry for ANOTHER plugin survives —
 * and SERIALISED behind {@link switchWriteLock}, so the read and the write are one critical section
 * and a second switch in flight cannot build its write on state the first has already replaced.
 * "Last writer wins" still holds for the same id; it is now the last writer in ARRIVAL order.
 */
export const writePluginSwitch = (
  id: string,
  enabled: boolean,
): Effect.Effect<
  PluginEnablementFile,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> =>
  switchWriteLock
    .withPermits(1)(
      Effect.gen(function* () {
        const file = yield* disabledPluginsPath;
        const next = applyPluginSwitch(yield* readPluginEnablement, id, enabled);
        yield* writeFileStringAtomically({ filePath: file, contents: enablementJson(next) }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("ru-code plugins: could not write disabled.json", { file, cause }),
          ),
        );
        yield* Effect.logInfo("ru-code plugins: switch recorded", { file, id, enabled });
        return next;
      }),
    )
    .pipe(Effect.withSpan("plugins.writePluginSwitch"));
