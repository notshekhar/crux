/**
 * Bun's `with { type: "file" }` import returns a path string, and embeds the
 * file's bytes when compiled with `bun build --compile`. TypeScript has no
 * built-in knowledge of this, so declare it.
 */
declare module "*.wasm" {
    /** A path that resolves both from source and inside a compiled binary. */
    const path: string;
    export default path;
}
