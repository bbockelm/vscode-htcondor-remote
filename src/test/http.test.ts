import { strict as assert } from "node:assert";
import { test } from "node:test";

import { configureHttp, formatUserAgent, http, userAgent, withUserAgent } from "../http";

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
	configureHttp("9.9.9", "1.90.0", async (_input, init) => {
		seen = new Headers(init?.headers).get("User-Agent");
		return new Response("{}");
	});

	// Read at call time rather than captured at import, so a module
	// loaded before activation still sends the right thing.
	await http()("https://ap.example.edu/");

	assert.equal(seen, `vscode-htcondor-remote/9.9.9 (VS Code 1.90.0; ${process.platform})`);
	assert.equal(userAgent(), seen);
});
