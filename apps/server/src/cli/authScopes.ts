import { AuthGrantScope } from "@t3tools/contracts";
import { Flag } from "effect/cli";

/** Empty when `--scope` was not passed. */
export const explicitAuthScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  Flag.Literals("scope", AuthGrantScope.literals).pipe(
    Flag.withDescription(
      `Authorization scope to grant. Repeat for multiple scopes; replaces the default set: ${defaults.join(", ")}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [...new Set(scopes)]),
  );

export const authScopesFlag = (defaults: ReadonlyArray<AuthGrantScope>) =>
  explicitAuthScopesFlag(defaults).pipe(
    Flag.map((scopes) => (scopes.length > 0 ? scopes : [...defaults])),
  );
