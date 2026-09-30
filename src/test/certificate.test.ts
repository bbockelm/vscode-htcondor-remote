import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { HTCondorApi } from "../api";
import { CertificateManager, KeyStore } from "../certificate";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "htcondor-cert-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

class MemoryKeyStore implements KeyStore {
	private readonly values = new Map<string, string>();
	async get(key: string) {
		return this.values.get(key);
	}
	async store(key: string, value: string) {
		this.values.set(key, value);
	}
}

/** Counts what the server was asked for, and by whom. */
interface Calls {
	ca: number;
	sign: number;
	signedKeys: string[];
}

function fakeApi(calls: Calls, validBefore: () => Date): HTCondorApi {
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/v1/ssh/ca")) {
			calls.ca++;
			return jsonResponse({
				public_key: "ecdsa-sha2-nistp256 AAAACA",
				known_hosts_line: "@cert-authority * ecdsa-sha2-nistp256 AAAACA",
				fingerprint: "SHA256:ca",
			});
		}
		if (url.endsWith("/api/v1/ssh/certificate")) {
			calls.sign++;
			const body = JSON.parse(String(init?.body)) as { public_key: string };
			calls.signedKeys.push(body.public_key);
			return jsonResponse({
				certificate: `ecdsa-sha2-nistp256-cert-v01@openssh.com SIGNED${calls.sign}`,
				principal: "bbockelm",
				valid_before: validBefore().toISOString(),
				fingerprint: "SHA256:cert",
			});
		}
		throw new Error(`unexpected request to ${url}`);
	};
	return new HTCondorApi("https://ap.example.edu", async () => "token", fetchImpl);
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("writes a key, a certificate and a known_hosts ssh can use", async () => {
	const calls: Calls = { ca: 0, sign: 0, signedKeys: [] };
	const expiry = new Date(Date.now() + 12 * 3600 * 1000);
	const mgr = new CertificateManager(fakeApi(calls, () => expiry), new MemoryKeyStore(), dir);

	const paths = await mgr.ensure();

	// The real check: OpenSSH reads the private key we wrote. A test
	// that only asserted the file exists would pass on any bytes at all.
	const pub = execFileSync("ssh-keygen", ["-y", "-f", paths.privateKey], { encoding: "utf8" });
	assert.match(pub, /^ecdsa-sha2-nistp256 /);

	assert.match(readFileSync(paths.certificate, "utf8"), /^ecdsa-sha2-nistp256-cert-v01@openssh\.com /);
	assert.match(readFileSync(paths.knownHosts, "utf8"), /^@cert-authority \* /);

	// ssh refuses a private key others can read, so the mode is part of
	// the contract and not housekeeping.
	assert.equal(statSync(paths.privateKey).mode & 0o077, 0, "private key is readable by somebody else");
});

test("a second call does nothing while the certificate is good", async () => {
	const calls: Calls = { ca: 0, sign: 0, signedKeys: [] };
	const expiry = new Date(Date.now() + 12 * 3600 * 1000);
	const mgr = new CertificateManager(fakeApi(calls, () => expiry), new MemoryKeyStore(), dir);

	await mgr.ensure();
	await mgr.ensure();
	await mgr.ensure();

	assert.equal(calls.sign, 1, "asked the server to sign again while holding a valid certificate");
});

test("renews inside the last hour, and reuses the same key when it does", async () => {
	const calls: Calls = { ca: 0, sign: 0, signedKeys: [] };
	const issued = new Date("2026-09-30T12:00:00Z");
	let now = issued;
	const mgr = new CertificateManager(
		fakeApi(calls, () => new Date(now.getTime() + 12 * 3600 * 1000)),
		new MemoryKeyStore(),
		dir,
		() => now
	);

	await mgr.ensure();
	assert.equal(calls.sign, 1);

	// 11 hours on: 1 hour left, which is the renewal window exactly.
	now = new Date(issued.getTime() + 11 * 3600 * 1000);
	await mgr.ensure();
	assert.equal(calls.sign, 2, "did not renew with an hour left");

	// The certificate rotates; the key underneath it does not.
	assert.equal(calls.signedKeys.length, 2);
	assert.equal(calls.signedKeys[0], calls.signedKeys[1], "rotated the keypair on renewal");
});

test("an expired certificate is replaced rather than used", async () => {
	const calls: Calls = { ca: 0, sign: 0, signedKeys: [] };
	const issued = new Date("2026-09-30T12:00:00Z");
	let now = issued;
	const mgr = new CertificateManager(
		fakeApi(calls, () => new Date(now.getTime() + 12 * 3600 * 1000)),
		new MemoryKeyStore(),
		dir,
		() => now
	);

	await mgr.ensure();
	now = new Date(issued.getTime() + 13 * 3600 * 1000);
	await mgr.ensure();

	assert.equal(calls.sign, 2, "kept using a certificate that had already expired");
});

test("a server with no CA says so in terms an operator can act on", async () => {
	const fetchImpl: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "This access point does not issue SSH certificates" }), {
			status: 503,
		});
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", fetchImpl);
	const mgr = new CertificateManager(api, new MemoryKeyStore(), dir);

	await assert.rejects(mgr.ensure(), /HTTP_API_SSH_CA_KEY_FILE/);
});

test("narrows the mode of a key file that already existed", async () => {
	// writeFile honours its mode only when it creates the file, so a
	// key left over from an older version -- or dropped there by
	// anything else -- would keep its permissions through every
	// renewal, and ssh would refuse to use it.
	const calls: Calls = { ca: 0, sign: 0, signedKeys: [] };
	const expiry = new Date(Date.now() + 12 * 3600 * 1000);
	const mgr = new CertificateManager(fakeApi(calls, () => expiry), new MemoryKeyStore(), dir);

	mkdirSync(dir, { recursive: true });
	writeFileSync(mgr.paths.privateKey, "stale", { mode: 0o644 });
	assert.notEqual(statSync(mgr.paths.privateKey).mode & 0o077, 0, "setup did not create a loose file");

	await mgr.ensure();

	assert.equal(statSync(mgr.paths.privateKey).mode & 0o077, 0, "left the existing key world-readable");
});
