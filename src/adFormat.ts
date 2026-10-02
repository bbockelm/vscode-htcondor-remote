// Rendering a ClassAd for a person to read.
//
// Kept free of any VS Code import so the formatting can be tested.

/**
 * Attributes worth putting at the top.
 *
 * A job ad has seventy-odd attributes in whatever order the server
 * sent them, and the handful somebody opened the view for are scattered
 * through it. These come first, in this order; everything else follows
 * alphabetically.
 */
const LEADING = [
	"ClusterId",
	"ProcId",
	"Owner",
	"JobStatus",
	"JobBatchName",
	"Cmd",
	"Args",
	"Arguments",
	"Iwd",
	"RemoteHost",
	"LastRemoteHost",
	"HoldReason",
	"HoldReasonCode",
	"HoldReasonSubCode",
	"ExitCode",
	"ExitBySignal",
	"RequestCpus",
	"RequestMemory",
	"RequestDisk",
	"QDate",
	"JobStartDate",
	"CompletionDate",
];

/** Format a ClassAd as aligned `Attribute = value` lines. */
export function formatAd(ad: Record<string, unknown>): string {
	const keys = Object.keys(ad);
	const leading = LEADING.filter((k) => keys.includes(k));
	const rest = keys.filter((k) => !leading.includes(k)).sort((a, b) => a.localeCompare(b));
	const ordered = [...leading, ...rest];

	// Aligned on the longest attribute name, which makes a long ad
	// scannable down the value column instead of ragged.
	const width = ordered.reduce((w, k) => Math.max(w, k.length), 0);
	const lines = ordered.map((key) => `${key.padEnd(width)} = ${formatValue(ad[key])}`);

	if (leading.length > 0) {
		// A blank line between the attributes somebody came for and the
		// rest, so the top of the document is the useful part.
		lines.splice(leading.length, 0, "");
	}
	return lines.join("\n") + "\n";
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "undefined";
	}
	if (typeof value === "string") {
		// Quoted the way a ClassAd writes a string, so the document
		// reads like one rather than like JSON.
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}

/** Seconds since the epoch as something readable, for a timestamp attribute. */
export function describeTime(seconds: unknown): string | undefined {
	if (typeof seconds !== "number" || seconds <= 0) {
		return undefined;
	}
	return new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
