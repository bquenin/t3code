import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { resolveDesktopSshCliRunner } from "./DesktopSshCliRunner.ts";

describe("desktop SSH server selection", () => {
  it.effect(
    "prefers the source bundle even when its package version matches a published release",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = yield* fs.makeTempDirectoryScoped();
        const archivePath = path.join(resourcesPath, "ssh-server.tar.gz");
        const environment = {
          path,
          resourcesPath,
          appVersion: "0.0.42",
          isDevelopment: false,
          devRemoteT3ServerEntryPath: Option.none<string>(),
        };
        assert.deepEqual(yield* resolveDesktopSshCliRunner(environment), {
          archiveVersion: "0.0.42",
        });
        yield* fs.writeFile(archivePath, new Uint8Array([1, 2, 3]));
        for (const sha256 of ["a".repeat(64), "b".repeat(64)]) {
          yield* fs.writeFileString(`${archivePath}.sha256`, `${sha256}\n`);
          const runner = yield* resolveDesktopSshCliRunner(environment);
          assert.deepEqual(runner.sourceBundle, { archivePath, sha256 });
          assert.isUndefined(runner.archiveVersion);
        }
        const dev = yield* resolveDesktopSshCliRunner({
          ...environment,
          isDevelopment: true,
          devRemoteT3ServerEntryPath: Option.some("/remote/dev/bin.ts"),
        });
        assert.equal(dev.nodeScriptPath, "/remote/dev/bin.ts");
        assert.isUndefined(dev.sourceBundle);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails clearly if a source build has missing or invalid metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped();
      const archivePath = path.join(resourcesPath, "ssh-server.tar.gz");
      const environment = {
        path,
        resourcesPath,
        appVersion: "0.0.42",
        isDevelopment: false,
        devRemoteT3ServerEntryPath: Option.none<string>(),
      };
      yield* fs.writeFile(archivePath, new Uint8Array());
      const missing = yield* resolveDesktopSshCliRunner(environment).pipe(Effect.flip);
      assert.equal(missing._tag, "SshLaunchError");
      yield* fs.writeFileString(`${archivePath}.sha256`, "../bad");
      const invalid = yield* resolveDesktopSshCliRunner(environment).pipe(Effect.flip);
      assert.equal(invalid._tag, "SshLaunchError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
