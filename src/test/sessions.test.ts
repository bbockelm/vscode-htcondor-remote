import { strict as assert } from "node:assert";
import { test } from "node:test";

import { PRESETS, describeSpec, isReady, isStuck, parseSize } from "../sessions";

// Smallest first, because it matches first: a session that starts now
// beats a bigger one that starts in twenty minutes.
test("the presets are offered smallest first", () => {
	const cpus = PRESETS.filter((p) => !p.spec.gpus).map((p) => p.spec.cpus ?? 0);
	assert.deepEqual([...cpus].sort((a, b) => a - b), cpus, "presets are not in ascending order");
});

// Asking for a GPU where none are free is the easiest way to wait
// forever, so it is last and says so.
test("the GPU preset is last and warns about waiting", () => {
	const last = PRESETS[PRESETS.length - 1]!;
	assert.equal(last.spec.gpus, 1);
	assert.match(last.detail, /wait/i);
});

test("a custom size is read the way a person writes it", () => {
	assert.deepEqual(parseSize("4 cpus, 16 GB"), { cpus: 4, memoryMB: 16384 });
	assert.deepEqual(parseSize("2cpu 8g"), { cpus: 2, memoryMB: 8192 });
	assert.deepEqual(parseSize("1 gpu 8 cpus 32GB"), { cpus: 8, gpus: 1, memoryMB: 32768 });
	assert.deepEqual(parseSize("512 MB"), { memoryMB: 512 });
});

// Guessing is worse than refusing: a session that silently asks for 1
// CPU when 32 was meant wastes the user's time twice, once waiting and
// once working out why it is slow.
test("an unreadable size is refused rather than guessed", () => {
	assert.equal(parseSize(""), undefined);
	assert.equal(parseSize("big"), undefined);
	assert.equal(parseSize("lots of cpus"), undefined);
});

test("the summary reads naturally", () => {
	assert.equal(describeSpec({ cpus: 1, memoryMB: 2048 }), "1 CPU, 2 GB");
	assert.equal(describeSpec({ cpus: 4, memoryMB: 8192 }), "4 CPUs, 8 GB");
	assert.equal(describeSpec({ cpus: 4, memoryMB: 16384, gpus: 1 }), "4 CPUs, 16 GB, 1 GPU");
	assert.equal(describeSpec({ cpus: 2, memoryMB: 1536 }), "2 CPUs, 1536 MB");
});

// Polling past a terminal state waits forever, which presents as a
// session that is "starting" until the user gives up.
test("held, removed and completed are stuck; running is ready", () => {
	assert.equal(isStuck(5), true, "Held");
	assert.equal(isStuck(3), true, "Removed");
	assert.equal(isStuck(4), true, "Completed");
	assert.equal(isStuck(1), false, "Idle is still on its way");
	assert.equal(isStuck(2), false, "Running");

	assert.equal(isReady(2), true);
	assert.equal(isReady(1), false);
});
