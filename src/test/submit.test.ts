import { strict as assert } from "node:assert";
import { test } from "node:test";

import { planSubmit, submitWarning } from "../submit";

// The trap: transfer_executable defaults to TRUE, so a submit file
// that says nothing about it produces a job that is accepted, returns
// 2xx, and then sits held forever on HoldReasonCode 16.
test("an ordinary submit file needs an upload", () => {
	const plan = planSubmit("executable = run.sh\nqueue\n");
	assert.equal(plan.needsUpload, true);
	assert.equal(plan.executable, "run.sh");
	assert.match(submitWarning(plan), /held/);
});

test("transfer_executable = false means no upload is needed", () => {
	const plan = planSubmit("executable = /bin/sleep\ntransfer_executable = false\nqueue\n");
	assert.equal(plan.needsUpload, false);
	assert.equal(submitWarning(plan), "");
});

// HTCondor accepts several spellings of both the command and the value.
test("the spelling of the command and the value does not matter", () => {
	for (const line of [
		"Transfer_Executable = False",
		"TRANSFEREXECUTABLE=false",
		"  transfer_executable   =   FALSE  ",
	]) {
		const plan = planSubmit(`executable = /bin/sleep\n${line}\nqueue\n`);
		assert.equal(plan.needsUpload, false, `not recognised: ${line}`);
	}
	for (const yes of ["true", "TRUE", "yes", "1", "T"]) {
		const plan = planSubmit(`executable = run.sh\ntransfer_executable = ${yes}\nqueue\n`);
		assert.equal(plan.needsUpload, true, `not recognised as true: ${yes}`);
	}
});

test("input files need an upload even when the executable does not", () => {
	const plan = planSubmit(
		"executable = /bin/sleep\ntransfer_executable = false\ntransfer_input_files = a.dat, b.dat\nqueue\n"
	);
	assert.equal(plan.needsUpload, true);
	assert.deepEqual(plan.inputFiles, ["a.dat", "b.dat"]);
	assert.match(submitWarning(plan), /a\.dat/);
	// And it must NOT tell them to add a line they already have.
	assert.doesNotMatch(submitWarning(plan), /transfer_executable = false/);
});

test("comments and blank lines are ignored", () => {
	const plan = planSubmit(
		["# transfer_executable = false", "", "   # executable = decoy", "executable = /bin/sleep", "transfer_executable = false", "queue"].join("\n")
	);
	assert.equal(plan.executable, "/bin/sleep");
	assert.equal(plan.needsUpload, false);
});

// A file with no executable at all -- everything already on the node --
// has nothing to upload.
test("a submit file with no executable needs no upload", () => {
	assert.equal(planSubmit("universe = vanilla\nqueue\n").needsUpload, false);
});
