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
	SCOPES,
} from "./oauth2";
import { StoredTokens, TokenStore } from "./tokens";

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

	async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		const stored = await this.tokens.read();
		if (!stored) {
			return [];
		}
		return [this.toSession(stored)];
	}

	async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		const session = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "Signing in to HTCondor", cancellable: true },
			(_progress, cancel) => this.signIn(cancel)
		);
		this.changed.fire({ added: [session], removed: [], changed: [] });
		return session;
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
		return this.tokens.token();
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
			const response = await fetch(new URL("/api/v1/whoami", this.serverUrl()), {
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
			return JSON.parse(raw) as ClientCredentials;
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
