import { strict as assert } from "node:assert";
import { test } from "node:test";
import { URL } from "node:url";

import { compare, describeTimings, directGet, fetchGet, parseStatusLine, requestBytes } from "../probe";

test("the status line is read out of the first bytes", () => {
	assert.equal(parseStatusLine("HTTP/1.1 200 OK"), 200);
	assert.equal(parseStatusLine("HTTP/1.0 503 Service Unavailable"), 503);
	assert.equal(parseStatusLine("not http at all"), undefined);
	assert.equal(parseStatusLine(""), undefined);
});

test("the request is one an ordinary server will answer", () => {
	const bytes = requestBytes(new URL("https://ap.example.edu/.well-known/x?y=1"), "probe/1.0");

	assert.match(bytes, /^GET \/\.well-known\/x\?y=1 HTTP\/1\.1\r\n/);
	assert.match(bytes, /\r\nHost: ap\.example\.edu\r\n/, "HTTP/1.1 requires a Host header");
	assert.match(bytes, /\r\nConnection: close\r\n/, "so the far end ends the response for us");
	assert.ok(bytes.endsWith("\r\n\r\n"), "headers have to be terminated or the server waits for more");
	assert.match(bytes, /probe\/1\.0/);
});

test("the port comes from the URL when it is not the default", async () => {
	// Nothing is listening, so this is about where it tried: a probe
	// that silently used 443 would time out against a server on 8443
	// and report the access point as unreachable.
	const result = await directGet("https://127.0.0.1:1/x", "probe/1.0", 2_000);

	assert.ok(result.error, "connecting to port 1 should not succeed");
	assert.ok(result.totalMs < 2_000, `took ${result.totalMs}ms; a refused connection is immediate`);
});

test("a fetch that fails is timed rather than thrown", async () => {
	// The probe's job is to produce two numbers. One of them failing
	// is a result, not a reason to produce nothing.
	const result = await fetchGet("https://ap.example.edu/x", async () => {
		throw new Error("nope");
	}, 1_000);

	assert.equal(result.error, "nope");
	assert.equal(result.status, undefined);
	assert.ok(result.totalMs >= 0);
});

test("the body is read, so both probes measure the same thing", async () => {
	// The status line can arrive well before the stack is finished.
	let bodyRead = false;
	const result = await fetchGet("https://ap.example.edu/x", async () => {
		return new Response(
			new ReadableStream({
				start(controller) {
					bodyRead = true;
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			})
		);
	}, 1_000);

	assert.equal(result.status, 200);
	assert.ok(bodyRead, "a probe that stops at the headers does not measure what the slow request measured");
});

test("a slow editor stack and a quick socket names the editor", () => {
	const verdict = compare({ totalMs: 180, status: 200 }, { totalMs: 24_800, status: 200 }, "override");

	assert.match(verdict, /not being spent at the access point/);
	assert.match(verdict, /http\.proxySupport/, "the setting to try should be named");
});

test("with proxy support already off, the editor is still named but the setting is not", () => {
	const verdict = compare({ totalMs: 180, status: 200 }, { totalMs: 24_800, status: 200 }, "off");

	assert.match(verdict, /not being spent at the access point/);
	assert.match(verdict, /something else in the editor/);
});

test("both slow points at the access point, and says which half", () => {
	const connectionBound = compare({ totalMs: 24_000, tcpMs: 20, tlsMs: 23_900 }, { totalMs: 24_500 }, "override");
	const serverBound = compare({ totalMs: 24_000, tcpMs: 20, tlsMs: 60 }, { totalMs: 24_500 }, "override");

	assert.match(connectionBound, /it is the connection/);
	assert.match(serverBound, /it is the server's answer/);
});

test("both quick says so plainly", () => {
	const verdict = compare({ totalMs: 180, status: 200 }, { totalMs: 210, status: 200 }, "override");

	assert.match(verdict, /Both probes were quick/);
});

test("a timing line carries every number it has", () => {
	const line = describeTimings("direct", { totalMs: 300, tcpMs: 20, tlsMs: 90, status: 200 });

	assert.match(line, /direct: 300ms/);
	assert.match(line, /connect 20ms/);
	assert.match(line, /TLS 90ms/);
	assert.match(line, /HTTP 200/);
});

test("the probe can carry the credentials of the request it is comparing against", () => {
	// Asking for a simpler, unauthenticated document proved less than
	// it looked: a quick answer there says nothing about an
	// authenticated query, which is the request that was slow.
	const bytes = requestBytes(new URL("https://ap.example.edu/api/v1/jobs?limit=200"), "probe/1.0", {
		Authorization: "Bearer abc.def",
	});

	assert.match(bytes, /\r\nAuthorization: Bearer abc\.def\r\n/);
	assert.match(bytes, /^GET \/api\/v1\/jobs\?limit=200 HTTP\/1\.1\r\n/, "and the same URL, query included");
	assert.ok(bytes.endsWith("\r\n\r\n"));
});

test("extra headers do not displace the ones that make it a valid request", () => {
	const bytes = requestBytes(new URL("https://ap.example.edu/x"), "probe/1.0", { Authorization: "Bearer t" });

	assert.match(bytes, /\r\nHost: ap\.example\.edu\r\n/);
	assert.match(bytes, /\r\nConnection: close\r\n\r\n$/, "Connection: close has to stay last and present");
});
