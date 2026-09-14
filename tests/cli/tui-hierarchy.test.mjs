import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTui } from "../../cli/lib/tui.mjs";

const repository = {
    path: "/work/example",
    name: "example",
    state: "current",
    branch: "main",
    upstream: "origin/main",
    detached: false,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    changedFiles: [],
    dirty: false,
    diverged: false,
    canPull: true,
    needsPull: false,
    blockers: [],
};

const model = {
    roots: ["/work"],
    allRepositories: [repository],
    repositories: [repository],
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
};

test("labels repository columns at compact terminal widths", () => {
    const output = renderTui(model, { columns: 70, rows: 24 });

    assert.match(output, /BRANCH\s+REPOSITORY\s+STATE/);
    assert.match(output, /@main\s+example\s+CURRENT/);
    assert.ok(output.split("\n").every((line) => line.length === 70));
});
