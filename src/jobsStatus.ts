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
	| { kind: "failed"; detail: string }
	/**
	 * Nobody is signed in, so there is nothing to list.
	 *
	 * Distinct from a failure: it is the ordinary state before signing
	 * in and after signing out, and the welcome view already says what
	 * to do about it. A message bar reading "Could not load jobs: Not
	 * signed in" on top of a "Sign in" button is noise.
	 */
	| { kind: "signed-out" };

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
		case "signed-out":
			return undefined;
		case "loaded":
			// Nothing: an empty tree after a successful listing really
			// does mean an empty queue, and VS Code's own welcome view
			// says so better than a message bar would.
			return undefined;
	}
}

/**
 * The slice of vscode.TreeView the message bar needs.
 *
 * Written as a property that accepts undefined, because that is what
 * clearing it is, and because the editor's own typing -- which
 * forbids it -- is what led to the bar being cleared with `delete`.
 */
export interface MessageBar {
	message: string | undefined;
}

/**
 * Put a state's message on the view.
 *
 * Always an assignment. `message` is an accessor on the editor's
 * TreeView, and `delete` does not go through a setter: it removes the
 * accessor instead, so the bar keeps whatever it last said -- "Loading
 * jobs…", after the jobs have loaded -- and no later message reaches
 * the view either.
 */
export function applyJobsMessage(view: MessageBar, state: JobsState): void {
	view.message = jobsMessage(state);
}

/** Whether the view is showing something it has actually confirmed. */
export function hasLoaded(state: JobsState): boolean {
	return state.kind === "loaded";
}
