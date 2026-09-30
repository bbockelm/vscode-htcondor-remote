// OpenSSH key material, generated and encoded in-process.
//
// The extension has to hand the real `ssh` binary a private key and a
// certificate, and hand the API server a public key in the form its
// certificate endpoint parses. It does all of that itself: shelling out
// to `ssh-keygen` would make the extension depend on software we do not
// ship, which is the one constraint this project will not trade away.
//
// Key type is ECDSA P-256, and that is a compatibility finding rather
// than a preference. Node can emit an ed25519 private key only as
// PKCS#8, and OpenSSH does not read it -- `ssh-keygen -y` on a Node
// ed25519 PKCS#8 PEM answers "invalid format", because OpenSSH
// implements ed25519 natively and stores it only in its own
// `openssh-key-v1` container. Supporting ed25519 would mean writing
// that container by hand. A P-256 key needs none of it: OpenSSH reads
// the SEC1 PEM that Node already produces, and the gateway's
// acceptableUserKey takes P-256 and ed25519 on equal terms.

import { generateKeyPairSync, KeyObject } from "node:crypto";

/** A generated keypair, in the two forms the rest of the extension needs. */
export interface KeyPair {
	/** SEC1 PEM ("BEGIN EC PRIVATE KEY"), what `ssh -i` reads. */
	privateKeyPem: string;
	/** An authorized_keys line, what POST /api/v1/ssh/certificate parses. */
	publicKeyLine: string;
}

const CURVE_NAME = "nistp256";
const KEY_TYPE = `ecdsa-sha2-${CURVE_NAME}`;

/**
 * Generate a keypair for this installation of the extension.
 *
 * The comment is cosmetic -- it travels into the certificate request and
 * shows up in the gateway's logs, which is the only reason to set it.
 */
export function generateKeyPair(comment: string): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	return {
		privateKeyPem: privateKey.export({ type: "sec1", format: "pem" }).toString(),
		publicKeyLine: encodePublicKey(publicKey, comment),
	};
}

/**
 * Encode an EC public key as an authorized_keys line.
 *
 * The blob is SSH wire format (RFC 4253 §6.6, RFC 5656 §3.1): a sequence
 * of length-prefixed strings, here the key type, the curve name and the
 * uncompressed point. The two names are both present and both required
 * even though one implies the other.
 */
export function encodePublicKey(publicKey: KeyObject, comment: string): string {
	const jwk = publicKey.export({ format: "jwk" });
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
		throw new Error(`expected a P-256 EC public key, got ${jwk.kty}/${jwk.crv}`);
	}

	// An uncompressed point is 0x04 followed by X and Y, each exactly
	// the curve's 32 bytes. A coordinate with a leading zero byte is a
	// perfectly ordinary key, and one that lost it produces a blob that
	// decodes without error and verifies against nothing -- so the
	// width is checked rather than assumed.
	const point = Buffer.concat([Buffer.from([0x04]), coordinate(jwk.x), coordinate(jwk.y)]);

	const blob = Buffer.concat([
		sshString(Buffer.from(KEY_TYPE, "utf8")),
		sshString(Buffer.from(CURVE_NAME, "utf8")),
		sshString(point),
	]);

	const line = `${KEY_TYPE} ${blob.toString("base64")}`;
	return comment ? `${line} ${comment}` : line;
}

/**
 * Decode one base64url JWK coordinate, which must be exactly 32 bytes.
 *
 * JWK fixes the width of an EC coordinate (RFC 7518 s6.2.1.2), leading
 * zeros included, so a short one here does not mean an unusual key --
 * it means the export path changed under us. Left-padding it instead
 * would hide that while still producing something that encodes
 * cleanly, which is the failure worth refusing.
 */
function coordinate(b64url: string): Buffer {
	const raw = Buffer.from(b64url, "base64url");
	if (raw.length !== 32) {
		throw new Error(`P-256 coordinate should be 32 bytes, got ${raw.length}`);
	}
	return raw;
}

/** Length-prefix a byte string the way the SSH wire format does. */
function sshString(body: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
}
