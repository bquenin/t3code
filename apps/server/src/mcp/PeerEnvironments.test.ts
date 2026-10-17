// @effect-diagnostics nodeBuiltinImport:off - the fake peer is a real Node HTTP MCP server.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerEnvironmentConfig,
} from "@t3tools/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";

interface FakePeer {
  readonly url: string;
  readonly authorizations: Array<string | undefined>;
  readonly initializations: () => number;
  /** Calls to `drop`, whose connection the peer cuts after reading the request. */
  readonly drops: () => number;
  readonly hangEntered: Promise<void>;
  /** The client's event stream, which it closes with the client. */
  readonly eventStreamOpened: Promise<void>;
  readonly eventStreamClosed: Promise<void>;
  readonly restart: Effect.Effect<void>;
  /** Forgets the sessions but keeps serving, so a known client gets a 404. */
  readonly forgetSessions: Effect.Effect<void>;
}

const reads = { retryUncertain: true };
const writes = { retryUncertain: false };

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body.length === 0 ? undefined : JSON.parse(body)));
  });

const makePeerServer = () => {
  const server = new Server(
    { name: "fake-peer", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  let enterHang = () => {};
  const hangEntered = new Promise<void>((resolve) => (enterHang = resolve));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case "echo":
        return { structuredContent: { echoed: args }, content: [{ type: "text", text: "{}" }] };
      case "text_only":
        return { content: [{ type: "text", text: JSON.stringify({ echoed: args }) }] };
      case "fail_plain":
        return { isError: true, content: [{ type: "text", text: "The thread was not found." }] };
      case "fail_coded":
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ code: "thread_not_found", message: "No such thread." }),
            },
          ],
        };
      default:
        enterHang();
        return new Promise((_, reject) =>
          extra.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
    }
  });
  return { server, hangEntered };
};

const withFakePeer = <A, E, R>(run: (peer: FakePeer) => Effect.Effect<A, E, R>) => {
  const authorizations: Array<string | undefined> = [];
  let initializations = 0;
  let drops = 0;
  let openEventStream = () => {};
  let closeEventStream = () => {};
  const eventStreamOpened = new Promise<void>((resolve) => (openEventStream = resolve));
  const eventStreamClosed = new Promise<void>((resolve) => (closeEventStream = resolve));
  let sessions = new Map<string, StreamableHTTPServerTransport>();
  let hangEntered: Promise<void> = Promise.resolve();
  const handler: NodeHttp.RequestListener = async (request, response) => {
    authorizations.push(request.headers.authorization);
    const body = request.method === "POST" ? await readBody(request) : undefined;
    if (
      Predicate.isObject(body) &&
      body.method === "tools/call" &&
      Predicate.isObject(body.params) &&
      body.params.name === "drop"
    ) {
      drops += 1;
      request.socket.destroy();
      return;
    }
    if (request.method === "GET") {
      openEventStream();
      response.on("close", closeEventStream);
    }
    const sessionId = request.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (transport === undefined) {
      if (sessionId !== undefined || !isInitializeRequest(body)) {
        response.writeHead(404).end();
        return;
      }
      initializations += 1;
      const current = sessions;
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => NodeCrypto.randomUUID(),
        onsessioninitialized: (id) => void current.set(id, created),
      });
      const peer = makePeerServer();
      hangEntered = peer.hangEntered;
      await peer.server.connect(created as Transport);
      transport = created;
    }
    await transport.handleRequest(request, response, body);
  };
  const listen = (port: number) =>
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    });
  const close = (server: NodeHttp.Server) =>
    Effect.callback<void>((resume) => {
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    });
  return Effect.acquireUseRelease(
    listen(0).pipe(
      Effect.map((server) => {
        const address = server.address();
        return { current: server, port: typeof address === "object" && address ? address.port : 0 };
      }),
    ),
    (state) =>
      run({
        url: `http://127.0.0.1:${state.port}`,
        authorizations,
        initializations: () => initializations,
        drops: () => drops,
        eventStreamOpened,
        eventStreamClosed,
        get hangEntered() {
          return hangEntered;
        },
        forgetSessions: Effect.sync(() => {
          sessions = new Map();
        }),
        restart: Effect.gen(function* () {
          yield* close(state.current);
          sessions = new Map();
          state.current = yield* listen(state.port);
        }),
      }),
    (state) => close(state.current),
  );
};

const tokenFile = (contents: string) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-peer-token-"));
  const path = NodePath.join(directory, "token");
  NodeFS.writeFileSync(path, contents);
  return path;
};

const layerPeers = (peerEnvironments: ReadonlyArray<PeerEnvironmentConfig>) =>
  PeerEnvironments.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest({ peerEnvironments: [...peerEnvironments] })),
    Layer.provide(NodeServices.layer),
  );

// The test settings service publishes no changes; this one publishes its updates.
const layerPublishingSettings = (peerEnvironments: ReadonlyArray<PeerEnvironmentConfig>) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<Effect.Success<typeof settings.getSettings>>();
      return ServerSettings.ServerSettingsService.of({
        ...settings,
        updateSettings: (patch) =>
          settings.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest({ peerEnvironments: [...peerEnvironments] })));

// Accepts connections and never answers.
const withSilentPeer = <A, E, R>(
  run: (peer: { url: string; reached: Promise<void> }) => Effect.Effect<A, E, R>,
) => {
  let reach = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(() => reach());
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return run({ url: `http://127.0.0.1:${port}`, reached });
    },
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
};

it.effect("forwards a tool call with the stored bearer token and returns its result", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const result = yield* peers.callTool("box", "echo", { value: "hi" }, reads);
      const fallback = yield* peers.callTool("box", "text_only", { value: "text" }, reads);

      expect(result).toEqual({ echoed: { value: "hi" } });
      expect(fallback).toEqual({ echoed: { value: "text" } });
      expect(new Set(peer.authorizations)).toEqual(new Set(["Bearer secret-token"]));
      expect(peer.initializations()).toBe(1);
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("secret-token\n") }]),
      ),
    ),
  ),
);

it.effect("reconnects once when the peer restarted and forgot the session", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      yield* peers.callTool("box", "echo", { call: 1 }, reads);
      yield* peer.restart;
      const result = yield* peers.callTool("box", "echo", { call: 2 }, reads);

      expect(result).toEqual({ echoed: { call: 2 } });
      expect(peer.initializations()).toBe(2);
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }]),
      ),
    ),
  ),
);

it.effect("does not resend a write whose connection failed after it was sent", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const write = yield* peers
        .callTool("box", "drop", {}, writes)
        .pipe(Effect.asVoid, Effect.flip);

      expect(peer.drops()).toBe(1);
      expect(write.code).toBe("peer_unavailable");
      expect(write.message).toContain("may have received it");
      expect(write.message).toContain("t3_thread_list or t3_thread_read");

      const read = yield* peers.callTool("box", "drop", {}, reads).pipe(Effect.asVoid, Effect.flip);

      expect(peer.drops()).toBe(3);
      expect(read.message).toContain("unreachable");
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }]),
      ),
    ),
  ),
);

it.effect("resends a write the peer refused for a session it forgot", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      yield* peers.callTool("box", "echo", { call: 1 }, writes);
      yield* peer.forgetSessions;

      expect(yield* peers.callTool("box", "echo", { call: 2 }, writes)).toEqual({
        echoed: { call: 2 },
      });
      expect(peer.initializations()).toBe(2);
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }]),
      ),
    ),
  ),
);

it.effect("a peer that hangs while connecting does not hold up another peer", () =>
  withFakePeer((peer) =>
    withSilentPeer((silent) =>
      Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        const stuck = yield* peers.callTool("stuck", "echo", {}, reads).pipe(Effect.forkChild);
        yield* Effect.promise(() => silent.reached);

        expect(yield* peers.callTool("box", "echo", { value: 1 }, reads)).toEqual({
          echoed: { value: 1 },
        });
        yield* Fiber.interrupt(stuck);
      }).pipe(
        Effect.provide(
          layerPeers([
            { label: "stuck", url: silent.url, bearerTokenFile: tokenFile("token") },
            { label: "box", url: peer.url, bearerTokenFile: tokenFile("token") },
          ]),
        ),
      ),
    ),
  ),
);

it.effect("closes the connection to a peer removed from settings", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* peers.callTool("box", "echo", {}, reads);
      yield* Effect.promise(() => peer.eventStreamOpened);

      yield* settings.updateSettings({ peerEnvironments: [] });
      yield* Effect.promise(() => peer.eventStreamClosed);

      const removed = yield* peers
        .callTool("box", "echo", {}, reads)
        .pipe(Effect.asVoid, Effect.flip);
      expect(removed.code).toBe("peer_unavailable");
      expect(removed.message).toContain("Unknown peer environment box");
    }).pipe(
      Effect.provide(
        PeerEnvironments.layer.pipe(
          Layer.provideMerge(
            layerPublishingSettings([
              { label: "box", url: peer.url, bearerTokenFile: tokenFile("token") },
            ]),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
);

it.effect("gives up on a peer that does not answer within the call timeout", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const call = yield* peers
        .callTool("box", "hang", {}, reads)
        .pipe(Effect.asVoid, Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => peer.hangEntered);
      yield* TestClock.adjust("21 seconds");
      const failure = yield* Fiber.join(call);

      expect(failure.code).toBe("peer_unavailable");
      expect(failure.message).toContain("did not answer in time");
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }]),
      ),
    ),
  ),
);

it.effect("passes a peer tool failure through with the peer's label", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const plain = yield* peers
        .callTool("box", "fail_plain", {}, reads)
        .pipe(Effect.asVoid, Effect.flip);
      const coded = yield* peers
        .callTool("box", "fail_coded", {}, reads)
        .pipe(Effect.asVoid, Effect.flip);

      expect({ code: plain.code, message: plain.message }).toEqual({
        code: "orchestration_error",
        message: "[box] The thread was not found.",
      });
      expect({ code: coded.code, message: coded.message }).toEqual({
        code: "thread_not_found",
        message: "[box] No such thread.",
      });
    }).pipe(
      Effect.provide(
        layerPeers([{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }]),
      ),
    ),
  ),
);

it.effect("reports unknown, unreadable and unreachable peers as unavailable", () =>
  Effect.gen(function* () {
    const peers = yield* PeerEnvironments.PeerEnvironments;
    const unknown = yield* peers
      .callTool("other", "echo", {}, reads)
      .pipe(Effect.asVoid, Effect.flip);
    const unreadable = yield* peers
      .callTool("missing-token", "echo", {}, reads)
      .pipe(Effect.asVoid, Effect.flip);
    const unreachable = yield* peers
      .callTool("down", "echo", {}, reads)
      .pipe(Effect.asVoid, Effect.flip);

    expect([unknown.code, unreadable.code, unreachable.code]).toEqual([
      "peer_unavailable",
      "peer_unavailable",
      "peer_unavailable",
    ]);
    expect(unknown.message).toContain("Configured peers: missing-token, down");
    expect(unreadable.message).toContain("bearer token file");
    expect(unreachable.message).toContain("unreachable");
  }).pipe(
    Effect.provide(
      layerPeers([
        {
          label: "missing-token",
          url: "http://127.0.0.1:9",
          bearerTokenFile: NodePath.join(NodeOS.tmpdir(), "t3-peer-token-missing", "token"),
        },
        { label: "down", url: "http://127.0.0.1:9", bearerTokenFile: tokenFile("token") },
      ]),
    ),
  ),
);

it.effect("picks up peers added to settings without a restart", () =>
  withFakePeer((peer) =>
    Effect.gen(function* () {
      const peers = yield* PeerEnvironments.PeerEnvironments;
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(yield* peers.list()).toEqual([]);

      yield* settings.updateSettings({
        peerEnvironments: [{ label: "box", url: peer.url, bearerTokenFile: tokenFile("token") }],
      });

      expect(yield* peers.list()).toEqual([{ label: "box", url: peer.url }]);
      expect(yield* peers.callTool("box", "echo", { value: 1 }, reads)).toEqual({
        echoed: { value: 1 },
      });
    }).pipe(Effect.provide(layerPeers([]))),
  ),
);

it.effect("works against a T3 server's own MCP endpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:peer"),
        requestNamespace: "client:hub",
        thread: undefined,
        client: { sessionId: "hub", label: "hub", access: "full-access" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      };
      const PeerToolkit = Toolkit.make(
        Tool.make("probe", {
          parameters: Schema.Struct({ value: Schema.String }),
          success: Schema.Struct({ echoed: Schema.String }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
        Tool.make("refuse", {
          success: Schema.Struct({}),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        PeerToolkit,
        McpToolAccess.toLayer(PeerToolkit, {
          probe: McpToolAccess.reads(({ value }) => Effect.succeed({ echoed: value })),
          refuse: McpToolAccess.reads(() =>
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "thread_not_found",
                message: "The thread was not found.",
              }),
            ),
          ),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === "Bearer peer.token" ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const { address } = yield* HttpServer.HttpServer;
      const url = address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${address.port}`;

      const result = yield* Effect.gen(function* () {
        const peers = yield* PeerEnvironments.PeerEnvironments;
        return {
          probe: yield* peers.callTool("peer", "probe", { value: "hi" }, reads),
          refused: yield* peers
            .callTool("peer", "refuse", {}, reads)
            .pipe(Effect.asVoid, Effect.flip),
        };
      }).pipe(
        Effect.provide(
          layerPeers([{ label: "peer", url, bearerTokenFile: tokenFile("peer.token") }]),
        ),
      );

      expect(result.probe).toEqual({ echoed: "hi" });
      expect({ code: result.refused.code, message: result.refused.message }).toEqual({
        code: "thread_not_found",
        message: "[peer] The thread was not found.",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
