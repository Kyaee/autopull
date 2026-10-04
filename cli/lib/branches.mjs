import { stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDirectory, isDirectoryExcluded, loadExclusions } from "./exclusions.mjs";
import { inspectRepository, runGit } from "./git.mjs";

// Use full refs as picker values; never interpret user text as Git options or revisions.
export const listRepositoryBranches = async (repositoryPath) => {
    const repository = await inspectRepository(repositoryPath);
    const { stdout } = await runGit(repositoryPath, ["for-each-ref", "--sort=refname",
        "--format=%(refname)%00%(symref)", "refs/heads/", "refs/remotes/"]);
    const remotes = (await runGit(repositoryPath, ["remote"])).stdout.trim().split("\n")
        .filter(Boolean).sort((left, right) => right.length - left.length);
    const refs = stdout.split("\n").filter(Boolean).map((line) => line.split("\0"))
        .filter(([, symbolic]) => !symbolic).map(([ref]) => ref);
    const localNames = new Set(refs.filter((ref) => ref.startsWith("refs/heads/"))
        .map((ref) => ref.slice("refs/heads/".length)));
    const branches = [];
    for (const ref of refs) {
        if (ref.startsWith("refs/heads/")) {
            const name = ref.slice("refs/heads/".length);
            branches.push({ ref, name, localName: name, remote: null, current: repository.branch === name });
        } else {
            const remote = remotes.find((name) => ref.startsWith(`refs/remotes/${name}/`));
            if (!remote) continue;
            const localName = ref.slice(`refs/remotes/${remote}/`.length);
            // Existing local branches keep their commits and upstream configuration.
            if (localNames.has(localName)) continue;
            branches.push({ ref, name: `${remote}/${localName}`, localName, remote, current: false });
        }
    }
    return { repository, branches };
};

export const switchRepositoryBranch = async (repositoryPath, branchRef, options = {}) => {
    const path = await canonicalDirectory(repositoryPath);
    const before = await inspectRepository(path);
    const blocked = (message) => ({ ok: false, blocked: true, message, repository: before });
    const directories = await loadExclusions(options.exclusionsPath);
    if (isDirectoryExcluded(path, directories)) return blocked("This directory is hidden from Autopull. Restore it first.");

    try {
        const root = (await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim();
        if (await canonicalDirectory(root) !== path) return blocked("Select the repository root before changing branches.");
        if (before.conflicts > 0) return blocked("Resolve conflicts before changing branches.");
        const gitDirectory = (await runGit(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
            try {
                await stat(join(gitDirectory, marker));
                return blocked("Finish or abort the current Git operation before changing branches.");
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        if (before.dirty) return blocked("Stash or commit local changes before changing branches.");
        const { branches } = await listRepositoryBranches(path);
        const branch = branches.find((candidate) => candidate.ref === branchRef);
        if (!branch) return blocked("That branch is no longer available. Reopen the branch picker.");
        if (branch.current) return { ok: true, blocked: false, message: `Already on ${branch.name}.`, repository: before };
        const args = ["switch", "--no-overwrite-ignore", "--no-recurse-submodules", "--no-guess"];
        if (branch.remote) args.push("--track=direct", "--create", branch.localName, branch.ref);
        else args.push("--", branch.localName);
        await runGit(path, args);
        const after = await inspectRepository(path);
        return { ok: true, blocked: false, message: `${after.name} is now on ${after.branch}.`, repository: after };
    } catch (error) {
        return { ok: false, blocked: false, message: error.message,
            repository: await inspectRepository(path).catch(() => before) };
    }
};
