import { strict as assert } from "node:assert";
import { test } from "node:test";

import { closeMessage, describeEnd, parseControl, resizeMessage, signalMessage } from "../terminalProtocol";

test("a resize carries whole, positive dimensions", () => {
	assert.deepEqual(JSON.parse(resizeMessage(80, 24)), { type: "resize", cols: 80, rows: 24 });
	// VS Code reports a fractional size while a panel is being dragged,
	// and a zero dimension makes TIOCSWINSZ meaningless -- the far end
	// renders into a terminal of no width and the output looks corrupt.
	assert.deepEqual(JSON.parse(resizeMessage(80.7, 24.2)), { type: "resize", cols: 80, rows: 24 });
	assert.deepEqual(JSON.parse(resizeMessage(0, -5)), { type: "resize", cols: 1, rows: 1 });
});

test("signals and close are the shapes the server reads", () => {
	assert.deepEqual(JSON.parse(signalMessage("INT")), { type: "signal", name: "INT" });
	assert.deepEqual(JSON.parse(closeMessage()), { type: "close" });
});

// This runs on every text frame. A server that grows a new message type
// must not take the terminal down with it.
test("an unparseable control frame is ignored, not thrown", () => {
	assert.equal(parseControl("not json"), undefined);
	assert.equal(parseControl("[]"), undefined);
	assert.equal(parseControl("null"), undefined);
	assert.equal(parseControl('{"no":"type"}'), undefined);
	assert.deepEqual(parseControl('{"type":"something-new"}'), { type: "something-new" });
});

// "Your command exited 1" and "the session never opened" are different
// things, and a terminal that renders them the same way sends people
// looking in the wrong place.
test("a failed setup reads differently from a command that exited", () => {
	const failed = describeEnd({ type: "error", message: "Timed out opening a shell" });
	assert.match(failed, /Timed out opening a shell/);

	assert.match(describeEnd({ type: "exit", code: 0 }), /session ended/);
	assert.match(describeEnd({ type: "exit" }), /session ended/);
	assert.match(describeEnd({ type: "exit", code: 3 }), /status 3/);
});
