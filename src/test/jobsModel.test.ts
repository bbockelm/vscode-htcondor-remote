import { strict as assert } from "node:assert";
import { test } from "node:test";

import { JobSummary } from "../api";
import { groupByStatus, jobLabel, jobTooltip } from "../jobsModel";

function job(cluster: number, status: number, extra: Partial<JobSummary> = {}): JobSummary {
	return { cluster, proc: 0, status, ...extra };
}

// Held first, finished last. The question this panel is opened for is
// "what is stuck?", and on a busy access point a few thousand completed
// jobs would otherwise push everything live off the screen.
test("held jobs come first and finished ones last", () => {
	const groups = groupByStatus([
		job(1, 4), // Completed
		job(2, 2), // Running
		job(3, 5), // Held
		job(4, 1), // Idle
		job(5, 3), // Removed
	]);
	assert.deepEqual(
		groups.map((g) => g.status),
		[5, 2, 1, 3, 4]
	);
});

// indexOf returns -1 for an unknown status, which would sort it ahead
// of Held -- putting a status nobody recognises at the very top.
test("an unknown status sorts last, not first", () => {
	const groups = groupByStatus([job(1, 99), job(2, 5), job(3, 2)]);
	assert.deepEqual(
		groups.map((g) => g.status),
		[5, 2, 99]
	);
});

test("jobs are grouped, not duplicated", () => {
	const groups = groupByStatus([job(1, 2), job(2, 2), job(3, 5)]);
	assert.equal(groups.length, 2);
	assert.equal(groups.find((g) => g.status === 2)?.jobs.length, 2);
	assert.equal(groups.find((g) => g.status === 5)?.jobs.length, 1);
});

test("an empty list produces no groups", () => {
	assert.deepEqual(groupByStatus([]), []);
});

test("the label prefers a batch name, then the command's basename", () => {
	assert.equal(jobLabel(job(12, 2, { batchName: "analysis" })), "12.0 — analysis");
	// The basename only: a full path is mostly shared prefix, and it
	// pushes the part that differs off the right-hand edge.
	assert.equal(jobLabel(job(12, 2, { command: "/home/me/work/run.sh" })), "12.0 — run.sh");
	assert.equal(jobLabel(job(12, 2)), "12.0");
});

// Noticing a held job is only useful with the reason, so it is always
// in the tooltip.
test("a held job's reason is in the tooltip", () => {
	const tooltip = jobTooltip(job(7, 5, { holdReason: "Failed to transfer output: no such file" }));
	assert.match(tooltip, /Held/);
	assert.match(tooltip, /no such file/);
});

test("the tooltip leaves out what is not known", () => {
	const tooltip = jobTooltip(job(7, 1));
	assert.match(tooltip, /7\.0 — Idle/);
	assert.doesNotMatch(tooltip, /Owner:|Running on:|Hold reason:/);
});
