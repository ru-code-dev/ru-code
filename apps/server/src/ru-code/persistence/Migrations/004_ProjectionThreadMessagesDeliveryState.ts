// ru-code (mid-turn wave, P3b): the delivery mark for a message the user sent
// while a turn was running — pending → delivered → not-delivered.
//
// Nullable, no default: NULL = "an ordinary message", which is the
// overwhelmingly common case and the state every existing row keeps. Only a
// message that went through the mid-turn queue ever carries a value, so nothing
// already stored changes meaning. Same shape as fork migration 002
// (chat_view_mode), for the same reason.
//
// This lives in the FORK-OWNED migration space (`ru_code_migrations`), so it
// cannot collide with an upstream migration id on the next t3 resync.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN delivery_state TEXT
  `;
});
