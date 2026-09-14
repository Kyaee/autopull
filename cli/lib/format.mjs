const shortState = (repository) => {
    if (repository.state === "dirty") return `${repository.staged + repository.modified + repository.untracked} changes`;
    if (repository.state === "conflict") return `${repository.conflicts} conflict${repository.conflicts === 1 ? "" : "s"}`;
    return repository.state;
};

const remoteState = (repository) => {
    if (!repository.upstream) return "no upstream";
    if (repository.ahead > 0 && repository.behind > 0) return `ahead ${repository.ahead}, behind ${repository.behind}`;
    if (repository.behind > 0) return `behind ${repository.behind}`;
    if (repository.ahead > 0) return `ahead ${repository.ahead}`;
    return "current";
};

const pad = (value, width) => String(value).slice(0, width).padEnd(width);

export const formatScan = (document) => {
    if (document.repositories.length === 0) {
        return "No Git repositories found.";
    }

    const lines = [
        `${pad("REPOSITORY", 30)} ${pad("BRANCH", 24)} ${pad("WORKTREE", 16)} REMOTE`,
        `${"-".repeat(30)} ${"-".repeat(24)} ${"-".repeat(16)} ${"-".repeat(24)}`,
    ];

    for (const repository of document.repositories) {
        lines.push([
            pad(repository.name, 30),
            pad(repository.branch ?? "detached", 24),
            pad(shortState(repository), 16),
            remoteState(repository),
        ].join(" "));
    }

    const { summary } = document;
    lines.push("", `${summary.total} repositories · ${summary.updatesReady} updates · ${summary.dirty} dirty · ${summary.conflicts} conflicted · ${summary.errors} errors`);

    if (document.discoveryErrors?.length) {
        lines.push("", ...document.discoveryErrors.map((error) => `Warning: ${error.path}: ${error.message}`));
    }

    return lines.join("\n");
};

export const formatPull = (document) => {
    const label = document.result.ok ? "UPDATED" : document.result.blocked ? "BLOCKED" : "FAILED";
    return `${label} ${document.result.repository.name}: ${document.result.message}`;
};

