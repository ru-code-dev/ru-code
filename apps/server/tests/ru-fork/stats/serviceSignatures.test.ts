import { assert, it } from "@effect/vitest";

import { SERVICE_SIGNATURES } from "../../../src/ru-fork/stats/serviceSignatures.ts";

// Drift guard: each marker MUST be a substring of the instruction it stands for. If a
// text-generation prompt is reworded past its marker, this fails loudly here instead of
// silently misclassifying those sessions as "service".
it("every service marker is a substring of its instruction", () => {
  for (const signature of SERVICE_SIGNATURES) {
    assert.isTrue(
      signature.instruction.includes(signature.marker),
      `${signature.category}: marker "${signature.marker}" is not in its instruction`,
    );
  }
});

it("covers exactly the four text-generation categories", () => {
  assert.deepEqual(
    SERVICE_SIGNATURES.map((signature) => signature.category).toSorted(),
    ["branch", "commit", "pr", "title"],
  );
});
