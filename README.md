# HTCondor for VS Code

Run and edit your work inside an HTCondor job, from the editor you already use.

**Status: early. Not yet published to the Marketplace.** The pieces below are
built and tested; the panels are not written yet.

## What it does

Sign in once, through VS Code's own account UI, and open a remote window whose
extension host runs *inside a job*. IntelliSense, the debugger, the integrated
terminal and every other extension then see the job's filesystem, its GPUs and
its environment — not the access point's.

That last part is the point. A VS Code session on a shared access point puts its
Node processes, file watchers and extension hosts where they compete with
everyone else's work; the same session inside a job lands in a cgroup with an
owner and an eviction policy.

## How it connects

```
VS Code ──ssh──▶ access point's SSH gateway ──condor_ssh_to_job──▶ your job
```

Remote-SSH does the connecting. This extension's job is to make that possible
with nothing for you to configure:

- **Signing in** is OAuth2 with PKCE against your access point, over a loopback
  redirect. The extension registers itself, so there is no client secret shipped
  in it and an administrator can revoke one installation.
- **Reaching the gateway** uses a short-lived SSH certificate — fifteen minutes,
  renewed in the background. The gateway has no revocation, so the lifetime is
  the only control over a certificate somebody copies; at fifteen minutes it is
  worth little more than the minutes left on it.
- **Trusting the host** comes from the same certificate authority, fetched from
  the access point. No host-key prompt, and no pinning by hand.
- **Pointing Remote-SSH at it** is a generated `ssh_config` in this extension's
  own storage, referenced by the `remote.SSH.configFile` setting. Your
  `~/.ssh/config` is never edited, and whatever that setting already held is
  included, so your other hosts keep working.

The gateway itself authenticates with an OAuth2 device code when you `ssh` to it
by hand. That works and is unpleasant through Remote-SSH, which renders the
prompt into a log nobody reads — which is why the extension uses a certificate
and you never see a prompt at all.

## Settings

| Setting | Meaning |
| --- | --- |
| `htcondor.serverUrl` | Your access point, e.g. `https://ap.example.edu`. |
| `htcondor.sshGateway` | The host you would `ssh` to, e.g. `ap.example.edu` or `ap.example.edu:2222`. Only needed while your access point does not publish its own address. |

## Requirements

- An HTCondor access point running `htcondor-api` with MCP/OAuth2 enabled and an
  SSH gateway configured.
- The **Remote - SSH** extension.
- An `ssh` on your PATH. Every desktop OS ships one.

## Developing

```bash
npm install
npm test        # type-check, then run the suite
npm run bundle  # what actually ships
```

The tests use `ssh` and `ssh-keygen` as oracles rather than as conveniences: the
key encoding and the generated `ssh_config` are both checked against what
OpenSSH itself makes of them, because a test comparing them to our own idea of
the format would pass just as happily on something no client can use.

## Design

`docs/DESIGN.md` carries the reasoning, including the paths that were tried and
rejected — an SSH server inside the extension, a pre-authenticated relay, and
`registerRemoteAuthorityResolver` — and why.
