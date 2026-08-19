import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { EXIT_DRAIN_GRACE_MS } from "./constants.ts";

// ru-code: end a child's stdio stream when the PROCESS EXITS (+ a short drain),
// instead of waiting for stdio EOF — which AV / a git daemon / a stuck
// async `end` can hold open. exitCode resolves on the Node "exit" event,
// independent of the pipe. On a healthy machine EOF ends the stream first → zero
// added latency, identical output.
export const haltOnExit =
  <X, XE>(exitCode: Effect.Effect<X, XE>) =>
  <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E> =>
    stream.pipe(
      Stream.interruptWhen(
        // Effect.ignore: settle on exit success OR failure (we only want the
        // timing); never let the signal fail the stream.
        exitCode.pipe(
          Effect.ignore,
          Effect.flatMap(() => Effect.sleep(Duration.millis(EXIT_DRAIN_GRACE_MS))),
        ),
      ),
    );
