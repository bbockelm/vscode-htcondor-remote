import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
	authorizationUrl,
	callbackPage,
	awaitRedirect,
	Discovery,
	discover,
	exchangeCode,
	pkce,
	refreshTokens,
	register,
	registrationIsCurrent,
	SCOPES,
	sessionCoversScopes,
} from "../oauth2";

const TIMEOUT = { timeout: 5_000 };

const DISCOVERY: Discovery = {
	authorizationEndpoint: "https://ap.example.edu/mcp/oauth2/authorize",
	tokenEndpoint: "https://ap.example.edu/mcp/oauth2/token",
	registrationEndpoint: "https://ap.example.edu/mcp/oauth2/register",
};

function jsonFetch(
	status: number,
	body: unknown,
	seen?: { req?: RequestInit | undefined; url?: string }
): typeof fetch {
	return (async (input: unknown, init?: RequestInit) => {
		if (seen) {
			seen.url = String(input);
			seen.req = init;
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

test("discovery reads the endpoints the server publishes", async () => {
	const seen: { url?: string } = {};
	const d = await discover(
		"https://ap.example.edu",
		jsonFetch(200, {
			authorization_endpoint: "https://ap.example.edu/mcp/oauth2/authorize",
			token_endpoint: "https://ap.example.edu/mcp/oauth2/token",
			registration_endpoint: "https://ap.example.edu/mcp/oauth2/register",
			device_authorization_endpoint: "https://ap.example.edu/mcp/oauth2/device/authorize",
		}, seen)
	);
	assert.equal(seen.url, "https://ap.example.edu/.well-known/oauth-authorization-server");
	assert.equal(d.tokenEndpoint, "https://ap.example.edu/mcp/oauth2/token");
	assert.equal(d.registrationEndpoint, "https://ap.example.edu/mcp/oauth2/register");
});

// Pointing the extension at the wrong URL is the mistake a user will
// actually make, so the message has to name what was expected.
test("a server without OAuth2 metadata says what is wrong", async () => {
	await assert.rejects(
		discover("https://example.com", jsonFetch(404, {})),
		/HTCondor API server with MCP enabled/
	);
});

test("metadata missing a required endpoint is refused", async () => {
	await assert.rejects(
		discover("https://ap.example.edu", jsonFetch(200, { token_endpoint: "https://x/token" })),
		/no authorization_endpoint/
	);
});

test("registration asks for both loopback spellings, without a port", async () => {
	const seen: { req?: RequestInit | undefined } = {};
	const creds = await register(
		DISCOVERY,
		jsonFetch(200, { client_id: "abc", client_secret: "s3cret" }, seen)
	);
	assert.equal(creds.clientId, "abc");
	assert.equal(creds.clientSecret, "s3cret");

	const body = JSON.parse(String(seen.req?.body)) as { redirect_uris: string[]; scope: string };
	// Both spellings, because the server treats `localhost` as loopback
	// specifically for native clients that register both. No port: it is
	// chosen when the browser opens, and a registered port would pin
	// every future sign-in to one that may be taken.
	assert.deepEqual(body.redirect_uris, ["http://127.0.0.1/callback", "http://localhost/callback"]);
	for (const uri of body.redirect_uris) {
		assert.equal(new URL(uri).port, "", `${uri} pins a port`);
	}
	assert.ok(body.scope.includes("condor:/WRITE"), "condor:/WRITE is what reaches a job");
	assert.ok(body.scope.includes("offline_access"), "without it the session lasts one token");
});

test("a server without registration says what an admin must do", async () => {
	const { registrationEndpoint: _drop, ...noRegistration } = DISCOVERY;
	await assert.rejects(register(noRegistration, jsonFetch(200, {})), /administrator can configure a client/);
});

test("the PKCE challenge is the S256 of the verifier", () => {
	const { verifier, challenge } = pkce();
	assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
	// base64url, so it survives a query string untouched.
	assert.doesNotMatch(challenge, /[+/=]/);
	assert.ok(verifier.length >= 43, `verifier is ${verifier.length} chars, RFC 7636 wants 43+`);
	assert.notEqual(pkce().verifier, verifier, "the verifier is not fresh per call");
});

test("the authorization URL carries PKCE and the scopes", () => {
	const url = new URL(authorizationUrl(DISCOVERY, { clientId: "abc" }, "http://127.0.0.1:9/cb", "chal", "st"));
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("client_id"), "abc");
	assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:9/cb");
	assert.equal(url.searchParams.get("code_challenge"), "chal");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("state"), "st");
	assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
});

test("the loopback listener returns the code", TIMEOUT, async () => {
	const redirect = await awaitRedirect("the-state");
	try {
		const res = await fetch(`${redirect.uri}?code=the-code&state=the-state`);
		assert.equal(res.status, 200);
		await res.text();
		assert.equal(await redirect.code, "the-code");
		// The address the OS reports, not the string we built: those
		// agreeing is the point, and asserting our own template would
		// pass however the socket was actually bound.
		assert.equal(redirect.boundHost, "127.0.0.1", `bound to ${redirect.boundHost}`);
		assert.equal(new URL(redirect.uri).hostname, redirect.boundHost);
	} finally {
		redirect.close();
	}
});

// A redirect that does not carry our state is not ours, and exchanging
// its code would mean exchanging one this flow never asked for.
test("a redirect with the wrong state is not accepted", TIMEOUT, async () => {
	const redirect = await awaitRedirect("the-state");
	try {
		const res = await fetch(`${redirect.uri}?code=someone-elses&state=wrong`);
		assert.equal(res.status, 400);
		await res.text();

		const settled = await Promise.race([
			redirect.code.then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("still waiting"), 150)),
		]);
		assert.equal(settled, "still waiting", "the flow accepted a code it did not ask for");
	} finally {
		redirect.close();
	}
});

test("an error redirect fails the flow with the server's reason", TIMEOUT, async () => {
	const redirect = await awaitRedirect("st");
	try {
		// The assertion is armed BEFORE the request that triggers the
		// rejection, because the rejection happens during it.
		const rejected = assert.rejects(redirect.code, /access_denied/);
		const res = await fetch(`${redirect.uri}?error=access_denied&error_description=nope&state=st`);
		await res.text();
		await rejected;
	} finally {
		redirect.close();
	}
});

test("the token request authenticates with the client secret", async () => {
	const seen: { req?: RequestInit | undefined } = {};
	await exchangeCode(
		DISCOVERY,
		{ clientId: "id with spaces", clientSecret: "secret:with:colons" },
		"code",
		"verifier",
		"http://127.0.0.1:9/cb",
		jsonFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }, seen)
	);

	const auth = String((seen.req?.headers as Record<string, string>).Authorization);
	assert.ok(auth.startsWith("Basic "), `expected client_secret_basic, got ${auth}`);
	// Both halves are form-encoded before base64 (RFC 6749 s2.3.1), or a
	// secret containing a colon breaks the split at the far end.
	const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString();
	assert.equal(decoded, "id%20with%20spaces:secret%3Awith%3Acolons");

	// The client id does not also go in the body when it is in the header.
	assert.equal(new URLSearchParams(String(seen.req?.body)).get("client_id"), null);
});

test("a public client with no secret sends its id in the body", async () => {
	const seen: { req?: RequestInit | undefined } = {};
	await exchangeCode(
		DISCOVERY,
		{ clientId: "public" },
		"code",
		"verifier",
		"http://127.0.0.1:9/cb",
		jsonFetch(200, { access_token: "at" }, seen)
	);
	assert.equal((seen.req?.headers as Record<string, string>).Authorization, undefined);
	assert.equal(new URLSearchParams(String(seen.req?.body)).get("client_id"), "public");
});

// expires_in is a duration and useless once stored; what a later session
// needs to know is whether the token is still good.
test("the expiry is stored as an absolute time", async () => {
	const before = Date.now();
	const tokens = await exchangeCode(
		DISCOVERY,
		{ clientId: "c" },
		"code",
		"v",
		"http://127.0.0.1:9/cb",
		jsonFetch(200, { access_token: "at", expires_in: 600 })
	);
	const at = tokens.expiresAt?.getTime() ?? 0;
	assert.ok(at >= before + 600_000 && at <= Date.now() + 600_000, `expiresAt is ${tokens.expiresAt}`);
});

// invalid_grant is what a user meets when a refresh token expires, and
// the raw code tells them nothing about what to do.
test("an expired refresh token says to sign in again", async () => {
	await assert.rejects(
		refreshTokens(DISCOVERY, { clientId: "c" }, "stale", jsonFetch(400, { error: "invalid_grant" })),
		/Signing in again will fix it/
	);
});

// error_description is where the server says WHICH scope, or which
// part of the grant it objected to. Reporting only the code throws away
// the one sentence that identifies the problem, and leaves
// "invalid_scope" meaning nothing at all.
test("the server's own explanation is not thrown away", async () => {
	await assert.rejects(
		refreshTokens(
			DISCOVERY,
			{ clientId: "c" },
			"rt",
			jsonFetch(400, {
				error: "invalid_scope",
				error_description:
					"The OAuth 2.0 Client was not granted scope offline and may thus not perform the 'refresh_token' authorization grant.",
			})
		),
		/was not granted scope offline/
	);
});

test("an unrecognised error still reports both halves", async () => {
	await assert.rejects(
		refreshTokens(
			DISCOVERY,
			{ clientId: "c" },
			"rt",
			jsonFetch(400, { error: "unsupported_grant_type", error_description: "nope" })
		),
		/unsupported_grant_type — nope/
	);
});

test("a hint is used when there is no description", async () => {
	await assert.rejects(
		refreshTokens(DISCOVERY, { clientId: "c" }, "rt", jsonFetch(400, { error: "invalid_scope", hint: "a hint" })),
		/a hint/
	);
});

test("the callback page is self-contained", () => {
	const page = callbackPage("Signed in", "You can close this tab.", "ok");
	// Served from a loopback port that closes seconds later, so it
	// cannot reference a stylesheet -- and should not fetch a font
	// either, which would leak the visit.
	assert.doesNotMatch(page, /<link\b/i);
	assert.doesNotMatch(page, /https?:\/\//);
	assert.doesNotMatch(page, /<script\b/i);
	// The house style the access point's own pages use.
	assert.match(page, /#667eea/);
	assert.match(page, /Signed in/);
});

test("the callback page escapes what it renders", () => {
	const page = callbackPage("<script>alert(1)</script>", 'a "quoted" & <tagged> message', "error");
	assert.doesNotMatch(page, /<script>alert/);
	assert.match(page, /&lt;script&gt;/);
	assert.match(page, /&quot;quoted&quot;/);
	assert.match(page, /&amp;/);
});

test("success and failure look different", () => {
	const ok = callbackPage("Signed in", "done", "ok");
	const bad = callbackPage("Sign-in failed", "nope", "error");
	assert.notEqual(ok, bad);
	// Colour alone is not the only difference, for anyone who cannot
	// see it.
	assert.match(ok, /Signed in/);
	assert.match(bad, /Sign-in failed/);
});

// The server's error_description is a sentence and ends with a full
// stop of its own. Appending ours produced "...malformed.. Signing out",
// which reads like a typo in the middle of an explanation the reader is
// already struggling with.
test("the server's sentence and ours do not collide", async () => {
	await assert.rejects(
		refreshTokens(
			DISCOVERY,
			{ clientId: "c" },
			"rt",
			jsonFetch(400, {
				error: "invalid_scope",
				error_description: "The OAuth 2.0 Client is not allowed to request scope 'openid'.",
			})
		),
		(err: Error) => {
			assert.doesNotMatch(err.message, /\.\./, `doubled full stop: ${err.message}`);
			assert.match(err.message, /scope 'openid'/);
			assert.match(err.message, /Signing out and in again/);
			return true;
		}
	);
});

test("a description without punctuation still gets a full stop", async () => {
	await assert.rejects(
		refreshTokens(DISCOVERY, { clientId: "c" }, "rt", jsonFetch(400, { error: "invalid_scope", error_description: "no trailing stop" })),
		/no trailing stop\. Signing out/
	);
});

// openid is requested because the access point grants it whether or not
// it was asked for, and a grant may not exceed what the client
// registered. Leaving it out produced a grant that worked once and then
// failed for ever.
test("openid is among the scopes requested", () => {
	assert.ok(SCOPES.includes("openid"), "the server grants openid regardless; not registering it breaks refresh");
	assert.ok(SCOPES.includes("condor:/WRITE"));
	assert.ok(SCOPES.includes("offline_access"));
});

// A registration is made for a fixed set of scopes. Reusing a stale one
// fails at the authorize step, naming a scope the user never chose.
test("a registration missing a current scope is not reused", () => {
	assert.equal(registrationIsCurrent({ clientId: "c", scopes: [...SCOPES] }), true);
	assert.equal(registrationIsCurrent({ clientId: "c", scopes: ["condor:/WRITE", "offline_access"] }), false);
	// Registered before this was recorded at all: cannot be trusted to
	// cover the current list.
	assert.equal(registrationIsCurrent({ clientId: "c" }), false);
	assert.equal(registrationIsCurrent({ clientId: "c", scopes: [] }), false);
});

// VS Code asks for matching sessions before deciding whether to
// prompt. A session handed back is one it considers usable, so it
// returns that instead of offering to sign in.
//
// The bug: a session granted under an older scope list still matched,
// so after the list changed "Sign in" did nothing visible and every
// request failed against a grant that could not serve them.
test("a session missing a requested scope does not match", () => {
	assert.equal(sessionCoversScopes(["condor:/WRITE", "offline_access"], SCOPES), false);
	assert.equal(sessionCoversScopes([...SCOPES], SCOPES), true);
	assert.equal(sessionCoversScopes([...SCOPES, "extra"], SCOPES), true, "extra scopes are not a mismatch");
});

// An empty request matches anything, which is VS Code's own rule and
// the reason passing [] at every call site hid this.
test("an empty request matches any session", () => {
	assert.equal(sessionCoversScopes(["condor:/WRITE"], []), true);
	assert.equal(sessionCoversScopes([], []), true);
});
