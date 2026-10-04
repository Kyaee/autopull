import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalDirectory, isDirectoryExcluded, loadExclusions } from "./exclusions.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 120_000;

export class GitCommandError extends Error {
    constructor(args, cause) {
        const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim() : "";
        super(stderr || cause?.message || `git ${args.join(" ")} failed`);
        this.name = "GitCommandError";
        this.args = args;
        this.exitCode = typeof cause?.code === "number" ? cause.code : null;
        this.stderr = stderr;
    }
}

export const runGit = async (repositoryPath, args, options = {}) => {
    const commandArgs = ["-C", resolve(repositoryPath), ...args];

    try {
        const { stdout, stderr } = await execFileAsync("git", commandArgs, {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            windowsHide: true,
        });

        return { stdout, stderr };
    } catch (error) {
        throw new GitCommandError(commandArgs, error);
    }
};

const changedPath = (record) => {
    if (record.startsWith("1 ")) return record.split(" ").slice(8).join(" ");
    if (record.startsWith("2 ")) return record.split(" ").slice(9).join(" ");
    if (record.startsWith("u ")) return record.split(" ").slice(10).join(" ");
    if (record.startsWith("? ")) return record.slice(2);
    return "";
};

export const parsePorcelainV2 = (output, repositoryPath) => {
    const records = output.split("\0").filter(Boolean);
    const result = {
        path: resolve(repositoryPath),
        name: basename(resolve(repositoryPath)),
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
    };

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];

        if (record.startsWith("# branch.head ")) {
            const branch = record.slice("# branch.head ".length);
            result.detached = branch === "(detached)";
            result.branch = result.detached ? null : branch;
            continue;
        }

        if (record.startsWith("# branch.upstream ")) {
            result.upstream = record.slice("# branch.upstream ".length);
            continue;
        }

        if (record.startsWith("# branch.ab ")) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
            if (match) {
                result.ahead = Number(match[1]);
                result.behind = Number(match[2]);
            }
            continue;
        }

        if (record.startsWith("? ")) {
            result.untracked += 1;
            result.changedFiles.push({ path: changedPath(record), kind: "untracked" });
            continue;
        }

        if (record.startsWith("1 ") || record.startsWith("2 ")) {
            const xy = record.slice(2, 4);
            if (xy[0] !== ".") result.staged += 1;
            if (xy[1] !== ".") result.modified += 1;
            result.changedFiles.push({ path: changedPath(record), kind: "changed" });

            // Porcelain v2 emits a second NUL record for a rename's original path.
            if (record.startsWith("2 ")) index += 1;
            continue;
        }

        if (record.startsWith("u ")) {
            result.conflicts += 1;
            result.changedFiles.push({ path: changedPath(record), kind: "conflict" });
        }
    }

    return result;
};

const classifyRepository = (raw) => {
    const dirty = raw.staged + raw.modified + raw.untracked > 0;
    const diverged = raw.ahead > 0 && raw.behind > 0;
    const blockers = [];

    if (raw.conflicts > 0) blockers.push(`${raw.conflicts} unresolved conflict${raw.conflicts === 1 ? "" : "s"}`);
    if (dirty) blockers.push("local changes are present");
    if (raw.detached) blockers.push("HEAD is detached");
    if (!raw.upstream) blockers.push("the current branch has no upstream");
    if (diverged) blockers.push("local and upstream histories have diverged");

    let state = "current";
    if (raw.conflicts > 0) state = "conflict";
    else if (dirty) state = "dirty";
    else if (raw.detached) state = "detached";
    else if (!raw.upstream) state = "no-upstream";
    else if (diverged) state = "diverged";
    else if (raw.behind > 0) state = "behind";
    else if (raw.ahead > 0) state = "ahead";

    return {
        ...raw,
        state,
        dirty,
        diverged,
        canPull: blockers.length === 0,
        needsPull: raw.behind > 0,
        blockers,
    };
};

export const inspectRepository = async (repositoryPath) => {
    const { stdout } = await runGit(repositoryPath, [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=normal",
        "-z",
    ]);

    return classifyRepository(parsePorcelainV2(stdout, repositoryPath));
};

export const pullRepository = async (repositoryPath, options = {}) => {
    const excludedDirectories = await loadExclusions(options.exclusionsPath);
    const before = await inspectRepository(repositoryPath);

    if (isDirectoryExcluded(await canonicalDirectory(repositoryPath), excludedDirectories)) {
        return {
            ok: false, blocked: true,
            message: "Update blocked: this directory is hidden from Autopull. Restore it from the hidden directories list first.",
            repository: before,
        };
    }

    if (!before.canPull) {
        return {
            ok: false,
            blocked: true,
            message: `Update blocked: ${before.blockers.join("; ")}.`,
            repository: before,
        };
    }

    try {
        const { stdout, stderr } = await runGit(repositoryPath, ["pull", "--ff-only"], {
            timeoutMs: NETWORK_TIMEOUT_MS,
        });
        const after = await inspectRepository(repositoryPath);

        return {
            ok: true,
            blocked: false,
            message: (stdout || stderr).trim() || "Repository is up to date.",
            repository: after,
        };
    } catch (error) {
        const after = await inspectRepository(repositoryPath).catch(() => before);
        return {
            ok: false,
            blocked: false,
            message: error.message,
            repository: after,
        };
    }
};

export const fetchRepository = async (repositoryPath) => {
    const before = await inspectRepository(repositoryPath);

    if (!before.upstream) {
        return {
            ok: false,
            message: "Fetch skipped: the current branch has no upstream.",
            repository: before,
        };
    }

    try {
        const { stdout, stderr } = await runGit(repositoryPath, ["fetch", "--prune"], {
            timeoutMs: NETWORK_TIMEOUT_MS,
        });
        return {
            ok: true,
            message: (stdout || stderr).trim() || "Remote state fetched.",
            repository: await inspectRepository(repositoryPath),
        };
    } catch (error) {
        return {
            ok: false,
            message: error.message,
            repository: await inspectRepository(repositoryPath).catch(() => before),
        };
    }
};
