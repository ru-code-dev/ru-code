// ru-fork: advanced chat mode — subscribe to the server's qwen-transcript stream for
// a thread and keep the records in local state. Self-contained: reuses the exported
// environment-connection registry (no store.ts / service.ts changes). Re-attaches if
// the environment connection object is replaced (full reconnect).
import type { EnvironmentId, ThreadId, TranscriptRecord } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "~/environments/runtime/service";

export function useTranscriptSubscription(
  environmentId: EnvironmentId | undefined,
  threadId: ThreadId | undefined,
  enabled: boolean,
): ReadonlyArray<TranscriptRecord> {
  const [records, setRecords] = useState<ReadonlyArray<TranscriptRecord>>([]);

  useEffect(() => {
    if (!enabled || !environmentId || !threadId) {
      setRecords([]);
      return;
    }
    setRecords([]);

    let unsubscribe = () => {};
    let attachedTo: unknown = null;

    const attach = () => {
      const connection = readEnvironmentConnection(environmentId);
      if (!connection || connection === attachedTo) return;
      unsubscribe();
      attachedTo = connection;
      unsubscribe = connection.client.orchestration.subscribeTranscript({ threadId }, (item) => {
        if (item.kind === "snapshot") {
          setRecords(item.records);
        } else {
          setRecords((previous) => [...previous, ...item.records]);
        }
      });
    };

    attach();
    const unsubscribeConnections = subscribeEnvironmentConnections(attach);
    return () => {
      unsubscribe();
      unsubscribeConnections();
    };
  }, [environmentId, threadId, enabled]);

  return records;
}
