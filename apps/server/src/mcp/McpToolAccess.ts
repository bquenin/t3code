import {
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import * as PeerEnvironments from "./PeerEnvironments.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/** Private constructors only enforce types; the token also blocks runtime construction. */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/** t3code/no-raw-mcp-registration confines Effect's unchecked registration API to McpHttpServer. */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.andThen(writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/** Requires handler capability checks, not thread control. */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      for (const threadId of threads(params)) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null && target.deletedAt === null) {
          yield* assertTargetWithinLimits(caller.limits, target);
        }
      }
      // Modes can rise after this check; the orchestrator rechecks under lock and records refusal before handlers wrap errors.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      return yield* handle(params).pipe(
        Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail<E | OrchestratorMcpFailure>(
              refusal === undefined ? error : escalationDenied(refusal),
            ),
          ),
        ),
      );
    }),
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

/** One tool with two access rules, picked per call, such as create versus update. */
export const either = <P, A, E, R, A2, E2, R2>(
  useFirst: (params: P) => boolean,
  first: Declaration<(params: P) => Effect.Effect<A, E, R>>,
  second: Declaration<(params: P) => Effect.Effect<A2, E2, R2>>,
) =>
  declare((params: P): Effect.Effect<A | A2, E | E2, R | R2> =>
    useFirst(params) ? checkedHandler(first)(params) : checkedHandler(second)(params),
  );

type PeerAccess<P> =
  | { readonly access: "reads" | "starts" }
  | {
      readonly access: "writes";
      /** Read on the peer first, so the target stays within this caller's limits. */
      readonly targetThreadId: (params: P) => ThreadId;
    };

const PeerTarget = Schema.Struct({
  thread: Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
});
const decodePeerTarget = Schema.decodeUnknownEffect(PeerTarget);

const unreadablePeerResult = (environment: string) =>
  new OrchestratorMcpFailure({
    code: "peer_unavailable",
    message: `Peer environment ${environment} returned a result this server cannot read. The two environments may run different T3 Code versions.`,
  });

/**
 * With `environment` set, the call runs on that peer instead of `local`. A
 * peer thread does not exist here, so the caller's own checks run here and a
 * write reads its target from the peer to check it; the peer checks its
 * target again against this environment's token.
 */
export const forwardsToPeer = <
  PS extends Schema.Top & { readonly Encoded: Readonly<Record<string, unknown>> },
  S extends Schema.Top & { readonly Type: object },
  P extends {
    readonly environment?: string | undefined;
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
    readonly attachments?: ReadonlyArray<unknown> | undefined;
  },
  A,
  E,
  R,
>(
  tool: { readonly name: string; readonly parametersSchema: PS; readonly successSchema: S },
  options: PeerAccess<NoInfer<P>>,
  local: Declaration<(params: P) => Effect.Effect<A, E, R>>,
) => {
  const handleLocally = checkedHandler(local);
  const encodeArgs = Schema.encodeUnknownEffect(tool.parametersSchema);
  const decodeResult = Schema.decodeUnknownEffect(tool.successSchema);
  const forward = Effect.fn("mcp.forwardToPeer")(function* (environment: string, params: P) {
    const { environment: _environment, ...args } = params;
    const { limits } = yield* options.access === "reads" ? readCaller() : orchestratingCaller;
    if (params.attachments !== undefined && params.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "Attachments cannot be forwarded to a peer environment; upload them there or put the content in message.",
      });
    }
    const forwarded =
      options.access === "starts"
        ? {
            ...args,
            runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, params.runtimeMode),
            interactionMode: yield* resolveInteractionMode(
              limits.interactionMode,
              params.interactionMode,
            ),
          }
        : args;
    const encoded = yield* encodeArgs(forwarded).pipe(Effect.mapError(unavailable));
    const peers = yield* PeerEnvironments.PeerEnvironments;
    if (options.access === "writes") {
      const target = yield* peers
        .callTool(
          environment,
          "t3_thread_read",
          { threadId: options.targetThreadId(params), limit: 1, maxCharsPerItem: 1 },
          { retryUncertain: true },
        )
        .pipe(
          Effect.flatMap((result) =>
            decodePeerTarget(result).pipe(Effect.mapError(() => unreadablePeerResult(environment))),
          ),
        );
      // The local path rechecks the target on acceptance. A peer cannot know this
      // caller's limits, so a mode raised there meanwhile is caught only by the
      // stored token's ceiling: keep it no broader than the hub's own agents hold.
      yield* assertTargetWithinLimits(limits, target.thread);
    }
    const result = yield* peers.callTool(environment, tool.name, encoded, {
      retryUncertain: options.access === "reads",
    });
    const decoded = yield* decodeResult(result).pipe(
      Effect.mapError(() => unreadablePeerResult(environment)),
    );
    return { ...decoded, environment };
  });
  type Forwarded = ReturnType<typeof forward>;
  return declare(
    (
      params: P,
    ): Effect.Effect<
      A | Effect.Success<Forwarded>,
      E | Effect.Error<Forwarded>,
      R | Effect.Services<Forwarded>
    > =>
      params.environment === undefined
        ? handleLocally(params)
        : forward(params.environment, params),
  );
};

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/** Recheck after waits before writing; caller modes may have changed. */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare((params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
