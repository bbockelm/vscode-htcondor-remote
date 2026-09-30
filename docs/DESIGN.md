# VS Code inside an HTCondor job

Run the VS Code server in a job sandbox instead of on the access point, so the
editor's Node processes, file watchers and extension hosts land in a cgroup with
an owner and an eviction policy.

## Decisions

**Forward path, not reverse tunnel.** The API server reaches into the job with
`condor_ssh_to_job` over CEDAR (`golang-htcondor/schedd_ssh.go`, `OpenJobShell`),
rather than having an agent inside the job dial out (the `jupytertunnel` model).

The deciding argument is credentials. A reverse tunnel needs a *second
principal* — something in the sandbox that can authenticate to the web app. It
cannot run a browser OAuth2 flow and must not hold the signing secret, so
`jupytertunnel` had to invent a single-use HMAC bearer token with a nonce burn
set (`webapi/jupytertunnel/token.go`) plus a yamux control channel whose only
verb is "here is your next token" (`control.go`). The forward path has no
job-side principal at all: the user's OAuth2 session is the only credential, and
the job leg is authorized by the schedd's `GET_JOB_CONNECT_INFO` (UserCheck2).

It also wins on four smaller axes: no helper binary to transfer and therefore no
`HelperGOOS`/`HelperGOARCH` constraint on matching; it works on *any* running job
including ones not launched by this feature; it is stateless, so no
`adoptJupyterSessions` and no persistence to survive an API restart; and
terminal, exec and port-forward are all channels on one `ssh.Client`.

Keep `jupytertunnel` as the fallback for pools where the API server cannot reach
the starter at all.

**Browser first, desktop second.** `code-server` / `openvscode-server` (both MIT)
listen on a UDS or loopback port and drop straight onto the forward path with
almost no new code. Desktop Remote-SSH is worth more but costs a gateway. Build
the browser path first: it validates lifetime, reaping, files and queue latency,
which is where the real risk lives. Both are now built — the browser path end to
end, and the gateway the desktop path needs.

**Both, not either.** The finished product is one extension that carries the
HTCondor panels *and* opens a full native remote session; see section 3. The
browser path remains the zero-install entry point and the only one that works
from a Chromebook.

**No proposed VS Code APIs.** `registerRemoteAuthorityResolver` — the API that
would let us define our own `condor://` authority — is still proposed in 2026. It
needs `enable-proposed-api` in the user's `~/.vscode/argv.json` and cannot be
published to the Marketplace. So the remote session goes through Remote-SSH and
the gateway, and everything below uses stable, documented API.

## Verified facts

The sshd HTCondor spawns inside the job
(`htcondor/src/condor_starter.V6.1/condor_ssh_to_job_sshd_config_template.in`):

- No `AllowTcpForwarding` line, so OpenSSH defaults to `yes`. **Port forwarding
  works** — proven end to end, see below. VS Code's auto-forwarded ports come
  free.
- `AcceptEnv *`, `X11Forwarding yes`.
- The forced command ends in `eval ${SSH_ORIGINAL_COMMAND}`
  (`condor_ssh_to_job_shell_setup`), so arbitrary remote commands run, which is
  what the Remote-SSH bootstrap needs.
- **`sftp` works** — corrected 2026-09-30. It was claimed here that the forced
  command swallows a subsystem request into `eval sftp`; a probe against a real
  job gets a genuine `SSH_FXP_VERSION` reply (`type=2`, version 3, 318-byte
  extensions), so sshd honours `Subsystem sftp` and a real `sftp-server` answers.
  The original claim came from reading the config template's comment and
  reasoning, never from testing. That matters because Remote-SSH installs its
  server over SFTP or SCP, so this was the biggest risk to the desktop path and
  it is not real. Note the probe was `condor_ssh_to_job` **directly**; the SSH
  gateway is an extra hop, and it refused subsystem requests until #535 taught it
  to forward them.
- The expansion in `eval ${SSH_ORIGINAL_COMMAND}` is **unquoted**, so every
  command sent through ssh-to-job is word-split on IFS — newlines included —
  and rejoined with spaces before `eval` re-parses it. **A multi-line script
  does not survive**: it arrives as one line and dies on its first indented
  block. Anything sent this way must be a single line with no significant
  whitespace (base64 the payload), or be written to a file first and then run.
- Ciphers pinned to `aes*-ctr`, MACs to `hmac-sha2-*`. Fine for modern clients.
- **`direct-streamlocal@openssh.com` works** — a Unix socket in the sandbox is
  reachable. `x/crypto/ssh` supports it through `Client.Dial("unix", path)`
  (`DialContext` delegates to `Dial`), so no protocol code is needed.
- **A relative socket path does NOT resolve.** sshd's working directory is not
  the sandbox, so the absolute path is required — and only the job knows it.
- **`sun_path` is capped at ~104 bytes** and both ends are bound by it — `bind()`
  as much as `connect()`. The failure arrives as `open failed` and names nothing.

  **This is the normal case, not an edge case.** A glidein — an HTCondor EP
  running inside a SLURM job — nests its own `execute/dir_N` under the host batch
  system's, so the scratch path exceeds the limit before anything of ours is
  added. The harness reproduces it faithfully (112 bytes), which makes it an
  asset rather than an obstacle.

  Binding by bare name would keep the address short — and **does not work**:
  code-server calls `path.resolve()` on `--socket` before binding, so the long
  path comes back and it dies with `listen EINVAL`. Measured against 4.139.1.
  Every test using a stand-in server passed, because stand-ins bind relative
  happily; only running the real binary found it.

  So: a sandbox whose path **fits** keeps its socket inside itself. One whose
  path does not gets a socket in a short private directory under `/tmp`, mode
  0700. Either way the job **publishes the address** in `<socket>.path`, because
  the far end has no working directory of its own to resolve against — sshd
  resolves what we hand it against its own. The proxy reads that file through a
  command in the sandbox, where the working directory makes the read itself
  immune to the problem it is solving.

  `/tmp`, not `$TMPDIR`: HTCondor commonly points `TMPDIR` at the job's scratch
  directory, which is the one place guaranteed not to work.

  Refusing to start — which an earlier version did — would refuse on exactly the
  pools this is for.

Containers work. `.docker_sock` is the generic container socket, not a
docker-only one: `condor_docker_enter` passes fds plus a length-prefixed command
to the starter, which runs `condor_nsenter -t <pid>` into the job's namespaces
(`src/condor_starter.V6.1/os_proc.cpp:1204`). Both docker and apptainer land
*inside* the image. The caveat: nsenter needs a live target pid, found by
`findChildProc` heuristics, which is why `shell_setup` deliberately does not kill
the interactive placeholder when `.docker_sock` exists. **A containerized session
job must keep a long-lived main process alive.**

`GET_JOB_CONNECT_INFO` is registered at **WRITE** (`schedd.cpp:17533`). So
`condor:/WRITE` already covers shell access and no new OAuth2 scope is needed —
which matters, because narrowing the advertised scope list later is retroactive
and kills live grants.

## Architecture

Both paths share one machine-room half: the API server holds an ssh client into
the job, and every session is multiplexed over it. Only the client-facing half
differs.

```
  laptop                          access point                    execute node
  ------                          ------------                    ------------
                                  htcondor-api                    starter
                                       |                             |
  browser / VS Code                    |                             |
    |-- OAuth2 (PKCE/device) --------->|                             |
    |<-- access token -----------------|                             |
                                       |-- GET_JOB_CONNECT_INFO ---->| (schedd)
                                       |-- START_SSHD (CEDAR/CCB) -->|
                                       |-- ssh client ============>>>| sshd
                                       |                             |

  browser path
    |-- GET /api/v1/jobs/{id}/proxy/unix/vscode.sock/... ------------>|
    |<== HTTP + websockets, reverse-proxied over a direct-streamlocal | code-server
                                                                     |
  desktop path                                                       |
    |-- ssh 12345.0@ap:2222 (device flow) --------------------------->|
    |<== a session channel forwarded into the job's sshd ============>| bash / VS Code server
```

**Browser path.** `handleJupyterProxy`'s reverse-proxy logic with
`http.Transport{DialContext: ...}` pointed at the ssh client instead of the yamux
session. Only the dialer changes. The dial is `direct-streamlocal` to a Unix
socket, not a TCP port, so nothing in the job is reachable by anyone else on the
execute node.

**Desktop path.** The SSH gateway (section 2) terminates a real SSH connection on
the API server, authenticates it with the device flow, and forwards its channels
into the job over that same cached client. From the client's side it is one
ordinary SSH connection to one ordinary host, which is exactly what Remote-SSH
knows how to use.

## Components

### 1. Server (golang-htcondor) — SHIPPED

- **`webapi/jobssh`** — one `*ssh.Client` per `(owner, cluster, proc)`, idle-reaped.
  Opening one costs a schedd RPC, a CEDAR handshake possibly relayed through CCB,
  an SSH handshake and an sshd spawn; a page load's worth of requests must not
  each pay it. Owner is in the key because a transport authenticates as somebody
  — cedar's own session cache had the bug where it wasn't, and one user's request
  resumed a session another had authenticated.
- **`ANY /api/v1/jobs/{id}/proxy/{port}/{rest...}`** — an `httputil.ReverseProxy`
  whose `Transport.DialContext` goes through the cache.
- **`ANY /api/v1/jobs/{id}/proxy/unix/{socket}/{rest...}`** — the same, to a Unix
  socket in the job's scratch directory. `jobssh` resolves `_CONDOR_SCRATCH_DIR`
  once per transport and memoizes it (failure included). The socket name is held
  to a bare filename over `[A-Za-z0-9._-]`: it is the only part of the path a
  request controls.
- `/api/v1/jobs/{id}/ssh` (existing PTY bridge) is unchanged.

#### Socket, not port — this is a security decision, not a preference

A TCP port bound to `127.0.0.1` inside a sandbox is reachable by **any local user
on the execute node** unless the job has its own network namespace, which no pool
can be assumed to configure. So `code-server --auth none` on a TCP port is a real
hole on a shared EP. A socket in the scratch dir is protected by file permissions
instead — which is what `jupytertunnel` already does with `--socket`, and the
reason no per-session secret is needed anywhere in this design.

The port form stays only because it is the only way to reach a job somebody else
set up.

**No `/forward/{port}` WebSocket endpoint.** An earlier draft had one; it isn't
needed. The browser never speaks a forwarding protocol — it makes ordinary HTTP
requests to the API server, which dials into the job internally. A raw forwarding
endpoint earns its place only for the desktop transport and for "forward a port
in my job to my laptop", and both can wait.

The desktop path needs no forwarding endpoint either, as it turned out. An
earlier draft had it relaying raw SSH bytes to a gateway in the extension; the
gateway moved to the server (section 2), and a real SSH port needs no tunnel
under it.

#### Three lifetime rules, each of which was wrong first

- A transport is reapable only when **nothing holds a connection AND** it has been
  idle. One connection can stay open for hours, so the idle clock alone closes a
  transport mid-session.
- **A refused port must not evict the transport.** A server in the job that hasn't
  finished starting refuses connections, which says nothing about the transport
  carrying them. Only the watcher — which sees the transport itself end — evicts.
  Confusing the two costs a full handshake on every poll.
- **`Close` must not wait on the watchers.** A watcher blocks until its transport
  ends, and an in-use transport is closed by its last release — so waiting
  deadlocks `Close` against the very request it is trying not to cut off.

#### Details inherited from the Jupyter proxy

- `Director`, not `Rewrite`: `Rewrite` changes which forwarded headers an app
  builds its own URLs from.
- Pass the browser's `Host` through. Apps compare it against `Origin` to reject
  cross-site requests, and code-server and JupyterLab both do; a rewritten `Host`
  makes the app 404 its own internal API calls.
- **Never delete the `Connection` header in the Director.** `ReverseProxy` reads
  it *after* the Director runs to decide whether a request is a protocol upgrade.
  Deleting it turns every WebSocket handshake into a plain GET the app answers
  with 400 — which an editor shows as loading fine and then never connecting. A
  test drives a real WebSocket through the proxy for exactly this.

#### Consequence for whatever runs in the job

Nothing rewrites the HTML that comes back, so the app's own absolute URLs must
already be right. For an app that can be told its prefix — JupyterLab's
`base_url` — tell it. code-server cannot be: it has no such flag, and its
`--abs-proxy-base-path` is for the *reverse* case, its own built-in proxy for
ports inside the session. So the proxy strips the prefix, and the one absolute
URL that matters — the root — is fixed by redirecting to the trailing-slash form
so every relative link resolves under the prefix.

### 2. SSH gateway (server-side, shipped)

```
ssh 12345.0@ap.example.edu -p 2222
```

An SSH port on the API server that authenticates with the OAuth2 device flow and
drops the caller into a job. Merged as #531; `HTTP_API_SSH_GATEWAY_ADDRESS` turns
it on.

This replaced an earlier design in this document — a loopback SSH server inside
the extension, relaying channels over a WebSocket. The server-side version is
better on every axis: the trust story is the API server's either way (see below),
there is no second SSH implementation to maintain, and the client needs nothing
installed. Anything that speaks SSH can reach a job.

Two properties matter for the extension:

- **The device flow needs no key and no client configuration.** The prompt is an
  ordinary RFC 4256 keyboard-interactive challenge, which every SSH client
  already renders.
- **Certificates exist for the non-interactive case.** `BatchMode=yes` refuses
  keyboard-interactive outright, so `GET /api/v1/ssh/ca` publishes the authority
  and `POST /api/v1/ssh/certificate` signs a public key, 12 hours by default.
  There is no revocation, so the lifetime is the only control.

Subsystem requests are forwarded to the job, so `scp` and `sftp` work — which
Remote-SSH needs to install its server. They were refused until #535, on a claim
about the forced command that was never tested and turned out to be false.

#### Trust, stated

**The API server sees the session in the clear.** That is not a regression: it
mints the user's IDTOKEN, reads and writes the job's files, proxies HTTP into the
job, and its terminal bridge already sees every keystroke.

Nor is there an arrangement here that avoids it. An earlier draft had the
extension originate a second SSH to the job so the API server "could not read" it
— which is fake, because the `START_SSHD` reply carries the job's per-session
private key in cleartext and the API server reads it. One trusted party, said
plainly, beats two SSH layers implying otherwise.

### 3. Extension

One extension, two halves that sell each other: **HTCondor panels** for the work
that is HTCondor-shaped, and the **full native remote experience** for the work
that is just coding. Neither alone is the product. The panels without the remote
session are a job monitor, which `condor_q` already is. The remote session
without the panels is Remote-SSH with a strange hostname, which teaches the user
nothing about where their code is running.

#### Panels

Ordinary, stable VS Code extension API over the REST endpoints that already
exist:

- **Jobs view** — a `TreeDataProvider` over `GET /api/v1/jobs`, grouped by
  status, with hold reasons inline. Context menu: hold, release, remove.
- **Submit from the editor** — a submit file in the editor gets a "Submit" lens;
  `POST /api/v1/jobs`, then reveal the new cluster in the jobs view. Remember
  that submit is two-step: the job is held until its input spool lands.
- **Logs** — open a job's stdout/stderr as a read-only document that tails.
- **Sandbox browsing** — a `FileSystemProvider` on a `condor:` scheme over the
  spool endpoints, so a running job's files open like any other file.
- **Terminal in a job** — a `Pseudoterminal` over the existing
  `/api/v1/jobs/{id}/ssh` WebSocket. This one already works in the web UI; the
  extension is a second front end on the same bridge.

#### The remote experience

`vscode.openFolder` on `vscode-remote://ssh-remote+<authority>/<path>`, with the
gateway from section 2 as the authority. That gives the real thing: the extension
host runs *in the job*, so IntelliSense, debugging, the integrated terminal and
every other extension see the job's filesystem, its GPUs and its environment.

The approach we are **not** taking is `registerRemoteAuthorityResolver`, which
would let us define a `condor://` authority and resolve it ourselves. It is still
proposed API in 2026: it requires `enable-proposed-api` in `~/.vscode/argv.json`
and cannot be published to the Marketplace. A resolver we cannot ship is not a
plan.

So we reuse Remote-SSH, and the whole question becomes how to point it at the
gateway without editing the user's `~/.ssh/config` — which is theirs, and which
an extension has no business rewriting.

#### Tested by hand, 2026-09-30 — it connects

```
vscode-remote://ssh-remote+ap2001-ssh.chtcdev.chtc.io/home/bbockelm
```

**A full VS Code Remote session into an HTCondor job works, end to end.**
Remote-SSH authenticated through the device flow, opened a shell, installed its
server and connected. **No ssh config, no key, no certificate, no settings, no
wrapper.** `BatchMode=yes` was the feared blocker and is not one.

Two things had to be fixed or noted on the way, and the second is the one that
shapes the extension.

**1. The session needs far more disk.** The first attempt died unpacking, on
`ENOSPC` — the session job asked for 1 GiB, and the VS Code server with a bundled
Copilot build does not fit in it, before any of the user's own code. CHTC's EPs
enforce disk with a per-job filesystem, so the ceiling arrives as a real `ENOSPC`
from the kernel rather than as a held job, which is why it surfaced as a tar
error deep in a client log with nothing in the HTCondor log to explain it. Fixed
in golang-htcondor #538: an interactive session now defaults to 8 GiB, which also
puts it back in line with an app's 10 GiB and a Jupyter session's 4 GiB.

Related, and not fixed by more disk: the sandbox dies with the session, so
`~/.vscode-server` is re-downloaded every time a session is recreated. A few
hundred MB per start is tolerable once and not as a habit. Options are a
longer-lived session job, or staging the server from a cache the EP already has.

**2. The device-code prompt is unusable through Remote-SSH.** It renders — the
keyboard-interactive challenge is not swallowed — but it lands in the *stderr of
Remote-SSH's ssh process*, which a user sees only by opening the Output panel and
picking the right channel. The first tester had to fish the URL out by hand. A
login you have to go looking for is not a login.

So the ordering inverts. **The certificate is the primary path and the device
flow through ssh is the fallback**, which is the reverse of what this document
said before the test.

The extension already has to be an `AuthenticationProvider`, and that is where a
login prompt belongs: VS Code's own account UI, a browser opened by
`vscode.env.openExternal`, progress in a notification. Having authenticated
there, the extension holds a token, so it can:

1. generate a keypair in its own storage (never `~/.ssh`),
2. `POST /api/v1/ssh/certificate`, hold the certificate in `SecretStorage`,
3. renew it before it expires — 12 hours by default, 24 maximum, because the
   gateway has no revocation,
4. and connect with no prompt at all, ever.

The user sees a normal VS Code sign-in and then a window that opens. They never
meet SSH.

**Pointing Remote-SSH at that certificate** without touching `~/.ssh/config`,
which is the user's file and not ours. Two candidates, in order:

- `remote.SSH.configFile` — an alternate config file. The extension writes one
  into its storage with a `Host` block naming our gateway, our `IdentityFile` and
  our `CertificateFile`. Cleanest if it works, with one catch: the setting
  replaces the user's config for *every* Remote-SSH host, so ours must begin with
  `Include ~/.ssh/config` or we break their other hosts.
- `remote.SSH.path` — a wrapper script that injects `-i` and
  `-o CertificateFile=` for our hosts only and execs the real `ssh` for
  everything else, chaining to whatever the setting already held.

Both are settings we can revert. Neither edits a file the user maintains.

#### Auth plumbing

- `vscode.authentication.registerAuthenticationProvider` — stable API. Sessions
  appear in the accounts menu, tokens in `SecretStorage`,
  `getSession({createIfNone: true})` drives the flow.
- `vscode.window.registerUriHandler` for a `vscode://` redirect. Better than
  loopback because `vscode.env.asExternalUri` tunnels the callback back to the
  laptop even when the extension host is itself remote — which is the situation
  once the user is inside a job. Needs the server to accept a custom scheme in
  `redirect_uris`.

## Auth

Auth code + PKCE with a **loopback redirect** is the primary flow and works
against the server today: `oauth2_cimd.go:186-210` handles loopback redirects
with ephemeral ports, including treating the `localhost` name as loopback, with
a comment noting that real native clients register both `127.0.0.1` and
`localhost` and then request an ephemeral port.

**Device code is the fallback**, not the default — the laptop has a browser. It
is fully built (`/mcp/oauth2/device/authorize`, advertised in discovery) and
accepts public clients: the device-authorize handler only does
`GetClient(ctx, clientID)`, no client authentication. Use it when the extension
host is already remote and cannot open a loopback port the laptop can reach.

Registration: the extension is a public client. Discovery only offers
`token_endpoint_auth_methods_supported: none` when CIMD is enabled, so the
extension needs either CIMD (publish a metadata document at an https URL and skip
registration — cleanest for a published extension) or DCR at
`/mcp/oauth2/register`.

`offline_access` is mandatory: an editor session lives for days.

### Prerequisite — DONE

`/api/v1/*` did not accept OAuth2 access tokens. `createAuthenticatedContext`
introspected the opaque token to learn the caller's name, then handed that same
opaque token to cedar as the HTCondor credential; the schedd cannot verify it and
the FS fallback is stripped, so every schedd-backed endpoint failed for callers
who had authenticated correctly, while `/api/v1/whoami` answered with their name.

Fixed on branch `oauth2-rest-idtoken` in golang-htcondor: mint the IDTOKEN the
way the MCP data path does, bounded by the grant's scopes.

## Open questions

1. ~~**`ssh.Client.Dial` through a job.**~~ **Settled 2026-09-29: it works.**
   `TestSSHToJobIntegration` now has a fourth step that starts a listener inside
   the sandbox and reaches it with `client.Dial` (golang-htcondor branch
   `sshtojob-portforward`). Note for future debugging: `administratively
   prohibited` means forwarding is disabled, `connect failed` means forwarding
   works and nothing is listening. They are not the same finding.
2. **Files.** A sandbox is empty and ephemeral, and CHTC execute nodes have no
   shared home. Ship-in/ship-out via spool is fine for a container recipe and
   useless for a 40 GB dataset. Offer both in the launch form: "on the access
   point (your files)" vs "on an execute node (fresh sandbox)". An AP-local
   startd solves the sysadmins' actual complaint — resource containment — with no
   file problem at all, and should probably ship first.
3. **Preemption.** A session dying mid-edit is unacceptable. Needs a
   non-preemptible interactive partition or serious `MaxJobRetirementTime`.
4. **Idle reaping.** An open tab heartbeats forever, so traffic-based idle
   detection reaps the closed session and never the abandoned one — the
   `jupytertunnel` comments already say this. Worse for VS Code, whose extension
   host polls constantly. The `periodic_remove` lifetime ceiling is the backstop
   the sandbox cannot argue with.
5. **Queue latency.** Waiting 20 minutes to open an editor is worse than SSH'ing
   to the AP. Needs fast-start interactive slots or this is not adopted.
6. ~~**Server install cost.**~~ **Settled: a published container image.**

   code-server is a **222 MB** download (~500 MB extracted). That rules out
   `transfer_input_files`, which would pay it per session, and rules out shipping
   it with this project, which is the wrong side of the wire entirely — it has to
   land on the *execute* node. A container image is cached by the execute node,
   so repeat sessions there start immediately.

   **Use `codercom/code-server`** — code-server's own image, amd64 and arm64,
   tracking releases closely (4.139.1 published 2026-09-26). Pinned, never
   `latest`: a session whose editor changes under it between one day and the next
   is a support problem nobody can reproduce.

   Two alternatives, recorded so nobody re-derives them:
   - `gitpod/openvscode-server` — no release since 2025-10. Stale.
   - `linuxserver/code-server` — the most popular on Docker Hub, but built around
     s6-overlay, which wants to be PID 1 supervising services. Poor shape here.

   Note that these images expect to run as their own user (`coder`, `/home/coder`),
   while apptainer runs the job as the submitting user — so `$HOME` is typically
   not writable. That is item 8.

   **We do not build or maintain an image.** A site that wants its own toolchain
   should build one, because extensions baked into an image are free in every
   session while hand-installed ones are reinstalled each time. `build_container`
   (`webapi/mcpserver/handlers_build.go`) already builds from a definition file or
   Dockerfile inside a job and stages the `.sif` to `osdf://`/`pelican://` under
   `HTTP_API_BUILD_STAGING_BASE`, with per-user path templating. That is a
   suggestion, not something this feature does for you.

7. **Watchers.** Set `files.watcherExclude` aggressively or a large tree blows
   the job's memory request.
8. **Editor state and `$HOME`.** The server keeps state, extensions and config
   under `$HOME` by default. In a container that is often unwritable, and when it
   *is* writable it may be a real shared home — where one session's extensions
   outlive it and reach the next. The launcher uses `$HOME` when the job has a
   usable one (which is what a mounted home produces, and where a user wants
   extensions to persist) and the scratch directory otherwise. Mounting the home
   directory is planned as an option.

## Milestones

1. ~~`/api/v1/*` accepts OAuth2 access tokens~~ — done.
2. ~~Validate `ssh.Client.Dial` through a real job~~ — done, it works.
3. ~~Session cache~~ + ~~reverse proxy into a job~~ — done (`job-ssh-proxy`).
4. ~~`code-server` launcher~~, ~~`/api/v1/apps`~~, ~~integration tests~~, ~~UI~~ —
   **done.** The browser path is complete: a user can launch a session from
   `/interactive` and open the editor. Requirements that were settled along the
   way, kept because they constrain anything else served this way:
   - A Unix socket, never a TCP port.
   - **Publish the socket's address** in `<socket>.path`, and pick that address
     to fit `sun_path` — the scratch directory when it fits, a private directory
     under `/tmp` when it does not. Binding by bare name from the scratch
     directory would have been shorter still, but code-server calls
     `path.resolve()` on `--socket` before binding, so the relative form never
     reaches `bind()`. An earlier version checked the length and refused, which
     would have refused on every glidein.
   - Nothing tells the server its URL prefix: no such flag exists. The proxy
     strips the prefix and redirects to the trailing-slash form instead.
   - The launcher script must be a single line or a transferred file: anything
     sent through ssh-to-job is word-split and rejoined (see above), and a
     containerized session must keep a long-lived main process alive for
     `condor_nsenter` to have a target.
   - `--auth none` is then correct, because nothing but the owner can open the
     socket.
5. ~~SSH gateway~~ — **done, and server-side rather than in the extension**
   (#531): an SSH port on the API server, device flow over
   keyboard-interactive, plus `GET /api/v1/ssh/ca` and
   `POST /api/v1/ssh/certificate` for the `BatchMode` case. Subsystem requests
   are forwarded (#535), so `scp`/`sftp` work and Remote-SSH can install its
   server. No `direct-tcpip` endpoint is needed: `ssh -J`/`ProxyJump` against
   the gateway is the forward.
6. ~~**Confirm Remote-SSH against the gateway by hand**~~ — **done 2026-09-30,
   it connects**, with nothing configured. See the test notes in section 3. It
   left two things to fix:
7. ~~**Raise the session's disk.**~~ — done, #538, 8 GiB in both
   `interactive.applySpecDefaults` and the REST surface. Still open: whether
   `~/.vscode-server` should survive a session, because a sandbox does not, and
   whether 1 GiB of memory holds an extension host with Copilot in it.
8. Extension, panels: auth provider, jobs view, submit lens, log tailing,
   terminal over the existing ssh WebSocket. All stable API, no unknowns — this
   is shippable on its own and is what makes the extension worth installing
   before a remote session is ever opened.
9. Extension, remote: keypair + certificate + renewal behind the auth provider,
   `remote.SSH.configFile` (or the wrapper) to point Remote-SSH at it, then
   submit, poll to Running and `openFolder`. The certificate is what makes this
   promptless; without it the user hunts for a URL in an Output channel.
