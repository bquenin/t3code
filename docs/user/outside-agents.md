# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host, T3
  Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts on the host

On the machine that runs the environment, `t3 thread` uses the same tools
without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Reach other environments

Agents in one environment can also work with threads in your other environments,
such as a desktop app on your laptop driving a server on a remote machine. The
environment the agents run in is the hub; each environment it reaches is a peer.
Peers need no setup beyond a token.

1. On the peer, mint a token for the hub:

   ```sh
   t3 auth session issue --mcp-client-access full-access --label hub --ttl 8760h --token-only
   ```

   The access works like the mode you choose for an outside agent: `read-only`
   only reads, and threads the hub starts on the peer cannot run with broader
   permissions than the access you pick. It is also the ceiling for everything
   the hub's agents do on the peer, so pick the access you would grant those
   agents themselves.

2. On the hub, save the token in a file only you can read, then add the peer to
   the server's `settings.json` in its `userdata` directory:

   ```json
   {
     "peerEnvironments": [
       {
         "label": "build-box",
         "url": "http://127.0.0.1:3790",
         "bearerTokenFile": "/home/me/.t3/build-box.token"
       }
     ]
   }
   ```

   `label` is a short lowercase name (letters, digits and `-`). `url` is the
   peer's `http://` or `https://` address with no path; the hub adds `/mcp`.
   Changes apply without a restart.

Agents on the hub see the peers in `t3_environment_read` and pass a label as
`environment` to `t3_project_list`, `t3_thread_list`, `t3_thread_search`,
`t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_organize` and
`t3_thread_launch`.

- The hub must reach the peer's URL itself: over Tailscale, a tunnel, or an
  SSH forward. When you SSH from the peer's machine to the hub's, forward the
  peer's port with `-R` (or `RemoteForward`), for example
  `ssh -R 3790:127.0.0.1:3773 hub-host` (3773 is the desktop app's usual port); when you SSH from the hub's machine to
  the peer's, use `-L` (or `LocalForward`).
- Peer calls only work while the peer's server is running.
- Ids from a peer only mean something there. Results from a peer carry its
  `environment`; pass the same `environment` with any thread or project id
  from them. Listing threads or launching on a peer needs a `projectId` from
  that peer's `t3_project_list`, or `scratch: true` for a launch. Organizing a
  peer's thread needs its `threadId`.
- Attachments stay in the environment they were uploaded to, so a launch on a
  peer refuses them. Put their content in the message instead.
- To cut a hub off, revoke its session on the peer in **Settings →
  Connections** or with `t3 auth session revoke`.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
