// Bundle the extension into a single file.
//
// `vscode` is external because the editor supplies it at runtime;
// bundling it would produce a module that shadows the real one. Node's
// built-ins are external for the same reason.
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "out/extension.js",
	external: ["vscode"],
	format: "cjs",
	platform: "node",
	// The floor VS Code 1.90 ships. Targeting newer would compile to
	// syntax the editor's Node cannot parse, and the failure is an
	// extension that silently never activates.
	target: "node18",
	sourcemap: true,
	minify: !watch,
	logLevel: "info",
};

if (watch) {
	const { context } = await import("esbuild");
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
}
