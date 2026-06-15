import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

// Test helper: decode `input` through `schema`, returning the success value or
// throwing if it failed (for happy-path assertions).
export const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown): A => {
  const exit = Schema.decodeUnknownExit(schema)(input);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected decode to succeed: ${JSON.stringify(input)}`);
  }
  return exit.value;
};

// Test helper: true iff decoding `input` through `schema` fails.
export const rejects = <A, I>(schema: Schema.Codec<A, I>, input: unknown): boolean =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

// Test helper: encode `value` (A → I), throwing if it fails.
export const encode = <A, I>(schema: Schema.Codec<A, I>, value: unknown): I => {
  const exit = Schema.encodeUnknownExit(schema)(value);
  if (Exit.isFailure(exit)) {
    throw new Error(`expected encode to succeed: ${JSON.stringify(value)}`);
  }
  return exit.value;
};
