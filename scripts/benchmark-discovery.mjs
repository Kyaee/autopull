import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverRepositories } from "../cli/lib/discovery.mjs";

// Marker-only repositories isolate filesystem discovery from Git/network costs.
// Run from the checkout: node scripts/benchmark-discovery.mjs
const root = await mkdtemp(resolve(".autopull-discovery-benchmark-"));
const timings = { serial: [], parallel: [] };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

try {
    for (let group = 0; group < 30; group++) {
        for (let project = 0; project < 40; project++) {
            await mkdir(join(root, `group-${group}`, `project-${project}`, project % 4 === 0 ? ".git" : "empty"), {
                recursive: true,
            });
        }
    }
    let expected;
    for (let round = 0; round < 8; round++) {
        // Alternate order and omit the first round to reduce warm-cache bias.
        for (const mode of round % 2 ? ["parallel", "serial"] : ["serial", "parallel"]) {
            const start = performance.now();
            const result = await discoverRepositories([root], { concurrency: mode === "serial" ? 1 : 8 });
            const elapsed = performance.now() - start;
            if (expected) assert.deepEqual(result, expected);
            else expected = result;
            assert.equal(result.repositories.length, 300);
            if (round > 0) timings[mode].push(elapsed);
        }
    }
    const serial = median(timings.serial);
    const parallel = median(timings.parallel);
    console.log(JSON.stringify({
        projects: 1200,
        repositories: expected.repositories.length,
        samples: timings.serial.length,
        serialMedianMs: +serial.toFixed(1),
        parallelMedianMs: +parallel.toFixed(1),
        speedup: +(serial / parallel).toFixed(2),
    }, null, 2));
} finally {
    await rm(root, { recursive: true, force: true });
}
