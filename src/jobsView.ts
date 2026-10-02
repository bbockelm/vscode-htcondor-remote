// The Jobs panel.
//
// Grouped by status rather than listed flat, because the question a
// user opens this for is almost always "what is stuck?" rather than
// "what exists". The arrangement itself lives in jobsModel.ts, where
// it is testable without an editor.

import * as vscode from "vscode";

import { HTCondorApi, describeStatus } from "./api";
import { JobNode, groupByStatus, jobContext, jobLabel, jobTooltip } from "./jobsModel";
import { JobsState } from "./jobsStatus";
import { jobId } from "./api";

export class JobsProvider implements vscode.TreeDataProvider<JobNode> {
	private readonly changed = new vscode.EventEmitter<JobNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	private readonly stateChanged = new vscode.EventEmitter<JobsState>();
	/** Fires whenever the view's own status changes. */
	readonly onDidChangeState = this.stateChanged.event;

	private state: JobsState = { kind: "never-loaded" };

	constructor(
		private readonly api: HTCondorApi,
		private readonly log: vscode.LogOutputChannel
	) {}

	refresh(): void {
		this.changed.fire(undefined);
	}

	getTreeItem(node: JobNode): vscode.TreeItem {
		if (node.kind === "group") {
			const item = new vscode.TreeItem(
				`${describeStatus(node.status)} (${node.jobs.length})`,
				// Held is expanded on arrival: it is the group somebody
				// needs to look at, and one collapsed by default is one
				// nobody opens.
				node.status === 5
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed
			);
			item.contextValue = "htcondor.group";
			return item;
		}

		const item = new vscode.TreeItem(jobLabel(node.job), vscode.TreeItemCollapsibleState.None);
		item.description = describeStatus(node.job.status);
		item.tooltip = jobTooltip(node.job);
		item.contextValue = jobContext(node.job);
		item.id = jobId(node.job);
		return item;
	}

	async getChildren(node?: JobNode): Promise<JobNode[]> {
		if (node?.kind === "job") {
			return [];
		}
		if (node?.kind === "group") {
			return node.jobs.map((job) => ({ kind: "job", job }));
		}
		this.setState({ kind: "loading" });
		try {
			const jobs = await this.api.listJobs();
			this.setState({ kind: "loaded", count: jobs.length });
			return groupByStatus(jobs).map((group) => ({ kind: "group", ...group }));
		} catch (err: unknown) {
			const detail = err instanceof Error ? err.message : String(err);
			// Reported in the log and in the view's own message rather
			// than as a modal: this refreshes on a stream and on a
			// timer, and a dialog per failed poll would be unusable on a
			// flaky connection. But an empty tree on its own is
			// indistinguishable from a queue with no jobs in it, which
			// is the thing that must not happen silently.
			this.log.warn(`Could not list jobs: ${detail}`);
			this.setState({ kind: "failed", detail });
			return [];
		}
	}

	private setState(next: JobsState): void {
		this.state = next;
		this.stateChanged.fire(next);
	}

	/** The view's current status. */
	get currentState(): JobsState {
		return this.state;
	}
}
