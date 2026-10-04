// Carrying a single-access-point install forward.
//
// Tokens and OAuth client registrations used to be stored under one
// key each, because there was one access point. They are now stored
// under the access point. Without moving them, updating the extension
// presents as being signed out for no reason anybody can see -- and
// the fix, signing in again, is not obvious when nothing says you were
// signed out.

import { scopedKey } from "./accessPoints";
import { SecretStore } from "./tokens";

/**
 * Move the unscoped values under the key for `accessPoint`.
 *
 * Returns the prefixes that moved, for the log. Leaves a scoped value
 * that already exists alone: it is the newer of the two, and the
 * unscoped one is a leftover.
 */
export async function migrateUnscopedSecrets(
	secrets: SecretStore,
	accessPoint: string,
	prefixes: readonly string[]
): Promise<string[]> {
	const moved: string[] = [];
	for (const prefix of prefixes) {
		const legacy = await secrets.get(prefix);
		if (legacy === undefined) {
			continue;
		}
		const key = scopedKey(prefix, accessPoint);
		if ((await secrets.get(key)) === undefined) {
			await secrets.store(key, legacy);
			moved.push(prefix);
		}
		// Either way the unscoped copy goes: a credential nothing
		// reads is a credential nobody retires.
		await secrets.delete(prefix);
	}
	return moved;
}
