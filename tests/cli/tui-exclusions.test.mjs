import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repositories = ["one", "two"].map((name) => ({
    name, path: `/work/${name}`, state: "behind", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 1, staged: 0, modified: 0, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: false, diverged: false, canPull: true,
    needsPull: true, blockers: [],
}));
const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("UI operation did not complete.");
};

const harness = async (t, storage) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), {
        isTTY: true, columns: 120, rows: 30,
        write(value) { frames.push(value); },
    });
    const fetched = [];
    const pulledGroups = [];
    const running = runTui({ roots: ["/work"], color: false }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repositories.map((repository) => repository.path), errors: [] }),
        inspectMany: async (paths) => repositories.filter((repository) => paths.includes(repository.path)),
        refreshMany: async (paths) => { fetched.push(paths); return repositories.filter((repository) => paths.includes(repository.path)).map((repository) => ({ ok: true, repository })); },
        loadGroups: async () => [{ name: "Work", repositories: repositories.map((repository) => repository.path) }],
        saveGroups: () => assert.fail("Hiding must preserve group membership"),
        loadExclusions: async () => [...storage.directories],
        saveExclusions: async (directories) => {
            if (storage.fail) throw new Error("Cannot write settings");
            storage.directories = [...new Set(directories)];
            return [...storage.directories];
        },
        pullMany: async (entries) => { pulledGroups.push(entries.map((repository) => repository.path)); return { results: [], updated: 1, blocked: 0, failed: 0 }; },
    });
    const key = (name, text = "") => input.emit("keypress", text, { name });
    t.after(() => { key("escape"); key("q"); });
    await waitFor(() => /Scanned/.test(frames.at(-1)));
    return { key, frames, running, fetched, pulledGroups };
};

test("hides repositories persistently, preserves group membership, skips fetch and group pull, and restores", async (t) => {
    const storage = { directories: [] };
    const ui = await harness(t, storage);
    ui.key("g"); ui.key("down"); ui.key("return");
    ui.key("d");
    assert.match(ui.frames.at(-1), /directory and files stay on disk/);
    ui.key("n");
    assert.deepEqual(storage.directories, []);
    ui.key("d"); ui.key("y");
    await waitFor(() => /one hidden/.test(ui.frames.at(-1)));
    assert.deepEqual(storage.directories, ["/work/one"]);
    assert.doesNotMatch(ui.frames.at(-1), /›.*one/);
    ui.key("f");
    await waitFor(() => /Remote state fetched/.test(ui.frames.at(-1)));
    assert.deepEqual(ui.fetched, [["/work/two"]]);
    ui.key("a"); ui.key("y");
    await waitFor(() => /Group pull:/.test(ui.frames.at(-1)));
    assert.deepEqual(ui.pulledGroups, [["/work/two"]]);
    ui.key("q"); await ui.running;

    const restarted = await harness(t, storage);
    assert.doesNotMatch(restarted.frames.at(-1), /›.*one/);
    restarted.key("h");
    await waitFor(() => /Hidden directories/.test(restarted.frames.at(-1)));
    assert.match(restarted.frames.at(-1), /› \/work\/one/);
    restarted.key("e");
    for (let index = 0; index < "/work/one".length; index += 1) restarted.key("backspace");
    restarted.key(undefined, "/work"); restarted.key("return");
    await waitFor(() => /Excluded directory saved/.test(restarted.frames.at(-1)));
    assert.deepEqual(storage.directories, ["/work"]);
    restarted.key("escape");
    assert.match(restarted.frames.at(-1), /AUTOPULL  0 repos/);
    restarted.key("h");
    await waitFor(() => /Hidden directories/.test(restarted.frames.at(-1)));
    restarted.key("return");
    await waitFor(() => /Exclusion removed:/.test(restarted.frames.at(-1)));
    assert.deepEqual(storage.directories, []);
    restarted.key("escape");
    assert.match(restarted.frames.at(-1), /AUTOPULL  2 repos/);
    restarted.key("q"); await restarted.running;
});

test("failed saves leave the repository visible and exclusions unchanged", async (t) => {
    const storage = { directories: [], fail: true };
    const ui = await harness(t, storage);
    ui.key("d"); ui.key("y");
    await waitFor(() => /Cannot save excluded directories/.test(ui.frames.at(-1)));
    assert.deepEqual(storage.directories, []);
    assert.match(ui.frames.at(-1), /›.*one/);
    ui.key("q"); await ui.running;
});

test("renders editable exclusions and selected paths within short and narrow viewports", () => {
    const directories = Array.from({ length: 12 }, (_, index) => `/work/project-${index}`);
    const model = { roots: ["/work"], repositories: [], discoveryErrors: [], view: "exclusions", excludedDirectories: directories, excludedIndex: 10 };
    for (const columns of [20, 60, 100]) {
        for (const rows of [8, 12, 24]) {
            const output = renderTui(model, { columns, rows });
            assert.match(output, columns >= 60 ? /› \/work\/project-10/ : /› \/work\/project/);
            assert.equal(output.split("\n").length, rows);
            assert.ok(output.split("\n").every((line) => line.length === columns));
        }
    }
});
