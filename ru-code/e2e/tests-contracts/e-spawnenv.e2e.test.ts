// ru-code PIN SUITE — the cross-cutting SPAWN-ENV pin (E1).
//
// Every other pin in this file's registry story is per-site: it proves ONE call site builds its
// env from @ru-code/branding's CLI registry. This one is the net underneath them: it boots the
// REAL app, exercises the three live spawn kinds in a single boot — the `--version` provider
// probe, ACP sessions / warm slots, and a one-shot `-p` text generation (the first-turn thread
// title) — and asserts that EVERY spawn the CLI actually received carries the registry's enforced
// assignments and shared flags.
//
// That is the invariant a per-site test cannot give: a NEW spawn site added tomorrow, or an old
// one quietly hand-rolling its env again, fails here without anyone remembering to pin it.
//
// Evidence comes from pinFakeCli, which appends `<iso> <argv>\t<recorded env JSON>` per
// invocation. The names it records are handed to it by this test, derived from the registry — the
// fake CLI itself stays registry-free.
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

// The e2e package does not depend on @ru-code/branding, so the registry is imported by path.
// Both files are dependency-free leaves, which is exactly why this works.
import { CLI_ENV } from "../../branding/src/cliEnv.ts";
import { cliArgAssignments, cliEnvAssignments } from "../../branding/src/cliEnvBuild.ts";

import { RU_CODE_TMP_ROOT } from "../harness/primitives.ts";
import { awaitStable, bootPin, runPinCleanups, saveEvidence } from "../harness/pinHarness.ts";

test.afterEach(async () => {
  await runPinCleanups();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every env var name the registry can ever write — what the fake CLI is asked to record. */
const RECORDED_NAMES = Object.values(CLI_ENV).flatMap((row) => [...row.names]);

/** The rows with a FIXED value: present with that exact value on EVERY spawn, no exceptions. */
const FIXED_PAIRS = cliEnvAssignments();

interface LoggedSpawn {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function parseSpawnLog(logPath: string): ReadonlyArray<LoggedSpawn> {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [head, envJson] = line.split("\t");
      // Drop the leading ISO timestamp; the rest is the argv the CLI was invoked with.
      const argv = (head ?? "").split(" ").slice(1);
      const env = envJson === undefined ? {} : (JSON.parse(envJson) as Record<string, string>);
      return { argv, env };
    });
}

/** True when `needle` appears as a contiguous run inside `haystack`. */
const containsRun = (haystack: ReadonlyArray<string>, needle: ReadonlyArray<string>): boolean =>
  needle.length === 0 ||
  haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));

test("E1: every spawn the CLI receives carries the branding registry's env + flags", async ({
  page,
}) => {
  NodeFS.mkdirSync(RU_CODE_TMP_ROOT, { recursive: true });
  const logPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(RU_CODE_TMP_ROOT, "pin-spawnenv-")),
    "spawns.log",
  );
  const app = await bootPin({
    name: "e1-spawn-env",
    env: {
      // Warm slots ON: ACP spawns happen at boot without touching the UI.
      RU_CODE_WARM_ENGINE: "1",
      // ru-code: a pinned app has NO workspace by default (branding's CREATE_STARTER_PROJECT is
      // off), so the sidebar shows "Пока нет проектов", "Новый диалог" is disabled and NO
      // composer is ever rendered. The other pins never notice because none of them drives a
      // turn. This is the same permanent env seam the standard e2e harness uses
      // (e2e/scripts/bootApp.ts) to get a workspace; production leaves it unset.
      RU_CODE_CREATE_STARTER_PROJECT: "1",
      RU_CODE_PIN_SPAWN_LOG: logPath,
      RU_CODE_PIN_SPAWN_LOG_ENV: RECORDED_NAMES.join(","),
    },
  });
  await awaitStable(page, app);

  // ── drive a first-turn prompt: that is both an ACP session and (via the thread-title
  // generator) a one-shot `-p` run, so all three spawn kinds appear in one boot. The title
  // generator is fire-and-forget server-side; we only need its SPAWN, which is logged before
  // the fake CLI does anything else.
  //
  // The steps below mirror openThread/sendPrompt in e2e/tests-core/fixtures.ts exactly — those
  // helpers cannot be imported here because they read the OTHER suite's harness-state file.
  // A real pointer click on "New thread" is intercepted by the hover-revealed header menu,
  // hence dispatchEvent; the composer is a contenteditable whose first keystrokes can race its
  // own mount, so the text is verified before Enter and the send is retried until it empties.
  await page.goto(app.webUrl, { waitUntil: "domcontentloaded" });
  await page.locator("div[contenteditable=true]").first().waitFor({ timeout: 30_000 });
  const newThread = page.getByRole("button", { name: /New thread|Новый диалог/ }).first();
  await newThread.dispatchEvent("click");
  await expect(page).toHaveURL(/\/draft\//, { timeout: 30_000 });

  const input = page.locator("div[contenteditable=true]").first();
  await input.waitFor({ timeout: 30_000 });
  await input.click();
  const prompt = "привет";
  await page.keyboard.type(prompt);
  await expect(input).toContainText(prompt, { timeout: 15_000 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.keyboard.press("Enter");
    const emptied = await input
      .textContent()
      .then((value) => !(value ?? "").includes(prompt))
      .catch(() => false);
    if (emptied) break;
    await page.waitForTimeout(250);
  }

  // Wait for the one-shot `-p` spawn to show up (the slowest of the three to appear).
  const deadline = Date.now() + 90_000;
  let spawns = parseSpawnLog(logPath);
  while (Date.now() < deadline && !spawns.some((spawn) => spawn.argv.includes("-p"))) {
    await sleep(1_000);
    spawns = parseSpawnLog(logPath);
  }

  saveEvidence("E1-evidence.json", JSON.stringify({ recorded: RECORDED_NAMES, spawns }, null, 2));

  // All three spawn kinds actually happened — otherwise the assertions below are vacuous.
  expect(spawns.length, "the CLI was spawned at all").toBeGreaterThan(0);
  expect(
    spawns.filter((spawn) => spawn.argv.includes("--version")).length,
    "the app ran its --version probe",
  ).toBeGreaterThan(0);
  expect(
    spawns.filter((spawn) => spawn.argv.includes("--acp")).length,
    "the app started at least one ACP session / warm slot",
  ).toBeGreaterThan(0);
  expect(
    spawns.filter((spawn) => spawn.argv.includes("-p")).length,
    "the app ran a one-shot text generation",
  ).toBeGreaterThan(0);

  // ── THE pin: no spawn site may bypass the registry ──
  const cliHomeNames = CLI_ENV.HOME.names;
  const sharedFlags = cliArgAssignments();
  for (const spawn of spawns) {
    const where = spawn.argv.join(" ");
    for (const [name, value] of FIXED_PAIRS) {
      expect(spawn.env[name], `${name} on \`${where}\``).toBe(value);
    }
    // HOME is runtime-supplied, so its VALUE varies per instance; what is enforced is that it is
    // there, non-empty, and already expanded (a literal `~` reaching the CLI is the original bug).
    for (const name of cliHomeNames) {
      const home = spawn.env[name] ?? "";
      expect(home.length, `${name} non-empty on \`${where}\``).toBeGreaterThan(0);
      expect(home.startsWith("~"), `${name} expanded on \`${where}\``).toBe(false);
    }
    expect(containsRun(spawn.argv, sharedFlags), `shared flags on \`${where}\``).toBe(true);
  }
});
