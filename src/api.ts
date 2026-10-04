// The slice of the HTCondor API server this extension talks to.
//
// Deliberately hand-written and small. The server has an OpenAPI
// document and generating a client from it would pull a code generator
// and its output into an extension whose whole selling point is that it
// needs nothing installed.

import { http } from "./http";

/** What GET /api/v1/ssh/ca answers. */
export interface SSHCertificateAuthority {
	/** The CA in authorized_keys form. */
	publicKey: string;
	/** `@cert-authority * <ca>`, ready for a known_hosts file. */
	knownHostsLine: string;
	fingerprint: string;
	/**
	 * Where the SSH gateway is, when the access point says.
	 *
	 * Not currently published by any released server, which is the one
	 * thing standing between this extension and needing no
	 * configuration at all: the server knows the name from
	 * HTTP_API_SSH_GATEWAY_HOST -- it is already the certificate's
	 * principal -- but does not tell clients. Read here so that a
	 * server which starts publishing it works with no extension change,
	 * with a setting as the fallback until then.
	 */
	gatewayHost?: string;
	gatewayPort?: number;
}

/** What POST /api/v1/ssh/certificate answers. */
export interface SSHCertificate {
	/** The line to save as `<key>-cert.pub`. */
	certificate: string;
	/** The account the gateway signed, which the request cannot choose. */
	principal: string;
	/** When it stops working. There is no revocation, so this is the only control. */
	validBefore: Date;
	fingerprint: string;
}

/**
 * Where the access point is.
 *
 * A function as well as a string because reading the setting at
 * activation made a missing setting fatal: `activate` threw before it
 * had registered anything, so a fresh install had no tree, no commands
 * and not even the welcome view telling the user what to configure --
 * indistinguishable from the extension not being installed.
 */
export type BaseUrl = string | (() => string);

export function resolveBaseUrl(base: BaseUrl): string {
	return typeof base === "string" ? base : base();
}

/** What POST /api/v1/jobs/{id}/warm answers. */
export interface WarmResult {
	ready: boolean;
	/** True when there already was a connection, so nothing was paid for. */
	reused: boolean;
	elapsedMs: number;
	/** How long the connection stays warm with nothing using it. */
	idleTimeoutSeconds: number;
}

/** Supplies a bearer token, refreshing it if need be. */
export type TokenSource = () => Promise<string>;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		message: string
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * How long any one request may take.
 *
 * Every request needs one. Without it a stalled connection never
 * settles, and a caller awaiting it never finishes either -- which, for
 * the tree, meant a view stuck on "Loading jobs" that could not even
 * fall back to its welcome, because VS Code only shows that once it
 * knows the tree is empty.
 *
 * Thirty seconds, which is generous for a queue listing and short
 * enough that a wedged access point is reported rather than waited on.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Above this, a request is worth a line in the log.
 *
 * There is a stall on the first request of a fresh window that the
 * access point never sees -- nothing reaches its log -- so the time has
 * to be accounted for on this side. Splitting the wait into "getting a
 * token" and "waiting for the server" is the whole point: the two have
 * nothing in common and one line says which it was.
 */
const SLOW_REQUEST_MS = 2_000;

/**
 * How long a request may be outstanding before it is worth looking
 * into while it is still outstanding.
 *
 * Five seconds: a queue listing across a continent is well under it,
 * and what is being caught is twenty-five.
 */
const STILL_WAITING_MS = 5_000;

export class HTCondorApi {
	constructor(
		private readonly baseUrl: BaseUrl,
		private readonly token: TokenSource,
		private readonly fetchImpl: typeof fetch = http(),
		// Settable so a test can use a deadline it can actually wait
		// for. A test asserting the production thirty seconds would
		// have to take thirty seconds, so it would be written to time
		// out first instead -- and then it fails whether or not the
		// timeout works.
		private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
		// Not a vscode.LogOutputChannel: this module has no editor in
		// it and should stay that way.
		private readonly trace: (message: string) => void = () => {},
		/**
		 * Called when a request has been outstanding this long without
		 * an answer, once per client.
		 *
		 * The moment worth looking at is while a request is stuck, not
		 * after it finishes: by then whatever was being initialised is
		 * initialised, and a second measurement says nothing about the
		 * first.
		 */
		private readonly onStillWaiting: (method: string, path: string, waitedMs: number) => void = () => {},
		private readonly stillWaitingAfterMs: number = STILL_WAITING_MS
	) {}

	/** So the watchdog above fires at most once. */
	private warnedWaiting = false;

	/**
	 * Whether a request has completed yet.
	 *
	 * The first one in a window is the one that is slow, and it is
	 * slow whether or not anything else is. Logging it unconditionally
	 * means there is always a measurement to compare the rest against,
	 * rather than a line that only appears once things are already
	 * wrong.
	 */
	private answered = false;

	/** Where this client is pointed, canonical at the moment it is asked. */
	get accessPoint(): string {
		return resolveBaseUrl(this.baseUrl);
	}

	async certificateAuthority(): Promise<SSHCertificateAuthority> {
		const body = await this.request<{
			public_key: string;
			known_hosts_line: string;
			fingerprint: string;
			gateway_host?: string;
			gateway_port?: number;
		}>("GET", "/api/v1/ssh/ca");
		return {
			publicKey: body.public_key,
			knownHostsLine: body.known_hosts_line,
			fingerprint: body.fingerprint,
			...(body.gateway_host ? { gatewayHost: body.gateway_host } : {}),
			...(body.gateway_port ? { gatewayPort: body.gateway_port } : {}),
		};
	}

	/**
	 * Ask the gateway to sign a public key.
	 *
	 * `lifetimeSeconds` may only ask for less than the server's default;
	 * more is clamped rather than refused.
	 */
	async signCertificate(publicKeyLine: string, lifetimeSeconds?: number): Promise<SSHCertificate> {
		const payload: Record<string, unknown> = { public_key: publicKeyLine };
		if (lifetimeSeconds !== undefined) {
			payload.lifetime_seconds = lifetimeSeconds;
		}
		const body = await this.request<{
			certificate: string;
			principal: string;
			valid_before: string;
			fingerprint: string;
		}>("POST", "/api/v1/ssh/certificate", payload);

		const validBefore = new Date(body.valid_before);
		if (Number.isNaN(validBefore.getTime())) {
			throw new ApiError(
				200,
				body.valid_before,
				`The server returned an expiry this client cannot read: ${body.valid_before}`
			);
		}
		return {
			certificate: body.certificate,
			principal: body.principal,
			validBefore,
			fingerprint: body.fingerprint,
		};
	}

	/**
	 * One job's whole ClassAd.
	 *
	 * No projection, unlike listJobs: the point is to show everything,
	 * and the attribute somebody needs is reliably the one a projection
	 * left out.
	 */
	async getJobAd(id: string): Promise<Record<string, unknown> | undefined> {
		const [cluster, proc] = id.split(".");
		const params = new URLSearchParams({
			constraint: `ClusterId == ${Number(cluster)} && ProcId == ${Number(proc ?? 0)}`,
			limit: "1",
		});
		const body = await this.request<{ jobs?: Array<Record<string, unknown>> }>(
			"GET",
			`/api/v1/jobs?${params.toString()}`
		);
		return body.jobs?.[0];
	}

	/** The caller's jobs, newest cluster first. */
	async listJobs(options: ListJobsOptions = {}): Promise<JobSummary[]> {
		const params = new URLSearchParams();
		if (options.constraint) {
			params.set("constraint", options.constraint);
		}
		params.set("limit", String(options.limit ?? 200));
		params.set("projection", JOB_PROJECTION.join(","));

		const body = await this.request<{ jobs?: Array<Record<string, unknown>> }>(
			"GET",
			`/api/v1/jobs?${params.toString()}`
		);
		const jobs: JobSummary[] = [];
		for (const ad of body.jobs ?? []) {
			const summary = toJobSummary(ad);
			if (summary) {
				jobs.push(summary);
			}
		}
		// Newest first: a tree that puts the oldest at the top buries
		// the job the user just submitted.
		jobs.sort((a, b) => b.cluster - a.cluster || b.proc - a.proc);
		return jobs;
	}

	/**
	 * Read the end of a running job's output, from the execute node.
	 *
	 * Offsets are the server's, passed back on the next call so each
	 * poll returns only what is new. -1 means "tail from the end",
	 * which is what a first call wants.
	 */
	async peek(id: string, offsets: PeekOffsets = {}): Promise<PeekResult> {
		const params = new URLSearchParams({
			stdout_offset: String(offsets.stdout ?? -1),
			stderr_offset: String(offsets.stderr ?? -1),
		});
		if (offsets.maxBytes) {
			params.set("max_bytes", String(offsets.maxBytes));
		}
		const body = await this.request<{
			stdout?: { text: string; offset: number };
			stderr?: { text: string; offset: number };
		}>("GET", `/api/v1/jobs/${encodeURIComponent(id)}/peek?${params.toString()}`);

		return {
			stdout: body.stdout?.text ?? "",
			stderr: body.stderr?.text ?? "",
			// The old offset is kept when the server returns none, so a
			// poll that answered nothing does not rewind the stream to
			// the beginning on the next call.
			offsets: {
				stdout: body.stdout?.offset ?? offsets.stdout ?? -1,
				stderr: body.stderr?.offset ?? offsets.stderr ?? -1,
			},
		};
	}

	/**
	 * Submit a submit file.
	 *
	 * Only half a submission for most jobs: see submit.ts. The queue
	 * accepts this and then holds the job until its input is spooled.
	 */
	/**
	 * Ask the access point to open its connection into a job now.
	 *
	 * Remote-SSH has its own deadline for a whole connection, and the
	 * access point builds the transport to the execute node inside it:
	 * a schedd query, a CEDAR connection and an SSH handshake. When
	 * that does not fit, the connection is what gives way -- and the
	 * retry succeeds, because the attempt that timed out left a warm
	 * transport behind. This is that attempt, made on purpose, with a
	 * timeout of ours rather than Remote-SSH's.
	 *
	 * `undefined` means the access point does not have the endpoint,
	 * which is not a failure: it is a server older than this feature,
	 * and connecting without warming is exactly what used to happen.
	 */
	async warmJob(id: string, timeoutMs: number): Promise<WarmResult | undefined> {
		try {
			const body = await this.request<{
				ready?: boolean;
				reused?: boolean;
				elapsed_ms?: number;
				idle_timeout_seconds?: number;
			}>("POST", `/api/v1/jobs/${encodeURIComponent(id)}/warm`, undefined, timeoutMs);
			return {
				ready: body.ready !== false,
				reused: body.reused === true,
				elapsedMs: body.elapsed_ms ?? 0,
				idleTimeoutSeconds: body.idle_timeout_seconds ?? 0,
			};
		} catch (err: unknown) {
			if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
				return undefined;
			}
			throw err;
		}
	}

	async submit(submitFile: string): Promise<{ clusterId: number; jobIds: string[] }> {
		const body = await this.request<{ cluster_id: number; job_ids?: string[] }>(
			"POST",
			"/api/v1/jobs",
			{ submit_file: submitFile }
		);
		return { clusterId: body.cluster_id, jobIds: body.job_ids ?? [] };
	}

	/**
	 * Start an interactive session.
	 *
	 * A job that exists to be connected to rather than to run
	 * something. Every field is optional and the server fills
	 * defaults.
	 */
	async createSession(spec: SessionSpec = {}): Promise<SessionCreated> {
		const body = await this.request<{
			instance_id: string;
			cluster_id: number;
			proc_id: number;
			job_id: string;
			batch_name: string;
		}>("POST", "/api/v1/interactive/terminal", {
			...(spec.cpus ? { cpus: spec.cpus } : {}),
			...(spec.memoryMB ? { memory_mb: spec.memoryMB } : {}),
			...(spec.diskMB ? { disk_mb: spec.diskMB } : {}),
			...(spec.gpus ? { gpus: spec.gpus } : {}),
			...(spec.submitLines ? { submit_lines: spec.submitLines } : {}),
		});
		return {
			instanceId: body.instance_id,
			jobId: body.job_id,
			cluster: body.cluster_id,
			proc: body.proc_id,
			batchName: body.batch_name,
		};
	}

	/** The caller's interactive sessions. */
	async listSessions(): Promise<SessionSummary[]> {
		// `terminals`, which is what the server calls them. Guessing
		// `sessions` here cost an evening: the list came back empty
		// every time, so a caller waiting for a session to start waited
		// for one that, as far as it could tell, did not exist.
		const body = await this.request<{ terminals?: Array<Record<string, unknown>> }>(
			"GET",
			"/api/v1/interactive/terminal"
		);
		return (body.terminals ?? []).map((raw) => ({
			instanceId: String(raw.instance_id ?? ""),
			jobId: String(raw.job_id ?? ""),
			status: typeof raw.job_status === "number" ? raw.job_status : 0,
			batchName: String(raw.batch_name ?? ""),
			...(raw.hold_reason ? { holdReason: String(raw.hold_reason) } : {}),
			...(typeof raw.hold_reason_code === "number" ? { holdReasonCode: raw.hold_reason_code } : {}),
		}));
	}

	/** Hold a job, with an optional reason the schedd records. */
	async holdJob(id: string, reason?: string): Promise<void> {
		await this.request<unknown>("POST", `/api/v1/jobs/${encodeURIComponent(id)}/hold`, {
			...(reason ? { reason } : {}),
		});
	}

	async releaseJob(id: string): Promise<void> {
		await this.request<unknown>("POST", `/api/v1/jobs/${encodeURIComponent(id)}/release`, {});
	}

	/** Remove a job from the queue. There is no undo. */
	async removeJob(id: string): Promise<void> {
		await this.request<unknown>("DELETE", `/api/v1/jobs/${encodeURIComponent(id)}`);
	}

	private async request<T>(method: string, path: string, payload?: unknown, timeoutMs?: number): Promise<T> {
		const deadline = timeoutMs ?? this.timeoutMs;
		const startedAt = Date.now();
		const headers: Record<string, string> = {
			Authorization: `Bearer ${await this.token()}`,
			Accept: "application/json",
		};
		if (payload !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		const tokenMs = Date.now() - startedAt;
		const sentAt = Date.now();

		// Armed before the request and cleared after it, so it only
		// fires while the request really is outstanding.
		let watchdog: NodeJS.Timeout | undefined;
		if (!this.warnedWaiting) {
			watchdog = setTimeout(() => {
				this.warnedWaiting = true;
				this.onStillWaiting(method, path, this.stillWaitingAfterMs);
			}, this.stillWaitingAfterMs);
			// Nothing should be kept alive by a diagnostic.
			watchdog.unref?.();
		}

		let response: Response;
		try {
			response = await this.fetchImpl(new URL(path, resolveBaseUrl(this.baseUrl)), {
				method,
				headers,
				signal: AbortSignal.timeout(deadline),
				...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
			});
		} catch (err: unknown) {
			clearTimeout(watchdog);
			// A timeout arrives as an abort, which says nothing about
			// what was being waited for.
			if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
				const waited = Date.now() - sentAt;
				this.answered = true;
				this.trace(timing(method, path, tokenMs, waited, "gave up", sentAt));
				// The split is in the message, not only in the log,
				// because this message is what gets read and reported
				// -- and "getting a token" and "waiting for the access
				// point" are different faults with different owners.
				throw new ApiError(
					0,
					"",
					`The access point did not answer within ${deadline / 1000}s ` +
						`(${method} ${path}; ${tokenMs}ms getting a token, ${waited}ms waiting)`
				);
			}
			this.answered = true;
			this.trace(timing(method, path, tokenMs, Date.now() - sentAt, "failed", sentAt));
			throw err;
		}
		clearTimeout(watchdog);
		const waitMs = Date.now() - sentAt;
		const first = !this.answered;
		this.answered = true;
		if (first || tokenMs + waitMs >= SLOW_REQUEST_MS) {
			this.trace(timing(method, path, tokenMs, waitMs, String(response.status), sentAt));
		}

		const text = await response.text();
		if (!response.ok) {
			throw new ApiError(response.status, text, describeFailure(method, path, response.status, text));
		}
		if (text.trim() === "") {
			// A 204, or an action that answers with nothing. Parsing an
			// empty body as JSON throws, which would turn a successful
			// hold into an error the user cannot act on.
			return undefined as T;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new ApiError(response.status, text, `${method} ${path} did not return JSON`);
		}
	}
}

/**
 * One line accounting for where a request's time went.
 *
 * `sentAt` is in it so the line can be put beside the access point's
 * own log. That comparison is the one that settles where a slow
 * request was slow: if the server recorded it arriving at this time
 * and answering 25 seconds later, the time was spent there; if it
 * recorded it arriving 25 seconds after this time, the request had
 * not left the editor yet.
 */
function timing(
	method: string,
	path: string,
	tokenMs: number,
	waitMs: number,
	outcome: string,
	sentAt: number
): string {
	const clock = new Date(sentAt).toISOString();
	return (
		`${method} ${path}: ${outcome} after ${tokenMs}ms getting a token ` +
		`and ${waitMs}ms waiting for the access point (sent at ${clock})`
	);
}

/**
 * Turn a failed response into something that says what to do about it.
 *
 * The two statuses worth naming are the ones an operator can fix and a
 * user cannot: a gateway with no CA key configured answers 503 to both
 * endpoints, and that is a deployment gap rather than anything the
 * person at the keyboard did wrong.
 */
function describeFailure(method: string, path: string, status: number, body: string): string {
	const detail = serverMessage(body);
	switch (status) {
		case 401:
			return "The access point did not accept this session. Signing in again should fix it.";
		case 403:
			return detail
				? `The access point refused: ${detail}`
				: "The access point refused this request.";
		case 503:
			return (
				"This access point does not issue SSH certificates. Its administrator needs to " +
				"configure HTTP_API_SSH_CA_KEY_FILE (or an application-database key) before " +
				"this extension can connect without a browser prompt."
			);
		default:
			return detail
				? `${method} ${path} failed (${status}): ${detail}`
				: `${method} ${path} failed (${status})`;
	}
}

/** Pull the server's own error text out of a JSON error body, if it is one. */
function serverMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
		for (const field of [parsed.error, parsed.message]) {
			if (typeof field === "string" && field.trim() !== "") {
				return field.trim();
			}
		}
	} catch {
		// Not JSON. The raw body is usually an HTML error page from
		// something in front of the server, which is not worth quoting.
	}
	return "";
}

/** The job attributes the views need, as HTCondor spells them. */
export interface JobSummary {
	cluster: number;
	proc: number;
	/** HTCondor's JobStatus code. */
	status: number;
	owner?: string;
	batchName?: string;
	command?: string;
	holdReason?: string;
	remoteHost?: string;
}

/**
 * HTCondor's JobStatus codes.
 *
 * Spelled out because a bare number in a tree label is unreadable, and
 * because the mapping is easy to get subtly wrong: 3 is Removed and 4
 * is Completed, which is the pair people reverse.
 */
export const JOB_STATUS: Record<number, string> = {
	1: "Idle",
	2: "Running",
	3: "Removed",
	4: "Completed",
	5: "Held",
	6: "Transferring Output",
	7: "Suspended",
};

export function describeStatus(status: number): string {
	return JOB_STATUS[status] ?? `Unknown (${status})`;
}

/** A job id as HTCondor writes it. */
export function jobId(job: { cluster: number; proc: number }): string {
	return `${job.cluster}.${job.proc}`;
}

export interface ListJobsOptions {
	/** A ClassAd expression. Omitted means every job the caller can see. */
	constraint?: string;
	limit?: number;
}

/** Attributes worth asking for. Fewer means smaller ads over the wire. */
const JOB_PROJECTION = [
	"ClusterId",
	"ProcId",
	"JobStatus",
	"Owner",
	"JobBatchName",
	"Cmd",
	"HoldReason",
	"RemoteHost",
];

/** Parse one ClassAd from the jobs endpoint into a JobSummary. */
export function toJobSummary(ad: Record<string, unknown>): JobSummary | undefined {
	const cluster = numberOf(ad.ClusterId);
	const proc = numberOf(ad.ProcId);
	if (cluster === undefined || proc === undefined) {
		// An ad without an id is not addressable, so there is nothing
		// useful a view could do with it.
		return undefined;
	}
	return {
		cluster,
		proc,
		status: numberOf(ad.JobStatus) ?? 0,
		...(stringOf(ad.Owner) ? { owner: stringOf(ad.Owner)! } : {}),
		...(stringOf(ad.JobBatchName) ? { batchName: stringOf(ad.JobBatchName)! } : {}),
		...(stringOf(ad.Cmd) ? { command: stringOf(ad.Cmd)! } : {}),
		...(stringOf(ad.HoldReason) ? { holdReason: stringOf(ad.HoldReason)! } : {}),
		...(stringOf(ad.RemoteHost) ? { remoteHost: stringOf(ad.RemoteHost)! } : {}),
	};
}

function numberOf(value: unknown): number | undefined {
	if (typeof value === "number") {
		return value;
	}
	// ClassAd values arrive as numbers, but an attribute that was set
	// from a string expression comes back as one -- and Number("") is
	// 0, which would silently become cluster 0.
	if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

export interface PeekOffsets {
	stdout?: number;
	stderr?: number;
	maxBytes?: number;
}

export interface PeekResult {
	stdout: string;
	stderr: string;
	/** Pass these back on the next call to get only what is new. */
	offsets: { stdout: number; stderr: number };
}

/** What to ask for when starting a session. All optional. */
export interface SessionSpec {
	cpus?: number;
	memoryMB?: number;
	diskMB?: number;
	gpus?: number;
	submitLines?: string;
}

export interface SessionCreated {
	instanceId: string;
	jobId: string;
	cluster: number;
	proc: number;
	batchName: string;
}

export interface SessionSummary {
	instanceId: string;
	jobId: string;
	status: number;
	batchName: string;
	holdReason?: string;
	/**
	 * HTCondor's HoldReasonCode.
	 *
	 * Needed as well as the text, because one hold is not a failure:
	 * every submission is written into the queue held on code 16 while
	 * its input spools, and the schedd releases it by itself. Reading
	 * only the reason string means guessing from prose.
	 */
	holdReasonCode?: number;
}
