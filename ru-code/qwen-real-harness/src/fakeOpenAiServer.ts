// oxlint-disable t3code/namespace-node-imports -- ru-code: PORTED VERBATIM from
// qwen-code integration-tests/fake-openai-server.ts; its import style is upstream's,
// and rewriting it would make the port diffable against nothing.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
// ru-code: a PORTED Node http server, deliberately outside Effect (see the header
// below) — the Effect-API diagnostics do not apply to it.
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ru-code (qwen-compression wave): PORTED VERBATIM from qwen-code
// `integration-tests/fake-openai-server.ts` @ 41b4ee8373fb4aa324925e69e0515ca72959ec5b
// (tag v0.21.1), license header kept. Not a re-implementation on purpose: the
// point of this harness is that the model backend behaves exactly as qwen's own
// integration tests assume, so any divergence between our capture and theirs is
// attributable to the harness, never to a hand-rolled mock. The only additions
// below are marked `ru-code:`; everything else is upstream bytes.
//
// Two things the compression scenarios steer through it:
//   · `usage.prompt_tokens` — qwen records it as `lastPromptTokenCount`, which is
//     what its auto-compaction threshold is measured against, so an inflated
//     value on turn 1 makes turn 2 compress (chatCompressionService.ts:357-372).
//   · `status` — the summariser side-query is an ordinary `/chat/completions`
//     call, so answering it 500 is how a `/compress` is made to FAIL.

import {
  createServer,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type FakeOpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type FakeOpenAIResponse = {
  model?: string;
  content?: string;
  contentChunks?: string[];
  disconnectAfterContentChunks?: number;
  toolCalls?: FakeOpenAIToolCall[];
  finishReason?: "stop" | "tool_calls" | "length";
  choices?: FakeOpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

export type FakeOpenAIChoice = {
  index: number;
  content?: string;
  contentChunks?: string[];
  toolCalls?: FakeOpenAIToolCall[];
  finishReason?: "stop" | "tool_calls" | "length";
};

export type FakeOpenAIRequest = {
  body: JsonObject;
  headers: IncomingHttpHeaders;
};

export type FakeOpenAIServer = {
  baseUrl: string;
  requests: FakeOpenAIRequest[];
  close: () => Promise<void>;
};

export type FakeOpenAIServerOptions = (
  | { listenHost?: undefined; baseUrlHost?: undefined }
  | { listenHost: string; baseUrlHost: string }
) & {
  keepAlive?: boolean;
};

export type FakeOpenAIHandler = (ctx: {
  body: JsonObject;
  requestIndex: number;
}) => FakeOpenAIResponse | FakeOpenAIFailure | Promise<FakeOpenAIResponse | FakeOpenAIFailure>;

/**
 * ru-code: an HTTP-level failure instead of a completion. Upstream's server can
 * only answer 200 (its own 500 path is reserved for a throwing handler), and the
 * `/compress` FAILURE scenario needs the summariser's call to fail at the
 * transport — that is what makes `tryCompressChat` throw, which is what turns
 * the ACP `session/prompt` into a JSON-RPC error with NO frame
 * (compressCommand.ts:113-120 → Session.ts:8475-8477).
 */
export type FakeOpenAIFailure = {
  readonly status: number;
  readonly message?: string;
};

const isFailure = (value: unknown): value is FakeOpenAIFailure =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { status?: unknown }).status === "number";

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("fake OpenAI request body too large");
  }
}

export function fakeToolCall(
  name: string,
  args: JsonObject,
  id = `call_${randomUUID()}`,
): FakeOpenAIToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

export async function startFakeOpenAIServer(
  handler: FakeOpenAIHandler,
  options: FakeOpenAIServerOptions = {},
): Promise<FakeOpenAIServer> {
  const requests: FakeOpenAIRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    try {
      const rawBody = await readRequestBody(req);
      const body = parseJsonBody(rawBody);
      if (!body) {
        res.writeHead(400);
        res.end("bad json");
        return;
      }

      const requestIndex = requests.length;
      requests.push({ body, headers: req.headers });

      const response = await handler({ body, requestIndex });
      // ru-code: the HTTP-failure arm (see FakeOpenAIFailure).
      if (isFailure(response)) {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: response.message ?? "fake OpenAI scripted failure",
              type: "server_error",
            },
          }),
        );
        return;
      }
      if (body["stream"] === true) {
        writeStreamed(res, getModel(body), response, options.keepAlive !== false);
      } else {
        writeNonStreamed(res, getModel(body), response, options.keepAlive !== false);
      }
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        res.writeHead(413);
        res.end("request body too large");
        return;
      }

      if (res.headersSent) {
        if (!res.writableEnded) {
          res.destroy();
        }
        return;
      }

      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "fake OpenAI server handler failed",
            type: "server_error",
          },
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, options.listenHost ?? "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start fake OpenAI server");
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://${options.baseUrlHost ?? "127.0.0.1"}:${(address as AddressInfo).port}/v1`,
    requests,
    close: () => (closePromise ??= closeServer(server)),
  };
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      totalLength += chunk.length;
      if (totalLength > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseJsonBody(rawBody: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getModel(body: JsonObject): string {
  return typeof body["model"] === "string" ? body["model"] : "fake-model";
}

function writeNonStreamed(
  res: ServerResponse,
  model: string,
  message: FakeOpenAIResponse,
  keepAlive: boolean,
): void {
  res.writeHead(
    200,
    keepAlive
      ? { "content-type": "application/json" }
      : { connection: "close", "content-type": "application/json" },
  );
  res.end(
    JSON.stringify({
      id: chatCompletionId(),
      object: "chat.completion",
      created: nowSeconds(),
      model: message.model ?? model,
      choices: responseChoices(message).map((choice) => ({
        index: choice.index,
        message: {
          role: "assistant",
          content: choice.content ?? choice.contentChunks?.join("") ?? null,
          ...(choice.toolCalls ? { tool_calls: choice.toolCalls } : {}),
        },
        finish_reason: finishReason(choice),
      })),
      usage: message.usage ?? DEFAULT_USAGE,
    }),
  );
}

function writeStreamed(
  res: ServerResponse,
  model: string,
  message: FakeOpenAIResponse,
  keepAlive: boolean,
): void {
  res.writeHead(200, {
    "cache-control": "no-cache",
    connection: keepAlive ? "keep-alive" : "close",
    "content-type": "text/event-stream",
  });

  const id = chatCompletionId();
  const created = nowSeconds();
  const responseModel = message.model ?? model;
  const chunk = (
    index: number,
    delta: JsonObject,
    finish_reason: string | null = null,
    usage?: FakeOpenAIResponse["usage"],
  ) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: responseModel,
    choices: [{ index, delta, finish_reason }],
    ...(usage ? { usage } : {}),
  });
  const send = (payload: unknown, callback?: () => void) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`, callback);
  };

  const choices = responseChoices(message);
  for (const [choicePosition, choice] of choices.entries()) {
    send(chunk(choice.index, { role: "assistant" }));
    for (const [contentIndex, content] of (choice.contentChunks ?? []).entries()) {
      if (message.disconnectAfterContentChunks === contentIndex + 1) {
        send(chunk(choice.index, { content }), () => res.destroy());
        return;
      }
      send(chunk(choice.index, { content }));
    }
    if (!choice.contentChunks && choice.content) {
      send(chunk(choice.index, { content: choice.content }));
    }
    for (const [toolIndex, toolCall] of (choice.toolCalls ?? []).entries()) {
      send(
        chunk(choice.index, {
          tool_calls: [
            {
              index: toolIndex,
              id: toolCall.id,
              type: toolCall.type,
              function: {
                name: toolCall.function.name,
                arguments: "",
              },
            },
          ],
        }),
      );
      if (toolCall.function.arguments) {
        send(
          chunk(choice.index, {
            tool_calls: [
              {
                index: toolIndex,
                function: {
                  arguments: toolCall.function.arguments,
                },
              },
            ],
          }),
        );
      }
    }
    send(
      chunk(
        choice.index,
        {},
        finishReason(choice),
        choices.length === 1 && choicePosition === choices.length - 1
          ? (message.usage ?? DEFAULT_USAGE)
          : undefined,
      ),
    );
  }
  if (choices.length > 1) {
    send({
      id,
      object: "chat.completion.chunk",
      created,
      model: responseModel,
      choices: [],
      usage: message.usage ?? DEFAULT_USAGE,
    });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function responseChoices(message: FakeOpenAIResponse): FakeOpenAIChoice[] {
  // ru-code: the one shape adaptation to this repo's `exactOptionalPropertyTypes`
  // — upstream assigns `undefined` to optional fields, which this tree forbids.
  // Behaviour is identical: an absent key and an explicit `undefined` read the
  // same everywhere downstream (`choice.content ?? choice.contentChunks?.join('')`).
  return (
    message.choices ?? [
      {
        index: 0,
        ...(message.content !== undefined ? { content: message.content } : {}),
        ...(message.contentChunks !== undefined ? { contentChunks: message.contentChunks } : {}),
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
        ...(message.finishReason !== undefined ? { finishReason: message.finishReason } : {}),
      },
    ]
  );
}

function finishReason(message: Pick<FakeOpenAIChoice, "finishReason" | "toolCalls">): string {
  return message.finishReason ?? (message.toolCalls ? "tool_calls" : "stop");
}

const DEFAULT_USAGE: NonNullable<FakeOpenAIResponse["usage"]> = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

function chatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
