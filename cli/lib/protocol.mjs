import { inspectRepository } from "./git.mjs";

export const PROTOCOL_VERSION = 1;

const errorRepository = (path, error) => ({
    path,
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    state: "error",
    branch: null,
    upstream: null,
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
    canPull: false,
    needsPull: false,
    blockers: [error.message],
});

export const inspectMany = async (paths, options = {}) => {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
    const results = new Array(paths.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < paths.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await inspectRepository(paths[index]).catch((error) => errorRepository(paths[index], error));
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return results;
};

export const summarize = (repositories) => repositories.reduce((summary, repository) => {
    summary.total += 1;
    if (repository.state === "current") summary.current += 1;
    if (repository.state === "behind") summary.updatesReady += 1;
    if (repository.dirty) summary.dirty += 1;
    if (repository.conflicts > 0) summary.conflicts += 1;
    if (repository.state === "error") summary.errors += 1;
    return summary;
}, { total: 0, current: 0, updatesReady: 0, dirty: 0, conflicts: 0, errors: 0 });

export const envelope = (command, payload) => ({
    protocolVersion: PROTOCOL_VERSION,
    command,
    generatedAt: new Date().toISOString(),
    ...payload,
});

