import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTui } from "../../cli/lib/tui.mjs";

const repository = {
    path: "/work/repositories/long-project-name",
    name: "long-project-name",
    state: "dirty",
    branch: "feature/readable-details",
    upstream: "origin/feature/readable-details",
    detached: false,
    ahead: 0,
    behind: 2,
    staged: 0,
    modified: 1,
    untracked: 0,
    conflicts: 0,
    changedFiles: [{ path: "src/a-long-directory/changed-file.ts", kind: "changed" }],
    dirty: true,
    diverged: false,
    canPull: false,
    needsPull: true,
    blockers: ["local changes are present", "the current branch has no upstream"],
};

const model = {
    roots: ["/work/repositories"],
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

test("wraps the selected repository blocker instead of truncating it", () => {
    const output = renderTui(model, { columns: 60, rows: 24 });

    assert.match(output, /Action\s+Blocked: local changes are present; the current/);
    assert.match(output, /\n│\s+branch has no upstream/);
    assert.match(output, /Files\s+src\/a-long-directory\/changed-file\.ts/);
    assert.match(output, /SCOPE\s+All repositories/);
    assert.match(output, /↑↓\/jk move/);
    assert.equal(output.split("\n").length, 24);
    assert.ok(output.split("\n").every((line) => line.length === 60));
});
