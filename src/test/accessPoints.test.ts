import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	accessPointLabel,
	accessPointSlug,
	addAccessPoint,
	canonicalAccessPoint,
	chooseAccessPoint,
	readAccessPoints,
	removeAccessPoint,
	sameAccessPoint,
	scopedKey,
} from "../accessPoints";

test("a bare host name is an https access point", () => {
	assert.equal(canonicalAccessPoint("ap.example.edu"), "https://ap.example.edu");
});

test("a bare host and port is a host and port, not a scheme", () => {
	// `new URL("ap.example.edu:8443")` parses: the scheme is
	// `ap.example.edu` and the path is `8443`. It is a valid URL and
	// entirely the wrong one.
	assert.equal(canonicalAccessPoint("ap.example.edu:8443"), "https://ap.example.edu:8443");
});

test("spellings of one access point canonicalise to one key", () => {
	const forms = [
		"https://ap.example.edu",
		"https://ap.example.edu/",
		"HTTPS://AP.EXAMPLE.EDU",
		"ap.example.edu",
		"  https://ap.example.edu  ",
		"https://ap.example.edu/api/v1/jobs?limit=1",
	];

	const keys = new Set(forms.map(canonicalAccessPoint));

	assert.deepEqual([...keys], ["https://ap.example.edu"], "two keys means two sets of tokens for one access point");
});

test("http is allowed, for a test instance", () => {
	assert.equal(canonicalAccessPoint("http://localhost:8080"), "http://localhost:8080");
});

test("a non-default https port is part of the identity", () => {
	assert.notEqual(canonicalAccessPoint("https://ap.example.edu:8443"), canonicalAccessPoint("https://ap.example.edu"));
});

test("what cannot be an address is refused rather than guessed at", () => {
	for (const bad of ["", "   ", "ftp://ap.example.edu", "https://", "http://"]) {
		assert.throws(() => canonicalAccessPoint(bad), `${JSON.stringify(bad)} should be refused`);
	}
});

test("credentials in the address are refused", () => {
	// They would end up in a settings file, in the menu, and in every
	// log line naming the access point.
	assert.throws(() => canonicalAccessPoint("https://user:pw@ap.example.edu"), /sign-in/);
});

test("the label is the host, the slug is safe for a directory name", () => {
	assert.equal(accessPointLabel("https://ap.example.edu:8443/x"), "ap.example.edu:8443");
	assert.equal(accessPointSlug("https://ap.example.edu:8443/x"), "ap.example.edu_8443");
	assert.ok(!accessPointSlug("https://ap.example.edu:8443").includes("/"));
});

test("storage keys differ between access points", () => {
	const a = scopedKey("htcondor.oauth2.tokens", "https://a.example.edu");
	const b = scopedKey("htcondor.oauth2.tokens", "b.example.edu");

	assert.notEqual(a, b);
	assert.equal(a, scopedKey("htcondor.oauth2.tokens", "https://a.example.edu/"), "one access point, one key");
});

test("adding is idempotent across spellings", () => {
	let list: string[] = [];
	list = addAccessPoint(list, "ap1.example.edu");
	list = addAccessPoint(list, "https://ap2.example.edu");
	list = addAccessPoint(list, "HTTPS://AP1.EXAMPLE.EDU/");

	assert.deepEqual(list, ["https://ap2.example.edu", "https://ap1.example.edu"]);
});

test("removing matches on the access point, not on the spelling", () => {
	const list = ["https://ap1.example.edu", "https://ap2.example.edu"];

	assert.deepEqual(removeAccessPoint(list, "AP1.example.edu/"), ["https://ap2.example.edu"]);
});

test("a bad entry in settings costs that entry, not the list", () => {
	const list = readAccessPoints(["ap1.example.edu", "not a url at all", "ftp://nope", "https://ap1.example.edu/"]);

	assert.deepEqual(list, ["https://ap1.example.edu"]);
});

test("a new window opens where the last one was", () => {
	const list = ["https://ap1.example.edu", "https://ap2.example.edu"];

	assert.equal(chooseAccessPoint(list, "https://ap2.example.edu"), "https://ap2.example.edu");
	assert.equal(chooseAccessPoint(list, "https://gone.example.edu"), "https://ap1.example.edu", "fall back, not fail");
	assert.equal(chooseAccessPoint(list), "https://ap1.example.edu");
	assert.equal(chooseAccessPoint([], "https://ap1.example.edu"), undefined);
});

test("sameAccessPoint says no rather than throwing on rubbish", () => {
	assert.equal(sameAccessPoint("ap.example.edu", "https://ap.example.edu/"), true);
	assert.equal(sameAccessPoint("ap.example.edu", "nonsense here"), false);
});
