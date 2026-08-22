// ru-code: per-thread chat-view choice (compact | detailed) becomes thread state
// (plan-mode parity). Nullable, no default: NULL = "user never chose" — the client
// falls back to the settings default, so existing rows keep their behavior.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN chat_view_mode TEXT
  `;
});
