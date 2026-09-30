import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Tokens } from "../oauth2";
import { REFRESH_BEFORE_MS, SecretStore, TOKENS_KEY, TokenStore } from "../tokens";

class MemorySecrets implements SecretStore {
	readonly values = new Map<string, string>();
	async get(key: string) {
		return this.values.get(key);
	}
	async store(key: string, value: string) {
		this.values.set(key, value);
	}
	async delete(key: string) {
		this.values.delete(key);
	}
}

function seed(secrets: MemorySecrets, expiresInMs: number | undefined, refresh = "rt"): void {
	secrets.values.set(
		TOKENS_KEY,
		JSON.stringify({
			accessToken: "old",
			refreshToken: refresh,
			...(expiresInMs === undefined ? {} : { expiresAt: new Date(Date.now() + expiresInMs).toISOString() }),
			account: "bbockelm",
		})
	);
}

function tokens(access: string, refresh?: string): Tokens {
	return {
		accessToken: access,
		...(refresh ? { refreshToken: refresh } : {}),
		expiresAt: new Date(Date.now() + 3600_000),
	};
}

test("a healthy token is returned untouched", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, 3600_000);
	let refreshed = 0;
	const store = new TokenStore(secrets, async () => {
		refreshed++;
		return { tokens: tokens("new"), account: "bbockelm" };
	});

	assert.equal(await store.token(), "old");
	assert.equal(refreshed, 0, "refreshed a token that was still good");
});

test("a token about to expire is refreshed", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, REFRESH_BEFORE_MS / 2);
	const store = new TokenStore(secrets, async () => ({
		tokens: tokens("new", "rt2"),
		account: "bbockelm",
	}));

	assert.equal(await store.token(), "new");
	assert.equal(JSON.parse(secrets.values.get(TOKENS_KEY)!).refreshToken, "rt2");
});

// The failure this class exists to prevent.
//
// A refresh token is single-use on most servers. Two callers refreshing
// at once each spend it, and the second spend fails -- so a user who
// does two things at the same moment is told their session expired,
// on a session that was fine.
test("concurrent callers cause exactly one refresh", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, 0);

	let refreshes = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));

	const store = new TokenStore(secrets, async () => {
		refreshes++;
		await gate;
		return { tokens: tokens("new", "rt2"), account: "bbockelm" };
	});

	// Started before any of them can finish, so they overlap for real.
	const all = [store.token(), store.token(), store.token(), store.token()];
	release();
	const results = await Promise.all(all);

	assert.equal(refreshes, 1, `refreshed ${refreshes} times; the extra spends would fail`);
	assert.deepEqual(results, ["new", "new", "new", "new"]);
});

// And once it has settled, the next caller must be able to refresh
// again -- an in-flight promise that is never cleared would pin the
// first result forever.
test("a later refresh is not blocked by an earlier one", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, 0);
	let refreshes = 0;
	const store = new TokenStore(secrets, async () => {
		refreshes++;
		return { tokens: tokens(`new${refreshes}`, "rt2"), account: "bbockelm" };
	});

	assert.equal(await store.token(), "new1");
	// Still expiring, because the fake clock did not move.
	seed(secrets, 0, "rt2");
	assert.equal(await store.token(), "new2");
	assert.equal(refreshes, 2);
});

// A refresh response may omit the refresh token, meaning "keep yours".
// Dropping it ends the session at the next expiry, which looks like a
// server that logs you out every hour.
test("a refresh response without a new refresh token keeps the old one", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, 0, "original");
	const store = new TokenStore(secrets, async () => ({
		tokens: tokens("new"),
		account: "bbockelm",
	}));

	await store.token();
	assert.equal(JSON.parse(secrets.values.get(TOKENS_KEY)!).refreshToken, "original");
});

test("an expired token with nothing to refresh says to sign in again", async () => {
	const secrets = new MemorySecrets();
	secrets.values.set(
		TOKENS_KEY,
		JSON.stringify({ accessToken: "old", expiresAt: new Date(0).toISOString(), account: "x" })
	);
	const store = new TokenStore(secrets, async () => {
		throw new Error("should not be called");
	});
	await assert.rejects(store.token(), /Sign in again/);
});

test("no session at all is a clear error, not a crash", async () => {
	const store = new TokenStore(new MemorySecrets(), async () => {
		throw new Error("should not be called");
	});
	await assert.rejects(store.token(), /Not signed in/);
});

// Corrupt storage must not wedge the extension: every command would
// fail and nothing in the UI would clear it.
test("unreadable storage reads as signed out", async () => {
	const secrets = new MemorySecrets();
	secrets.values.set(TOKENS_KEY, "{not json");
	const store = new TokenStore(secrets, async () => {
		throw new Error("should not be called");
	});
	assert.equal(await store.read(), undefined);
	await assert.rejects(store.token(), /Not signed in/);
});

// A token with no expiry is not treated as expired. Some servers do not
// return expires_in, and guessing would refresh on every single call.
test("a token with no expiry is used as-is", async () => {
	const secrets = new MemorySecrets();
	seed(secrets, undefined);
	let refreshed = 0;
	const store = new TokenStore(secrets, async () => {
		refreshed++;
		return { tokens: tokens("new"), account: "x" };
	});
	assert.equal(await store.token(), "old");
	assert.equal(refreshed, 0);
});
