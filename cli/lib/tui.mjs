import { emitKeypressEvents } from "node:readline";
import { discoverRepositories } from "./discovery.mjs";
import { pullRepository } from "./git.mjs";
import {
    createGroup,
    deleteGroup,
    loadGroups,
    renameGroup,
    repositoriesInGroup,
    saveGroups,
    toggleGroupRepository,
} from "./groups.mjs";
import { inspectMany, pullMany, refreshMany, summarize } from "./protocol.mjs";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ANSI_RESET = "\u001b[0m";

const paintLine = (line, color) => {
    if (line.startsWith("›")) return `\u001b[1;7m${line}${ANSI_RESET}`;
    if (!color) return line;
    if (line.startsWith("AUTOPULL")) return `\u001b[1;36m${line}${ANSI_RESET}`;
    if (/^\s*(?:REPOSITORY|BRANCH)\s+/.test(line) && line.includes("STATE")) {
        return `\u001b[2m${line}${ANSI_RESET}`;
    }
    return line
        .replace(/\b(CONFLICT(?: \d+)?|ERROR|BLOCKED|DIVERGED)\b/g, "\u001b[1;31m$1\u001b[0m")
        .replace(/\b(DIRTY(?: \d+)?|NO-UPSTREAM|DETACHED)\b/g, "\u001b[33m$1\u001b[0m")
        .replace(/\b(BEHIND(?: \d+)?|READY)\b/g, "\u001b[36m$1\u001b[0m")
        .replace(/\b(AHEAD(?: \d+)?)\b/g, "\u001b[34m$1\u001b[0m")
        .replace(/\bCURRENT\b/g, "\u001b[32m$&\u001b[0m")
        .replace(/(█+|░+)/gu, "\u001b[36m$1\u001b[0m")
        .replace(/(↑↓\/jk|Enter\/Esc|Enter|Esc|Space|[srpgaqned])(?= (?:move|scan|refresh|pull|groups|quit|new|members|rename|delete|use|back|done|toggle|confirm|cancel))/gu,
            "\u001b[1;36m$1\u001b[0m");
};

const stateLabel = (repository) => {
    if (repository.state === "behind") return `BEHIND ${repository.behind}`;
    if (repository.state === "ahead") return `AHEAD ${repository.ahead}`;
    if (repository.state === "dirty") {
        return `DIRTY ${repository.staged + repository.modified + repository.untracked}`;
    }
    if (repository.state === "conflict") return `CONFLICT ${repository.conflicts}`;
    return repository.state.toUpperCase();
};

const worktreeLabel = (repository) => {
    const changes = repository.staged + repository.modified + repository.untracked;
    if (repository.conflicts > 0) return `${repository.conflicts} unresolved`;
    if (changes > 0) return `${changes} local change${changes === 1 ? "" : "s"}`;
    return "clean";
};

const remoteLabel = (repository) => {
    if (!repository.upstream) return "no upstream";
    if (repository.ahead > 0 && repository.behind > 0) {
        return `ahead ${repository.ahead}, behind ${repository.behind}`;
    }
    if (repository.behind > 0) return `behind ${repository.behind}`;
    if (repository.ahead > 0) return `ahead ${repository.ahead}`;
    return "current";
};

const displayText = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");

const fit = (value, width) => {
    const text = displayText(value);
    if (width <= 0) return "";
    if (text.length <= width) return text.padEnd(width);
    if (width === 1) return "…";
    return `${text.slice(0, width - 1)}…`;
};

const viewport = (items, selectedIndex, capacity) => {
    if (items.length <= capacity) return { items, offset: 0 };
    const half = Math.floor(capacity / 2);
    const offset = Math.max(0, Math.min(selectedIndex - half, items.length - capacity));
    return { items: items.slice(offset, offset + capacity), offset };
};

const branchLabel = (repository) => repository.detached ? "detached" : repository.branch ?? "unknown";

const repositoryColumnWidths = (width) => {
    const branch = Math.min(20, Math.max(12, Math.floor(width * 0.2)));
    const state = 14;
    const remote = Math.min(24, Math.max(14, Math.floor(width * 0.22)));
    return { branch, state, remote, name: Math.max(12, width - branch - state - remote - 8) };
};

const compactRepositoryColumnWidths = (width) => {
    const branch = Math.min(16, Math.max(6, Math.floor(width * 0.28)));
    const state = Math.min(12, Math.max(5, Math.floor(width * 0.23)));
    return { branch, state, name: Math.max(4, width - branch - state - 7) };
};

const repositoryHeader = (width) => {
    if (width < 76) {
        const columns = compactRepositoryColumnWidths(width);
        return [
            " ",
            fit("BRANCH", columns.branch),
            fit("REPOSITORY", columns.name),
            fit("STATE", columns.state),
        ].join(" ");
    }
    const columns = repositoryColumnWidths(width);
    return [
        " ",
        fit("REPOSITORY", columns.name),
        fit("BRANCH", columns.branch),
        fit("STATE", columns.state),
        fit("REMOTE", columns.remote),
    ].join(" ");
};

const repositoryRow = (repository, selected, width) => {
    const marker = selected ? "›" : " ";
    const state = stateLabel(repository);
    const branch = branchLabel(repository);

    if (width < 76) {
        const columns = compactRepositoryColumnWidths(width);
        return [marker, fit(`@${branch}`, columns.branch), fit(repository.name, columns.name), fit(state, columns.state)].join(" ");
    }

    const columns = repositoryColumnWidths(width);
    return [
        marker,
        fit(repository.name, columns.name),
        fit(branch, columns.branch),
        fit(state, columns.state),
        fit(remoteLabel(repository), columns.remote),
    ].join(" ");
};

const actionLabel = (repository) => {
    if (!repository.canPull) return `Blocked: ${repository.blockers.join("; ")}`;
    if (repository.needsPull) return "Ready to fast-forward. Press p to pull";
    return "No update is waiting";
};

const DETAIL_ROWS = 11;

const wrapText = (value, width) => {
    if (width <= 1) return [String(value).slice(0, Math.max(0, width))];
    const source = displayText(value);
    const words = [...source.matchAll(/\S+/gu)];
    if (words.length === 0) return [""];
    const lines = [];
    let line = "";
    let previousEnd = 0;
    for (const match of words) {
        const word = match[0];
        const separator = source.slice(previousEnd, match.index);
        const addition = line ? `${separator}${word}` : word;
        if (!line) {
            line = word;
        } else if (line.length + addition.length <= width) {
            line += addition;
        } else {
            lines.push(line);
            line = word;
        }
        previousEnd = match.index + word.length;
    }
    if (line) lines.push(line);
    return lines.flatMap((candidate) => candidate.length <= width
        ? [candidate]
        : Array.from({ length: Math.ceil(candidate.length / width) }, (_, index) => candidate.slice(index * width, (index + 1) * width)));
};

const labeledLines = (label, value, width) => {
    const labelWidth = 8;
    const contentWidth = Math.max(1, width - labelWidth);
    return wrapText(value, contentWidth).map((line, index) => fit(`${index === 0 ? fit(label, labelWidth) : " ".repeat(labelWidth)}${line}`, width));
};

const limitedLabeledLines = (label, value, width, limit) => {
    const lines = labeledLines(label, value, width);
    if (lines.length <= limit) return lines;
    const visible = lines.slice(0, limit);
    visible[limit - 1] = fit(`${visible[limit - 1].trimEnd().slice(0, Math.max(0, width - 1))}…`, width);
    return visible;
};

const repositoryDetailLines = (repository, width) => {
    const firstChange = repository.changedFiles[0]?.path;
    const lines = [
        fit(`${repository.name}  ${stateLabel(repository)}`, width),
        fit(repository.path, width),
        ...limitedLabeledLines("Branch", `${branchLabel(repository)}  →  ${repository.upstream ?? "no upstream"}`, width, 2),
        ...limitedLabeledLines("State", `${worktreeLabel(repository)}; remote ${remoteLabel(repository)}`, width, 2),
        ...limitedLabeledLines("Action", actionLabel(repository), width, 2),
    ];
    if (firstChange) {
        const remaining = repository.changedFiles.length - 1;
        lines.push(fit(`Files   ${firstChange}${remaining > 0 ? ` (+${remaining} more)` : ""}`, width));
    }
    return lines;
};

const selectedGroup = (model) => model.groupIndex === 0 ? null : model.groups[model.groupIndex - 1];

// Fit before adding ANSI escapes so borders remain aligned in every color mode.
const panel = (title, content, width, height, terminal, accent = 36) => {
    const inner = Math.max(1, width - 4);
    const styled = terminal.style || terminal.color;
    const border = (line) => terminal.color ? `\u001b[${accent}m${line}${ANSI_RESET}` : line;
    const heading = ` ${title} `;
    const top = `╭─${fit(heading, width - 4).trimEnd()}`;
    const lines = [border(`${top}${"─".repeat(Math.max(0, width - top.length - 1))}╮`)];
    for (let index = 0; index < height - 2; index += 1) {
        const line = fit(content[index] ?? "", inner);
        lines.push(`${border("│")} ${styled ? paintLine(line, terminal.color) : line} ${border("│")}`);
    }
    lines.push(border(`╰${"─".repeat(width - 2)}╯`));
    return lines;
};

const meter = (label, count, total, width) => {
    const size = Math.max(2, width - label.length - String(count).length - 4);
    const filled = total ? Math.round(count / total * size) : 0;
    return `${label} ${count}  ${"█".repeat(filled)}${"░".repeat(size - filled)}`;
};

export const renderTui = (model, terminal = {}) => {
    const width = Math.max(20, terminal.columns ?? 100);
    const rows = Math.max(8, terminal.rows ?? 30);
    const summary = model.summary ?? summarize(model.repositories);
    const scope = model.activeGroup ?? "All repositories";
    const overview = [`AUTOPULL  ${summary.total} repos  ${summary.updatesReady} ready  ${summary.dirty} dirty  ${summary.conflicts} conflicted`];
    if (width >= 76) {
        const cell = Math.floor((width - 10) / 3);
        overview.push([
            meter("CURRENT", summary.current, summary.total, cell),
            meter("READY", summary.updatesReady, summary.total, cell),
            meter("DIRTY", summary.dirty, summary.total, cell),
        ].map((item) => fit(item, cell)).join("   "));
    } else {
        overview.push(`CURRENT ${summary.current}  READY ${summary.updatesReady}  DIRTY ${summary.dirty}`);
    }
    const warning = model.discoveryErrors[0];
    const status = model.busy ? `● ${model.activity}…` : model.notification ? `STATUS  ${model.notification}`
        : warning ? `Warning  ${warning.path}: ${warning.message}` : `SCOPE   ${scope}  ${model.roots.join(":")}`;
    overview.push(status);
    if (rows < 12) {
        const selected = model.repositories[model.selectedIndex];
        const compact = [overview[0], status, repositoryHeader(width),
            selected ? repositoryRow(selected, true, width) : "No repositories found."];
        while (compact.length < rows - 1) compact.push("");
        compact.push("↑↓/jk move  q quit");
        return compact.map((line) => {
            const fitted = fit(line, width);
            return terminal.style || terminal.color ? paintLine(fitted, terminal.color) : fitted;
        }).join("\n");
    }
    const lines = panel("autopull / overview", overview, width, 5, terminal);
    const bodyHeight = rows - 8;
    const sideBySide = width >= 120 && bodyHeight >= DETAIL_ROWS && model.repositories.length > 0;
    const selected = model.repositories[model.selectedIndex];
    let content = [];
    let title = "repositories";
    let accent = 36;
    if (model.modal) {
        title = model.modal.kind === "input" ? "group / name" : "confirmation";
        accent = 33;
        content = [...wrapText(model.modal.title, width - 4), "",
            model.modal.kind === "input" ? `> ${model.modal.value}_` : "Press y to confirm or any other key to cancel.",
            model.modal.kind === "input" ? "Enter save  Esc cancel" : ""];
    } else if (model.view === "groups") {
        title = "Repository groups";
        const entries = [{ name: "All repositories", repositories: model.allRepositories.map((repository) => repository.path) }, ...model.groups];
        const visible = viewport(entries, model.groupIndex, Math.max(1, bodyHeight - 2));
        content = visible.items.map((group, index) => {
            const active = group.name === model.activeGroup || (!model.activeGroup && visible.offset + index === 0);
            return `${visible.offset + index === model.groupIndex ? "›" : " "} ${group.name}  ${group.repositories.length} repos${active ? "  active" : ""}`;
        });
    } else if (model.view === "members") {
        title = `Edit group: ${model.editingGroup}`;
        const paths = new Set(model.groups.find((group) => group.name === model.editingGroup)?.repositories ?? []);
        const visible = viewport(model.allRepositories, model.memberIndex, Math.max(1, bodyHeight - 2));
        content = visible.items.map((repository, index) =>
            `${visible.offset + index === model.memberIndex ? "›" : " "} ${paths.has(repository.path) ? "[x]" : "[ ]"} @${branchLabel(repository)}  ${repository.name}`);
        if (!content.length) content.push("No scanned repositories.");
    } else {
        const showDetails = selected && bodyHeight >= 16;
        const listWidth = sideBySide ? Math.floor(width * 0.60) : width;
        const listHeight = sideBySide || !showDetails ? bodyHeight : bodyHeight - DETAIL_ROWS;
        const visible = viewport(model.repositories, model.selectedIndex, Math.max(1, listHeight - 3));
        title = `repositories / ${scope} / ${model.repositories.length ? `${visible.offset + 1}–${visible.offset + visible.items.length}` : "0"} of ${model.repositories.length}`;
        content = [repositoryHeader(listWidth - 4), ...visible.items.map((repository, index) =>
            repositoryRow(repository, visible.offset + index === model.selectedIndex, listWidth - 4))];
        if (!model.repositories.length) content = [...wrapText(model.busy ? "Scanning for Git repositories…" : model.activeGroup
            ? `No scanned repositories belong to ${scope}. Press g to edit membership.`
            : "No Git repositories found. Press s to scan again.", listWidth - 4)];
        const list = panel(title, content, listWidth, listHeight, terminal);
        if (sideBySide && selected) {
            const detailWidth = width - listWidth - 1;
            const detail = panel("selected / repository", repositoryDetailLines(selected, detailWidth - 4), detailWidth, bodyHeight, terminal, 34);
            lines.push(...list.map((line, index) => `${line} ${detail[index]}`));
        } else {
            lines.push(...list);
            if (showDetails) lines.push(...panel("selected / repository", repositoryDetailLines(selected, width - 4), width, DETAIL_ROWS, terminal, 34));
        }
    }
    if (model.modal || model.view !== "repositories") {
        lines.push(...panel(title, content, width, bodyHeight, terminal, accent));
    }
    let controls = "↑↓/jk move  s scan  r refresh  p pull  g groups  q quit";
    if (model.activeGroup) controls = "↑↓/jk move  p pull  a pull group  g groups  q quit";
    if (model.view === "groups") controls = "↑↓/jk move  Enter use  n new  e members  r rename  d delete  Esc back";
    if (model.view === "members") controls = "↑↓/jk move  Space toggle membership  Enter/Esc done";
    if (model.modal) controls = model.modal.kind === "input" ? "Type a group name  Enter save  Esc cancel" : "y confirm  n/Esc cancel";
    if (width < 40) controls = model.modal ? "Esc cancel" : "↑↓ move  q quit";
    lines.push(...panel("controls", [controls], width, 3, terminal));
    return lines.slice(0, rows).join("\n");
};

export const tuiActionForKey = (key = {}) => {
    if (key.ctrl && key.name === "c") return "quit";
    if (key.name === "q") return "quit";
    if (key.name === "escape") return "back";
    if (key.name === "up" || key.name === "k") return "up";
    if (key.name === "down" || key.name === "j") return "down";
    if (key.name === "s") return "scan";
    if (key.name === "r") return "refresh";
    if (key.name === "p") return "pull";
    if (key.name === "a") return "pull-group";
    if (key.name === "g") return "groups";
    if (key.name === "n") return "new";
    if (key.name === "e") return "edit";
    if (key.name === "d") return "delete";
    if (key.name === "space") return "toggle";
    if (key.name === "return") return "enter";
    return null;
};

export const runTui = async (options, io = process, services = {}) => {
    const input = io.stdin;
    const output = io.stdout;
    if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
        throw new Error("The TUI requires an interactive terminal.");
    }

    const discover = services.discoverRepositories ?? discoverRepositories;
    const inspect = services.inspectMany ?? inspectMany;
    const refresh = services.refreshMany ?? refreshMany;
    const pull = services.pullRepository ?? pullRepository;
    const pullGroup = services.pullMany ?? pullMany;
    const readGroups = services.loadGroups ?? loadGroups;
    const writeGroups = services.saveGroups ?? saveGroups;
    const roots = options.roots;
    let active = true;
    const model = {
        roots,
        allRepositories: [],
        repositories: [],
        summary: summarize([]),
        discoveryErrors: [],
        selectedIndex: 0,
        groups: [],
        activeGroup: null,
        groupIndex: 0,
        editingGroup: null,
        memberIndex: 0,
        view: "repositories",
        modal: null,
        busy: false,
        activity: "",
        notification: "",
    };

    const draw = () => {
        if (!active) return;
        const color = options.color ?? (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
        output.write(`${CLEAR_SCREEN}${renderTui(model, { columns: output.columns, rows: output.rows, style: true, color })}`);
    };

    const applyGroupFilter = () => {
        const selectedPath = model.repositories[model.selectedIndex]?.path;
        if (model.activeGroup && !model.groups.some((group) => group.name === model.activeGroup)) {
            model.activeGroup = null;
        }
        model.repositories = repositoriesInGroup(model.allRepositories, model.groups, model.activeGroup);
        const nextIndex = selectedPath
            ? model.repositories.findIndex((repository) => repository.path === selectedPath)
            : -1;
        model.selectedIndex = nextIndex >= 0
            ? nextIndex
            : Math.min(model.selectedIndex, Math.max(0, model.repositories.length - 1));
        model.summary = summarize(model.repositories);
    };

    const replaceRepository = (repository) => {
        const index = model.allRepositories.findIndex((candidate) => candidate.path === repository.path);
        if (index >= 0) model.allRepositories[index] = repository;
        applyGroupFilter();
    };

    const persistGroups = async (nextGroups, message, onSaved) => {
        model.busy = true;
        model.activity = "Saving groups";
        draw();
        try {
            model.groups = await writeGroups(nextGroups, options.groupsPath);
            onSaved?.();
            applyGroupFilter();
            model.notification = message;
        } catch (error) {
            model.notification = `Cannot save groups: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const changeGroups = async (change, message, onSaved) => {
        try {
            await persistGroups(change(), message, onSaved);
        } catch (error) {
            model.notification = error instanceof Error ? error.message : String(error);
            draw();
        }
    };

    const load = async (refreshRemotes) => {
        model.busy = true;
        model.activity = refreshRemotes ? "Refreshing remotes" : "Scanning";
        model.notification = "";
        draw();

        try {
            const discovery = await discover(roots, { maxDepth: options.maxDepth });
            let groupWarning = "";
            try {
                model.groups = await readGroups(options.groupsPath);
            } catch (error) {
                groupWarning = `Cannot read groups: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (refreshRemotes) {
                const results = await refresh(discovery.repositories);
                model.allRepositories = results.map((result) => result.repository);
                const failures = results.filter((result) => !result.ok).length;
                model.notification = failures > 0
                    ? `Refresh finished with ${failures} failure${failures === 1 ? "" : "s"}.`
                    : "Remote state refreshed.";
            } else {
                model.allRepositories = await inspect(discovery.repositories);
                model.notification = `Scanned ${model.allRepositories.length} repositor${model.allRepositories.length === 1 ? "y" : "ies"}.`;
            }
            model.discoveryErrors = discovery.errors;
            applyGroupFilter();
            if (groupWarning) model.notification = groupWarning;
        } catch (error) {
            model.notification = `Failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const pullSelected = async () => {
        const selected = model.repositories[model.selectedIndex];
        if (!selected) {
            model.notification = "There is no repository to pull.";
            draw();
            return;
        }
        if (!selected.canPull) {
            model.notification = `Pull blocked: ${selected.blockers.join("; ")}.`;
            draw();
            return;
        }
        if (!selected.needsPull) {
            model.notification = `${selected.name} has no waiting update.`;
            draw();
            return;
        }

        model.busy = true;
        model.activity = `Pulling ${selected.name}`;
        model.notification = "";
        draw();
        try {
            const result = await pull(selected.path);
            replaceRepository(result.repository);
            model.notification = `${result.ok ? "Updated" : result.blocked ? "Blocked" : "Failed"}: ${result.message}`;
        } catch (error) {
            model.notification = `Pull failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const pullActiveGroup = async () => {
        if (!model.activeGroup) return;
        model.busy = true;
        model.activity = `Pulling ${model.activeGroup}`;
        draw();
        try {
            const outcome = await pullGroup(model.repositories);
            for (const result of outcome.results) replaceRepository(result.repository);
            model.notification = `Group pull: ${outcome.updated} updated, ${outcome.blocked} blocked, ${outcome.failed} failed.`;
        } catch (error) {
            model.notification = `Group pull failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const openGroups = () => {
        model.view = "groups";
        model.groupIndex = model.activeGroup
            ? Math.max(0, model.groups.findIndex((group) => group.name === model.activeGroup) + 1)
            : 0;
        model.notification = "";
        draw();
    };

    const openNamePrompt = (title, value, submit) => {
        model.modal = { kind: "input", title, value, submit };
        model.notification = "";
        draw();
    };

    const createRepositoryGroup = () => {
        openNamePrompt("New group name", "", async (name) => {
            await changeGroups(
                () => createGroup(model.groups, name),
                `Created group ${name.trim()}.`,
                () => { model.groupIndex = model.groups.length; },
            );
        });
    };

    const renameSelectedGroup = () => {
        const group = selectedGroup(model);
        if (!group) {
            model.notification = "All repositories cannot be renamed.";
            draw();
            return;
        }
        const previousName = group.name;
        openNamePrompt(`Rename ${previousName}`, previousName, async (name) => {
            const nextName = name.trim();
            await changeGroups(
                () => renameGroup(model.groups, previousName, nextName),
                `Renamed ${previousName} to ${nextName}.`,
                () => {
                    if (model.activeGroup === previousName) model.activeGroup = nextName;
                },
            );
        });
    };

    const confirmDeleteSelectedGroup = () => {
        const group = selectedGroup(model);
        if (!group) {
            model.notification = "All repositories cannot be deleted.";
            draw();
            return;
        }
        model.modal = {
            kind: "confirm",
            title: `Delete group ${group.name}? Repository files will not be changed.`,
            submit: async () => {
                await changeGroups(
                    () => deleteGroup(model.groups, group.name),
                    `Deleted group ${group.name}.`,
                    () => {
                        if (model.activeGroup === group.name) model.activeGroup = null;
                        model.groupIndex = Math.min(model.groupIndex, model.groups.length);
                    },
                );
            },
        };
        draw();
    };

    const openMembershipEditor = () => {
        const group = selectedGroup(model);
        if (!group) {
            model.notification = "Choose a named group to edit its repositories.";
            draw();
            return;
        }
        model.editingGroup = group.name;
        model.memberIndex = 0;
        model.view = "members";
        model.notification = "Space adds or removes a repository.";
        draw();
    };

    const toggleSelectedMembership = () => {
        const repository = model.allRepositories[model.memberIndex];
        if (!repository || !model.editingGroup) return;
        void changeGroups(
            () => toggleGroupRepository(model.groups, model.editingGroup, repository.path),
            `Updated ${model.editingGroup}.`,
        );
    };

    const confirmGroupPull = () => {
        if (!model.activeGroup) {
            model.notification = "Select a named group before using group pull.";
            draw();
            return;
        }
        const waiting = model.repositories.filter((repository) => repository.needsPull).length;
        if (waiting === 0) {
            model.notification = `${model.activeGroup} has no waiting updates.`;
            draw();
            return;
        }
        model.modal = {
            kind: "confirm",
            title: `Pull ${waiting} waiting repositor${waiting === 1 ? "y" : "ies"} in ${model.activeGroup}?`,
            submit: pullActiveGroup,
        };
        draw();
    };

    return new Promise((resolve) => {
        let finished = false;
        const wasRaw = input.isRaw;
        const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;

        const finish = () => {
            if (finished) return;
            finished = true;
            active = false;
            input.off("keypress", onKeypress);
            output.off?.("resize", onResize);
            if (!wasRaw) input.setRawMode(false);
            if (wasPaused) input.pause();
            output.write(LEAVE_ALTERNATE_SCREEN);
            resolve(0);
        };

        const onResize = () => draw();
        const handleModalKey = (text, key) => {
            if (!model.modal) return false;
            const modal = model.modal;
            if (modal.kind === "confirm") {
                model.modal = null;
                if (key.name === "y") void modal.submit();
                else draw();
                return true;
            }
            if (key.name === "escape") {
                model.modal = null;
                draw();
            } else if (key.name === "backspace") {
                modal.value = modal.value.slice(0, -1);
                draw();
            } else if (key.name === "return") {
                model.modal = null;
                void modal.submit(modal.value);
            } else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f]/u.test(text)) {
                modal.value += text;
                draw();
            }
            return true;
        };

        const moveSelection = (direction) => {
            const indexKey = model.view === "groups"
                ? "groupIndex"
                : model.view === "members" ? "memberIndex" : "selectedIndex";
            const length = model.view === "groups"
                ? model.groups.length + 1
                : model.view === "members" ? model.allRepositories.length : model.repositories.length;
            model[indexKey] = Math.max(0, Math.min(length - 1, model[indexKey] + direction));
            model.notification = "";
            draw();
        };

        const onKeypress = (text, key) => {
            if (handleModalKey(text, key)) return;
            const action = tuiActionForKey(key);
            if (action === "quit") {
                finish();
                return;
            }
            if (model.busy) return;
            if (action === "up") {
                moveSelection(-1);
            } else if (action === "down") {
                moveSelection(1);
            } else if (action === "back") {
                if (model.view === "members") model.view = "groups";
                else if (model.view === "groups") model.view = "repositories";
                else {
                    finish();
                    return;
                }
                model.notification = "";
                draw();
            } else if (model.view === "groups" && action === "new") {
                createRepositoryGroup();
            } else if (model.view === "groups" && action === "edit") {
                openMembershipEditor();
            } else if (model.view === "groups" && action === "refresh") {
                renameSelectedGroup();
            } else if (model.view === "groups" && action === "delete") {
                confirmDeleteSelectedGroup();
            } else if (model.view === "groups" && action === "enter") {
                model.activeGroup = selectedGroup(model)?.name ?? null;
                applyGroupFilter();
                model.view = "repositories";
                model.notification = model.activeGroup ? `Showing ${model.activeGroup}.` : "Showing all repositories.";
                draw();
            } else if (model.view === "members" && action === "toggle") {
                toggleSelectedMembership();
            } else if (model.view === "members" && action === "enter") {
                model.view = "groups";
                model.notification = "";
                draw();
            } else if (model.view !== "repositories") {
                return;
            } else if (action === "scan") {
                void load(false);
            } else if (action === "refresh") {
                void load(true);
            } else if (action === "pull") {
                void pullSelected();
            } else if (action === "pull-group") {
                confirmGroupPull();
            } else if (action === "groups") {
                openGroups();
            } else if (action === "enter") {
                void pullSelected();
            }
        };

        output.write(ENTER_ALTERNATE_SCREEN);
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.resume();
        input.on("keypress", onKeypress);
        output.on?.("resize", onResize);
        void load(false);
    });
};
