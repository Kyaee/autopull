import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTui, tuiActionForKey } from "../../cli/lib/tui.mjs";

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
    repositories,
    summary: null,
    discoveryErrors: [],
    selectedIndex: 0,
    busy: false,
    activity: "",
    notification: "",
});

test("renders repository state, selected details, and TUI controls", () => {
    const output = renderTui(model([repository()]), { columns: 100, rows: 30 });

    assert.match(output, /AUTOPULL  1 repos  1 ready/);
    assert.match(output, /› example/);
    assert.match(output, /Branch  main  →  origin\/main/);
    assert.match(output, /Ready to fast-forward\. Press p to pull/);
    assert.match(output, /r refresh remotes/);
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
    assert.equal(tuiActionForKey({ name: "j" }), "down");
    assert.equal(tuiActionForKey({ name: "r" }), "refresh");
    assert.equal(tuiActionForKey({ name: "return" }), "pull");
    assert.equal(tuiActionForKey({ name: "c", ctrl: true }), "quit");
    assert.equal(tuiActionForKey({ name: "x" }), null);
});
