import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import { SshLaunchError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export const resolveDesktopSshCliRunner = Effect.fn("desktop.resolveSshCliRunner")(function* (
  environment: Pick<
    DesktopEnvironment["Service"],
    "isDevelopment" | "devRemoteT3ServerEntryPath" | "path" | "resourcesPath" | "appVersion"
  >,
): Effect.fn.Return<RemoteT3RunnerOptions, SshLaunchError, FileSystem.FileSystem> {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: devRemoteEntryPath, nodeEngineRange: serverPackageJson.engines.node };
  }
  const fs = yield* FileSystem.FileSystem;
  const archivePath = environment.path.join(environment.resourcesPath, "ssh-server.tar.gz");
  return yield* Effect.gen(function* () {
    if (!(yield* fs.exists(archivePath))) return { archiveVersion: environment.appVersion };
    const sha256 = (yield* fs.readFileString(`${archivePath}.sha256`)).trim();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      return yield* new SshLaunchError({
        message: "The bundled SSH server checksum is invalid.",
        stdout: "",
      });
    }
    return {
      sourceBundle: { archivePath, sha256 },
      nodeEngineRange: serverPackageJson.engines.node,
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshLaunchError({ message: "Cannot load the bundled SSH server.", stdout: "", cause }),
    ),
  );
});
