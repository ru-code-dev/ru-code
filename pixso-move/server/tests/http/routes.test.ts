import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brokenNodeStore, jsonRequest, makeHandler } from "./harness.ts";

const key = "dz_alice";
const body = { designerId: key, rootName: "Card", nodesJson: '{"id":"1"}', preview: "iVBOR" };

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

const setup = (broken = false) => {
  const built = broken ? makeHandler(brokenNodeStore) : makeHandler();
  handler = built.handler;
  dispose = built.dispose;
};

afterEach(() => dispose());

describe("POST /ingest", () => {
  beforeEach(() => setup());

  it("stores a node and returns its id", async () => {
    const res = await handler(jsonRequest("POST", "/ingest", key, body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { nodeId: string };
    expect(typeof json.nodeId).toBe("string");
  });

  it("rejects a missing key with 401", async () => {
    const res = await handler(jsonRequest("POST", "/ingest", undefined, body));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await handler(jsonRequest("POST", "/ingest", key, { designerId: key }));
    expect(res.status).toBe(400);
  });

  it("rejects a key/body mismatch with 401", async () => {
    const res = await handler(jsonRequest("POST", "/ingest", key, { ...body, designerId: "dz_x" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /nodes and /node", () => {
  beforeEach(() => setup());

  it("lists summaries and fetches one by id", async () => {
    const created = (await (await handler(jsonRequest("POST", "/ingest", key, body))).json()) as {
      nodeId: string;
    };
    const list = await handler(jsonRequest("GET", "/nodes", key));
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const one = await handler(jsonRequest("GET", `/node?id=${created.nodeId}`, key));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { rootName: string }).rootName).toBe("Card");
  });

  it("401 without a key, 400 without an id, 404 for an unknown id", async () => {
    expect((await handler(jsonRequest("GET", "/nodes", undefined))).status).toBe(401);
    expect((await handler(jsonRequest("GET", "/node", key))).status).toBe(400);
    expect((await handler(jsonRequest("GET", "/node?id=missing", key))).status).toBe(404);
  });
});

describe("GET /processing-data", () => {
  beforeEach(() => setup());

  it("returns an empty array for a valid node with no results", async () => {
    const created = (await (await handler(jsonRequest("POST", "/ingest", key, body))).json()) as {
      nodeId: string;
    };
    const res = await handler(jsonRequest("GET", `/processing-data?nodeId=${created.nodeId}`, key));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("400 for a missing nodeId, 404 for an unknown node", async () => {
    expect((await handler(jsonRequest("GET", "/processing-data", key))).status).toBe(400);
    expect((await handler(jsonRequest("GET", "/processing-data?nodeId=missing", key))).status).toBe(
      404,
    );
  });
});

describe("resilience and CORS", () => {
  it("returns 500 (not a crash) when a store defects", async () => {
    setup(true);
    const res = await handler(jsonRequest("GET", "/nodes", key));
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it("answers CORS preflight with the allowed headers", async () => {
    setup();
    const res = await handler(
      new Request("http://test/ingest", {
        method: "OPTIONS",
        headers: { origin: "http://x", "access-control-request-method": "POST" },
      }),
    );
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
