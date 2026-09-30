import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { renderConfig, writeSSHConfig } from "../sshconfig";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "htcondor-sshcfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CA_LINE = "@cert-authority ap.example.edu,[ap.example.edu]:* ssh-ed25519 AAAAC3Nz";

/**
 * What `ssh` itself makes of our config.
 *
 * `ssh -G` resolves a host exactly as a real connection would and
 * prints the result, without connecting. It is the oracle here for the
 * same reason ssh-keygen is elsewhere: a test comparing our file
 * against our own idea of the format would pass just as happily on
 * something ssh cannot use.
 */
function effectiveConfig(configFile: string, alias: string): Map<string, string> {
	const out = execFileSync("ssh", ["-G", "-F", configFile, alias], { encoding: "utf8" });
	const settings = new Map<string, string>();
	for (const line of out.split("\n")) {
		const at = line.indexOf(" ");
		if (at > 0 && !settings.has(line.slice(0, at))) {
			settings.set(line.slice(0, at), line.slice(at + 1).trim());
		}
	}
	return settings;
}

test("ssh resolves our host to the relay", async () => {
	const paths = await writeSSHConfig(
		dir,
		[{ alias: "condor-12345.0", port: 54321, target: "12345.0", gatewayName: "ap.example.edu" }],
		CA_LINE
	);

	const cfg = effectiveConfig(paths.configFile, "condor-12345.0");
	assert.equal(cfg.get("hostname"), "127.0.0.1");
	assert.equal(cfg.get("port"), "54321");
	assert.equal(cfg.get("user"), "12345.0");
	assert.equal(cfg.get("hostkeyalias"), "ap.example.edu");
	// ssh -G normalises yes/no to true/false, which is worth asserting
	// against rather than guessing: the point is what ssh concluded,
	// not what we wrote.
	assert.equal(cfg.get("pubkeyauthentication"), "false");
	assert.equal(cfg.get("stricthostkeychecking"), "true");
});

// The one that breaks host verification if it regresses, in a way that
// looks unrelated to the cause: without HostKeyAlias, ssh checks the
// name it dialled -- 127.0.0.1 -- against a certificate issued for the
// access point and a known_hosts pattern scoped to it. Both miss, and
// the user is asked to trust an unknown host.
test("the known_hosts file ssh uses is the one we wrote", async () => {
	const paths = await writeSSHConfig(
		dir,
		[{ alias: "condor-work", port: 40000, target: "+work", gatewayName: "ap.example.edu" }],
		CA_LINE
	);

	const cfg = effectiveConfig(paths.configFile, "condor-work");
	const known = cfg.get("userknownhostsfile") ?? "";
	assert.ok(
		known.includes(paths.knownHosts),
		`ssh resolved userknownhostsfile to ${known}, want ${paths.knownHosts}`
	);
	assert.equal(readFileSync(paths.knownHosts, "utf8").trim(), CA_LINE);
});

// ssh takes the FIRST value it obtains for each keyword, so including
// the user's config before ours would let a `Host *` block in it
// override the settings that make these hosts work.
test("our settings win over the user's own config", async () => {
	const text = renderConfig(
		[{ alias: "condor-a", port: 1234, target: "1.0" }],
		join(dir, "known_hosts")
	);
	const ourBlock = text.indexOf("Host condor-a");
	const include = text.indexOf("Include ");
	assert.ok(ourBlock >= 0 && include >= 0, "expected both a Host block and an Include");
	assert.ok(ourBlock < include, "the Include comes before our Host block, so the user's config wins");
});

// A user's own hosts have to keep working; the setting this file is
// installed under replaces their config for every Remote-SSH host, not
// just ours.
test("a host we did not write still resolves through the include", async () => {
	const paths = await writeSSHConfig(dir, [{ alias: "condor-a", port: 1234, target: "1.0" }], CA_LINE);
	const cfg = effectiveConfig(paths.configFile, "somewhere.else.example");
	assert.equal(cfg.get("hostname"), "somewhere.else.example");
	// Ours must not have leaked onto it.
	assert.notEqual(cfg.get("port"), "1234");
});

test("an empty target names the default session, not the local user", async () => {
	const paths = await writeSSHConfig(dir, [{ alias: "condor-default", port: 2222, target: "  " }], CA_LINE);
	const cfg = effectiveConfig(paths.configFile, "condor-default");
	assert.equal(cfg.get("user"), "default");
});

// Windows profiles have spaces in them and this file is written under
// one, so an unquoted path is read as two arguments.
test("paths with spaces survive", async () => {
	const spaced = join(dir, "Jo Smith", "storage");
	const paths = await writeSSHConfig(spaced, [{ alias: "condor-a", port: 1234, target: "1.0" }], CA_LINE);

	// Asserted on the text, not through `ssh -G`, because -G cannot
	// tell the two cases apart. UserKnownHostsFile takes a LIST, so an
	// unquoted `.../Jo Smith/known_hosts` becomes two files -- neither
	// of which exists -- and -G prints them space-separated, which
	// reads back exactly like the one correct path. The failure only
	// appears later, as host verification that silently never matches.
	const text = readFileSync(paths.configFile, "utf8");
	assert.ok(
		text.includes(`UserKnownHostsFile "${paths.knownHosts}"`),
		`the path is not quoted as a single argument:\n${text}`
	);

	// And ssh still parses the file, which is the other half.
	assert.equal(effectiveConfig(paths.configFile, "condor-a").get("port"), "1234");
});

test("several hosts coexist", async () => {
	const paths = await writeSSHConfig(
		dir,
		[
			{ alias: "condor-1.0", port: 5000, target: "1.0" },
			{ alias: "condor-2.0", port: 5000, target: "2.0" },
		],
		CA_LINE
	);
	assert.equal(effectiveConfig(paths.configFile, "condor-1.0").get("user"), "1.0");
	assert.equal(effectiveConfig(paths.configFile, "condor-2.0").get("user"), "2.0");
});

test("the files are not readable by anyone else", async () => {
	const paths = await writeSSHConfig(dir, [{ alias: "condor-a", port: 1234, target: "1.0" }], CA_LINE);
	for (const file of [paths.configFile, paths.knownHosts]) {
		assert.equal(statSync(file).mode & 0o077, 0, `${file} is readable by others`);
	}
});
