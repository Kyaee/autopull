#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepositories } from "./lib/discovery.mjs";
import { formatPull, formatScan } from "./lib/format.mjs";
import { inspectRepository, pullRepository } from "./lib/git.mjs";
import { envelope, inspectMany, refreshMany, summarize } from "./lib/protocol.mjs";

const HELP = `Autopull safely inspects and updates local Git repositories.

Usage:
  autopull scan [roots...] [--json] [--max-depth N]
  autopull refresh [roots...] [--json] [--max-depth N]
  autopull status <repository> [--json]
  autopull pull <repository> [--json]

Commands:
  scan     Discover repositories and inspect their local Git state
  refresh  Fetch and then inspect repositories without changing working trees
  status   Inspect one repository
  pull     Pull one clean repository using --ff-only

Scan is read-only. Use refresh when remote counts must be current.`;

const parsedArguments = (argv) => {
    const values = [];
    let json = false;
    let maxDepth = 4;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--json") {
            json = true;
        } else if (argument === "--max-depth") {
            maxDepth = Number(argv[index + 1]);
            index += 1;
        } else if (argument.startsWith("--max-depth=")) {
            maxDepth = Number(argument.split("=", 2)[1]);
        } else if (argument.startsWith("-")) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            values.push(argument);
        }
    }

    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) {
        throw new Error("--max-depth must be an integer from 0 to 12.");
    }

    return { values, json, maxDepth };
};

const defaultRoots = () => {
    const fromEnvironment = process.env.AUTOPULL_ROOTS?.split(":").filter(Boolean) ?? [];
    if (fromEnvironment.length > 0) return fromEnvironment.map((root) => resolve(root));

    const repositoriesDirectory = resolve(homedir(), "Repos");
    return [existsSync(repositoriesDirectory) ? repositoriesDirectory : process.cwd()];
};

const write = (io, document, text, json) => {
    io.stdout.write(`${json ? JSON.stringify(document, null, 2) : text}\n`);
};

const scan = async (args, io) => {
    const roots = args.values.length > 0 ? args.values.map((root) => resolve(root)) : defaultRoots();
    const discovery = await discoverRepositories(roots, { maxDepth: args.maxDepth });
    const repositories = await inspectMany(discovery.repositories);
    const document = envelope("scan", {
        roots,
        summary: summarize(repositories),
        repositories,
        discoveryErrors: discovery.errors,
    });
    write(io, document, formatScan(document), args.json);
    return 0;
};

const refresh = async (args, io) => {
    const roots = args.values.length > 0 ? args.values.map((root) => resolve(root)) : defaultRoots();
    const discovery = await discoverRepositories(roots, { maxDepth: args.maxDepth });
    const refreshResults = await refreshMany(discovery.repositories);
    const repositories = refreshResults.map((result) => result.repository);
    const document = envelope("refresh", {
        roots,
        summary: summarize(repositories),
        repositories,
        refreshResults,
        discoveryErrors: discovery.errors,
    });
    write(io, document, formatScan(document), args.json);
    return refreshResults.some((result) => !result.ok) ? 1 : 0;
};

const status = async (args, io) => {
    if (args.values.length !== 1) throw new Error("status requires exactly one repository path.");
    const repository = await inspectRepository(resolve(args.values[0]));
    const document = envelope("status", { repositories: [repository], summary: summarize([repository]) });
    write(io, document, formatScan(document), args.json);
    return 0;
};

const pull = async (args, io) => {
    if (args.values.length !== 1) throw new Error("pull requires exactly one repository path.");
    const result = await pullRepository(resolve(args.values[0]));
    const document = envelope("pull", { result });
    write(io, document, formatPull(document), args.json);
    return result.ok ? 0 : result.blocked ? 2 : 1;
};

export const runCli = async (arguments_, io = process) => {
    const rawArguments = [...arguments_];
    if (rawArguments[0] === "--") rawArguments.shift();
    const [command = "help", ...argv] = rawArguments;

    if (command === "help" || command === "--help" || command === "-h") {
        io.stdout.write(`${HELP}\n`);
        return 0;
    }

    const args = parsedArguments(argv);
    if (command === "scan") return scan(args, io);
    if (command === "refresh") return refresh(args, io);
    if (command === "status") return status(args, io);
    if (command === "pull") return pull(args, io);
    throw new Error(`Unknown command: ${command}`);
};

export const executeCli = async (arguments_, io = process) => {
    try {
        return await runCli(arguments_, io);
    } catch (error) {
        const json = arguments_.includes("--json");
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            io.stdout.write(`${JSON.stringify(envelope("error", { error: { message } }), null, 2)}\n`);
        } else {
            io.stderr.write(`autopull: ${message}\n`);
        }
        return 1;
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await executeCli(process.argv.slice(2));
}
