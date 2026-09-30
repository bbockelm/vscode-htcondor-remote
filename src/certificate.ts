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

import { createPublicKey } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HTCondorApi } from "./api";
import { encodePublicKey, generateKeyPair } from "./openssh";

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
}

const PRIVATE_KEY_SECRET = "htcondor.ssh.privateKey";

/** Shows up in the gateway's logs, which is its only purpose. */
const KEY_COMMENT = "vscode-htcondor-remote";

/**
 * How long before expiry a certificate is replaced.
 *
 * An hour, against a 12-hour certificate. The window has to cover a
 * laptop that was asleep and a connection that outlives the credential
 * it was opened with: ssh reads these files when it connects, so a
 * certificate that expires mid-session does not break the session, only
 * the next reconnect -- which is exactly when the user is least willing
 * to deal with it.
 */
const RENEW_BEFORE_MS = 60 * 60 * 1000;

export class CertificateManager {
	private validBefore: Date | undefined;

	constructor(
		private readonly api: HTCondorApi,
		private readonly keys: KeyStore,
		private readonly storageDir: string,
		private readonly now: () => Date = () => new Date()
	) {}

	get paths(): CertificatePaths {
		return {
			privateKey: join(this.storageDir, "id_ecdsa"),
			certificate: join(this.storageDir, "id_ecdsa-cert.pub"),
			knownHosts: join(this.storageDir, "known_hosts"),
		};
	}

	/**
	 * Make sure a valid certificate is on disk, and say where it is.
	 *
	 * Cheap to call before every connection, which is the intended use:
	 * it does nothing when the certificate on hand is still good.
	 */
	async ensure(): Promise<CertificatePaths> {
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
		let privateKeyPem = await this.keys.get(PRIVATE_KEY_SECRET);
		let publicKeyLine: string | undefined;
		if (!privateKeyPem) {
			const pair = generateKeyPair(KEY_COMMENT);
			privateKeyPem = pair.privateKeyPem;
			publicKeyLine = pair.publicKeyLine;
			await this.keys.store(PRIVATE_KEY_SECRET, privateKeyPem);
		} else {
			publicKeyLine = publicKeyFromPrivate(privateKeyPem);
		}

		const [ca, cert] = await Promise.all([
			this.api.certificateAuthority(),
			this.api.signCertificate(publicKeyLine),
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
		return paths;
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
