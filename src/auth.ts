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
import { StoredTokens, TokenStore } from "./tokens";
import { http } from "./http";

export const AUTH_PROVIDER_ID = "htcondor";
const CLIENT_SECRET_KEY = "htcondor.oauth2.client";

export class HTCondorAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this.changed.event;

	private discovery: Discovery | undefined;
	private readonly tokens: TokenStore;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly serverUrl: () => string
	) {
		this.tokens = new TokenStore(secrets, (refreshToken) => this.refresh(refreshToken));
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
		const stored = await this.tokens.read();
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

	async removeSession(_sessionId: string): Promise<void> {
		const stored = await this.tokens.read();
		await this.tokens.clear();
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
		const before = await this.tokens.read();
		try {
			return await this.tokens.token();
		} catch (err: unknown) {
			// The store clears a grant that cannot be refreshed. Saying
			// so here is what turns a dead session into a visible one:
			// the accounts menu drops it, and the view flips to "Sign
			// in" instead of looking signed in and failing everything.
			if (before && !(await this.tokens.read())) {
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
			return this.toSession(await this.tokens.write(exchanged, account));
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
		this.discovery ??= await discover(this.serverUrl());
		return this.discovery;
	}

	private async client(discovery: Discovery): Promise<ClientCredentials> {
		const raw = await this.secrets.get(CLIENT_SECRET_KEY);
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
		await this.secrets.store(CLIENT_SECRET_KEY, JSON.stringify(credentials));
		return credentials;
	}

	private toSession(stored: StoredTokens): vscode.AuthenticationSession {
		return {
			// Stable, so VS Code treats a refreshed token as the same
			// session rather than a new account appearing each time.
			id: AUTH_PROVIDER_ID,
			accessToken: stored.accessToken,
			account: { id: stored.account, label: stored.account },
			scopes: SCOPES,
		};
	}
}
