# Task 2 — Contracts (`@pixso-move/contracts`)

All cross-package shapes as **effect Schema**. Server decodes/validates with them; processor reuses
row types; plugin imports request types. TDD: decode/encode tests first. Uses the **confirmed**
Schema API (conventions §4) — no hedging.

## File budget (all ≤ 150 LOC, single-responsibility)
| Path | Responsibility | est. LOC |
|---|---|---|
| `src/base.ts` | shared primitives copied from ru-fork `baseSchemas.ts` (`TrimmedString`, `TrimmedNonEmptyString`, `NonNegativeInt`) | ~16 |
| `src/ids.ts` | `DesignerId`, `NodeId`, `ResultTag` (branded) | ~18 |
| `src/ingest.ts` | `Base64Png`, `IngestRequest`, `IngestResponse` | ~22 |
| `src/node.ts` | `NodeSummary`, `NodeRecord` | ~18 |
| `src/processing.ts` | `ProcessingStatus`, `ProcessingResult` | ~20 |
| `src/errors.ts` | `AuthError`, `IngestError`, `NodeNotFoundError` | ~18 |
| `src/index.ts` | re-export all | ~8 |
| `tests/*.test.ts` | one per src module | — |

## `src/base.ts` (copied utility — DRY primitive source)
```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.transformOrFail({
    decode: (v) => Effect.succeed(v.trim()), encode: (v) => Effect.succeed(v.trim()),
  })),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
```
> Verbatim from `packages/contracts/src/baseSchemas.ts:5-15`. Header-mark it `// pixso-move: copied
> from ru-fork baseSchemas.ts`. (Small enough to own; keeps `@pixso-move/contracts` standalone.)

## `src/ids.ts`
```ts
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base.ts";
const makeId = <B extends string>(b: B) => TrimmedNonEmptyString.pipe(Schema.brand(b));

export const DesignerId = makeId("DesignerId").check(Schema.isMaxLength(200));
export const NodeId = makeId("NodeId");
export const ResultTag = makeId("ResultTag").check(Schema.isMaxLength(64));
export type DesignerId = typeof DesignerId.Type;
export type NodeId = typeof NodeId.Type;
export type ResultTag = typeof ResultTag.Type;
```

## `src/ingest.ts`
```ts
export const Base64Png = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8 * 1024 * 1024));
export const IngestRequest = Schema.Struct({
  designerId: DesignerId,
  rootName: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  nodesJson: Schema.String.check(Schema.isMinLength(2)),   // opaque JSON string, stored verbatim
  preview: Base64Png,
});
export const IngestResponse = Schema.Struct({ nodeId: NodeId });
```

## `src/node.ts`
```ts
export const NodeSummary = Schema.Struct({
  nodeId: NodeId, rootName: Schema.String, addedAt: Schema.String, preview: Base64Png });
export const NodeRecord = Schema.Struct({
  nodeId: NodeId, designerId: DesignerId, rootName: Schema.String,
  nodesJson: Schema.String, preview: Base64Png, addedAt: Schema.String });
```

## `src/processing.ts`
```ts
export const ProcessingStatus = Schema.Literals(["pending", "processing", "done", "error"]);
export const ProcessingResult = Schema.Struct({
  nodeId: NodeId, resultTag: ResultTag, status: ProcessingStatus, attempts: NonNegativeInt,
  result: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String),
  createdAt: Schema.String, startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String) });
```

## `src/errors.ts`
```ts
export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError",
  { message: Schema.String, status: Schema.Int }) {}          // 401
export class IngestError extends Schema.TaggedErrorClass<IngestError>()("IngestError",
  { message: Schema.String, status: Schema.Int }) {}          // 400 | 413
export class NodeNotFoundError extends Schema.TaggedErrorClass<NodeNotFoundError>()(
  "NodeNotFoundError", { message: Schema.String, status: Schema.Int }) {}   // 404
```

## TDD — tests first (100%)
Use `Schema.decodeUnknownExit(schema)(input)` and assert `Exit.isSuccess`/`Exit.isFailure`
(idiom from `packages/shared/src/schemaJson.ts`).

- **happy decode** per schema → branded/typed value; `TrimmedNonEmptyString` trims.
- **reject** per refinement: empty string, over-max (`DesignerId>200`, `ResultTag>64`,
  `rootName>512`, `preview>8MB`), `nodesJson` length <2, wrong `status` literal, missing field.
  Each `.check` branch is exercised (→ 100% branches).
- **errors**: each `TaggedError` carries `_tag`/`message`/`status`.

## Acceptance
- [ ] Confirmed Schema API only; all valid inputs decode, all invalid rejected (tested).
- [ ] Each file ≤150 LOC, single-purpose; primitives sourced once from `base.ts`.
- [ ] 100% coverage; `tsc`/oxlint clean; shapes exactly match [00-overview.md](./00-overview.md).
