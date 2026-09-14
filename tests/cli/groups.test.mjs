import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
    createGroup,
    deleteGroup,
    loadGroups,
    renameGroup,
    repositoriesInGroup,
    saveGroups,
    toggleGroupRepository,
} from "../../cli/lib/groups.mjs";
import { pullMany } from "../../cli/lib/protocol.mjs";

const temporaryDirectories = [];

const temporaryDirectory = async () => {
    const path = await mkdtemp(join(tmpdir(), "autopull-groups-test-"));
    temporaryDirectories.push(path);
    return path;
};

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("creates, renames, edits, and deletes repository groups", () => {
    let groups = createGroup([], "Work");
    groups = toggleGroupRepository(groups, "Work", "/repos/api");
    groups = toggleGroupRepository(groups, "Work", "/repos/web");
    groups = renameGroup(groups, "Work", "Client work");

    assert.equal(groups[0].name, "Client work");
    assert.deepEqual(groups[0].repositories, ["/repos/api", "/repos/web"]);

    groups = toggleGroupRepository(groups, "Client work", "/repos/api");
    assert.deepEqual(groups[0].repositories, ["/repos/web"]);
    assert.deepEqual(deleteGroup(groups, "Client work"), []);
});

test("rejects empty and duplicate group names", () => {
    const groups = createGroup([], "Work");
    assert.throws(() => createGroup(groups, " work "), /already exists/);
    assert.throws(() => createGroup(groups, "  "), /cannot be empty/);
    assert.throws(() => createGroup(groups, "bad\tname"), /control characters/);
});

test("saves group data atomically and loads normalized paths", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "groups.json");
    await saveGroups([{ name: "Work", repositories: ["/repos/web", "/repos/web"] }], path);

    assert.deepEqual(await loadGroups(path), [{ name: "Work", repositories: ["/repos/web"] }]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.version, 1);
});

test("filters scanned repositories by group membership", () => {
    const repositories = [{ path: "/repos/api" }, { path: "/repos/web" }];
    const groups = [{ name: "API", repositories: ["/repos/api"] }];
    assert.deepEqual(repositoriesInGroup(repositories, groups, "API"), [{ path: "/repos/api" }]);
    assert.equal(repositoriesInGroup(repositories, groups, null).length, 2);
});

test("pulls only repositories with waiting updates and reports each outcome", async () => {
    const repositories = [
        { path: "/repos/current", needsPull: false },
        { path: "/repos/ready", needsPull: true },
        { path: "/repos/dirty", needsPull: true },
        { path: "/repos/error", needsPull: true },
    ];
    const called = [];
    const result = await pullMany(repositories, {
        pullRepository: async (path) => {
            called.push(path);
            if (path.endsWith("error")) throw new Error("cannot inspect repository");
            return path.endsWith("dirty")
                ? { ok: false, blocked: true, repository: { path } }
                : { ok: true, blocked: false, repository: { path } };
        },
    });

    assert.deepEqual(called, ["/repos/ready", "/repos/dirty", "/repos/error"]);
    assert.deepEqual({ waiting: result.waiting, updated: result.updated, blocked: result.blocked, failed: result.failed }, {
        waiting: 3,
        updated: 1,
        blocked: 1,
        failed: 1,
    });
});
