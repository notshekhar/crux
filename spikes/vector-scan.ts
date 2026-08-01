/**
 * Brute-force int8 vector scan in JS — is it fast enough without SIMD?
 *
 * Gates: 04-storage.md:132 — "100k chunks x 384 dims x int8 = 38 MB, scans in
 * ~50 ms with SIMD". JS has no SIMD, so I predicted 150-300 ms when we chose
 * Bun. This measures whether that is survivable or whether the vector arm needs
 * to move off the main thread / into a sidecar.
 *
 * Layout matters more than the arithmetic: one contiguous Int8Array with
 * stride-based access, never an array of 100k small typed arrays.
 */

const DIM = 384;

function makeCorpus(n: number) {
    const buf = new Int8Array(n * DIM);
    // deterministic pseudo-random so runs are comparable
    let s = 12345;
    for (let i = 0; i < buf.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = (s % 255) - 127;
    }
    return buf;
}

/** Top-k by dot product over a contiguous int8 corpus. */
function scan(corpus: Int8Array, q: Int8Array, n: number, k: number) {
    const topScore = new Float64Array(k);
    const topIdx = new Int32Array(k);
    topScore.fill(-Infinity);

    for (let v = 0; v < n; v++) {
        const base = v * DIM;
        let dot = 0;
        // manual 4x unroll — the JIT does not vectorise this, but unrolling
        // still cuts loop overhead measurably
        for (let d = 0; d < DIM; d += 4) {
            dot +=
                corpus[base + d]! * q[d]! +
                corpus[base + d + 1]! * q[d + 1]! +
                corpus[base + d + 2]! * q[d + 2]! +
                corpus[base + d + 3]! * q[d + 3]!;
        }
        if (dot > topScore[k - 1]!) {
            let i = k - 1;
            while (i > 0 && topScore[i - 1]! < dot) {
                topScore[i] = topScore[i - 1]!;
                topIdx[i] = topIdx[i - 1]!;
                i--;
            }
            topScore[i] = dot;
            topIdx[i] = v;
        }
    }
    return { topScore, topIdx };
}

const bench = (label: string, n: number) => {
    const corpus = makeCorpus(n);
    const q = corpus.slice(0, DIM); // query = first vector, so top hit must be itself
    // warm the JIT
    scan(corpus, q, Math.min(n, 5000), 20);

    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
        const t = performance.now();
        const { topIdx } = scan(corpus, q, n, 20);
        runs.push(performance.now() - t);
        if (topIdx[0] !== 0) throw new Error("correctness: query vector did not rank first");
    }
    runs.sort((a, b) => a - b);
    const med = runs[2]!;
    const mb = (n * DIM) / 1024 / 1024;
    console.log(
        `  ${label.padEnd(16)} ${med.toFixed(0).padStart(5)} ms   ${mb.toFixed(0).padStart(4)} MB   ${(((n / med) * 1000) / 1e6).toFixed(1)} M vec/s`,
    );
    return med;
};

console.log(`\n  int8 brute-force scan, ${DIM} dims, top-20\n`);
console.log(`  corpus              time      size   throughput`);
const at100k = bench("100k chunks", 100_000);
const at500k = bench("500k chunks", 500_000);
const at1m = bench("1M chunks", 1_000_000);

console.log(`\n  04-storage.md budget: ~50 ms at 100k (assumes SIMD), ~500 ms at 1M`);
console.log(`  measured:             ${at100k.toFixed(0)} ms at 100k, ${at1m.toFixed(0)} ms at 1M`);

const verdict =
    at100k < 100
        ? "PASS — inside interactive budget"
        : at100k < 250
          ? "OK — needs a worker thread"
          : "FAIL — needs a native sidecar";
console.log(`\n  ${verdict}\n`);
