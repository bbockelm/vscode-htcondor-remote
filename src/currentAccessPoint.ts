// Which access point this window is pointed at.
//
// Per window rather than per machine, deliberately: having one window
// on a production access point and another on a test one is a normal
// way to work, and a setting shared by every window cannot do it. What
// is remembered globally is only the last choice, so a new window opens
// where the last one was.

import * as vscode from "vscode";

import {
	accessPointLabel,
	addAccessPoint,
	canonicalAccessPoint,
	chooseAccessPoint,
	readAccessPoints,
	removeAccessPoint,
	sameAccessPoint,
} from "./accessPoints";

export const ACCESS_POINTS_SETTING = "accessPoints";
export const LAST_USED_KEY = "htcondor.lastAccessPoint";

export class CurrentAccessPoint implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<string | undefined>();
	/** Fires with the access point now in force, or undefined when there is none. */
	readonly onDidChange = this.changed.event;

	private active: string | undefined;
	private readonly status: vscode.StatusBarItem;

	constructor(private readonly memento: vscode.Memento) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.status.command = "htcondor.switchAccessPoint";
		this.active = chooseAccessPoint(this.list(), this.memento.get<string>(LAST_USED_KEY));
		this.render();
	}

	dispose(): void {
		this.status.dispose();
		this.changed.dispose();
	}

	/** Every access point configured, canonical and in order. */
	list(): string[] {
		return readAccessPoints(
			vscode.workspace.getConfiguration("htcondor").get<string[]>(ACCESS_POINTS_SETTING, [])
		);
	}

	get url(): string | undefined {
		return this.active;
	}

	/** The access point, or a message naming what the user has to do about it. */
	require(): string {
		if (!this.active) {
			throw new Error("No access point yet. Run “HTCondor: Add Access Point” to add one.");
		}
		return this.active;
	}

	/** Point this window at one of the configured access points. */
	async use(url: string): Promise<void> {
		const canonical = canonicalAccessPoint(url);
		if (this.active && sameAccessPoint(this.active, canonical)) {
			return;
		}
		this.active = canonical;
		await this.memento.update(LAST_USED_KEY, canonical);
		this.render();
		this.changed.fire(canonical);
	}

	/** Add one to the configured list and switch to it. */
	async add(url: string): Promise<string> {
		const canonical = canonicalAccessPoint(url);
		await this.write(addAccessPoint(this.list(), canonical));
		await this.use(canonical);
		return canonical;
	}

	async remove(url: string): Promise<void> {
		await this.write(removeAccessPoint(this.list(), url));
		if (this.active && sameAccessPoint(this.active, url)) {
			this.active = chooseAccessPoint(this.list());
			await this.memento.update(LAST_USED_KEY, this.active);
			this.render();
			this.changed.fire(this.active);
		}
	}

	/**
	 * Catch up with a list edited behind our back.
	 *
	 * The setting is a plain array of strings and people edit
	 * settings. A window pointed at an access point that is no longer
	 * in the list would otherwise keep using it, with nothing in the
	 * UI offering to put it back.
	 */
	async reconcile(): Promise<void> {
		const list = this.list();
		const stillThere = this.active && list.some((entry) => sameAccessPoint(entry, this.active as string));
		if (stillThere) {
			this.render();
			return;
		}
		this.active = chooseAccessPoint(list, this.memento.get<string>(LAST_USED_KEY));
		this.render();
		this.changed.fire(this.active);
	}

	private async write(list: readonly string[]): Promise<void> {
		// Global: an access point is an account you have, not a
		// property of the folder that happens to be open.
		await vscode.workspace
			.getConfiguration("htcondor")
			.update(ACCESS_POINTS_SETTING, [...list], vscode.ConfigurationTarget.Global);
	}

	private render(): void {
		if (this.active) {
			this.status.text = `$(server) ${accessPointLabel(this.active)}`;
			this.status.tooltip = `HTCondor access point: ${this.active}\nClick to switch.`;
		} else {
			this.status.text = "$(server) HTCondor: add an access point";
			this.status.tooltip = "No HTCondor access point configured. Click to add one.";
		}
		this.status.show();
	}
}
