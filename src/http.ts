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

/**
 * The `fetch` the editor replaced, if it kept a reference.
 *
 * VS Code patches the global `fetch` in every extension host and
 * stashes the original on `globalThis.__vscodeOriginalFetch`.
 */
export function unpatchedFetch(
	global: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): typeof fetch | undefined {
	const original = global.__vscodeOriginalFetch;
	if (typeof original !== "function" || original === global.fetch) {
		return undefined;
	}
	return original as typeof fetch;
}

/**
 * Prefer `fast`, fall back to `safe` for good, once.
 *
 * The editor replaces `fetch` in every extension host to add proxy
 * support and the operating system's certificates. Measured against
 * the function it replaced -- same process, same client, same
 * connection stack -- the replacement took 17690ms for a request the
 * original answered in 448ms. That is worth going around.
 *
 * But not unconditionally: the two things the patch adds are the two
 * things a user behind a corporate proxy or a private certificate
 * authority cannot do without, and neither is visible from here until
 * a request fails. So the quick one is tried, and the first time it
 * fails at the network level the slow one takes over permanently.
 * Worst case is one wasted attempt and today's behaviour; best case,
 * which is most people, is seventeen seconds a window.
 *
 * A failed request is only retried when the method is one that can
 * safely be sent twice. A POST that failed may still have arrived,
 * and submitting somebody's job twice is worse than a slow request.
 */
export function withFallback(
	fast: typeof fetch,
	safe: typeof fetch,
	onFallback: (reason: string) => void
): typeof fetch {
	let fallenBack = false;
	return async (input, init) => {
		if (fallenBack) {
			return safe(input, init);
		}
		try {
			return await fast(input, init);
		} catch (err: unknown) {
			// Our own deadline, or a caller cancelling. Retrying would
			// double a wait somebody already decided was too long.
			if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
				throw err;
			}
			fallenBack = true;
			onFallback(err instanceof Error ? err.message : String(err));
			const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
			if (method !== "GET" && method !== "HEAD") {
				throw err;
			}
			return safe(input, init);
		}
	};
}

export interface HttpOptions {
	/** The editor's `fetch`: proxy-aware, certificate-aware, and slow here. */
	patched?: typeof fetch;
	/** The one it replaced, when the editor kept it. */
	unpatched?: typeof fetch;
	/**
	 * Whether to go around the editor at all.
	 *
	 * False when a proxy is configured: there is no point failing a
	 * request to discover what the settings already say.
	 */
	preferUnpatched?: boolean;
	onFallback?: (reason: string) => void;
}

let agent = formatUserAgent("0.0.0", "unknown", process.platform);
let configured: typeof fetch = withUserAgent(fetch, agent);

/**
 * Set the agent and choose the transport for the rest of the session.
 * Called once, from activation, before anything that might request.
 */
export function configureHttp(version: string, editorVersion: string, options: HttpOptions = {}): void {
	agent = formatUserAgent(version, editorVersion, process.platform);
	const patched = options.patched ?? fetch;
	const chosen =
		options.preferUnpatched && options.unpatched
			? withFallback(options.unpatched, patched, options.onFallback ?? ((): void => {}))
			: patched;
	configured = withUserAgent(chosen, agent);
}

/** The fetch everything should use. Read at call time, not at import. */
export function http(): typeof fetch {
	return configured;
}

/** The same string, for transports that are not fetch -- the terminal's WebSocket. */
export function userAgent(): string {
	return agent;
}
