import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        homeDirectory: "/home/alice",
        baseDir: "/home/alice/.t3",
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        homeDirectory: "/home/alice",
        baseDir: "/home/alice/.t3",
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const resolve = (input: {
  readonly baseDir: string;
  readonly isDevelopment?: boolean;
  readonly platform?: NodeJS.Platform;
}) =>
  resolveUserDataPath({
    appDataDirectory: "/appdata",
    homeDirectory: "/home/alice",
    isDevelopment: false,
    platform: "darwin",
    ...input,
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("keeps the shared profile for the default T3 home, even when set explicitly", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolve({ baseDir: "/home/alice/.t3" }), "/appdata/t3code-v2");
    assert.equal(yield* resolve({ baseDir: "/home/alice/.t3/" }), "/appdata/t3code-v2");
    assert.equal(yield* resolve({ baseDir: "/home/alice/x/../.t3" }), "/appdata/t3code-v2");
  }),
);

it.effect("gives each custom T3 home its own stable profile", () =>
  Effect.gen(function* () {
    const personal = yield* resolve({ baseDir: "/home/alice/.t3-personal" });
    const work = yield* resolve({ baseDir: "/home/alice/.t3-work" });
    assert.match(personal, /^\/appdata\/t3code-v2-[0-9a-f]{8}$/);
    assert.match(work, /^\/appdata\/t3code-v2-[0-9a-f]{8}$/);
    assert.notEqual(personal, work);
    assert.equal(yield* resolve({ baseDir: "/home/alice/.t3-personal/" }), personal);
    const dev = yield* resolve({ baseDir: "/home/alice/.t3-personal", isDevelopment: true });
    assert.equal(dev, personal.replace("t3code-v2-", "t3code-dev-"));
  }),
);

it.effect("keeps Windows credential keys readable when a custom T3 home gets its own profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    const resolveCustom = (baseDir: string) =>
      resolveUserDataPath({
        appDataDirectory: directory,
        homeDirectory: "/home/alice",
        baseDir,
        isDevelopment: false,
        platform: "win32",
      });
    yield* fs.makeDirectory(path.join(directory, "t3code"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "t3code", "Local State"), "v1 key");
    const fromV1 = yield* resolveCustom("/home/alice/.t3-work");
    assert.equal(yield* fs.readFileString(path.join(fromV1, "Local State")), "v1 key");

    yield* fs.makeDirectory(path.join(directory, "t3code-v2"), { recursive: true });
    yield* fs.writeFileString(path.join(directory, "t3code-v2", "Local State"), "shared key");
    const personal = yield* resolveCustom("/home/alice/.t3-personal");
    assert.notEqual(personal, path.join(directory, "t3code-v2"));
    assert.equal(yield* fs.readFileString(path.join(personal, "Local State")), "shared key");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
