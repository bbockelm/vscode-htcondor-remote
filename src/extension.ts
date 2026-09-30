// Activation and wiring.
//
// The shape of the thing: sign in once through VS Code's own account
// UI, hold a short-lived SSH certificate on the strength of that, write
// an ssh config pointing at the access point's gateway, and hand
// Remote-SSH an authority it can already reach. The user meets a normal
// sign-in and then a window that opens. They never meet SSH.

import * as vscode from "vscode";

import { HTCondorApi, jobId } from "./api";
import { AUTH_PROVIDER_ID, HTCondorAuthProvider } from "./auth";
import { CertificateManager, CHECK_INTERVAL_MS, KeyStore } from "./certificate";
import { JobNode } from "./jobsModel";
import { JobsProvider } from "./jobsView";
import { JobLogs } from "./logsView";
import { planSubmit, submitWarning } from "./submit";
import { HostSpec, writeSSHConfig } from "./sshconfig";

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("HTCondor", { log: true });
	context.subscriptions.push(output);

	const serverUrl = (): string => {
		const configured = vscode.workspace.getConfiguration("htcondor").get<string>("serverUrl", "").trim();
		if (configured === "") {
			throw new Error(
				"Set `htcondor.serverUrl` to your access point, for example https://ap.example.edu"
			);
		}
		return configured;
	};

	const auth = new HTCondorAuthProvider(context.secrets, serverUrl);
	context.subscriptions.push(
		auth,
		vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, "HTCondor", auth, {
			supportsMultipleAccounts: false,
		})
	);

	const api = new HTCondorApi(serverUrl(), () => auth.token());
	const certificates = new CertificateManager(api, secretKeyStore(context), context.globalStorageUri.fsPath);

	// Renewal runs on a timer as well as on demand. ssh reads the
	// certificate when it connects, and Remote-SSH reconnects by itself
	// after a network blip or a laptop waking -- at which point nothing
	// in this extension is on the call stack to notice the credential
	// has lapsed.
	const renewal = setInterval(() => {
		void certificates.ensure().catch((err: unknown) => {
			// Logged, not shown. A failed background renewal is not
			// worth a modal; the next connection attempt will surface
			// it with context the user can act on.
			output.warn(`Could not renew the SSH certificate: ${describe(err)}`);
		});
	}, CHECK_INTERVAL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(renewal) });

	const jobs = new JobsProvider(api, output);
	const logs = new JobLogs(api, output);
	context.subscriptions.push(
		logs,
		vscode.commands.registerCommand("htcondor.showLogs", (node?: JobNode) => {
			if (node?.kind === "job") {
				logs.show(jobId(node.job));
			}
		}),
		vscode.window.registerTreeDataProvider("htcondor.jobs", jobs),
		vscode.commands.registerCommand("htcondor.refreshJobs", () => jobs.refresh()),
		vscode.commands.registerCommand("htcondor.signIn", async () => {
			await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { createIfNone: true });
			vscode.window.showInformationMessage("Signed in to HTCondor.");
		}),
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
	await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { createIfNone: true });

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

			const alias = aliasFor(target);
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

			output.info(`Connecting to ${alias} via ${gateway.host}:${gateway.port}`);
			await vscode.commands.executeCommand(
				"vscode.newWindow",
				{ remoteAuthority: `ssh-remote+${alias}`, reuseWindow: false }
			);
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

/** A stable, filesystem-safe Host alias for a target. */
function aliasFor(target: string): string {
	const cleaned = target.replace(/[^A-Za-z0-9._+-]/g, "");
	return `condor-${cleaned === "" ? "default" : cleaned}`;
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
	await vscode.authentication.getSession(AUTH_PROVIDER_ID, [], { createIfNone: true });

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
