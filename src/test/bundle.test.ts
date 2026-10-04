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
		ThemeIcon: class {
			constructor(public readonly id: string) {}
		},
		TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		QuickPickItemKind: { Separator: -1, Default: 0 },
		window: {
			createOutputChannel: () => ({ ...disposable, info: noop, warn: noop, append: noop, show: noop }),
			registerTreeDataProvider: () => disposable,
			createTerminal: () => ({ show: noop }),
			createTreeView: () => ({ ...disposable, message: undefined, onDidChangeVisibility: () => disposable }),
			showTextDocument: noop,
			registerFileDecorationProvider: () => disposable,
			createStatusBarItem: () => ({ ...disposable, show: noop, hide: noop, text: "", tooltip: "", command: "" }),
			showQuickPick: noop,
			showInputBox: noop,
			showInformationMessage: noop,
			showErrorMessage: noop,
			showWarningMessage: noop,
			withProgress: noop,
		},
		workspace: {
			getConfiguration: () => ({ get: () => "", update: noop }),
			onDidChangeConfiguration: () => disposable,
			registerTextDocumentContentProvider: () => disposable,
			openTextDocument: noop,
		},
		commands: { registerCommand: () => disposable },
		authentication: { registerAuthenticationProvider: () => disposable, getSession: noop },
		env: { openExternal: noop, asExternalUri: (u: unknown) => u },
		version: "1.90.0",
	};
}

/** An ExtensionContext just real enough to activate against. */
function contextStub(): Record<string, unknown> {
	const noop = (): void => {};
	return {
		subscriptions: [] as unknown[],
		secrets: { get: async () => undefined, store: noop, delete: noop, onDidChange: noop },
		globalStorageUri: { fsPath: "/tmp/htcondor-test" },
		globalState: { get: () => undefined, update: async () => undefined },
		extension: { packageJSON: { version: "9.9.9" } },
	};
}

/** Load the bundle with `vscode` supplied, the way the editor does. */
function withStubbedVscode<T>(stub: Record<string, unknown>, body: (bundle: unknown) => T): T {
	// Intercepting resolution is how an extension host supplies
	// `vscode` too: it is never a file on disk.
	const loader = Module as unknown as {
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
		return body(require(BUNDLE));
	} finally {
		loader._load = originalLoad;
		delete require.cache[require.resolve(BUNDLE)];
	}
}

test("the bundle loads and exports an activation function", () => {
	assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing; the test script should bundle before running`);

	withStubbedVscode(vscodeStub(), (bundle) => {
		const extension = bundle as { activate?: unknown; deactivate?: unknown };
		assert.equal(typeof extension.activate, "function", "no activate export: VS Code would load nothing");
		assert.equal(typeof extension.deactivate, "function");
	});
});

test("activation survives a first run with nothing configured", () => {
	// The export check above says the module parses. It does not say
	// the extension works: everything interesting happens inside
	// activate(), and a throw there leaves an editor with no tree, no
	// commands and no welcome view -- the same symptom as not being
	// installed. A fresh install has no access point configured, which
	// is the one activation every user performs.
	withStubbedVscode(vscodeStub(), (bundle) => {
		const { activate } = bundle as { activate: (c: unknown) => void };
		activate(contextStub());
	});
});
