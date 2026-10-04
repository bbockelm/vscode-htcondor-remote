import { strict as assert } from "node:assert";
import { test } from "node:test";

import { HTCondorApi, describeStatus, jobId, toJobSummary } from "../api";
import { applyJobsMessage, MessageBar } from "../jobsStatus";

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

// The hold CODE has to survive the parse, not just the reason text:
// one hold is not a failure, and prose is the wrong thing to decide on.
test("a session's hold code is read, not just its reason", async () => {
	const seen: Seen = {};
	const api = recordingApi(
		seen,
		200,
		JSON.stringify({
			terminals: [
				{
					instance_id: "abc",
					job_id: "12.0",
					job_status: 5,
					hold_reason: "Spooling input data files",
					hold_reason_code: 16,
				},
			],
		})
	);
	const [session] = await api.listSessions();
	assert.equal(session!.holdReasonCode, 16);
	assert.equal(session!.holdReason, "Spooling input data files");
});

// A request that never answers is worse than one that fails: the
// caller never finishes either. For the jobs tree that meant a view
// stuck on "Loading jobs" which could not even fall back to its
// welcome, because VS Code only shows that once it knows the tree is
// empty.
// Given a deadline of its own, so that removing the abort signal makes
// this fail in five seconds rather than wedging the whole suite -- a
// hung run reads as infrastructure trouble rather than as the missing
// timeout it is.
test("a request that never answers times out", { timeout: 5_000 }, async () => {
	const hang: typeof fetch = ((_input: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			// Reject the way an aborted fetch does.
			init?.signal?.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "TimeoutError";
				reject(err);
			});
		})) as typeof fetch;

	// 100ms, so the test waits for the deadline rather than the
	// other way round.
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", hang, 100);
	await assert.rejects(api.listJobs(), /did not answer within/);
});

// Every request carries the deadline, not just the first one written.
test("the timeout is attached to the request", async () => {
	let sawSignal = false;
	const fetchImpl: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
		sawSignal = init?.signal instanceof AbortSignal;
		return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
	}) as typeof fetch;

	await new HTCondorApi("https://ap.example.edu", async () => "t", fetchImpl).listJobs();
	assert.ok(sawSignal, "no abort signal was attached, so this request could hang for ever");
});

test("the access point can be supplied as a function, read at request time", async () => {
	// Reading the setting once, at activation, made an unconfigured
	// install fatal -- activate() threw before registering anything.
	// Passing the lookup instead also means a user who changes the
	// setting does not have to reload the window.
	let current = "https://first.example.edu";
	const seen: string[] = [];
	const api = new HTCondorApi(
		() => current,
		async () => "t",
		async (input) => {
			seen.push(new URL(String(input)).origin);
			return new Response(JSON.stringify({ jobs: [] }));
		}
	);

	await api.listJobs();
	current = "https://second.example.edu";
	await api.listJobs();

	assert.deepEqual(seen, ["https://first.example.edu", "https://second.example.edu"]);
});

test("a slow request accounts for where its time went", async () => {
	const lines: string[] = [];
	const api = new HTCondorApi(
		"https://ap.example.edu",
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return "t";
		},
		async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return new Response(JSON.stringify({ jobs: [] }));
		},
		undefined,
		(message) => lines.push(message)
	);

	await api.listJobs();

	// The stall users hit never reaches the access point's log, so this
	// side has to say which half of the wait it was.
	assert.equal(lines.length, 0, "a request under the slow threshold is not worth a line");
});

test("a request that times out says how long each part took", async () => {
	const lines: string[] = [];
	const hang = (): Promise<Response> =>
		new Promise((_resolve, reject) => {
			setTimeout(() => {
				const err = new Error("aborted");
				err.name = "TimeoutError";
				reject(err);
			}, 20);
		});
	const api = new HTCondorApi("https://ap.example.edu", async () => "t", hang, 50, (message) =>
		lines.push(message)
	);

	await assert.rejects(() => api.listJobs());

	assert.equal(lines.length, 1, `expected one accounting line, got ${JSON.stringify(lines)}`);
	assert.match(lines[0], /gave up/);
	assert.match(lines[0], /getting a token/);
	assert.match(lines[0], /waiting for the access point/);
});

/**
 * A message bar that behaves like the editor's.
 *
 * `message` is an accessor on a real TreeView, which is the detail
 * that mattered: `delete view.message` removes the accessor rather
 * than calling a setter, so the bar freezes on whatever it last said
 * and every later message is written to a dead property.
 */
function fakeMessageBar(): { shown: () => string | undefined; view: MessageBar } {
	let current: string | undefined;
	const view = {} as MessageBar;
	Object.defineProperty(view, "message", {
		configurable: true,
		get: () => current,
		set: (value: string | undefined) => {
			current = value;
		},
	});
	return { shown: () => current, view };
}

test("a successful load clears the message bar", async () => {
	// The reported symptom: "Loading jobs…" stayed up after the jobs
	// had loaded.
	const { shown, view } = fakeMessageBar();

	applyJobsMessage(view, { kind: "loading" });
	assert.equal(shown(), "Loading jobs…");

	applyJobsMessage(view, { kind: "loaded", count: 3 });
	assert.equal(shown(), undefined, "the bar still says something after the jobs arrived");
});

test("the message bar is assigned, never deleted", async () => {
	// Clearing it with `delete` takes the accessor with it, so the
	// view stops hearing about anything that happens afterwards.
	const { shown, view } = fakeMessageBar();

	applyJobsMessage(view, { kind: "loading" });
	applyJobsMessage(view, { kind: "loaded", count: 0 });
	applyJobsMessage(view, { kind: "failed", detail: "the access point said no" });

	assert.ok(
		Object.getOwnPropertyDescriptor(view, "message")?.get,
		"the accessor is gone, so nothing this view is told will ever be shown again"
	);
	assert.match(String(shown()), /the access point said no/);
});
