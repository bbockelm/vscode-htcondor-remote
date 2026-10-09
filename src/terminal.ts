// A terminal inside a running job.
//
// The transport already exists: /api/v1/jobs/{id}/ssh is a WebSocket
// carrying raw stdio in binary frames, and the web UI has driven it for
// a while. This is a second front end on the same bridge, so a user who
// wants a shell in a job does not have to open a browser for it.

import * as vscode from "vscode";
import { WebSocket } from "ws";

import { TokenSource } from "./api";
import { userAgent } from "./http";
import { closeMessage, ControlMessage, describeEnd, parseControl, resizeMessage } from "./terminalProtocol";

export class JobTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	private socket: WebSocket | undefined;
	/** Set once the socket is open, so a resize before then is not lost. */
	private pending: { cols: number; rows: number } | undefined;
	/**
	 * Whether the far end has produced any output.
	 *
	 * The difference between a shell that ran and one that never
	 * started. A socket that closes before a single byte of output
	 * did not give the user a session, whatever it says on the way
	 * out, and closing the terminal on it hides why.
	 */
	private sawOutput = false;
	/**
	 * Whether the session has already ended.
	 *
	 * A failed connection raises both `error` and `close`, and firing
	 * onDidClose for each was how the error message disappeared: VS
	 * Code disposes a pseudoterminal the moment it reports a clean
	 * exit, so the close event -- which carries no code -- threw away
	 * the terminal the error event had just written the reason into.
	 * What the user saw was a terminal panel that opened onto whatever
	 * shell was there before, with no sign anything had been tried.
	 */
	private ended = false;

	constructor(
		private readonly baseUrl: string,
		private readonly token: TokenSource,
		private readonly jobId: string,
		/** So a failure is in the log as well as in the terminal. */
		private readonly log: (message: string) => void = () => {}
	) {}

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
		if (initialDimensions) {
			this.pending = { cols: initialDimensions.columns, rows: initialDimensions.rows };
		}
		// Said before the connection is attempted, not after it
		// succeeds. Opening a shell on an execute node goes through a
		// schedd query and a Cedar handshake and can take seconds, and
		// a terminal that shows nothing for that long looks like a
		// terminal that did nothing.
		this.writeEmitter.fire(`Opening a shell in job ${this.jobId} on ${hostOf(this.baseUrl)}...\r\n`);
		void this.connect();
	}

	close(): void {
		const socket = this.socket;
		this.socket = undefined;
		if (socket && socket.readyState === WebSocket.OPEN) {
			// Asked to close rather than dropped, so the far end tears
			// the shell down instead of waiting for a timeout.
			socket.send(closeMessage());
			socket.close();
		}
	}

	handleInput(data: string): void {
		// Binary, because the far end is a pty and expects bytes. A text
		// frame would be read as a control message and dropped.
		this.socket?.send(Buffer.from(data, "utf8"));
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		const size = { cols: dimensions.columns, rows: dimensions.rows };
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(resizeMessage(size.cols, size.rows));
		} else {
			// Remembered rather than dropped: the terminal is sized
			// before the socket opens, and a shell that starts at 80x24
			// when the panel is twice that wraps every line.
			this.pending = size;
		}
	}

	private async connect(): Promise<void> {
		let socket: WebSocket;
		try {
			const url = new URL(`/api/v1/jobs/${encodeURIComponent(this.jobId)}/ssh`, this.baseUrl);
			url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
			socket = new WebSocket(url.toString(), {
				headers: {
					Authorization: `Bearer ${await this.token()}`,
					"User-Agent": userAgent(),
				},
			});
		} catch (err: unknown) {
			this.fail(err instanceof Error ? err.message : String(err));
			return;
		}
		this.socket = socket;

		socket.once("unexpected-response", (_req, res) => {
			// The only place the status is visible: once a WebSocket
			// fails to open, the error event says nothing about why.
			this.fail(`the access point refused the connection (${res.statusCode})`);
		});
		socket.once("error", (err) => this.fail(err.message));

		socket.once("open", () => {
			if (this.pending) {
				socket.send(resizeMessage(this.pending.cols, this.pending.rows));
				this.pending = undefined;
			}
		});

		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				this.sawOutput = true;
				this.writeEmitter.fire(data.toString());
				return;
			}
			const message = parseControl(data.toString());
			if (!message) {
				return;
			}
			if (message.type === "error") {
				// The access point upgrades the socket before it tries
				// to reach the execute node, so that a failure can be
				// explained over the socket rather than as a status
				// nobody can read. That explanation arrives here --
				// and closing the terminal on it threw it away, which
				// is why this looked like a shell that connected and
				// vanished.
				this.failFromServer(message);
				return;
			}
			if (message.type === "exit") {
				this.writeEmitter.fire(describeEnd(message));
				// A clean exit is the user finishing; the terminal
				// closing with them is right. A non-zero one is
				// something they will want to read.
				if ((message.code ?? 0) === 0) {
					this.end(0);
				} else {
					this.ended = true;
				}
			}
		});

		socket.once("close", (code: number, reason: Buffer) => {
			if (this.ended) {
				return;
			}
			if (this.sawOutput) {
				// A shell ran and the connection ended. Ordinary.
				this.end(undefined);
				return;
			}
			const detail = reason.toString().trim();
			this.fail(
				`the connection closed before a shell started (code ${code}${detail === "" ? "" : `: ${detail}`})`
			);
		});
	}

	private fail(reason: string): void {
		if (this.ended) {
			return;
		}
		// Marked ended so the socket's own close event does not then
		// close the terminal, but onDidClose is deliberately NOT
		// fired. Firing it disposes the terminal whatever exit code it
		// carries -- that is what the editor does with a
		// pseudoterminal -- so the terminal would vanish half a second
		// after opening, taking this message with it and leaving
		// whatever local shell was there before in view. Which is
		// exactly how this was first reported.
		this.ended = true;
		this.log(`Could not open a shell in ${this.jobId}: ${reason}`);
		this.writeEmitter.fire(
			`\r\n\x1b[31mCould not open a shell in ${this.jobId}: ${reason}\x1b[0m\r\n` +
				`\r\nThis terminal is left open so the reason can be read. Close it when done.\r\n`
		);
	}

	/**
	 * Report a failure the access point described over the socket.
	 *
	 * Same handling as any other failure -- the terminal stays open --
	 * but the wording is the server's, which is the one that knows
	 * whether the job is still starting or the execute node is out of
	 * reach.
	 */
	private failFromServer(message: ControlMessage): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.log(`Could not open a shell in ${this.jobId}: ${message.reason ?? message.message ?? "no reason given"}`);
		this.writeEmitter.fire(
			describeEnd(message) + `\r\nThis terminal is left open so the reason can be read. Close it when done.\r\n`
		);
	}

	/** End the session once. Later attempts are the same end arriving twice. */
	private end(code: number | undefined): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.closeEmitter.fire(code);
	}
}

/** The access point's hostname, or the whole URL if it will not parse. */
function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
