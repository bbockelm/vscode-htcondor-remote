// Small text helpers, kept free of any VS Code import so they can be
// tested directly.

/**
 * Prefix every line, leaving a trailing newline alone.
 *
 * The trailing newline matters: a log is appended to in chunks, and a
 * prefix on the empty string after the final newline would put a stray
 * marker at the start of the next chunk — which shows up as a line
 * that reads "[stderr] " and nothing else.
 */
export function prefixLines(text: string, prefix: string): string {
	if (text === "") {
		return "";
	}
	const trailing = text.endsWith("\n");
	const body = trailing ? text.slice(0, -1) : text;
	const prefixed = body
		.split("\n")
		.map((line) => prefix + line)
		.join("\n");
	return trailing ? prefixed + "\n" : prefixed;
}
