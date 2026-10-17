import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PeerEnvironmentLabel = Schema.String.check(
  Schema.isPattern(/^[a-z0-9-]{1,32}$/),
  Schema.makeFilter((label) => label !== "local" || "The label local is reserved."),
);
export type PeerEnvironmentLabel = typeof PeerEnvironmentLabel.Type;

const isPeerOrigin = (url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === ""
  );
};

export const PeerEnvironmentConfig = Schema.Struct({
  label: PeerEnvironmentLabel,
  /** The hub calls the peer's MCP endpoint at `${url}/mcp`. */
  url: TrimmedNonEmptyString.check(
    Schema.makeFilter(
      (url) =>
        isPeerOrigin(url) ||
        "Use the peer's http(s) address with no path, query or fragment, such as http://127.0.0.1:3790.",
    ),
  ),
  bearerTokenFile: TrimmedNonEmptyString.check(Schema.isPattern(/^(\/|[A-Za-z]:[\\/])/)),
});
export type PeerEnvironmentConfig = typeof PeerEnvironmentConfig.Type;

export const PeerEnvironmentConfigs = Schema.Array(PeerEnvironmentConfig).check(
  Schema.makeFilter(
    (peers) =>
      new Set(peers.map((peer) => peer.label)).size === peers.length ||
      "Peer environment labels must be unique.",
  ),
);

export const PeerEnvironmentSummary = Schema.Struct({
  label: PeerEnvironmentLabel,
  url: Schema.String,
});
export type PeerEnvironmentSummary = typeof PeerEnvironmentSummary.Type;

export const PeerEnvironmentTarget = Schema.optional(
  PeerEnvironmentLabel.annotate({
    description: "Peer environment label from t3_environment_read. Omit for this environment.",
  }),
);

export const PeerEnvironmentSource = Schema.optional(
  PeerEnvironmentLabel.annotate({
    description:
      "The peer environment this result came from. Pass it back as environment with any id from this result.",
  }),
);
