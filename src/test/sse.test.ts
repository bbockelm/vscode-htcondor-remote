import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EventStreamParser, parseFrame } from "../sse";

test("a whole frame parses", () => {
	const got = parseFrame('event: upsert\ndata: {"key":"12.0"}\nid: YWJj');
	assert.deepEqual(got, { event: "upsert", data: '{"key":"12.0"}', id: "YWJj" });
});

// Chunk boundaries fall wherever TCP puts them. A frame routinely
// arrives in pieces, and a parser that assumed otherwise would drop
// every event split across a read.
test("a frame split across chunks is still delivered whole", () => {
	const p = new EventStreamParser();
	assert.deepEqual(p.push("event: ups"), []);
	assert.deepEqual(p.push('ert\ndata: {"key":"1'), []);
	const out = p.push('2.0"}\n\n');
	assert.equal(out.length, 1);
	assert.equal(out[0]!.event, "upsert");
	assert.equal(out[0]!.data, '{"key":"12.0"}');
});

test("two frames in one chunk both come out", () => {
	const p = new EventStreamParser();
	const out = p.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
	assert.deepEqual(out.map((e) => e.event), ["a", "b"]);
	assert.deepEqual(out.map((e) => e.data), ["1", "2"]);
});

// A proxy that rewrites line endings is a real thing to meet between a
// laptop and an access point.
test("CRLF line endings work", () => {
	const p = new EventStreamParser();
	const out = p.push("event: upsert\r\ndata: x\r\n\r\n");
	assert.equal(out.length, 1);
	assert.equal(out[0]!.data, "x");
});

// A comment is how a server keeps an idle connection alive. Treating
// one as an event would hand the caller an empty payload to parse.
test("a keepalive comment is not an event", () => {
	const p = new EventStreamParser();
	assert.deepEqual(p.push(": keepalive\n\n"), []);
	assert.equal(parseFrame(": keepalive"), undefined);
	assert.equal(parseFrame("id: abc"), undefined, "an id with no data is not an event");
});

// One optional space after the colon is part of the format, not the
// value. Keeping it would corrupt every JSON payload.
test("exactly one leading space is stripped", () => {
	assert.equal(parseFrame("data:  two spaces")!.data, " two spaces");
	assert.equal(parseFrame("data:none")!.data, "none");
});

// Multi-line data is joined with newlines, per the spec.
test("multi-line data is joined", () => {
	assert.equal(parseFrame("data: a\ndata: b")!.data, "a\nb");
});

test("a frame with no event name defaults to message", () => {
	assert.equal(parseFrame("data: x")!.event, "message");
});

test("the parser keeps an incomplete trailing frame for later", () => {
	const p = new EventStreamParser();
	const out = p.push("event: a\ndata: 1\n\nevent: b\ndata: incomp");
	assert.equal(out.length, 1);
	assert.deepEqual(p.push("lete\n\n").map((e) => e.data), ["incomplete"]);
});
