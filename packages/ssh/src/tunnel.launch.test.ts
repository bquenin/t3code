// @effect-diagnostics nodeBuiltinImport:off - Run the generated POSIX launch script against real fake servers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildRemoteLaunchScript } from "./tunnel.ts";

// Serves 200 on --port after FAKE_READY_DELAY_MS; FAKE_SPAWN_MARKER records a launch.
const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
if (process.env.FAKE_SPAWN_MARKER) fs.writeFileSync(process.env.FAKE_SPAWN_MARKER, String(port));
setTimeout(() => {
  http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1");
}, Number(process.env.FAKE_READY_DELAY_MS || 0));
`;

const roots: string[] = [];
const servers: NodeChildProcess.ChildProcess[] = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ssh-launch-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const serverPath = NodePath.join(root, "server.cjs");
  await NodeFSP.mkdir(home);
  await NodeFSP.writeFile(serverPath, FAKE_SERVER);
  const t3Home = NodePath.join(home, ".t3");
  const stateDir = NodePath.join(t3Home, "ssh-launch", "test-key");
  const marker = NodePath.join(root, "spawned");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_OPTIONS: "",
    FAKE_SPAWN_MARKER: marker,
  };

  /** A server another launcher already started against this T3 home. */
  const startHomeServer = async (readyDelayMs = 0) => {
    const port = await freePort();
    const server = NodeChildProcess.spawn(
      process.execPath,
      [serverPath, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", t3Home],
      {
        env: { ...env, FAKE_SPAWN_MARKER: "", FAKE_READY_DELAY_MS: String(readyDelayMs) },
        stdio: "ignore",
      },
    );
    servers.push(server);
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    return { port, pid: server.pid!, exited };
  };

  const writeState = async (state: { managed: string; port?: number; pid?: number }) => {
    await NodeFSP.mkdir(stateDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(stateDir, "managed"), `${state.managed}\n`);
    if (state.port !== undefined) {
      await NodeFSP.writeFile(NodePath.join(stateDir, "port"), `${state.port}\n`);
    }
    if (state.pid !== undefined) {
      await NodeFSP.writeFile(NodePath.join(stateDir, "pid"), `${state.pid}\n`);
    }
  };

  /** Runs the script like the desktop does; `loginShell` mirrors its `sh -l` on a bash host. */
  const launch = (
    rewrite: (script: string) => string = (script) => script,
    { loginShell = false } = {},
  ) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = loginShell
        ? NodeChildProcess.spawn("bash", ["-l", "-s", "--", "test-key"], { env, stdio: "pipe" })
        : NodeChildProcess.spawn("sh", ["-s", "--", "test-key"], { env, stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", async (code) => {
        const pid = await NodeFSP.readFile(NodePath.join(stateDir, "pid"), "utf8").catch(() => "");
        if (pid.trim()) spawnedPids.push(Number(pid.trim()));
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(rewrite(buildRemoteLaunchScript({ nodeScriptPath: serverPath })));
    });

  const spawnedSecondServer = () =>
    NodeFSP.access(marker).then(
      () => true,
      () => false,
    );
  const managedState = () =>
    NodeFSP.readFile(NodePath.join(stateDir, "managed"), "utf8").then((value) => value.trim());

  /** A logout script that fails without a TTY, like Debian's clear_console. */
  const failingLogout = () => NodeFSP.writeFile(NodePath.join(home, ".bash_logout"), "false\n");

  return { startHomeServer, writeState, launch, spawnedSecondServer, managedState, failingLogout };
}

const lastJsonLine = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");

describe("remote launch script with a server already on the T3 home", () => {
  it("starts its own server when none is running", async () => {
    const { launch, spawnedSecondServer, managedState } = await fixture();

    const result = await launch();

    expect(result.code, result.stderr).toBe(0);
    expect(lastJsonLine(result.stdout).serverKind).toBe("managed");
    expect(await spawnedSecondServer()).toBe(true);
    expect(await managedState()).toBe("managed");
  });

  it("attaches to the running server instead of starting another", async () => {
    const { startHomeServer, launch, spawnedSecondServer, managedState } = await fixture();
    const owner = await startHomeServer();

    const result = await launch();

    expect(result.code, result.stderr).toBe(0);
    expect(lastJsonLine(result.stdout)).toEqual({ remotePort: owner.port, serverKind: "external" });
    expect(await spawnedSecondServer()).toBe(false);
    expect(await managedState()).toBe("external");
  });

  it("attaches from a login shell whose logout script fails", async () => {
    const { startHomeServer, launch, spawnedSecondServer, failingLogout } = await fixture();
    const owner = await startHomeServer();
    await failingLogout();

    const result = await launch(undefined, { loginShell: true });

    expect(result.code, result.stderr).toBe(0);
    expect(lastJsonLine(result.stdout)).toEqual({ remotePort: owner.port, serverKind: "external" });
    expect(await spawnedSecondServer()).toBe(false);
  });

  it("waits out a server that is still starting rather than racing it", async () => {
    const { startHomeServer, writeState, launch, spawnedSecondServer } = await fixture();
    // Slower than the two-second reuse probe, as a server busy after a reboot can be.
    const owner = await startHomeServer(3_500);
    await writeState({ managed: "external", port: owner.port });

    const result = await launch();

    expect(result.code, result.stderr).toBe(0);
    expect(lastJsonLine(result.stdout)).toEqual({ remotePort: owner.port, serverKind: "external" });
    expect(await spawnedSecondServer()).toBe(false);
  });

  it("retires its own managed server once another server owns the home", async () => {
    const { startHomeServer, writeState, launch, spawnedSecondServer, managedState } =
      await fixture();
    const owner = await startHomeServer();
    const ownManaged = await startHomeServer();
    await writeState({ managed: "managed", port: ownManaged.port, pid: ownManaged.pid });

    const result = await launch();

    expect(result.code, result.stderr).toBe(0);
    expect(lastJsonLine(result.stdout)).toEqual({ remotePort: owner.port, serverKind: "external" });
    expect(await spawnedSecondServer()).toBe(false);
    expect(await managedState()).toBe("external");
    await ownManaged.exited;
  });

  it("fails rather than starting a second server when the owner never answers", async () => {
    const { startHomeServer, launch, spawnedSecondServer } = await fixture();
    const owner = await startHomeServer(60_000);

    // Shorten the owner's 60-second readiness window so the failure arrives quickly.
    const result = await launch((script) =>
      script.replace(
        /HOME_SERVER_INFO#\* \}"\n  if ! wait_ready "\d+"/,
        'HOME_SERVER_INFO#* }"\n  if ! wait_ready "1500"',
      ),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`T3 server ${owner.pid} already uses`);
    expect(result.stderr).toContain("Not starting a second server");
    expect(await spawnedSecondServer()).toBe(false);
  });
});
