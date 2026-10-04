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
function openTerminal(): { written: string[]; closes: (number | undefined)[]; socket: () => FakeSocket } {
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
	let module: { JobTerminal: new (base: string, token: () => Promise<string>, id: string) => Terminal };
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		module = require(path);
	} finally {
		loader._load = originalLoad;
		delete require.cache[require.resolve(path)];
	}

	latest = undefined;
	const terminal = new module.JobTerminal("https://ap.example.edu", async () => "token", "1234.0");
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

test("a failed connection closes the terminal exactly once, with a non-zero code", async () => {
	// Both events arrive when a connection fails, and firing onDidClose
	// for each was the bug: the second carried no exit code, VS Code
	// read that as a clean exit and disposed the terminal, and the
	// error message went with it. What the user saw was the terminal
	// panel showing whatever shell had been there before.
	const { closes, socket } = openTerminal();
	await settle();

	socket().emit("error", new Error("connection refused"));
	socket().emit("close");

	assert.deepEqual(closes, [1], "one close, non-zero so the terminal stays open with the reason in it");
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
