import { strict as assert } from "node:assert";
import { test } from "node:test";

import { explainBlocking, LoopLag } from "../eventLoop";

/** Drive a monitor with ticks that happened exactly on time. */
function punctual(lag: LoopLag, from: number, count: number, intervalMs = 250): number {
	let at = from;
	for (let i = 0; i < count; i++) {
		lag.tick(at);
		at += intervalMs;
	}
	return at;
}

test("a thread that is never late reports no blocking", () => {
	const lag = new LoopLag(250);
	const end = punctual(lag, 1_000, 20);

	assert.equal(lag.blockedBetween(1_000, end), 0);
	assert.equal(lag.worstBetween(1_000, end), 0);
});

test("a stall is measured as the time the thread could not run", () => {
	const lag = new LoopLag(250);
	lag.tick(1_000);
	// The next tick was due at 1250 and ran at 21250: twenty seconds
	// in which nothing in the window could make progress.
	lag.tick(21_250);

	assert.equal(lag.blockedBetween(1_000, 21_250), 20_000);
	assert.equal(lag.worstBetween(1_000, 21_250), 20_000);
});

test("many small stalls add up the same as one long one", () => {
	// A request waiting on a thread blocked in twenty one-second
	// stretches waited just as long as one blocked for twenty
	// seconds. Summing is what makes the number comparable with the
	// request's own wait.
	const spread = new LoopLag(250);
	let at = 1_000;
	spread.tick(at);
	for (let i = 0; i < 20; i++) {
		at += 1_250;
		spread.tick(at);
	}

	assert.equal(spread.blockedBetween(1_000, at), 20_000);
	assert.equal(spread.worstBetween(1_000, at), 1_000, "the worst single stall is still only a second");
});

test("only stalls inside the window count", () => {
	const lag = new LoopLag(250);
	lag.tick(1_000);
	lag.tick(11_250); // a ten-second stall, before the window
	lag.tick(11_500);
	lag.tick(16_500); // the next tick was due at 11750, so a 4.75s stall, inside it

	assert.equal(lag.blockedBetween(11_400, 16_500), 4_750);
	assert.equal(lag.blockedBetween(0, 16_500), 14_750, "both stalls, when the window covers both");
});

test("old samples are dropped rather than accumulating", () => {
	const lag = new LoopLag(250, 10);
	punctual(lag, 1_000, 50);

	assert.equal(lag.count, 10);
});

test("nothing is said about a request that was quick", () => {
	assert.equal(explainBlocking(400, 0, 0), undefined);
	assert.equal(explainBlocking(4_999, 4_000, 4_000), undefined);
});

test("a long wait on a responsive thread is the request's own", () => {
	const verdict = explainBlocking(20_000, 300, 250);

	assert.match(String(verdict), /really was outstanding/);
});

test("a long wait on a blocked thread says the request was probably not slow", () => {
	// The case being chased: the access point's log shows nothing
	// over half a second, so a twenty-second wait measured in here is
	// twenty seconds of not being able to look.
	const verdict = explainBlocking(20_000, 19_500, 19_000);

	assert.match(String(verdict), /blocked for 19500ms of those 20000ms/);
	assert.match(String(verdict), /another extension holds the thread/);
	assert.match(String(verdict), /other extensions disabled/, "it should say how to confirm it");
});
