import { PlusIcon, QrCodeIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { AnimatedHeight } from "../AnimatedHeight";
import { setPairingTokenOnUrl } from "../../pairingUrl";
// ru-fork: pair URL builders need to preserve the --base-url prefix.
import { getBasePath, joinBasePath } from "../../ru-fork/basePath";
import {
  createServerPairingCredential,
  fetchSessionState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import type { WsRpcClient } from "~/rpc/wsRpcClient";
import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  addSavedEnvironment,
  getPrimaryEnvironmentConnection,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
} from "~/environments/runtime";

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

function getSavedBackendStatusTooltip(
  runtime: SavedEnvironmentRuntimeState | null,
  record: SavedEnvironmentRecord,
  nowMs: number,
) {
  const connectionState = runtime?.connectionState ?? "disconnected";

  if (connectionState === "connected") {
    const connectedAt = runtime?.connectedAt ?? record.lastConnectedAt;
    return connectedAt ? `Connected for ${formatElapsedDurationLabel(connectedAt, nowMs)}` : null;
  }

  if (connectionState === "connecting") {
    return null;
  }

  if (connectionState === "error") {
    return runtime?.lastError ?? "An unknown connection error occurred.";
  }

  return record.lastConnectedAt
    ? `Last connected at ${formatAccessTimestamp(record.lastConnectedAt)}`
    : "Not connected yet.";
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function upsertDesktopPairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  next: ServerPairingLinkRecord,
) {
  const existingIndex = current.findIndex((pairingLink) => pairingLink.id === next.id);
  if (existingIndex === -1) {
    return sortDesktopPairingLinks([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopPairingLinks(updated);
}

function removeDesktopPairingLink(current: ReadonlyArray<ServerPairingLinkRecord>, id: string) {
  return current.filter((pairingLink) => pairingLink.id !== id);
}

function upsertDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  next: ServerClientSessionRecord,
) {
  const existingIndex = current.findIndex(
    (clientSession) => clientSession.sessionId === next.sessionId,
  );
  if (existingIndex === -1) {
    return sortDesktopClientSessions([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopClientSessions(updated);
}

function removeDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  sessionId: ServerClientSessionRecord["sessionId"],
) {
  return current.filter((clientSession) => clientSession.sessionId !== sessionId);
}

function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  // ru-fork: preserve any reverse-proxy prefix already on endpointUrl.
  const existing = url.pathname.replace(/\/+$/, "");
  url.pathname = existing.length > 0 ? `${existing}/pair` : "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  // ru-fork: prepend the configured --base-url prefix.
  const url = new URL(joinBasePath(getBasePath(), "/pair"), window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const shareablePairingUrl =
    endpointUrl != null && endpointUrl !== ""
      ? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential)
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl;
  const copyValue = shareablePairingUrl ?? pairingLink.credential;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: shareablePairingUrl ? "URL для связки скопирован" : "Токен связки скопирован",
        description: shareablePairingUrl
          ? "Откройте его в клиенте, который нужно связать с этим окружением."
          : "Вставьте в другой клиент с доступным хостом этого бэкенда.",
      });
    },
    onError: (error) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? "Не удалось скопировать URL связки"
            : "Копирование в буфер недоступно",
          description: canCopyToClipboard ? error.message : "Показано полное значение.",
        }),
      );
    },
  });

  const handleCopy = useCallback(() => {
    copyToClipboard(copyValue, undefined);
  }, [copyToClipboard, copyValue]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel = pairingLink.role === "owner" ? "Владелец" : "Клиент";
  const primaryLabel = pairingLink.label ?? `${roleLabel} link`;

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                        aria-label="Show QR code"
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {[roleLabel, formatExpiresInLabel(pairingLink.expiresAt, nowMs)].join(" · ")}
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              Скопируйте токен и выполните связку с другого клиента, используя доступный хост этого
              бэкенда.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <Button size="xs" variant="outline" onClick={handleCopy}>
                {isCopied ? "Скопировано" : shareablePairingUrl ? "Копировать" : "Копировать токен"}
              </Button>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "Показать ссылку" : "Показать токен"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>{shareablePairingUrl ? "Ссылка связки" : "Токен связки"}</DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? "Копирование в буфер недоступно. Откройте или скопируйте этот URL вручную на устройстве, которое нужно связать."
                    : "Копирование в буфер недоступно. Скопируйте токен вручную и выполните связку из другого клиента по доступному хосту."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={copyValue}
                  rows={shareablePairingUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Готово
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopy}>
                    {isCopied ? "Скопировано" : "Скопировать снова"}
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Отзыв…" : "Отозвать"}
          </Button>
        </div>
      </div>
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const roleLabel = clientSession.role === "owner" ? "Владелец" : "Клиент";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? ({ desktop: "Десктоп", mobile: "Мобильный", tablet: "Планшет", bot: "Бот" } as const)[
          clientSession.client.deviceType
        ]
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                Это устройство
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[roleLabel, ...deviceInfoBits].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential(pairingLabel);
      setPairingLabel("");
      setDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel]);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Отзыв…" : "Отозвать остальные"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Создать ссылку
            </Button>
          }
        />
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Создать ссылку для связки</DialogTitle>
            <DialogDescription>
              Создайте одноразовую ссылку, по которой другое устройство сможет подключиться к этому
              бэкенду как авторизованный клиент.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Метка клиента (необязательно)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="напр. iPad в гостиной"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Отмена
            </Button>
            <Button disabled={isCreatingPairingLink} onClick={() => void handleCreatePairingLink()}>
              {isCreatingPairingLink ? "Создание…" : "Создать ссылку"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={endpointUrl}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  );
});

type SavedBackendListRowProps = {
  environmentId: EnvironmentId;
  reconnectingEnvironmentId: EnvironmentId | null;
  removingEnvironmentId: EnvironmentId | null;
  onReconnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

function SavedBackendListRow({
  environmentId,
  reconnectingEnvironmentId,
  removingEnvironmentId,
  onReconnect,
  onRemove,
}: SavedBackendListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);

  if (!record) {
    return null;
  }

  const connectionState = runtime?.connectionState ?? "disconnected";
  const stateDotClassName =
    connectionState === "connected"
      ? "bg-success"
      : connectionState === "connecting"
        ? "bg-warning"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  const roleLabel = runtime?.role ? (runtime.role === "owner" ? "Владелец" : "Клиент") : null;
  const descriptorLabel = runtime?.descriptor?.label ?? null;
  const statusTooltip = getSavedBackendStatusTooltip(runtime, record, nowMs);
  const metadataBits = [
    roleLabel,
    record.lastConnectedAt
      ? `Last connected ${formatAccessTimestamp(record.lastConnectedAt)}`
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={stateDotClassName}
              pingClassName={
                connectionState === "connecting" ? "bg-warning/60 duration-2000" : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{record.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          {descriptorLabel && descriptorLabel !== record.label ? (
            <p className="text-xs text-muted-foreground">Server label: {descriptorLabel}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={reconnectingEnvironmentId === environmentId}
            onClick={() => void onReconnect(environmentId)}
          >
            {reconnectingEnvironmentId === environmentId ? "Переподключение…" : "Переподключиться"}
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={removingEnvironmentId === environmentId}
            onClick={() => void onRemove(environmentId)}
          >
            {removingEnvironmentId === environmentId ? "Удаление…" : "Удалить"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const [currentSessionRole, setCurrentSessionRole] = useState<"owner" | "client" | null>(
    desktopBridge ? "owner" : null,
  );
  const [currentAuthPolicy, setCurrentAuthPolicy] = useState<
    "desktop-managed-local" | "loopback-browser" | "remote-reachable" | "unsafe-no-auth" | null
  >(desktopBridge ? null : null);
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentIds = useMemo(
    () =>
      Object.values(savedEnvironmentsById)
        .toSorted((left, right) => left.label.localeCompare(right.label))
        .map((record) => record.environmentId),
    [savedEnvironmentsById],
  );

  const [desktopServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
  const [desktopServerExposureError, setDesktopServerExposureError] = useState<string | null>(null);
  const [desktopPairingLinks, setDesktopPairingLinks] = useState<
    ReadonlyArray<ServerPairingLinkRecord>
  >([]);
  const [desktopClientSessions, setDesktopClientSessions] = useState<
    ReadonlyArray<ServerClientSessionRecord>
  >([]);
  const [desktopAccessManagementError, setDesktopAccessManagementError] = useState<string | null>(
    null,
  );
  const [isLoadingDesktopAccessManagement, setIsLoadingDesktopAccessManagement] = useState(false);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [savedBackendMode, setSavedBackendMode] = useState<"pairing-url" | "host-code">(
    "pairing-url",
  );
  const [savedBackendLabel, setSavedBackendLabel] = useState("");
  const [savedBackendPairingUrl, setSavedBackendPairingUrl] = useState("");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [reconnectingSavedEnvironmentId, setReconnectingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const canManageLocalBackend = currentSessionRole === "owner";
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureError(null);
      try {
        const nextState = await desktopBridge.setServerExposureMode(
          checked ? "network-accessible" : "local-only",
        );
        setDesktopServerExposureState(nextState);
        setPendingDesktopServerExposureMode(null);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update network exposure.";
        setPendingDesktopServerExposureMode(null);
        setDesktopServerExposureError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Другим связанным клиентам потребуется новая ссылка перед переподключением.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const handleAddSavedBackend = useCallback(async () => {
    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    try {
      const record = await addSavedEnvironment({
        label: savedBackendLabel,
        ...(savedBackendMode === "pairing-url"
          ? { pairingUrl: savedBackendPairingUrl }
          : {
              host: savedBackendHost,
              pairingCode: savedBackendPairingCode,
            }),
      });
      setSavedBackendLabel("");
      setSavedBackendPairingUrl("");
      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setAddBackendDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Backend added",
        description: `${record.label} is now saved and will reconnect on app startup.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Не удалось добавить бэкенд",
          description: message,
        }),
      );
    } finally {
      setIsAddingSavedBackend(false);
    }
  }, [
    savedBackendHost,
    savedBackendLabel,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendPairingUrl,
  ]);

  const handleReconnectSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setReconnectingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await reconnectSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconnect backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect backend",
          description: message,
        }),
      );
    } finally {
      setReconnectingSavedEnvironmentId(null);
    }
  }, []);

  const handleRemoveSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await removeSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    } finally {
      setRemovingSavedEnvironmentId(null);
    }
  }, []);

  useEffect(() => {
    if (desktopBridge) {
      setCurrentSessionRole("owner");
      return;
    }

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setCurrentSessionRole(session.authenticated ? (session.role ?? null) : null);
        setCurrentAuthPolicy(session.auth.policy);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentSessionRole(null);
        setCurrentAuthPolicy(null);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!canManageLocalBackend) return;

    let cancelled = false;
    setIsLoadingDesktopAccessManagement(true);
    type AuthAccessEvent = Parameters<
      Parameters<WsRpcClient["server"]["subscribeAuthAccess"]>[0]
    >[0];
    const unsubscribeAuthAccess =
      getPrimaryEnvironmentConnection().client.server.subscribeAuthAccess(
        (event: AuthAccessEvent) => {
          if (cancelled) {
            return;
          }

          switch (event.type) {
            case "snapshot":
              setDesktopPairingLinks(
                sortDesktopPairingLinks(
                  event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
                    toDesktopPairingLinkRecord(pairingLink),
                  ),
                ),
              );
              setDesktopClientSessions(
                sortDesktopClientSessions(
                  event.payload.clientSessions.map((clientSession: AuthClientSession) =>
                    toDesktopClientSessionRecord(clientSession),
                  ),
                ),
              );
              break;
            case "pairingLinkUpserted":
              setDesktopPairingLinks((current) =>
                upsertDesktopPairingLink(current, toDesktopPairingLinkRecord(event.payload)),
              );
              break;
            case "pairingLinkRemoved":
              setDesktopPairingLinks((current) =>
                removeDesktopPairingLink(current, event.payload.id),
              );
              break;
            case "clientUpserted":
              setDesktopClientSessions((current) =>
                upsertDesktopClientSession(current, toDesktopClientSessionRecord(event.payload)),
              );
              break;
            case "clientRemoved":
              setDesktopClientSessions((current) =>
                removeDesktopClientSession(current, event.payload.sessionId),
              );
              break;
          }

          setDesktopAccessManagementError(null);
          setIsLoadingDesktopAccessManagement(false);
        },
        {
          onResubscribe: () => {
            if (!cancelled) {
              setIsLoadingDesktopAccessManagement(true);
            }
          },
        },
      );
    if (desktopBridge) {
      void desktopBridge
        .getServerExposureState()
        .then((state) => {
          if (cancelled) return;
          setDesktopServerExposureState(state);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : "Failed to load network exposure state.";
          setDesktopServerExposureError(message);
        });
    } else {
      setDesktopServerExposureState(null);
      setDesktopServerExposureError(null);
    }

    return () => {
      cancelled = true;
      unsubscribeAuthAccess();
    };
  }, [canManageLocalBackend, desktopBridge]);

  useEffect(() => {
    if (canManageLocalBackend) return;
    setIsLoadingDesktopAccessManagement(false);
    setDesktopPairingLinks([]);
    setDesktopClientSessions([]);
    setDesktopAccessManagementError(null);
    setDesktopServerExposureState(null);
    setDesktopServerExposureError(null);
  }, [canManageLocalBackend]);
  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection title="Управление локальным бэкендом">
            {desktopBridge ? (
              <SettingsRow
                title="Доступ к сети"
                description={
                  desktopServerExposureState?.endpointUrl
                    ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                    : desktopServerExposureState?.mode === "network-accessible"
                      ? desktopServerExposureState.advertisedHost
                        ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                        : "Exposed on all interfaces."
                      : desktopServerExposureState
                        ? "Limited to this machine."
                        : "Loading…"
                }
                status={
                  desktopServerExposureError ? (
                    <span className="block text-destructive">{desktopServerExposureError}</span>
                  ) : null
                }
                control={
                  <AlertDialog
                    open={pendingDesktopServerExposureMode !== null}
                    onOpenChange={(open) => {
                      if (isUpdatingDesktopServerExposure) return;
                      if (!open) setPendingDesktopServerExposureMode(null);
                    }}
                  >
                    <Switch
                      checked={desktopServerExposureState?.mode === "network-accessible"}
                      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
                      onCheckedChange={(checked) => {
                        setPendingDesktopServerExposureMode(
                          checked ? "network-accessible" : "local-only",
                        );
                      }}
                      aria-label="Enable network access"
                    />
                    <AlertDialogPopup>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {pendingDesktopServerExposureMode === "network-accessible"
                            ? "Enable network access?"
                            : "Disable network access?"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {pendingDesktopServerExposureMode === "network-accessible"
                            ? "T3 Code will restart to expose this environment over the network."
                            : "T3 Code will restart and limit this environment back to this machine."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose
                          disabled={isUpdatingDesktopServerExposure}
                          render={
                            <Button variant="outline" disabled={isUpdatingDesktopServerExposure} />
                          }
                        >
                          Отмена
                        </AlertDialogClose>
                        <Button
                          onClick={handleConfirmDesktopServerExposureChange}
                          disabled={
                            pendingDesktopServerExposureMode === null ||
                            isUpdatingDesktopServerExposure
                          }
                        >
                          {isUpdatingDesktopServerExposure ? (
                            <>
                              <Spinner className="size-3.5" />
                              Restarting…
                            </>
                          ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                            "Restart and enable"
                          ) : (
                            "Restart and disable"
                          )}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogPopup>
                  </AlertDialog>
                }
              />
            ) : (
              <SettingsRow
                title="Доступ к сети"
                description={
                  currentAuthPolicy === "remote-reachable"
                    ? "Этот бэкенд уже настроен для удалённого доступа. Изменения сетевого доступа выполняются там, где запущен сервер."
                    : "Этот бэкенд доступен только на этой машине. Перезапустите его с не-loopback хостом для удалённой связки."
                }
                control={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <Switch
                            checked={isLocalBackendNetworkAccessible}
                            disabled
                            aria-label="Enable network access"
                          />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">
                      Network exposure changes restart the backend and must be controlled where the
                      server process is launched.
                    </TooltipPopup>
                  </Tooltip>
                }
              />
            )}
          </SettingsSection>

          {isLocalBackendNetworkAccessible ? (
            <SettingsSection
              title="Авторизованные клиенты"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              {desktopAccessManagementError ? (
                <div className={ITEM_ROW_CLASSNAME}>
                  <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
                </div>
              ) : null}
              <PairingClientsList
                endpointUrl={desktopServerExposureState?.endpointUrl}
                isLoading={isLoadingDesktopAccessManagement}
                pairingLinks={visibleDesktopPairingLinks}
                clientSessions={desktopClientSessions}
                revokingPairingLinkId={revokingDesktopPairingLinkId}
                revokingClientSessionId={revokingDesktopClientSessionId}
                onRevokePairingLink={handleRevokeDesktopPairingLink}
                onRevokeClientSession={handleRevokeDesktopClientSession}
              />
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <SettingsSection title="Local backend access">
          <SettingsRow
            title="Owner tools"
            description="Pairing links and client-session management are only available to owner sessions for this backend."
          />
        </SettingsSection>
      )}

      <SettingsSection
        title="Удалённые бэкенды"
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) => {
              setAddBackendDialogOpen(open);
              if (!open) {
                setSavedBackendError(null);
              }
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <DialogTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
                        aria-label="Добавить бэкенд"
                      >
                        <PlusIcon className="size-3" />
                        <span>Добавить бэкенд</span>
                      </Button>
                    }
                  />
                }
              />
              <TooltipPopup side="top">Добавить бэкенд</TooltipPopup>
            </Tooltip>
            <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Добавить бэкенд</DialogTitle>
                <DialogDescription>Свяжите другой бэкенд с этим клиентом.</DialogDescription>
                <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/50 p-1">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "pairing-url"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("pairing-url")}
                  >
                    URL связки
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "host-code"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("host-code")}
                  >
                    Хост + код
                  </button>
                </div>
              </DialogHeader>
              <DialogPanel>
                <AnimatedHeight>
                  <div className="space-y-4">
                    {savedBackendMode === "pairing-url" ? (
                      <p className="text-xs text-muted-foreground">
                        Введите полный URL связки от бэкенда, к которому хотите подключиться.
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Введите хост бэкенда и код связки отдельно.
                      </p>
                    )}
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Название
                        </span>
                        <Input
                          value={savedBackendLabel}
                          onChange={(event) => setSavedBackendLabel(event.target.value)}
                          placeholder="Мой бэкенд (необязательно)"
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                      </label>
                      {savedBackendMode === "pairing-url" ? (
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            URL связки
                          </span>
                          <Input
                            value={savedBackendPairingUrl}
                            onChange={(event) => setSavedBackendPairingUrl(event.target.value)}
                            placeholder="https://backend.example.com/pair#token=..."
                            disabled={isAddingSavedBackend}
                            spellCheck={false}
                          />
                          <span className="mt-1 block text-[11px] text-muted-foreground">
                            Полный URL вместе с токеном связки.
                          </span>
                        </label>
                      ) : (
                        <>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              Хост
                            </span>
                            <Input
                              value={savedBackendHost}
                              onChange={(event) => setSavedBackendHost(event.target.value)}
                              placeholder="https://backend.example.com"
                              disabled={isAddingSavedBackend}
                              spellCheck={false}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              Код связки
                            </span>
                            <Input
                              value={savedBackendPairingCode}
                              onChange={(event) => setSavedBackendPairingCode(event.target.value)}
                              placeholder="Код связки"
                              disabled={isAddingSavedBackend}
                              spellCheck={false}
                            />
                          </label>
                        </>
                      )}
                    </div>
                    {savedBackendError ? (
                      <p className="text-xs text-destructive">{savedBackendError}</p>
                    ) : null}
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={isAddingSavedBackend}
                      onClick={() => void handleAddSavedBackend()}
                    >
                      <PlusIcon className="size-3.5" />
                      {isAddingSavedBackend ? "Добавление…" : "Добавить бэкенд"}
                    </Button>
                  </div>
                </AnimatedHeight>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironmentIds.map((environmentId) => (
          <SavedBackendListRow
            key={environmentId}
            environmentId={environmentId}
            reconnectingEnvironmentId={reconnectingSavedEnvironmentId}
            removingEnvironmentId={removingSavedEnvironmentId}
            onReconnect={handleReconnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}

        {savedEnvironmentIds.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              Удалённых бэкендов пока нет. Нажмите «Добавить бэкенд», чтобы связать ещё один.
            </p>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
