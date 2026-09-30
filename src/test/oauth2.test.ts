import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
	authorizationUrl,
	awaitRedirect,
	Discovery,
	discover,
	exchangeCode,
	pkce,
	refreshTokens,
	register,
	SCOPES,
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
