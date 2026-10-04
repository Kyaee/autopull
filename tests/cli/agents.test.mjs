import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { discoverCodingAgents, findExecutable, launchCodingAgent, parseCliCommand, resolveCodingAgent } from "../../cli/lib/agents.mjs";

const fixture = async (t) => {
    const build = join(process.cwd(), "build");
    await mkdir(build, { recursive: true });
    const directory = await mkdtemp(join(build, "agent tests-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
};

const executable = async (path, source = "#!/bin/sh\nexit 0\n") => {
    await writeFile(path, source);
    await chmod(path, 0o755);
};

test("detects installed coding agents in PATH order, including executable symlinks", async (t) => {
    const directory = await fixture(t);
    const second = join(directory, "second");
    await mkdir(second);
    await executable(join(directory, "codex"));
    await executable(join(second, "codex"));
    await executable(join(directory, "agy"));
    await executable(join(directory, "copilot"));
    await executable(join(directory, "kiro-cli"));
    await executable(join(directory, "custom"));
    await symlink(join(directory, "custom"), join(directory, "claude"));
    await writeFile(join(directory, "aider"), "not executable");
    await mkdir(join(directory, "opencode"));
    const agents = await discoverCodingAgents(`${directory}${delimiter}${second}`);
    assert.deepEqual(agents.map((agent) => agent.name), ["Codex", "Claude Code", "AGY", "Copilot", "Kiro"]);
    assert.equal(agents[0].executable, join(directory, "codex"));
    assert.deepEqual(agents.at(-1).args, ["chat"]);
    assert.deepEqual(agents[0].args, []);
    assert.deepEqual(await discoverCodingAgents(join(directory, "missing")), []);
    assert.equal(await findExecutable("aider", directory), null);
});

test("parses custom commands with quotes and treats shell operators as literal arguments", () => {
    assert.deepEqual(parseCliCommand('"/path with spaces/agent" chat --name ""'), ["/path with spaces/agent", "chat", "--name", ""]);
    assert.deepEqual(parseCliCommand("agent '$(touch sentinel)' ';' `id`"), ["agent", "$(touch sentinel)", ";", "`id`"]);
    assert.deepEqual(parseCliCommand("agent path\\ with\\ spaces"), ["agent", "path with spaces"]);
    assert.throws(() => parseCliCommand(""), /Enter a CLI command/);
    assert.throws(() => parseCliCommand('agent "unfinished'), /Finish the quoted argument/);
});

test("launches a custom CLI in the repository with literal arguments and reports exits", async (t) => {
    const directory = await fixture(t);
    const repository = join(directory, "repository with spaces");
    await mkdir(repository);
    const binary = join(directory, "my-cli");
    await executable(binary, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync("launch.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\nprocess.exit(7);\n`);
    // Extensionless scripts with ESM syntax require an explicit module package.
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    const agent = await resolveCodingAgent('my-cli chat "$(touch sentinel)"', directory);
    const interruptListeners = process.listenerCount("SIGINT");
    const result = await launchCodingAgent(agent, repository, { stdio: "ignore" });
    assert.equal(process.listenerCount("SIGINT"), interruptListeners);
    assert.deepEqual(result, { code: 7, signal: null });
    assert.deepEqual(JSON.parse(await readFile(join(repository, "launch.json"), "utf8")), {
        cwd: repository, args: ["chat", "$(touch sentinel)"],
    });
    await assert.rejects(readFile(join(repository, "sentinel")), { code: "ENOENT" });
    await assert.rejects(resolveCodingAgent("missing", directory), /CLI executable not found/);
    await assert.rejects(launchCodingAgent({ executable: join(directory, "missing"), args: [] }, repository, { stdio: "ignore" }), { code: "ENOENT" });
    assert.equal(process.listenerCount("SIGINT"), interruptListeners);
});
