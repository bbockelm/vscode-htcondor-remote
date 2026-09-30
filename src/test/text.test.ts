import { strict as assert } from "node:assert";
import { test } from "node:test";

import { prefixLines } from "../text";

test("every line is prefixed", () => {
	assert.equal(prefixLines("a\nb\nc", "> "), "> a\n> b\n> c");
});

// A log arrives in chunks. Prefixing the empty string after the final
// newline puts a stray marker at the start of the next chunk, which
// shows up as a line reading "[stderr] " and nothing else.
test("a trailing newline does not produce an empty prefixed line", () => {
	assert.equal(prefixLines("a\nb\n", "> "), "> a\n> b\n");
	assert.doesNotMatch(prefixLines("a\n", "> "), /> $/);
});

test("an empty chunk stays empty", () => {
	assert.equal(prefixLines("", "> "), "");
});

test("a blank line is still prefixed", () => {
	assert.equal(prefixLines("a\n\nb", "> "), "> a\n> \n> b");
});
