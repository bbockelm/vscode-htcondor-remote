// A loopback SSH endpoint that carries the caller's OAuth2 token.
//
// This is what lets the extension open a remote session with nothing
// configured and nothing on disk. `ssh` connects to 127.0.0.1 here;
// each connection is forwarded to the API server's
// /api/v1/ssh/relay over TLS with a bearer token attached, and the
// gateway on the far side knows who the caller is before the SSH
// handshake begins. No key, no certificate, no device-code prompt in a
// log nobody reads.
//
// It is NOT an SSH server. It never looks at the bytes, holds no host
// key and terminates nothing. The gateway is still the SSH endpoint and
// still presents its own host certificate, so `ssh` verifies the real
// server through this hop exactly as it would without it. An earlier
// design had the extension implement SSH itself; this deliberately does
// not.

import { createServer, Server, Socket } from "node:net";
import { AddressInfo } from "node:net";
import { createWebSocketStream, WebSocket } from "ws";

import { TokenSource } from "./api";

/** Somewhere to report trouble a user might need to see. */
export interface RelayLog {
	info(message: string): void;
	error(message: string): void;
}

const silent: RelayLog = { info: () => {}, error: () => {} };

export class Relay {
	private server: Server | undefined;
	private readonly open = new Set<Socket>();

	constructor(
		private readonly baseUrl: string,
		private readonly token: TokenSource,
		private readonly log: RelayLog = silent
	) {}

	/**
	 * Listen on loopback and return the port.
	 *
	 * Loopback only, and an ephemeral port: this accepts connections
	 * with no authentication of its own, because the thing it forwards
	 * them to supplies the credential. Binding it anywhere reachable
	 * would hand the caller's token to whoever connected.
	 */
	async listen(): Promise<number> {
		if (this.server) {
			return (this.server.address() as AddressInfo).port;
		}
		const server = createServer((socket) => void this.forward(socket));
		this.server = server;

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		const { port } = server.address() as AddressInfo;
		this.log.info(`SSH relay listening on 127.0.0.1:${port}`);
		return port;
	}

	/** Stop listening and drop every connection still open. */
	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const socket of this.open) {
			socket.destroy();
		}
		this.open.clear();
		if (!server) {
			return;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async forward(socket: Socket): Promise<void> {
		this.open.add(socket);
		socket.on("close", () => this.open.delete(socket));
		// Nagle would add latency to every keystroke in an interactive
		// session, for no benefit on a loopback hop.
		socket.setNoDelay(true);

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.relayUrl(), {
				headers: { Authorization: `Bearer ${await this.token()}` },
			});
		} catch (err) {
			// A token that cannot be obtained at all: nothing to forward
			// to, so drop the connection rather than leave ssh waiting.
			this.log.error(`Could not start an SSH relay connection: ${describe(err)}`);
			socket.destroy();
			return;
		}

		ws.once("unexpected-response", (_req, res) => {
			// The status is the useful part and it is only visible here:
			// once a WebSocket fails to open, the error event says
			// nothing about why. A 401 means the session expired, a 403
			// that the token is too narrowly scoped, a 503 that this
			// access point runs no gateway.
			this.log.error(
				`The access point refused the SSH relay: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()
			);
			socket.destroy();
		});

		ws.once("error", (err) => {
			this.log.error(`SSH relay connection failed: ${describe(err)}`);
			socket.destroy();
		});

		// The catch-all, and the reason the two handlers above are not
		// enough on their own: whichever of them fires for a given
		// failure -- and `ws` picks between them by whether a listener
		// happens to be attached -- the socket ends up here. Without
		// it, a refusal that took an unexpected path would leave `ssh`
		// waiting on a connection that will never carry anything, which
		// the user experiences as a hang with no message at all.
		ws.once("close", () => socket.destroy());

		ws.once("open", () => {
			const stream = createWebSocketStream(ws, { decodeStrings: false });
			stream.on("error", () => socket.destroy());
			// Piped rather than hand-copied, so a slow reader on either
			// side applies backpressure to the other instead of the
			// bytes piling up in this process.
			socket.pipe(stream);
			stream.pipe(socket);
		});
	}

	/** The relay endpoint, as a ws:// or wss:// URL. */
	private relayUrl(): string {
		const url = new URL("/api/v1/ssh/relay", this.baseUrl);
		url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
		return url.toString();
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
