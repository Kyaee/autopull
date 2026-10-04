import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui, tuiActionForKey } from "../../cli/lib/tui.mjs";

const repository = (name, path, branch = "main") => ({
    name, path, branch, state: "behind", upstream: `origin/${branch}`,
    detached: false, ahead: 0, behind: 1, staged: 0, modified: 0, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: false, diverged: false, canPull: true,
    needsPull: true, blockers: [],
});
const repositories = [repository("alpha", "/work/team/alpha"), repository("beta", "/work/client/beta", "feature/search"),
    repository("gamma", "/work/archive/gamma", "release/qfpgx")];
const settle = () => new Promise((resolve) => setImmediate(resolve));
const plain = (output) => output.replace(/\u001b\[[0-9;]*m/gu, "");
const harness = async (t, services = {}, repos = repositories) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(frame) { frames.push(plain(frame)); } });
    const running = runTui({ roots: ["/work"], color: false }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repos.map((repo) => repo.path), errors: [] }),
        inspectMany: async () => repos,
        loadGroups: async () => [{ name: "Client", repositories: [repositories[1].path, repositories[2].path] }],
        loadExclusions: async () => [],
        refreshMany: () => assert.fail("Search must not fetch"),
        pullRepository: () => assert.fail("Search must not pull"),
        discoverCodingAgents: () => assert.fail("Search must not launch tools"),
        listRepositoryBranches: () => assert.fail("Search must not open branches"),
        stashRepositoryChanges: () => assert.fail("Search must not stash"),
        saveExclusions: () => assert.fail("Search must not hide"),
        ...services,
    });
    const key = (name, text = "", ctrl = false) => input.emit("keypress", text, { name, sequence: text, ctrl, meta: name === "escape" });
    const command = (name) => { key("a", "\u0001", true); key(name); };
    const search = (query) => { key(undefined, "/"); key(undefined, query); key("return"); };
    t.after(() => { key("c", "\u0003", true); });
    await settle();
    return { frames, key, command, search, running, input };
};

test("slash opens a live, case-insensitive name, path, or branch filter and Escape clears the applied search", async (t) => {
    assert.equal(tuiActionForKey({ sequence: "/" }), "search");
    assert.equal(tuiActionForKey({ name: "/" }), "search");
    assert.equal(tuiActionForKey({ name: "escape", sequence: "\u001b", meta: true }), "back");
    const ui = await harness(t);
    for (const [query, name] of [["ALPHA", "alpha"], ["CLIENT", "beta"], ["FEATURE/SEARCH", "beta"], ["qfpgx", "gamma"]]) {
        ui.key(undefined, "/");
        assert.match(ui.frames.at(-1), /Search \/  _/);
        assert.match(ui.frames.at(-1), /Enter apply/);
        ui.key(undefined, query);
        assert.match(ui.frames.at(-1), /AUTOPULL  1 repos/);
        assert.ok(ui.frames.at(-1).includes(`Search /  ${query}_`));
        assert.match(ui.frames.at(-1), new RegExp(`› .*${name}`));
        ui.key("return");
        assert.doesNotMatch(ui.frames.at(-1), /Enter apply/);
        assert.ok(ui.frames.at(-1).includes(`Search /  ${query}`));
        ui.key("escape");
        assert.match(ui.frames.at(-1), /AUTOPULL  3 repos/);
        assert.match(ui.frames.at(-1), /Press \/ to search/);
    }
    ui.search("[");
    assert.match(ui.frames.at(-1), /No repositories match "\["/);
    assert.match(ui.frames.at(-1), /AUTOPULL  0 repos/);
    ui.key("return");
    assert.match(ui.frames.at(-1), /There is no repository to pull/);
    ui.key("escape"); ui.key("q"); await ui.running;
});

test("typing dashboard shortcuts, spaces, and slash stays in search, Ctrl+U clears it, and Ctrl+C exits", async (t) => {
    const ui = await harness(t);
    ui.key(undefined, "/");
    for (const letter of "fpgxbzdsvohq") ui.key(letter, letter);
    ui.key("space", " "); ui.key(undefined, "/");
    ui.key("a", "\u0001", true);
    assert.match(ui.frames.at(-1), /Search \/  fpgxbzdsvohq \/_/);
    assert.doesNotMatch(ui.frames.at(-1), /Press \/ to edit the search/);
    assert.equal(ui.input.listenerCount("keypress"), 1);
    assert.doesNotMatch(ui.frames.at(-1), /Ctrl\+A \/ commands/);
    ui.key("u", "\u0015", true);
    assert.match(ui.frames.at(-1), /Search \/  _/);
    assert.match(ui.frames.at(-1), /AUTOPULL  3 repos/);
    ui.key("c", "\u0003", true); await ui.running;
    assert.equal(ui.input.listenerCount("keypress"), 0);
});

test("cancel restores query, cursor, and marks; backspace restores draft matches, and applied batch actions use matching marks", async (t) => {
    const fetched = [];
    const ui = await harness(t, { refreshMany: async (paths) => {
        fetched.push(paths);
        return repositories.filter((repo) => paths.includes(repo.path)).map((repo) => ({ ok: true, repository: repo }));
    } });
    ui.key("space"); ui.key("k"); ui.key("space"); ui.key("k");
    ui.key(undefined, "/"); ui.key(undefined, "alpha");
    assert.match(ui.frames.at(-1), /1 selected/);
    ui.key("escape");
    assert.match(ui.frames.at(-1), /2 selected/);
    assert.match(ui.frames.at(-1), /› \[ \].*gamma/);
    ui.key(undefined, "/"); ui.key(undefined, "alphaX");
    assert.match(ui.frames.at(-1), /AUTOPULL  0 repos/);
    ui.key("backspace");
    assert.match(ui.frames.at(-1), /1 selected/);
    assert.match(ui.frames.at(-1), /› \[x\].*alpha/);
    ui.key("return");
    ui.key("f"); await settle();
    assert.deepEqual(fetched, [[repositories[0].path]]);
    assert.match(ui.frames.at(-1), /AUTOPULL  1 repos/);
    ui.key(undefined, "/"); ui.key("u", "\u0015", true); ui.key(undefined, "beta"); ui.key("escape");
    assert.match(ui.frames.at(-1), /Search \/  alpha/);
    assert.match(ui.frames.at(-1), /› \[x\].*alpha/);
    ui.key("escape");
    assert.match(ui.frames.at(-1), /AUTOPULL  3 repos  1 selected/);
    ui.key("q"); await ui.running;
});

test("search remains inside the active group, survives scans, and slash closes the command popup", async (t) => {
    const ui = await harness(t);
    ui.command("g"); ui.key("k"); ui.key("return");
    assert.match(ui.frames.at(-1), /repositories \/ Client/);
    ui.search("alpha");
    assert.match(ui.frames.at(-1), /AUTOPULL  0 repos/);
    ui.key("escape");
    assert.match(ui.frames.at(-1), /AUTOPULL  2 repos/);
    ui.key("a", "\u0001", true); ui.key(undefined, "/");
    assert.doesNotMatch(ui.frames.at(-1), /Ctrl\+A \/ commands/);
    assert.match(ui.frames.at(-1), /Enter apply/);
    ui.key(undefined, "client"); ui.key("return");
    ui.command("s"); await settle();
    assert.match(ui.frames.at(-1), /Search \/  client/);
    assert.match(ui.frames.at(-1), /AUTOPULL  1 repos/);
    assert.match(ui.frames.at(-1), /›.*beta/);
    ui.key("q"); await ui.running;
});

test("search works with an empty dashboard and quit remains available", async (t) => {
    const ui = await harness(t, {}, []);
    ui.search("project");
    assert.match(ui.frames.at(-1), /Search \/  project/);
    assert.match(ui.frames.at(-1), /AUTOPULL  0 repos/);
    ui.key("escape");
    assert.match(ui.frames.at(-1), /No Git repositories found/);
    ui.key("q"); await ui.running;
});

test("search has its own top panel with a visible input tail and fixed controls across terminal sizes and color modes", () => {
    const query = "very-long-directory/with-a-long-query-tail";
    const base = { roots: ["/work"], repositories, discoveryErrors: [], selectedIndex: 0, view: "repositories", searchQuery: query };
    for (const columns of [20, 60, 80, 120]) {
        for (const rows of [8, 12, 18, 24, 30]) {
            for (const color of [false, true]) {
                const focused = renderTui({ ...base, searchEditing: true }, { columns, rows, color, style: true });
                const idle = plain(renderTui(base, { columns, rows, color, style: true })).split("\n");
                const lines = plain(focused).split("\n");
                assert.match(lines[0], /╭─ search/);
                assert.match(lines[1], /Search \/.*tail_/);
                assert.match(lines[2], /╰─.*╯/);
                if (rows >= 14) assert.match(lines[3], /╭─ autopull/);
                assert.match(lines.at(rows < 12 ? -1 : -2), /Enter apply/);
                assert.equal(lines.length, rows);
                assert.ok(lines.every((line) => line.length === columns));
                assert.equal(lines.findIndex((line) => line.includes("controls")), idle.findIndex((line) => line.includes("controls")));
                if (color) assert.match(focused, /\u001b\[1;97;44mSearch/);
                else assert.match(focused, /\u001b\[1;7mSearch/);
            }
        }
    }
});
