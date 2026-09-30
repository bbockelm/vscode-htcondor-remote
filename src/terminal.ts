// A terminal inside a running job.
//
// The transport already exists: /api/v1/jobs/{id}/ssh is a WebSocket
// carrying raw stdio in binary frames, and the web UI has driven it for
// a while. This is a second front end on the same bridge, so a user who
// wants a shell in a job does not have to open a browser for it.

import * as vscode from "vscode";
import { WebSocket } from "ws";

import { TokenSource } from "./api";
import { closeMessage, describeEnd, parseControl, resizeMessage } from "./terminalProtocol";

export class JobTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	private socket: WebSocket | undefined;
	/** Set once the socket is open, so a resize before then is not lost. */
	private pending: { cols: number; rows: number } | undefined;

	constructor(
		private readonly baseUrl: string,
		private readonly token: TokenSource,
		private readonly jobId: string
	) {}

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
		if (initialDimensions) {
			this.pending = { cols: initialDimensions.columns, rows: initialDimensions.rows };
		}
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
				headers: { Authorization: `Bearer ${await this.token()}` },
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
				this.closeEmitter.fire(message.code ?? 0);
			}
		});

		socket.once("close", () => this.closeEmitter.fire());
	}

	private fail(reason: string): void {
		this.writeEmitter.fire(`\r\n\x1b[31mCould not open a shell in ${this.jobId}: ${reason}\x1b[0m\r\n`);
		this.closeEmitter.fire(1);
	}
}
