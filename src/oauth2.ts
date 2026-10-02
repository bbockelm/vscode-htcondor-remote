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
	/**
	 * The scopes this registration was made with.
	 *
	 * Kept so a later version asking for different ones can tell that
	 * the stored registration is stale. A client may not request a
	 * scope it did not register, so reusing an old registration after
	 * the list changes fails at the authorize step with a message about
	 * a scope the user never chose.
	 */
	scopes?: string[];
}

/** Whether a stored registration still covers what this version asks for. */
export function registrationIsCurrent(credentials: ClientCredentials): boolean {
	const registered = new Set(credentials.scopes ?? []);
	// An older registration recorded none. It predates this check, so
	// it cannot be trusted to cover the current list.
	if (registered.size === 0) {
		return false;
	}
	return SCOPES.every((scope) => registered.has(scope));
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
 *
 * `openid` is requested because the access point GRANTS it whether or
 * not it was asked for. A grant may not exceed what the client is
 * registered for, so a client that leaves it out gets a grant carrying
 * a scope it never registered -- which works until the first refresh
 * and then fails for ever with:
 *
 *     The OAuth 2.0 Client is not allowed to request scope 'openid'
 *
 * Asking for it costs nothing: it names no privilege, and the server
 * was adding it regardless.
 */
export const SCOPES = ["openid", "condor:/WRITE", "offline_access"];

/**
 * A refusal from the token endpoint, with the reason kept.
 *
 * `fatal` means this grant will never work again, however many times it
 * is retried: the refresh token is spent, revoked, or the grant no
 * longer carries the scopes the client needs. The only cure is signing
 * in again, so a caller that keeps retrying is burning the user's time
 * instead of telling them.
 */
export class TokenError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly fatal: boolean
	) {
		super(message);
		this.name = "TokenError";
	}
}

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
		scopes: [...SCOPES],
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
		const reply = (status: number, heading: string, message: string, tone: Tone = "ok") => {
			res.writeHead(status, {
				"Content-Type": "text/html; charset=utf-8",
				// This page is the last thing an authorization code
				// touches; nothing should keep a copy of it.
				"Cache-Control": "no-store",
			});
			res.end(callbackPage(heading, message, tone));
		};

		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description") ?? "";
			reply(400, "Sign-in failed", "You can close this tab and try again in VS Code.", "error");
			fail(new Error(`The access point refused the sign-in: ${error} ${description}`.trim()));
			return;
		}
		if (url.searchParams.get("state") !== state) {
			// Not our redirect. Answering with the code would mean
			// exchanging one this flow never asked for.
			reply(
				400,
				"Not this window",
				"This sign-in did not come from the VS Code window that is waiting. Start it again from the editor.",
				"error"
			);
			return;
		}
		const received = url.searchParams.get("code");
		if (!received) {
			reply(400, "Sign-in failed", "The access point returned no authorization code.", "error");
			fail(new Error("The access point returned no authorization code"));
			return;
		}
		reply(200, "Signed in", "You can close this tab and return to VS Code.", "ok");
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
		const code = errorCode(text);
		// invalid_grant: the refresh token is spent or revoked.
		// invalid_scope: the grant no longer covers what this client
		// asks for -- most often because offline_access was never
		// granted, without which no refresh is permitted at all.
		// Neither improves by being retried.
		const fatal = code === "invalid_grant" || code === "invalid_scope";
		throw new TokenError(describeTokenFailure(response.status, text), code, fatal);
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
	let description = "";
	try {
		const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown; hint?: unknown };
		code = typeof parsed.error === "string" ? parsed.error : "";
		// error_description is where the server says WHICH scope, or
		// which part of the grant it objected to. Reporting only the
		// code throws away the one sentence that identifies the
		// problem, and leaves "invalid_scope" meaning nothing at all --
		// which is exactly how an hour went missing.
		for (const field of [parsed.error_description, parsed.hint]) {
			if (typeof field === "string" && field.trim() !== "") {
				description = field.trim();
				break;
			}
		}
	} catch {
		// Not JSON; the status carries what there is to say.
	}

	if (code === "invalid_grant") {
		// The case a user meets: a refresh token that expired or was
		// revoked. "invalid_grant" tells them nothing.
		return "This sign-in is no longer valid. Signing in again will fix it.";
	}
	if (code === "invalid_scope") {
		// Almost always a grant that no longer covers what this client
		// asks for -- scopes narrowed on the server, or a consent that
		// did not include offline_access, without which no refresh is
		// permitted at all.
		return join(
			"This sign-in no longer covers what the extension needs" + (description ? `: ${description}` : ""),
			"Signing out and in again usually fixes it."
		);
	}

	const parts = [code, description].filter((p) => p !== "");
	return `The access point refused the token request (${status})${parts.length ? `: ${parts.join(" — ")}` : ""}`;
}

/** The OAuth2 error code in a failure body, if there is one. */
function errorCode(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed.error === "string" ? parsed.error : "";
	} catch {
		return "";
	}
}

type Tone = "ok" | "error";

/**
 * The page the browser lands on after authorizing.
 *
 * Styled to match the access point's own standalone pages -- the same
 * gradient, card and type -- because it is the only page in this flow
 * the extension serves, and a plain-HTML interruption between two
 * designed pages reads as something having gone wrong.
 *
 * Entirely self-contained: it is served from a loopback port that
 * closes seconds later, so it cannot reference a stylesheet, and
 * should not reach the network for a font either.
 */
export function callbackPage(heading: string, message: string, tone: Tone): string {
	const accent = tone === "ok" ? "#2f9e68" : "#c0392b";
	const glyph = tone === "ok" ? "&#10003;" : "&#33;";
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HTCondor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    background: #fff; border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    max-width: 440px; width: 100%; padding: 40px; text-align: center;
  }
  .mark {
    width: 56px; height: 56px; border-radius: 50%;
    background: ${accent}; color: #fff;
    font-size: 30px; line-height: 56px; margin: 0 auto 20px;
  }
  h1 { color: #333; font-size: 24px; margin-bottom: 10px; }
  p { color: #666; font-size: 14px; line-height: 1.6; }
  .hint { color: #999; font-size: 12px; margin-top: 24px; }
</style>
<div class="card">
  <div class="mark">${glyph}</div>
  <h1>${escapeHTML(heading)}</h1>
  <p>${escapeHTML(message)}</p>
  <p class="hint">HTCondor for VS Code</p>
</div>
`;
}

/** Escape text for HTML. Nothing here is attacker-controlled today,
 * but a message assembled from a server's error field one day would
 * be, and remembering at that point is not something to rely on. */
function escapeHTML(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Join sentences without doubling the full stop.
 *
 * The server's error_description is a sentence and ends with one of its
 * own, so appending ours produced "...malformed.. Signing out" -- which
 * reads like a typo in the middle of an explanation the reader is
 * already struggling with.
 */
function join(first: string, second: string): string {
	const left = first.replace(/\s+$/, "");
	return /[.!?]$/.test(left) ? `${left} ${second}` : `${left}. ${second}`;
}
