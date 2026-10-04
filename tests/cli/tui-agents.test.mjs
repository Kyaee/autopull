import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { renderTui, runTui } from "../../cli/lib/tui.mjs";

const repository = (name) => ({
    path: `/work/${name}`, name, state: "dirty", branch: "main", upstream: "origin/main",
    detached: false, ahead: 0, behind: 0, staged: 0, modified: 1, untracked: 0,
    conflicts: 0, changedFiles: [], dirty: true, diverged: false, canPull: false,
    needsPull: false, blockers: ["local changes are present"],
});
const agent = { name: "Codex", command: "codex", executable: "/tools/codex", args: [] };
const settle = () => new Promise((resolve) => setImmediate(resolve));

const harness = async (t, services = {}, repositories = [repository("one"), repository("two")]) => {
    const input = Object.assign(new EventEmitter(), {
        isTTY: true, isRaw: false, paused: false,
        setRawMode(raw) { this.isRaw = raw; },
        resume() { this.paused = false; },
        pause() { this.paused = true; },
        isPaused() { return this.paused; },
    });
    const frames = [];
    const output = Object.assign(new EventEmitter(), {
        isTTY: true, columns: 100, rows: 30,
        write(frame) { frames.push(frame); },
    });
    let scans = 0;
    const running = runTui({ roots: ["/work"], color: false }, { stdin: input, stdout: output }, {
        discoverRepositories: async () => ({ repositories: repositories.map((repo) => repo.path), errors: [] }),
        inspectMany: async () => { scans += 1; return repositories; },
        loadGroups: async () => [],
        discoverCodingAgents: async () => [agent],
        ...services,
    });
    const key = (name, text = "") => input.emit("keypress", text, { name });
    t.after(() => { key("escape"); key("q"); });
    await settle();
    return { input, output, frames, key, running, scans: () => scans };
};

for (const outcome of ["success", "nonzero", "signal", "error"]) {
    test(`Fix hands the terminal to the selected agent and restores it after ${outcome}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const pending = Promise.withResolvers();
        const launches = [];
        const ui = await harness(t, {
            launchCodingAgent: (tool, path) => { launches.push({ tool, path }); return pending.promise; },
        });
        ui.key("k");
        ui.key("x");
        await settle();
        assert.match(ui.frames.at(-1), /fix \/ two/);
        assert.match(ui.frames.at(-1), /Codex \(codex\)/);
        ui.key("escape");
        assert.equal(launches.length, 0);
        ui.key("x");
        await settle();
        ui.key("return");
        assert.deepEqual(launches, [{ tool: agent, path: "/work/two" }]);
        assert.equal(ui.input.isRaw, false);
        assert.equal(ui.input.paused, true);
        assert.equal(ui.input.listenerCount("keypress"), 0);
        assert.equal(ui.output.listenerCount("resize"), 0);
        assert.match(ui.frames.at(-1), /\u001b\[\?1049l/);
        const count = ui.frames.length;
        ui.key("q");
        ui.output.emit("resize");
        t.mock.timers.tick(1000);
        assert.equal(ui.frames.length, count);
        if (outcome === "error") pending.reject(new Error("Executable disappeared"));
        else pending.resolve(outcome === "success" ? { code: 0, signal: null }
            : outcome === "signal" ? { code: null, signal: "SIGINT" } : { code: 7, signal: null });
        await settle();
        assert.equal(ui.input.isRaw, true);
        assert.equal(ui.input.paused, false);
        assert.equal(ui.input.listenerCount("keypress"), 1);
        assert.equal(ui.output.listenerCount("resize"), 1);
        assert.equal(ui.scans(), 2);
        assert.match(ui.frames.at(-1), /Codex (?:closed|exited|:)|Cannot open Codex/);
        assert.match(ui.frames.at(-1), /›.*two/);
        ui.key("q");
        await ui.running;
        assert.equal(ui.input.isRaw, false);
    });
}

test("offers a custom command when no coding agents are detected and recovers from invalid commands", async (t) => {
    const commands = [];
    const launches = [];
    const ui = await harness(t, {
        discoverCodingAgents: async () => [],
        resolveCodingAgent: async (value) => {
            commands.push(value);
            if (value === "missing") throw new Error("CLI executable not found: missing");
            return { ...agent, name: "Custom" };
        },
        launchCodingAgent: async (tool, path) => { launches.push({ tool, path }); return { code: 0, signal: null }; },
    });
    for (const command of ["missing", '"custom CLI" chat']) {
        ui.key("x");
        await settle();
        assert.match(ui.frames.at(-1), /› Other CLI/);
        ui.key("return");
        assert.match(ui.frames.at(-1), /coding CLI/);
        ui.key(undefined, command);
        ui.key("return");
        await settle();
        assert.match(ui.frames.at(-1), command === "missing" ? /CLI executable not found/ : /Custom closed/);
    }
    assert.deepEqual(commands, ["missing", '"custom CLI" chat']);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].path, "/work/one");
    ui.key("q");
    await ui.running;
});

test("does not open an agent without a selected repository", async (t) => {
    const ui = await harness(t, { discoverCodingAgents: () => assert.fail("Should not detect tools without a repository") }, []);
    ui.key("x");
    assert.match(ui.frames.at(-1), /Select a repository to fix/);
    ui.key("q");
    await ui.running;
});

test("does not launch a custom CLI after quitting while its command is being resolved", async (t) => {
    const pending = Promise.withResolvers();
    const ui = await harness(t, {
        discoverCodingAgents: async () => [],
        resolveCodingAgent: () => pending.promise,
        launchCodingAgent: () => assert.fail("Must not launch after quit"),
    });
    ui.key("x");
    await settle();
    ui.key("return");
    ui.key(undefined, "custom");
    ui.key("return");
    ui.key("q");
    await ui.running;
    const count = ui.frames.length;
    pending.resolve(agent);
    await settle();
    assert.equal(ui.frames.length, count);
    assert.equal(ui.input.isRaw, false);
});

test("keeps the selected coding agent visible in short and narrow terminals", () => {
    const repo = repository("example");
    const agents = [...Array.from({ length: 12 }, (_, index) => ({ name: `Tool ${index}` })), { name: "Other CLI…" }];
    const model = {
        roots: ["/work"], repositories: [repo], discoveryErrors: [], selectedIndex: 0,
        view: "repositories", modal: { kind: "agents", repository: repo, agents, selectedIndex: 12 },
    };
    for (const columns of [20, 60, 80, 120]) {
        for (const rows of [8, 12, 24]) {
            const output = renderTui(model, { columns, rows });
            assert.match(output, /› Other CLI/);
            assert.equal(output.split("\n").length, rows);
            assert.ok(output.split("\n").every((line) => line.length === columns));
        }
    }
});
