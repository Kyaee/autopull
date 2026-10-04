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
    const concurrency = options.concurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
        throw new RangeError("Discovery concurrency must be an integer from 1 to 32.");
    }
    const ignoredNames = new Set([...DEFAULT_IGNORES, ...(options.ignoredNames ?? [])]);
    let frontier = [];
    const seen = new Set();
    const repositories = [];
    const errors = [];

    for (const candidate of roots) {
        const path = resolve(candidate);
        if (!(await readableDirectory(path))) {
            errors.push({ path, message: "Root is not a readable directory." });
            continue;
        }
        frontier.push({ path, depth: 0 });
    }

    const visit = async (current) => {
        let canonicalPath;

        try {
            canonicalPath = await realpath(current.path);
        } catch (error) {
            return { error: { path: current.path, message: error.message } };
        }

        if (seen.has(canonicalPath)) return {};
        seen.add(canonicalPath);

        if (await isGitRepository(canonicalPath)) {
            return { repository: canonicalPath };
        }

        if (current.depth >= maxDepth) return {};

        let entries;
        try {
            entries = await readdir(canonicalPath, { withFileTypes: true });
        } catch (error) {
            return { error: { path: canonicalPath, message: error.message } };
        }

        const children = [];
        for (const entry of entries) {
            if (
                !entry.isDirectory()
                || entry.isSymbolicLink()
                || entry.name.startsWith(".")
                || ignoredNames.has(entry.name)
            ) continue;
            children.push({ path: resolve(canonicalPath, entry.name), depth: current.depth + 1 });
        }
        return { children };
    };

    // Finish each depth before starting the next so overlapping roots are
    // always visited at their shallowest depth. Keep filesystem work bounded.
    while (frontier.length > 0) {
        const results = new Array(frontier.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < frontier.length) {
                const index = cursor++;
                results[index] = await visit(frontier[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, frontier.length) }, worker));
        frontier = [];
        for (const result of results) {
            if (result.repository) repositories.push(result.repository);
            if (result.error) errors.push(result.error);
            if (result.children) {
                for (const child of result.children) frontier.push(child);
            }
        }
    }

    return {
        repositories: repositories.sort((left, right) => left.localeCompare(right)),
        errors,
    };
};
