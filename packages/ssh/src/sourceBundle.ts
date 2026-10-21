import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { SshAuthOptions } from "./auth.ts";
import { getLastNonEmptyOutputLine, runSshCommand } from "./command.ts";
import { SshLaunchError } from "./errors.ts";

export interface SshSourceBundle {
  readonly archivePath: string;
  readonly sha256: string;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Receive a desktop's server bundle over stdin, then publish only a working install. */
export function buildSourceBundleInstallScript(sha256: string, nodeEnvironmentScript: string) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid SSH source bundle SHA-256.");
  }
  return `set -eu
${nodeEnvironmentScript}
ensure_remote_node_path || { printf 'The bundled T3 server requires a supported Node.js installation.\\n' >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { printf 'The bundled T3 server requires npm/npx to install native dependencies.\\n' >&2; exit 1; }
ROOT="$HOME/.t3/runtime/source"
RUNTIME="$ROOT/${sha256}"
mkdir -p "$ROOT"
STAGING="$(mktemp -d "$ROOT/.staging-XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
cat > "$STAGING/bundle.tar.gz"
ACTUAL="$(node -e 'const fs = require("node:fs"); const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$STAGING/bundle.tar.gz")"
[ "$ACTUAL" = '${sha256}' ] || { printf 'SSH source bundle checksum mismatch.\\n' >&2; exit 1; }
tar -xzf "$STAGING/bundle.tar.gz" -C "$STAGING"
rm "$STAGING/bundle.tar.gz"
cd "$STAGING"
MANAGER="$(node -p 'require("./package.json").packageManager')"
npx --yes "$MANAGER" install --prod --frozen-lockfile >&2
node dist/bin.mjs --version >&2
# Exercise both native dependencies before publishing the runtime.
node --input-type=module -e 'import "node-pty"; import "@ff-labs/fff-node";' >&2
cat > t3 <<'T3'
#!/bin/sh
exec node "$(dirname "$0")/dist/bin.mjs" "$@"
T3
chmod 755 t3
printf '%s\\n' '${sha256}' > .install-complete
cd "$ROOT"
# Two clients can finish the same immutable build concurrently. The loser
# discards its staging directory; it never replaces a running installation.
node - "$STAGING" "$RUNTIME" <<'NODE'
const fs = require("node:fs");
try { fs.renameSync(process.argv[2], process.argv[3]); }
catch (error) {
  if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
  if (fs.readFileSync(process.argv[3] + "/.install-complete", "utf8").trim() !== "${sha256}") throw error;
}
NODE
printf '%s\\n' "$RUNTIME/dist/bin.mjs"
`;
}

export const ensureRemoteSourceBundle = Effect.fn("ssh.ensureRemoteSourceBundle")(function* (
  target: DesktopSshEnvironmentTarget,
  bundle: SshSourceBundle,
  nodeEnvironmentScript: string,
  auth?: SshAuthOptions,
) {
  const script = yield* Effect.try({
    try: () => buildSourceBundleInstallScript(bundle.sha256, nodeEnvironmentScript),
    catch: (cause) =>
      new SshLaunchError({ message: "Invalid bundled SSH server metadata.", stdout: "", cause }),
  });
  const probe = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-s"],
    stdin: `RUNTIME="$HOME/.t3/runtime/source/${bundle.sha256}"\nif [ -f "$RUNTIME/dist/bin.mjs" ] && [ "$(cat "$RUNTIME/.install-complete" 2>/dev/null)" = '${bundle.sha256}' ]; then printf '%s\\n' "$RUNTIME/dist/bin.mjs"; fi`,
  });
  const existingPath = getLastNonEmptyOutputLine(probe.stdout);
  if (existingPath?.endsWith(`/source/${bundle.sha256}/dist/bin.mjs`)) return existingPath;

  const fs = yield* FileSystem.FileSystem;
  const archive = yield* fs
    .readFile(bundle.archivePath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({ message: "Cannot read the bundled SSH server.", stdout: "", cause }),
      ),
    );
  yield* Effect.logInfo("ssh.sourceBundle.install", { alias: target.alias, sha256: bundle.sha256 });
  const result = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: ["sh", "-l", "-c", quote(script)],
    stdin: archive,
    timeoutMs: 900_000,
  });
  const entryPath = getLastNonEmptyOutputLine(result.stdout);
  if (!entryPath?.endsWith(`/source/${bundle.sha256}/dist/bin.mjs`)) {
    return yield* new SshLaunchError({
      message: "The bundled SSH server installation did not finish.",
      stdout: result.stdout,
    });
  }
  return entryPath;
});
