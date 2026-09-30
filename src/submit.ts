// Submitting a job, and the trap that comes with it.
//
// `POST /api/v1/jobs` is only half a submission. Every submission is
// written into the queue as JobStatus=5 with HoldReasonCode=16,
// "Spooling input data files", and released immediately only if it
// needs no upload. Whether it needs one is decided by
// `transfer_executable`, which DEFAULTS TO TRUE -- so a plain submit
// returns 2xx and then sits held forever, waiting for an upload nobody
// sends.
//
// So the submit path here checks the file first and says what will
// happen, rather than reporting a success the queue disagrees with.

/** What a submit file implies for the two-step submit. */
export interface SubmitPlan {
	/** True when the job will spool-hold unless input is uploaded. */
	needsUpload: boolean;
	/** Whether the executable itself is among what must be uploaded. */
	transfersExecutable: boolean;
	/** The executable, as written, when one is named. */
	executable?: string;
	/** Files named by transfer_input_files, as written. */
	inputFiles: string[];
}

/**
 * Read a submit file well enough to know whether it needs an upload.
 *
 * Deliberately not a full submit-file parser. It answers one question,
 * and where it is unsure it answers "needs an upload", because that is
 * the safe direction: warning about a job that would have been fine
 * costs a sentence, while staying quiet about one that will hang costs
 * the user a held job they have to work out for themselves.
 */
export function planSubmit(text: string): SubmitPlan {
	let transferExecutable: boolean | undefined;
	let executable: string | undefined;
	const inputFiles: string[] = [];

	for (const raw of text.split("\n")) {
		// Comments and the queue statement carry nothing we need.
		const line = raw.replace(/^\s+/, "");
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const at = line.indexOf("=");
		if (at < 0) {
			continue;
		}
		// Submit commands are case-insensitive and may be written with
		// underscores or not at all consistently.
		const key = line.slice(0, at).trim().toLowerCase().replace(/_/g, "");
		const value = line.slice(at + 1).trim();

		switch (key) {
			case "transferexecutable":
				transferExecutable = isTrue(value);
				break;
			case "executable":
				executable = value;
				break;
			case "transferinputfiles":
				for (const file of value.split(",")) {
					const trimmed = file.trim();
					if (trimmed !== "") {
						inputFiles.push(trimmed);
					}
				}
				break;
			default:
				break;
		}
	}

	// Unset means true, which is the whole problem.
	const willTransferExecutable = (transferExecutable ?? true) && executable !== undefined;
	return {
		needsUpload: willTransferExecutable || inputFiles.length > 0,
		transfersExecutable: willTransferExecutable,
		...(executable ? { executable } : {}),
		inputFiles,
	};
}

/** HTCondor's spelling of truth in a submit file. */
function isTrue(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === "true" || v === "yes" || v === "1" || v === "t";
}

/**
 * What to tell the user before submitting.
 *
 * Empty when there is nothing to say.
 */
export function submitWarning(plan: SubmitPlan): string {
	if (!plan.needsUpload) {
		return "";
	}
	// Named by what is actually being waited for. Telling somebody to
	// add `transfer_executable = false` when they already have it, and
	// the hold is really about their input files, sends them to fix
	// the wrong line.
	const parts: string[] = [];
	if (plan.transfersExecutable && plan.executable) {
		parts.push(`its executable (${plan.executable})`);
	}
	if (plan.inputFiles.length > 0) {
		parts.push(`its input files (${plan.inputFiles.join(", ")})`);
	}
	const advice = plan.transfersExecutable
		? " Add `transfer_executable = false` if the executable already exists on the execute node, or submit it with condor_submit for now."
		: " Submit it with condor_submit for now.";
	return (
		`This job will be held while it waits for ${parts.join(" and ")} to be uploaded, ` +
		`and this extension cannot upload yet.` +
		advice
	);
}
