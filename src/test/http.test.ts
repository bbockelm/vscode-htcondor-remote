import { strict as assert } from "node:assert";
import { test } from "node:test";

import { configureHttp, formatUserAgent, http, unpatchedFetch, userAgent, withFallback, withUserAgent } from "../http";

test("the agent names the extension, its version and the editor", () => {
	const agent = formatUserAgent("1.2.3", "1.95.0", "darwin");

	assert.equal(agent, "vscode-htcondor-remote/1.2.3 (VS Code 1.95.0; darwin)");
});

test("a wrapped fetch sends the agent", async () => {
	let seen: string | null = null;
	const wrapped = withUserAgent(async (_input, init) => {
		seen = new Headers(init?.headers).get("User-Agent");
		return new Response("{}");
	}, "test-agent/1.0");

	await wrapped("https://ap.example.edu/");

	assert.equal(seen, "test-agent/1.0");
});

test("wrapping keeps the caller's own headers and body", async () => {
	let headers: Headers | undefined;
	let body: unknown;
	const wrapped = withUserAgent(async (_input, init) => {
		headers = new Headers(init?.headers);
		body = init?.body;
		return new Response("{}");
	}, "test-agent/1.0");

	await wrapped("https://ap.example.edu/", {
		method: "POST",
		headers: { Authorization: "Bearer t", Accept: "application/json" },
		body: "payload",
	});

	assert.equal(headers?.get("Authorization"), "Bearer t");
	assert.equal(headers?.get("Accept"), "application/json");
	assert.equal(body, "payload");
});

test("the configured fetch is the one callers get", async () => {
	let seen: string | null = null;
	configureHttp("9.9.9", "1.90.0", {
		patched: async (_input, init) => {
			seen = new Headers(init?.headers).get("User-Agent");
			return new Response("{}");
		},
	});

	// Read at call time rather than captured at import, so a module
	// loaded before activation still sends the right thing.
	await http()("https://ap.example.edu/");

	assert.equal(seen, `vscode-htcondor-remote/9.9.9 (VS Code 1.90.0; ${process.platform})`);
	assert.equal(userAgent(), seen);
});

test("the quick transport is used while it works", async () => {
	const calls: string[] = [];
	const wrapped = withFallback(
		async () => {
			calls.push("fast");
			return new Response("{}");
		},
		async () => {
			calls.push("safe");
			return new Response("{}");
		},
		() => calls.push("switched")
	);

	await wrapped("https://ap.example.edu/a");
	await wrapped("https://ap.example.edu/b");

	assert.deepEqual(calls, ["fast", "fast"]);
});

test("a network failure hands the job to the editor's stack for good", async () => {
	// What a proxy or a private certificate authority looks like from
	// here: the direct request simply fails.
	const calls: string[] = [];
	const reasons: string[] = [];
	const wrapped = withFallback(
		async () => {
			calls.push("fast");
			throw new Error("unable to verify the first certificate");
		},
		async () => {
			calls.push("safe");
			return new Response("{}");
		},
		(reason) => reasons.push(reason)
	);

	const first = await wrapped("https://ap.example.edu/a");
	await wrapped("https://ap.example.edu/b");

	assert.equal(first.status, 200, "the request that triggered the switch should still succeed");
	assert.deepEqual(calls, ["fast", "safe", "safe"], "no second attempt at the one that failed");
	assert.deepEqual(reasons, ["unable to verify the first certificate"]);
});

test("a request that may already have arrived is not sent twice", async () => {
	// A POST that failed at the network level may still have been
	// received. Submitting somebody's job twice is worse than a slow
	// request.
	const calls: string[] = [];
	const wrapped = withFallback(
		async () => {
			calls.push("fast");
			throw new Error("connection reset");
		},
		async () => {
			calls.push("safe");
			return new Response("{}");
		},
		() => {}
	);

	await assert.rejects(() => wrapped("https://ap.example.edu/jobs", { method: "POST", body: "x" }));
	assert.deepEqual(calls, ["fast"], "a POST must not be replayed");

	// But the switch still happened, so the next request goes the safe way.
	await wrapped("https://ap.example.edu/jobs", { method: "POST", body: "y" });
	assert.deepEqual(calls, ["fast", "safe"]);
});

test("our own deadline is not a reason to try again", async () => {
	// Retrying would double a wait somebody already decided was too
	// long.
	const calls: string[] = [];
	let attempt = 0;
	const wrapped = withFallback(
		async () => {
			calls.push("fast");
			attempt += 1;
			if (attempt === 1) {
				const timeout = new Error("aborted");
				timeout.name = "TimeoutError";
				throw timeout;
			}
			return new Response("{}");
		},
		async () => {
			calls.push("safe");
			return new Response("{}");
		},
		() => calls.push("switched")
	);

	await assert.rejects(() => wrapped("https://ap.example.edu/a"), /aborted/);
	await wrapped("https://ap.example.edu/b");

	assert.deepEqual(calls, ["fast", "fast"], "a timeout should neither retry nor switch transports");
});

test("with no unpatched fetch to use, the editor's is used directly", async () => {
	let used = "";
	configureHttp("1.0.0", "1.90.0", {
		patched: async () => {
			used = "patched";
			return new Response("{}");
		},
		preferUnpatched: true,
	});

	await http()("https://ap.example.edu/");

	assert.equal(used, "patched", "preferring the unpatched one is not possible when there is not one");
});

test("preferring the unpatched one actually uses it", async () => {
	let used = "";
	configureHttp("1.0.0", "1.90.0", {
		patched: async () => {
			used = "patched";
			return new Response("{}");
		},
		unpatched: async () => {
			used = "unpatched";
			return new Response("{}");
		},
		preferUnpatched: true,
	});

	await http()("https://ap.example.edu/");

	assert.equal(used, "unpatched");
});

test("not preferring it leaves the editor's stack in charge", async () => {
	let used = "";
	configureHttp("1.0.0", "1.90.0", {
		patched: async () => {
			used = "patched";
			return new Response("{}");
		},
		unpatched: async () => {
			used = "unpatched";
			return new Response("{}");
		},
		preferUnpatched: false,
	});

	await http()("https://ap.example.edu/");

	assert.equal(used, "patched");
});

test("the editor's unpatched fetch is found when it is stashed", () => {
	const patched = (): Promise<Response> => Promise.resolve(new Response());
	const original = (): Promise<Response> => Promise.resolve(new Response());

	assert.equal(unpatchedFetch({ fetch: patched, __vscodeOriginalFetch: original }), original);
});

test("no unpatched fetch is reported when there is nothing to compare", () => {
	const same = (): Promise<Response> => Promise.resolve(new Response());

	// Not patched at all: the stash holds the very function in use, so
	// going around the patch would be going around nothing.
	assert.equal(unpatchedFetch({ fetch: same, __vscodeOriginalFetch: same }), undefined);
	assert.equal(unpatchedFetch({ fetch: same }), undefined);
	assert.equal(unpatchedFetch({ fetch: same, __vscodeOriginalFetch: "not a function" }), undefined);
});
