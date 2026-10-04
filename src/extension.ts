// Activation and wiring.
//
// The shape of the thing: sign in once through VS Code's own account
// UI, hold a short-lived SSH certificate on the strength of that, write
// an ssh config pointing at the access point's gateway, and hand
// Remote-SSH an authority it can already reach. The user meets a normal
// sign-in and then a window that opens. They never meet SSH.

import * as vscode from "vscode";

import { HTCondorApi, jobId } from "./api";
import { discover } from "./oauth2";
import { PRESETS, describeSpec, isReady, isStuck, parseSize } from "./sessions";
import { SessionSpec } from "./api";
import { AUTH_PROVIDER_ID, CLIENT_SECRET_KEY, HTCondorAuthProvider } from "./auth";
import { SCOPES } from "./oauth2";
import { CertificateManager, CHECK_INTERVAL_MS, KeyStore } from "./certificate";
import { JobNode } from "./jobsModel";
import { JOB_DETAILS_SCHEME, JobDetailsProvider } from "./jobDetails";
import { JobsProvider } from "./jobsView";
import { jobsMessage } from "./jobsStatus";
import { JobWatch } from "./watch";
import { JobLogs } from "./logsView";
import { planSubmit, submitWarning } from "./submit";
import { JobTerminal } from "./terminal";
import { configureHttp } from "./http";
import { accessPointLabel, canonicalAccessPoint, insecureAccessPoint } from "./accessPoints";
import { ACCESS_POINTS_SETTING, CurrentAccessPoint } from "./currentAccessPoint";
import { migrateUnscopedSecrets } from "./migrate";
import { TOKENS_KEY } from "./tokens";
import { aliasFor, HostSpec, writeSSHConfig } from "./sshconfig";

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("HTCondor", { log: true });
	context.subscriptions.push(output);

	// Before anything can make a request. Every outbound call picks
	// this up through `http()`, so an access point's log shows which
	// extension and which version asked, rather than `node`.
	const version = String((context.extension.packageJSON as { version?: string }).version ?? "0.0.0");
	configureHttp(version, vscode.version);
	output.info(`HTCondor extension ${version} on VS Code ${vscode.version}`);
	// Logged because the editor does not use Node's fetch as it
	// comes: with proxy support on, it substitutes its own agent and
	// its own view of the system certificates, and that is the only
	// thing between this extension and the network that a plain
	// `node` script does not have. A first request that stalls for
	// half a minute without ever reaching the access point is most
	// easily explained there, and the setting is the first thing to
	// know when one does.
	const httpConfig = vscode.workspace.getConfiguration("http");
	output.info(
		`Proxy support: ${httpConfig.get<string>("proxySupport", "override")}` +
			`, proxy: ${httpConfig.get<string>("proxy", "") || "(none)"}`
	);

	const current = new CurrentAccessPoint(context.globalState);
	context.subscriptions.push(current);
	const serverUrl = (): string => current.require();
	void adoptLegacySetting(context, current, output);

	const auth = new HTCondorAuthProvider(context.secrets, serverUrl);
	context.subscriptions.push(
		auth,
		vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, "HTCondor", auth, {
			supportsMultipleAccounts: false,
		})
	);

	const api = new HTCondorApi(serverUrl, () => auth.token(), undefined, undefined, (message) =>
		output.info(message)
	);
	const certificates = new CertificateManager(
		api,
		secretKeyStore(context),
		context.globalStorageUri.fsPath,
		undefined,
		() => current.url ?? ""
	);

	// Renewal runs on a timer as well as on demand. ssh reads the
	// certificate when it connects, and Remote-SSH reconnects by itself
	// after a network blip or a laptop waking -- at which point nothing
	// in this extension is on the call stack to notice the credential
	// has lapsed.
	// Follow the queue, so the tree reflects it without being asked.
	//
	// Changes are coalesced: a cluster of a thousand jobs produces a
	// thousand events in a moment, and re-reading the queue for each
	// would be a denial of service aimed at ourselves.
	let pending: NodeJS.Timeout | undefined;
	const watch = new JobWatch(serverUrl, () => auth.token(), {
		onChange: () => {
			if (pending) {
				return;
			}
			pending = setTimeout(() => {
				pending = undefined;
				jobs.refresh();
			}, 400);
		},
		onUnavailable: (reason, detail) => {
			output.info(`Not following job changes: ${detail}`);
			// Fall back to asking, rather than leaving a tree that never
			// changes. An access point with no mirror is a deployment
			// choice, so this is the normal path there and not an error.
			if (!pollTimer) {
				// At once, then on a timer. setInterval alone leaves the
				// view blank for the whole first interval, which is
				// exactly the window in which a user decides the
				// extension is broken.
				jobs.refresh();
				pollTimer = setInterval(() => jobs.refresh(), reason === "unauthorized" ? 60_000 : 15_000);
			}
		},
		onRetry: (detail, delayMs) => {
			output.warn(`Job stream dropped (${detail}); reconnecting in ${Math.round(delayMs / 1000)}s`);
		},
	});
	let pollTimer: NodeJS.Timeout | undefined;
	context.subscriptions.push({
		dispose: () => {
			watch.close();
			if (pending) {
				clearTimeout(pending);
			}
			if (pollTimer) {
				clearInterval(pollTimer);
			}
		},
	});
	// Only once there is a session to stream with; starting before that
	// would spend a reconnect cycle on a 401.
	const startWatching = async (): Promise<void> => {
		const sessions = await auth.getSessions();
		if (sessions.length > 0) {
			watch.start();
		}
	};
	void startWatching();
	context.subscriptions.push(auth.onDidChangeSessions(() => void startWatching()));

	// Everything that holds an access point reads it through a
	// closure, so a switch is a matter of dropping what was cached for
	// the old one and asking again.
	context.subscriptions.push(
		current.onDidChange((url) => {
			void (async (): Promise<void> => {
				output.info(url ? `Access point: ${url}` : "No access point configured");
				watch.close();
				if (pollTimer) {
					clearInterval(pollTimer);
					pollTimer = undefined;
				}
				logs.closeAll();
				jobs.refresh();
				await startWatching();
			})();
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`htcondor.${ACCESS_POINTS_SETTING}`)) {
				void current.reconcile();
			}
		})
	);

	const renewal = setInterval(() => {
		void certificates.ensure().catch((err: unknown) => {
			// Logged, not shown. A failed background renewal is not
			// worth a modal; the next connection attempt will surface
			// it with context the user can act on.
			output.warn(`Could not renew the SSH certificate: ${describe(err)}`);
		});
	}, CHECK_INTERVAL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(renewal) });

	// The welcome view keys off these, so an unconfigured extension
	// offers a button instead of an empty tree and a settings hunt.
	const setContext = async (): Promise<void> => {
		const configured = current.url !== undefined;
		await vscode.commands.executeCommand("setContext", "htcondor.configured", configured);
		let signedIn = false;
		if (configured) {
			const sessions = await auth.getSessions();
			signedIn = sessions.length > 0;
		}
		await vscode.commands.executeCommand("setContext", "htcondor.signedIn", signedIn);
	};
	void setContext();
	context.subscriptions.push(
		auth.onDidChangeSessions(() => void setContext()),
		current.onDidChange(() => void setContext())
	);

	const jobs = new JobsProvider(api, output, async () => (await auth.getSessions()).length > 0);
	const jobsView = vscode.window.createTreeView("htcondor.jobs", { treeDataProvider: jobs });
	const logs = new JobLogs(api, output);
	const details = new JobDetailsProvider(api);
	context.subscriptions.push(
		logs,
		vscode.workspace.registerTextDocumentContentProvider(JOB_DETAILS_SCHEME, details),
		vscode.commands.registerCommand("htcondor.showJobDetails", async (node?: JobNode) => {
			if (node?.kind !== "job") {
				return;
			}
			const uri = JobDetailsProvider.uriFor(jobId(node.job));
			// Re-read first: the document is cached by VS Code, and a
			// job reopened after it changed would otherwise show what it
			// looked like the first time.
			details.refresh(jobId(node.job));
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
		vscode.commands.registerCommand("htcondor.openTerminal", async (node?: JobNode) => {
			if (node?.kind !== "job") {
				return;
			}
			if (!(await ensureSession())) {
				return;
			}
			const id = jobId(node.job);
			vscode.window
				.createTerminal({
					name: `HTCondor ${id}`,
					pty: new JobTerminal(serverUrl(), () => auth.token(), id),
				})
				.show();
		}),
		vscode.commands.registerCommand("htcondor.showLogs", (node?: JobNode) => {
			if (node?.kind === "job") {
				logs.show(jobId(node.job));
			}
		}),
		// createTreeView rather than registerTreeDataProvider, for the
		// message bar: an empty tree alone cannot say whether the queue
		// is empty, the view has never asked, or asking failed.
		jobsView,
		jobs.onDidChangeState((state) => {
			const message = jobsMessage(state);
			// Assigned conditionally because the typing forbids
			// undefined, while clearing the bar is exactly what a
			// successful load should do.
			if (message === undefined) {
				delete (jobsView as { message?: string }).message;
			} else {
				jobsView.message = message;
			}
		}),
		vscode.commands.registerCommand("htcondor.refreshJobs", () => jobs.refresh()),
		vscode.commands.registerCommand("htcondor.switchAccessPoint", () => switchAccessPoint(current)),
		vscode.commands.registerCommand("htcondor.addAccessPoint", () =>
			addAccessPointCommand(current, jobs, output, setContext)
		),
		vscode.commands.registerCommand("htcondor.removeAccessPoint", () =>
			removeAccessPointCommand(current, auth, certificates, output)
		),
		vscode.commands.registerCommand("htcondor.signIn", async () => {
			// force: an explicit click is a new decision, and VS Code
			// would otherwise honour a remembered Cancel by doing
			// nothing.
			if (await ensureSession(true)) {
				void vscode.window.showInformationMessage("Signed in to HTCondor.");
			}
		}),
		vscode.commands.registerCommand("htcondor.newSession", () =>
			newSession(api, certificates, jobs, output)
		),
		vscode.commands.registerCommand("htcondor.signOut", async () => {
			await auth.signOut();
			// The certificate outlives the session otherwise, and
			// anything that can read it can still reach the user's
			// jobs.
			await certificates.forget();
			await setContext();
			jobs.refresh();
			void vscode.window.showInformationMessage("Signed out of HTCondor.");
		}),
		vscode.commands.registerCommand("htcondor.showExtensionLog", () => output.show(true)),
		vscode.commands.registerCommand("htcondor.setup", () =>
			addAccessPointCommand(current, jobs, output, setContext)
		),
		vscode.commands.registerCommand("htcondor.submit", () => submitActiveEditor(api, jobs, output)),
		vscode.commands.registerCommand("htcondor.connect", () => connect(api, certificates, output)),
		// From the panel: the job is already chosen, so there is
		// nothing to ask. Opening an editor in the job you are looking
		// at is the shortest path this extension has, and making the
		// user retype an id they can see is the easiest way to lose it.
		vscode.commands.registerCommand("htcondor.holdJob", (node?: JobNode) =>
			actOnJob(node, jobs, output, "Hold", (id) => api.holdJob(id))
		),
		vscode.commands.registerCommand("htcondor.releaseJob", (node?: JobNode) =>
			actOnJob(node, jobs, output, "Release", (id) => api.releaseJob(id))
		),
		vscode.commands.registerCommand("htcondor.removeJob", async (node?: JobNode) => {
			if (!node || node.kind !== "job") {
				return;
			}
			// Confirmed, because there is no undo: a removed job is gone
			// from the queue and its sandbox with it.
			const id = jobId(node.job);
			const answer = await vscode.window.showWarningMessage(
				`Remove job ${id}? This cannot be undone.`,
				{ modal: true },
				"Remove"
			);
			if (answer !== "Remove") {
				return;
			}
			return actOnJob(node, jobs, output, "Remove", (job) => api.removeJob(job));
		}),
		vscode.commands.registerCommand("htcondor.connectToJob", (node?: JobNode) => {
			if (!node || node.kind !== "job") {
				return connect(api, certificates, output);
			}
			return connect(api, certificates, output, jobId(node.job));
		})
	);
}

export function deactivate(): void {
	// Nothing: everything is a subscription.
}

/**
 * Open a remote window inside a job.
 *
 * The target is a job id (`12345.0`) or a session (`+work`), which is
 * what the gateway's username field means. An empty answer is the
 * caller's default session, which the gateway starts if they have none.
 */
async function connect(
	api: HTCondorApi,
	certificates: CertificateManager,
	output: vscode.LogOutputChannel,
	chosen?: string
): Promise<void> {
	if (!(await ensureSession())) {
		return;
	}

	const target =
		chosen ??
		(
			await vscode.window.showInputBox({
				title: "Connect to HTCondor",
				prompt: "A job id such as 12345.0, or +name for a session. Leave empty for your default session.",
				placeHolder: "12345.0",
			})
		)?.trim() ??
		"";

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "Preparing an HTCondor session" },
		async () => {
			const ca = await api.certificateAuthority();
			const gateway = resolveGateway(ca.gatewayHost, ca.gatewayPort);
			const paths = await certificates.ensure();

			const alias = aliasFor(api.accessPoint, target);
			const host: HostSpec = {
				alias,
				gatewayHost: gateway.host,
				gatewayPort: gateway.port,
				target,
			};
			const written = await writeSSHConfig(
				storageDir(certificates),
				[host],
				ca.knownHostsLine,
				{ privateKey: paths.privateKey, certificate: paths.certificate },
				vscode.workspace.getConfiguration("remote.SSH").get<string>("configFile")
			);

			// Global, because Remote-SSH reads it in the window it is
			// about to open, which is not this one.
			await vscode.workspace
				.getConfiguration("remote.SSH")
				.update("configFile", written.configFile, vscode.ConfigurationTarget.Global);

			// Reusing this window is the default because it is what VS
			// Code's own "Connect to Host..." does, and a convention the
			// editor already set is worth more than a preference of
			// ours. A new window is a setting away for anyone who wants
			// to keep what they are looking at.
			const inNewWindow =
				vscode.workspace.getConfiguration("htcondor").get<string>("openIn", "currentWindow") === "newWindow";

			output.info(
				`Connecting to ${alias} via ${gateway.host}:${gateway.port} ` +
					`(${inNewWindow ? "new window" : "this window"})`
			);
			await vscode.commands.executeCommand("vscode.newWindow", {
				remoteAuthority: `ssh-remote+${alias}`,
				reuseWindow: !inNewWindow,
			});
		}
	);
}

/**
 * Where the gateway is.
 *
 * Preferring what the access point says leaves room for it to start
 * publishing the address, at which point this needs no setting at all.
 * Until then the setting is the only source, because the server knows
 * the name and does not tell anyone.
 */
function resolveGateway(
	advertisedHost: string | undefined,
	advertisedPort: number | undefined
): { host: string; port: number } {
	const configured = vscode.workspace
		.getConfiguration("htcondor")
		.get<string>("sshGateway", "")
		.trim();

	if (advertisedHost) {
		return { host: advertisedHost, port: advertisedPort ?? 22 };
	}
	if (configured === "") {
		throw new Error(
			"This access point does not publish its SSH gateway address. Set " +
				"`htcondor.sshGateway` to the host you would `ssh` to, for example " +
				"ap.example.edu or ap.example.edu:2222."
		);
	}
	const [host, port] = splitHostPort(configured);
	return { host, port };
}

function splitHostPort(value: string): [string, number] {
	const bracketed = /^\[(.+)\]:(\d+)$/.exec(value);
	if (bracketed) {
		return [bracketed[1]!, Number(bracketed[2])];
	}
	// Only split on the LAST colon, and only when what follows is a
	// port: a bare IPv6 address is full of colons and none of them
	// separate a port.
	const at = value.lastIndexOf(":");
	if (at > 0 && /^\d+$/.test(value.slice(at + 1)) && !value.slice(0, at).includes(":")) {
		return [value.slice(0, at), Number(value.slice(at + 1))];
	}
	return [value, 22];
}

/**
 * Pick an access point, or add one.
 *
 * A dropdown rather than a setting because moving between access
 * points is a thing people do several times a day, and editing JSON
 * is not. The two housekeeping entries are in the same list so that
 * the first-run case -- an empty list -- still has something to click.
 */
async function switchAccessPoint(current: CurrentAccessPoint): Promise<void> {
	const ADD = "$(add) Add access point\u2026";
	const REMOVE = "$(trash) Remove access point\u2026";
	const configured = current.list();

	const items: vscode.QuickPickItem[] = configured.map((url) => ({
		label: accessPointLabel(url),
		...(url === current.url ? { description: "$(check) in use" } : {}),
		detail: url,
	}));
	if (items.length > 0) {
		items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
	}
	items.push({ label: ADD }, ...(configured.length > 0 ? [{ label: REMOVE }] : []));

	const picked = await vscode.window.showQuickPick(items, {
		title: "HTCondor access point",
		placeHolder: configured.length > 0 ? "Which access point?" : "No access points yet",
	});
	if (!picked) {
		return;
	}
	if (picked.label === ADD) {
		await vscode.commands.executeCommand("htcondor.addAccessPoint");
		return;
	}
	if (picked.label === REMOVE) {
		await vscode.commands.executeCommand("htcondor.removeAccessPoint");
		return;
	}
	if (picked.detail) {
		await current.use(picked.detail);
	}
}

async function addAccessPointCommand(
	current: CurrentAccessPoint,
	jobs: JobsProvider,
	output: vscode.LogOutputChannel,
	refreshContext: () => Promise<void>
): Promise<void> {
	const entered = await vscode.window.showInputBox({
		title: "Add an HTCondor access point",
		prompt: "The address of your access point's web interface.",
		placeHolder: "ap.example.edu",
		ignoreFocusOut: true,
		// Validated as typed, because the address becomes the key
		// everything for this access point is stored under: a typo
		// accepted here is a second, empty account.
		validateInput: (value: string): string | undefined => {
			if (value.trim() === "") {
				return "An address is required.";
			}
			try {
				return insecureAccessPoint(canonicalAccessPoint(value));
			} catch (err: unknown) {
				return describe(err);
			}
		},
	});
	if (entered === undefined || entered.trim() === "") {
		return;
	}

	let url: string;
	try {
		url = canonicalAccessPoint(entered);
	} catch (err: unknown) {
		void vscode.window.showErrorMessage(describe(err));
		return;
	}

	// Checked before it is saved, so a typo is caught here rather than
	// surfacing later as an unrelated-looking failure to sign in.
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Checking the access point" },
			() => discover(url)
		);
	} catch (err: unknown) {
		const answer = await vscode.window.showWarningMessage(describe(err), "Add anyway", "Cancel");
		if (answer !== "Add anyway") {
			return;
		}
	}

	await current.add(url);
	output.info(`Added access point ${url}`);
	await refreshContext();

	// Straight into the sign-in: wanting the address saved and not
	// wanting to sign in is not a real case, and leaving them to find
	// the command themselves is the problem this is fixing.
	if (!(await ensureSession())) {
		return;
	}
	await refreshContext();
	jobs.refresh();
}

async function removeAccessPointCommand(
	current: CurrentAccessPoint,
	auth: HTCondorAuthProvider,
	certificates: CertificateManager,
	output: vscode.LogOutputChannel
): Promise<void> {
	const configured = current.list();
	if (configured.length === 0) {
		void vscode.window.showInformationMessage("There are no HTCondor access points to remove.");
		return;
	}
	const picked = await vscode.window.showQuickPick(
		configured.map((url) => ({ label: accessPointLabel(url), detail: url })),
		{ title: "Remove an HTCondor access point", placeHolder: "Which one?" }
	);
	if (!picked?.detail) {
		return;
	}

	// Its credentials go with it. A token and an SSH key left behind
	// for an access point the user has said they are done with are a
	// credential nobody is going to think to retire.
	await auth.forget(picked.detail);
	await certificates.forgetFor(picked.detail);
	await current.remove(picked.detail);
	output.info(`Removed access point ${picked.detail} and its stored credentials`);
	void vscode.window.showInformationMessage(`Removed ${accessPointLabel(picked.detail)}.`);
}

/**
 * Carry a `htcondor.serverUrl` install into the list, once.
 *
 * Guarded by a flag rather than by the setting being empty, so that
 * removing the access point afterwards sticks instead of being undone
 * on the next window.
 */
async function adoptLegacySetting(
	context: vscode.ExtensionContext,
	current: CurrentAccessPoint,
	output: vscode.LogOutputChannel
): Promise<void> {
	const DONE = "htcondor.migratedServerUrl";
	if (context.globalState.get<boolean>(DONE)) {
		return;
	}
	const legacy = vscode.workspace.getConfiguration("htcondor").get<string>("serverUrl", "").trim();
	try {
		if (legacy !== "") {
			const url = await current.add(legacy);
			const moved = await migrateUnscopedSecrets(context.secrets, url, [TOKENS_KEY, CLIENT_SECRET_KEY]);
			output.info(
				`Adopted htcondor.serverUrl as ${url}` +
					(moved.length > 0 ? ` and kept you signed in to it` : "")
			);
		}
		await context.globalState.update(DONE, true);
	} catch (err: unknown) {
		// A bad legacy value should not stop the extension; the user
		// can add an access point by hand.
		output.warn(`Could not adopt htcondor.serverUrl: ${describe(err)}`);
	}
}


function storageDir(certificates: CertificateManager): string {
	// The certificate manager already owns this directory; the config
	// belongs beside the key it names.
	return certificates.paths.privateKey.replace(/[/\\][^/\\]+$/, "");
}

function secretKeyStore(context: vscode.ExtensionContext): KeyStore {
	return {
		get: (key) => Promise.resolve(context.secrets.get(key)),
		store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
		delete: (key) => Promise.resolve(context.secrets.delete(key)),
	};
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Run one action against the job a tree node names.
 *
 * Refreshes afterwards either way. A panel still showing "Held" after a
 * successful release is worse than a slow one: the user tries again,
 * and the second attempt fails on a job that was never held.
 */
async function actOnJob(
	node: JobNode | undefined,
	jobs: JobsProvider,
	output: vscode.LogOutputChannel,
	verb: string,
	act: (id: string) => Promise<void>
): Promise<void> {
	if (!node || node.kind !== "job") {
		return;
	}
	const id = jobId(node.job);
	try {
		await act(id);
		output.info(`${verb} ${id}`);
	} catch (err: unknown) {
		// Shown, not just logged: this one the user asked for, so a
		// silent failure would leave them believing it worked.
		void vscode.window.showErrorMessage(`Could not ${verb.toLowerCase()} job ${id}: ${describe(err)}`);
	} finally {
		jobs.refresh();
	}
}

/**
 * Submit the submit file in the active editor.
 *
 * Warns first when the job would spool-hold. The queue accepts a
 * submission that needs an upload and then holds it indefinitely, so a
 * command that only reported the 2xx would be reporting a success the
 * user does not have.
 */
async function submitActiveEditor(
	api: HTCondorApi,
	jobs: JobsProvider,
	output: vscode.LogOutputChannel
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showErrorMessage("Open a submit file first.");
		return;
	}
	if (!(await ensureSession())) {
		return;
	}

	const text = editor.document.getText();
	const warning = submitWarning(planSubmit(text));
	if (warning) {
		const answer = await vscode.window.showWarningMessage(warning, "Submit anyway", "Cancel");
		if (answer !== "Submit anyway") {
			return;
		}
	}

	try {
		const result = await api.submit(text);
		const what = result.jobIds.length === 1 ? `job ${result.jobIds[0]}` : `cluster ${result.clusterId}`;
		output.info(`Submitted ${what}`);
		void vscode.window.showInformationMessage(`Submitted ${what}.`);
	} catch (err: unknown) {
		void vscode.window.showErrorMessage(`Could not submit: ${describe(err)}`);
	} finally {
		jobs.refresh();
	}
}

/**
 * Start an interactive session and offer to open it.
 *
 * A session is a job that exists to be connected to. Creating one and
 * leaving the user to find it in the tree would be most of a feature:
 * the thing they wanted was to be inside it, so this waits for it to
 * start and then offers the two ways in.
 */
async function newSession(
	api: HTCondorApi,
	certificates: CertificateManager,
	jobs: JobsProvider,
	output: vscode.LogOutputChannel
): Promise<void> {
	if (!(await ensureSession())) {
		return;
	}

	const picked = await vscode.window.showQuickPick(
		[
			...PRESETS.map((p) => ({ label: p.label, detail: p.detail, spec: p.spec })),
			{ label: "Custom…", detail: "Say what you need, e.g. 4 cpus, 16 GB", spec: undefined },
		],
		{ title: "New interactive session", placeHolder: "How big?" }
	);
	if (!picked) {
		return;
	}

	let spec: SessionSpec | undefined = picked.spec;
	if (!spec) {
		const typed = await vscode.window.showInputBox({
			title: "Session size",
			prompt: "CPUs, memory and GPUs, in any order.",
			placeHolder: "4 cpus, 16 GB",
			// Validated as typed, so an unreadable size is caught here
			// rather than silently becoming the server's defaults.
			validateInput: (value) =>
				value.trim() === "" || parseSize(value) ? undefined : "Try something like `4 cpus, 16 GB`.",
		});
		if (typed === undefined) {
			return;
		}
		spec = parseSize(typed) ?? {};
	}

	// Everything inside is wrapped, because a rejected command promise
	// is reported nowhere a user will look: the progress notification
	// simply disappears and the extension appears to have done
	// nothing. That is exactly how a wrong response key hid for a
	// whole evening.
	let created;
	try {
		created = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Starting a session", cancellable: true },
			async (progress, cancel) => {
				progress.report({ message: describeSpec(spec) });
				const session = await api.createSession(spec);
				output.info(`Created session ${session.jobId} (${describeSpec(spec)})`);
				jobs.refresh();

				// Waiting here rather than returning immediately,
				// because the queue wait is the whole cost of a session
				// and a user who is told "created" has no idea whether
				// to act.
				progress.report({ message: `${session.jobId} is queued` });
				const ready = await waitForSession(api, session.jobId, progress, cancel, output);
				jobs.refresh();
				return ready ? session : undefined;
			}
		);
	} catch (err: unknown) {
		await report(output, "Could not start a session", err);
		return;
	}
	if (!created) {
		return;
	}

	const answer = await vscode.window.showInformationMessage(
		`Session ${created.jobId} is running.`,
		"Open a window",
		"Open a shell"
	);
	if (answer === "Open a window") {
		await connect(api, certificates, output, created.jobId);
	} else if (answer === "Open a shell") {
		await vscode.commands.executeCommand("htcondor.openTerminal", {
			kind: "job",
			job: { cluster: created.cluster, proc: created.proc, status: 2 },
		});
	}
}

/**
 * Poll until a session runs, is stuck, or the user gives up.
 *
 * Reports what it is waiting for rather than spinning silently: a
 * queue wait with no explanation is indistinguishable from a hang, and
 * a held session would otherwise be waited on forever.
 */
async function waitForSession(
	api: HTCondorApi,
	jobId: string,
	progress: vscode.Progress<{ message?: string }>,
	cancel: vscode.CancellationToken,
	output: vscode.LogOutputChannel
): Promise<boolean> {
	// Bounded. An unbounded poll is indistinguishable from a hang, and
	// when the thing being polled for can never appear -- a job that
	// vanished, a response this client misreads -- it IS one.
	const deadlineMs = 20 * 60 * 1000;
	const started = Date.now();
	let everSeen = false;

	for (let attempt = 0; !cancel.isCancellationRequested; attempt++) {
		const elapsed = Math.round((Date.now() - started) / 1000);
		if (Date.now() - started > deadlineMs) {
			await report(
				output,
				`Session ${jobId} has not started after ${Math.round(deadlineMs / 60000)} minutes`,
				everSeen
					? new Error("It is still queued. It will keep waiting; connect from the Jobs view when it starts.")
					: new Error(`It never appeared in this access point's session list, which may mean the request succeeded but something else is wrong.`)
			);
			return false;
		}

		let sessions;
		try {
			sessions = await api.listSessions();
		} catch (err: unknown) {
			// Logged and retried: a blip while waiting is not a reason
			// to abandon a session that is probably still coming.
			output.warn(`Could not list sessions while waiting for ${jobId}: ${describe(err)}`);
			await pause(3_000);
			continue;
		}

		const session = sessions.find((s) => s.jobId === jobId);
		if (session) {
			everSeen = true;
			if (isReady(session.status)) {
				return true;
			}
			if (isStuck(session.status, session.holdReasonCode)) {
				await report(
					output,
					`Session ${jobId} stopped before it started`,
					new Error(session.holdReason || "It was held, removed or finished.")
				);
				return false;
			}
			progress.report({ message: `${jobId} is waiting for a slot (${elapsed}s)` });
		} else {
			// Said out loud rather than shown as a bare title. A
			// notification that never changes reads as a hang.
			progress.report({ message: `waiting for ${jobId} to appear (${elapsed}s)` });
			if (attempt === 5) {
				output.warn(
					`${jobId} has not appeared in the session list after ${elapsed}s. ` +
						`The session was created, so this is most likely a problem reading the list.`
				);
			}
		}
		await pause(3_000);
	}
	// Cancelled. The session is left alone on purpose -- it is still
	// queued, and the user can connect to it from the tree when it
	// starts.
	return false;
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the user something failed, and give them the log.
 *
 * Every failure path goes through here. An error shown without a way
 * to see the detail leaves the user with "it did not work" and nothing
 * to do about it -- and the log channel is not somewhere anybody finds
 * by accident.
 */
async function report(output: vscode.LogOutputChannel, what: string, err: unknown): Promise<void> {
	const detail = describe(err);
	output.error(`${what}: ${detail}`);
	const answer = await vscode.window.showErrorMessage(`${what}: ${detail}`, "Show log");
	if (answer === "Show log") {
		output.show(true);
	}
}

/**
 * Get a session, asking for one if there is none.
 *
 * Returns false when the user declined, which is a normal answer and
 * not an error: every caller simply stops.
 *
 * The scopes are passed rather than left empty, because VS Code
 * matches a stored session against them before deciding whether to
 * prompt. An empty list matches anything, including a session granted
 * under a scope list this version no longer uses -- which is how
 * "Sign in" came to do nothing at all.
 */
async function ensureSession(force = false): Promise<boolean> {
	try {
		// forceNewSession for an explicit click, createIfNone otherwise.
		//
		// VS Code remembers that a prompt was dismissed and will then
		// quietly answer "no session" to createIfNone rather than
		// asking again -- so after one Cancel, the Sign in button did
		// nothing at all, which looks like a broken button rather than
		// a remembered decision. An explicit click is a new decision
		// and says so.
		const session = await vscode.authentication.getSession(
			AUTH_PROVIDER_ID,
			SCOPES,
			force ? { forceNewSession: true } : { createIfNone: true }
		);
		return session !== undefined;
	} catch (err: unknown) {
		// Cancelling is not a failure worth a dialog -- the user just
		// said no -- but anything else is worth seeing.
		const message = err instanceof Error ? err.message : String(err);
		if (!/cancel/i.test(message)) {
			void vscode.window.showErrorMessage(`Could not sign in: ${message}`);
		}
		return false;
	}
}
