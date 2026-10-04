import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { listRepositoryBranches, switchRepositoryBranch } from "../../cli/lib/branches.mjs";
import { saveExclusions } from "../../cli/lib/exclusions.mjs";

const exec = promisify(execFile);
const git = async (path, ...args) => (await exec("git", ["-C", path, ...args], { encoding: "utf8" })).stdout;
const fixture = async (t) => {
    const build = join(process.cwd(), "build");
    await mkdir(build, { recursive: true });
    const root = await mkdtemp(join(build, "branch-tests-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "repository with spaces");
    await mkdir(path);
    await git(path, "init", "--initial-branch=main");
    await git(path, "config", "user.name", "Autopull Tests");
    await git(path, "config", "user.email", "autopull@example.test");
    await writeFile(join(path, "tracked.txt"), "main\n");
    await writeFile(join(path, ".gitignore"), "ignored.txt\n");
    await git(path, "add", ".");
    await git(path, "commit", "-m", "initial");
    return { path, root, options: { exclusionsPath: join(root, "exclusions.json") } };
};

test("lists local and fetched remote branches, omits symbolic HEAD and existing local names", async (t) => {
    const { path, root } = await fixture(t);
    await git(path, "branch", "feature/local");
    const bare = join(root, "remote.git");
    await git(root, "clone", "--bare", path, bare);
    await git(bare, "branch", "feature/remote");
    await git(path, "remote", "add", "team/origin", bare);
    await git(path, "fetch", "team/origin");
    await git(path, "remote", "set-head", "team/origin", "main");
    const { repository, branches } = await listRepositoryBranches(path);
    assert.equal(repository.branch, "main");
    assert.deepEqual(branches.map((branch) => branch.name), ["feature/local", "main", "team/origin/feature/remote"]);
    assert.equal(branches.find((branch) => branch.name === "main").current, true);
    assert.deepEqual(branches.at(-1), { name: "team/origin/feature/remote", ref: "refs/remotes/team/origin/feature/remote",
        localName: "feature/remote", remote: "team/origin", current: false });
});

test("switches local branches, preserves commits, and works from detached HEAD", async (t) => {
    const { path, options } = await fixture(t);
    const main = await git(path, "rev-parse", "main");
    await git(path, "switch", "-c", "feature/local");
    await writeFile(join(path, "tracked.txt"), "feature\n");
    await git(path, "commit", "-am", "feature");
    const feature = await git(path, "rev-parse", "feature/local");
    await git(path, "switch", "--detach", "main");
    const result = await switchRepositoryBranch(path, "refs/heads/feature/local", options);
    assert.equal(result.ok, true);
    assert.equal(result.repository.branch, "feature/local");
    assert.equal(result.repository.detached, false);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), "feature\n");
    assert.equal(await git(path, "rev-parse", "main"), main);
    assert.equal(await git(path, "rev-parse", "feature/local"), feature);
    assert.match((await switchRepositoryBranch(path, "refs/heads/feature/local", options)).message, /Already on/);
});

test("creates a tracking branch from a remote without resetting an existing local branch", async (t) => {
    const { path, root, options } = await fixture(t);
    const bare = join(root, "remote.git");
    await git(root, "clone", "--bare", path, bare);
    await git(bare, "branch", "feature/remote");
    await git(path, "remote", "add", "origin", bare);
    await git(path, "fetch", "origin");
    const ref = "refs/remotes/origin/feature/remote";
    const result = await switchRepositoryBranch(path, ref, options);
    assert.equal(result.ok, true);
    assert.equal(result.repository.branch, "feature/remote");
    assert.equal(result.repository.upstream, "origin/feature/remote");
    await writeFile(join(path, "tracked.txt"), "local commit\n");
    await git(path, "commit", "-am", "local commit");
    const head = await git(path, "rev-parse", "HEAD");
    await git(path, "switch", "main");
    assert.equal((await switchRepositoryBranch(path, ref, options)).blocked, true);
    assert.equal(await git(path, "rev-parse", "feature/remote"), head);
    assert.equal((await switchRepositoryBranch(path, "refs/heads/feature/remote", options)).repository.ahead, 1);
    assert.equal((await listRepositoryBranches(path)).branches.some((branch) => branch.ref === ref), false);
});

test("blocks staged, unstaged, and untracked work without changing files or the index", async (t) => {
    const { path, options } = await fixture(t);
    await git(path, "branch", "other");
    for (const kind of ["staged", "unstaged", "untracked"]) {
        const file = join(path, kind === "untracked" ? "notes.txt" : "tracked.txt");
        await writeFile(file, "keep my work\n");
        if (kind === "staged") await git(path, "add", "tracked.txt");
        const status = await git(path, "status", "--porcelain=v2", "-z");
        const result = await switchRepositoryBranch(path, "refs/heads/other", options);
        assert.equal(result.blocked, true);
        assert.match(result.message, /Stash or commit/);
        assert.equal(result.repository.branch, "main");
        assert.equal(await git(path, "status", "--porcelain=v2", "-z"), status);
        assert.equal(await readFile(file, "utf8"), "keep my work\n");
        if (kind === "untracked") await rm(file);
        else await git(path, "restore", "--source=HEAD", "--staged", "--worktree", "tracked.txt");
    }
});

test("blocks conflicts and unfinished operations even when the working tree is clean", async (t) => {
    const { path, options } = await fixture(t);
    await git(path, "switch", "-c", "other");
    await writeFile(join(path, "tracked.txt"), "other\n");
    await git(path, "commit", "-am", "other");
    await git(path, "switch", "main");
    await writeFile(join(path, "tracked.txt"), "main version\n");
    await git(path, "commit", "-am", "main version");
    await assert.rejects(git(path, "merge", "other"));
    const conflicts = await readFile(join(path, "tracked.txt"), "utf8");
    assert.match((await switchRepositoryBranch(path, "refs/heads/other", options)).message, /Resolve conflicts/);
    assert.equal(await readFile(join(path, "tracked.txt"), "utf8"), conflicts);
    await git(path, "merge", "--abort");
    const gitDirectory = (await git(path, "rev-parse", "--absolute-git-dir")).trim();
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
        const markerPath = join(gitDirectory, marker);
        if (marker.includes("rebase") || marker === "sequencer") await mkdir(markerPath);
        else await writeFile(markerPath, await git(path, "rev-parse", "HEAD"));
        assert.match((await switchRepositoryBranch(path, "refs/heads/other", options)).message, /current Git operation/);
        await rm(markerPath, { recursive: true });
    }
    assert.equal((await listRepositoryBranches(path)).repository.branch, "main");
});

test("refuses hidden repositories, non-root directories, stale refs, and revision or option input", async (t) => {
    const { path, options } = await fixture(t);
    await git(path, "branch", "other");
    await saveExclusions([path], options.exclusionsPath);
    assert.match((await switchRepositoryBranch(path, "refs/heads/other", options)).message, /hidden/);
    await saveExclusions([], options.exclusionsPath);
    const child = join(path, "child");
    await mkdir(child);
    assert.match((await switchRepositoryBranch(child, "refs/heads/other", options)).message, /repository root/);
    for (const ref of ["refs/heads/missing", "HEAD~1", "--discard-changes", null]) {
        assert.match((await switchRepositoryBranch(path, ref, options)).message, /no longer available/);
    }
    await writeFile(options.exclusionsPath, "malformed");
    await assert.rejects(switchRepositoryBranch(path, "refs/heads/other", options), /Cannot read excluded/);
    assert.equal((await listRepositoryBranches(path)).repository.branch, "main");
});

test("protects ignored files and refuses a branch already used by another worktree", async (t) => {
    const { path, root, options } = await fixture(t);
    await git(path, "switch", "-c", "other");
    await writeFile(join(path, "ignored.txt"), "tracked on other\n");
    await git(path, "add", "-f", "ignored.txt");
    await git(path, "commit", "-m", "tracked on other");
    await git(path, "switch", "main");
    await writeFile(join(path, "ignored.txt"), "keep ignored file\n");
    const result = await switchRepositoryBranch(path, "refs/heads/other", options);
    assert.equal(result.ok, false);
    assert.equal(result.repository.branch, "main");
    assert.equal(await readFile(join(path, "ignored.txt"), "utf8"), "keep ignored file\n");
    await rm(join(path, "ignored.txt"));
    await git(path, "worktree", "add", join(root, "other worktree"), "other");
    const busy = await switchRepositoryBranch(path, "refs/heads/other", options);
    assert.equal(busy.ok, false);
    assert.match(busy.message, /already (?:checked out|used)/);
    assert.equal(busy.repository.branch, "main");
});
