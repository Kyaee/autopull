import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repository = (name, overrides = {}) => ({
    name, path: `/work/${name}`, state: "behind", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 1, staged: 0, modified: 0, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: false, diverged: false, canPull: true,
    needsPull: true, blockers: [], ...overrides,
});
const repositories = [repository("one"), repository("two", { state: "dirty", dirty: true, modified: 1, canPull: false }),
    repository("three"), repository("four", { state: "current", behind: 0, needsPull: false })];
const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("UI operation did not complete");
};
const harness = async (t, services = {}) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 30, write(value) { frames.push(value); } });
    const running = runTui({ roots: ["/work"], color: false, exclusionsPath: "/settings/exclusions.json" }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repositories.map((repo) => repo.path), errors: [] }),
        inspectMany: async (paths) => repositories.filter((repo) => paths.includes(repo.path)),
        loadGroups: async () => [{ name: "Two only", repositories: ["/work/two"] }],
        loadExclusions: async () => [],
        ...services,
    });
    const key = (name) => input.emit("keypress", "", { name });
    const command = (name) => { input.emit("keypress", "\u0001", { name: "a", ctrl: true }); key(name); };
    t.after(() => { key("escape"); key("q"); });
    await waitFor(() => /Scanned/.test(frames.at(-1)));
    return { frames, key, command, running };
};
const markThree = (ui) => {
    ui.key("space"); ui.key("k"); ui.key("space"); ui.key("k"); ui.key("space"); ui.key("k");
};

test("fetches and pulls only marked repositories, confirms the batch, and continues after blocked and failed pulls", async (t) => {
    const fetched = [];
    const pulled = [];
    const ui = await harness(t, {
        refreshMany: async (paths) => { fetched.push(paths); return repositories.filter((repo) => paths.includes(repo.path)).map((repo) => ({ ok: true, repository: repo })); },
        pullRepository: async (path, options) => {
            pulled.push(path);
            assert.equal(options.exclusionsPath, "/settings/exclusions.json");
            if (path === "/work/three") throw new Error("offline");
            return { ok: path === "/work/one", blocked: path === "/work/two", repository: repositories.find((repo) => repo.path === path), message: "result" };
        },
    });
    markThree(ui);
    assert.match(ui.frames.at(-1), /3 selected/);
    assert.equal((ui.frames.at(-1).match(/\[x\]/g) ?? []).length, 3);
    assert.match(ui.frames.at(-1), /› \[ \].*four/);
    ui.key("f");
    await waitFor(() => /Selection fetch/.test(ui.frames.at(-1)));
    assert.deepEqual(fetched, [["/work/one", "/work/two", "/work/three"]]);
    ui.key("p");
    assert.match(ui.frames.at(-1), /3 marked repositories/);
    ui.key("n");
    assert.deepEqual(pulled, []);
    ui.key("p"); ui.key("y");
    await waitFor(() => /Selection pull: 1 updated, 1 blocked, 1 failed/.test(ui.frames.at(-1)));
    assert.deepEqual(pulled, ["/work/one", "/work/two", "/work/three"]);
    ui.command("c");
    assert.doesNotMatch(ui.frames.at(-1), /\d+ selected|\[x\]/);
    ui.key("q"); await ui.running;
});

test("stashes marked repositories only after confirmation and keeps going after failures", async (t) => {
    const stashed = [];
    const ui = await harness(t, { stashRepositoryChanges: async (path, options) => {
        stashed.push(path);
        assert.deepEqual(options, { confirmed: true, exclusionsPath: "/settings/exclusions.json" });
        if (path === "/work/two") throw new Error("index locked");
        return { ok: path === "/work/one", blocked: path === "/work/three", repository: repositories.find((repo) => repo.path === path), message: "result" };
    } });
    markThree(ui);
    ui.command("z");
    assert.match(ui.frames.at(-1), /Stash changes in 3 marked repositories/);
    assert.match(ui.frames.at(-1), /one, two, three/);
    ui.key("escape");
    assert.deepEqual(stashed, []);
    ui.command("z"); ui.key("y");
    await waitFor(() => /Selection stash: 1 stashed, 1 blocked, 1 failed/.test(ui.frames.at(-1)));
    assert.deepEqual(stashed, ["/work/one", "/work/two", "/work/three"]);
    ui.key("q"); await ui.running;
});

test("hides multiple marks in one saved exclusion update and clears removed marks", async (t) => {
    let excluded = [];
    const writes = [];
    const ui = await harness(t, {
        loadExclusions: async () => excluded,
        saveExclusions: async (paths) => { writes.push(paths); excluded = paths; return paths; },
    });
    ui.key("space"); ui.key("k"); ui.key("space"); ui.key("k");
    ui.command("d"); ui.key("n");
    assert.deepEqual(writes, []);
    ui.command("d"); ui.key("y");
    await waitFor(() => /2 repositories hidden/.test(ui.frames.at(-1)));
    assert.deepEqual(writes, [["/work/one", "/work/two"]]);
    assert.match(ui.frames.at(-1), /AUTOPULL  2 repos/);
    assert.doesNotMatch(ui.frames.at(-1), /\[x\]|\d+ selected/);
    ui.key("q"); await ui.running;
});

test("select-all toggles within the group filter, scans retain visible marks, and fetch reloads exclusions", async (t) => {
    let excluded = [];
    const fetched = [];
    const ui = await harness(t, {
        loadExclusions: async () => excluded,
        refreshMany: async (paths) => { fetched.push(paths); return repositories.filter((repo) => paths.includes(repo.path)).map((repo) => ({ ok: true, repository: repo })); },
    });
    ui.command("v");
    assert.match(ui.frames.at(-1), /4 selected/);
    ui.command("v");
    assert.doesNotMatch(ui.frames.at(-1), /\d+ selected|\[x\]/);
    assert.match(ui.frames.at(-1), /› .*one/);
    ui.key("space");
    assert.match(ui.frames.at(-1), /1 selected/);
    ui.command("v");
    assert.match(ui.frames.at(-1), /4 selected/);
    ui.command("s");
    await waitFor(() => /Scanned/.test(ui.frames.at(-1)));
    assert.match(ui.frames.at(-1), /4 selected/);
    excluded = ["/work/one", "/work/four"];
    ui.key("f");
    await waitFor(() => /Selection fetch/.test(ui.frames.at(-1)));
    assert.deepEqual(fetched, [["/work/two", "/work/three"]]);
    assert.match(ui.frames.at(-1), /2 selected/);
    ui.command("g"); ui.key("k"); ui.key("return");
    assert.match(ui.frames.at(-1), /1 selected/);
    ui.command("v");
    assert.doesNotMatch(ui.frames.at(-1), /\[x\]|\d+ selected/);
    assert.match(ui.frames.at(-1), /› .*two/);
    ui.command("v");
    assert.equal((ui.frames.at(-1).match(/\[x\]/g) ?? []).length, 1);
    ui.key("space");
    assert.doesNotMatch(ui.frames.at(-1), /\[x\]|\d+ selected/);
    ui.key("q"); await ui.running;
});

test("marked checkboxes retain cursor, branch, name colors, and footer alignment across layouts", () => {
    const model = { roots: ["/work"], repositories, selectedIndex: 2, discoveryErrors: [], view: "repositories", markedPaths: ["/work/one", "/work/two"] };
    for (const columns of [20, 60, 80, 120]) {
        for (const rows of [8, 12, 24, 32]) {
            for (const color of [false, true]) {
                const rendered = renderTui(model, { columns, rows, color, style: true });
                const output = rendered.replace(/\u001b\[[0-9;]*m/gu, "");
                assert.match(output, /› \[ \]/);
                if (columns >= 60) assert.match(output, /2 selected/);
                // Short stacked layouts reserve the list for the focused repository.
                const neighborsVisible = columns >= 60 && (rows >= 32 || columns >= 120 && rows >= 24);
                if (neighborsVisible) assert.match(output, /\[x\]/);
                assert.match(output, /q quit/);
                assert.equal(output.split("\n").length, rows);
                assert.ok(output.split("\n").every((line) => line.length === columns));
                if (color && neighborsVisible) assert.ok(rendered.includes("\u001b[33mtwo\u001b[39m"));
            }
        }
    }
});
