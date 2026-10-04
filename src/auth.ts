// The VS Code side of signing in.
//
// Everything protocol-shaped lives in oauth2.ts, without a VS Code
// dependency, so it can be tested against a real loopback redirect.
// What is here is the part that only makes sense inside an editor:
// where the tokens are kept, how the browser is opened, and how a
// session is presented to the user.
//
// This is also the answer to the finding that started the design over:
// the gateway's device-code prompt works and is unusable through
// Remote-SSH, because it renders into the ssh process's stderr where
// nobody looks. A sign-in belongs in the editor's own account UI, once,
// and every connection after it should be silent.

import * as vscode from "vscode";

import {
	ClientCredentials,
	Discovery,
	Tokens,
	authorizationUrl,
	awaitRedirect,
	discover,
	exchangeCode,
	pkce,
	refreshTokens,
	register,
	registrationIsCurrent,
	SCOPES,
	sessionCoversScopes,
} from "./oauth2";
import { StoredTokens, TOKENS_KEY, TokenStore } from "./tokens";
import { accessPointLabel, canonicalAccessPoint, sameAccessPoint, scopedKey } from "./accessPoints";
import { http } from "./http";

export const AUTH_PROVIDER_ID = "htcondor";
export const CLIENT_SECRET_KEY = "htcondor.oauth2.client";

export class HTCondorAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changed.event;

	private discovery: Discovery | undefined;
	/** The access point the three fields above and below belong to. */
	private accessPoint: string | undefined;
	private tokens: TokenStore | undefined;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly serverUrl: () => string
	) {}

	/**
	 * The access point in force, or undefined when there is none
	 * configured yet.
	 *
	 * Undefined rather than a throw: "no access point" is the state a
	 * fresh install is in, and the view that says so has to be able to
	 * ask whether anyone is signed in without raising.
	 */
	private current(): string | undefined {
		try {
			return canonicalAccessPoint(this.serverUrl());
		} catch {
			return undefined;
		}
	}

	/**
	 * The token store for the access point in force.
	 *
	 * Rebuilt when the access point changes, because the tokens are
	 * stored under it: a token minted by one access point is not a
	 * credential anywhere else, and sending it would at best fail.
	 */
	private store(): TokenStore | undefined {
		const accessPoint = this.current();
		if (!accessPoint) {
			return undefined;
		}
		if (accessPoint !== this.accessPoint || !this.tokens) {
			this.accessPoint = accessPoint;
			this.discovery = undefined;
			this.tokens = new TokenStore(
				this.secrets,
				(refreshToken) => this.refresh(refreshToken),
				undefined,
				scopedKey(TOKENS_KEY, accessPoint)
			);
		}
		return this.tokens;
	}

	/**
	 * Tell the provider the window has moved to another access point.
	 *
	 * `previous` is what getSessions answered before the move, which
	 * is the only way to name what was removed once the move has
	 * happened.
	 */
	async accessPointChanged(previous: readonly vscode.AuthenticationSession[]): Promise<void> {
		this.accessPoint = undefined;
		this.tokens = undefined;
		this.discovery = undefined;
		const added = await this.getSessions(SCOPES);
		this.changed.fire({ added, removed: [...previous], changed: [] });
	}

	dispose(): void {
		this.changed.dispose();
	}

	/**
	 * Sessions matching the requested scopes.
	 *
	 * The scopes argument is honoured, and that is not a formality.
	 * VS Code asks this before prompting: a session returned here is
	 * one it considers usable, so it hands it back and never offers to
	 * sign in. Ignoring the argument meant a session granted under an
	 * older scope list still matched, so after the list changed the
	 * "Sign in" button did nothing visible and every request failed
	 * against a grant that could not serve them.
	 */
	async getSessions(scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const store = this.store();
		if (!store) {
			return [];
		}
		const stored = await store.read();
		if (!stored) {
			return [];
		}
		const session = this.toSession(stored);
		return sessionCoversScopes(session.scopes, scopes ?? []) ? [session] : [];
	}

	async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const session = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Signing in to HTCondor", cancellable: true },
			(_progress, cancel) => this.signIn(cancel)
		);
		this.changed.fire({ added: [session], removed: [], changed: [] });
		return session;
	}

	/**
	 * Sign out, for a caller that is not the accounts menu.
	 *
	 * VS Code offers its own sign-out there, but only once an extension
	 * has asked for the session -- so a user who has not opened
	 * anything yet has no way to undo a sign-in. This is the same
	 * thing, reachable from the view they are already looking at.
	 */
	async signOut(): Promise<void> {
		await this.removeSession(AUTH_PROVIDER_ID);
	}

	/**
	 * Drop everything stored for an access point.
	 *
	 * For an access point being removed, which may not be the one in
	 * force -- so it works from the keys rather than from the current
	 * store.
	 */
	async forget(accessPoint: string): Promise<void> {
		await this.secrets.delete(scopedKey(TOKENS_KEY, accessPoint));
		await this.secrets.delete(scopedKey(CLIENT_SECRET_KEY, accessPoint));
		if (this.accessPoint && sameAccessPoint(this.accessPoint, accessPoint)) {
			this.tokens = undefined;
			this.accessPoint = undefined;
			this.discovery = undefined;
		}
	}

	async removeSession(_sessionId: string): Promise<void> {
		const store = this.store();
		if (!store) {
			return;
		}
		const stored = await store.read();
		await store.clear();
		if (stored) {
			this.changed.fire({ added: [], removed: [this.toSession(stored)], changed: [] });
		}
	}

	/**
	 * A bearer token, refreshed if it is about to expire.
	 *
	 * This is the `TokenSource` the rest of the extension takes. The
	 * lifecycle lives in TokenStore, where it can be tested against
	 * concurrent callers.
	 */
	async token(): Promise<string> {
		const store = this.requireStore();
		const before = await store.read();
		try {
			return await store.token();
		} catch (err: unknown) {
			// The store clears a grant that cannot be refreshed. Saying
			// so here is what turns a dead session into a visible one:
			// the accounts menu drops it, and the view flips to "Sign
			// in" instead of looking signed in and failing everything.
			if (before && !(await store.read())) {
				this.changed.fire({ added: [], removed: [this.toSession(before)], changed: [] });
			}
			throw err;
		}
	}

	private async refresh(refreshToken: string): Promise<{ tokens: Tokens; account: string }> {
		const discovery = await this.resolveDiscovery();
		const client = await this.client(discovery);
		const refreshed = await refreshTokens(discovery, client, refreshToken);
		return { tokens: refreshed, account: await this.accountName(refreshed.accessToken) };
	}

	private async signIn(cancel: vscode.CancellationToken): Promise<vscode.AuthenticationSession> {
		const discovery = await this.resolveDiscovery();
		const client = await this.client(discovery);
		const { verifier, challenge } = pkce();
		const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

		const redirect = await awaitRedirect(state);
		try {
			const url = authorizationUrl(discovery, client, redirect.uri, challenge, state);
			// asExternalUri, not openExternal alone: when the extension
			// host is itself remote -- which it is once the user is
			// inside a job -- the loopback port lives on the wrong
			// machine, and this is what tunnels it back to the browser.
			const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
			if (!(await vscode.env.openExternal(external))) {
				throw new Error("Could not open a browser to sign in.");
			}

			const code = await Promise.race([
				redirect.code,
				new Promise<never>((_resolve, reject) => {
					cancel.onCancellationRequested(() => reject(new Error("Sign-in cancelled.")));
				}),
			]);

			const exchanged = await exchangeCode(discovery, client, code, verifier, redirect.uri);
			const account = await this.accountName(exchanged.accessToken);
			return this.toSession(await this.requireStore().write(exchanged, account));
		} finally {
			redirect.close();
		}
	}

	/** Who the access point says this token belongs to. */
	private async accountName(accessToken: string): Promise<string> {
		try {
			const response = await http()(new URL("/api/v1/whoami", this.serverUrl()), {
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			});
			if (response.ok) {
				const body = (await response.json()) as { user?: string; name?: string };
				const name = body.user ?? body.name;
				if (typeof name === "string" && name !== "") {
					return name;
				}
			}
		} catch {
			// Cosmetic. A session that works but is labelled "HTCondor"
			// is better than a sign-in that fails because a display
			// name could not be fetched.
		}
		return "HTCondor";
	}

	private async resolveDiscovery(): Promise<Discovery> {
		// Through store(), so that a changed access point drops the
		// cached document before it is read rather than after.
		this.requireStore();
		this.discovery ??= await discover(this.serverUrl());
		return this.discovery;
	}

	/** The token store, or a message naming what the user has to do. */
	private requireStore(): TokenStore {
		const store = this.store();
		if (!store) {
			throw new Error("Add an access point first: run \u201cHTCondor: Add Access Point\u201d.");
		}
		return store;
	}

	private async client(discovery: Discovery): Promise<ClientCredentials> {
		// Scoped, because a client registration is issued by one
		// access point's authorization server and means nothing to
		// another's.
		const key = scopedKey(CLIENT_SECRET_KEY, this.accessPoint ?? this.serverUrl());
		const raw = await this.secrets.get(key);
		if (raw) {
			const stored = JSON.parse(raw) as ClientCredentials;
			// A registration that does not cover what this version asks
			// for is re-made rather than reused. A client may not
			// request a scope it did not register, so keeping it would
			// fail at the authorize step with a message naming a scope
			// the user never chose.
			if (registrationIsCurrent(stored)) {
				return stored;
			}
		}
		const credentials = await register(discovery);
		await this.secrets.store(key, JSON.stringify(credentials));
		return credentials;
	}

	private toSession(stored: StoredTokens): vscode.AuthenticationSession {
		// The access point is part of the identity. Two accounts with
		// the same name on two access points are two accounts, and the
		// editor's accounts menu is where a user checks which one they
		// are using.
		const where = this.accessPoint ? accessPointLabel(this.accessPoint) : "";
		const name = where === "" ? stored.account : `${stored.account}@${where}`;
		return {
			// Stable per access point, so VS Code treats a refreshed
			// token as the same session rather than a new account
			// appearing each time.
			id: this.accessPoint ? `${AUTH_PROVIDER_ID}:${this.accessPoint}` : AUTH_PROVIDER_ID,
			accessToken: stored.accessToken,
			account: { id: name, label: name },
			scopes: SCOPES,
		};
	}
}
