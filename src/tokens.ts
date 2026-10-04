// Where the tokens live, and when they are replaced.
//
// Separated from the VS Code authentication provider so it can be
// tested: the refresh path has a failure mode that only shows up under
// concurrency, and reproducing it inside an editor is not practical.

import { TokenError, Tokens } from "./oauth2";

/** The slice of vscode.SecretStorage this needs. */
export interface SecretStore {
	get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
	store(key: string, value: string): Thenable<void> | Promise<void>;
	delete(key: string): Thenable<void> | Promise<void>;
}

export interface StoredTokens {
	accessToken: string;
	refreshToken?: string;
	/** ISO 8601. A Date does not survive JSON. */
	expiresAt?: string;
	account: string;
}

/**
 * The prefix tokens are stored under. One access point's tokens go
 * under `${TOKENS_KEY}:${its canonical URL}`: they are not
 * interchangeable, and offering one access point a token another
 * minted is the mistake a single key invited.
 */
export const TOKENS_KEY = "htcondor.oauth2.tokens";

/**
 * Replace a token this long before it expires.
 *
 * A minute: unlike the SSH certificate, this is refreshed on the path
 * that uses it, so the window only has to cover the request in flight
 * rather than a laptop that was asleep.
 */
export const REFRESH_BEFORE_MS = 60 * 1000;

export class TokenStore {
	private inFlight: Promise<string> | undefined;

	constructor(
		private readonly secrets: SecretStore,
		private readonly refresh: (refreshToken: string) => Promise<{ tokens: Tokens; account: string }>,
		private readonly now: () => number = () => Date.now(),
		/** Which access point's tokens these are. */
		private readonly key: string = TOKENS_KEY
	) {}

	async read(): Promise<StoredTokens | undefined> {
		const raw = await this.secrets.get(this.key);
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw) as StoredTokens;
		} catch {
			// Unreadable storage is not a reason to wedge. Treated as
			// signed out, which the user can fix by signing in; throwing
			// would leave them with an extension that fails every
			// command and no way to clear it.
			return undefined;
		}
	}

	async write(tokens: Tokens, account: string, fallbackRefresh?: string): Promise<StoredTokens> {
		// A refresh response may omit the refresh token, meaning "keep
		// the one you have". Dropping it would end the session at the
		// next expiry, which looks like a server that logs you out
		// every hour.
		const refresh = tokens.refreshToken ?? fallbackRefresh;
		const stored: StoredTokens = {
			accessToken: tokens.accessToken,
			...(refresh ? { refreshToken: refresh } : {}),
			...(tokens.expiresAt ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
			account,
		};
		await this.secrets.store(this.key, JSON.stringify(stored));
		return stored;
	}

	async clear(): Promise<void> {
		await this.secrets.delete(this.key);
	}

	/**
	 * A usable access token, refreshed if it is about to expire.
	 *
	 * Deliberately does NOT start a sign-in. A background renewal that
	 * opens a browser is worse than an error; the caller knows whether
	 * the user is there to answer it.
	 */
	async token(): Promise<string> {
		const stored = await this.read();
		if (!stored) {
			throw new Error("Not signed in to HTCondor.");
		}

		const expiresAt = stored.expiresAt ? Date.parse(stored.expiresAt) : undefined;
		const expiring =
			expiresAt !== undefined && !Number.isNaN(expiresAt) && expiresAt - this.now() < REFRESH_BEFORE_MS;
		if (!expiring) {
			return stored.accessToken;
		}
		if (!stored.refreshToken) {
			throw new Error("This HTCondor sign-in has expired. Sign in again to continue.");
		}

		// One refresh at a time, and the reason is not efficiency.
		// A refresh token is single-use on most servers: two callers
		// refreshing at once each spend it, and the second spend fails
		// -- which presents as an expired session on a perfectly good
		// one, at the exact moment the user did two things at once.
		this.inFlight ??= this.doRefresh(stored.refreshToken).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async doRefresh(refreshToken: string): Promise<string> {
		let result;
		try {
			result = await this.refresh(refreshToken);
		} catch (err: unknown) {
			// A grant that cannot be refreshed is cleared, not kept.
			// Keeping it means every call from here on fails the same
			// way for ever -- which is what it did: a warning in a log
			// nobody had found, every two and a half minutes, with
			// nothing in the UI suggesting the one thing that fixes it.
			if (err instanceof TokenError && err.fatal) {
				await this.clear();
			}
			throw err;
		}
		await this.write(result.tokens, result.account, refreshToken);
		return result.tokens.accessToken;
	}
}
