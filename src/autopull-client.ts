import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type RepositoryState =
    | "current"
    | "behind"
    | "ahead"
    | "diverged"
    | "dirty"
    | "conflict"
    | "detached"
    | "no-upstream"
    | "error";

export type ChangedFile = {
    path: string;
    kind: "changed" | "untracked" | "conflict";
};

export type Repository = {
    path: string;
    name: string;
    state: RepositoryState;
    branch: string | null;
    upstream: string | null;
    detached: boolean;
    ahead: number;
    behind: number;
    staged: number;
    modified: number;
    untracked: number;
    conflicts: number;
    changedFiles: ChangedFile[];
    dirty: boolean;
    diverged: boolean;
    canPull: boolean;
    needsPull: boolean;
    blockers: string[];
};

export type Summary = {
    total: number;
    current: number;
    updatesReady: number;
    dirty: number;
    conflicts: number;
    errors: number;
};

export type ScanDocument = {
    protocolVersion: 1;
    command: "scan" | "status" | "refresh";
    generatedAt: string;
    roots?: string[];
    summary: Summary;
    repositories: Repository[];
    discoveryErrors?: Array<{ path: string; message: string }>;
    refreshResults?: Array<{ ok: boolean; message: string; repository: Repository }>;
};

export type PullDocument = {
    protocolVersion: 1;
    command: "pull";
    generatedAt: string;
    result: {
        ok: boolean;
        blocked: boolean;
        message: string;
        repository: Repository;
    };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";

const assertProtocol = (value: unknown): Record<string, unknown> => {
    if (!isObject(value) || value.protocolVersion !== 1 || typeof value.command !== "string") {
        throw new Error("The Autopull CLI returned an unsupported response.");
    }
    return value;
};

const cliPath = () => {
    const candidates = [
        process.env.AUTOPULL_CLI_PATH,
        resolve(process.cwd(), "cli", "autopull.mjs"),
        resolve(process.cwd(), "..", "cli", "autopull.mjs"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    const candidate = candidates.find(existsSync);

    if (!candidate) {
        throw new Error("Autopull CLI not found. Set AUTOPULL_CLI_PATH to cli/autopull.mjs.");
    }

    return candidate;
};

const parseResponse = (stdout: string) => {
    if (!stdout.trim()) throw new Error("The Autopull CLI returned no data.");

    try {
        return assertProtocol(JSON.parse(stdout));
    } catch (error) {
        if (error instanceof SyntaxError) throw new Error("The Autopull CLI returned invalid JSON.");
        throw error;
    }
};

export const executeCliProcess = (arguments_: string[]): Promise<string> => new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...arguments_, "--json"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 130_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
        clearTimeout(timeout);
        Object.assign(error, { stdout });
        reject(error);
    });
    child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) {
            resolveOutput(stdout);
            return;
        }
        const error = new Error(stderr.trim() || `Autopull CLI exited with ${signal ?? code}.`);
        Object.assign(error, { stdout });
        reject(error);
    });
});

const runProtocol = async (arguments_: string[]) => {
    try {
        const stdout = await executeCliProcess(arguments_);
        return parseResponse(stdout);
    } catch (error) {
        const stdout = isObject(error) && typeof error.stdout === "string" ? error.stdout : "";
        if (stdout.trim()) return parseResponse(stdout);
        throw new Error(error instanceof Error ? error.message : String(error));
    }
};

export const defaultRepositoryRoots = () => {
    const configured = process.env.AUTOPULL_ROOTS?.split(":").filter(Boolean);
    if (configured?.length) return configured.map((root) => resolve(root));

    const repositoriesDirectory = resolve(homedir(), "Repos");
    return [existsSync(repositoriesDirectory) ? repositoriesDirectory : process.cwd()];
};

export const scanRepositories = async (roots: string[]): Promise<ScanDocument> => {
    const document = await runProtocol(["scan", ...roots]);
    if (document.command !== "scan" || !Array.isArray(document.repositories) || !isObject(document.summary)) {
        throw new Error("The Autopull CLI returned an invalid scan response.");
    }
    return document as ScanDocument;
};

export const refreshRepositories = async (roots: string[]): Promise<ScanDocument> => {
    const document = await runProtocol(["refresh", ...roots]);
    if (document.command !== "refresh" || !Array.isArray(document.repositories) || !isObject(document.summary)) {
        throw new Error("The Autopull CLI returned an invalid refresh response.");
    }
    return document as ScanDocument;
};

export const pullRepository = async (repositoryPath: string): Promise<PullDocument> => {
    const document = await runProtocol(["pull", repositoryPath]);
    if (document.command !== "pull" || !isObject(document.result)) {
        throw new Error("The Autopull CLI returned an invalid pull response.");
    }
    return document as PullDocument;
};
