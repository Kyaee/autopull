import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repository = (name, overrides = {}) => ({
    name, path: `/work/${name}`, state: "current", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: false, diverged: false, canPull: true,
    needsPull: false, blockers: [], ...overrides,
});
const branches = [
    { name: "feature/local", ref: "refs/heads/feature/local", current: false, remote: null },
    { name: "main", ref: "refs/heads/main", current: true, remote: null },
    { name: "origin/feature/remote", ref: "refs/remotes/origin/feature/remote", current: false, remote: "origin" },
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
const harness = async (t, services = {}, repositories = [repository("one"), repository("two")]) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(value) { frames.push(value); } });
    const running = runTui({ roots: ["/work"], color: false, exclusionsPath: "/settings/exclusions.json" }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repositories.map((repo) => repo.path), errors: [] }),
        inspectMany: async () => repositories,
        loadGroups: async () => [], loadExclusions: async () => [],
        listRepositoryBranches: async (path) => ({ repository: repositories.find((repo) => repo.path === path), branches }),
        switchRepositoryBranch: () => assert.fail("Must only switch after choosing a branch"),
        ...services,
    });
    const key = (name, ctrl = false) => input.emit("keypress", "", { name, ctrl });
    const command = () => { key("a", true); key("b"); };
    t.after(() => { key("escape"); key("q"); });
    await settle();
    return { frames, key, command, running };
};

test("branch picker uses the highlighted repository, navigates with reversed j/k, and cancels safely", async (t) => {
    const listed = [];
    const ui = await harness(t, { listRepositoryBranches: async (path) => {
        listed.push(path);
        return { repository: repository("two"), branches };
    } });
    ui.key("space"); ui.key("k"); // Mark one, highlight two.
    ui.key("b");
    assert.equal(listed.length, 0);
    assert.match(ui.frames.at(-1), /Press Ctrl\+A first/);
    for (const cancel of ["escape", "q"]) {
        ui.command(); await settle();
        assert.match(ui.frames.at(-1), /branch \/ two/);
        assert.match(ui.frames.at(-1), /› main  current/);
        ui.key("j");
        assert.match(ui.frames.at(-1), /› feature\/local/);
        ui.key("k"); ui.key("k");
        assert.match(ui.frames.at(-1), /› origin\/feature\/remote  remote/);
        ui.key(cancel);
        assert.doesNotMatch(ui.frames.at(-1), /Enter switch/);
        assert.match(ui.frames.at(-1), /1 selected/);
    }
    assert.deepEqual(listed, ["/work/two", "/work/two"]);
    ui.key("q"); await ui.running;
});

test("switches only the chosen repository, blocks repeated actions while busy, and updates branch and upstream", async (t) => {
    const calls = [];
    const pending = Promise.withResolvers();
    const ui = await harness(t, { switchRepositoryBranch: (path, ref, options) => {
        calls.push({ path, ref, options });
        return pending.promise;
    } });
    ui.key("space"); ui.key("k");
    ui.command(); await settle();
    ui.key("k"); ui.key("return");
    assert.deepEqual(calls, [{ path: "/work/two", ref: "refs/remotes/origin/feature/remote",
        options: { exclusionsPath: "/settings/exclusions.json" } }]);
    assert.match(ui.frames.at(-1), /Changing branch in two/);
    ui.command(); ui.key("return");
    assert.equal(calls.length, 1);
    pending.resolve({ ok: true, message: "two is now on feature/remote.", repository: repository("two", {
        branch: "feature/remote", upstream: "origin/feature/remote",
    }) });
    await settle();
    assert.match(ui.frames.at(-1), /Branch: two is now on feature\/remote/);
    assert.match(ui.frames.at(-1), /feature\/remote  →  origin\/feature\/remote/);
    assert.match(ui.frames.at(-1), /1 selected/);
    ui.key("q"); await ui.running;
});

for (const outcome of ["blocked", "failed", "error"]) {
    test(`reports switch outcome ${outcome} and allows reopening the picker`, async (t) => {
        const ui = await harness(t, { switchRepositoryBranch: async () => {
            if (outcome === "error") throw new Error("Index is locked");
            return { ok: false, blocked: outcome === "blocked", message: "Cannot switch yet", repository: repository("one") };
        } });
        ui.command(); await settle(); ui.key("j"); ui.key("return"); await settle();
        assert.match(ui.frames.at(-1), outcome === "error" ? /Branch change failed: Index is locked/
            : outcome === "blocked" ? /Blocked: Cannot switch yet/ : /Failed: Cannot switch yet/);
        ui.command(); await settle();
        assert.match(ui.frames.at(-1), /› main  current/);
        ui.key("escape"); ui.key("q"); await ui.running;
    });
}

test("handles an empty dashboard, no branches, and a list error without opening a picker", async (t) => {
    const empty = await harness(t, { listRepositoryBranches: () => assert.fail("No repository selected") }, []);
    empty.command();
    assert.match(empty.frames.at(-1), /Select a repository to change branches/);
    empty.key("q"); await empty.running;
    for (const failed of [false, true]) {
        const ui = await harness(t, { listRepositoryBranches: async () => {
            if (failed) throw new Error("Repository removed");
            return { repository: repository("one"), branches: [] };
        } });
        ui.command(); await settle();
        assert.match(ui.frames.at(-1), failed ? /Cannot load branches: Repository removed/ : /No branches found/);
        assert.doesNotMatch(ui.frames.at(-1), /Enter switch/);
        ui.key("q"); await ui.running;
    }
});

test("quitting during branch discovery prevents a late popup or branch switch", async (t) => {
    const pending = Promise.withResolvers();
    const ui = await harness(t, { listRepositoryBranches: () => pending.promise });
    ui.command();
    assert.match(ui.frames.at(-1), /Loading branches/);
    ui.key("q"); await ui.running;
    const count = ui.frames.length;
    pending.resolve({ repository: repository("one"), branches });
    await settle();
    assert.equal(ui.frames.length, count);
});

test("keeps the selected branch and switch/cancel controls visible across terminal sizes and colors", () => {
    const choices = Array.from({ length: 15 }, (_, index) => ({ name: `feature/${index}`, ref: `refs/heads/feature/${index}` }));
    const model = { roots: ["/work"], repositories: [repository("one")], selectedIndex: 0, discoveryErrors: [], view: "repositories",
        modal: { kind: "branches", repository: repository("one"), branches: choices, selectedIndex: 14 } };
    for (const columns of [20, 60, 80, 120]) {
        for (const rows of [8, 12, 24]) {
            for (const color of [false, true]) {
                const rendered = renderTui(model, { columns, rows, color, style: true });
                if (columns >= 60 && rows >= 24) assert.ok(rendered.includes("Choose a branch, then Enter."));
                const output = rendered.replace(/\u001b\[[0-9;]*m/gu, "");
                assert.match(output, /› feature\/14/);
                assert.match(output, /Enter switch/);
                assert.match(output, /Esc/);
                assert.equal(output.split("\n").length, rows);
                assert.ok(output.split("\n").every((line) => line.length === columns));
            }
        }
    }
});
