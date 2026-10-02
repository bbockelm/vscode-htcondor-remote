// The Jobs panel.
//
// Grouped by status rather than listed flat, because the question a
// user opens this for is almost always "what is stuck?" rather than
// "what exists". The arrangement itself lives in jobsModel.ts, where
// it is testable without an editor.

import * as vscode from "vscode";

import { HTCondorApi, describeStatus } from "./api";
import { JobNode, groupByStatus, jobContext, jobLabel, jobTooltip } from "./jobsModel";
import { jobId } from "./api";

export class JobsProvider implements vscode.TreeDataProvider<JobNode> {
	private readonly changed = new vscode.EventEmitter<JobNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

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
		try {
			const jobs = await this.api.listJobs();
			return groupByStatus(jobs).map((group) => ({ kind: "group", ...group }));
		} catch (err: unknown) {
			// Reported in the log and as an empty tree rather than as a
			// modal: this refreshes on a timer, and a dialog per failed
			// poll would be unusable on a flaky connection.
			this.log.warn(`Could not list jobs: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}
}
