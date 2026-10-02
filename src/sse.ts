// Parsing a text/event-stream.
//
// Written out rather than using EventSource, because EventSource cannot
// send an Authorization header and this stream needs one. The format is
// small (W3C server-sent events) and the parsing is the part worth
// testing, so it lives here with no transport attached.

export interface ServerSentEvent {
	/** The `event:` name, or "message" when the stream omits one. */
	event: string;
	/** The `data:` lines, joined with newlines as the spec requires. */
	data: string;
	/** The `id:` field, which is this stream's resume cursor. */
	id?: string;
}

/**
 * Feed bytes in, get whole events out.
 *
 * Chunk boundaries fall wherever TCP puts them, so a frame routinely
 * arrives in pieces and two frames routinely arrive together. The
 * parser holds the remainder rather than assuming either.
 */
export class EventStreamParser {
	private buffer = "";

	/** Parse whatever is complete in this chunk. */
	push(chunk: string): ServerSentEvent[] {
		this.buffer += chunk;
		const events: ServerSentEvent[] = [];

		// Frames are separated by a blank line. \r\n is permitted by the
		// spec and does turn up behind proxies that rewrite line endings.
		let at: number;
		while ((at = this.findSeparator()) !== -1) {
			const [frame, width] = [this.buffer.slice(0, at), this.separatorWidth(at)];
			this.buffer = this.buffer.slice(at + width);
			const parsed = parseFrame(frame);
			if (parsed) {
				events.push(parsed);
			}
		}
		return events;
	}

	private findSeparator(): number {
		const candidates = [this.buffer.indexOf("\n\n"), this.buffer.indexOf("\r\n\r\n")].filter((i) => i !== -1);
		return candidates.length === 0 ? -1 : Math.min(...candidates);
	}

	private separatorWidth(at: number): number {
		return this.buffer.startsWith("\r\n\r\n", at) ? 4 : 2;
	}
}

/** Parse one frame. Returns undefined for a frame carrying no data. */
export function parseFrame(frame: string): ServerSentEvent | undefined {
	let event = "message";
	let id: string | undefined;
	const data: string[] = [];

	for (const rawLine of frame.split(/\r?\n/)) {
		// A line starting with a colon is a comment, which is how a
		// server keeps an idle connection alive. Ignoring it is the
		// whole handling it needs.
		if (rawLine === "" || rawLine.startsWith(":")) {
			continue;
		}
		const colon = rawLine.indexOf(":");
		const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
		// One optional space after the colon is part of the format, not
		// part of the value.
		let value = colon === -1 ? "" : rawLine.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}

		switch (field) {
			case "event":
				event = value;
				break;
			case "data":
				data.push(value);
				break;
			case "id":
				id = value;
				break;
			default:
				// `retry` and anything the server grows later.
				break;
		}
	}

	if (data.length === 0) {
		// A comment-only or id-only frame is not an event. Returning one
		// would hand the caller an empty payload to parse.
		return undefined;
	}
	return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}
