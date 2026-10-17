import {
  OrchestratorMcpFailure,
  type PeerEnvironmentConfig,
  type PeerEnvironmentSummary,
} from "@t3tools/contracts";
import type { Client } from "@modelcontextprotocol/sdk/client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSettings from "../serverSettings.ts";
import { resolveThreadWaitTimeoutMs } from "./OrchestratorMcpService.ts";

const CALL_TIMEOUT = Duration.seconds(20);
const WAIT_FORWARD_GRACE = Duration.seconds(5);

export class PeerEnvironments extends Context.Service<
  PeerEnvironments,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<PeerEnvironmentSummary>,
      OrchestratorMcpFailure
    >;
    /**
     * Resolves to the peer tool's result object. `retryUncertain` also retries
     * a call whose connection failed after it was sent, which may run it twice.
     */
    readonly callTool: (
      label: string,
      toolName: string,
      args: Readonly<Record<string, unknown>>,
      options: { readonly retryUncertain: boolean },
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/mcp/PeerEnvironments") {}

class PeerTransportError extends Schema.TaggedError<PeerTransportError>()("PeerTransportError", {
  label: Schema.String,
  stage: Schema.Literals(["connect", "call"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `The MCP ${this.stage} to peer environment ${this.label} failed.`;
  }
}

interface Connection {
  readonly url: string;
  readonly bearerTokenFile: string;
  readonly client: Client;
}

const peerUnavailable = (message: string) =>
  new OrchestratorMcpFailure({ code: "peer_unavailable", message });

const isFailureCode = Schema.is(OrchestratorMcpFailure.fields.code);

const firstText = (content: unknown) => {
  const block = Array.isArray(content) ? content[0] : undefined;
  return Predicate.isObject(block) && block.type === "text" && Predicate.isString(block.text)
    ? block.text
    : undefined;
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string | undefined) =>
  text === undefined ? undefined : Option.getOrUndefined(decodeJson(text));

/**
 * A T3 server sends a declared tool failure as its encoded JSON in the text
 * content; anything else keeps its text as the message.
 */
const peerToolFailure = (label: string, result: Record<string, unknown>) => {
  const text = firstText(result.content);
  const failure = parseJson(text);
  const code =
    Predicate.isObject(failure) && isFailureCode(failure.code)
      ? failure.code
      : "orchestration_error";
  const message =
    Predicate.isObject(failure) && Predicate.isString(failure.message)
      ? failure.message
      : (text ?? "The tool failed.");
  return new OrchestratorMcpFailure({ code, message: `[${label}] ${message}` });
};

const peerToolResult = (label: string, result: Record<string, unknown>) => {
  if (result.isError === true) return Effect.fail(peerToolFailure(label, result));
  const value = Predicate.isObject(result.structuredContent)
    ? result.structuredContent
    : parseJson(firstText(result.content));
  return Predicate.isObject(value)
    ? Effect.succeed(value)
    : Effect.fail(
        peerUnavailable(`Peer environment ${label} returned a result this server cannot read.`),
      );
};

const forwardTimeout = (toolName: string, args: Readonly<Record<string, unknown>>) =>
  toolName === "t3_thread_wait"
    ? Duration.sum(
        Duration.millis(
          resolveThreadWaitTimeoutMs(
            Predicate.isNumber(args.timeoutMs) ? args.timeoutMs : undefined,
          ),
        ),
        WAIT_FORWARD_GRACE,
      )
    : CALL_TIMEOUT;

// Loaded on first use, so an environment without peers never loads the MCP client.
const loadSdk = () =>
  Promise.all([
    import("@modelcontextprotocol/sdk/client"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]).then(([client, transport, types]) => ({
    Client: client.Client,
    StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport,
    StreamableHTTPError: transport.StreamableHTTPError,
    McpError: types.McpError,
    ErrorCode: types.ErrorCode,
  }));

const closeClient = (client: Client) => Effect.promise(() => client.close().catch(() => undefined));

const isCurrent = (connection: Connection, peer: PeerEnvironmentConfig) =>
  connection.url === peer.url && connection.bearerTokenFile === peer.bearerTokenFile;

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const sdk = yield* Effect.cached(
    Effect.tryPromise({
      try: loadSdk,
      catch: () => peerUnavailable("The MCP client could not be loaded."),
    }),
  );
  const connections = new Map<string, Connection>();
  // One lock per peer, so a slow connect to one peer does not hold up another.
  const locks = new Map<string, Semaphore.Semaphore>();
  const withPeerLock =
    (label: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let lock = locks.get(label);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(label, lock);
        }
        return lock.withPermits(1)(effect);
      });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...connections.values()], (connection) => closeClient(connection.client), {
      discard: true,
    }),
  );

  const peers = settings.getSettings.pipe(
    Effect.map((current) =>
      current.peerEnvironments.filter(
        (peer, index, all) => all.findIndex((other) => other.label === peer.label) === index,
      ),
    ),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Peer environments could not be read from settings.",
        }),
    ),
  );

  const resolvePeer = (label: string) =>
    peers.pipe(
      Effect.flatMap((all) => {
        const peer = all.find((candidate) => candidate.label === label);
        return peer !== undefined
          ? Effect.succeed(peer)
          : Effect.fail(
              peerUnavailable(
                all.length === 0
                  ? `Unknown peer environment ${label}: this environment has no peers configured.`
                  : `Unknown peer environment ${label}. Configured peers: ${all.map((candidate) => candidate.label).join(", ")}.`,
              ),
            );
      }),
    );

  const connect = (peer: PeerEnvironmentConfig) =>
    Effect.gen(function* () {
      const token = yield* fileSystem.readFileString(peer.bearerTokenFile).pipe(
        Effect.map((text) => text.trim()),
        Effect.filterOrFail(
          (text) => text.length > 0,
          () => undefined,
        ),
        Effect.mapError(() =>
          peerUnavailable(
            `The bearer token file for peer environment ${peer.label} could not be read or is empty.`,
          ),
        ),
      );
      const { Client, StreamableHTTPClientTransport } = yield* sdk;
      const client = new Client({ name: "t3-code-peer", version: packageJson.version });
      yield* Effect.tryPromise({
        try: () => {
          const transport = new StreamableHTTPClientTransport(new URL("/mcp", peer.url), {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          });
          // The SDK declares its own transport's sessionId without
          // exactOptionalPropertyTypes in mind.
          return client.connect(transport as Transport);
        },
        catch: (cause) => new PeerTransportError({ label: peer.label, stage: "connect", cause }),
      }).pipe(Effect.onError(() => closeClient(client)));
      return { url: peer.url, bearerTokenFile: peer.bearerTokenFile, client } satisfies Connection;
    });

  const acquire = (peer: PeerEnvironmentConfig) =>
    withPeerLock(peer.label)(
      Effect.gen(function* () {
        const existing = connections.get(peer.label);
        if (existing !== undefined && isCurrent(existing, peer)) return existing;
        connections.delete(peer.label);
        if (existing !== undefined) yield* closeClient(existing.client);
        const connection = yield* connect(peer);
        connections.set(peer.label, connection);
        return connection;
      }),
    );

  const drop = (label: string, stale: (connection: Connection) => boolean) =>
    withPeerLock(label)(
      Effect.suspend(() => {
        const connection = connections.get(label);
        if (connection === undefined || !stale(connection)) return Effect.void;
        connections.delete(label);
        return closeClient(connection.client);
      }),
    );

  const changes = yield* settings.subscribeChanges;
  yield* Stream.runForEach(changes, ({ peerEnvironments }) =>
    Effect.forEach(
      [...locks.keys()],
      (label) =>
        drop(label, (connection) => {
          const peer = peerEnvironments.find((candidate) => candidate.label === label);
          return peer === undefined || !isCurrent(connection, peer);
        }),
      { concurrency: "unbounded", discard: true },
    ),
  ).pipe(Effect.forkScoped);

  const attempt = (
    peer: PeerEnvironmentConfig,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    timeout: Duration.Duration,
    isProtocolError: (error: PeerTransportError) => boolean,
  ) =>
    Effect.gen(function* () {
      const connection = yield* acquire(peer);
      return yield* Effect.tryPromise({
        try: (signal) =>
          connection.client.callTool({ name: toolName, arguments: { ...args } }, undefined, {
            signal,
            // The Effect timeout around the call governs; this only keeps the
            // client's shorter default from firing first.
            timeout: Duration.toMillis(timeout) + 1_000,
          }),
        catch: (cause) => new PeerTransportError({ label: peer.label, stage: "call", cause }),
      }).pipe(
        Effect.tapError((error) =>
          isProtocolError(error)
            ? Effect.void
            : drop(peer.label, (current) => current === connection),
        ),
      );
    });

  const callTool: PeerEnvironments["Service"]["callTool"] = (
    label,
    toolName,
    args,
    { retryUncertain },
  ) =>
    Effect.gen(function* () {
      const peer = yield* resolvePeer(label);
      const { McpError, ErrorCode, StreamableHTTPError } = yield* sdk;
      const timeout = forwardTimeout(toolName, args);
      const isProtocolError = (error: PeerTransportError) =>
        error.cause instanceof McpError && error.cause.code !== ErrorCode.ConnectionClosed;
      // Nothing ran on the peer before the connect finished, or when it
      // answered 404 for a session it no longer knows.
      const isRetryable = (error: PeerTransportError) =>
        !isProtocolError(error) &&
        (error.stage === "connect" ||
          retryUncertain ||
          (error.cause instanceof StreamableHTTPError && error.cause.code === 404));
      const toFailure = (error: PeerTransportError) => {
        const { cause } = error;
        if (cause instanceof McpError && isProtocolError(error)) {
          if (cause.code === ErrorCode.RequestTimeout)
            return peerUnavailable(`Peer environment ${label} did not answer in time.`);
          return new OrchestratorMcpFailure({
            code:
              cause.code === ErrorCode.InvalidParams ? "invalid_request" : "orchestration_error",
            message: `[${label}] ${cause.message.replace(/^MCP error -?\d+: /, "")}`,
          });
        }
        if (cause instanceof StreamableHTTPError && (cause.code === 401 || cause.code === 403))
          return peerUnavailable(
            `Peer environment ${label} rejected the bearer token. Mint a new one on the peer with t3 auth session issue --mcp-client-access.`,
          );
        return peerUnavailable(
          error.stage === "call" && !retryUncertain
            ? `The connection to peer environment ${label} failed after the request was sent, so the peer may have received it. Check with t3_thread_list or t3_thread_read before retrying.`
            : `Peer environment ${label} is unreachable. Check that its server is running and reachable from this environment.`,
        );
      };
      const result = yield* attempt(peer, toolName, args, timeout, isProtocolError).pipe(
        Effect.catchTags({
          // A restarted peer forgets the session, and a dropped connection may
          // recover; a fresh client covers both.
          PeerTransportError: (error) =>
            isRetryable(error)
              ? attempt(peer, toolName, args, timeout, isProtocolError)
              : Effect.fail(error),
        }),
        Effect.catchTags({ PeerTransportError: (error) => Effect.fail(toFailure(error)) }),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(peerUnavailable(`Peer environment ${label} did not answer in time.`)),
        }),
      );
      return yield* peerToolResult(label, result);
    }).pipe(Effect.withSpan("PeerEnvironments.callTool", { attributes: { toolName } }));

  return PeerEnvironments.of({
    list: () => peers.pipe(Effect.map((all) => all.map(({ label, url }) => ({ label, url })))),
    callTool,
  });
});

export const layer = Layer.effect(PeerEnvironments, make);
