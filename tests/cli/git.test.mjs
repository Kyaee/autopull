import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { discoverRepositories } from "../../cli/lib/discovery.mjs";
import { fetchRepository, inspectRepository, parsePorcelainV2, pullRepository } from "../../cli/lib/git.mjs";
import { runCli } from "../../cli/autopull.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

const temporaryDirectory = async () => {
    const path = await mkdtemp(join(tmpdir(), "autopull-test-"));
    temporaryDirectories.push(path);
    return path;
};

const git = async (cwd, ...args) => execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const initializeRepository = async (path) => {
    await mkdir(path, { recursive: true });
    await git(path, "init", "--initial-branch=main");
    await git(path, "config", "user.email", "autopull@example.test");
    await git(path, "config", "user.name", "Autopull Tests");
    await writeFile(join(path, "README.md"), "initial\n");
    await git(path, "add", "README.md");
    await git(path, "commit", "-m", "initial");
};

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("parses branch, remote counts, changes, and conflicts from porcelain v2", () => {
    const output = [
        "# branch.oid 1234",
        "# branch.head feature/test",
        "# branch.upstream origin/feature/test",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 aaaa bbbb src/app.tsx",
        "? notes.txt",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt",
        "",
    ].join("\0");

    const parsed = parsePorcelainV2(output, "/tmp/example");
    assert.equal(parsed.branch, "feature/test");
    assert.equal(parsed.upstream, "origin/feature/test");
    assert.equal(parsed.ahead, 2);
    assert.equal(parsed.behind, 3);
    assert.equal(parsed.modified, 1);
    assert.equal(parsed.untracked, 1);
    assert.equal(parsed.conflicts, 1);
    assert.deepEqual(parsed.changedFiles.map((file) => file.path), ["src/app.tsx", "notes.txt", "conflict.txt"]);
});

test("discovers nested repositories without walking through their contents", async () => {
    const root = await temporaryDirectory();
    const first = join(root, "group", "first");
    const nestedInsideRepository = join(first, "vendor", "nested");
    const second = join(root, "second");
    await initializeRepository(first);
    await initializeRepository(nestedInsideRepository);
    await initializeRepository(second);

    const result = await discoverRepositories([root], { maxDepth: 5 });
    assert.deepEqual(result.repositories.sort(), [first, second].sort());
    assert.deepEqual(result.errors, []);
});

test("classifies a repository with untracked work as dirty and blocks pulling", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await writeFile(join(root, "personal-notes.txt"), "do not overwrite\n");

    const status = await inspectRepository(root);
    assert.equal(status.state, "dirty");
    assert.equal(status.untracked, 1);
    assert.equal(status.canPull, false);

    const result = await pullRepository(root);
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.message, /local changes are present/);
});

test("detects a real unresolved merge conflict and blocks pulling", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await git(root, "switch", "-c", "incoming");
    await writeFile(join(root, "README.md"), "incoming version\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "incoming change");
    await git(root, "switch", "main");
    await writeFile(join(root, "README.md"), "personal version\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "personal change");
    await assert.rejects(git(root, "merge", "incoming"));

    const status = await inspectRepository(root);
    assert.equal(status.state, "conflict");
    assert.equal(status.conflicts, 1);
    assert.equal(status.canPull, false);

    const result = await pullRepository(root);
    assert.equal(result.blocked, true);
    assert.match(result.message, /unresolved conflict/);
});

test("fast-forwards a clean repository from its upstream", async () => {
    const root = await temporaryDirectory();
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    const consumer = join(root, "consumer");

    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bare]);
    await execFileAsync("git", ["clone", bare, seed]);
    await git(seed, "config", "user.email", "autopull@example.test");
    await git(seed, "config", "user.name", "Autopull Tests");
    await writeFile(join(seed, "README.md"), "initial\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "initial");
    await git(seed, "push", "-u", "origin", "main");
    await execFileAsync("git", ["clone", bare, consumer]);

    await writeFile(join(seed, "README.md"), "initial\nremote update\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "remote update");
    await git(seed, "push");
    for (const command of ["fetch", "refresh"]) {
        let stdout = "";
        const exitCode = await runCli([command, consumer, "--json"], {
            stdout: { write: (value) => { stdout += value; } },
        });
        assert.equal(exitCode, 0);
        const document = JSON.parse(stdout);
        assert.equal(document.command, command);
        assert.equal(document.refreshResults[0].ok, true);
        assert.equal(document.repositories[0].behind, 1);
        assert.equal(await readFile(join(consumer, "README.md"), "utf8"), "initial\n");
    }

    const before = await inspectRepository(consumer);
    assert.equal(before.behind, 1);
    assert.equal(before.canPull, true);

    const result = await pullRepository(consumer);
    assert.equal(result.ok, true);
    assert.equal(result.repository.behind, 0);
    assert.equal(result.repository.state, "current");
});

test("blocks a pull when local and remote history diverge", async () => {
    const root = await temporaryDirectory();
    const bare = join(root, "remote.git");
    const seed = join(root, "seed");
    const consumer = join(root, "consumer");

    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bare]);
    await execFileAsync("git", ["clone", bare, seed]);
    await git(seed, "config", "user.email", "autopull@example.test");
    await git(seed, "config", "user.name", "Autopull Tests");
    await writeFile(join(seed, "README.md"), "initial\n");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "initial");
    await git(seed, "push", "-u", "origin", "main");
    await execFileAsync("git", ["clone", bare, consumer]);
    await git(consumer, "config", "user.email", "autopull@example.test");
    await git(consumer, "config", "user.name", "Autopull Tests");

    await writeFile(join(consumer, "local.txt"), "local\n");
    await git(consumer, "add", "local.txt");
    await git(consumer, "commit", "-m", "local change");
    await writeFile(join(seed, "remote.txt"), "remote\n");
    await git(seed, "add", "remote.txt");
    await git(seed, "commit", "-m", "remote change");
    await git(seed, "push");
    await fetchRepository(consumer);

    const status = await inspectRepository(consumer);
    assert.equal(status.state, "diverged");
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);

    const result = await pullRepository(consumer);
    assert.equal(result.blocked, true);
    assert.match(result.message, /histories have diverged/);
});

test("CLI scan accepts a package-runner delimiter and emits protocol JSON", async () => {
    const root = await temporaryDirectory();
    const repository = join(root, "example");
    await initializeRepository(repository);

    let stdout = "";
    const exitCode = await runCli([
        "--",
        "scan",
        root,
        "--max-depth",
        "1",
        "--json",
    ], {
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: () => {} },
    });
    assert.equal(exitCode, 0);
    const document = JSON.parse(stdout);

    assert.equal(document.protocolVersion, 1);
    assert.equal(document.command, "scan");
    assert.equal(document.summary.total, 1);
    assert.equal(document.repositories[0].path, repository);
});
