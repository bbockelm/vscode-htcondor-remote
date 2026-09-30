// The control protocol of the job terminal bridge.
//
// The server side is handleJobSSH: binary frames carry raw stdio in
// both directions, and text frames carry small JSON control messages.
// Kept apart from the VS Code pseudoterminal so the encoding can be
// tested — it is the half where a mistake is silent, because a control
// message the server does not understand is simply ignored.

/** Server → client, and the one client → server type worth naming. */
export interface ControlMessage {
	type: string;
	cols?: number;
	rows?: number;
	name?: string;
	code?: number;
	reason?: string;
	message?: string;
}

/** A resize, as the server expects it. */
export function resizeMessage(cols: number, rows: number): string {
	// Rounded and floored at 1: VS Code reports a fractional size while
	// a panel is being dragged, and a zero or negative dimension makes
	// TIOCSWINSZ meaningless -- the far end renders into a terminal of
	// no width and the output looks corrupt.
	return JSON.stringify({
		type: "resize",
		cols: Math.max(1, Math.floor(cols)),
		rows: Math.max(1, Math.floor(rows)),
	});
}

/** A signal, by POSIX name without the SIG prefix. */
export function signalMessage(name: string): string {
	return JSON.stringify({ type: "signal", name });
}

export function closeMessage(): string {
	return JSON.stringify({ type: "close" });
}

/**
 * Read a control frame.
 *
 * Returns undefined for anything unparseable rather than throwing: this
 * runs on every text frame, and a server that grows a new message type
 * should not take the terminal down with it.
 */
export function parseControl(data: string): ControlMessage | undefined {
	try {
		const parsed = JSON.parse(data) as unknown;
		if (typeof parsed === "object" && parsed !== null && typeof (parsed as ControlMessage).type === "string") {
			return parsed as ControlMessage;
		}
	} catch {
		// Not JSON. Nothing useful to do with it.
	}
	return undefined;
}

/**
 * What to print when the session ends.
 *
 * The server sends `exit` on a normal end and `error` when setup
 * failed, and the distinction matters to the user: one means their
 * command finished, the other that it never started.
 */
export function describeEnd(message: ControlMessage): string {
	if (message.type === "error") {
		const detail = message.message ?? message.reason ?? "the session could not be opened";
		return `\r\n\x1b[31m${detail}\x1b[0m\r\n`;
	}
	if (message.code === undefined || message.code === 0) {
		return "\r\n[session ended]\r\n";
	}
	return `\r\n[session ended with status ${message.code}]\r\n`;
}
