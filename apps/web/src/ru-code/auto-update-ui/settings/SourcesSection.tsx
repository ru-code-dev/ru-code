// ru-code: auto-update settings — «Update sources» (v3 two-source model): two
// source cards (git first, web second) with user-owned switches and derived
// health. NO URL inputs (links are baked branding constants); NO rollback.
import { APP_NAME } from "@ru-code/branding";
import {
  ChevronRightIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  UserRoundCheckIcon,
  UserRoundIcon,
} from "lucide-react";

import { manifestUrlFor, sourceHealth, type AutoUpdateUiState } from "../model";
import { clearGitCreds, probeSource, toggleSource, useAutoUpdate } from "../store/autoUpdateStore";
import { Button } from "../ui-kit/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui-kit/collapsible";
import { Callout } from "../ui-kit/custom/Callout";
import { ChannelCard } from "../ui-kit/custom/ChannelCard";
import { CopyButton } from "../ui-kit/custom/CopyButton";
import { CredentialCard } from "../ui-kit/custom/CredentialCard";
import { InfoHint } from "../ui-kit/custom/InfoHint";
import { KeyValueGrid } from "../ui-kit/custom/KeyValueGrid";
import { SettingsSection } from "../ui-kit/layout";
import type { WizardKind } from "./wizard/CredentialsWizard";

/**
 * The credential file's real name, as the engine writes it (`<stateDir>/auto-update-credentials.enc`
 * — see the auto-update engine's `credsPath`). Named here rather than described, because the whole
 * value of the developer panel is that its strings are exact.
 */
const CREDENTIALS_FILENAME = "auto-update-credentials.enc";

// ru-code: the WEB source's sign-in affordance is HIDDEN in the UI on purpose — it is
// not deleted. Everything behind it stays wired and tested: the credentials wizard's
// `web` flow, the save/test RPCs (`saveWebCreds` / `testWebCreds`) and the engine's
// HTTP-basic support. Re-enabling the button is this ONE constant.
const WEB_SIGN_IN_UI_ENABLED = false;

// ── git card ─────────────────────────────────────────────────────────────────

function gitStatusLine(git: AutoUpdateUiState["git"]): React.ReactNode {
  switch (git.authVia) {
    case "ambient":
      return "via your system git keys — no setup needed";
    case "https":
      return (
        <>
          login: <span className="font-mono">{git.httpsCred?.username ?? ""}</span>
        </>
      );
    case "ssh":
      return (
        <>
          SSH key ·{" "}
          <span className="font-mono">{git.sshCred?.fingerprint.slice(0, 19) ?? ""}…</span>
        </>
      );
  }
}

function GitSourceConfig({ onOpenWizard }: { onOpenWizard: (kind: WizardKind) => void }) {
  const state = useAutoUpdate();
  if (state === null) return null;
  const { git } = state;

  return (
    <>
      {git.authVia === "ambient" ? (
        <Callout icon={<ShieldCheckIcon />} tone="success" title="Works without setup">
          {`git on this computer already knows how to sign in to the repository (ssh-agent or the system password store). ${APP_NAME} runs it in a safe mode — no pop-ups and no repeated sign-in attempts.`}
          <span className="mt-2 flex gap-1.5">
            <Button onClick={() => onOpenWizard("https")} size="xs" variant="ghost">
              <UserRoundIcon />
              Sign in with a login
            </Button>
            <Button onClick={() => onOpenWizard("ssh")} size="xs" variant="ghost">
              <KeyRoundIcon />
              Your own SSH key
            </Button>
          </span>
        </Callout>
      ) : null}

      {git.authVia === "https" && git.httpsCred ? (
        <CredentialCard
          action={
            <>
              <Button onClick={() => onOpenWizard("https")} size="xs" variant="outline">
                Change
              </Button>
              <Button
                aria-label="Delete the saved sign-in"
                onClick={clearGitCreds}
                size="xs"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </>
          }
          description={`The password is encrypted and stored only on this computer · updated ${git.httpsCred.savedAgo}`}
          icon={<UserRoundCheckIcon />}
          title={
            <>
              Signed in: <span className="font-mono">{git.httpsCred.username}</span>
            </>
          }
          tone={git.paused ? "warning" : "success"}
        />
      ) : null}

      {git.authVia === "ssh" && git.sshCred ? (
        <CredentialCard
          action={
            <>
              <Button onClick={() => onOpenWizard("ssh")} size="xs" variant="outline">
                Replace
              </Button>
              <Button
                aria-label="Delete the saved sign-in"
                onClick={clearGitCreds}
                size="xs"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </>
          }
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-[11px]">{git.sshCred.fingerprint.slice(0, 24)}…</span>
              <span>· ed25519 · added {git.sshCred.savedAgo}</span>
            </span>
          }
          icon={<KeyRoundIcon />}
          title="SSH key added"
          tone={git.paused ? "warning" : "success"}
        />
      ) : null}
    </>
  );
}

// ── developer details ────────────────────────────────────────────────────────

function DevDetails() {
  const state = useAutoUpdate();
  if (state === null) return null;
  const manifestUrl = manifestUrlFor(state);
  // ru-code: every line here is a FACT the user may paste into a support ticket, so each one names
  // what the app actually does. The secrets row used to print `~/.t3/userdata/secrets/
  // autoupdate-*.bin` — a foreign brand, a directory that does not exist and a filename that never
  // existed; the real store is ONE file, `auto-update-credentials.enc`, in this app's state
  // directory. The web-check row claimed `curl`, which nothing in this app uses.
  const diagnostics = [
    `manifest: ${manifestUrl}`,
    `sources: git=${state.git.enabled ? state.git.state : "off"} web=${state.web.enabled ? state.web.state : "off"} (git auth: ${state.git.authVia})`,
    `install: ${state.installDir}`,
    `entry: ${state.entryPoint}`,
    `secrets: ${CREDENTIALS_FILENAME} in the app state directory (aes-256-gcm)`,
  ].join("\n");

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon className="size-4 transition-transform duration-200 group-data-panel-open:rotate-90" />
        <TerminalIcon className="size-3.5" />
        For developers
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-3 space-y-3 rounded-xl border border-border/60 bg-muted/32 p-3.5 dark:bg-input/16">
          <KeyValueGrid
            entries={[
              { key: "Manifest", value: manifestUrl },
              {
                key: "git check",
                value: "GIT_TERMINAL_PROMPT=0 git ls-remote (BatchMode=yes for SSH)",
              },
              { key: "web check", value: "GET …/manifest.json (Accept: application/json)" },
              { key: "Install directory", value: state.installDir },
              { key: "Process", value: state.entryPoint },
              {
                key: "Secrets",
                value: `${CREDENTIALS_FILENAME} in the app state directory · aes-256-gcm`,
              },
            ]}
          />
          <CopyButton label="Copy diagnostics" value={diagnostics} variant="ghost" />
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ── section ──────────────────────────────────────────────────────────────────

export function SourcesSection({ onOpenWizard }: { onOpenWizard: (kind: WizardKind) => void }) {
  const state = useAutoUpdate();
  if (state === null) return null;

  // #24: a per-source «Проверить» never fires while a global check / install run is in flight.
  // Same rule as the hero (StatusHeroCard): a run that already FAILED is terminal, not work in
  // flight. Counting it as busy left every per-source «Проверить» disabled too, so the one action
  // that unpauses a source and re-resolves a release was unreachable after a failed press.
  const busy = state.checking || (state.run !== null && state.run.phase !== "failed");

  // ru-code: true exactly when at least one credential is actually on disk — the condition
  // that makes the callout's encryption promise honest (see the Callout title below).
  const storesCredentials =
    state.git.httpsCred !== null || state.git.sshCred !== null || state.web.cred !== null;

  return (
    <SettingsSection icon={<GlobeIcon className="size-3.5" />} title="Update sources">
      <div className="space-y-3 p-4 sm:p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {`${APP_NAME} checks git first, then the website. Each source can be turned off; the newest version across the enabled ones is taken.`}
        </p>

        {state.git.offered ? (
          <ChannelCard
            enabled={state.git.enabled}
            health={sourceHealth(state.git.state)}
            icon={<GitBranchIcon />}
            issue={state.git.state === "ok" ? null : state.git.healthLine}
            lastProbe={state.git.lastResult?.line ?? null}
            onProbe={() => probeSource("git")}
            onToggle={(enabled) => toggleSource("git", enabled)}
            probeDisabled={busy}
            probeTestId="auto-update-probe-git"
            dataState={state.git.state}
            statusLine={gitStatusLine(state.git)}
            testId="auto-update-source-git"
            title="Git repository"
          >
            <GitSourceConfig onOpenWizard={onOpenWizard} />
          </ChannelCard>
        ) : null}

        {state.web.offered ? (
          <ChannelCard
            enabled={state.web.enabled}
            health={sourceHealth(state.web.state)}
            icon={<GlobeIcon />}
            issue={state.web.state === "ok" ? null : state.web.healthLine}
            lastProbe={state.web.lastResult?.line ?? null}
            onProbe={() => probeSource("web")}
            onToggle={(enabled) => toggleSource("web", enabled)}
            probeDisabled={busy}
            probeTestId="auto-update-probe-web"
            dataState={state.web.state}
            testId="auto-update-source-web"
            statusLine={
              state.web.cred !== null ? (
                <>
                  login: <span className="font-mono">{state.web.cred.username}</span>
                </>
              ) : (
                "default release address"
              )
            }
            title="Site / server"
          >
            {WEB_SIGN_IN_UI_ENABLED ? (
              <Button onClick={() => onOpenWizard("web")} size="xs" variant="outline">
                <UserRoundIcon />
                {state.web.cred !== null ? "Change sign-in" : "Add sign-in"}
              </Button>
            ) : null}
          </ChannelCard>
        ) : null}

        <Callout
          icon={<ShieldCheckIcon />}
          title={
            // ru-code: the encryption promise is only true where something IS stored, so it
            // renders only then — git credentials (login or SSH key), or a web login saved
            // before WEB_SIGN_IN_UI_ENABLED hid that path. With nothing on disk the callout
            // carries the pause rule alone.
            storesCredentials ? (
              <span className="flex items-center gap-1.5">
                Sign-in data is encrypted and never leaves this computer
                <InfoHint>
                  On-disk encryption is AES-256-GCM. It protects the file if it is copied to another
                  machine.
                </InfoHint>
              </span>
            ) : undefined
          }
          tone="info"
        >
          {`If the server denies access twice, ${APP_NAME} pauses that source.`}
        </Callout>

        <DevDetails />
      </div>
    </SettingsSection>
  );
}
