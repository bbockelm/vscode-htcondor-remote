import { strict as assert } from "node:assert";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { JobWatch, WatchUnavailable } from "../watch";

const TIMEOUT = { timeout: 5_000 };
const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((fn) => fn()));

/** A stand-in for /api/v1/jobs/watch. */
function watchServer(handler: (req: { cursor: string | null; auth: string | undefined }, res: Res) => void) {
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		handler(
			{ cursor: url.searchParams.get("cursor"), auth: req.headers.authorization },
			{
				status: (code: number) => {
					res.writeHead(code);
					res.end();
				},
				stream: (frames: string) => {
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.write(frames);
				},
				end: () => res.end(),
			}
		);
	});
	server.listen(0, "127.0.0.1");
	cleanups.push(() => {
		server.closeAllConnections?.();
		server.close();
	});
	return new Promise<string>((resolve) =>
		server.on("listening", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
	);
}

interface Res {
	status(code: number): void;
	stream(frames: string): void;
	end(): void;
}

test("a change event reaches the caller", TIMEOUT, async () => {
	const base = await watchServer((_req, res) => {
		res.stream('event: upsert\ndata: {"key":"12.0"}\n\n');
	});

	const changed = new Promise<void>((resolve) => {
		const watch = new JobWatch(base, async () => "t", {
			onChange: () => {
				watch.close();
				resolve();
			},
			onUnavailable: () => {},
			onRetry: () => {},
		});
		watch.start();
	});
	await changed;
});

// An access point with no job-queue mirror answers 503. That is a
// deployment choice, not a fault: retrying it forever would log an
// error every thirty seconds for the life of the window.
test("no mirror stops the watch instead of retrying forever", TIMEOUT, async () => {
	let attempts = 0;
	const base = await watchServer((_req, res) => {
		attempts++;
		res.status(503);
	});

	const reason = await new Promise<WatchUnavailable>((resolve) => {
		const watch = new JobWatch(base, async () => "t", {
			onChange: () => {},
			onUnavailable: (r) => {
				watch.close();
				resolve(r);
			},
			onRetry: () => {},
		});
		watch.start();
	});
	assert.equal(reason, "no-mirror");
	assert.equal(attempts, 1, "it retried a refusal that will never change");
});

test("a refused stream is reported as such, not retried", TIMEOUT, async () => {
	const base = await watchServer((_req, res) => res.status(401));
	const reason = await new Promise<WatchUnavailable>((resolve) => {
		const watch = new JobWatch(base, async () => "t", {
			onChange: () => {},
			onUnavailable: (r) => {
				watch.close();
				resolve(r);
			},
			onRetry: () => {},
		});
		watch.start();
	});
	assert.equal(reason, "unauthorized");
});

// The cursor is what makes a reconnect a resume. Without it the server
// replays from the beginning, so every reconnection costs a full
// re-read of the queue.
test("a reconnect resumes from the last cursor", TIMEOUT, async () => {
	const cursors: Array<string | null> = [];
	const base = await watchServer((req, res) => {
		cursors.push(req.cursor);
		if (cursors.length === 1) {
			// One event carrying a cursor, then drop the connection.
			res.stream('id: Y3Vyc29yLTE=\nevent: upsert\ndata: {}\n\n');
			setTimeout(() => res.end(), 10);
			return;
		}
		res.stream("event: synced\ndata: {}\n\n");
	});

	await new Promise<void>((resolve) => {
		const watch = new JobWatch(base, async () => "t", {
			onChange: () => {},
			onUnavailable: () => {},
			onRetry: () => {},
		});
		watch.start();
		const check = setInterval(() => {
			if (cursors.length >= 2) {
				clearInterval(check);
				watch.close();
				resolve();
			}
		}, 20);
	});

	assert.equal(cursors[0], null, "the first connection should not send a cursor");
	assert.equal(cursors[1], "Y3Vyc29yLTE=", "the reconnect did not resume");
});

test("the caller's token is sent", TIMEOUT, async () => {
	let auth: string | undefined;
	const base = await watchServer((req, res) => {
		auth = req.auth;
		res.stream('event: upsert\ndata: {}\n\n');
	});

	await new Promise<void>((resolve) => {
		const watch = new JobWatch(base, async () => "a-token", {
			onChange: () => {
				watch.close();
				resolve();
			},
			onUnavailable: () => {},
			onRetry: () => {},
		});
		watch.start();
	});
	assert.equal(auth, "Bearer a-token");
});

// `synced` is a position marker, not a change. Treating it as one makes
// the tree re-read the whole queue every time the stream catches up.
test("a synced marker is not a change", TIMEOUT, async () => {
	let changes = 0;
	const base = await watchServer((_req, res) => {
		res.stream("event: synced\ndata: {}\n\nevent: upsert\ndata: {}\n\n");
	});

	await new Promise<void>((resolve) => {
		const watch = new JobWatch(base, async () => "t", {
			onChange: () => {
				changes++;
				watch.close();
				resolve();
			},
			onUnavailable: () => {},
			onRetry: () => {},
		});
		watch.start();
	});
	assert.equal(changes, 1, "synced was counted as a change");
});
