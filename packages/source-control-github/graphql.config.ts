import { defineConfig } from "@effect/graphql-generator/Config";

// Public schema: https://docs.github.com/public/fpt/schema.docs.graphql. `@include` cannot hide
// fields Enterprise Server lacks, since GraphQL validates the whole document first; they live in
// documents only sent to github.com (`src/server/enterpriseServerDocuments.test.ts`).
export default defineConfig({
  schema: "./schema/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    GitObjectID: "effect/Schema#String",
    GitRefname: "effect/Schema#String",
    // Preserve GitHub's strings for comparison with other reads.
    DateTime: "effect/Schema#String",
  },
});
