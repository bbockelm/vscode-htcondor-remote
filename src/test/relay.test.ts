import { strict as assert } from "node:assert";
import { createServer, Server as HttpServer } from "node:http";
import { AddressInfo, connect, Socket } from "node:net";
import { after, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { Relay, RelayLog } from "../relay";

/** Collects what the relay wanted the user to know. */
function recordingLog(): RelayLog & { messages: string[] } {
	const messages: string[] = [];
	return {
		messages,
		info: (m) => messages.push(m),
		error: (m) => messages.push(m),
	};
}

interface FakeServer {
	baseUrl: string;
	/** Authorization headers seen, in arrival order. */
	authHeaders: string[];
	/** The server end of the most recent accepted connection. */
	accepted: Promise<WebSocket>;
	close(): Promise<void>;
}

/** A stand-in for /api/v1/ssh/relay. `status` refuses the upgrade. */
function fakeRelayServer(status?: number): Promise<FakeServer> {
	const authHeaders: string[] = [];
	let resolveAccepted: (ws: WebSocket) => void;
	const accepted = new Promise<WebSocket>((r) => (resolveAccepted = r));

	const http: HttpServer = createServer((_req, res) => {
		res.writeHead(404).end();
	});
	const wss = new WebSocketServer({ noServer: true });

	http.on("upgrade", (req, socket, head) => {
		authHeaders.push(req.headers.authorization ?? "");
		if (status) {
			socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => resolveAccepted(ws));
	});

	return new Promise((resolve) => {
		http.listen(0, "127.0.0.1", () => {
			const { port } = http.address() as AddressInfo;
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				authHeaders,
				accepted,
				close: () =>
					new Promise<void>((done) => {
						wss.close();
						// closeAllConnections, or close() waits for every
						// socket the relay still holds and the callback
						// never fires. A hook has no timeout, so that
						// hangs the whole run rather than failing it --
						// which is how a deliberately broken relay wedged
						// this suite instead of turning it red.
						http.closeAllConnections();
						http.close(() => done());
					}),
			});
		});
	});
}

function dial(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => resolve(socket));
		socket.once("error", reject);
	});
}

// Every test below waits on a socket event, so every one carries a
// timeout. Without it a relay that forwards nothing does not fail --
// it hangs, and a hung suite in CI reads as an infrastructure problem
// rather than the broken data path it is. Found the hard way: a
// deliberately one-directional relay wedged the run instead of turning
// it red.
// 3 seconds. These tests move bytes over loopback and finish in
// milliseconds, so the only thing a long timeout buys is a slow red
// build: a broken relay makes every one of them wait out the clock.
const TIMEOUT = { timeout: 3_000 };

const cleanups: Array<() => Promise<void>> = [];
// The hook gets a timeout of its own. Without one a cleanup that never
// settles does not fail the run -- it hangs it, long after every test
// has already passed or failed, so a suite that has finished its work
// looks like a suite that is stuck.
after(
	async () => {
		for (const fn of cleanups) {
			await fn();
		}
	},
	{ timeout: 5_000 }
);

test("bytes cross in both directions", TIMEOUT, async () => {
	const server = await fakeRelayServer();
	const relay = new Relay(server.baseUrl, async () => "token");
	cleanups.push(() => relay.close(), () => server.close());

	const port = await relay.listen();
	const socket = await dial(port);
	const ws = await server.accepted;

	// Client to server. The first thing a real client sends is its SSH
	// version string, so a stand-in for it will do.
	const fromClient = new Promise<Buffer>((resolve) =>
		ws.once("message", (data) => resolve(data as Buffer))
	);
	socket.write("SSH-2.0-TestClient\r\n");
	assert.equal((await fromClient).toString(), "SSH-2.0-TestClient\r\n");

	// Server to client.
	const fromServer = new Promise<Buffer>((resolve) => socket.once("data", resolve));
	ws.send(Buffer.from("SSH-2.0-HTCondorGateway\r\n"));
	assert.equal((await fromServer).toString(), "SSH-2.0-HTCondorGateway\r\n");

	socket.destroy();
});

test("the caller's token is attached to the upgrade", TIMEOUT, async () => {
	const server = await fakeRelayServer();
	const relay = new Relay(server.baseUrl, async () => "a-real-token");
	cleanups.push(() => relay.close(), () => server.close());

	const socket = await dial(await relay.listen());
	await server.accepted;

	assert.deepEqual(server.authHeaders, ["Bearer a-real-token"]);
	socket.destroy();
});

// A large transfer is where a naive relay breaks: it has to preserve
// every byte and the order of them across many frames, which is what
// `scp` and Remote-SSH's own server install depend on.
test("a large stream arrives intact and in order", TIMEOUT, async () => {
	const server = await fakeRelayServer();
	const relay = new Relay(server.baseUrl, async () => "token");
	cleanups.push(() => relay.close(), () => server.close());

	const socket = await dial(await relay.listen());
	const ws = await server.accepted;

	const size = 512 * 1024;
	const payload = Buffer.alloc(size);
	for (let i = 0; i < size; i++) {
		payload[i] = i % 251;
	}

	const received = new Promise<Buffer>((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		ws.on("message", (data) => {
			const buf = data as Buffer;
			chunks.push(buf);
			total += buf.length;
			if (total >= size) {
				resolve(Buffer.concat(chunks));
			}
		});
	});

	socket.write(payload);
	const got = await received;
	assert.equal(got.length, size, "byte count differs");
	assert.ok(got.equals(payload), "bytes differ or arrived out of order");

	socket.destroy();
});

// A refused upgrade has to reach the user as something they can act on.
// Without this the session just fails to open, and the reason -- an
// expired sign-in, a token scoped too narrowly, an access point with no
// gateway -- is only visible as an HTTP status nobody sees.
test("a refused upgrade is reported with its status and drops the connection", TIMEOUT, async () => {
	const server = await fakeRelayServer(401);
	const log = recordingLog();
	const relay = new Relay(server.baseUrl, async () => "stale-token", log);
	cleanups.push(() => relay.close(), () => server.close());

	const socket = await dial(await relay.listen());
	await new Promise<void>((resolve) => socket.once("close", () => resolve()));

	assert.ok(
		log.messages.some((m) => m.includes("401")),
		`no message carried the status; got ${JSON.stringify(log.messages)}`
	);
});

// Loopback is a security property, not a default. This listener accepts
// without authenticating -- the credential is added on the way out --
// so a socket reachable from the network would hand the caller's token
// to whoever connected to it.
test("listens on loopback only", TIMEOUT, async () => {
	const server = await fakeRelayServer();
	const relay = new Relay(server.baseUrl, async () => "token");
	cleanups.push(() => relay.close(), () => server.close());

	await relay.listen();
	const address = (relay as unknown as { server: HttpServer }).server.address() as AddressInfo;
	assert.equal(address.address, "127.0.0.1", `bound to ${address.address}`);
});

test("close stops listening", TIMEOUT, async () => {
	const server = await fakeRelayServer();
	const relay = new Relay(server.baseUrl, async () => "token");
	cleanups.push(() => server.close());

	const port = await relay.listen();
	await relay.close();

	await assert.rejects(dial(port), "the port still accepts connections after close");
});
