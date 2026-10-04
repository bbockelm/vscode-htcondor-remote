// What this extension looks like on the wire.
//
// Node's fetch sends `User-Agent: node`, which in an access point's
// log is indistinguishable from any other script anyone happens to be
// running. An operator reading that log should be able to tell that a
// request came from this extension, and which version of it, without
// asking the person at the keyboard.
//
// No `vscode` import: the formatting is the part worth testing, and a
// test for it should not need an editor.

/**
 * The product token, built from the pieces the editor can tell us.
 *
 * RFC 9110 shape: `product/version (comment)`. The comment carries the
 * editor and platform, because the three together are what makes a bug
 * report reproducible -- the same extension behaves differently under
 * VS Code 1.90 and 1.105, and differently again on Windows.
 */
export function formatUserAgent(version: string, editorVersion: string, platform: string): string {
	return `vscode-htcondor-remote/${version} (VS Code ${editorVersion}; ${platform})`;
}

/**
 * Wrap a fetch so every request through it carries `agent`.
 *
 * A wrapper rather than a header added at each call site: there are
 * five of them -- the REST client, OAuth discovery, registration, the
 * token endpoint and the change stream -- and the one that gets
 * forgotten is the one an operator ends up asking about.
 */
export function withUserAgent(impl: typeof fetch, agent: string): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("User-Agent", agent);
		return impl(input, { ...init, headers });
	};
}

let agent = formatUserAgent("0.0.0", "unknown", process.platform);
let configured: typeof fetch = withUserAgent(fetch, agent);

/**
 * Set the agent for the rest of the session. Called once, from
 * activation, before anything that might make a request.
 */
export function configureHttp(version: string, editorVersion: string, impl: typeof fetch = fetch): void {
	agent = formatUserAgent(version, editorVersion, process.platform);
	configured = withUserAgent(impl, agent);
}

/** The fetch everything should use. Read at call time, not at import. */
export function http(): typeof fetch {
	return configured;
}

/** The same string, for transports that are not fetch -- the terminal's WebSocket. */
export function userAgent(): string {
	return agent;
}
