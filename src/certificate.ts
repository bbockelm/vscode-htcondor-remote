// Keeping a usable SSH certificate on disk, so `ssh` never prompts.
//
// This is the piece that makes the remote session bearable. The gateway
// authenticates a bare `ssh` with an OAuth2 device code, which works and
// is unusable through Remote-SSH: the challenge goes to the ssh
// process's stderr, where a user finds it only by opening the Output
// panel and picking the right channel. Tested by hand on 2026-09-30, and
// the first person to try it had to fish the URL out of a log.
//
// A certificate moves that prompt to where it belongs -- VS Code's own
// sign-in UI, once -- and every connection after it is silent.
//
// The certificates are SHORT-LIVED and continuously renewed, which is
// the whole reason this approach is defensible. The gateway has no
// revocation: no CRL, no OCSP, no list to add a stolen key to. A
// twelve-hour certificate is therefore a twelve-hour credential sitting
// in a file, and its lifetime is the only control over it. At fifteen
// minutes the lifetime IS the revocation, and what is on disk is worth
// little more than the minutes left on it.
//
// `lifetime_seconds` is honoured by the server for any positive value
// and clamped only at the top, so asking for less costs nothing and
// needs no server change.

import { createPublicKey } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HTCondorApi } from "./api";
import { encodePublicKey, generateKeyPair } from "./openssh";
import { accessPointSlug, scopedKey } from "./accessPoints";

/** Where the files live and what they are called. */
export interface CertificatePaths {
	privateKey: string;
	certificate: string;
	knownHosts: string;
}

/** Somewhere to keep a private key between sessions. */
export interface KeyStore {
	get(key: string): Promise<string | undefined>;
	store(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

const PRIVATE_KEY_SECRET = "htcondor.ssh.privateKey";

/** Shows up in the gateway's logs, which is its only purpose. */
const KEY_COMMENT = "vscode-htcondor-remote";

/**
 * How long a certificate is asked to last.
 *
 * Fifteen minutes. Short enough that a copy taken off disk is worth
 * little, long enough that renewing it is not a conversation with the
 * server every few seconds. The server clamps only upwards, so this is
 * honoured exactly.
 */
export const LIFETIME_SECONDS = 15 * 60;

/**
 * How long before expiry a certificate is replaced.
 *
 * A third of its life. ssh reads these files when it connects, so a
 * certificate that lapses mid-session does not break the session -- it
 * breaks the next RECONNECT, which is when the user is least willing to
 * deal with it, and Remote-SSH reconnects on its own.
 *
 * A third rather than a half because the renewal that matters most is
 * the one after a laptop wakes up: nothing fires while it sleeps, so
 * the margin has to survive a timer that is late rather than punctual.
 */
const RENEW_BEFORE_MS = Math.floor((LIFETIME_SECONDS / 3) * 1000);

/**
 * How often to check, for a caller driving this on a timer.
 *
 * Shorter than the renewal window, so an ordinary tick is early rather
 * than exactly on time.
 */
export const CHECK_INTERVAL_MS = Math.floor((LIFETIME_SECONDS / 6) * 1000);

export class CertificateManager {
	private validBefore: Date | undefined;
	/** The access point the cached expiry above belongs to. */
	private issuedBy: string | undefined;

	constructor(
		private readonly api: HTCondorApi,
		private readonly keys: KeyStore,
		private readonly baseDir: string,
		private readonly now: () => Date = () => new Date(),
		/**
		 * Which access point this is for. A certificate is signed by
		 * one access point's CA and names an account on it, and its
		 * known_hosts holds that CA alone, so none of these files can
		 * be shared with another.
		 */
		private readonly accessPoint: () => string = () => ""
	) {}

	private get storageDir(): string {
		const slug = accessPointSlug(this.accessPoint());
		return slug === "" ? this.baseDir : join(this.baseDir, slug);
	}

	get paths(): CertificatePaths {
		const dir = this.storageDir;
		return {
			privateKey: join(dir, "id_ecdsa"),
			certificate: join(dir, "id_ecdsa-cert.pub"),
			knownHosts: join(dir, "known_hosts"),
		};
	}

	/**
	 * Make sure a valid certificate is on disk, and say where it is.
	 *
	 * Cheap to call before every connection, which is the intended use:
	 * it does nothing when the certificate on hand is still good.
	 */
	async ensure(): Promise<CertificatePaths> {
		// A certificate from the access point we were pointed at a
		// moment ago is not a certificate for this one, however long
		// it has left to run.
		if (this.issuedBy !== this.accessPoint()) {
			this.validBefore = undefined;
		}
		if (this.validBefore && this.validBefore.getTime() - this.now().getTime() > RENEW_BEFORE_MS) {
			return this.paths;
		}
		return this.renew();
	}

	/** Get a fresh certificate whatever the state of the current one. */
	async renew(): Promise<CertificatePaths> {
		const paths = this.paths;
		await mkdir(this.storageDir, { recursive: true, mode: 0o700 });

		// The key outlives the certificate. Rotating it on every renewal
		// would be churn without a benefit: it never leaves this machine,
		// and what expires -- the thing that actually carries the
		// account name -- is the certificate over it.
		const keySecret =
			this.accessPoint() === "" ? PRIVATE_KEY_SECRET : scopedKey(PRIVATE_KEY_SECRET, this.accessPoint());
		let privateKeyPem = await this.keys.get(keySecret);
		let publicKeyLine: string | undefined;
		if (!privateKeyPem) {
			const pair = generateKeyPair(KEY_COMMENT);
			privateKeyPem = pair.privateKeyPem;
			publicKeyLine = pair.publicKeyLine;
			await this.keys.store(keySecret, privateKeyPem);
		} else {
			publicKeyLine = publicKeyFromPrivate(privateKeyPem);
		}

		const [ca, cert] = await Promise.all([
			this.api.certificateAuthority(),
			this.api.signCertificate(publicKeyLine, LIFETIME_SECONDS),
		]);

		// chmod as well as the mode argument, because writeFile applies
		// its mode only when it CREATES the file. Overwriting an
		// existing key leaves whatever mode that file already had, so a
		// key written by an older version -- or by anything else that
		// got there first -- keeps its permissions through every
		// renewal. ssh refuses a private key others can read, which
		// turns that into a connection failure nobody can explain.
		await writeFile(paths.privateKey, privateKeyPem, { mode: 0o600 });
		await chmod(paths.privateKey, 0o600);
		await writeFile(paths.certificate, `${cert.certificate}\n`, { mode: 0o600 });
		await writeFile(paths.knownHosts, `${ca.knownHostsLine}\n`, { mode: 0o600 });

		this.validBefore = cert.validBefore;
		this.issuedBy = this.accessPoint();
		return paths;
	}

	/**
	 * Remove the key and certificate from disk.
	 *
	 * Signing out should not leave a usable credential behind. The
	 * certificate outlives the session otherwise -- up to its full
	 * lifetime -- and anything that can read the file can still open a
	 * shell in the user's jobs with it.
	 */
	/**
	 * Remove the key and certificate held for another access point.
	 *
	 * For one being removed from the list, which is usually not the
	 * one in force.
	 */
	async forgetFor(accessPoint: string): Promise<void> {
		const dir = join(this.baseDir, accessPointSlug(accessPoint));
		await Promise.all([
			this.keys.delete(scopedKey(PRIVATE_KEY_SECRET, accessPoint)),
			rm(dir, { recursive: true, force: true }),
		]);
		if (this.issuedBy === accessPoint) {
			this.validBefore = undefined;
			this.issuedBy = undefined;
		}
	}

	async forget(): Promise<void> {
		this.validBefore = undefined;
		const paths = this.paths;
		await Promise.all(
			[paths.privateKey, paths.certificate, paths.knownHosts].map(async (file) => {
				try {
					await rm(file, { force: true });
				} catch {
					// Best effort. A file that cannot be removed is
					// worth neither failing the sign-out nor a dialog.
				}
			})
		);
	}

	/** When the certificate on hand expires, if there is one. */
	get expiresAt(): Date | undefined {
		return this.validBefore;
	}
}

/** Recover the authorized_keys line for a private key we stored earlier. */
function publicKeyFromPrivate(privateKeyPem: string): string {
	return encodePublicKey(createPublicKey(privateKeyPem), KEY_COMMENT);
}
