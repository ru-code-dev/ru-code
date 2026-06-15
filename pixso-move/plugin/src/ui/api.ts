import type { Settings, SendResult } from "./state/types.ts";

export const DEFAULT_SERVER_URL = "http://localhost:7787";

export interface Collected {
  readonly designerId: string;
  readonly rootName: string;
  readonly nodesJson: string;
  readonly preview: string;
}

export interface IngestRequestPlan {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const joinIngestUrl = (serverUrl: string): string =>
  `${serverUrl.replace(/\/+$/, "")}/ingest`;

// Pure: turn settings + collected payload into the exact POST /ingest request.
export const buildIngestRequest = (settings: Settings, payload: Collected): IngestRequestPlan => ({
  url: joinIngestUrl(settings.serverUrl),
  headers: {
    "content-type": "application/json",
    "x-designer-id": settings.designerId,
  },
  body: JSON.stringify({
    designerId: settings.designerId,
    rootName: payload.rootName,
    nodesJson: payload.nodesJson,
    preview: payload.preview,
  }),
});

type FetchImpl = typeof fetch;

// Send the ingest request. Server errors are surfaced verbatim; success returns nodeId.
export const sendToServer = async (
  settings: Settings,
  payload: Collected,
  fetchImpl: FetchImpl = fetch,
): Promise<SendResult> => {
  const plan = buildIngestRequest(settings, payload);
  try {
    const response = await fetchImpl(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: plan.body,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, message: text || `HTTP ${response.status}` };
    const parsed = JSON.parse(text) as { nodeId?: unknown };
    const nodeId = typeof parsed.nodeId === "string" ? parsed.nodeId : "";
    return { ok: true, nodeId };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};
