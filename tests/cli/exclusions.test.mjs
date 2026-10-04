import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { executeCli, runCli } from "../../cli/autopull.mjs";
import { discoverRepositories } from "../../cli/lib/discovery.mjs";
import { canonicalDirectory, isDirectoryExcluded, loadExclusions, saveExclusions } from "../../cli/lib/exclusions.mjs";

const execFileAsync = promisify(execFile);
const fixture = async (t) => {
    const build = join(process.cwd(), "build");
    await mkdir(build, { recursive: true });
    const directory = await mkdtemp(join(build, "exclusion tests-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
};

test("stores editable exclusions, normalizes aliases, and matches only a directory and its descendants", async (t) => {
    const root = await fixture(t);
    const hidden = join(root, "hidden");
    const alias = join(root, "alias");
    await mkdir(hidden);
    await symlink(hidden, alias);
    const path = join(root, "settings", "exclusions.json");
    assert.deepEqual(await loadExclusions(path), []);
    await saveExclusions([hidden, alias, hidden], path);
    assert.deepEqual(await loadExclusions(path), [hidden]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, directories: [hidden] });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(isDirectoryExcluded(hidden, [hidden]), true);
    assert.equal(isDirectoryExcluded(join(hidden, "nested", "repo"), [hidden]), true);
    assert.equal(isDirectoryExcluded(`${hidden}-other`, [hidden]), false);
    assert.equal(isDirectoryExcluded(root, [hidden]), false);
    assert.equal(await canonicalDirectory(alias), hidden);
    await writeFile(path, '{"version":1,"directories":[]}');
    assert.deepEqual(await loadExclusions(path), []);
    await assert.rejects(saveExclusions([""], path), /cannot be empty/);
    await assert.rejects(saveExclusions(["bad\npath"], path), /control characters/);
});

test("discovery skips excluded roots and subtrees, including roots reached through a symlink", async (t) => {
    const root = await fixture(t);
    const hidden = join(root, "hidden");
    const included = join(root, "hidden-other");
    await mkdir(join(hidden, "nested", ".git"), { recursive: true });
    await mkdir(join(included, ".git"), { recursive: true });
    await symlink(hidden, join(root, "alias"));
    const options = { excludedDirectories: [hidden] };
    assert.deepEqual((await discoverRepositories([root], options)).repositories, [included]);
    assert.deepEqual((await discoverRepositories([join(root, "alias")], options)).repositories, []);
});

test("CLI excludes directories from scans and fetches, blocks explicit pulls, and restores without changing files", async (t) => {
    const root = await fixture(t);
    const repository = join(root, "project");
    await mkdir(repository);
    await execFileAsync("git", ["init", "--initial-branch=main", repository]);
    await writeFile(join(repository, "notes.txt"), "keep this work\n");
    const path = join(root, "exclusions.json");
    const previous = process.env.AUTOPULL_EXCLUSIONS_FILE;
    process.env.AUTOPULL_EXCLUSIONS_FILE = path;
    t.after(() => {
        if (previous === undefined) delete process.env.AUTOPULL_EXCLUSIONS_FILE;
        else process.env.AUTOPULL_EXCLUSIONS_FILE = previous;
    });
    await saveExclusions([repository], path);
    const invoke = async (command) => {
        let output = "";
        const code = await runCli([command, repository, "--json"], { stdout: { write(value) { output += value; } } });
        return { code, document: JSON.parse(output) };
    };
    for (const command of ["scan", "fetch", "refresh"]) {
        const result = await invoke(command);
        assert.equal(result.code, 0);
        assert.deepEqual(result.document.repositories, []);
    }
    const blocked = await invoke("pull");
    assert.equal(blocked.code, 2);
    assert.equal(blocked.document.result.blocked, true);
    assert.match(blocked.document.result.message, /hidden from Autopull/);
    assert.equal(await readFile(join(repository, "notes.txt"), "utf8"), "keep this work\n");
    await saveExclusions([], path);
    assert.equal((await invoke("scan")).document.repositories[0].path, repository);
    assert.equal(await readFile(join(repository, "notes.txt"), "utf8"), "keep this work\n");
    await writeFile(path, '{"version":1,"directories":"invalid"}');
    for (const command of ["scan", "fetch", "pull"]) {
        let output = "";
        const code = await executeCli([command, repository, "--json"], { stdout: { write(value) { output += value; } } });
        assert.equal(code, 1);
        assert.match(JSON.parse(output).error.message, /Cannot read excluded directories/);
    }
});
