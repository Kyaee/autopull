import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const defaultExclusionsPath = () => process.env.AUTOPULL_EXCLUSIONS_FILE
    ? resolve(process.env.AUTOPULL_EXCLUSIONS_FILE)
    : join(homedir(), ".config", "autopull", "exclusions.json");

export const canonicalDirectory = async (value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Directory path cannot be empty.");
    if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Directory path cannot contain control characters.");
    const trimmed = value.trim();
    const path = resolve(trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed);
    try {
        return await realpath(path);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return path;
        throw error;
    }
};

export const normalizeExclusions = async (directories) => {
    if (!Array.isArray(directories)) throw new Error("Excluded directories must be an array of paths.");
    const paths = await Promise.all(directories.map(canonicalDirectory));
    return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
};

export const isDirectoryExcluded = (path, directories) => directories.some((directory) => {
    const child = relative(directory, resolve(path));
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
});

export const loadExclusions = async (path = defaultExclusionsPath()) => {
    try {
        const document = JSON.parse(await readFile(path, "utf8"));
        if (document?.version !== 1) throw new Error("Unsupported exclusions file version.");
        return await normalizeExclusions(document.directories);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw new Error(`Cannot read excluded directories: ${error.message}`);
    }
};

export const saveExclusions = async (directories, path = defaultExclusionsPath()) => {
    const normalized = await normalizeExclusions(directories);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, directories: normalized }, null, 2)}\n`, {
            encoding: "utf8", mode: 0o600, flag: "wx",
        });
        await rename(temporaryPath, path);
    } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }
    return normalized;
};
