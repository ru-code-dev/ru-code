import { getPairingTokenFromUrl } from "../../pairingUrl";

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function normalizeRemoteBaseUrl(rawValue: string): URL {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Введите URL бэкенда.");
  }

  const normalizedInput =
    /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) || trimmed.startsWith("//")
      ? trimmed
      : `https://${trimmed}`;
  const url = new URL(normalizedInput, window.location.origin);
  // ru-fork: preserve the path portion the user typed (it may
  // encode a reverse-proxy prefix like /services/u001/my-app); only
  // strip a trailing slash.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  url.search = "";
  url.hash = "";
  return url;
}

// ru-fork: a pairing URL ends in "/pair"; strip that suffix when
// converting to a base URL so we're left with just the proxy prefix
// (which may be empty / "/").
function stripPairSuffixAndTrailingSlash(url: URL): void {
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/pair")) {
    path = path.slice(0, -"/pair".length);
  }
  url.pathname = path.length === 0 ? "/" : path;
}

function toHttpBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  stripPairSuffixAndTrailingSlash(next);
  next.search = "";
  next.hash = "";
  return next.toString();
}

function toWsBaseUrl(url: URL): string {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  stripPairSuffixAndTrailingSlash(next);
  next.search = "";
  next.hash = "";
  return next.toString();
}

export function resolveRemotePairingTarget(input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    const url = new URL(pairingUrl, window.location.origin);
    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new Error("Pairing URL is missing its token.");
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new Error("Введите URL бэкенда.");
  }
  if (!pairingCode) {
    throw new Error("Введите код связки.");
  }

  const normalizedHost = normalizeRemoteBaseUrl(host);
  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
}
