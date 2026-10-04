import { strict as assert } from "node:assert";
import { test } from "node:test";

import { HTCondorApi } from "../api";
import { describeWarm, WARM_TIMEOUT_MS, warmStaysValid, warmTarget } from "../warmup";

test("a job id is something that can be warmed", () => {
	assert.equal(warmTarget("12345.0"), "12345.0");
	assert.equal(warmTarget(" 12345.7 "), "12345.7");
});

test("a bare cluster id means its first proc", () => {
	assert.equal(warmTarget("12345"), "12345.0");
});

test("a session is not something that can be warmed", () => {
	// The gateway resolves -- and may submit -- the job during the
	// connection, so there is nothing to open in advance.
	assert.equal(warmTarget("+work"), undefined);
	assert.equal(warmTarget(""), undefined);
	assert.equal(warmTarget("my-session"), undefined);
	assert.equal(warmTarget("12345.0.0"), undefined);
});

test("the log says when warming found the work already done", () => {
	const already = describeWarm("12.0", { ready: true, reused: true, elapsedMs: 3, idleTimeoutSeconds: 600 });
	const fresh = describeWarm("12.0", { ready: true, reused: false, elapsedMs: 4200, idleTimeoutSeconds: 600 });

	assert.match(already, /already connected/);
	assert.match(fresh, /4\.2s/, "the time is the cost the connection would otherwise have carried");
});

test("an access point without the endpoint is not a failure", () => {
	assert.match(describeWarm("12.0", undefined), /connecting straight away/);
});

test("a warm-up that would be reaped before it is used does not count", () => {
	assert.equal(warmStaysValid({ ready: true, reused: false, elapsedMs: 1, idleTimeoutSeconds: 600 }), true);
	assert.equal(warmStaysValid({ ready: true, reused: false, elapsedMs: 1, idleTimeoutSeconds: 5 }), false);
	// A server that does not say predates the field; that it has the
	// endpoint at all is the stronger signal.
	assert.equal(warmStaysValid({ ready: true, reused: false, elapsedMs: 1, idleTimeoutSeconds: 0 }), true);
	assert.equal(warmStaysValid(undefined), false);
});

test("warming asks the access point to connect, with its own deadline", async () => {
	let seen: { url: string; method: string | undefined } | undefined;
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", async (input, init) => {
		seen = { url: String(input), method: init?.method };
		return new Response(
			JSON.stringify({ ready: true, reused: false, elapsed_ms: 1200, idle_timeout_seconds: 600 })
		);
	});

	const result = await api.warmJob("12345.0", WARM_TIMEOUT_MS);

	assert.equal(seen?.url, "https://ap.example.edu/api/v1/jobs/12345.0/warm");
	assert.equal(seen?.method, "POST", "warming opens a connection, so it is not a GET");
	assert.deepEqual(result, { ready: true, reused: false, elapsedMs: 1200, idleTimeoutSeconds: 600 });
});

test("the caller's deadline is the one that applies", { timeout: 5_000 }, async () => {
	// The whole point is to spend the time here rather than inside
	// Remote-SSH's shorter deadline, so a warm-up capped at the
	// ordinary request timeout would defeat the exercise. Measured
	// rather than read off the error message: the message is built
	// from the deadline that was asked for, so it says the right thing
	// even when the wrong one is in force.
	const hang: typeof fetch = ((_input: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "TimeoutError";
				reject(err);
			});
		})) as typeof fetch;
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", hang, 20);

	const started = Date.now();
	await assert.rejects(() => api.warmJob("1.0", 400));
	const elapsed = Date.now() - started;

	assert.ok(elapsed >= 300, `gave up after ${elapsed}ms; the client's own 20ms deadline was used instead of 400ms`);
});

test("an older access point says so rather than failing the connection", async () => {
	for (const status of [404, 405]) {
		const api = new HTCondorApi("https://ap.example.edu", async () => "t", async () =>
			new Response("no such endpoint", { status })
		);

		assert.equal(await api.warmJob("1.0", 1000), undefined, `status ${status} should be "cannot", not "failed"`);
	}
});

test("a job that cannot be reached is reported, not swallowed", async () => {
	// 502 is the access point saying the execute node could not be
	// reached. The caller logs it and connects anyway, but it has to
	// be able to see it.
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", async () =>
		new Response("could not open shell", { status: 502 })
	);

	await assert.rejects(() => api.warmJob("1.0", 1000));
});
