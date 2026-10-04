import { strict as assert } from "node:assert";
import * as Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";

// The authentication provider against a stubbed editor.
//
// What is being tested is which key it reads and writes, which is not
// a detail: before the key included the access point, pointing the
// window at a second access point sent it the first one's token.

interface Session {
	id: string;
	accessToken: string;
	account: { id: string; label: string };
	scopes: readonly string[];
}

interface Provider {
	getSessions(scopes?: readonly string[]): Promise<Session[]>;
	accessPointChanged(previous: readonly Session[]): Promise<void>;
	forget(accessPoint: string): Promise<void>;
}

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

function vscodeStub(): Record<string, unknown> {
	return {
		EventEmitter: class {
			private readonly listeners: ((value: unknown) => void)[] = [];
			event = (listener: (value: unknown) => void): { dispose: () => void } => {
				this.listeners.push(listener);
				return { dispose: (): void => {} };
			};
			fire = (value: unknown): void => {
				for (const listener of [...this.listeners]) {
					listener(value);
				}
			};
			dispose = (): void => {};
		},
	};
}

/** Load the provider with `vscode` supplied, the way the editor does. */
function load(): {
	make: (secrets: MemorySecrets, serverUrl: () => string) => Provider;
	tokensKey: string;
	clientKey: string;
	scopes: readonly string[];
} {
	const stub = vscodeStub();
	const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
	const originalLoad = loader._load;
	loader._load = function (request: string, ...rest: unknown[]): unknown {
		return request === "vscode" ? stub : originalLoad.call(this, request, ...rest);
	};
	const authPath = join(__dirname, "..", "auth.js");
	try {
		/* eslint-disable @typescript-eslint/no-var-requires */
		const auth = require(authPath) as {
			HTCondorAuthProvider: new (s: unknown, u: () => string) => Provider;
			CLIENT_SECRET_KEY: string;
			SCOPES: readonly string[];
		};
		const tokens = require(join(__dirname, "..", "tokens.js")) as { TOKENS_KEY: string };
		/* eslint-enable @typescript-eslint/no-var-requires */
		return {
			make: (secrets, serverUrl) => new auth.HTCondorAuthProvider(secrets, serverUrl),
			tokensKey: tokens.TOKENS_KEY,
			clientKey: auth.CLIENT_SECRET_KEY,
			scopes: auth.SCOPES,
		};
	} finally {
		loader._load = originalLoad;
		delete require.cache[require.resolve(authPath)];
	}
}

const stored = (account: string): string =>
	JSON.stringify({ accessToken: `token-for-${account}`, account, expiresAt: undefined });

test("a token stored for one access point is not offered to another", async () => {
	const { make, tokensKey, scopes } = load();
	const secrets = new MemorySecrets();
	await secrets.store(`${tokensKey}:https://ap1.example.edu`, stored("alice"));

	let where = "https://ap1.example.edu";
	const provider = make(secrets, () => where);

	const onFirst = await provider.getSessions(scopes);
	assert.equal(onFirst.length, 1, "signed in to the access point whose token we hold");
	assert.equal(onFirst[0].accessToken, "token-for-alice");

	where = "https://ap2.example.edu";
	await provider.accessPointChanged(onFirst);

	const onSecond = await provider.getSessions(scopes);
	assert.deepEqual(onSecond, [], "no token for this access point means signed out, not someone else's token");
});

test("the account name says which access point it is on", async () => {
	const { make, tokensKey, scopes } = load();
	const secrets = new MemorySecrets();
	await secrets.store(`${tokensKey}:https://ap1.example.edu`, stored("alice"));
	await secrets.store(`${tokensKey}:https://ap2.example.edu`, stored("alice"));

	let where = "https://ap1.example.edu";
	const provider = make(secrets, () => where);
	const first = await provider.getSessions(scopes);

	where = "https://ap2.example.edu";
	await provider.accessPointChanged(first);
	const second = await provider.getSessions(scopes);

	assert.equal(first[0].account.label, "alice@ap1.example.edu");
	assert.equal(second[0].account.label, "alice@ap2.example.edu");
	assert.notEqual(first[0].id, second[0].id, "two access points are two sessions, not one that changed");
});

test("a spelling of the same access point is the same session", async () => {
	const { make, tokensKey, scopes } = load();
	const secrets = new MemorySecrets();
	await secrets.store(`${tokensKey}:https://ap1.example.edu`, stored("alice"));

	let where = "https://ap1.example.edu";
	const provider = make(secrets, () => where);
	const before = await provider.getSessions(scopes);

	where = "AP1.example.edu/";
	await provider.accessPointChanged(before);

	assert.equal((await provider.getSessions(scopes)).length, 1, "a different spelling is not a different account");
});

test("with no access point configured, nobody is signed in and nothing throws", async () => {
	const { make, scopes } = load();
	const provider = make(new MemorySecrets(), () => {
		throw new Error("no access point");
	});

	assert.deepEqual(await provider.getSessions(scopes), []);
});

test("removing an access point takes its credentials with it", async () => {
	const { make, tokensKey, clientKey, scopes } = load();
	const secrets = new MemorySecrets();
	await secrets.store(`${tokensKey}:https://ap1.example.edu`, stored("alice"));
	await secrets.store(`${clientKey}:https://ap1.example.edu`, '{"clientId":"x"}');
	await secrets.store(`${tokensKey}:https://ap2.example.edu`, stored("bob"));

	const provider = make(secrets, () => "https://ap2.example.edu");
	await provider.forget("https://ap1.example.edu");

	assert.deepEqual(
		[...secrets.values.keys()].sort(),
		[`${tokensKey}:https://ap2.example.edu`],
		"the one removed is gone, the one kept is kept"
	);
	assert.equal((await provider.getSessions(scopes)).length, 1, "forgetting one does not sign out of the other");
});
