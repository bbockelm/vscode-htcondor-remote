// Which access points this extension knows about, and which one it is
// talking to.
//
// One URL in a setting was wrong for the way people actually work: a
// user with an account on two access points edits a setting to move
// between them, and the editor keeps no record that the two are
// different places. They are different places in every way that
// matters here -- different OAuth issuers, different tokens, different
// SSH certificate authorities, different queues -- so the URL is not a
// preference, it is a key. Everything this extension stores is stored
// under it.
//
// No `vscode` import: canonicalising a URL that is about to be used as
// a storage key is the part worth testing hard.

/**
 * The canonical form of an access point, which is what gets used as a
 * key.
 *
 * Two spellings of the same access point must produce the same string,
 * or the same user ends up with two sets of tokens and two entries in
 * the menu. Throws rather than guessing, because a key derived from a
 * typo is a session that silently never matches.
 *
 * The path is dropped. Nothing in this extension can reach an access
 * point served under a path prefix -- every request is built with an
 * absolute path against this base, which discards it -- so keeping it
 * would only record a promise that is not kept.
 */
export function canonicalAccessPoint(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new Error("An access point needs an address, for example https://ap.example.edu");
	}
	// Without a scheme, `ap.example.edu:8443` parses as the scheme
	// `ap.example.edu` with the path `8443`, which is a valid URL and
	// the wrong one.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`${input} is not an address, for example https://ap.example.edu`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`${input} is not an http or https address`);
	}
	if (url.hostname === "") {
		throw new Error(`${input} has no host name`);
	}
	if (url.username !== "" || url.password !== "") {
		// Credentials in the URL would end up in a settings file, in
		// the menu, and in every log line naming the access point.
		throw new Error("Put the user name in your access point's sign-in, not in its address");
	}
	return url.origin;
}

/**
 * A reason not to use this address, or undefined if it is fine.
 *
 * Separate from canonicalisation, which is a parser and has to accept
 * whatever is already stored. This is the policy, and it is applied
 * where an address is being chosen: a bearer token travels on every
 * request, so plain http to anywhere but this machine would put it on
 * the wire in clear.
 */
export function insecureAccessPoint(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(canonicalAccessPoint(url));
	} catch {
		return undefined;
	}
	if (parsed.protocol === "https:") {
		return undefined;
	}
	if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") {
		return undefined;
	}
	return "Use https, or localhost for a local server.";
}

/** True when the two addresses are the same access point. */
export function sameAccessPoint(a: string, b: string): boolean {
	try {
		return canonicalAccessPoint(a) === canonicalAccessPoint(b);
	} catch {
		return false;
	}
}

/** What to call it in a menu: the host, which is what users say out loud. */
export function accessPointLabel(url: string): string {
	try {
		return new URL(canonicalAccessPoint(url)).host;
	} catch {
		return url;
	}
}

/**
 * A name for this access point's directory on disk.
 *
 * Its certificate, its known_hosts and its generated ssh_config live
 * there. They cannot be shared: a certificate is signed by one access
 * point's CA and names an account on it, and offering it to another is
 * at best a failed login.
 */
export function accessPointSlug(url: string): string {
	return accessPointLabel(url).replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * A storage key scoped to one access point.
 *
 * Tokens and OAuth client registrations go under these. Sending an
 * access point a token minted by a different one is the failure this
 * prevents, and it is not a theoretical one -- before the key included
 * the access point, switching between two meant doing exactly that.
 */
export function scopedKey(prefix: string, accessPoint: string): string {
	return `${prefix}:${canonicalAccessPoint(accessPoint)}`;
}

/** Add one, canonicalised, keeping the order and ignoring duplicates. */
export function addAccessPoint(list: readonly string[], url: string): string[] {
	const canonical = canonicalAccessPoint(url);
	const kept = list.filter((entry) => !sameAccessPoint(entry, canonical));
	return [...kept, canonical];
}

export function removeAccessPoint(list: readonly string[], url: string): string[] {
	return list.filter((entry) => !sameAccessPoint(entry, url));
}

/**
 * Canonicalise a configured list, dropping what will not parse.
 *
 * A bad entry in a settings file should cost that entry, not the
 * extension: everything else in the list still works.
 */
export function readAccessPoints(configured: readonly string[]): string[] {
	const seen: string[] = [];
	for (const entry of configured) {
		let canonical: string;
		try {
			canonical = canonicalAccessPoint(entry);
		} catch {
			continue;
		}
		if (!seen.includes(canonical)) {
			seen.push(canonical);
		}
	}
	return seen;
}

/**
 * Which one to start on.
 *
 * The one last chosen, when it is still in the list, so a new window
 * opens where the last one was. Otherwise the first, so a user with a
 * single access point never has to choose at all.
 */
export function chooseAccessPoint(list: readonly string[], remembered?: string): string | undefined {
	if (remembered) {
		const match = list.find((entry) => sameAccessPoint(entry, remembered));
		if (match) {
			return match;
		}
	}
	return list[0];
}
