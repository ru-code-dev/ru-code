/**
 * Pixso Move — React Query hooks over {@link api}. The gallery only fetches after the user
 * presses refresh (gated by `nonce`); detail data fetches on demand when a node is open.
 */

import { useQuery } from "@tanstack/react-query";

import { fetchNode, fetchNodes, fetchProcessing } from "./api";

const root = ["pixso-move"] as const;

export const pixsoQueryKeys = {
  nodes: (serverUrl: string, designerId: string, nonce: number) =>
    [...root, "nodes", serverUrl, designerId, nonce] as const,
  node: (serverUrl: string, designerId: string, nodeId: string) =>
    [...root, "node", serverUrl, designerId, nodeId] as const,
  processing: (serverUrl: string, designerId: string, nodeId: string) =>
    [...root, "processing", serverUrl, designerId, nodeId] as const,
};

export function usePixsoNodes(serverUrl: string, designerId: string, nonce: number) {
  return useQuery({
    queryKey: pixsoQueryKeys.nodes(serverUrl, designerId, nonce),
    queryFn: () => fetchNodes(serverUrl, designerId),
    enabled: designerId.trim().length > 0 && nonce > 0,
  });
}

export function usePixsoNode(serverUrl: string, designerId: string, nodeId: string | null) {
  return useQuery({
    queryKey: pixsoQueryKeys.node(serverUrl, designerId, nodeId ?? ""),
    queryFn: () => fetchNode(serverUrl, designerId, nodeId as string),
    enabled: nodeId !== null && designerId.trim().length > 0,
  });
}

export function usePixsoProcessing(serverUrl: string, designerId: string, nodeId: string | null) {
  return useQuery({
    queryKey: pixsoQueryKeys.processing(serverUrl, designerId, nodeId ?? ""),
    queryFn: () => fetchProcessing(serverUrl, designerId, nodeId as string),
    enabled: nodeId !== null && designerId.trim().length > 0,
  });
}
