/**
 * ru-fork: Analytics — keeps the store's session set in sync with the server.
 *
 * Two server ops, two triggers, nothing on a timer:
 *  - **Open the panel** → `getSnapshot` (instant read of the last-saved data) then
 *    `refresh` (scan disk, re-parse changed files, return current). A failed refresh
 *    keeps the read's data on screen — it never blanks.
 *  - **⟳ button** (bumps `refreshNonce`) → `refresh` only.
 *
 * @module ru-fork/stats/useStatsData
 */
import { useEffect, useRef } from "react";

import type { StatsSnapshot } from "@t3tools/contracts";

import { readEnvironmentConnection } from "~/environments/runtime/service";
import { usePrimaryEnvironmentId } from "~/environments/primary/context";
import { useStatsStore } from "./store";

export function useStatsData(): void {
  const environmentId = usePrimaryEnvironmentId();
  const refreshNonce = useStatsStore((state) => state.refreshNonce);
  const setSnapshot = useStatsStore((state) => state.setSnapshot);
  const setStatus = useStatsStore((state) => state.setStatus);
  const previousNonce = useRef(refreshNonce);

  useEffect(() => {
    if (!environmentId) return;
    const connection = readEnvironmentConnection(environmentId);
    if (!connection) return;
    let cancelled = false;

    const apply = (snapshot: StatsSnapshot) => {
      if (cancelled) return;
      setSnapshot(snapshot.sessions, Date.parse(snapshot.generatedAt));
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      // Status-only — the last good data stays on screen.
      setStatus("error", error instanceof Error ? error.message : "Не удалось обновить статистику");
    };
    const runRefresh = () => connection.client.stats.refresh({}).then(apply).catch(fail);

    // A nonce change means the ⟳ button was pressed → refresh only. Otherwise this
    // is an open (mount or primary-environment change) → instant read, then refresh.
    const forced = refreshNonce !== previousNonce.current;
    previousNonce.current = refreshNonce;

    setStatus("loading");
    if (forced) {
      void runRefresh();
    } else {
      connection.client.stats
        .getSnapshot({})
        .then(apply)
        .catch(() => {
          // An empty/failed read is fine — the refresh below populates or reports.
        })
        .finally(() => {
          if (!cancelled) void runRefresh();
        });
    }

    return () => {
      cancelled = true;
    };
  }, [environmentId, refreshNonce, setSnapshot, setStatus]);
}
