import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PeerEnvironments from "../../PeerEnvironments.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("thread:hub-caller");
const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:hub"),
  requestNamespace: "provider:hub",
  thread: {
    threadId: callerThreadId,
    providerSessionId: "provider:hub",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const approvalRequiredClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
  client: { sessionId: "session:supervised", label: "Supervised", access: "approval-required" },
};

interface Forwarded {
  readonly label: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly retryUncertain: boolean;
}

const peerOrganizeResult = { sequence: 7 };

// The organize's target check reads only the thread's modes from this.
const peerThread = (runtimeMode: RuntimeMode) => ({
  thread: { runtimeMode, interactionMode: "default" },
});

const targetIn = (runtimeMode: RuntimeMode) => (toolName: string) =>
  Effect.succeed(toolName === "t3_thread_read" ? peerThread(runtimeMode) : peerOrganizeResult);

const recordingPeers = (
  forwarded: Array<Forwarded>,
  respond: (toolName: string) => Effect.Effect<unknown, OrchestratorMcpFailure> = targetIn(
    "full-access",
  ),
) =>
  Layer.mock(PeerEnvironments.PeerEnvironments)({
    callTool: (label, toolName, args, { retryUncertain }) => {
      forwarded.push({ label, toolName, args, retryUncertain });
      return respond(toolName);
    },
  });

const organize = (
  scope: McpInvocationContext.McpInvocationScope,
  peers: Layer.Layer<PeerEnvironments.PeerEnvironments, ServerSettingsError>,
  params: Record<string, unknown>,
  dispatched: Array<OrchestrationV2ServerCommand> = [],
) => {
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
      getProjectThreadRecords: (input) =>
        Effect.succeed(idleThreadProjection(liveThreadShell(input.threadId))),
      dispatch: (command) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 3 } as Orchestrator.OrchestratorV2DispatchResult);
      },
    }),
    Layer.mock(ThreadSearch.ThreadSearch)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    NodeCrypto.layer,
    peers,
  );
  return Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    const results = yield* toolkit
      .handle("t3_thread_organize", params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    return results.at(-1)?.result;
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
        Layer.provideMerge(layerDependencies),
      ),
    ),
  );
};

it.effect("forwards an organize to the peer after reading its target there", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const result = yield* organize(
      threadCaller,
      recordingPeers(forwarded),
      { threadId: "thread:on-peer", action: "archive", environment: "box" },
      dispatched,
    );

    expect(forwarded).toEqual([
      {
        label: "box",
        toolName: "t3_thread_read",
        args: { threadId: "thread:on-peer", limit: 1, maxCharsPerItem: 1 },
        retryUncertain: true,
      },
      {
        label: "box",
        toolName: "t3_thread_organize",
        args: { threadId: "thread:on-peer", action: "archive" },
        retryUncertain: false,
      },
    ]);
    expect(dispatched).toEqual([]);
    expect(result).toEqual({ ...peerOrganizeResult, environment: "box" });
  }),
);

it.effect("refuses an organize on a peer without threadId before calling the peer", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const result = yield* organize(threadCaller, recordingPeers(forwarded), {
      action: "archive",
      environment: "box",
    });

    expect(result).toMatchObject({
      code: "invalid_request",
      message: "threadId is required with environment.",
    });
    expect(forwarded).toEqual([]);
  }),
);

it.effect("refuses an organize on a peer thread with broader modes than the caller", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const result = yield* organize(
      approvalRequiredClient,
      recordingPeers(forwarded, targetIn("full-access")),
      { threadId: "thread:on-peer", action: "pin", environment: "box" },
    );

    expect(result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(forwarded.map((call) => call.toolName)).toEqual(["t3_thread_read"]);
  }),
);

it.effect("organizes a local thread without calling a peer", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const result = yield* organize(
      threadCaller,
      recordingPeers(forwarded),
      { threadId: "thread:local", action: "archive" },
      dispatched,
    );

    expect(result).toEqual({ sequence: 3 });
    expect(dispatched).toMatchObject([{ type: "thread.archive", threadId: "thread:local" }]);
    expect(forwarded).toEqual([]);
  }),
);
