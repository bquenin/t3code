import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as PeerEnvironments from "../../PeerEnvironments.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:hub-caller");
const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:hub"),
  requestNamespace: "provider:hub",
  thread: {
    threadId,
    providerSessionId: "provider:hub",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
  client: { sessionId: "session:reader", label: "Reader", access: "read-only" },
};

interface Forwarded {
  readonly label: string;
  readonly toolName: string;
  readonly args: unknown;
}

const peerSendResult = {
  threadId: "thread:on-peer",
  messageId: "message:on-peer",
  runId: "run:on-peer",
  status: "running",
  delivery: "started",
};

const callTool = (
  scope: McpInvocationContext.McpInvocationScope,
  peers: Layer.Layer<PeerEnvironments.PeerEnvironments, ServerSettingsError>,
  name: "t3_thread_send" | "t3_thread_read",
  params: Record<string, unknown>,
) => {
  // OrchestratorMcpService is empty: a forwarded call must never reach the local service.
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
    peers,
  );
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    return results.at(-1)?.result;
  }).pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer)),
    Effect.provide(layerDependencies),
  );
};

const recordingPeers = (
  forwarded: Array<Forwarded>,
  respond: () => Effect.Effect<unknown, OrchestratorMcpFailure> = () =>
    Effect.succeed(peerSendResult),
) =>
  Layer.mock(PeerEnvironments.PeerEnvironments)({
    callTool: (label, toolName, args) => {
      forwarded.push({ label, toolName, args });
      return respond();
    },
  });

it.effect("forwards a send to the peer without environment and tags the result with it", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const result = yield* callTool(threadCaller, recordingPeers(forwarded), "t3_thread_send", {
      threadId: "thread:on-peer",
      message: "Run the tests",
      environment: "box",
    });

    expect(forwarded).toEqual([
      {
        label: "box",
        toolName: "t3_thread_send",
        args: { threadId: "thread:on-peer", message: "Run the tests" },
      },
    ]);
    expect(result).toEqual({ ...peerSendResult, environment: "box" });
  }),
);

it.effect("lets a read-only client forward reads but not sends", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const send = yield* callTool(readOnlyClient, recordingPeers(forwarded), "t3_thread_send", {
      threadId: "thread:on-peer",
      message: "Run the tests",
      environment: "box",
    });
    expect(send).toMatchObject({ code: "capability_denied" });
    expect(forwarded).toEqual([]);

    yield* callTool(
      readOnlyClient,
      recordingPeers(forwarded, () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "[box] The thread was not found.",
          }),
        ),
      ),
      "t3_thread_read",
      { threadId: "thread:on-peer", environment: "box" },
    );
    expect(forwarded.map((call) => call.toolName)).toEqual(["t3_thread_read"]);
  }),
);

it.effect("returns the peer's failure as the tool failure", () =>
  Effect.gen(function* () {
    const failure = new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "[box] The thread was not found.",
    });
    const result = yield* callTool(
      threadCaller,
      recordingPeers([], () => Effect.fail(failure)),
      "t3_thread_read",
      { threadId: "thread:on-peer", environment: "box" },
    );

    expect(result).toMatchObject({ code: "thread_not_found", message: failure.message });
  }),
);

it.effect("refuses a peer result that does not match the tool's output", () =>
  Effect.gen(function* () {
    const result = yield* callTool(
      threadCaller,
      recordingPeers([], () => Effect.succeed({ unexpected: true })),
      "t3_thread_send",
      { threadId: "thread:on-peer", message: "Run the tests", environment: "box" },
    );

    expect(result).toMatchObject({ code: "peer_unavailable" });
  }),
);

it.effect("reports an unconfigured environment label as peer_unavailable", () =>
  Effect.gen(function* () {
    const result = yield* callTool(
      threadCaller,
      PeerEnvironments.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(NodeServices.layer),
      ),
      "t3_thread_read",
      { threadId: "thread:on-peer", environment: "box" },
    );

    expect(result).toMatchObject({ code: "peer_unavailable" });
  }),
);
