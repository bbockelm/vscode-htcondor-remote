// What the Jobs view says above the tree.
//
// Separate from the view so the wording can be tested, and because the
// distinction it draws is the whole point: an empty tree means "no
// jobs" and "never asked" and "asked and failed", and those are three
// different things a user needs to tell apart.

/** What the Jobs view currently knows. */
export type JobsState =
	| { kind: "never-loaded" }
	| { kind: "loading" }
	| { kind: "loaded"; count: number }
	| { kind: "failed"; detail: string };

/**
 * The message for a state, or undefined when the tree speaks for
 * itself.
 *
 * An empty tree with no message is only correct once a listing has
 * actually come back empty. Before that it is a lie by omission: the
 * view looks like a queue with nothing in it when really nothing has
 * been asked.
 */
export function jobsMessage(state: JobsState): string | undefined {
	switch (state.kind) {
		case "never-loaded":
			return "Not loaded yet.";
		case "loading":
			return "Loading jobs…";
		case "failed":
			// Named, and pointing at where the detail is. "Could not
			// load" with no reason leaves the user with nothing to do.
			return `Could not load jobs: ${state.detail}`;
		case "loaded":
			// Nothing: an empty tree after a successful listing really
			// does mean an empty queue, and VS Code's own welcome view
			// says so better than a message bar would.
			return undefined;
	}
}

/** Whether the view is showing something it has actually confirmed. */
export function hasLoaded(state: JobsState): boolean {
	return state.kind === "loaded";
}
