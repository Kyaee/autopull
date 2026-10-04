import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, resolve } from "node:path";

const CODING_AGENTS = [
    { name: "Codex", command: "codex" },
    { name: "Claude Code", command: "claude" },
    { name: "AGY", command: "agy" },
    { name: "Copilot", command: "copilot" },
    { name: "Kiro", command: "kiro-cli", args: ["chat"] },
    { name: "OpenCode", command: "opencode" },
    { name: "Aider", command: "aider" },
    { name: "Gemini CLI", command: "gemini" },
    { name: "Qwen Code", command: "qwen" },
    { name: "Amp", command: "amp" },
    { name: "Cursor Agent", command: "cursor-agent" },
    { name: "Droid", command: "droid" },
    { name: "Pi", command: "pi" },
];

export const findExecutable = async (command, path = process.env.PATH ?? "") => {
    const expanded = command.startsWith("~/") ? resolve(homedir(), command.slice(2)) : command;
    const candidates = expanded.includes("/")
        ? [resolve(expanded)]
        : path.split(delimiter).map((directory) => resolve(directory || ".", expanded));
    for (const candidate of candidates) {
        try {
            if (!(await stat(candidate)).isFile()) continue;
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Missing or non-executable candidates do not prevent checking later PATH entries.
        }
    }
    return null;
};

export const discoverCodingAgents = async (path = process.env.PATH ?? "") => {
    const agents = await Promise.all(CODING_AGENTS.map(async (agent) => {
        const executable = await findExecutable(agent.command, path);
        return executable ? { ...agent, executable, args: agent.args ?? [] } : null;
    }));
    return agents.filter(Boolean);
};

// Parse quoted arguments without evaluating shell substitutions or operators.
export const parseCliCommand = (value) => {
    const tokens = [];
    let token = "";
    let quote = null;
    let escaped = false;
    let started = false;
    for (const character of value.trim()) {
        if (escaped) {
            token += character;
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
            started = true;
        } else if (quote) {
            if (character === quote) quote = null;
            else token += character;
        } else if (character === "'" || character === '"') {
            quote = character;
            started = true;
        } else if (/\s/u.test(character)) {
            if (started) tokens.push(token);
            token = "";
            started = false;
        } else {
            token += character;
            started = true;
        }
    }
    if (quote || escaped) throw new Error("Finish the quoted argument or escaped character.");
    if (started) tokens.push(token);
    if (!tokens[0]) throw new Error("Enter a CLI command.");
    return tokens;
};

export const resolveCodingAgent = async (value, path = process.env.PATH ?? "") => {
    const [command, ...args] = parseCliCommand(value);
    const executable = await findExecutable(command, path);
    if (!executable) throw new Error(`CLI executable not found: ${command}`);
    return { name: basename(command), command, executable, args };
};

export const launchCodingAgent = (agent, repositoryPath, options = {}) => new Promise((resolveExit, reject) => {
    // The child shares the foreground process group; keep its Ctrl+C from exiting Autopull.
    const ignoreInterrupt = () => {};
    process.on("SIGINT", ignoreInterrupt);
    const cleanup = () => process.off("SIGINT", ignoreInterrupt);
    let child;
    try {
        child = spawn(agent.executable, agent.args, {
            cwd: repositoryPath,
            stdio: options.stdio ?? "inherit",
            shell: false,
        });
    } catch (error) {
        cleanup();
        reject(error);
        return;
    }
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => { cleanup(); resolveExit({ code, signal }); });
});
