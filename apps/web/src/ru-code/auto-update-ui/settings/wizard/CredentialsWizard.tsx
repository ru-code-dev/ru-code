// ru-code: auto-update settings — credentials wizard (login + SSH key).
// Flows:
//   login (git-https OR web basic-auth): username/token → connection test → done
//   ssh: method (paste | generate | file) → key → connection test → done
// Real end-to-end only (audit #7): the target host is read from the BAKED source
// url (never fabricated), the terminal reflects the real `CredentialTestResult`
// (localized code + mono raw + latency), the generated key shows nothing until the
// RPC resolves, and an in-flight test aborts on close. Nothing is saved until the
// connection test passes; the server re-tests on save and keyscan-pins the host
// (there is no manual known_hosts paste).
import {
  CheckIcon,
  ClipboardPasteIcon,
  FileKey2Icon,
  FolderOpenIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserRoundIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { APP_NAME } from "@ru-code/branding";
import type { CredentialTestResult, SshKeySourceInput } from "@t3tools/contracts";

import {
  generateSshKey,
  saveGitHttps,
  saveSsh,
  saveWebCreds,
  testGitHttps,
  testSsh,
  testWebCreds,
  useAutoUpdate,
} from "../../store/autoUpdateStore";
import { Button } from "../../ui-kit/button";
import { cn } from "../../ui-kit/cn";
import { Callout } from "../../ui-kit/custom/Callout";
import { CopyButton } from "../../ui-kit/custom/CopyButton";
import { TerminalBox, type TerminalLine } from "../../ui-kit/custom/TerminalBox";
import { WizardSteps } from "../../ui-kit/custom/WizardSteps";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui-kit/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui-kit/input-group";
import { Label } from "../../ui-kit/label";
import { Spinner } from "../../ui-kit/spinner";
import { Textarea } from "../../ui-kit/textarea";

/** `https` = git over user/pass, `web` = website basic auth, `ssh` = git SSH key. */
export type WizardKind = "https" | "web" | "ssh";

type TestState = "idle" | "running" | "ok" | "fail";

/**
 * The host of a baked source link (never fabricated — read from the wire `url`).
 * Handles `https://host/…`, `git@host:org/repo`, and bare `host/…` shapes; returns
 * "" when the build baked no link (the caller then shows nothing).
 */
function hostOf(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";
  const scp = /^[^@\s]+@([^:/\s]+)/.exec(trimmed);
  if (scp !== null) return scp[1] ?? "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).host;
  } catch {
    return trimmed.replace(/^([^/\s]+).*$/, "$1");
  }
}

/** «<app> connects to <host>» — the real target, shown before a connection test. */
function ConnectTarget({ url }: { url: string }) {
  const host = hostOf(url);
  if (host.length === 0) return null;
  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {`${APP_NAME} connects to`} <span className="font-mono text-foreground/85">{host}</span>.
    </p>
  );
}

// ── connection test (drives the terminal from the REAL result) ─────────────────

function useConnectionTest() {
  const [testState, setTestState] = useState<TestState>("idle");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  /**
   * Forget the verdict. A test result describes ONE key (or one login) — the moment the input
   * changes, the green «проверены на реальном подключении» callout is describing something the
   * user has replaced, and «Сохранить» is enabled for a credential nothing has tried.
   */
  const reset = () => {
    cancelled.current = true;
    setTestState("idle");
    setLines([]);
  };

  const run = (probe: () => Promise<CredentialTestResult>) => {
    cancelled.current = false;
    setTestState("running");
    setLines([{ tone: "act", text: "connecting…" }]);
    probe()
      .then((result) => {
        if (cancelled.current) return;
        if (result.ok) {
          setLines([
            {
              tone: "ok",
              text: `signed in${result.latencyMs !== null ? ` · ${result.latencyMs} ms` : ""}`,
            },
            { tone: "ok", text: "found the release manifest" },
          ]);
          setTestState("ok");
        } else {
          setLines([{ tone: "err", text: result.raw ?? "the server rejected the connection" }]);
          setTestState("fail");
        }
      })
      .catch((error: unknown) => {
        if (cancelled.current) return;
        setLines([
          { tone: "err", text: error instanceof Error ? error.message : "could not connect" },
        ]);
        setTestState("fail");
      });
  };

  return { testState, lines, run, reset };
}

function ConnectionTestView({
  testState,
  lines,
  failHint,
}: {
  testState: TestState;
  lines: TerminalLine[];
  failHint: string;
}) {
  if (testState === "idle") return null;
  return (
    <div className="space-y-3">
      <TerminalBox follow lines={lines} maxHeight="max-h-36" />
      {testState === "fail" ? (
        <Callout tone="destructive" title="Could not connect">
          {failHint}
        </Callout>
      ) : null}
      {testState === "ok" ? (
        <Callout icon={<CheckIcon />} tone="success" title="Connection works">
          The credentials were verified on a real connection — you can save.
        </Callout>
      ) : null}
    </div>
  );
}

function DoneStep({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-success/10 text-success-foreground dark:bg-success/16">
        <CheckIcon className="size-7" />
      </span>
      <div className="text-[15px] font-semibold text-foreground">{title}</div>
      <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

// ── login flow (git-https OR web basic auth) ───────────────────────────────────

function LoginFlow({ kind, onClose }: { kind: "https" | "web"; onClose: () => void }) {
  const state = useAutoUpdate();
  const [step, setStep] = useState(0);
  // ru-code: `https` = git over HTTPS (personal access tokens are the norm there);
  // `web` = plain HTTP Basic auth against the release host — no tokens involved, so
  // the token wording and the `ghp_…` placeholder stay on the git side only.
  const gitHttps = kind === "https";
  const existing = kind === "https" ? state?.git.httpsCred?.username : state?.web.cred?.username;
  const sourceUrl = (kind === "https" ? state?.git.url : state?.web.url) ?? "";
  const [username, setUsername] = useState(existing ?? "");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const { testState, lines, run, reset } = useConnectionTest();

  const steps = ["Login", "Check", "Done"];
  const probe = () =>
    kind === "https"
      ? testGitHttps({ username: username || "deploy-bot", password: secret })
      : testWebCreds({ username: username || "deploy-bot", password: secret });

  /**
   * The success screen follows the SAVE. It used to call a void action and advance immediately, so
   * a refused save produced a green «Вход выполнен» with a red toast over it and no credential
   * stored — the wizard telling the user the opposite of what happened.
   */
  const persist = () => {
    setSaving(true);
    const saved =
      kind === "https"
        ? saveGitHttps({ username: username || "deploy-bot", password: secret })
        : saveWebCreds({ username: username || "deploy-bot", password: secret });
    saved
      .then(() => setStep(2))
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary dark:bg-primary/12">
            <UserRoundIcon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-lg">Sign in with a login</DialogTitle>
            <DialogDescription className="mt-1">
              {`${APP_NAME} will sign in to the`}{" "}
              {kind === "https" ? "git repository" : "release server"} as this user.
            </DialogDescription>
          </div>
        </div>
        <WizardSteps className="mt-3" current={step} total={steps.length} />
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {step === 0 ? (
          <>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Usually a separate «deploy» user with read-only access is created for this.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="wizard-username">Login</Label>
              <InputGroup>
                <InputGroupInput
                  className="font-mono text-[13px]"
                  id="wizard-username"
                  onChange={(event) => {
                    setUsername(event.target.value);
                    reset();
                  }}
                  placeholder="deploy-bot"
                  spellCheck={false}
                  value={username}
                />
              </InputGroup>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wizard-secret">
                {gitHttps ? "Password or access token" : "Password"}
              </Label>
              <InputGroup>
                <InputGroupInput
                  className="font-mono text-[13px]"
                  id="wizard-secret"
                  onChange={(event) => {
                    setSecret(event.target.value);
                    reset();
                  }}
                  placeholder={gitHttps ? "ghp_…" : "••••••••"}
                  type="password"
                  value={secret}
                />
              </InputGroup>
              <p className="text-xs text-muted-foreground/80">
                {gitHttps
                  ? "A token is safer than a password — it can be revoked at any time."
                  : "The server asks for this login and password on every request (HTTP Basic authentication)."}
              </p>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <ConnectTarget url={sourceUrl} />
            <Callout tone="primary" icon={<ShieldCheckIcon />}>
              {`${APP_NAME} will try to connect with these credentials. Nothing is saved until the check passes.`}
            </Callout>
            <ConnectionTestView
              failHint={
                gitHttps
                  ? "Check the login and token — the server did not accept them."
                  : "Check the login and password — the server did not accept them."
              }
              lines={lines}
              testState={testState}
            />
          </>
        ) : null}

        {step === 2 ? (
          <DoneStep
            description="The password is saved encrypted on this computer. You can change or delete it any time in the source settings."
            title={`Signed in: ${username || "deploy-bot"}`}
          />
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {step === 1 ? (
          <Button className="me-auto" onClick={() => setStep(0)} variant="ghost">
            Back
          </Button>
        ) : null}
        {step === 0 ? (
          <Button
            disabled={username.length === 0 || secret.length === 0}
            onClick={() => {
              setStep(1);
              run(probe);
            }}
          >
            Check the connection
          </Button>
        ) : null}
        {step === 1 ? (
          testState === "fail" ? (
            <Button onClick={() => run(probe)} variant="outline">
              Retry
            </Button>
          ) : (
            <Button disabled={testState !== "ok" || saving} onClick={persist}>
              {testState === "running" || saving ? <Spinner /> : null}
              Save and connect
            </Button>
          )
        ) : null}
        {step === 2 ? <Button onClick={onClose}>Done</Button> : null}
      </DialogFooter>
    </>
  );
}

// ── SSH flow ─────────────────────────────────────────────────────────────────

type SshMethod = "paste" | "generate" | "file";

const SSH_METHODS: ReadonlyArray<{
  value: SshMethod;
  icon: typeof ClipboardPasteIcon;
  title: string;
  description: string;
}> = [
  {
    value: "paste",
    icon: ClipboardPasteIcon,
    title: "Paste an existing key",
    description: "You already have a private key file (it starts with «-----BEGIN»).",
  },
  {
    value: "generate",
    icon: SparklesIcon,
    title: "Generate a new one",
    description: `${APP_NAME} will create a key, and you add its public part to the repository.`,
  },
  {
    value: "file",
    icon: FolderOpenIcon,
    title: "Point to a file on disk",
    description: "For example ~/.ssh/id_ed25519 — the file stays where it is.",
  },
];

function SshFlow({ onClose }: { onClose: () => void }) {
  const state = useAutoUpdate();
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<SshMethod>("paste");
  const [keyPath, setKeyPath] = useState("~/.ssh/id_ed25519");
  const [pastedKey, setPastedKey] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  /** The key generation failed — the screen says so instead of spinning forever. */
  const [keygenFailed, setKeygenFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const { testState, lines, run, reset } = useConnectionTest();
  const sourceUrl = state?.git.url ?? "";

  const steps = ["Method", "Key", "Check", "Done"];
  /**
   * «Продолжить» requires a key that EXISTS. `generate` used to be hardcoded ready, so a failed
   * keygen still let the user walk forward and test a key whose public half they were never shown
   * — and therefore could not have added to the repository as a deploy key.
   */
  const keyReady =
    method === "generate"
      ? generatedKey !== null
      : method === "file"
        ? keyPath.length > 0
        : pastedKey.length > 0;

  const keySource: SshKeySourceInput =
    method === "paste"
      ? { origin: "paste", privateKeyPem: pastedKey }
      : method === "file"
        ? { origin: "file", path: keyPath }
        : { origin: "generate" };

  useEffect(() => {
    if (step !== 1 || method !== "generate") return;
    let cancelled = false;
    setKeygenFailed(false);
    generateSshKey()
      .then((info) => {
        if (!cancelled) setGeneratedKey(info.publicKey);
      })
      .catch(() => {
        // Swallowing this left «Создаю ключ…» spinning forever under a callout that already
        // claimed the key had been created, with «Продолжить» enabled. The store surfaces the
        // error as a toast; this is what the screen itself has to say.
        if (!cancelled) setKeygenFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [step, method]);

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary dark:bg-primary/12">
            <KeyRoundIcon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-lg">Add an SSH key</DialogTitle>
            <DialogDescription className="mt-1">
              {`A key is a pair of files ${APP_NAME} uses to sign in without a password.`}
            </DialogDescription>
          </div>
        </div>
        <WizardSteps className="mt-3" current={step} total={steps.length} />
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {step === 0 ? (
          <div className="space-y-2">
            {SSH_METHODS.map((option) => {
              const Icon = option.icon;
              const active = method === option.value;
              return (
                <button
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                    active
                      ? "border-primary/56 bg-primary/4 dark:bg-primary/8"
                      : "border-border/70 bg-background hover:border-border hover:bg-accent/40 dark:bg-input/16",
                  )}
                  key={option.value}
                  onClick={() => {
                    setMethod(option.value);
                    setGeneratedKey(null);
                    reset();
                  }}
                  type="button"
                >
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg border",
                      active
                        ? "border-primary/32 bg-primary/8 text-primary"
                        : "border-border/70 bg-muted/64 text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-foreground">
                      {option.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {step === 1 && method === "paste" ? (
          <div className="space-y-1.5">
            <Label htmlFor="wizard-key">Private key</Label>
            <Textarea
              className="min-h-28 font-mono text-[11.5px]"
              id="wizard-key"
              onChange={(event) => {
                setPastedKey(event.target.value);
                reset();
              }}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
              spellCheck={false}
              value={pastedKey}
            />
            <p className="text-xs text-muted-foreground/80">
              Paste the contents of the key file. It will be encrypted before saving.
            </p>
          </div>
        ) : null}

        {step === 1 && method === "generate" ? (
          <>
            {/* The success callout describes a key that EXISTS. It used to render the instant the
                step opened, above a spinner for a key that might never arrive. */}
            {generatedKey !== null ? (
              <Callout icon={<SparklesIcon />} tone="success" title="A new ed25519 key was created">
                Add its <b>public part</b> to the repository as a deploy key — then sign-in will
                work.
              </Callout>
            ) : null}
            {generatedKey !== null ? (
              <TerminalBox
                action={<CopyButton size="icon-xs" value={generatedKey} variant="ghost" />}
                lines={[{ tone: "dim", text: generatedKey }]}
                maxHeight="max-h-24"
              />
            ) : keygenFailed ? (
              <Callout
                action={
                  <Button
                    onClick={() => {
                      setKeygenFailed(false);
                      generateSshKey()
                        .then((info) => setGeneratedKey(info.publicKey))
                        .catch(() => setKeygenFailed(true));
                    }}
                    size="xs"
                    variant="outline"
                  >
                    Try again
                  </Button>
                }
                tone="destructive"
                title="The key could not be created"
              >
                Check that ssh-keygen is available on this machine, or choose another method.
              </Callout>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/32 px-3 py-2.5 text-[13px] text-muted-foreground dark:bg-input/16">
                <Spinner className="size-4" />
                Creating the key…
              </div>
            )}
          </>
        ) : null}

        {step === 1 && method === "file" ? (
          <div className="space-y-1.5">
            <Label htmlFor="wizard-key-path">Path to the private key</Label>
            <InputGroup>
              <InputGroupAddon>
                <FileKey2Icon className="text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                className="font-mono text-[13px]"
                id="wizard-key-path"
                onChange={(event) => {
                  setKeyPath(event.target.value);
                  reset();
                }}
                spellCheck={false}
                value={keyPath}
              />
            </InputGroup>
          </div>
        ) : null}

        {step === 2 ? (
          <>
            <ConnectTarget url={sourceUrl} />
            <Callout icon={<ShieldCheckIcon />} tone="primary">
              {`${APP_NAME} records the server fingerprint on this first connection and warns you if it ever changes. Nothing is saved until the check passes.`}
            </Callout>
            <ConnectionTestView
              failHint="The server did not accept the key. Check that the public part is added to the repository as a deploy key."
              lines={lines}
              testState={testState}
            />
          </>
        ) : null}

        {step === 3 ? (
          <DoneStep
            description={
              <>
                The key is encrypted and stored only on this computer · fingerprint{" "}
                <span className="font-mono text-[11px]">
                  {state?.git.sshCred?.fingerprint.slice(0, 24) ?? ""}…
                </span>
                .
              </>
            }
            title="SSH key added"
          />
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {step > 0 && step < 3 ? (
          <Button
            className="me-auto"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            variant="ghost"
          >
            Back
          </Button>
        ) : null}
        {step === 0 ? <Button onClick={() => setStep(1)}>Continue</Button> : null}
        {step === 1 ? (
          <Button disabled={!keyReady} onClick={() => setStep(2)}>
            Continue
          </Button>
        ) : null}
        {step === 2 ? (
          testState === "fail" ? (
            <Button onClick={() => run(() => testSsh(keySource))} variant="outline">
              Retry
            </Button>
          ) : testState === "idle" ? (
            <Button onClick={() => run(() => testSsh(keySource))}>Check the connection</Button>
          ) : (
            <Button
              disabled={testState !== "ok" || saving}
              onClick={() => {
                // The success screen follows the SAVE, not the click. It used to advance
                // unconditionally, so a save the server refused (a failing re-test, a disk error,
                // a dropped connection) drew «SSH-ключ добавлен» with a red toast on top of it and
                // nothing stored — the one screen in the flow that must never be optimistic.
                setSaving(true);
                saveSsh(keySource)
                  .then(() => setStep(3))
                  .catch(() => undefined)
                  .finally(() => setSaving(false));
              }}
            >
              {testState === "running" || saving ? <Spinner /> : null}
              Save and connect
            </Button>
          )
        ) : null}
        {step === 3 ? <Button onClick={onClose}>Done</Button> : null}
      </DialogFooter>
    </>
  );
}

// ── entry ────────────────────────────────────────────────────────────────────

export function CredentialsWizard({
  kind,
  onClose,
}: {
  kind: WizardKind | null;
  onClose: () => void;
}) {
  return (
    <Dialog onOpenChange={(open) => (!open ? onClose() : undefined)} open={kind !== null}>
      <DialogPopup className="max-w-xl" data-testid="auto-update-wizard">
        {kind === "https" ? <LoginFlow key="https" kind="https" onClose={onClose} /> : null}
        {kind === "web" ? <LoginFlow key="web" kind="web" onClose={onClose} /> : null}
        {kind === "ssh" ? <SshFlow key="ssh" onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
