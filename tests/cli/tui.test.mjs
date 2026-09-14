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
    assert.match(output, /r refresh/);
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
    assert.equal(tuiActionForKey({ name: "return" }), "enter");
    assert.equal(tuiActionForKey({ name: "g" }), "groups");
    assert.equal(tuiActionForKey({ name: "space" }), "toggle");
    assert.equal(tuiActionForKey({ name: "c", ctrl: true }), "quit");
    assert.equal(tuiActionForKey({ name: "x" }), null);
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
