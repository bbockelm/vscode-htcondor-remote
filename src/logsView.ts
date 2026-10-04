// A job's output, tailed into an output channel.
//
// An OutputChannel rather than a document: the content only grows, the
// user does not edit it, and VS Code's output view already knows how to
// follow a growing stream. A read-only editor document would need a
// FileSystemProvider and a scheme to go with it, for a worse result.

import * as vscode from "vscode";

import { HTCondorApi, PeekOffsets } from "./api";
import { prefixLines } from "./text";

/**
 * How often to ask for more.
 *
 * Three seconds. The MCP documentation asks callers not to poll this
 * faster than every five; three is for a human watching a log, and
 * stops as soon as the channel is closed.
 */
const POLL_MS = 3_000;

export class JobLogs implements vscode.Disposable {
	private readonly channels = new Map<string, { channel: vscode.OutputChannel; timer: NodeJS.Timeout }>();

	constructor(
		private readonly api: HTCondorApi,
		private readonly log: vscode.LogOutputChannel
	) {}

	dispose(): void {
		this.closeAll();
	}

	/**
	 * Close every open job output.
	 *
	 * Called when the window changes access point: each of these polls
	 * a job id, and the same id on another access point is a different
	 * job. Left open they would quietly start following it.
	 */
	closeAll(): void {
		for (const { channel, timer } of this.channels.values()) {
			clearInterval(timer);
			channel.dispose();
		}
		this.channels.clear();
	}

	/** Open a job's output, or reveal it if it is already open. */
	show(id: string): void {
		const existing = this.channels.get(id);
		if (existing) {
			existing.channel.show(true);
			return;
		}

		const channel = vscode.window.createOutputChannel(`HTCondor ${id}`);
		channel.show(true);

		let offsets: PeekOffsets = {};
		let polling = false;
		const tick = async (): Promise<void> => {
			// Skipped rather than queued when the previous poll is
			// still in flight. A slow access point would otherwise
			// build a backlog of requests that all return the same
			// bytes.
			if (polling) {
				return;
			}
			polling = true;
			try {
				const result = await this.api.peek(id, offsets);
				offsets = result.offsets;
				if (result.stdout) {
					channel.append(result.stdout);
				}
				if (result.stderr) {
					// Marked, because a log with both interleaved and
					// nothing to tell them apart is worse than either
					// alone.
					channel.append(prefixLines(result.stderr, "[stderr] "));
				}
			} catch (err: unknown) {
				// Logged once and the poll continues: a job between
				// states, or a brief network failure, should not close
				// a log the user is watching.
				this.log.warn(`Could not read output for ${id}: ${describe(err)}`);
			} finally {
				polling = false;
			}
		};

		void tick();
		const timer = setInterval(() => void tick(), POLL_MS);
		this.channels.set(id, { channel, timer });
	}

	/** Stop following a job and drop its channel. */
	close(id: string): void {
		const open = this.channels.get(id);
		if (!open) {
			return;
		}
		clearInterval(open.timer);
		open.channel.dispose();
		this.channels.delete(id);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
