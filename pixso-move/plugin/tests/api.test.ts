import { describe, expect, it } from "vitest";

import { buildIngestRequest, sendToServer } from "../src/ui/api.ts";
import type { Settings } from "../src/ui/state/types.ts";

const settings: Settings = {
  serverUrl: "http://localhost:7787/",
  designerId: "dz_alice",
  themeName: "pastel-dreams",
  themeMode: "system",
};
const payload = {
  designerId: "dz_alice",
  rootName: "Hero",
  nodesJson: "{}",
  preview: "AAAA",
};

describe("buildIngestRequest", () => {
  it("joins the url, sets headers and a matching body", () => {
    const plan = buildIngestRequest(settings, payload);
    expect(plan.url).toBe("http://localhost:7787/ingest");
    expect(plan.headers["x-designer-id"]).toBe("dz_alice");
    expect(plan.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(plan.body)).toEqual({
      designerId: "dz_alice",
      rootName: "Hero",
      nodesJson: "{}",
      preview: "AAAA",
    });
  });
});

const fakeFetch = (status: number, body: string): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })) as unknown as typeof fetch;

describe("sendToServer", () => {
  it("maps a 200 to success with nodeId", async () => {
    const result = await sendToServer(settings, payload, fakeFetch(200, '{"nodeId":"n1"}'));
    expect(result).toEqual({ ok: true, nodeId: "n1" });
  });

  it("surfaces a 4xx body verbatim", async () => {
    const result = await sendToServer(settings, payload, fakeFetch(400, "bad request"));
    expect(result).toEqual({ ok: false, message: "bad request" });
  });

  it("maps a network throw to a failure", async () => {
    const throwing = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const result = await sendToServer(settings, payload, throwing);
    expect(result).toEqual({ ok: false, message: "offline" });
  });
});
