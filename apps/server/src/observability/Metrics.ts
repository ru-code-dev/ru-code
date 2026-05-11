import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import { dual } from "effect/Function";

export const orchestrationCommandsTotal = Metric.counter(
  "ru_fork_orchestration_commands_total",
  {
    description: "Total orchestration commands dispatched.",
  },
);

export const orchestrationCommandDuration = Metric.timer(
  "ru_fork_orchestration_command_duration",
  {
    description: "Orchestration command dispatch duration.",
  },
);

export const orchestrationCommandAckDuration = Metric.timer(
  "ru_fork_orchestration_command_ack_duration",
  {
    description:
      "Time from orchestration command dispatch to the first committed domain event emitted for that command.",
  },
);

export const orchestrationEventsProcessedTotal = Metric.counter(
  "ru_fork_orchestration_events_processed_total",
  {
    description: "Total orchestration intent events processed by runtime reactors.",
  },
);

export const providerSessionsTotal = Metric.counter("ru_fork_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("ru_fork_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("ru_fork_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter(
  "ru_fork_provider_runtime_events_total",
  {
    description: "Total canonical provider runtime events processed.",
  },
);

export const gitCommandsTotal = Metric.counter("ru_fork_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("ru_fork_git_command_duration", {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter("ru_fork_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter("ru_fork_terminal_restarts_total", {
  description: "Total terminal restart requests handled.",
});

type Attributes = Readonly<Record<string, unknown>>;

const compactAttributes = (attributes: Attributes): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
};

export const metricAttributes = (attributes: Attributes): ReadonlyArray<[string, string]> =>
  Object.entries(compactAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Attributes,
  amount = 1,
): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export const providerMetricAttributes = (provider: string, extra?: Attributes): Attributes => ({
  provider,
  ...extra,
});

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Attributes;
}): Attributes => ({
  provider: input.provider,
  ...(input.model ? { model: input.model } : {}),
  ...input.extra,
});

const outcomeFromExit = <E>(exit: Exit.Exit<unknown, E>): "success" | "failure" | "interrupt" => {
  if (Exit.isSuccess(exit)) return "success";
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "failure";
};

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?: Attributes | (() => Attributes);
  readonly outcomeAttributes?: (outcome: ReturnType<typeof outcomeFromExit>) => Attributes;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(effect);
    const endedAt = yield* Clock.currentTimeNanos;
    const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;
    const duration = Duration.nanos(elapsedNanos);
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);
