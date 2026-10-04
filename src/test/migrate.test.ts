import { strict as assert } from "node:assert";
import { test } from "node:test";

import { scopedKey } from "../accessPoints";
import { migrateUnscopedSecrets } from "../migrate";

class MemorySecrets {
	readonly values = new Map<string, string>();
	async get(key: string): Promise<string | undefined> {
		return this.values.get(key);
	}
	async store(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}
}

const AP = "https://ap.example.edu";

test("an existing install keeps its session", async () => {
	// Updating the extension should not present as being signed out
	// for no visible reason.
	const secrets = new MemorySecrets();
	secrets.values.set("htcondor.oauth2.tokens", "the-tokens");
	secrets.values.set("htcondor.oauth2.client", "the-client");

	const moved = await migrateUnscopedSecrets(secrets, AP, [
		"htcondor.oauth2.tokens",
		"htcondor.oauth2.client",
	]);

	assert.deepEqual(moved, ["htcondor.oauth2.tokens", "htcondor.oauth2.client"]);
	assert.equal(secrets.values.get(scopedKey("htcondor.oauth2.tokens", AP)), "the-tokens");
	assert.equal(secrets.values.get(scopedKey("htcondor.oauth2.client", AP)), "the-client");
});

test("the unscoped copy does not survive the move", async () => {
	// A credential nothing reads is a credential nobody retires.
	const secrets = new MemorySecrets();
	secrets.values.set("htcondor.oauth2.tokens", "the-tokens");

	await migrateUnscopedSecrets(secrets, AP, ["htcondor.oauth2.tokens"]);

	assert.equal(secrets.values.has("htcondor.oauth2.tokens"), false);
});

test("a newer scoped value is not overwritten by the leftover", async () => {
	const secrets = new MemorySecrets();
	secrets.values.set("htcondor.oauth2.tokens", "stale");
	secrets.values.set(scopedKey("htcondor.oauth2.tokens", AP), "current");

	const moved = await migrateUnscopedSecrets(secrets, AP, ["htcondor.oauth2.tokens"]);

	assert.deepEqual(moved, [], "nothing moved");
	assert.equal(secrets.values.get(scopedKey("htcondor.oauth2.tokens", AP)), "current");
	assert.equal(secrets.values.has("htcondor.oauth2.tokens"), false, "the leftover still goes");
});

test("a fresh install has nothing to move", async () => {
	const secrets = new MemorySecrets();

	assert.deepEqual(await migrateUnscopedSecrets(secrets, AP, ["htcondor.oauth2.tokens"]), []);
	assert.equal(secrets.values.size, 0);
});
