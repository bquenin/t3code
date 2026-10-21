// @effect-diagnostics nodeBuiltinImport:off - Exercise the generated POSIX installer with real binary stdin and isolated subprocess fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildSourceBundleInstallScript } from "./sourceBundle.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: Uint8Array) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, { env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-source-bundle-"));
  roots.push(root);
  const home = NodePath.join(root, "user's home");
  const bin = NodePath.join(root, "bin");
  const source = NodePath.join(root, "source");
  await Promise.all([
    NodeFSP.mkdir(home),
    NodeFSP.mkdir(bin),
    NodeFSP.mkdir(NodePath.join(source, "dist"), { recursive: true }),
  ]);
  await NodeFSP.writeFile(
    NodePath.join(source, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "dist/bin.mjs"),
    'console.log("t3 source fixture");\n',
  );
  await NodeFSP.writeFile(
    NodePath.join(bin, "npx"),
    `#!/bin/sh
printf '%s\\n' "$*" > "$HOME/install-args"
[ "\${FAIL_INSTALL:-}" != 1 ] || exit 42
mkdir -p node_modules/node-pty node_modules/@ff-labs/fff-node
printf 'module.exports = {};\\n' > node_modules/node-pty/index.js
printf 'module.exports = {};\\n' > node_modules/@ff-labs/fff-node/index.js
`,
  );
  await NodeFSP.chmod(NodePath.join(bin, "npx"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_OPTIONS: "",
  };
  const archivePath = NodePath.join(root, "server.tar.gz");
  const packed = await run("tar", ["-czf", archivePath, "-C", source, "."], env);
  expect(packed.code, packed.stderr).toBe(0);
  const archive = await NodeFSP.readFile(archivePath);
  const sha256 = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const install = (hash = sha256, extraEnv = {}) =>
    run(
      "sh",
      ["-c", buildSourceBundleInstallScript(hash, "ensure_remote_node_path() { return 0; }")],
      { ...env, ...extraEnv },
      archive,
    );
  return { home, sha256, install, runtime: NodePath.join(home, ".t3/runtime/source", sha256) };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH source bundle installation",
  () => {
    it("installs and probes the bundle, preserving the package manager and frozen lockfile", async () => {
      const f = await fixture();
      const result = await f.install();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(NodePath.join(f.runtime, "dist/bin.mjs"));
      expect(
        (await NodeFSP.readFile(NodePath.join(f.runtime, ".install-complete"), "utf8")).trim(),
      ).toBe(f.sha256);
      expect((await NodeFSP.readFile(NodePath.join(f.home, "install-args"), "utf8")).trim()).toBe(
        "--yes pnpm@11.10.0 install --prod --frozen-lockfile",
      );
      expect(await NodeFSP.readdir(NodePath.join(f.home, ".t3/runtime/source"))).toEqual([
        f.sha256,
      ]);
    });

    it("rejects damaged uploads before installing dependencies", async () => {
      const f = await fixture();
      const result = await f.install("a".repeat(64));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      expect(await NodeFSP.readdir(NodePath.join(f.home, ".t3/runtime/source"))).toEqual([]);
      await expect(NodeFSP.readFile(NodePath.join(f.home, "install-args"))).rejects.toThrow();
    });

    it("leaves no completed runtime after an install failure and permits a retry", async () => {
      const f = await fixture();
      const failed = await f.install(f.sha256, { FAIL_INSTALL: "1" });
      expect(failed.code).not.toBe(0);
      expect(await NodeFSP.readdir(NodePath.join(f.home, ".t3/runtime/source"))).toEqual([]);
      const retried = await f.install();
      expect(retried.code, retried.stderr).toBe(0);
    });

    it("publishes one immutable runtime when clients install the same build concurrently", async () => {
      const f = await fixture();
      const results = await Promise.all([f.install(), f.install()]);
      for (const result of results) expect(result.code, result.stderr).toBe(0);
      expect(await NodeFSP.readdir(NodePath.join(f.home, ".t3/runtime/source"))).toEqual([
        f.sha256,
      ]);
    });

    it("rejects unsafe runtime directory identifiers", () => {
      for (const hash of ["", "../old", "a;touch /tmp/bad", "ABC", "a".repeat(63)]) {
        expect(() => buildSourceBundleInstallScript(hash, "")).toThrow("SHA-256");
      }
    });
  },
);
