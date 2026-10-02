// How the Jobs panel arranges what it shows.
//
// No VS Code dependency, so the arrangement can be tested: the
// ordering and the labels are where the judgement is, and the tree
// provider around them is glue.

import { JobSummary, describeStatus, jobId } from "./api";

/** A status group, or a job inside one. */
export type JobNode = { kind: "group"; status: number; jobs: JobSummary[] } | { kind: "job"; job: JobSummary };

/**
 * The order groups appear in.
 *
 * Held first: it is the only status that means something needs a
 * person. Running and Idle next, because that is the work in progress.
 * Finished states last -- they are history, and on a busy access point
 * they would otherwise push everything live off the screen.
 */
const GROUP_ORDER = [5, 2, 1, 6, 7, 3, 4];

export function groupByStatus(jobs: JobSummary[]): Array<{ status: number; jobs: JobSummary[] }> {
	const groups = new Map<number, JobSummary[]>();
	for (const job of jobs) {
		const existing = groups.get(job.status);
		if (existing) {
			existing.push(job);
		} else {
			groups.set(job.status, [job]);
		}
	}
	return [...groups.entries()]
		.map(([status, grouped]) => ({ status, jobs: grouped }))
		.sort((a, b) => rank(a.status) - rank(b.status));
}

function rank(status: number): number {
	const at = GROUP_ORDER.indexOf(status);
	// An unknown status sorts after everything known rather than
	// first, which is what indexOf's -1 would otherwise do.
	return at === -1 ? GROUP_ORDER.length : at;
}

/** The label for one job row. */
export function jobLabel(job: JobSummary): string {
	if (job.batchName) {
		return `${jobId(job)} — ${job.batchName}`;
	}
	if (job.command) {
		// The basename: a full path is mostly shared prefix and pushes
		// the part that differs off the right-hand edge.
		const base = job.command.split(/[/\\]/).pop();
		if (base) {
			return `${jobId(job)} — ${base}`;
		}
	}
	return jobId(job);
}

/** What to show when hovering a job. */
export function jobTooltip(job: JobSummary): string {
	const lines = [`${jobId(job)} — ${describeStatus(job.status)}`];
	if (job.owner) {
		lines.push(`Owner: ${job.owner}`);
	}
	if (job.remoteHost) {
		lines.push(`Running on: ${job.remoteHost}`);
	}
	if (job.command) {
		lines.push(`Command: ${job.command}`);
	}
	if (job.holdReason) {
		// The reason a held job is held is the whole point of noticing
		// it, so it is never truncated away.
		lines.push(`Hold reason: ${job.holdReason}`);
	}
	return lines.join("\n");
}

/**
 * The tree item context value for a job, which the menus gate on.
 *
 * Per status, because most actions only make sense for some. Offering
 * "open a window in this job" on a completed one is not a small
 * untidiness: there is nothing to connect to, so the only thing the
 * menu entry can do is fail.
 */
export function jobContext(job: JobSummary): string {
	switch (job.status) {
		case 1:
			return "htcondor.job.idle";
		case 2:
			return "htcondor.job.running";
		case 5:
			return "htcondor.job.held";
		case 3:
		case 4:
			return "htcondor.job.finished";
		default:
			return "htcondor.job.other";
	}
}
