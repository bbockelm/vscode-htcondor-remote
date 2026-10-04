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
import { closeMessage, describeEnd, parseControl, resizeMessage } from "./terminalProtocol";

export class JobTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	private socket: WebSocket | undefined;
	/** Set once the socket is open, so a resize before then is not lost. */
	private pending: { cols: number; rows: number } | undefined;
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
		private readonly jobId: string
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
				this.writeEmitter.fire(data.toString());
				return;
			}
			const message = parseControl(data.toString());
			if (!message) {
				return;
			}
			if (message.type === "exit" || message.type === "error") {
				this.writeEmitter.fire(describeEnd(message));
				this.end(message.code ?? 0);
			}
		});

		socket.once("close", () => this.end(undefined));
	}

	private fail(reason: string): void {
		if (this.ended) {
			return;
		}
		this.writeEmitter.fire(`\r\n\x1b[31mCould not open a shell in ${this.jobId}: ${reason}\x1b[0m\r\n`);
		// Non-zero, so the terminal stays open with the reason in it.
		// A pseudoterminal that reports a clean exit is disposed, which
		// for a failure means closing the window the explanation is in.
		this.end(1);
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
