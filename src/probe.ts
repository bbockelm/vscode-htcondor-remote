// Timing the same request two ways, to find out whose 25 seconds it is.
//
// The first request a window makes has been seen to take 25 seconds
// and then succeed with a 200, while the same request from a shell on
// the same machine answers in under a second. That leaves two
// candidates with two different owners: the access point really is
// slow for that one request, or the time is spent in the editor before
// the request is sent at all. The editor does not use Node's HTTP
// stack as it comes -- with `http.proxySupport` on it substitutes its
// own agent and its own view of the system certificates -- and that is
// the one layer a shell does not have.
//
// So: ask once through whatever `fetch` the extension host gives us,
// and once over a socket this module opens itself, which nothing has
// patched. Whichever is slow names the owner.

import { connect, TLSSocket } from "node:tls";
import { URL } from "node:url";

export interface Timings {
	/** Until the TCP connection is up. */
	tcpMs?: number;
	/** Until the TLS handshake is done. */
	tlsMs?: number;
	/** Until the first byte of the response. */
	totalMs: number;
	status?: number;
	error?: string;
}

/** The first line of an HTTP response, or undefined if it is not one. */
export function parseStatusLine(line: string): number | undefined {
	const match = /^HTTP\/1\.[01] (\d{3})/.exec(line);
	return match ? Number(match[1]) : undefined;
}

/** A minimal HTTP/1.1 GET, as bytes. */
export function requestBytes(url: URL, userAgent: string, extra: Readonly<Record<string, string>> = {}): string {
	// `Connection: close` so the far end ends the response for us and
	// there is no need to understand chunked encoding or keep-alive.
	const headers = [
		`Host: ${url.host}`,
		`User-Agent: ${userAgent}`,
		`Accept: application/json`,
		...Object.entries(extra).map(([name, value]) => `${name}: ${value}`),
		`Connection: close`,
	];
	return `GET ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`;
}

/**
 * Fetch a URL over a socket this process opens, bypassing anything the
 * editor has put in front of Node's HTTP stack.
 *
 * `extra` carries the headers that make the probe the same request as
 * the one being compared against. Asking for a different, simpler URL
 * proved less than it looked: a quick answer to an unauthenticated
 * well-known document says nothing about an authenticated query,
 * which is the request that was slow.
 */
export async function directGet(
	target: string,
	userAgent: string,
	timeoutMs: number,
	extra: Readonly<Record<string, string>> = {}
): Promise<Timings> {
	const url = new URL(target);
	const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
	const started = Date.now();
	const since = (): number => Date.now() - started;

	return new Promise<Timings>((resolve) => {
		const result: Timings = { totalMs: 0 };
		let settled = false;
		const finish = (extra: Partial<Timings>): void => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			resolve({ ...result, ...extra, totalMs: since() });
		};

		const socket: TLSSocket = connect({ host: url.hostname, port, servername: url.hostname }, () => {
			result.tlsMs = since();
			socket.write(requestBytes(url, userAgent, extra));
		});
		socket.setTimeout(timeoutMs, () => finish({ error: `no answer within ${timeoutMs / 1000}s` }));
		socket.once("connect", () => {
			result.tcpMs = since();
		});
		socket.once("data", (chunk: Buffer) => {
			const status = parseStatusLine(chunk.toString("latin1").split("\r\n")[0] ?? "");
			finish(status === undefined ? { error: "the answer was not HTTP" } : { status });
		});
		socket.once("error", (err: Error) => finish({ error: err.message }));
		socket.once("close", () => finish({ error: "the connection closed with no answer" }));
	});
}

/**
 * The `fetch` the editor replaced, if it kept a reference.
 *
 * VS Code patches the global `fetch` in the extension host and stashes
 * the original on `globalThis.__vscodeOriginalFetch`. The two differ
 * only by that patch -- same process, same undici, same connection
 * stack -- so timing both is the cleanest control there is for
 * deciding whether the patch is what costs the time.
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

/** Time the same URL through the fetch the extension host gave us. */
export async function fetchGet(
	target: string,
	impl: typeof fetch,
	timeoutMs: number,
	extra: Readonly<Record<string, string>> = {}
): Promise<Timings> {
	const started = Date.now();
	try {
		const response = await impl(target, { signal: AbortSignal.timeout(timeoutMs), headers: { ...extra } });
		// Read the body: with an HTTP/1.1 connection the status line can
		// arrive well before the stack is finished, and the number being
		// compared has to mean the same thing in both probes.
		await response.text();
		return { totalMs: Date.now() - started, status: response.status };
	} catch (err: unknown) {
		return { totalMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * What the two timings mean together.
 *
 * The point of the probe: the comparison is the diagnosis, and leaving
 * the reader to make it is leaving the bug unexplained.
 */
export function compare(direct: Timings, viaFetch: Timings, proxySupport: string): string {
	const slowFetch = viaFetch.totalMs >= 5_000;
	const slowDirect = direct.totalMs >= 5_000;

	if (slowFetch && !slowDirect) {
		return (
			`The access point answered a socket this extension opened in ${direct.totalMs}ms, and the same ` +
			`request through the editor's HTTP stack took ${viaFetch.totalMs}ms. The time is not being spent ` +
			`at the access point. ` +
			(proxySupport === "override"
				? "`http.proxySupport` is `override`, which is what substitutes that stack; setting it to " +
					"`off` and reloading would confirm it."
				: `\`http.proxySupport\` is \`${proxySupport}\`, so something else in the editor's networking is responsible.`)
		);
	}
	if (slowFetch && slowDirect) {
		return (
			`Both probes were slow (${direct.totalMs}ms direct, ${viaFetch.totalMs}ms through the editor), so ` +
			`the time is being spent reaching or inside the access point rather than in the editor. ` +
			`Connecting took ${direct.tcpMs ?? "?"}ms and the TLS handshake ${direct.tlsMs ?? "?"}ms, so ` +
			(typeof direct.tlsMs === "number" && direct.tlsMs >= 5_000
				? "it is the connection, not the server's answer."
				: "it is the server's answer, not the connection.")
		);
	}
	if (!slowFetch && slowDirect) {
		return (
			`Only the direct probe was slow (${direct.totalMs}ms against ${viaFetch.totalMs}ms through the ` +
			`editor), which is the opposite of the problem being looked for: the editor's stack is the fast ` +
			`one here, probably because it is reusing a connection.`
		);
	}
	return `Both probes were quick: ${direct.totalMs}ms direct, ${viaFetch.totalMs}ms through the editor's HTTP stack.`;
}

/** One line per probe, for the log. */
export function describeTimings(label: string, t: Timings): string {
	const parts = [`${label}: ${t.totalMs}ms`];
	if (t.tcpMs !== undefined) {
		parts.push(`connect ${t.tcpMs}ms`);
	}
	if (t.tlsMs !== undefined) {
		parts.push(`TLS ${t.tlsMs}ms`);
	}
	if (t.status !== undefined) {
		parts.push(`HTTP ${t.status}`);
	}
	if (t.error !== undefined) {
		parts.push(t.error);
	}
	return parts.join(", ");
}
