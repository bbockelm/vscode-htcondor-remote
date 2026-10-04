// Opening the connection before Remote-SSH asks for it.
//
// Remote-SSH applies its own deadline to a whole connection, and the
// access point builds the transport to the execute node inside that
// deadline: a schedd query, a CEDAR connection to the node, an SSH
// handshake within it. On a busy pool that does not fit, and what
// gives way is the connection -- with a timeout and no explanation.
// The retry then works, because the attempt that timed out left a warm
// transport behind.
//
// So the extension makes that attempt itself, first, with a timeout it
// chose. By the time Remote-SSH connects, everything but the SSH hop
// to the gateway is already done.
//
// No `vscode` import: what is worth testing is which targets can be
// warmed and what the user is told, not the progress notification.

import { WarmResult } from "./api";

/**
 * How long to spend warming.
 *
 * Generous on purpose -- being generous here is the entire point, since
 * the alternative is spending it inside Remote-SSH's shorter deadline.
 * It is still bounded: a job on an unreachable node would otherwise
 * hold the connection the user asked for indefinitely.
 */
export const WARM_TIMEOUT_MS = 60_000;

/**
 * The job to warm for a gateway target, or undefined if there is none
 * to warm.
 *
 * The gateway's username field takes a job id, or a session name, or
 * nothing at all for the caller's default session. Only a job id names
 * something that exists yet: for the other two the gateway resolves --
 * and may submit -- the job during the connection, so there is nothing
 * to open in advance.
 */
export function warmTarget(target: string): string | undefined {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(target.trim());
	if (!match) {
		return undefined;
	}
	return `${match[1]}.${match[2] ?? "0"}`;
}

/** One line for the log, saying whether warming was worth it. */
export function describeWarm(job: string, result: WarmResult | undefined): string {
	if (!result) {
		return `This access point cannot open a connection to ${job} in advance; connecting straight away`;
	}
	if (result.reused) {
		return `Job ${job} was already connected`;
	}
	return `Opened a connection to job ${job} in ${(result.elapsedMs / 1000).toFixed(1)}s, ahead of the editor's`;
}

/**
 * Whether a warm-up is likely to still be good by the time it is used.
 *
 * The access point reaps a connection nothing is using. If that window
 * were shorter than the time Remote-SSH takes to get going, warming
 * would be work thrown away -- so a server that reports a short one is
 * believed rather than assumed.
 */
export function warmStaysValid(result: WarmResult | undefined, expectedDelaySeconds = 30): boolean {
	if (!result) {
		return false;
	}
	// A server that does not say is one that predates the field; the
	// endpoint existing at all is the stronger signal.
	return result.idleTimeoutSeconds === 0 || result.idleTimeoutSeconds >= expectedDelaySeconds;
}
