/**
 * Pixso Move — typed HTTP client for the pixso-move server (a separate Effect/sqlite service,
 * default http://127.0.0.1:7787). Every read is gated by the `x-designer-id` header, which is
 * the designer's shared key. Kept dependency-free (plain fetch) and isolated in ru-fork.
 */

export interface PixsoNodeSummary {
  readonly nodeId: string;
  readonly rootName: string;
  readonly addedAt: string;
  /** base64 PNG (no data: prefix). */
  readonly preview: string;
}

export interface PixsoNodeRecord {
  readonly nodeId: string;
  readonly designerId: string;
  readonly rootName: string;
  readonly nodesJson: string;
  readonly preview: string;
  readonly addedAt: string;
}

export type PixsoProcessingStatus = "pending" | "processing" | "done" | "error";

export interface PixsoProcessingResult {
  readonly nodeId: string;
  readonly resultTag: string;
  readonly status: PixsoProcessingStatus;
  readonly attempts: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

const base = (serverUrl: string): string => serverUrl.trim().replace(/\/+$/, "");

const getJson = async <T>(serverUrl: string, designerId: string, path: string): Promise<T> => {
  const response = await fetch(`${base(serverUrl)}${path}`, {
    headers: { "x-designer-id": designerId },
  });
  if (!response.ok) {
    throw new Error(`Сервер ответил ${response.status}`);
  }
  return (await response.json()) as T;
};

export const fetchNodes = (serverUrl: string, designerId: string) =>
  getJson<ReadonlyArray<PixsoNodeSummary>>(serverUrl, designerId, "/nodes");

export const fetchNode = (serverUrl: string, designerId: string, nodeId: string) =>
  getJson<PixsoNodeRecord>(serverUrl, designerId, `/node?id=${encodeURIComponent(nodeId)}`);

export const fetchProcessing = (serverUrl: string, designerId: string, nodeId: string) =>
  getJson<ReadonlyArray<PixsoProcessingResult>>(
    serverUrl,
    designerId,
    `/processing-data?nodeId=${encodeURIComponent(nodeId)}`,
  );

export const previewDataUrl = (preview: string): string => `data:image/png;base64,${preview}`;
