// A job's full ClassAd, as a read-only document.
//
// A document rather than a webview: an ad is text, and a document gets
// find, selection, copy, folding and the user's own theme for free. A
// webview would reimplement all of that worse.

import * as vscode from "vscode";

import { HTCondorApi } from "./api";
import { formatAd } from "./adFormat";

export const JOB_DETAILS_SCHEME = "htcondor-job";

export class JobDetailsProvider implements vscode.TextDocumentContentProvider {
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly api: HTCondorApi) {}

	/** The URI for a job's details. The job id is the path. */
	static uriFor(jobId: string): vscode.Uri {
		// `.classad` so the editor picks a sensible mode and the tab
		// shows the job id rather than a scheme nobody recognises.
		return vscode.Uri.parse(`${JOB_DETAILS_SCHEME}:${jobId}.classad`);
	}

	/** Re-read an open details document. */
	refresh(jobId: string): void {
		this.changed.fire(JobDetailsProvider.uriFor(jobId));
	}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const jobId = uri.path.replace(/\.classad$/, "");
		try {
			const ad = await this.api.getJobAd(jobId);
			if (!ad) {
				// Said plainly rather than left blank. A job that has
				// left the queue is the ordinary reason, and an empty
				// document looks like a failure to load.
				return `# Job ${jobId} is not in the queue.\n#\n# It may have finished and been removed from it; the\n# history holds finished jobs.\n`;
			}
			return formatAd(ad);
		} catch (err: unknown) {
			return `# Could not read job ${jobId}:\n# ${err instanceof Error ? err.message : String(err)}\n`;
		}
	}
}
