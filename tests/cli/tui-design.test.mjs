import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTui } from "../../cli/lib/tui.mjs";

const repository = (name, state, overrides = {}) => ({
    path: `/work/${name}`,
    name,
    state,
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

test("uses a full-row selection treatment and semantic state colors", () => {
    const repositories = [
        repository("selected", "current"),
        repository("dirty", "dirty", { dirty: true, modified: 2, canPull: false, blockers: ["local changes are present"] }),
        repository("broken", "error", { canPull: false, blockers: ["cannot inspect"] }),
    ];
    const output = renderTui(model(repositories), { columns: 100, rows: 30, color: true });

    assert.match(output, /\u001b\[1;7m› selected/);
    assert.match(output, /\u001b\[33mDIRTY 2\u001b\[0m/);
    assert.match(output, /\u001b\[1;31mERROR\u001b\[0m/);
});

test("keeps selection styling when terminal colors are disabled", () => {
    const output = renderTui(model([repository("selected", "current")]), {
        columns: 80,
        rows: 24,
        style: true,
        color: false,
    });

    assert.match(output, /\u001b\[1;7m› selected/);
});
