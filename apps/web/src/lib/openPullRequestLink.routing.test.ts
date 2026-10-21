import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useOpenChangeRequestLink } from "./openPullRequestLink";

const state = vi.hoisted(() => {
  const url = "https://github.acme.test/team/nested-repo/pull/7";
  const link = {
    host: "github.acme.test",
    repository: "team/nested-repo",
    number: 7,
    url,
    source: "agent",
    linkedAt: "2026-07-01T00:00:00Z",
    snapshot: null,
    stack: null,
  };
  return {
    url,
    link,
    supported: true,
    navigate: vi.fn(),
    openPullRequest: vi.fn(),
    projects: ["mac", "cws"].map((environmentId) => ({
      id: "home",
      environmentId,
      workspaceRoot: environmentId === "mac" ? "/Users/person" : "/home/person",
      repositoryIdentity: null,
    })),
    threads: ["mac", "cws"].map((environmentId) => ({
      id: `${environmentId}-thread`,
      projectId: "home",
      environmentId,
      pullRequests: [link],
    })),
  };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: {}, stackedThreadToast: vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: <T>(select: (settings: { pullRequestLinksOpenInApp: boolean }) => T) =>
    select({ pullRequestLinksOpenInApp: true }),
}));
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openPullRequest: state.openPullRequest }) },
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => "mac" }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {}, serverEnvironment: {} }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map(
        state.projects.map(({ environmentId }) => [
          environmentId,
          {
            environment: {
              capabilities: {
                pullRequests: true,
                threadPullRequests: true,
                ...(state.supported ? { pullRequestsWithoutCheckout: true } : {}),
              },
            },
          },
        ]),
      ),
  },
}));
vi.mock("../state/entities", () => ({
  useProjects: () => state.projects,
  readProjects: () => state.projects,
  readThreadShell: (ref: { environmentId: string; threadId: string }) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
}));

const local = { environmentId: EnvironmentId.make("mac"), threadId: ThreadId.make("mac-thread") };
const remote = { environmentId: EnvironmentId.make("cws"), threadId: ThreadId.make("cws-thread") };
const click = () => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  metaKey: false,
  ctrlKey: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.supported = true;
  for (const thread of state.threads) thread.pullRequests = [state.link];
});

describe("opening a linked PR from a parent-folder project", () => {
  it("opens the thread's right panel from a plain click", () => {
    const event = click();
    expect(useOpenChangeRequestLink(local)(event, state.url)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(state.openPullRequest).toHaveBeenCalledWith(local, {
      projectId: "home",
      host: "github.acme.test",
      repository: "team/nested-repo",
      number: 7,
      url: state.url,
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("opens an inactive remote sidebar thread on its own environment", () => {
    expect(useOpenChangeRequestLink()(click(), state.url, remote)).toBe(true);
    expect(state.openPullRequest).toHaveBeenCalledWith(
      remote,
      expect.objectContaining({
        projectId: "home",
        host: "github.acme.test",
        repository: "team/nested-repo",
        number: 7,
      }),
    );
  });

  it("prefers the primary environment on the PR page when the sidebar has no active thread", () => {
    state.threads.sort((left, right) => left.environmentId.localeCompare(right.environmentId));
    expect(useOpenChangeRequestLink()(click(), state.url)).toBe(true);
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/pull-requests",
        search: expect.objectContaining({
          selectedEnvironmentId: "mac",
          selectedProjectId: "home",
          selectedHost: "github.acme.test",
          number: 7,
        }),
      }),
    );
    expect(state.openPullRequest).not.toHaveBeenCalled();
  });

  it("keeps the browser fallback for a server without this capability", () => {
    state.supported = false;
    expect(useOpenChangeRequestLink(local)(click(), state.url)).toBe(false);
    expect(state.openPullRequest).not.toHaveBeenCalled();
  });

  it.each(["metaKey", "ctrlKey"] as const)(
    "preserves %s clicks for the external browser",
    (key) => {
      expect(useOpenChangeRequestLink(local)({ ...click(), [key]: true }, state.url)).toBe(false);
      expect(state.openPullRequest).not.toHaveBeenCalled();
    },
  );

  it("does not use another environment's saved links after unlinking locally", () => {
    const open = useOpenChangeRequestLink(local);
    state.threads.find((thread) => thread.environmentId === "mac")!.pullRequests = [];
    expect(open(click(), state.url)).toBe(false);
    expect(state.openPullRequest).not.toHaveBeenCalled();
  });

  it("leaves an unrelated PR URL to the ordinary browser handler", () => {
    expect(useOpenChangeRequestLink(local)(click(), state.url.replace("/7", "/8"))).toBe(false);
    expect(state.openPullRequest).not.toHaveBeenCalled();
  });
});
