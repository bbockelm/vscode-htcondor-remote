import { strict as assert } from "node:assert";
import * as Module from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// The closest thing to "it loads in an editor" that can run here.
//
// Nothing in this extension has been exercised inside VS Code, so the
// failure worth guarding against is the dullest one: a bundle that
// throws on import, or stops exporting `activate`, leaves an extension
// that silently never activates and says nothing about why.
//
// `vscode` is external to the bundle because the editor supplies it, so
// loading it here means supplying a stand-in.

const BUNDLE = join(__dirname, "..", "extension.js");

/** A `vscode` just real enough to be imported. */
function vscodeStub(): Record<string, unknown> {
	const noop = (): void => {};
	const disposable = { dispose: noop };
	return {
		EventEmitter: class {
			event = noop;
			fire = noop;
			dispose = noop;
		},
		Uri: { parse: (s: string) => s },
		ConfigurationTarget: { Global: 1 },
		ProgressLocation: { Notification: 15 },
		TreeItem: class {},
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		window: {
			createOutputChannel: () => ({ ...disposable, info: noop, warn: noop, append: noop, show: noop }),
			registerTreeDataProvider: () => disposable,
			createTerminal: () => ({ show: noop }),
			showInformationMessage: noop,
			showErrorMessage: noop,
			showWarningMessage: noop,
			withProgress: noop,
		},
		workspace: { getConfiguration: () => ({ get: () => "", update: noop }) },
		commands: { registerCommand: () => disposable },
		authentication: { registerAuthenticationProvider: () => disposable, getSession: noop },
		env: { openExternal: noop, asExternalUri: (u: unknown) => u },
	};
}

test("the bundle loads and exports an activation function", () => {
	assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing; the test script should bundle before running`);

	const stub = vscodeStub();
	// Intercepting resolution is how an extension host supplies
	// `vscode` too: it is never a file on disk.
	const loader = Module as unknown as {
		_resolveFilename: (request: string, ...rest: unknown[]) => string;
		_load: (request: string, ...rest: unknown[]) => unknown;
	};
	const originalLoad = loader._load;
	loader._load = function (request: string, ...rest: unknown[]): unknown {
		if (request === "vscode") {
			return stub;
		}
		return originalLoad.call(this, request, ...rest);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const extension = require(BUNDLE) as { activate?: unknown; deactivate?: unknown };
		assert.equal(typeof extension.activate, "function", "no activate export: VS Code would load nothing");
		assert.equal(typeof extension.deactivate, "function");
	} finally {
		loader._load = originalLoad;
		delete require.cache[require.resolve(BUNDLE)];
	}
});
