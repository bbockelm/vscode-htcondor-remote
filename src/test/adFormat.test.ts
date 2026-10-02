import { strict as assert } from "node:assert";
import { test } from "node:test";

import { describeTime, formatAd } from "../adFormat";

// A job ad has seventy-odd attributes in whatever order the server sent
// them, and the handful somebody opened the view for are scattered
// through it.
test("the attributes somebody came for are at the top", () => {
	const text = formatAd({
		ZZZSomething: 1,
		HoldReason: "nope",
		ClusterId: 12,
		AAAOther: 2,
		ProcId: 0,
		JobStatus: 5,
	});
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	assert.match(lines[0]!, /^ClusterId\s/);
	assert.match(lines[1]!, /^ProcId\s/);
	assert.match(lines[2]!, /^JobStatus\s/);
	// And the rest sorted, so a long ad is predictable.
	const rest = lines.slice(4).map((l) => l.split(/\s/)[0]!);
	assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)));
});

test("values are written the way a ClassAd writes them", () => {
	const text = formatAd({ ClusterId: 12, Cmd: "/bin/sh", Running: true, Nothing: null });
	assert.match(text, /Cmd\s+= "\/bin\/sh"/);
	assert.match(text, /ClusterId\s+= 12/);
	assert.match(text, /Running\s+= true/);
	assert.match(text, /Nothing\s+= undefined/);
});

// A quote or a backslash in an attribute must not produce something
// that reads as two values.
test("strings are escaped", () => {
	const text = formatAd({ HoldReason: 'he said "no" \\ then left' });
	assert.match(text, /\\"no\\"/);
	assert.match(text, /\\\\/);
});

test("names are aligned, so the value column is scannable", () => {
	const text = formatAd({ ClusterId: 1, AVeryLongAttributeNameIndeed: 2 });
	const columns = text
		.split("\n")
		.filter((l) => l.includes(" = "))
		.map((l) => l.indexOf(" = "));
	assert.equal(new Set(columns).size, 1, "the = signs do not line up");
});

test("an empty ad does not produce nonsense", () => {
	assert.equal(formatAd({}).trim(), "");
});

test("a timestamp reads as a time", () => {
	assert.equal(describeTime(0), undefined);
	assert.equal(describeTime("not a number"), undefined);
	assert.match(describeTime(1790000000)!, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
});
