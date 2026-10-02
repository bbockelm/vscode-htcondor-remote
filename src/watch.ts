// Following the job queue, so the tree reflects it without being asked.
//
// Without this the tree only changes when something tells it to, so a
// job that starts running while you are looking at it sits there as
// Idle until you press refresh. The access point already streams the
// changes; this consumes them.

import { TokenSource } from "./api";
import { EventStreamParser } from "./sse";

/** Why a watch stopped, when it stopped for good. */
export type WatchUnavailable = "no-mirror" | "unauthorized" | "unsupported";

export interface WatchHandlers {
	/** A job changed. The tree should re-read. */
	onChange(): void;
	/**
	 * The stream cannot be had at all, and retrying will not help.
	 *
	 * The caller is expected to fall back to asking periodically. The
	 * commonest reason is an access point with no job-queue mirror
	 * configured, which answers 503 -- a deployment choice rather than
	 * a fault, so it must not read as one.
	 */
	onUnavailable(reason: WatchUnavailable, detail: string): void;
	/** A transient failure, already being retried. */
	onRetry(detail: string, delayMs: number): void;
}

/** How long to wait before reconnecting, growing to a ceiling. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class JobWatch {
	private stop: AbortController | undefined;
	private closed = false;

	constructor(
		private readonly baseUrl: string,
		private readonly token: TokenSource,
		private readonly handlers: WatchHandlers
	) {}

	/** Start following, reconnecting until close() is called. */
	start(): void {
		if (this.stop) {
			return;
		}
		void this.run();
	}

	close(): void {
		this.closed = true;
		this.stop?.abort();
		this.stop = undefined;
	}

	private async run(): Promise<void> {
		let delay = FIRST_RETRY_MS;
		// The cursor is what makes a reconnect a resume rather than a
		// restart: without it the server replays from the beginning and
		// every reconnection costs a full re-read.
		let cursor: string | undefined;

		while (!this.closed) {
			try {
				cursor = await this.stream(cursor);
				// A clean end is not an error -- the server closes an
				// idle stream -- so reconnect immediately rather than
				// backing off as though something broke.
				delay = FIRST_RETRY_MS;
			} catch (err: unknown) {
				if (this.closed) {
					return;
				}
				if (err instanceof WatchStopped) {
					this.handlers.onUnavailable(err.reason, err.message);
					return;
				}
				this.handlers.onRetry(describe(err), delay);
				await pause(delay);
				delay = Math.min(delay * 2, MAX_RETRY_MS);
			}
		}
	}

	/** One connection. Returns the last cursor seen. */
	private async stream(cursor: string | undefined): Promise<string | undefined> {
		const controller = new AbortController();
		this.stop = controller;

		const url = new URL("/api/v1/jobs/watch", this.baseUrl);
		if (cursor) {
			url.searchParams.set("cursor", cursor);
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${await this.token()}`,
				Accept: "text/event-stream",
				// No buffering in between, or events arrive in bursts
				// when a proxy decides it has enough of them.
				"Cache-Control": "no-cache",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			// 503 is an access point with no job-queue mirror. That is a
			// deployment choice, not a fault, and retrying it forever
			// would log an error every thirty seconds for ever.
			if (response.status === 503) {
				throw new WatchStopped("no-mirror", "this access point does not stream job changes");
			}
			if (response.status === 401 || response.status === 403) {
				throw new WatchStopped("unauthorized", `the access point refused the stream (${response.status})`);
			}
			if (response.status === 404) {
				throw new WatchStopped("unsupported", "this access point has no job change stream");
			}
			throw new Error(`the job stream failed (${response.status})`);
		}
		if (!response.body) {
			throw new WatchStopped("unsupported", "the job stream returned no body");
		}

		const parser = new EventStreamParser();
		const decoder = new TextDecoder();
		let latest = cursor;

		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			// stream: true, because a multi-byte character can straddle
			// a chunk boundary and decoding each chunk alone would
			// corrupt it.
			for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
				if (event.id) {
					latest = event.id;
				}
				switch (event.event) {
					case "upsert":
					case "delete":
					case "reset":
					case "resync":
						this.handlers.onChange();
						break;
					case "error":
						// The server's own error frame. Reported and
						// retried, since the connection may still be
						// fine.
						throw new Error(serverError(event.data));
					default:
						// `synced` and anything added later: a position
						// marker rather than a change.
						break;
				}
			}
		}
		return latest;
	}
}

/** A failure that will not improve by being retried. */
class WatchStopped extends Error {
	constructor(
		readonly reason: WatchUnavailable,
		message: string
	) {
		super(message);
		this.name = "WatchStopped";
	}
}

function serverError(data: string): string {
	try {
		const parsed = JSON.parse(data) as { error?: unknown };
		if (typeof parsed.error === "string" && parsed.error !== "") {
			return parsed.error;
		}
	} catch {
		// Not JSON; the raw frame is the best there is.
	}
	return data || "the job stream reported an error";
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
