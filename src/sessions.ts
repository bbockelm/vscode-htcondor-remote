// Starting an interactive session: what to ask for, and when it is
// ready.
//
// An interactive session is a job that exists to be connected to rather
// than to run something. The queue wait is the whole cost of one, so
// the sizes offered here are deliberately modest: a session that asks
// for more than it needs waits longer for a slot, and waiting is the
// part users give up on.

import { SessionSpec } from "./api";

export interface SessionPreset {
	label: string;
	detail: string;
	spec: SessionSpec;
}

/**
 * The sizes offered, smallest first.
 *
 * Smallest first because it matches first, and a session that starts
 * now beats a bigger one that starts in twenty minutes. The GPU entry
 * is last: asking for one where none are free is the single easiest
 * way to wait forever.
 */
export const PRESETS: SessionPreset[] = [
	{
		label: "Small",
		detail: "1 CPU, 2 GB memory — starts soonest",
		spec: { cpus: 1, memoryMB: 2048 },
	},
	{
		label: "Medium",
		detail: "4 CPUs, 8 GB memory",
		spec: { cpus: 4, memoryMB: 8192 },
	},
	{
		label: "Large",
		detail: "8 CPUs, 16 GB memory",
		spec: { cpus: 8, memoryMB: 16384 },
	},
	{
		label: "GPU",
		detail: "1 GPU, 4 CPUs, 16 GB memory — may wait for a free GPU",
		spec: { cpus: 4, memoryMB: 16384, gpus: 1 },
	},
];

/**
 * Parse a custom size, written the way a person would write it.
 *
 * Accepts "4 cpus, 16 GB", "2cpu 8g", "1 gpu 8 cpus 32GB" in any
 * order. Returns undefined for anything it cannot read rather than
 * guessing, because a session that silently asks for 1 CPU when the
 * user asked for 32 wastes their time twice: once waiting, once
 * discovering why it is slow.
 */
export function parseSize(text: string): SessionSpec | undefined {
	const spec: SessionSpec = {};
	let matched = false;

	for (const [pattern, apply] of [
		[/(\d+)\s*(?:cpus?|cores?)\b/i, (n: number) => (spec.cpus = n)],
		[/(\d+)\s*gpus?\b/i, (n: number) => (spec.gpus = n)],
		// Memory last of the three, so "8 GB" is not eaten by a looser
		// pattern above it.
		[/(\d+)\s*(?:gb?|gib)\b/i, (n: number) => (spec.memoryMB = n * 1024)],
		[/(\d+)\s*(?:mb|mib)\b/i, (n: number) => (spec.memoryMB = n)],
	] as Array<[RegExp, (n: number) => void]>) {
		const found = pattern.exec(text);
		if (found?.[1]) {
			apply(Number(found[1]));
			matched = true;
		}
	}

	return matched ? spec : undefined;
}

/** A one-line summary of what will be asked for. */
export function describeSpec(spec: SessionSpec): string {
	const parts: string[] = [];
	parts.push(`${spec.cpus ?? 1} CPU${(spec.cpus ?? 1) === 1 ? "" : "s"}`);
	if (spec.memoryMB) {
		parts.push(spec.memoryMB % 1024 === 0 ? `${spec.memoryMB / 1024} GB` : `${spec.memoryMB} MB`);
	}
	if (spec.gpus) {
		parts.push(`${spec.gpus} GPU${spec.gpus === 1 ? "" : "s"}`);
	}
	return parts.join(", ");
}

/** HTCondor job statuses that mean "not going to start by itself". */
export function isStuck(status: number): boolean {
	// Held, removed and completed are all terminal for a session that
	// was waiting to run. Polling past them waits forever.
	return status === 3 || status === 4 || status === 5;
}

/** Whether a session is ready to connect to. */
export function isReady(status: number): boolean {
	return status === 2;
}
