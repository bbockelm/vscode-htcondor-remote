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
