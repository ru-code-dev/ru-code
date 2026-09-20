// ru-code v2 (V2-33): the HOST's folder picker a plugin asked for through `ctx.pickFolder` — the
// app's command palette in one more mode, `folder`.
//
// THE DONOR IS THE PALETTE'S OWN "ADD PROJECT" BROWSE, not the Files tab (S21 analysis): the same
// `CommandPaletteContent` chrome, the same `buildBrowseGroups` rows, the same `filesystem.browse`
// RPC (folders only, `~` expanded, no root containment), the same input where the user types a path
// by hand, the same navigation rules — a row ENTERS the folder, Enter on the typed path picks it,
// ⌘/Ctrl+Enter picks it while a row is highlighted. What differs is the answer: instead of
// creating a project, the resolved ABSOLUTE path goes back to the plugin through the request store
// (`folderPicker.ts`), and every way of leaving without picking answers `null`.
//
// WHAT THE PLUGIN GETS AND DOES NOT GET. One string or `null`. The environment is chosen HERE — the
// primary one today, `usePrimaryEnvironmentId()`, which is also where `ctx.invoke` is pinned — so
// following the palette's `browseEnvironmentId` later is a change to this file, not to the SDK.
//
// `ProjectFilePicker.tsx` is the pattern for a mode composed from `CommandPaletteContent`; the
// browse plumbing is lifted from `CommandPalette.tsx`'s add-project flow, minus everything that is
// about projects (clone, WSL, "Create & Add", the native dialog).

import { useAtomValue } from "@effect/atom-react";
import { L } from "@ru-code/localization";
import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

import {
  browseInputEndPaddingClass,
  buildBrowseGroups,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
  type SearchOverlayMode,
} from "~/components/CommandPalette.logic";
import { CommandPaletteContent } from "~/components/CommandPaletteContent";
import { CommandPaletteResults } from "~/components/CommandPaletteResults";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
} from "~/lib/projectPaths";
import { isMacPlatform } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom } from "~/state/server";

import {
  readFolderPickRequest,
  registerFolderPickerHost,
  respondToFolderPick,
  subscribeFolderPick,
  type FolderPickRequest,
} from "./folderPicker";

/** The test id of the mode's chrome; the dialog itself carries `data-palette-mode="folder"`. */
export const FOLDER_PICKER_TEST_ID = "plugin-folder-picker";

const HOME_QUERY = "~/";

/** The dialog's accessible name in the `folder` mode — a fork string, so the dictionary is untouched. */
export const folderPickerAriaLabel = (): string => L("Folder picker", "Выбор папки");

/** `CommandPalette.tsx` `getEnvironmentBrowsePlatform` — the OS name as `navigator.platform` spells it. */
const browsePlatform = (os: string | null | undefined): string =>
  os === "windows" ? "Win32" : os === "darwin" ? "MacIntel" : "Linux";

/** The slice of the palette's reducer state the host gate reads. */
export interface FolderPickerPaletteState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
}

/**
 * May a pending `pickFolder` request take the palette NOW? (S33 A5)
 *
 * Only when the palette is CLOSED, or already showing the `folder` mode (a queued second request
 * re-opening the moment the first is answered). A user mid-query in ⌘K — a typed thread name, a
 * submenu, an add-project browse — keeps it: swapping the body would unmount
 * `OpenCommandPaletteDialog` and destroy that state, and Esc in `folder` mode closes rather than
 * falls back (V2-33), so there would be no way back. The request stays pending and the plugin's
 * promise untouched until the palette closes; then it opens.
 */
export const folderPickerMayOpen = (palette: FolderPickerPaletteState): boolean =>
  !palette.open || palette.mode === "folder";

/**
 * ONE line in `CommandPalette`: announce the host, and open the `folder` mode when a plugin asks
 * and the palette is free ({@link folderPickerMayOpen}).
 *
 * `openFolderMode` is the palette's own reducer action — a no-op while the mode is already showing,
 * so a queued second request (answered the moment the first is) re-opens rather than toggles.
 *
 * LEAVING the `folder` mode while a request is showing — Esc, the backdrop, ⌘P — is the user's
 * answer, and it is answered HERE, at the transition: the body's own unmount cleanup answers too,
 * but only after the dialog has closed, and by then this effect has already re-run on the close
 * and would have re-opened the picker for the request it was about to cancel. The body's answer
 * stays as the guard for the host going away; it is a no-op once the request is answered.
 */
export function usePluginFolderPickerHost(
  palette: FolderPickerPaletteState,
  openFolderMode: () => void,
): void {
  const request = useSyncExternalStore(
    subscribeFolderPick,
    readFolderPickRequest,
    readFolderPickRequest,
  );
  const { open, mode } = palette;
  /** The request the `folder` mode is showing right now, or `null`. */
  const showing = useRef<FolderPickRequest | null>(null);
  useEffect(() => registerFolderPickerHost(), []);
  useEffect(() => {
    if (open && mode === "folder") {
      showing.current = request;
      return;
    }
    const left = showing.current;
    showing.current = null;
    if (left !== null && readFolderPickRequest() === left) respondToFolderPick(null);
    // Read the store, not `request`: the answer above may just have promoted a queued request.
    if (readFolderPickRequest() !== null && folderPickerMayOpen({ open, mode })) openFolderMode();
  }, [mode, open, openFolderMode, request]);
}

/** The body of the `folder` mode. Mounted by the palette dialog while `mode === "folder"`. */
export function FolderPickerPalette(props: { readonly setOpen: (open: boolean) => void }) {
  const request = useSyncExternalStore(
    subscribeFolderPick,
    readFolderPickRequest,
    readFolderPickRequest,
  );
  if (request === null) {
    // The mode outlived its request (the plugin's host cleanup answered it): nothing to show, and
    // nothing to answer — the palette closes on the next Esc like any other mode.
    return (
      <CommandPaletteContent
        aria-label={folderPickerAriaLabel()}
        escapeLabel={L("Cancel", "Отмена")}
        inputProps={{ disabled: true, placeholder: HOME_QUERY }}
        mode="none"
        testId={FOLDER_PICKER_TEST_ID}
        value=""
      >
        <div className="py-10 text-center text-sm text-muted-foreground">
          {L("Nothing to pick right now.", "Сейчас нечего выбирать.")}
        </div>
      </CommandPaletteContent>
    );
  }
  return (
    <OpenFolderPicker
      key={request.pluginId + (request.start ?? "")}
      request={request}
      setOpen={props.setOpen}
    />
  );
}

function OpenFolderPicker(props: {
  readonly request: FolderPickRequest;
  readonly setOpen: (open: boolean) => void;
}) {
  const { request, setOpen } = props;
  const environmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const platform = browsePlatform(
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.platform.os,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  // The plugin's `start` is a HINT: a path the app cannot browse opens home instead (SDK contract).
  // A start that is not even a browsable path shape falls back before the first request; one the
  // server refuses falls back on its answer (below).
  const startQuery =
    request.start !== undefined && isFilesystemBrowseQuery(request.start, platform)
      ? ensureBrowseDirectoryPath(request.start)
      : HOME_QUERY;
  const [query, setQuery] = useState(startQuery);
  const [fromStart, setFromStart] = useState(startQuery !== HOME_QUERY);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);

  const browsePath = useMemo(() => getFilesystemBrowsePath(query, platform), [platform, query]);
  const browseQuery = useEnvironmentQuery(
    browsePath.isBrowsing && browsePath.directoryPath.length > 0 && environmentId !== null
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const browseResult = browseQuery.data;
  useEffect(() => {
    if (fromStart && browseQuery.error !== null) {
      setFromStart(false);
      setQuery(HOME_QUERY);
    }
  }, [browseQuery.error, fromStart]);

  const { visibleEntries, exactEntry } = useMemo(
    () => filterFilesystemBrowseEntries(browseResult?.entries ?? [], browsePath.filterQuery),
    [browsePath.filterQuery, browseResult],
  );

  // Answer ONCE. The request this body shows is answered by the pick, or — if the body goes away
  // first (Esc, the backdrop, another mode's shortcut, the dialog closing) — with `null` on the
  // way out, unless something else already answered it (the host cleanup, a queued request).
  const answered = useRef(false);
  const answer = useCallback(
    (path: string | null) => {
      if (answered.current) return;
      answered.current = true;
      if (readFolderPickRequest() === request) respondToFolderPick(path);
    },
    [request],
  );
  useEffect(() => () => answer(null), [answer]);

  const navigate = useCallback((nextQuery: string) => {
    setFromStart(false);
    setHighlightedItemValue(null);
    setQuery(nextQuery);
  }, []);
  const browseTo = useCallback(
    (name: string) => navigate(appendBrowsePathSegment(query, name)),
    [navigate, query],
  );
  const browseUp = useCallback(() => {
    if (browsePath.parentPath !== null) navigate(ensureBrowseDirectoryPath(browsePath.parentPath));
  }, [browsePath.parentPath, navigate]);

  const groups = useMemo(
    () =>
      browsePath.isBrowsing
        ? buildBrowseGroups({
            browseEntries: visibleEntries,
            browseQuery: query,
            canBrowseUp: browsePath.canBrowseUp,
            upIcon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
            directoryIcon: <FolderIcon className={ITEM_ICON_CLASS} />,
            browseUp,
            browseTo,
          })
        : [],
    [browsePath.canBrowseUp, browsePath.isBrowsing, browseTo, browseUp, query, visibleEntries],
  );

  // The add-project rule, minus "create it": a trailing separator names the directory itself (the
  // server's `parentPath` is its ABSOLUTE form, `~` expanded), otherwise the typed leaf must be an
  // entry the server listed. A folder that does not exist is not pickable.
  const resolvedPath = hasTrailingPathSeparator(query)
    ? (browseResult?.parentPath ?? null)
    : (exactEntry?.fullPath ?? null);
  const hasHighlightedBrowseItem = highlightedItemValue?.startsWith("browse:") ?? false;
  const canPick = browsePath.isBrowsing && !browseQuery.isPending && resolvedPath !== null;
  const useMetaForMod = isMacPlatform(navigator.platform);
  const pickShortcut = hasHighlightedBrowseItem ? `${useMetaForMod ? "⌘" : "Ctrl"} Enter` : "Enter";
  const pickLabel = L("Add folder", "Добавить папку");

  const pick = (): void => {
    if (!canPick || resolvedPath === null) return;
    answer(resolvedPath);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    const primary = useMetaForMod
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (hasHighlightedBrowseItem && !primary) return; // the row's own Enter — it enters the folder
    event.preventDefault();
    pick();
  };

  const emptyStateMessage = !browsePath.isBrowsing
    ? L(
        "Type an absolute path, or ~/ for your home folder.",
        "Введите абсолютный путь или ~/ для домашней папки.",
      )
    : browseQuery.error !== null
      ? browseQuery.error
      : browseQuery.isPending
        ? L("Reading folders…", "Читаю папки…")
        : L("No folders inside.", "Внутри нет папок.");

  return (
    <CommandPaletteContent
      key={browsePath.directoryPath}
      aria-label={folderPickerAriaLabel()}
      autoHighlight={false}
      escapeLabel={L("Cancel", "Отмена")}
      footerActionLabel={hasHighlightedBrowseItem ? L("Open", "Открыть") : undefined}
      inputAccessory={
        <Button
          variant="outline"
          size="xs"
          tabIndex={-1}
          className="absolute inset-e-2.5 top-1/2 -translate-y-1/2 gap-1.5 pe-1 ps-2"
          aria-label={`${pickLabel} (${pickShortcut})`}
          data-testid="plugin-folder-picker-add"
          disabled={!canPick}
          onMouseDown={(event) => event.preventDefault()}
          onClick={pick}
        >
          <span>{pickLabel}</span>
          <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
            <Kbd>{pickShortcut}</Kbd>
          </KbdGroup>
        </Button>
      }
      inputProps={{
        className: browseInputEndPaddingClass({
          willCreateProjectPath: true,
          hasHighlightedBrowseItem,
        }),
        placeholder: L(
          "Enter a folder path (e.g. ~/projects)",
          "Введите путь к папке (например, ~/projects)",
        ),
        startAddon: <FolderIcon />,
        onKeyDown,
      }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setFromStart(false);
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelClassName="max-h-[min(28rem,70vh)]"
      testId={FOLDER_PICKER_TEST_ID}
      value={query}
    >
      <CommandPaletteResults
        groups={groups}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => {
          // Every row here is a `keepOpen` navigation: entering a folder never picks it.
          if (item.kind === "action") void item.run();
        }}
        emptyStateMessage={emptyStateMessage}
      />
    </CommandPaletteContent>
  );
}
