import { emitKeypressEvents } from "node:readline";
import { discoverRepositories } from "./discovery.mjs";
import { pullRepository } from "./git.mjs";
import { inspectMany, refreshMany, summarize } from "./protocol.mjs";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[?25l";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

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

const repositoryRow = (repository, selected, width) => {
    const marker = selected ? "›" : " ";
    const state = stateLabel(repository);

    if (width < 76) {
        const available = Math.max(8, width - state.length - 5);
        return `${marker} ${fit(repository.name, available)}  ${state}`;
    }

    const branchWidth = Math.min(20, Math.max(12, Math.floor(width * 0.2)));
    const stateWidth = 14;
    const remoteWidth = Math.min(24, Math.max(14, Math.floor(width * 0.22)));
    const nameWidth = Math.max(12, width - branchWidth - stateWidth - remoteWidth - 8);
    return [
        marker,
        fit(repository.name, nameWidth),
        fit(repository.branch ?? "detached", branchWidth),
        fit(state, stateWidth),
        fit(remoteLabel(repository), remoteWidth),
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

export const renderTui = (model, terminal = {}) => {
    const width = Math.max(20, terminal.columns ?? 100);
    const rows = Math.max(8, terminal.rows ?? 30);
    const summary = model.summary ?? summarize(model.repositories);
    const busy = model.busy ? `  ${model.activity}…` : "";
    const title = `AUTOPULL  ${summary.total} repos  ${summary.updatesReady} ready  ${summary.dirty} dirty  ${summary.conflicts} conflicted${busy}`;
    const lines = [fit(title, width), "─".repeat(width)];

    if (model.repositories.length === 0) {
        lines.push("", model.busy ? "Scanning for Git repositories…" : "No Git repositories found.");
    } else {
        const listCapacity = Math.max(3, rows - 14);
        const visible = viewport(model.repositories, model.selectedIndex, listCapacity);
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
    const footer = [
        fit(status, width),
        fit("↑/k up  ↓/j down  s scan  r refresh remotes  p pull selected  q quit", width),
    ];
    return cropLines(lines, rows, footer).map((line) => fit(line, width)).join("\n");
};

export const tuiActionForKey = (key = {}) => {
    if (key.ctrl && key.name === "c") return "quit";
    if (key.name === "q" || key.name === "escape") return "quit";
    if (key.name === "up" || key.name === "k") return "up";
    if (key.name === "down" || key.name === "j") return "down";
    if (key.name === "s") return "scan";
    if (key.name === "r") return "refresh";
    if (key.name === "p" || key.name === "return") return "pull";
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
    const roots = options.roots;
    let active = true;
    const model = {
        roots,
        repositories: [],
        summary: summarize([]),
        discoveryErrors: [],
        selectedIndex: 0,
        busy: false,
        activity: "",
        notification: "",
    };

    const draw = () => {
        if (!active) return;
        output.write(`${CLEAR_SCREEN}${renderTui(model, output)}`);
    };

    const load = async (refreshRemotes) => {
        model.busy = true;
        model.activity = refreshRemotes ? "Refreshing remotes" : "Scanning";
        model.notification = "";
        draw();

        try {
            const discovery = await discover(roots, { maxDepth: options.maxDepth });
            if (refreshRemotes) {
                const results = await refresh(discovery.repositories);
                model.repositories = results.map((result) => result.repository);
                const failures = results.filter((result) => !result.ok).length;
                model.notification = failures > 0
                    ? `Refresh finished with ${failures} failure${failures === 1 ? "" : "s"}.`
                    : "Remote state refreshed.";
            } else {
                model.repositories = await inspect(discovery.repositories);
                model.notification = `Scanned ${model.repositories.length} repositor${model.repositories.length === 1 ? "y" : "ies"}.`;
            }
            model.discoveryErrors = discovery.errors;
            model.selectedIndex = Math.min(model.selectedIndex, Math.max(0, model.repositories.length - 1));
            model.summary = summarize(model.repositories);
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
            const index = model.repositories.findIndex((repository) => repository.path === selected.path);
            if (index >= 0) model.repositories[index] = result.repository;
            model.summary = summarize(model.repositories);
            model.notification = `${result.ok ? "Updated" : result.blocked ? "Blocked" : "Failed"}: ${result.message}`;
        } catch (error) {
            model.notification = `Pull failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
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
        const onKeypress = (_text, key) => {
            const action = tuiActionForKey(key);
            if (action === "quit") {
                finish();
                return;
            }
            if (model.busy) return;
            if (action === "up" && model.repositories.length > 0) {
                model.selectedIndex = Math.max(0, model.selectedIndex - 1);
                model.notification = "";
                draw();
            } else if (action === "down" && model.repositories.length > 0) {
                model.selectedIndex = Math.min(model.repositories.length - 1, model.selectedIndex + 1);
                model.notification = "";
                draw();
            } else if (action === "scan") {
                void load(false);
            } else if (action === "refresh") {
                void load(true);
            } else if (action === "pull") {
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
