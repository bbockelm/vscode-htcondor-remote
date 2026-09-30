import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { encodePublicKey, generateKeyPair } from "../openssh";

// OpenSSH itself is the oracle here, and deliberately so. The thing
// being tested is agreement with an implementation we do not control:
// a unit test that checked our encoder against our own idea of the
// format would pass just as happily on a blob `ssh` cannot read.
//
// `ssh-keygen -y` reads a private key and prints the public key. That
// single call exercises both halves at once -- OpenSSH parsing what we
// wrote, and OpenSSH's own encoding of the public key to compare ours
// against.
//
// It does NOT skip when ssh-keygen is missing. A test that quietly
// skips is a test that reports success for having done nothing, and
// this is the one test standing between us and shipping keys no client
// can read.

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "htcondor-openssh-"));
	try {
		execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
	} catch (err: unknown) {
		const code = (err as { code?: string }).code;
		if (code === "ENOENT") {
			throw new Error(
				"ssh-keygen is not on PATH. It is this suite's oracle for the " +
					"OpenSSH key formats, so its absence is a failure and not a skip."
			);
		}
		// ssh-keygen exits non-zero for an unknown flag while still
		// being perfectly present, which is all we wanted to know.
	}
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** What `ssh-keygen -y` says the public key of this PEM is. */
function opensshPublicKey(pem: string, name: string): string {
	const path = join(dir, name);
	writeFileSync(path, pem, { mode: 0o600 });
	return execFileSync("ssh-keygen", ["-y", "-f", path], { encoding: "utf8" }).trim();
}

test("ssh reads the private key we generate", () => {
	const pair = generateKeyPair("test@example");
	const fromSSH = opensshPublicKey(pair.privateKeyPem, "readable");
	assert.match(
		fromSSH,
		/^ecdsa-sha2-nistp256 /,
		"ssh-keygen did not recognise the key as an ECDSA P-256 key"
	);
});

test("our public key encoding matches OpenSSH's, byte for byte", () => {
	// Repeated, because a coordinate with a leading zero byte is the
	// case that breaks a naive encoder and it turns up about once in
	// 256 keys. Twenty keys is not certainty; it is enough that a
	// padding bug stops being a rare mystery and becomes a red suite.
	for (let i = 0; i < 20; i++) {
		const pair = generateKeyPair("");
		const ours = pair.publicKeyLine.trim();
		const theirs = opensshPublicKey(pair.privateKeyPem, `match-${i}`);
		assert.equal(ours, theirs, `key ${i}: our encoding disagrees with ssh-keygen`);
	}
});

test("the comment is appended, and only when there is one", () => {
	const withComment = generateKeyPair("someone@laptop");
	assert.ok(
		withComment.publicKeyLine.endsWith(" someone@laptop"),
		`expected a trailing comment, got ${withComment.publicKeyLine}`
	);
	// Three fields with a comment, two without -- a trailing space
	// would make an empty third field and some parsers care.
	assert.equal(withComment.publicKeyLine.split(" ").length, 3);
	assert.equal(generateKeyPair("").publicKeyLine.split(" ").length, 2);
});

test("a non-EC key is refused rather than mis-encoded", () => {
	// An ed25519 key reaching the EC encoder must not produce a blob at
	// all. The failure mode being guarded against is not a crash, it is
	// a well-formed line that no server will accept and that looks
	// correct until somebody tries to log in with it.
	const { publicKey } = generateKeyPairSync("ed25519");
	assert.throws(() => encodePublicKey(publicKey, ""), /expected a P-256 EC public key/);
});
