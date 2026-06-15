import { describe, expect, it } from "vitest";

import * as Contracts from "../src/index.ts";

describe("index barrel", () => {
  it("re-exports the public schemas and errors", () => {
    expect(Contracts.DesignerId).toBeDefined();
    expect(Contracts.NodeId).toBeDefined();
    expect(Contracts.ResultTag).toBeDefined();
    expect(Contracts.IngestRequest).toBeDefined();
    expect(Contracts.IngestResponse).toBeDefined();
    expect(Contracts.NodeSummary).toBeDefined();
    expect(Contracts.NodeRecord).toBeDefined();
    expect(Contracts.ProcessingResult).toBeDefined();
    expect(Contracts.ProcessingStatus).toBeDefined();
    expect(Contracts.AuthError).toBeDefined();
    expect(Contracts.IngestError).toBeDefined();
    expect(Contracts.NodeNotFoundError).toBeDefined();
    expect(Contracts.Base64Png).toBeDefined();
    expect(Contracts.TrimmedNonEmptyString).toBeDefined();
    expect(Contracts.NonNegativeInt).toBeDefined();
  });
});
