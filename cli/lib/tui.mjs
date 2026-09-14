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
    if (/^─+$/.test(line)) return `\u001b[2m${line}${ANSI_RESET}`;
    if (line.startsWith("AUTOPULL")) return `\u001b[1m${line}${ANSI_RESET}`;
    if (/^\s*REPOSITORY\s+BRANCH\s+STATE/.test(line)) return `\u001b[2m${line}${ANSI_RESET}`;
    if (!color) return line;

    return line
        .replace(/\b(CONFLICT(?: \d+)?|ERROR)\b/g, "\u001b[1;31m$1\u001b[0m")
        .replace(/\b(DIRTY(?: \d+)?|NO-UPSTREAM|DETACHED)\b/g, "\u001b[33m$1\u001b[0m")
        .replace(/\b(BEHIND(?: \d+)?|READY)\b/g, "\u001b[36m$1\u001b[0m")
        .replace(/\b(AHEAD(?: \d+)?)\b/g, "\u001b[34m$1\u001b[0m")
        .replace(/\bCURRENT\b/g, "\u001b[2m$&\u001b[0m");
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

const fit = (value, width) => {
    const text = String(value);
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

const repositoryHeader = (width) => {
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
        const branchWidth = Math.min(16, Math.max(6, Math.floor(width * 0.28)));
        const stateWidth = Math.min(12, Math.max(5, Math.floor(width * 0.23)));
        const nameWidth = Math.max(4, width - branchWidth - stateWidth - 7);
        return [marker, fit(`@${branch}`, branchWidth), fit(repository.name, nameWidth), fit(state, stateWidth)].join(" ");
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

const cropLines = (lines, rows, footer) => {
    if (lines.length + footer.length <= rows) return [...lines, ...footer];
    const visibleContent = Math.max(1, rows - footer.length);
    return [...lines.slice(0, visibleContent), ...footer];
};

const selectedGroup = (model) => model.groupIndex === 0 ? null : model.groups[model.groupIndex - 1];

const renderModal = (model, lines, width) => {
    lines.push("", "─".repeat(width), fit(model.modal.title, width));
    if (model.modal.kind === "input") {
        lines.push(fit(`> ${model.modal.value}_`, width), "", "Enter save  Esc cancel");
    } else {
        lines.push("", "Press y to confirm or any other key to cancel.");
    }
};

const renderGroups = (model, lines, width, rows) => {
    lines.push("Repository groups", "");
    const entries = [{ name: "All repositories", repositories: model.allRepositories.map((repository) => repository.path) }, ...model.groups];
    const visible = viewport(entries, model.groupIndex, Math.max(2, rows - 8));
    for (const [index, group] of visible.items.entries()) {
        const marker = visible.offset + index === model.groupIndex ? "›" : " ";
        const active = group.name === model.activeGroup || (model.activeGroup === null && visible.offset + index === 0)
            ? "  active"
            : "";
        lines.push(fit(`${marker} ${group.name}  ${group.repositories.length} repos${active}`, width));
    }
};

const renderMembers = (model, lines, width, rows) => {
    const group = model.groups.find((candidate) => candidate.name === model.editingGroup);
    const paths = new Set(group?.repositories ?? []);
    lines.push(fit(`Edit group: ${model.editingGroup}`, width), "");
    const visible = viewport(model.allRepositories, model.memberIndex, Math.max(2, rows - 8));
    for (const [index, repository] of visible.items.entries()) {
        const marker = visible.offset + index === model.memberIndex ? "›" : " ";
        const checked = paths.has(repository.path) ? "[x]" : "[ ]";
        lines.push(fit(`${marker} ${checked} @${branchLabel(repository)}  ${repository.name}`, width));
    }
    if (model.allRepositories.length === 0) lines.push("No scanned repositories.");
};

export const renderTui = (model, terminal = {}) => {
    const width = Math.max(20, terminal.columns ?? 100);
    const rows = Math.max(8, terminal.rows ?? 30);
    const summary = model.summary ?? summarize(model.repositories);
    const busy = model.busy ? `  ${model.activity}…` : "";
    const groupLabel = model.activeGroup ? `  Group: ${model.activeGroup}` : "";
    const title = `AUTOPULL  ${summary.total} repos  ${summary.updatesReady} ready  ${summary.dirty} dirty  ${summary.conflicts} conflicted${groupLabel}${busy}`;
    const lines = [fit(title, width), "─".repeat(width)];

    if (model.modal) {
        renderModal(model, lines, width);
    } else if (model.view === "groups") {
        renderGroups(model, lines, width, rows);
    } else if (model.view === "members") {
        renderMembers(model, lines, width, rows);
    } else if (model.repositories.length === 0) {
        const emptyMessage = model.activeGroup
            ? `No scanned repositories belong to ${model.activeGroup}. Press g to edit membership.`
            : "No Git repositories found.";
        lines.push("", model.busy ? "Scanning for Git repositories…" : emptyMessage);
    } else {
        const listCapacity = Math.max(3, rows - (width >= 76 ? 15 : 14));
        const visible = viewport(model.repositories, model.selectedIndex, listCapacity);
        if (width >= 76) lines.push(repositoryHeader(width));
        for (const [index, repository] of visible.items.entries()) {
            lines.push(repositoryRow(repository, visible.offset + index === model.selectedIndex, width));
        }

        const selected = model.repositories[model.selectedIndex];
        if (selected) {
            const changePreview = selected.changedFiles.slice(0, 3).map((file) => file.path).join(", ");
            const remaining = Math.max(0, selected.changedFiles.length - 3);
            lines.push(
                "",
                "─".repeat(width),
                fit(`${selected.name}  ${selected.path}`, width),
                fit(`Branch  ${selected.branch ?? "detached"}  →  ${selected.upstream ?? "no upstream"}`, width),
                fit(`State   ${worktreeLabel(selected)}; remote ${remoteLabel(selected)}`, width),
                fit(`Action  ${actionLabel(selected)}`, width),
            );
            if (changePreview) {
                lines.push(fit(`Files   ${changePreview}${remaining > 0 ? `, +${remaining} more` : ""}`, width));
            }
        }
    }

    if (model.discoveryErrors.length > 0) {
        lines.push(fit(`Warning  ${model.discoveryErrors[0].path}: ${model.discoveryErrors[0].message}`, width));
    }

    const status = model.notification || `Roots: ${model.roots.join(":")}`;
    let controls = "↑/k up  ↓/j down  s scan  r refresh  p pull  g groups  q quit";
    if (model.activeGroup) controls = "↑/k up  ↓/j down  p pull  a pull group  g groups  q quit";
    if (model.view === "groups") controls = "↑/k up  ↓/j down  Enter use  n new  e members  r rename  d delete  Esc back";
    if (model.view === "members") controls = "↑/k up  ↓/j down  Space toggle membership  Enter/Esc done";
    if (model.modal) controls = model.modal.kind === "input" ? "Type a group name" : "y confirm  n/Esc cancel";
    const footer = [fit(status, width), fit(controls, width)];
    const fitted = cropLines(lines, rows, footer).map((line) => fit(line, width));
    return (terminal.style || terminal.color ? fitted.map((line) => paintLine(line, terminal.color)) : fitted).join("\n");
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
