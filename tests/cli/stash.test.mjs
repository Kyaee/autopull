import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { saveExclusions } from "../../cli/lib/exclusions.mjs";
import { inspectRepository } from "../../cli/lib/git.mjs";
import { stashRepositoryChanges } from "../../cli/lib/stash.mjs";

const exec = promisify(execFile);
const git = async (path, ...args) => (await exec("git", ["-C", path, ...args], { encoding: "utf8" })).stdout;
const fixture = async (t) => {
    const build = join(process.cwd(), "build");
    await mkdir(build, { recursive: true });
    const root = await mkdtemp(join(build, "stash-tests-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "repository with spaces");
    await mkdir(path);
    await git(path, "init", "--initial-branch=main");
    await git(path, "config", "user.name", "Autopull Tests");
    await git(path, "config", "user.email", "autopull@example.test");
    await writeFile(join(path, "tracked.txt"), "initial\n");
    await writeFile(join(path, ".gitignore"), "ignored.txt\n");
    await git(path, "add", ".");
    await git(path, "commit", "-m", "initial");
    return { path, root, options: { confirmed: true, exclusionsPath: join(root, "exclusions.json") } };
};

test("stashes staged, unstaged, and untracked changes and restores the exact index without changing commits or ignored files", async (t) => {
    const { path, options } = await fixture(t);
    await writeFile(join(path, "tracked.txt"), "staged\n");
    await git(path, "add", "tracked.txt");
    await writeFile(join(path, "tracked.txt"), "unstaged\n");
    await mkdir(join(path, "new folder"));
    await writeFile(join(path, "new folder", "notes.txt"), "untracked\n");
    await writeFile(join(path, "ignored.txt"), "ignored\n");
    const head = await git(path, "rev-parse", "HEAD");
    const status = await git(path, "status", "--porcelain=v2", "-z");
    const result = await stashRepositoryChanges(path, options);
    assert.equal(result.ok, true);
    assert.equal(result.repository.dirty, false);
    assert.match(result.backup, /^[a-f0-9]{40,64}$/);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "initial\n");
    await assert.rejects(readFile(join(path, "new folder", "notes.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(path, "ignored.txt"), "utf8"), "ignored\n");
    assert.equal(await git(path, "rev-parse", "HEAD"), head);
    assert.match(await git(path, "stash", "list"), /Autopull: stash local changes/);
    await git(path, "stash", "apply", "--index", result.backup);
    assert.equal(await git(path, "status", "--porcelain=v2", "-z"), status);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "unstaged\n");
    assert.equal(await readFile(join(path, "new folder", "notes.txt"), "utf8"), "untracked\n");
    assert.equal(await git(path, "show", ":tracked.txt"), "staged\n");
});

test("requires confirmation and refuses hidden directories, subdirectories, clean repositories, and malformed settings", async (t) => {
    const { path, options } = await fixture(t);
    assert.equal((await stashRepositoryChanges(path, options)).blocked, true);
    await writeFile(join(path, "tracked.txt"), "keep\n");
    assert.equal((await stashRepositoryChanges(path, { ...options, confirmed: false })).blocked, true);
    await mkdir(join(path, "child"));
    assert.match((await stashRepositoryChanges(join(path, "child"), options)).message, /repository root/);
    await saveExclusions([path], options.exclusionsPath);
    assert.match((await stashRepositoryChanges(path, options)).message, /hidden/);
    await writeFile(options.exclusionsPath, "malformed");
    await assert.rejects(stashRepositoryChanges(path, options), /Cannot read excluded/);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "keep\n");
    assert.equal(await git(path, "stash", "list"), "");
});

test("refuses a Git operation or unresolved merge without changing files", async (t) => {
    const { path, options } = await fixture(t);
    await git(path, "switch", "-c", "other");
    await writeFile(join(path, "tracked.txt"), "other\n");
    await git(path, "commit", "-am", "other");
    await git(path, "switch", "main");
    await writeFile(join(path, "tracked.txt"), "main\n");
    await git(path, "commit", "-am", "main");
    await assert.rejects(git(path, "merge", "other"));
    const before = await readFile(join(path, "tracked.txt"), "utf8");
    assert.match((await stashRepositoryChanges(path, options)).message, /conflicts/);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), before);
    await writeFile(join(path, "tracked.txt"), "resolved\n");
    await git(path, "add", "tracked.txt");
    assert.match((await stashRepositoryChanges(path, options)).message, /current Git operation/);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "resolved\n");
    assert.equal(await git(path, "stash", "list"), "");
});

test("reports stash failures without deleting local work in a repository without commits", async (t) => {
    const { root, options } = await fixture(t);
    const path = join(root, "unborn");
    await mkdir(path);
    await git(path, "init", "--initial-branch=main");
    await writeFile(join(path, "notes.txt"), "keep\n");
    const result = await stashRepositoryChanges(path, options);
    assert.equal(result.ok, false);
    assert.equal(result.backup, null);
    assert.equal(await readFile(join(path, "notes.txt"), "utf8"), "keep\n");
});

test("refuses dirty submodules and keeps their work", async (t) => {
    const { path, root, options } = await fixture(t);
    const source = join(root, "source");
    await git(root, "clone", path, source);
    await git(path, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
    await git(path, "commit", "-am", "add submodule");
    await writeFile(join(path, "module", "tracked.txt"), "keep submodule edit\n");
    const result = await stashRepositoryChanges(path, options);
    assert.equal(result.blocked, true);
    assert.match(result.message, /submodule/);
    assert.equal(await readFile(join(path, "module", "tracked.txt"), "utf8"), "keep submodule edit\n");
    assert.equal(await git(path, "stash", "list"), "");
    assert.equal((await inspectRepository(path)).dirty, true);
});
