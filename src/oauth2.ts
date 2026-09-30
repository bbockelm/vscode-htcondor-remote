// The OAuth2 client, with no dependency on VS Code.
//
// Kept separate from the authentication provider that wraps it so the
// protocol can be tested against a real loopback redirect and a fake
// server, rather than only inside an editor.
//
// The flow is authorization code with PKCE and a loopback redirect,
// which is what the access point is built for: oauth2_cimd.go treats
// `localhost` as loopback specifically because native clients register
// both `127.0.0.1` and `localhost` and then ask for an ephemeral port.
//
// Registration is dynamic (RFC 7591), once per installation. The server
// issues a CONFIDENTIAL client -- `Public: false`, with a secret -- and
// advertises `none` as a token-endpoint auth method only when CIMD is
// enabled, so a secretless public client is not generally available.
// Registering per installation is the better shape anyway: the secret
// is never shipped in the extension, differs between machines, and an
// administrator can revoke one install without touching the rest.

import { createHash, randomBytes } from "node:crypto";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";

/** The endpoints this client uses, from RFC 8414 discovery. */
export interface Discovery {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	deviceAuthorizationEndpoint?: string;
}

/** What registration returns, and what has to be kept. */
export interface ClientCredentials {
	clientId: string;
	clientSecret?: string;
}

export interface Tokens {
	accessToken: string;
	refreshToken?: string;
	/** Absolute, not a duration: a duration is useless once stored. */
	expiresAt?: Date;
	scope?: string;
}

/**
 * Scopes the extension asks for.
 *
 * `condor:/WRITE` because that is what reaches a job: the schedd
 * registers GET_JOB_CONNECT_INFO at WRITE, so shell access needs it and
 * an SSH certificate is refused without it. `offline_access` because an
 * editor session lives for days and re-prompting daily is the thing
 * this design exists to avoid.
 */
export const SCOPES = ["condor:/WRITE", "offline_access"];

export async function discover(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
	const url = new URL("/.well-known/oauth-authorization-server", baseUrl);
	const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
	if (!response.ok) {
		throw new Error(
			`The access point did not publish OAuth2 metadata (${response.status}). ` +
				`Is ${baseUrl} an HTCondor API server with MCP enabled?`
		);
	}
	const body = (await response.json()) as Record<string, unknown>;
	const required = (name: string): string => {
		const value = body[name];
		if (typeof value !== "string" || value === "") {
			throw new Error(`The access point's OAuth2 metadata has no ${name}`);
		}
		return value;
	};
	const optional = (name: string): string | undefined => {
		const value = body[name];
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	return {
		authorizationEndpoint: required("authorization_endpoint"),
		tokenEndpoint: required("token_endpoint"),
		...(optional("registration_endpoint") ? { registrationEndpoint: optional("registration_endpoint")! } : {}),
		...(optional("device_authorization_endpoint")
			? { deviceAuthorizationEndpoint: optional("device_authorization_endpoint")! }
			: {}),
	};
}

/**
 * Register this installation.
 *
 * Both `127.0.0.1` and `localhost` are registered with no port, because
 * the port is chosen when the browser is opened and a registration
 * naming one would pin every future sign-in to a port that may be taken.
 */
export async function register(
	discovery: Discovery,
	fetchImpl: typeof fetch = fetch
): Promise<ClientCredentials> {
	if (!discovery.registrationEndpoint) {
		throw new Error(
			"This access point does not offer dynamic client registration, so the " +
				"extension cannot register itself. An administrator can configure a " +
				"client for it instead."
		);
	}
	const response = await fetchImpl(discovery.registrationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			client_name: "VS Code (HTCondor)",
			redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: SCOPES.join(" "),
		}),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Could not register with the access point (${response.status}): ${text}`);
	}
	const body = JSON.parse(text) as { client_id?: string; client_secret?: string };
	if (!body.client_id) {
		throw new Error("The access point registered the extension without a client_id");
	}
	return {
		clientId: body.client_id,
		...(body.client_secret ? { clientSecret: body.client_secret } : {}),
	};
}

/** One PKCE pair. S256 only; `plain` is advertised and not worth using. */
export function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/** A loopback listener waiting for one redirect. */
export interface Redirect {
	/** The redirect_uri to send, with the port that was actually bound. */
	uri: string;
	/**
	 * The address actually bound, as the OS reports it.
	 *
	 * Separate from `uri`, which is a string we build: the two agreeing
	 * is the property worth checking, since this socket accepts an
	 * authorization code and one reachable off-host would accept one
	 * from anywhere.
	 */
	boundHost: string;
	/** Resolves with the authorization code, or rejects with the error. */
	code: Promise<string>;
	close(): void;
}

/**
 * Listen on loopback for the authorization redirect.
 *
 * `state` is generated by the caller and checked here: a redirect that
 * does not carry it back is not ours, and treating it as ours is how a
 * code from somewhere else gets exchanged.
 */
export async function awaitRedirect(state: string): Promise<Redirect> {
	let settle: (code: string) => void;
	let fail: (err: Error) => void;
	const code = new Promise<string>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// Mark it handled the moment it exists. A redirect can arrive and
	// fail before the caller gets round to awaiting -- it opens a
	// browser in between -- and an unhandled rejection takes down the
	// extension host rather than failing the sign-in. Attaching an
	// empty catch does not swallow anything: the caller awaiting the
	// same promise still sees the rejection.
	code.catch(() => {});

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const reply = (status: number, message: string) => {
			res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<!doctype html><meta charset="utf-8"><title>HTCondor</title><p>${message}`);
		};

		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description") ?? "";
			reply(400, "Sign-in failed. You can close this tab and try again in VS Code.");
			fail(new Error(`The access point refused the sign-in: ${error} ${description}`.trim()));
			return;
		}
		if (url.searchParams.get("state") !== state) {
			// Not our redirect. Answering with the code would mean
			// exchanging one this flow never asked for.
			reply(400, "This sign-in did not come from VS Code.");
			return;
		}
		const received = url.searchParams.get("code");
		if (!received) {
			reply(400, "The access point returned no authorization code.");
			fail(new Error("The access point returned no authorization code"));
			return;
		}
		reply(200, "Signed in. You can close this tab and return to VS Code.");
		settle(received);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		// 127.0.0.1, not 0.0.0.0: this accepts an authorization code,
		// and a listener reachable from the network would accept one
		// from anywhere.
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const { address, port } = server.address() as AddressInfo;
	return {
		uri: `http://127.0.0.1:${port}/callback`,
		boundHost: address,
		code,
		close: () => {
			server.closeAllConnections?.();
			server.close();
		},
	};
}

/** Build the URL to open in the browser. */
export function authorizationUrl(
	discovery: Discovery,
	client: ClientCredentials,
	redirectUri: string,
	challenge: string,
	state: string
): string {
	const url = new URL(discovery.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", SCOPES.join(" "));
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

export async function exchangeCode(
	discovery: Discovery,
	client: ClientCredentials,
	code: string,
	verifier: string,
	redirectUri: string,
	fetchImpl: typeof fetch = fetch
): Promise<Tokens> {
	return tokenRequest(
		discovery,
		client,
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		},
		fetchImpl
	);
}

export async function refreshTokens(
	discovery: Discovery,
	client: ClientCredentials,
	refreshToken: string,
	fetchImpl: typeof fetch = fetch
): Promise<Tokens> {
	return tokenRequest(
		discovery,
		client,
		{ grant_type: "refresh_token", refresh_token: refreshToken },
		fetchImpl
	);
}

async function tokenRequest(
	discovery: Discovery,
	client: ClientCredentials,
	params: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<Tokens> {
	const form = new URLSearchParams(params);
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};

	if (client.clientSecret) {
		// client_secret_basic. Both halves are form-encoded before
		// base64 per RFC 6749 s2.3.1 -- a generated secret can contain
		// characters that would otherwise break the colon split.
		const basic = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
		headers.Authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
	} else {
		form.set("client_id", client.clientId);
	}

	const response = await fetchImpl(discovery.tokenEndpoint, {
		method: "POST",
		headers,
		body: form.toString(),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(describeTokenFailure(response.status, text));
	}

	const body = JSON.parse(text) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
	};
	if (!body.access_token) {
		throw new Error("The access point returned no access token");
	}
	return {
		accessToken: body.access_token,
		...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
		...(typeof body.expires_in === "number"
			? { expiresAt: new Date(Date.now() + body.expires_in * 1000) }
			: {}),
		...(body.scope ? { scope: body.scope } : {}),
	};
}

function describeTokenFailure(status: number, body: string): string {
	let code = "";
	try {
		code = String((JSON.parse(body) as { error?: unknown }).error ?? "");
	} catch {
		// Not JSON; the status carries what there is to say.
	}
	if (code === "invalid_grant") {
		// The case a user meets: a refresh token that expired or was
		// revoked. "invalid_grant" tells them nothing.
		return "This sign-in is no longer valid. Signing in again will fix it.";
	}
	return `The access point refused the token request (${status})${code ? `: ${code}` : ""}`;
}
