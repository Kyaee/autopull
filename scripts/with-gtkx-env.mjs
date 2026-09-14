#!/usr/bin/env node

import { spawn } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);

if (!command) {
    process.stderr.write("Usage: with-gtkx-env <project binary> [arguments...]\n");
    process.exitCode = 1;
} else {
    const executable = resolve(root, "node_modules", ".bin", command);
    const pkgConfigPath = [
        resolve(root, "tools", "pkgconfig"),
        process.env.PKG_CONFIG_PATH,
    ].filter(Boolean).join(delimiter);

    const child = spawn(executable, args, {
        cwd: root,
        env: { ...process.env, PKG_CONFIG_PATH: pkgConfigPath },
        stdio: "inherit",
    });

    child.on("error", (error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exitCode = code ?? 1;
    });
}

