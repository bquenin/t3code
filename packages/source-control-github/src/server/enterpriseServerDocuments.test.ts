import * as Generator from "@effect/graphql-generator/Generator";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import config from "../../graphql.config.ts";

/**
 * The documents only ever sent to github.com. Every other document is also sent to Enterprise
 * Server, and GraphQL validates a whole document before `@include` or `@skip` can leave anything
 * out, so one field Enterprise Server lacks fails that read on every Enterprise Server host.
 */
const GITHUB_COM_ONLY = ["src/server/pullRequestStacks.graphql"];

/** github.com fields Enterprise Server does not have. */
const ENTERPRISE_SERVER_MISSING = [
  { type: "PullRequest", field: "stack" },
  { type: "PullRequest", field: "stackEntry" },
];

/** github.com's schema without `ENTERPRISE_SERVER_MISSING`, each with its description. */
function enterpriseServerSchema(schema: string): string {
  return ENTERPRISE_SERVER_MISSING.reduce((sdl, { type, field }) => {
    const start = sdl.search(new RegExp(`^type ${type}\\b`, "m"));
    const end = sdl.indexOf("\n}\n", start);
    const definition = sdl.slice(start, end);
    const pattern = new RegExp(`\\n\\n(?:  """\\n(?:  (?!""").*\\n)*  """\\n)?  ${field}: [^\\n]*`);
    expect(definition, `${type}.${field}`).toMatch(pattern);
    return sdl.slice(0, start) + definition.replace(pattern, "") + sdl.slice(end);
  }, schema);
}

const generateAgainst = (schema: string, documents: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const cwd = path.resolve(import.meta.dirname, "../..");
    const schemaPath = path.resolve(cwd, config.schema);
    const result = yield* Generator.generate({ ...config, documents }, { cwd }).pipe(
      Effect.updateService(FileSystem.FileSystem, (fs) =>
        FileSystem.FileSystem.of({
          ...fs,
          readFileString: (file, encoding) =>
            file === schemaPath ? Effect.succeed(schema) : fs.readFileString(file, encoding),
        }),
      ),
    );
    return result.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
  });

it.effect("every document sent to Enterprise Server is valid without github.com-only fields", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../..");
    const schema = enterpriseServerSchema(
      yield* fs.readFileString(path.resolve(root, config.schema)),
    );
    const documents = (yield* fs.readDirectory(path.join(root, "src"), { recursive: true }))
      .map((file) => `src/${file.split(path.sep).join("/")}`)
      .filter((file) => file.endsWith(".graphql") && !GITHUB_COM_ONLY.includes(file));
    expect(documents).toContain("src/server/pullRequestBatches.graphql");
    expect(documents).toContain("src/server/pullRequestListings.graphql");

    expect(yield* generateAgainst(schema, documents)).toEqual([]);
    // The github.com-only documents are what that schema refuses.
    expect(yield* generateAgainst(schema, GITHUB_COM_ONLY)).not.toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
