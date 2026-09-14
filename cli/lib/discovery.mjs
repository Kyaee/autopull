import { access, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_IGNORES = new Set([
    ".cache",
    ".git",
    ".local",
    ".npm",
    ".pnpm-store",
    ".var",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
]);

const isGitRepository = async (directory) => {
    try {
        const marker = await stat(resolve(directory, ".git"));
        return marker.isDirectory() || marker.isFile();
    } catch {
        return false;
    }
};

const readableDirectory = async (directory) => {
    try {
        await access(directory, constants.R_OK);
        return (await stat(directory)).isDirectory();
    } catch {
        return false;
    }
};

export const discoverRepositories = async (roots, options = {}) => {
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 4;
    const ignoredNames = new Set([...DEFAULT_IGNORES, ...(options.ignoredNames ?? [])]);
    const queue = [];
    const seen = new Set();
    const repositories = [];
    const errors = [];

    for (const candidate of roots) {
        const path = resolve(candidate);
        if (!(await readableDirectory(path))) {
            errors.push({ path, message: "Root is not a readable directory." });
            continue;
        }
        queue.push({ path, depth: 0 });
    }

    while (queue.length > 0) {
        const current = queue.shift();
        let canonicalPath;

        try {
            canonicalPath = await realpath(current.path);
        } catch (error) {
            errors.push({ path: current.path, message: error.message });
            continue;
        }

        if (seen.has(canonicalPath)) continue;
        seen.add(canonicalPath);

        if (await isGitRepository(canonicalPath)) {
            repositories.push(canonicalPath);
            continue;
        }

        if (current.depth >= maxDepth) continue;

        let entries;
        try {
            entries = await readdir(canonicalPath, { withFileTypes: true });
        } catch (error) {
            errors.push({ path: canonicalPath, message: error.message });
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredNames.has(entry.name)) continue;
            queue.push({ path: resolve(canonicalPath, entry.name), depth: current.depth + 1 });
        }
    }

    return {
        repositories: repositories.sort((left, right) => left.localeCompare(right)),
        errors,
    };
};

