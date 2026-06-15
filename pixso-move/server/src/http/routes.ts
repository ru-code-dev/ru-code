import * as Layer from "effect/Layer";

import { ingestRoute } from "./ingest.ts";
import { getNodeRoute, listNodesRoute } from "./nodes.ts";
import { processingDataRoute } from "./processing.ts";

// All routes merged. CORS middleware is provided alongside in server.ts.
export const routesLayer = Layer.mergeAll(
  ingestRoute,
  listNodesRoute,
  getNodeRoute,
  processingDataRoute,
);
