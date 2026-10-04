import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repository = (name, overrides = {}) => ({
    name, path: `/work/${name}`, state: "dirty", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 1, staged: 1, modified: 1, untracked: 1,
    conflicts: 0, changedFiles: [], dirty: true, diverged: false, canPull: false,
    needsPull: true, blockers: ["local changes are present"], ...overrides,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const harness = async (t, services, repositories = [repository("one"), repository("two")]) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(value) { frames.push(value); } });
    const running = runTui({ roots: ["/work"], color: false, exclusionsPath: "/settings/exclusions.json" }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repositories.map((repo) => repo.path), errors: [] }),
        inspectMany: async () => repositories,
        loadGroups: async () => [], loadExclusions: async () => [],
        pullRepository: () => assert.fail("Stash must not pull automatically"),
        ...services,
    });
    const key = (name) => input.emit("keypress", "", { name });
    const command = (name) => { input.emit("keypress", "\u0001", { name: "a", ctrl: true }); key(name); };
    t.after(() => { key("escape"); key("q"); });
    await settle();
    return { frames, key, command, running };
};

test("asks before stashing the selected repository, cancels by default, and refreshes its state after success", async (t) => {
    const calls = [];
    const pending = Promise.withResolvers();
    const ui = await harness(t, {
        stashRepositoryChanges: (path, options) => { calls.push({ path, options }); return pending.promise; },
    });
    assert.match(ui.frames.at(-1), /Ctrl\+A more/);
    ui.key("k");
    for (const cancel of ["n", "escape", "return", "q"]) {
        ui.command("z");
        assert.match(ui.frames.at(-1), /Stash changes in two\?/);
        assert.match(ui.frames.at(-1), /Do you want to continue/);
        assert.match(ui.frames.at(-1), /untracked[\s│]*files/);
        assert.match(ui.frames.at(-1), /\/work\/two/);
        ui.key(cancel);
        assert.equal(calls.length, 0);
    }
    ui.command("z"); ui.key("y");
    assert.deepEqual(calls, [{ path: "/work/two", options: { confirmed: true, exclusionsPath: "/settings/exclusions.json" } }]);
    ui.command("z"); ui.key("y");
    assert.equal(calls.length, 1);
    pending.resolve({ ok: true, message: "Recover: git stash apply --index abc123", repository: repository("two", {
        dirty: false, staged: 0, modified: 0, untracked: 0, state: "behind", canPull: true, blockers: [],
    }) });
    await settle();
    assert.match(ui.frames.at(-1), /Stashed: Recover: git stash apply --index abc123/);
    assert.match(ui.frames.at(-1), /Ready to fast-forward/);
    ui.key("q"); await ui.running;
});

for (const failure of ["blocked", "error"]) {
    test(`shows a stash ${failure} and allows another action`, async (t) => {
        const ui = await harness(t, { stashRepositoryChanges: async () => {
            if (failure === "error") throw new Error("Index is locked");
            return { ok: false, blocked: true, message: "Operation in progress", repository: repository("one") };
        } });
        ui.command("z"); ui.key("y"); await settle();
        assert.match(ui.frames.at(-1), failure === "error" ? /Stash failed: Index is locked/ : /Blocked: Operation in progress/);
        ui.command("z");
        assert.match(ui.frames.at(-1), /Stash changes in one/);
        ui.key("escape"); ui.key("q"); await ui.running;
    });
}

test("does not ask to stash an empty, clean, or conflicted repository", async (t) => {
    for (const repositories of [[], [repository("clean", { dirty: false })], [repository("conflict", { conflicts: 1 })]]) {
        const ui = await harness(t, { stashRepositoryChanges: () => assert.fail("Must not stash") }, repositories);
        ui.command("z");
        assert.doesNotMatch(ui.frames.at(-1), /Do you want to continue/);
        assert.match(ui.frames.at(-1), /Select a repository|no uncommitted changes|Resolve conflicts/);
        ui.key("q"); await ui.running;
    }
});

test("keeps stash scope and confirm/cancel keys visible in compact terminals", () => {
    const repo = repository("one");
    const model = { roots: ["/work"], repositories: [repo], selectedIndex: 0, discoveryErrors: [], view: "repositories",
        modal: { kind: "confirm", compactTitle: "Stash all edits + untracked files in one? Clears working tree. Continue?", title: "Stash changes in one? Do you want to continue?" } };
    for (const [columns, rows] of [[20, 8], [60, 12], [100, 24]]) {
        const output = renderTui(model, { columns, rows });
        assert.match(output, /Stash/);
        assert.match(output, /y confirm/);
        assert.match(output, /cancel/);
        if (columns < 100) assert.match(output, /untracked files/);
        assert.equal(output.split("\n").length, rows);
        assert.ok(output.split("\n").every((line) => line.length === columns));
    }
});
