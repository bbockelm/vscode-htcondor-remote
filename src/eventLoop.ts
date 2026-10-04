// How much of a slow request was the editor not running at all.
//
// A request was taking twenty seconds and answering 200. The access
// point's log showed nothing over half a second, the same request from
// a shell was immediate, and turning off the editor's own HTTP stack
// changed nothing. What is left is the possibility that the request
// was never slow: that it came back quickly and the extension host --
// a single thread, shared by every extension in the window -- was busy
// elsewhere and could not run the line that notices.
//
// A promise cannot resolve while the thread is blocked, so from inside
// a blocked extension host a fast request and a slow one look exactly
// alike. The difference is visible only to a clock that expects to be
// woken regularly and notices when it is not.
//
// No `vscode` import, and no timer of its own: the caller drives it,
// so the arithmetic can be tested without waiting for real time.

export interface LagSample {
	/** When the tick actually ran. */
	at: number;
	/** How late it was. */
	lagMs: number;
}

export class LoopLag {
	private readonly samples: LagSample[] = [];
	private expected: number | undefined;

	constructor(
		private readonly intervalMs: number = 250,
		/**
		 * How many samples to keep.
		 *
		 * Enough to cover the first few minutes of a window, which is
		 * where the problem is; a monitor that grew without bound
		 * would be its own bug.
		 */
		private readonly limit: number = 1_200
	) {}

	/** Record a tick that was scheduled `intervalMs` after the last. */
	tick(now: number): void {
		if (this.expected !== undefined) {
			this.samples.push({ at: now, lagMs: Math.max(0, now - this.expected) });
			if (this.samples.length > this.limit) {
				this.samples.shift();
			}
		}
		this.expected = now + this.intervalMs;
	}

	/**
	 * How long the thread was unable to run between two moments.
	 *
	 * The sum rather than the worst: a thread blocked in twenty
	 * one-second stretches delayed the answer by twenty seconds just
	 * as surely as one twenty-second stretch, and the question being
	 * asked is how much of a request's wait it can account for.
	 */
	blockedBetween(from: number, to: number): number {
		let total = 0;
		for (const sample of this.samples) {
			// A tick is attributed to the window it finished in. Its
			// lag may have started earlier, which is the right way
			// round: a block that was already running when the request
			// was sent is part of why the request was slow.
			if (sample.at > from && sample.at <= to) {
				total += sample.lagMs;
			}
		}
		return Math.round(total);
	}

	/** The longest single stall in a window. */
	worstBetween(from: number, to: number): number {
		let worst = 0;
		for (const sample of this.samples) {
			if (sample.at > from && sample.at <= to) {
				worst = Math.max(worst, sample.lagMs);
			}
		}
		return Math.round(worst);
	}

	/** Samples held, so a caller can tell "nothing blocked" from "nothing measured". */
	get count(): number {
		return this.samples.length;
	}
}

/**
 * What a request's wait and the thread's stalls say together.
 *
 * Returns undefined when there is nothing worth saying, which is the
 * ordinary case.
 */
export function explainBlocking(waitMs: number, blockedMs: number, worstMs: number): string | undefined {
	if (waitMs < 5_000) {
		return undefined;
	}
	// Most of the wait unaccounted for by stalls: the request really
	// did take that long to come back.
	if (blockedMs < waitMs / 2) {
		return (
			`The editor was responsive for most of that (blocked ${blockedMs}ms of ${waitMs}ms), ` +
			`so the request really was outstanding.`
		);
	}
	return (
		`The extension host was blocked for ${blockedMs}ms of those ${waitMs}ms, in stretches of up to ` +
		`${worstMs}ms. The request was very likely answered long before this extension could notice: ` +
		`nothing in a window can run while another extension holds the thread. ` +
		`Running the window with other extensions disabled would confirm it.`
	);
}
