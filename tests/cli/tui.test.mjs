import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { renderTui, runTui, tuiActionForKey } from "../../cli/lib/tui.mjs";

const repository = (overrides = {}) => ({
    path: "/work/example",
    name: "example",
    state: "behind",
    branch: "main",
    upstream: "origin/main",
    detached: false,
    ahead: 0,
    behind: 2,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    changedFiles: [],
    dirty: false,
    diverged: false,
    canPull: true,
    needsPull: true,
    blockers: [],
    ...overrides,
});

const model = (repositories) => ({
    roots: ["/work"],
    allRepositories: repositories,
    repositories,
    summary: null,
    discoveryErrors: [],
    selectedIndex: 0,
    groups: [],
    activeGroup: null,
    groupIndex: 0,
    editingGroup: null,
    memberIndex: 0,
    view: "repositories",
    modal: null,
    busy: false,
    activity: "",
    notification: "",
});

test("renders repository state, selected details, and TUI controls", () => {
    const output = renderTui(model([repository()]), { columns: 100, rows: 30 });

    assert.match(output, /AUTOPULL  1 repos  1 ready/);
    assert.match(output, /REPOSITORY\s+BRANCH\s+STATE\s+REMOTE/);
    assert.match(output, /› example/);
    assert.match(output, /Branch  main  →  origin\/main/);
    assert.match(output, /Ready to fast-forward\. Press p to pull/);
    assert.match(output, /f fetch/);
    assert.match(output, /o root/);
});

test("explains why a selected repository cannot be pulled", () => {
    const dirty = repository({
        state: "dirty",
        behind: 1,
        modified: 1,
        dirty: true,
        canPull: false,
        blockers: ["local changes are present"],
        changedFiles: [{ path: "notes.txt", kind: "changed" }],
    });
    const output = renderTui(model([dirty]), { columns: 80, rows: 24 });

    assert.match(output, /Blocked: local changes are present/);
    assert.match(output, /Files   notes\.txt/);
    assert.ok(output.split("\n").every((line) => line.length === 80));
});

test("maps navigation and action keys", () => {
    assert.equal(tuiActionForKey({ name: "up" }), "up");
    assert.equal(tuiActionForKey({ name: "j" }), "up");
    assert.equal(tuiActionForKey({ name: "k" }), "down");
    assert.equal(tuiActionForKey({ name: "r" }), "fetch");
    assert.equal(tuiActionForKey({ name: "f" }), "fetch");
    assert.equal(tuiActionForKey({ name: "o" }), "root");
    assert.equal(tuiActionForKey({ name: "return" }), "enter");
    assert.equal(tuiActionForKey({ name: "g" }), "groups");
    assert.equal(tuiActionForKey({ name: "space" }), "toggle");
    assert.equal(tuiActionForKey({ name: "c", ctrl: true }), "quit");
    assert.equal(tuiActionForKey({ name: "x" }), "fix");
    assert.equal(tuiActionForKey({ name: "z" }), null);
});

test("renders group management and membership views", () => {
    const grouped = model([repository()]);
    grouped.groups = [{ name: "Client work", repositories: ["/work/example"] }];
    grouped.view = "groups";
    grouped.groupIndex = 1;

    const groupsOutput = renderTui(grouped, { columns: 90, rows: 24 });
    assert.match(groupsOutput, /Repository groups/);
    assert.match(groupsOutput, /› Client work  1 repos/);
    assert.match(groupsOutput, /n new  e members  r rename  d delete/);

    grouped.view = "members";
    grouped.editingGroup = "Client work";
    const membersOutput = renderTui(grouped, { columns: 90, rows: 24 });
    assert.match(membersOutput, /Edit group: Client work/);
    assert.match(membersOutput, /› \[x\] @main  example/);
    assert.match(membersOutput, /Space toggle membership/);
});

test("keeps the current branch visible in a narrow terminal", () => {
    const output = renderTui(model([repository({ branch: "feature/groups" })]), { columns: 60, rows: 24 });

    assert.match(output, /› @feature\/groups\s+example/);
    assert.match(output, /Branch  feature\/groups  →  origin\/main/);
    assert.ok(output.split("\n").every((line) => line.length === 60));
});

for (const outcome of ["success", "failure", "quit"]) {
    test(`animates a pending fetch and stops on ${outcome}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const input = Object.assign(new EventEmitter(), {
            isTTY: true,
            isRaw: false,
            setRawMode() {},
            resume() {},
        });
        const frames = [];
        const output = Object.assign(new EventEmitter(), {
            isTTY: true,
            columns: 100,
            rows: 30,
            write(frame) { frames.push(frame); },
        });
        const pending = Promise.withResolvers();
        let refreshCalls = 0;
        const running = runTui({ roots: ["/work"], color: false }, { stdin: input, stdout: output }, {
            discoverRepositories: async () => ({ repositories: ["/work/example"], errors: [] }),
            inspectMany: async () => [repository()],
            loadGroups: async () => [],
            refreshMany: () => { refreshCalls += 1; return pending.promise; },
        });
        t.after(() => input.emit("keypress", "q", { name: "q" }));
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        await settle();
        input.emit("keypress", "r", { name: "r" });
        await settle();
        assert.match(frames.at(-1), /⠋ Fetching remotes…/);
        assert.match(frames.at(-1), /›.*example/);
        t.mock.timers.tick(100);
        assert.match(frames.at(-1), /⠙ Fetching remotes…/);
        input.emit("keypress", "r", { name: "r" });
        assert.equal(refreshCalls, 1);

        if (outcome === "quit") {
            input.emit("keypress", "q", { name: "q" });
            await running;
        }
        if (outcome === "failure") pending.reject(new Error("Fetch unavailable"));
        else pending.resolve([{ ok: true, repository: repository() }]);
        await settle();
        if (outcome !== "quit") {
            assert.match(frames.at(-1), outcome === "success" ? /Remote state fetched\./ : /Failed: Fetch unavailable/);
            assert.doesNotMatch(frames.at(-1), /Fetching remotes…/);
        }
        const count = frames.length;
        t.mock.timers.tick(500);
        assert.equal(frames.length, count);
        input.emit("keypress", "q", { name: "q" });
        await running;
    });
}

test("changes roots, clears the group filter, and uses the new root for subsequent scans and fetches", async (t) => {
    const build = join(process.cwd(), "build");
    await mkdir(build, { recursive: true });
    const root = await mkdtemp(join(build, "root tests-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), {
        isTTY: true, columns: 120, rows: 30,
        write(frame) { frames.push(frame); },
    });
    const discoveredRoots = [];
    const fetchedPaths = [];
    const initialRoots = ["/work"];
    const running = runTui({ roots: initialRoots, color: false }, { stdin: input, stdout: output }, {
        discoverRepositories: async (roots) => {
            discoveredRoots.push([...roots]);
            return { repositories: [join(roots[0], "example")], errors: [] };
        },
        inspectMany: async (paths) => [repository({ path: paths[0] })],
        loadGroups: async () => [{ name: "Work", repositories: ["/work/example"] }],
        refreshMany: async (paths) => {
            fetchedPaths.push([...paths]);
            return [{ ok: true, repository: repository({ path: paths[0] }) }];
        },
    });
    const key = (name, text = "") => input.emit("keypress", text, { name });
    t.after(() => key("q"));
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const waitForScan = async (count) => {
        for (let attempts = 0; attempts < 100; attempts += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (discoveredRoots.length === count && /STATUS  Scanned/.test(frames.at(-1))) return;
        }
        assert.fail("Root scan did not complete.");
    };
    await waitForScan(1);
    key("o");
    assert.match(frames.at(-1), /root folder/);
    key("escape");
    assert.equal(discoveredRoots.length, 1);

    for (const invalid of ["", join(root, "missing"), join(process.cwd(), "README.md")]) {
        key("o");
        if (invalid) key(undefined, invalid);
        key("return");
        for (let attempts = 0; attempts < 100 && !/Failed:/.test(frames.at(-1)); attempts += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.match(frames.at(-1), /Failed: Root folder/);
        assert.match(frames.at(-1), /›.*example/);
        assert.equal(discoveredRoots.length, 1);
    }

    key("g");
    key("down");
    key("r");
    assert.match(frames.at(-1), /Rename Work/);
    key("escape");
    key("return");
    assert.match(frames.at(-1), /repositories \/ Work/);
    key("o");
    key(undefined, `~/${relative(homedir(), root)}`);
    key("return");
    await waitForScan(2);
    assert.deepEqual(discoveredRoots.at(-1), [root]);
    assert.match(frames.at(-1), /repositories \/ All repositories/);
    assert.deepEqual(initialRoots, ["/work"]);
    key("s");
    await waitForScan(3);
    assert.deepEqual(discoveredRoots.at(-1), [root]);
    key("f");
    await settle();
    assert.deepEqual(fetchedPaths, [[join(root, "example")]]);

    key("o");
    key(undefined, relative(process.cwd(), root));
    key("return");
    await waitForScan(5);
    assert.deepEqual(discoveredRoots.at(-1), [root]);
    key("q");
    await running;
});
