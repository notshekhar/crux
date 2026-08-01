/**
 * Content hashing — the authority for the skip rule in 02-queue.md.
 *
 * The plan specifies blake3. Bun's CryptoHasher has no blake3, and adding one
 * means a native dependency, which spike 02 established we cannot afford. sha256
 * is built in and hardware-accelerated on arm64 — measured at 1793 MB/s here
 * against blake2b256's 645 MB/s, so it is both faster and dependency-free.
 *
 * Digests are truncated to 128 bits. At 1M chunks the collision probability is
 * ~1.5e-27, and it halves the space these hashes occupy across `chunks`,
 * `file_chunks`, and `vectors`.
 */

/** Hex characters in a stored hash. 32 hex chars = 128 bits. */
export const HASH_HEX_LEN = 32;

export function hashBytes(data: Uint8Array | string): string {
    return new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, HASH_HEX_LEN);
}

/**
 * Hash a file's bytes. Returns null if the file is gone — the caller turns that
 * into a delete job rather than an error (06-retrieval.md:119).
 */
export async function hashFile(path: string): Promise<string | null> {
    try {
        const buf = await Bun.file(path).arrayBuffer();
        return hashBytes(new Uint8Array(buf));
    } catch {
        return null;
    }
}

/** Stable id for a returned span: sp_<hash of content_hash + path + range>. */
export function spanId(contentHash: string, path: string, startLine: number, endLine: number): string {
    return `sp_${hashBytes(`${contentHash}:${path}:${startLine}:${endLine}`).slice(0, 12)}`;
}
