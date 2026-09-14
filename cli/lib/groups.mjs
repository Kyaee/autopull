import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const GROUPS_VERSION = 1;

export const defaultGroupsPath = () => process.env.AUTOPULL_GROUPS_FILE
    ? resolve(process.env.AUTOPULL_GROUPS_FILE)
    : join(homedir(), ".config", "autopull", "groups.json");

const cleanName = (name) => String(name).trim();

const assertName = (groups, name, currentName = null) => {
    const cleaned = cleanName(name);
    if (!cleaned) throw new Error("Group name cannot be empty.");
    if (cleaned.length > 60) throw new Error("Group name cannot exceed 60 characters.");
    if (/[\u0000-\u001f\u007f]/u.test(cleaned)) throw new Error("Group name cannot contain control characters.");
    const duplicate = groups.some((group) => group.name.toLowerCase() === cleaned.toLowerCase()
        && group.name !== currentName);
    if (duplicate) throw new Error(`A group named ${cleaned} already exists.`);
    return cleaned;
};

const normalizedGroups = (groups) => {
    if (!Array.isArray(groups)) return [];
    const seen = new Set();
    const normalized = [];
    for (const candidate of groups) {
        if (!candidate || typeof candidate.name !== "string" || !Array.isArray(candidate.repositories)) continue;
        const name = cleanName(candidate.name);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        normalized.push({
            name,
            repositories: [...new Set(candidate.repositories
                .filter((path) => typeof path === "string" && path.length > 0)
                .map((path) => resolve(path)))].sort(),
        });
    }
    return normalized;
};

export const loadGroups = async (path = defaultGroupsPath()) => {
    try {
        const document = JSON.parse(await readFile(path, "utf8"));
        if (document.version !== GROUPS_VERSION) {
            throw new Error(`Unsupported repository group file version: ${document.version}.`);
        }
        return normalizedGroups(document.groups);
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        if (error instanceof SyntaxError) throw new Error(`Cannot read repository groups: ${error.message}`);
        throw error;
    }
};

export const saveGroups = async (groups, path = defaultGroupsPath()) => {
    const normalized = normalizedGroups(groups);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: GROUPS_VERSION, groups: normalized }, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(temporaryPath, path);
    } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }
    return normalized;
};

export const createGroup = (groups, name) => [
    ...groups,
    { name: assertName(groups, name), repositories: [] },
];

export const renameGroup = (groups, currentName, nextName) => {
    if (!groups.some((group) => group.name === currentName)) {
        throw new Error(`Group ${currentName} does not exist.`);
    }
    const cleaned = assertName(groups, nextName, currentName);
    return groups.map((group) => group.name === currentName ? { ...group, name: cleaned } : group);
};

export const deleteGroup = (groups, name) => groups.filter((group) => group.name !== name);

export const toggleGroupRepository = (groups, name, repositoryPath) => {
    const resolvedPath = resolve(repositoryPath);
    let found = false;
    const updated = groups.map((group) => {
        if (group.name !== name) return group;
        found = true;
        const repositories = group.repositories.includes(resolvedPath)
            ? group.repositories.filter((path) => path !== resolvedPath)
            : [...group.repositories, resolvedPath].sort();
        return { ...group, repositories };
    });
    if (!found) throw new Error(`Group ${name} does not exist.`);
    return updated;
};

export const repositoriesInGroup = (repositories, groups, name) => {
    if (!name) return repositories;
    const group = groups.find((candidate) => candidate.name === name);
    if (!group) return [];
    const paths = new Set(group.repositories);
    return repositories.filter((repository) => paths.has(repository.path));
};
