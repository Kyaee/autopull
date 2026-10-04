import { stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDirectory, isDirectoryExcluded, loadExclusions } from "./exclusions.mjs";
import { inspectRepository, runGit } from "./git.mjs";

// Clear local edits through Git's stash so the user can recover them later.
export const stashRepositoryChanges = async (repositoryPath, options = {}) => {
    const path = await canonicalDirectory(repositoryPath);
    const before = await inspectRepository(path);
    const blocked = (message) => ({ ok: false, blocked: true, message, repository: before });
    if (options.confirmed !== true) return blocked("Confirmation is required before stashing local changes.");
    const directories = await loadExclusions(options.exclusionsPath);
    if (isDirectoryExcluded(path, directories)) return blocked("This directory is hidden from Autopull. Restore it first.");

    let backup = null;
    try {
        const root = (await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim();
        if (await canonicalDirectory(root) !== path) return blocked("Select the repository root before stashing changes.");
        if (before.conflicts > 0) return blocked("Resolve conflicts before stashing changes; no files were changed.");
        const gitDirectory = (await runGit(path, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
            try {
                await stat(join(gitDirectory, marker));
                return blocked("Finish or abort the current Git operation before stashing changes.");
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        const status = (await runGit(path, ["status", "--porcelain=v2", "-z"])).stdout;
        if (status.split("\0").some((record) => /^(?:1|2|u) \S+ S(?!\.\.\.)/u.test(record))) {
            return blocked("Handle submodule changes separately before stashing changes.");
        }
        if (!before.dirty) return blocked("There are no uncommitted changes to stash.");
        await runGit(path, ["rev-parse", "--verify", "HEAD"]);
        await runGit(path, ["stash", "push", "--include-untracked", "--message", `Autopull: stash local changes ${new Date().toISOString()}`], { timeoutMs: 120_000 });
        backup = (await runGit(path, ["rev-parse", "--verify", "refs/stash"])).stdout.trim();
        const after = await inspectRepository(path);
        const recovery = `git stash apply --index ${backup.slice(0, 12)}`;
        return {
            ok: !after.dirty && after.conflicts === 0, blocked: false, backup,
            message: after.dirty || after.conflicts > 0
                ? `Some changes remain. Backup recovery: ${recovery}`
                : `Recover: ${recovery}`,
            repository: after,
        };
    } catch (error) {
        return {
            ok: false, blocked: false, backup,
            message: `${error.message}${backup ? ` Recover: git stash apply --index ${backup.slice(0, 12)}` : ""}`,
            repository: await inspectRepository(path).catch(() => before),
        };
    }
};
