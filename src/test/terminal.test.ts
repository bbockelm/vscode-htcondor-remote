import { strict as assert } from "node:assert";
import * as Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";

// JobTerminal needs both `vscode` and `ws`, so it is loaded the way the
// editor loads it: with those two supplied by the loader. The bug this
// file exists for is invisible to a unit test of any smaller piece --
// it is about how many times an event fires.

interface FakeSocket {
	emit(event: string, ...args: unknown[]): void;
	sent: unknown[];
}

let latest: FakeSocket | undefined;

/** A `ws` whose socket does nothing until a test tells it to. */
function wsStub(): Record<string, unknown> {
	return {
		WebSocket: class {
			static readonly OPEN = 1;
			readyState = 0;
			readonly sent: unknown[] = [];
			private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

			constructor() {
				latest = this as unknown as FakeSocket;
			}
			on(event: string, handler: (...args: unknown[]) => void): void {
				this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
			}
			once(event: string, handler: (...args: unknown[]) => void): void {
				this.on(event, handler);
			}
			send(data: unknown): void {
				this.sent.push(data);
			}
			close(): void {}
			emit(event: string, ...args: unknown[]): void {
				for (const handler of this.handlers.get(event) ?? []) {
					handler(...args);
				}
			}
		},
	};
}

/** A `vscode` with an EventEmitter that really emits. */
function vscodeStub(): Record<string, unknown> {
	return {
		EventEmitter: class {
			private readonly listeners: ((value: unknown) => void)[] = [];
			event = (listener: (value: unknown) => void): { dispose: () => void } => {
				this.listeners.push(listener);
				return { dispose: (): void => {} };
			};
			fire = (value: unknown): void => {
				for (const listener of [...this.listeners]) {
					listener(value);
				}
			};
			dispose = (): void => {};
		},
	};
}

interface Terminal {
	onDidWrite(listener: (text: string) => void): unknown;
	onDidClose(listener: (code: number | undefined) => void): unknown;
	open(dimensions: undefined): void;
}

/** Load JobTerminal against the stubs and build one. */
function openTerminal(logged: string[] = []): {
	written: string[];
	closes: (number | undefined)[];
	socket: () => FakeSocket;
} {
	const vscode = vscodeStub();
	const ws = wsStub();
	const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
	const originalLoad = loader._load;
	loader._load = function (request: string, ...rest: unknown[]): unknown {
		if (request === "vscode") {
			return vscode;
		}
		if (request === "ws") {
			return ws;
		}
		return originalLoad.call(this, request, ...rest);
	};

	const path = join(__dirname, "..", "terminal.js");
	let module: {
		JobTerminal: new (
			base: string,
			token: () => Promise<string>,
			id: string,
			log: (message: string) => void
		) => Terminal;
	};
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		module = require(path);
	} finally {
		loader._load = originalLoad;
		delete require.cache[require.resolve(path)];
	}

	latest = undefined;
	const terminal = new module.JobTerminal("https://ap.example.edu", async () => "token", "1234.0", (m) =>
		logged.push(m)
	);
	const written: string[] = [];
	const closes: (number | undefined)[] = [];
	terminal.onDidWrite((text) => written.push(text));
	terminal.onDidClose((code) => closes.push(code));
	terminal.open(undefined);
	// A getter: the socket is built after the token is awaited, so it
	// does not exist yet when this returns.
	return {
		written,
		closes,
		socket: (): FakeSocket => {
			assert.ok(latest, "no socket was opened");
			return latest;
		},
	};
}

/** The socket is built after an await, so let the microtasks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("a failed connection leaves the terminal open with the reason in it", async () => {
	// The editor disposes a pseudoterminal as soon as onDidClose
	// fires, whatever exit code it carries. Firing it on a failure
	// therefore destroys the window the explanation is in: the
	// terminal appeared for half a second and vanished, leaving
	// whatever local shell was there before in view. Which is exactly
	// how this was reported -- twice.
	const { closes, written, socket } = openTerminal();
	await settle();

	socket().emit("error", new Error("connection refused"));
	socket().emit("close");

	assert.deepEqual(closes, [], "the terminal must stay open, or the reason cannot be read");
	assert.match(written.join(""), /connection refused/);
});

test("the reason a connection failed is written where the user can read it", async () => {
	const { written, socket } = openTerminal();
	await settle();
	socket().emit("error", new Error("connection refused"));

	assert.ok(
		written.join("").includes("connection refused"),
		`the failure should name itself, got: ${written.join("")}`
	);
});

test("the terminal says what it is connecting to before it tries", async () => {
	// Opening a shell goes through a schedd query and a Cedar
	// handshake. A terminal blank for those seconds looks like one that
	// did nothing at all -- which is how this was first reported.
	const { written } = openTerminal();

	const banner = written.join("");
	assert.match(banner, /1234\.0/, "the banner should name the job");
	assert.match(banner, /ap\.example\.edu/, "the banner should name the access point");
});

test("a shell that exits normally closes the terminal once", async () => {
	const { closes, socket } = openTerminal();
	await settle();

	socket().emit("message", Buffer.from(JSON.stringify({ type: "exit", code: 0 })), false);
	socket().emit("close");

	assert.deepEqual(closes, [0], "the exit message ends it; the socket closing afterwards is the same end");
});

test("a failure is logged as well as shown, so it survives the terminal", async () => {
	const logged: string[] = [];
	const { socket } = openTerminal(logged);
	await settle();

	socket().emit("error", new Error("the access point refused the connection (409)"));

	assert.equal(logged.length, 1);
	assert.match(logged[0], /409/);
});

test("a setup failure reported over the socket leaves the terminal open", async () => {
	// The access point upgrades the socket before it tries to reach
	// the execute node, so that a failure can be explained over the
	// socket rather than as a status nobody can read. Closing the
	// terminal on that explanation threw it away: the shell appeared
	// to connect and vanish.
	const logged: string[] = [];
	const { closes, written, socket } = openTerminal(logged);
	await settle();

	socket().emit(
		"message",
		Buffer.from(
			JSON.stringify({
				type: "error",
				reason: "could not open shell",
				message: "Failed to open a shell on the execute node: connection refused",
			})
		),
		false
	);
	socket().emit("close", 1008, Buffer.from("could not open shell"));

	assert.deepEqual(closes, [], "the terminal must stay open, or the reason cannot be read");
	assert.match(written.join(""), /connection refused/);
	assert.match(logged.join(""), /could not open shell/);
});

test("a socket that closes before any output is a failure, not an end", async () => {
	const { closes, written, socket } = openTerminal();
	await settle();

	socket().emit("close", 1006, Buffer.from(""));

	assert.deepEqual(closes, [], "nothing ran, so there is nothing to have ended");
	assert.match(written.join(""), /closed before a shell started/);
	assert.match(written.join(""), /1006/, "the close code is the only clue there is");
});

test("a shell that ran and then ended closes the terminal", async () => {
	// The ordinary case must still behave like a terminal.
	const { closes, socket } = openTerminal();
	await settle();

	socket().emit("message", Buffer.from("hello from the job\r\n"), true);
	socket().emit("close", 1000, Buffer.from(""));

	assert.deepEqual(closes, [undefined]);
});

test("a shell that exits non-zero leaves its status readable", async () => {
	const { closes, written, socket } = openTerminal();
	await settle();

	socket().emit("message", Buffer.from("output\r\n"), true);
	socket().emit("message", Buffer.from(JSON.stringify({ type: "exit", code: 42 })), false);
	socket().emit("close", 1000, Buffer.from(""));

	assert.deepEqual(closes, [], "a non-zero exit is something the user will want to read");
	assert.match(written.join(""), /status 42/);
});
