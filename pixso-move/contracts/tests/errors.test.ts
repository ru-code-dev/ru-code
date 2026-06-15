import { describe, expect, it } from "vitest";

import { AuthError, IngestError, NodeNotFoundError } from "../src/errors.ts";

describe("tagged errors", () => {
  it("AuthError carries tag, message, status", () => {
    const e = new AuthError({ message: "no key", status: 401 });
    expect(e._tag).toBe("AuthError");
    expect(e.message).toBe("no key");
    expect(e.status).toBe(401);
  });
  it("IngestError carries tag, message, status", () => {
    const e = new IngestError({ message: "bad body", status: 400 });
    expect(e._tag).toBe("IngestError");
    expect(e.status).toBe(400);
  });
  it("NodeNotFoundError carries tag, message, status", () => {
    const e = new NodeNotFoundError({ message: "missing", status: 404 });
    expect(e._tag).toBe("NodeNotFoundError");
    expect(e.status).toBe(404);
  });
});
