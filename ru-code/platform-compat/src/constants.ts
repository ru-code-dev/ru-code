// ru-code: EVERY Windows compatibility switch lives in THIS file — one place to audit, one
// place to flip while testing which strategy works best on a given machine (different Windows
// versions and configurations behave differently). Each constant controls exactly one seam
// (grep the constant name to find it). Background: `.ps1` script files do not run on every
// setup, high-frequency non-interactive PowerShell spawning is heavy and setup-dependent, and
// Node bug #51018 breaks `powershell` spawned with `detached: true` +
// `stdio: "ignore"`. The defaults below are the most compatible behaviours; every legacy
// behaviour stays reachable by flipping the constant back.

/**
 * How the server opens a URL in the default browser on Windows (and Windows-from-WSL).
 * - `"explorer"` (default): `explorer.exe <url>` — no PowerShell, immune to Node #51018.
 * - `"powershell"`: legacy `powershell.exe -EncodedCommand Start …` with detached+ignore
 *   stdio — BROKEN on Windows by Node #51018 (`spawn UNKNOWN`); kept for comparison only.
 */
export const EXTERNAL_OPEN_WINDOWS: "explorer" | "powershell" = "explorer";

/**
 * How the preview port scanner enumerates listening ports on Windows (only relevant when
 * the user enables port scanning in Settings — it is OFF by default on every platform).
 * - `"node"` (default): pure-Node loopback probes of common dev ports — zero child processes.
 * - `"powershell"`: legacy `powershell.exe -Command Get-NetTCPConnection …` every poll tick —
 *   heavier and more setup-dependent; kept for strategy comparison.
 */
export const PORT_SCAN_WINDOWS_METHOD: "node" | "powershell" = "node";

/**
 * Terminal UI visibility (web; pure UI gating of button/shortcut/drawer — zero server code
 * disabled, flipping back restores everything).
 * - `"all"`: terminal UI on every platform (upstream behaviour).
 * - `"hide-windows"`: hide every terminal trigger when the SERVER runs on Windows.
 * - `"hidden"`: hide on EVERY platform — previews exactly what a Windows user sees with the
 *   terminal disabled, testable from any dev machine.
 *
 * The shipped value is set at release time and is whatever the declaration below says — this
 * comment describes the options only and never states which one is in force.
 */
export const TERMINAL_UI_VISIBILITY: "all" | "hide-windows" | "hidden" = "hide-windows";

/**
 * Which shell the Windows terminal prefers. The chosen shell becomes the FIRST spawn
 * candidate; the remaining ones stay as fallbacks (see TERMINAL_SHELL_FALLBACK_ANY_ERROR).
 * - `"powershell"` (upstream default): `powershell.exe -NoLogo` (pwsh.exe first if present).
 * - `"cmd"`: `%ComSpec%` / `cmd.exe`.
 * - `"git-bash"`: Git-for-Windows `bash.exe` (standard install paths; NOT System32 bash).
 */
export const TERMINAL_WINDOWS_SHELL: "powershell" | "cmd" | "git-bash" = "powershell";

/**
 * Shell-candidate fallback behaviour. Upstream only advances to the next candidate on
 * "not found" spawn errors — any other failure (access-denied / UNKNOWN) aborts the whole
 * terminal start even though the next candidate (e.g. cmd.exe) would work.
 * - `true` (default): ANY spawn failure of a candidate advances to the next one; the start
 *   fails only after the LAST candidate.
 * - `false`: upstream behaviour (not-found-only).
 */
export const TERMINAL_SHELL_FALLBACK_ANY_ERROR: boolean = true;

/**
 * How the terminal detects a running foreground child on Windows (feeds preview's
 * port→terminal attribution; runs ONLY while port scanning is enabled in Settings).
 * - `"console-list"` (default): in-process `GetConsoleProcessList` via node-pty's shipped
 *   `conpty_console_list.node` — ZERO child processes. Reports pids only (no command label).
 * - `"tasklist"`: `tasklist.exe /fo csv /nh` — one plain signed system exe per poll.
 * - `"powershell"`: legacy `powershell.exe -Command Get-CimInstance Win32_Process` every
 *   second per terminal — the app's heaviest recurring spawn churn; kept for comparison.
 */
export const TERMINAL_INSPECT_WINDOWS_METHOD: "console-list" | "tasklist" | "powershell" =
  "console-list";

/**
 * How the on-demand process-diagnostics RPC enumerates processes on Windows.
 * - `"tasklist"` (default): `tasklist.exe /fo csv /nh` — plain system exe; the CPU column is
 *   unavailable (tasklist reports memory only) and renders empty.
 * - `"powershell"`: legacy `powershell.exe -Command Get-CimInstance …` — observed failing
 *   with `spawn UNKNOWN` on some Windows setups (diagnostics panel empty); kept for comparison.
 */
export const DIAGNOSTICS_WINDOWS_METHOD: "tasklist" | "powershell" = "tasklist";

/**
 * Windows-safe terminal process teardown.
 * - `true` (default): `kill()` is called WITHOUT a signal on Windows (node-pty throws
 *   "Signals not supported on windows." for ANY signal argument — ConPTY kill terminates the
 *   process tree, same approach as VS Code), and a failed graceful kill still attempts the
 *   force-kill step instead of silently leaking the process.
 * - `false`: upstream behaviour (signal passed through → every Windows kill throws and the
 *   shell + conhost pair leak on each terminal stop/restart).
 */
export const TERMINAL_WINDOWS_KILL_COMPAT: boolean = true;

/**
 * Schema decode-default for the new `preview.portScanEnabled` server setting. `false`
 * guarantees the scanner is OFF for every install — fresh, upgraded, or reinstalled (an
 * existing settings.json without the field decodes to this value) — until the user
 * explicitly enables it in Settings. The scanner AND the terminal foreground-inspection
 * poll are both gated on the setting server-side, before any child process is spawned.
 */
export const PORT_SCAN_DEFAULT_ENABLED: boolean = false;
