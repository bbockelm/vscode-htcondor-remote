// The slice of the HTCondor API server this extension talks to.
//
// Deliberately hand-written and small. The server has an OpenAPI
// document and generating a client from it would pull a code generator
// and its output into an extension whose whole selling point is that it
// needs nothing installed.

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

export class HTCondorApi {
	constructor(
		private readonly baseUrl: string,
		private readonly token: TokenSource,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

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

	private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${await this.token()}`,
			Accept: "application/json",
		};
		if (payload !== undefined) {
			headers["Content-Type"] = "application/json";
		}

		const response = await this.fetchImpl(new URL(path, this.baseUrl), {
			method,
			headers,
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		});

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
