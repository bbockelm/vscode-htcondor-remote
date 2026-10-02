import { strict as assert } from "node:assert";
import { test } from "node:test";

import { HTCondorApi, describeStatus, jobId, toJobSummary } from "../api";

function apiReturning(jobs: unknown[], seen?: { url?: string }): HTCondorApi {
	const fetchImpl = (async (input: unknown) => {
		if (seen) {
			seen.url = String(input);
		}
		return new Response(JSON.stringify({ jobs }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return new HTCondorApi("https://ap.example.edu", async () => "t", fetchImpl);
}

test("jobs come back newest first", async () => {
	const api = apiReturning([
		{ ClusterId: 10, ProcId: 0, JobStatus: 1 },
		{ ClusterId: 12, ProcId: 1, JobStatus: 2 },
		{ ClusterId: 12, ProcId: 0, JobStatus: 2 },
	]);
	const jobs = await api.listJobs();
	assert.deepEqual(
		jobs.map(jobId),
		["12.1", "12.0", "10.0"],
		"a tree sorted oldest-first buries the job just submitted"
	);
});

test("the constraint and projection reach the query", async () => {
	const seen: { url?: string } = {};
	const api = apiReturning([], seen);
	await api.listJobs({ constraint: "JobStatus == 5", limit: 7 });

	const url = new URL(seen.url ?? "");
	assert.equal(url.pathname, "/api/v1/jobs");
	assert.equal(url.searchParams.get("constraint"), "JobStatus == 5");
	assert.equal(url.searchParams.get("limit"), "7");
	assert.ok(url.searchParams.get("projection")?.includes("HoldReason"), "hold reasons are not requested");
});

// An ad with no id is not addressable, so a view can do nothing with
// it. Dropping it beats rendering a row that no command can act on.
test("an ad without an id is dropped rather than rendered", () => {
	assert.equal(toJobSummary({ JobStatus: 1 }), undefined);
	assert.equal(toJobSummary({ ClusterId: 5 }), undefined);
	assert.ok(toJobSummary({ ClusterId: 5, ProcId: 0 }));
});

// Number("") is 0, so a naive conversion turns an empty attribute into
// cluster 0 -- a job id that looks real and matches nothing.
test("an empty attribute does not become zero", () => {
	assert.equal(toJobSummary({ ClusterId: "", ProcId: 0 }), undefined);
	assert.equal(toJobSummary({ ClusterId: "  ", ProcId: "0" }), undefined);
	// A numeric string is still a number, which is how some ads arrive.
	assert.equal(jobId(toJobSummary({ ClusterId: "12", ProcId: "3" })!), "12.3");
});

// 3 is Removed and 4 is Completed. That pair is the one people reverse,
// and a tree that labels a removed job "Completed" is worse than one
// that shows the raw number.
test("the status names are the HTCondor ones", () => {
	assert.equal(describeStatus(1), "Idle");
	assert.equal(describeStatus(2), "Running");
	assert.equal(describeStatus(3), "Removed");
	assert.equal(describeStatus(4), "Completed");
	assert.equal(describeStatus(5), "Held");
	assert.match(describeStatus(99), /Unknown \(99\)/);
});

test("the attributes a view needs survive the round trip", async () => {
	const api = apiReturning([
		{
			ClusterId: 42,
			ProcId: 3,
			JobStatus: 5,
			Owner: "bbockelm",
			JobBatchName: "analysis",
			Cmd: "/bin/run.sh",
			HoldReason: "Failed to transfer output",
			RemoteHost: "slot1@e2464",
		},
	]);
	const [job] = await api.listJobs();
	assert.equal(jobId(job!), "42.3");
	assert.equal(job!.owner, "bbockelm");
	assert.equal(job!.batchName, "analysis");
	assert.equal(job!.holdReason, "Failed to transfer output");
	assert.equal(describeStatus(job!.status), "Held");
});

type Seen = { url?: string | undefined; method?: string | undefined; body?: string | undefined };

function recordingApi(seen: Seen, status = 200, body = ""): HTCondorApi {
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		seen.url = String(input);
		seen.method = init?.method;
		seen.body = init?.body === undefined ? undefined : String(init.body);
		// null, not "": the Response constructor rejects a body on a
		// 204, which is exactly the status this test is about.
		return new Response(body === "" ? null : body, { status });
	}) as typeof fetch;
	return new HTCondorApi("https://ap.example.edu", async () => "t", fetchImpl);
}

test("hold, release and remove reach the right endpoints", async () => {
	const seen: Seen = {};

	await recordingApi(seen).holdJob("12.0", "because");
	assert.equal(seen.method, "POST");
	assert.ok(seen.url?.endsWith("/api/v1/jobs/12.0/hold"), seen.url);
	assert.equal(JSON.parse(seen.body ?? "{}").reason, "because");

	await recordingApi(seen).releaseJob("12.0");
	assert.ok(seen.url?.endsWith("/api/v1/jobs/12.0/release"), seen.url);

	await recordingApi(seen).removeJob("12.0");
	assert.equal(seen.method, "DELETE");
	assert.ok(seen.url?.endsWith("/api/v1/jobs/12.0"), seen.url);
});

// An action that answers 204 has no body, and JSON.parse("") throws --
// which would turn a hold that worked into an error the user cannot
// act on.
test("an empty response body is not an error", async () => {
	const seen: Seen = {};
	await recordingApi(seen, 204, "").holdJob("12.0");
});

test("peek tails from the end on a first call", async () => {
	const seen: Seen = {};
	const api = recordingApi(seen, 200, JSON.stringify({ stdout: { text: "hello\n", offset: 6 } }));
	const result = await api.peek("12.0");

	const url = new URL(seen.url ?? "");
	assert.ok(url.pathname.endsWith("/api/v1/jobs/12.0/peek"), url.pathname);
	assert.equal(url.searchParams.get("stdout_offset"), "-1", "a first call must tail, not replay the file");
	assert.equal(result.stdout, "hello\n");
	assert.equal(result.offsets.stdout, 6);
});

test("the returned offsets are the ones to send next", async () => {
	const seen: Seen = {};
	const api = recordingApi(
		seen,
		200,
		JSON.stringify({ stdout: { text: "more", offset: 40 }, stderr: { text: "err", offset: 3 } })
	);
	const result = await api.peek("12.0", { stdout: 34, stderr: 0 });
	assert.equal(new URL(seen.url ?? "").searchParams.get("stdout_offset"), "34");
	assert.deepEqual(result.offsets, { stdout: 40, stderr: 3 });
});

// A poll that returns nothing must not rewind the stream: sending -1
// again would re-tail and show the same bytes over and over.
test("a poll with no new output keeps its place", async () => {
	const seen: Seen = {};
	const api = recordingApi(seen, 200, JSON.stringify({}));
	const result = await api.peek("12.0", { stdout: 100, stderr: 5 });
	assert.deepEqual(result.offsets, { stdout: 100, stderr: 5 });
	assert.equal(result.stdout, "");
});

// The server calls them `terminals`. Reading the wrong key does not
// fail -- it returns an empty list, so a caller waiting for a session
// to start waits for one that appears never to exist.
test("sessions are read from the key the server actually uses", async () => {
	const seen: Seen = {};
	const api = recordingApi(
		seen,
		200,
		JSON.stringify({
			terminals: [{ instance_id: "abc", job_id: "12.0", job_status: 2, batch_name: "session" }],
		})
	);
	const sessions = await api.listSessions();
	assert.equal(sessions.length, 1, "nothing was read; the response key is wrong");
	assert.equal(sessions[0]!.jobId, "12.0");
	assert.equal(sessions[0]!.status, 2);
});

test("a session list with the wrong key reads as empty, not as a crash", async () => {
	const seen: Seen = {};
	const api = recordingApi(seen, 200, JSON.stringify({ somethingElse: [] }));
	assert.deepEqual(await api.listSessions(), []);
});
