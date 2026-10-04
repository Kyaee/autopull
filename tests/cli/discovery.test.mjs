import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { discoverRepositories } from "../../cli/lib/discovery.mjs";

test("parallel discovery preserves depth limits, repository boundaries, ignores, and canonical roots", async () => {
    const root = await mkdtemp(resolve(".autopull-discovery-test-"));
    try {
        const projects = join(root, "projects");
        const expected = [];
        for (let index = 0; index < 20; index++) {
            const repository = join(projects, `repo-${index}`);
            await mkdir(repository, { recursive: true });
            // Worktrees have a .git file instead of a directory.
            if (index % 2) await writeFile(join(repository, ".git"), "gitdir: /unused\n");
            else await mkdir(join(repository, ".git"));
            await mkdir(join(repository, "nested", ".git"), { recursive: true });
            expected.push(repository);
        }
        await mkdir(join(projects, "deep", "too-deep", ".git"), { recursive: true });
        for (const ignored of ["node_modules", ".hidden", "custom-ignore"]) {
            await mkdir(join(projects, ignored, "ignored-repo", ".git"), { recursive: true });
        }
        await symlink(projects, join(root, "alias"));
        await symlink(projects, join(projects, "loop"));
        const missing = join(root, "missing");
        const roots = [root, projects, join(root, "alias"), missing];
        const options = { maxDepth: 1, ignoredNames: ["custom-ignore"] };
        const serial = await discoverRepositories(roots, { ...options, concurrency: 1 });
        const parallel = await discoverRepositories(roots, options);
        assert.deepEqual(parallel, serial);
        assert.deepEqual(parallel.repositories, expected.sort((a, b) => a.localeCompare(b)));
        assert.deepEqual(parallel.errors, [{ path: missing, message: "Root is not a readable directory." }]);
        assert.deepEqual((await discoverRepositories([root], { maxDepth: 1 })).repositories, []);
        assert.deepEqual((await discoverRepositories([expected[0]], { maxDepth: 0 })).repositories, [expected[0]]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("discovery rejects invalid worker limits", async () => {
    for (const concurrency of [0, -1, 1.5, 33, NaN, Infinity, "8"]) {
        await assert.rejects(discoverRepositories([], { concurrency }), /concurrency must be an integer/);
    }
    assert.deepEqual(await discoverRepositories([], { concurrency: 32 }), { repositories: [], errors: [] });
});
