import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repository = {
    path: "/work/one", name: "one", state: "behind", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 1, staged: 0, modified: 0, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: false, diverged: false, canPull: true,
    needsPull: true, blockers: [],
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Ctrl+A arms one secondary command, cancels safely, and leaves primary and screen shortcuts direct", async (t) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
    const frames = [];
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write(frame) { frames.push(frame); } });
    let scans = 0;
    let fetches = 0;
    let pulls = 0;
    const pending = Promise.withResolvers();
    const running = runTui({ roots: ["/work"], color: false }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: [repository.path], errors: [] }),
        inspectMany: async () => { scans += 1; return scans === 2 ? pending.promise : [repository]; },
        loadGroups: async () => [], loadExclusions: async () => [],
        refreshMany: async () => { fetches += 1; return [{ ok: true, repository }]; },
        pullRepository: async () => { pulls += 1; return { ok: true, repository, message: "updated" }; },
        discoverCodingAgents: () => assert.fail("An unprefixed key must not open an agent"),
        stashRepositoryChanges: () => assert.fail("An unprefixed key must not stash"),
        saveExclusions: () => assert.fail("An unprefixed key must not hide files"),
    });
    const key = (name, ctrl = false, text = "") => input.emit("keypress", text, { name, ctrl });
    const prefix = () => key("a", true);
    t.after(() => { pending.resolve([repository]); key("escape"); key("q"); });
    await settle();
    for (const name of ["s", "o", "x", "z", "d", "h", "g", "a"]) {
        key(name);
        assert.match(frames.at(-1), /Press Ctrl\+A first/);
    }
    assert.equal(scans, 1);
    prefix();
    assert.match(frames.at(-1), /Ctrl\+A  s scan/);
    assert.match(frames.at(-1), /z stash/);
    key("escape");
    assert.doesNotMatch(frames.at(-1), /Ctrl\+A  s scan/);
    prefix(); key("b"); key("g");
    assert.doesNotMatch(frames.at(-1), /Repository groups/);
    prefix(); key("x", true); key("x");
    assert.match(frames.at(-1), /Press Ctrl\+A first/);
    prefix(); key("s"); await settle();
    assert.equal(scans, 2);
    prefix(); // Busy operations cannot arm a prefix for a later key.
    pending.resolve([repository]); await settle();
    key("g");
    assert.doesNotMatch(frames.at(-1), /Repository groups/);
    prefix(); key("g");
    assert.match(frames.at(-1), /Repository groups/);
    key("n");
    key("a", false, "a");
    assert.match(frames.at(-1), /> a_/);
    key("escape"); key("escape");
    key("f"); await settle();
    key("p"); await settle();
    assert.equal(fetches, 1);
    assert.equal(pulls, 1);
    prefix(); key("q"); await running;
});

test("prefix bar shows commands above controls while retaining the repository across terminal sizes and color modes", () => {
    const model = { roots: ["/work"], repositories: [repository], selectedIndex: 0, discoveryErrors: [],
        view: "repositories", activeGroup: "Work", prefixArmed: true };
    for (const columns of [20, 60, 80, 120]) {
        for (const rows of [8, 12, 18, 20, 30]) {
          for (const color of [false, true]) {
            const rendered = renderTui(model, { columns, rows, color, style: true });
            const output = rendered.replace(/\u001b\[[0-9;]*m/gu, "");
            for (const command of ["s scan", "x fix", "z stash", "d hide", "h hidden", "g groups", "o root", "a group", "v all", "c clear"]) {
                assert.ok(output.includes(command), `${columns}x${rows}: ${command}`);
            }
            assert.match(output, /Esc cancel/);
            assert.match(output, /›/);
            assert.ok(output.indexOf("›") < output.indexOf("Ctrl+A  s scan"));
            assert.ok(output.indexOf("Esc cancel") < output.lastIndexOf("q quit"));
            if (color) assert.match(rendered, /\u001b\[1;97;44m/);
            else assert.doesNotMatch(rendered, /\u001b\[1;97;44m/);
            assert.equal(output.split("\n").length, rows);
            assert.ok(output.split("\n").every((line) => line.length === columns));
          }
        }
    }
});
