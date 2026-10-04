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
    assert.match(output, /\u001b\[33mdirty\u001b\[39m/);
    assert.match(output, /\u001b\[31mbroken\u001b\[39m/);
});

test("colors repository names by severity across layouts and preserves selection without colors", () => {
    const repositories = [
        repository("ERROR", "current"),
        repository("broken", "error"),
        repository("conflicted", "conflict", { conflicts: 1 }),
        ...["dirty", "behind", "ahead", "diverged", "detached", "no-upstream"].map((state) => repository(state, state)),
    ];
    for (const columns of [60, 100, 140]) {
        const state = model(repositories);
        const output = renderTui(state, { columns, rows: 32, color: true });
        assert.doesNotMatch(output, /\u001b\[31mERROR\u001b/);
        for (const repo of repositories.slice(1)) {
            const code = ["error", "conflict"].includes(repo.state) ? 31 : 33;
            assert.ok(output.includes(`\u001b[${code}m${repo.name}\u001b[39m`), `${columns}: ${repo.name}`);
        }
        for (const selectedIndex of [1, 3]) {
            state.selectedIndex = selectedIndex;
            const colored = renderTui(state, { columns, rows: 32, color: true });
            const code = selectedIndex === 1 ? 31 : 33;
            assert.ok(colored.includes(`\u001b[27;${code};100m${repositories[selectedIndex].name}\u001b[39;49;7m`));
            assert.ok(plain(colored).split("\n").every((line) => line.length === columns));
            const monochrome = renderTui(state, { columns, rows: 32, style: true, color: false });
            assert.match(monochrome, /\u001b\[1;7m›/);
            assert.doesNotMatch(monochrome, /\u001b\[(?:31|33|27;31;100|27;33;100)m/);
        }
    }
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

const plain = (output) => output.replace(/\u001b\[[0-9;]*m/gu, "");

test("fits panels and controls across terminal sizes and color modes", () => {
    const repositories = Array.from({ length: 35 }, (_, index) => repository(`project-${index}`, "current"));
    const state = model(repositories);
    state.selectedIndex = 22;
    for (const columns of [20, 60, 80, 100, 120, 160]) {
        for (const rows of [8, 12, 18, 24, 32]) {
            for (const color of [false, true]) {
                const output = plain(renderTui(state, { columns, rows, color, style: true }));
                assert.equal(output.split("\n").length, rows, `${columns}x${rows}`);
                assert.ok(output.split("\n").every((line) => line.length === columns), `${columns}x${rows}`);
                assert.match(output, /q quit/);
                if (columns >= 60) assert.match(output, /›.*project-22/);
            }
        }
    }
});

test("anchors details and footer while the selected repository changes", () => {
    const state = model([
        repository("clean", "current"),
        repository("blocked", "dirty", { canPull: false, blockers: ["local changes are present", "the current branch has no upstream"] }),
    ]);
    for (const columns of [60, 100, 140]) {
        state.selectedIndex = 0;
        const first = renderTui(state, { columns, rows: 30 }).split("\n");
        state.selectedIndex = 1;
        const second = renderTui(state, { columns, rows: 30 }).split("\n");
        assert.equal(first.findIndex((line) => line.includes("selected / repository")), second.findIndex((line) => line.includes("selected / repository")));
        assert.deepEqual(first.slice(-3), second.slice(-3));
    }
});

test("renders empty, group, membership, and confirmation panels within the viewport", () => {
    const state = model([]);
    for (const columns of [20, 80, 140]) {
        for (const view of ["repositories", "groups", "members"]) {
            state.view = view;
            const lines = renderTui(state, { columns, rows: 24 }).split("\n");
            assert.equal(lines.length, 24);
            assert.ok(lines.every((line) => line.length === columns));
        }
        state.modal = { kind: "confirm", title: "Pull waiting repositories in the selected group?" };
        const lines = renderTui(state, { columns, rows: 24 }).split("\n");
        assert.ok(lines.every((line) => line.length === columns));
        state.modal = null;
    }
});

test("keeps multiline Git errors and terminal escape sequences inside their panel", () => {
    const state = model([repository("broken", "error", {
        canPull: false,
        blockers: ["fatal: not a git repository\nStopping at filesystem boundary\u001b[2J"],
    })]);
    const output = renderTui(state, { columns: 100, rows: 24 });
    assert.equal(output.split("\n").length, 24);
    assert.ok(output.split("\n").every((line) => line.length === 100));
    assert.ok(!output.includes("\u001b"));
    assert.match(output, /Stopping at filesystem boundary/);
});
