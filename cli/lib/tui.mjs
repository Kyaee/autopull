import { emitKeypressEvents } from "node:readline";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverCodingAgents, launchCodingAgent, resolveCodingAgent } from "./agents.mjs";
import { canonicalDirectory, isDirectoryExcluded, loadExclusions, saveExclusions } from "./exclusions.mjs";
import { discoverRepositories } from "./discovery.mjs";
import { stashRepositoryChanges } from "./stash.mjs";
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
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PREFIX_ACTIONS = new Set(["scan", "root", "fix", "stash", "delete", "exclusions", "groups", "pull-group", "select-all", "clear-selection"]);
const prefixCommands = (model) => [
    ["s", "scan"], ["x", "fix"], ["z", "stash"], ["d", "hide"],
    ["h", "hidden"], ["g", "groups"], ["o", "root"],
    ...(model.activeGroup ? [["a", "group pull"]] : []),
    ["v", "all"], ["c", "clear"],
];

const commandLines = (entries, width) => {
    const lines = [];
    let line = "";
    for (const entry of entries) {
        if (line && line.length + entry.length + 2 > width) {
            lines.push(line);
            line = "";
        }
        line = line ? `${line}  ${entry}` : entry;
    }
    if (line) lines.push(line);
    return lines;
};

const styledSlice = (line, start, end) => {
    let position = 0;
    let styles = "";
    let result = "";
    let started = false;
    for (const [token] of line.matchAll(/\u001b\[[0-9;]*m|[^\u001b]+/gu)) {
        if (token.startsWith("\u001b")) {
            if (position < start) styles += token;
            else if (position < end) result += token;
            continue;
        }
        const from = Math.max(0, start - position);
        const to = Math.min(token.length, end - position);
        if (to > from) {
            if (!started) {
                result = styles + result;
                started = true;
            }
            result += token.slice(from, to);
        }
        position += token.length;
        if (position >= end) break;
    }
    return result.includes("\u001b") ? result + ANSI_RESET : result;
};

const floatingCommands = (lines, model, width, terminal, controlRows) => {
    if (!model.prefixArmed || model.modal || model.view !== "repositories") return lines;
    const compact = width < 40;
    const popupWidth = compact ? width : Math.min(64, width - 8);
    const commands = [...prefixCommands(model).map(([key, label]) => `${key} ${label}`), "Esc cancel"];
    const content = commandLines(compact ? ["Ctrl+A", ...commands] : commands, popupWidth - (compact ? 0 : 4));
    const popup = (compact ? content.map((value) => fit(value, popupWidth))
        : panel("Ctrl+A / commands", content, popupWidth, content.length + 2, { color: false, style: false }))
        .map((line) => terminal.color ? `\u001b[1;97;44m${line}${ANSI_RESET}`
            : terminal.style ? `\u001b[1m${line}${ANSI_RESET}` : line);
    const top = Math.max(0, lines.length - controlRows - (compact ? 0 : 1) - popup.length);
    const left = compact ? 0 : width - popupWidth - 2;
    const result = [...lines];
    if (compact && top > 0) {
        // Keep the focused repository visible when a tiny terminal needs a full-width popup.
        const focused = lines.find((line) => line.includes("›"));
        if (focused) result[0] = focused;
    }
    for (let index = 0; index < popup.length; index += 1) {
        const original = result[top + index];
        result[top + index] = styledSlice(original, 0, left) + popup[index] + styledSlice(original, left + popupWidth, width);
    }
    return result;
};

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
        .replace(/(?<![\p{L}\p{N}])(↑↓ jk|Ctrl\+A|\^A|Enter\/Esc|Enter|Esc|Space|[sfrpgaqnedoxhzvc])(?= (?:move|mark|more|scan|fetch|fix|stash|pull|groups|root|quit|new|members|rename|delete|use|back|done|toggle|confirm|cancel|open|hide|hidden|restore|edit|add|all|clear))/gu,
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
    const nameColor = repository.state === "error" || repository.state === "conflict" || repository.conflicts > 0
        ? 31
        : repository.state !== "current" || repository.dirty || repository.diverged || !repository.canPull || repository.needsPull
            ? 33 : null;

    if (width < 76) {
        const columns = compactRepositoryColumnWidths(width);
        const name = fit(repository.name, columns.name);
        return {
            text: [marker, fit(`@${branch}`, columns.branch), name, fit(state, columns.state)].join(" "),
            nameStart: columns.branch + 3, nameLength: name.trimEnd().length, nameColor, selected,
        };
    }

    const columns = repositoryColumnWidths(width);
    const name = fit(repository.name, columns.name);
    return { text: [
        marker,
        name,
        fit(branch, columns.branch),
        fit(state, columns.state),
        fit(remoteLabel(repository), columns.remote),
    ].join(" "), nameStart: 2, nameLength: name.trimEnd().length, nameColor, selected };
};

const selectionHeader = (model, width) => model.markedPaths?.length
    ? `      ${repositoryHeader(width - 4).slice(2)}` : repositoryHeader(width);

const selectionRow = (model, repository, selected, width) => {
    const marking = model.markedPaths?.length > 0;
    const row = repositoryRow(repository, selected, width - (marking ? 4 : 0));
    if (marking) {
        row.text = `${row.text.slice(0, 2)}[${model.markedPaths.includes(repository.path) ? "x" : " "}] ${row.text.slice(2)}`;
        row.nameStart += 4;
    }
    return row;
};

const paintContent = (value, width, terminal) => {
    const row = typeof value === "object" ? value : null;
    const line = fit(row ? row.text : value, width);
    if (!terminal.style && !terminal.color) return line;
    if (!row) return paintLine(line, terminal.color);
    if (!terminal.color) return paintLine(line, false);
    const start = Math.min(row.nameStart, line.length);
    const end = Math.min(start + row.nameLength, line.length);
    const name = row.nameColor
        ? `\u001b[${row.selected ? `27;${row.nameColor};100` : row.nameColor}m${line.slice(start, end)}\u001b[${row.selected ? "39;49;7" : "39"}m`
        : line.slice(start, end);
    if (row.selected) return `\u001b[1;7m${line.slice(0, start)}${name}${line.slice(end)}${ANSI_RESET}`;
    return `${line.slice(0, start)}${name}${paintLine(line.slice(end), terminal.color)}`;
};

const actionLabel = (repository) => {
    if (!repository.canPull) return `Blocked: ${repository.blockers.join("; ")}. Press Ctrl+A then x to fix`;
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
    const border = (line) => terminal.color ? `\u001b[${accent}m${line}${ANSI_RESET}` : line;
    const heading = ` ${title} `;
    const top = `╭─${fit(heading, width - 4).trimEnd()}`;
    const lines = [border(`${top}${"─".repeat(Math.max(0, width - top.length - 1))}╮`)];
    for (let index = 0; index < height - 2; index += 1) {
        const line = paintContent(content[index] ?? "", inner, terminal);
        lines.push(`${border("│")} ${line} ${border("│")}`);
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
    const selection = model.markedPaths?.length ? `  ${model.markedPaths.length} selected` : "";
    const overview = [`AUTOPULL  ${summary.total} repos${selection}  ${summary.updatesReady} ready  ${summary.dirty} dirty  ${summary.conflicts} conflicted`];
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
    const status = model.busy ? `${SPINNER_FRAMES[(model.spinnerFrame ?? 0) % SPINNER_FRAMES.length]} ${model.activity}…` : model.notification ? `STATUS  ${model.notification}`
        : warning ? `Warning  ${warning.path}: ${warning.message}` : `SCOPE   ${scope}  ${model.roots.join(":")}`;
    overview.push(status);
    if (rows < 12) {
        const selected = model.repositories[model.selectedIndex];
        const selectedLine = selected ? selectionRow(model, selected, true, width) : "No repositories found.";
        let compact = [overview[0], status, selectionHeader(model, width),
            selectedLine];
        if (model.modal?.kind === "agents") {
            const visible = viewport(model.modal.agents, model.modal.selectedIndex, rows - 3);
            compact = [`Fix ${model.modal.repository.name}`, "Choose a coding CLI",
                ...visible.items.map((agent, index) => `${visible.offset + index === model.modal.selectedIndex ? "›" : " "} ${agent.name}`)];
        } else if (model.modal?.kind === "input") {
            compact = [model.modal.heading ?? "group / name", ...wrapText(model.modal.title, width).slice(0, rows - 4),
                `> ${model.modal.value}_`];
        } else if (model.modal?.kind === "confirm") {
            compact = ["Confirm", ...wrapText(model.modal.compactTitle ?? model.modal.title, width).slice(0, rows - 2)];
        } else if (model.view === "exclusions") {
            const directories = model.excludedDirectories ?? [];
            const visible = viewport(directories, model.excludedIndex ?? 0, rows - 3);
            compact = ["Hidden directories", "Enter restore e edit",
                ...visible.items.map((path, index) => `${visible.offset + index === model.excludedIndex ? "›" : " "} ${path}`)];
        }
        while (compact.length < rows - 1) compact.push("");
        const controls = model.modal?.kind === "confirm" ? "y confirm n cancel" : model.modal
            ? `Enter ${model.modal.submitLabel ?? (model.modal.heading === "root folder" ? "scan" : model.modal.kind === "agents" || model.modal.heading === "coding CLI" ? "open" : "save")} Esc cancel`
            : model.view === "exclusions" ? "Esc back q quit" : width < 40 ? "Ctrl+A more q quit" : "↑↓ jk move Space mark Ctrl+A more q quit";
        const lines = [...compact.map((line) => paintContent(line, width, terminal)), paintContent(controls, width, terminal)];
        return floatingCommands(lines, model, width, terminal, 1).join("\n");
    }
    const lines = panel(`autopull / ${model.roots.join(":")}`, overview, width, 5, terminal);
    const bodyHeight = rows - 8;
    const sideBySide = width >= 120 && bodyHeight >= DETAIL_ROWS && model.repositories.length > 0;
    const selected = model.repositories[model.selectedIndex];
    let content = [];
    let title = "repositories";
    let accent = 36;
    if (model.modal?.kind === "agents") {
        title = `fix / ${model.modal.repository.name}`;
        accent = 34;
        const heading = bodyHeight >= 7
            ? [fit(model.modal.repository.path, width - 4), model.modal.agents.length === 1
                ? "No known coding CLIs found on PATH." : "Choose a coding CLI to open interactively.", ""]
            : bodyHeight >= 5 ? [fit(model.modal.repository.path, width - 4)] : [];
        const visible = viewport(model.modal.agents, model.modal.selectedIndex, Math.max(1, bodyHeight - 2 - heading.length));
        content = [...heading,
            ...visible.items.map((agent, index) => `${visible.offset + index === model.modal.selectedIndex ? "›" : " "} ${agent.name}${agent.command ? ` (${agent.command})` : ""}`),
        ];
    } else if (model.modal) {
        title = model.modal.kind === "input" ? model.modal.heading ?? "group / name" : "confirmation";
        accent = 33;
        content = [...wrapText(bodyHeight < 10 ? model.modal.compactTitle ?? model.modal.title : model.modal.title, width - 4), "",
            model.modal.kind === "input" ? `> ${model.modal.value}_` : "Press y to confirm or any other key to cancel.",
            model.modal.kind === "input" ? `Enter ${model.modal.submitLabel ?? (model.modal.heading === "root folder" ? "scan" : "save")}  Esc cancel` : ""];
    } else if (model.view === "exclusions") {
        title = "Hidden directories / editable exclusions";
        const directories = model.excludedDirectories ?? [];
        const visible = viewport(directories, model.excludedIndex ?? 0, Math.max(1, bodyHeight - 2));
        content = visible.items.map((path, index) => `${visible.offset + index === model.excludedIndex ? "›" : " "} ${path}`);
        if (!content.length) content.push("No hidden directories. Press n to add one.");
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
        content = [selectionHeader(model, listWidth - 4), ...visible.items.map((repository, index) =>
            selectionRow(model, repository, visible.offset + index === model.selectedIndex, listWidth - 4))];
        if (!model.repositories.length) content = [...wrapText(model.busy ? "Scanning for Git repositories…" : model.activeGroup
            ? `No scanned repositories belong to ${scope}. Press Ctrl+A then g to edit membership.`
            : "No Git repositories found. Press Ctrl+A then s to scan again.", listWidth - 4)];
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
    let controls = "↑↓ jk move Space mark f fetch p pull Ctrl+A more q quit";
    if (model.view === "groups") controls = "↑↓ jk move  Enter use  n new  e members  r rename  d delete  Esc back";
    if (model.view === "members") controls = "↑↓ jk move  Space toggle membership  Enter/Esc done";
    if (model.view === "exclusions") controls = "↑↓ jk Enter restore e edit n add Esc back q quit";
    if (model.modal) controls = model.modal.kind === "agents" ? "↑↓ jk move  Enter open  Esc cancel"
        : model.modal.kind === "input" ? model.modal.heading === "coding CLI"
        ? "Type a CLI command  Enter open  Esc cancel"
        : model.modal.heading === "root folder"
        ? "Type a folder path  Enter scan  Esc cancel"
        : model.modal.heading === "excluded directory"
        ? "Type a folder path  Enter save  Esc cancel"
        : "Type a group name  Enter save  Esc cancel" : "y confirm  n/Esc cancel";
    if (width < 40) controls = model.modal?.kind === "confirm" ? "y confirm n cancel" : model.modal ? "Enter open Esc" : model.view === "exclusions" ? "r undo q quit" : "^A more q quit";
    lines.push(...panel("controls", [controls], width, 3, terminal));
    return floatingCommands(lines.slice(0, rows), model, width, terminal, 3).join("\n");
};

export const tuiActionForKey = (key = {}) => {
    if (key.ctrl && key.name === "c") return "quit";
    if (key.ctrl && key.name === "a") return "prefix";
    if (key.ctrl || key.meta) return null;
    if (key.name === "q") return "quit";
    if (key.name === "escape") return "back";
    if (key.name === "up" || key.name === "j") return "up";
    if (key.name === "down" || key.name === "k") return "down";
    if (key.name === "s") return "scan";
    if (key.name === "f" || key.name === "r") return "fetch";
    if (key.name === "o") return "root";
    if (key.name === "x") return "fix";
    if (key.name === "v") return "select-all";
    if (key.name === "c") return "clear-selection";
    if (key.name === "z") return "stash";
    if (key.name === "h") return "exclusions";
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
    const fetch = services.refreshMany ?? refreshMany;
    const pull = services.pullRepository ?? pullRepository;
    const stashChanges = services.stashRepositoryChanges ?? stashRepositoryChanges;
    const pullGroup = services.pullMany ?? pullMany;
    const readGroups = services.loadGroups ?? loadGroups;
    const writeGroups = services.saveGroups ?? saveGroups;
    const findAgents = services.discoverCodingAgents ?? discoverCodingAgents;
    const resolveAgent = services.resolveCodingAgent ?? resolveCodingAgent;
    const launchAgent = services.launchCodingAgent ?? launchCodingAgent;
    const readExclusions = services.loadExclusions ?? loadExclusions;
    const writeExclusions = services.saveExclusions ?? saveExclusions;
    let active = true;
    let suspended = false;
    let animationTimer = null;
    const model = {
        roots: [...options.roots],
        allRepositories: [],
        repositories: [],
        summary: summarize([]),
        discoveryErrors: [],
        selectedIndex: 0,
        markedPaths: [],
        groups: [],
        activeGroup: null,
        groupIndex: 0,
        editingGroup: null,
        memberIndex: 0,
        excludedDirectories: [],
        excludedIndex: 0,
        view: "repositories",
        modal: null,
        prefixArmed: false,
        busy: false,
        activity: "",
        spinnerFrame: 0,
        notification: "",
    };

    const draw = () => {
        if (!active || suspended) return;
        clearTimeout(animationTimer);
        animationTimer = null;
        if (!model.busy) model.spinnerFrame = 0;
        const color = options.color ?? (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
        output.write(`${CLEAR_SCREEN}${renderTui(model, { columns: output.columns, rows: output.rows, style: true, color })}`);
        if (model.busy) {
            animationTimer = setTimeout(() => {
                model.spinnerFrame = (model.spinnerFrame + 1) % SPINNER_FRAMES.length;
                draw();
            }, 100);
        }
    };

    const applyGroupFilter = () => {
        const selectedPath = model.repositories[model.selectedIndex]?.path;
        if (model.activeGroup && !model.groups.some((group) => group.name === model.activeGroup)) {
            model.activeGroup = null;
        }
        const included = model.allRepositories.filter((repository) => !isDirectoryExcluded(repository.path, model.excludedDirectories));
        model.repositories = repositoriesInGroup(included, model.groups, model.activeGroup);
        const visiblePaths = new Set(model.repositories.map((repository) => repository.path));
        model.markedPaths = model.markedPaths.filter((path) => visiblePaths.has(path));
        model.excludedIndex = Math.max(0, Math.min(model.excludedIndex, model.excludedDirectories.length - 1));
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

    const load = async (fetchRemotes, rootFolder = null) => {
        model.busy = true;
        model.activity = fetchRemotes ? "Fetching remotes" : "Scanning";
        model.notification = "";
        draw();

        try {
            if (rootFolder !== null) {
                const value = rootFolder.trim();
                if (!value) throw new Error("Root folder cannot be empty.");
                const path = resolve(value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value);
                try {
                    await access(path, constants.R_OK | constants.X_OK);
                    if (!(await stat(path)).isDirectory()) throw new Error("Not a directory.");
                    model.roots = [await realpath(path)];
                } catch {
                    throw new Error(`Root folder is not a readable directory: ${path}`);
                }
                model.activeGroup = null;
                model.selectedIndex = 0;
                model.markedPaths = [];
                model.allRepositories = [];
                model.repositories = [];
                model.summary = summarize([]);
                model.discoveryErrors = [];
                draw();
            }
            model.excludedDirectories = await readExclusions(options.exclusionsPath);
            applyGroupFilter();
            const discovery = await discover(model.roots, { maxDepth: options.maxDepth, excludedDirectories: model.excludedDirectories });
            const includedPaths = discovery.repositories.filter((path) => !isDirectoryExcluded(path, model.excludedDirectories));
            let groupWarning = "";
            try {
                model.groups = await readGroups(options.groupsPath);
            } catch (error) {
                groupWarning = `Cannot read groups: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (fetchRemotes) {
                const results = await fetch(includedPaths);
                model.allRepositories = results.map((result) => result.repository);
                const failures = results.filter((result) => !result.ok).length;
                model.notification = failures > 0
                    ? `Fetch finished with ${failures} failure${failures === 1 ? "" : "s"}.`
                    : "Remote state fetched.";
            } else {
                model.allRepositories = await inspect(includedPaths);
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

    const markedRepositories = () => model.repositories.filter((repository) => model.markedPaths.includes(repository.path));
    const actionRepositories = () => model.markedPaths.length ? markedRepositories()
        : model.repositories[model.selectedIndex] ? [model.repositories[model.selectedIndex]] : [];

    const fetchMarked = async () => {
        model.busy = true;
        model.activity = "Fetching marked repositories";
        model.notification = "";
        draw();
        try {
            model.excludedDirectories = await readExclusions(options.exclusionsPath);
            applyGroupFilter();
            const targets = markedRepositories();
            const results = await fetch(targets.map((repository) => repository.path));
            for (const result of results) replaceRepository(result.repository);
            const failed = results.filter((result) => !result.ok).length;
            model.notification = `Selection fetch: ${results.length - failed} fetched, ${failed} failed.`;
        } catch (error) {
            model.notification = `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const pullSelected = async () => {
        if (model.markedPaths.length) {
            const targets = markedRepositories();
            const waiting = targets.filter((repository) => repository.needsPull).length;
            if (!waiting) {
                model.notification = "Marked repositories have no waiting updates.";
                draw();
                return;
            }
            model.modal = {
                kind: "confirm",
                compactTitle: `Pull ${waiting} waiting updates in ${targets.length} marked repositories? Continue?`,
                title: `Pull ${waiting} waiting updates in ${targets.length} marked repositories? ${targets.map((repository) => repository.name).join(", ")}. Each repository is checked before a fast-forward pull. Do you want to continue?`,
                submit: () => pullTargets(targets, "Selection pull"),
            };
            draw();
            return;
        }
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
            const result = await pull(selected.path, { exclusionsPath: options.exclusionsPath });
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

    const stashMarked = async (targets) => {
        model.busy = true;
        model.activity = "Stashing marked repositories";
        draw();
        let stashed = 0;
        let blocked = 0;
        let failed = 0;
        try {
            for (const repository of targets) {
                try {
                    const result = await stashChanges(repository.path, { confirmed: true, exclusionsPath: options.exclusionsPath });
                    replaceRepository(result.repository);
                    if (result.ok) stashed += 1;
                    else if (result.blocked) blocked += 1;
                    else failed += 1;
                } catch {
                    failed += 1;
                }
            }
            model.notification = `Selection stash: ${stashed} stashed, ${blocked} blocked, ${failed} failed. Recover with git stash list in each repository.`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const confirmStashChanges = () => {
        if (model.markedPaths.length) {
            const targets = markedRepositories();
            model.notification = "";
            model.modal = {
                kind: "confirm",
                compactTitle: `Stash all edits + untracked files in ${targets.length} marked repositories? Continue?`,
                title: `Stash changes in ${targets.length} marked repositories? ${targets.map((repository) => repository.name).join(", ")}. All staged edits, unstaged edits, and untracked files will be saved in each repository's Git stash and cleared from its working tree. Commits and ignored files stay. Do you want to continue?`,
                submit: () => stashMarked(targets),
            };
            draw();
            return;
        }
        const repository = model.repositories[model.selectedIndex];
        if (!repository || !repository.dirty || repository.conflicts > 0) {
            model.notification = !repository ? "Select a repository to stash changes."
                : repository.conflicts > 0 ? "Resolve conflicts before stashing changes."
                : "There are no uncommitted changes to stash.";
            draw();
            return;
        }
        model.notification = "";
        model.modal = {
            kind: "confirm",
            compactTitle: `Stash all edits + untracked files in ${repository.name}? Clears working tree. Continue?`,
            title: `Stash changes in ${repository.name}? Do you want to continue?\nAll staged edits, unstaged edits, and untracked files will be saved in a Git stash and cleared from the working tree. Commits and ignored files stay.\n${repository.path}`,
            submit: async () => {
                model.busy = true;
                model.activity = `Stashing edits in ${repository.name}`;
                draw();
                try {
                    const result = await stashChanges(repository.path, { confirmed: true, exclusionsPath: options.exclusionsPath });
                    replaceRepository(result.repository);
                    model.notification = `${result.ok ? "Stashed" : result.blocked ? "Blocked" : "Failed"}: ${result.message}`;
                } catch (error) {
                    model.notification = `Stash failed: ${error instanceof Error ? error.message : String(error)}`;
                } finally {
                    model.busy = false;
                    model.activity = "";
                    draw();
                }
            },
        };
        draw();
    };

    const pullTargets = async (targets, label) => {
        model.busy = true;
        model.activity = label;
        draw();
        try {
            const outcome = await pullGroup(targets, {
                pullRepository: (path) => pull(path, { exclusionsPath: options.exclusionsPath }),
            });
            for (const result of outcome.results) replaceRepository(result.repository);
            model.notification = `${label}: ${outcome.updated} updated, ${outcome.blocked} blocked, ${outcome.failed} failed.`;
        } catch (error) {
            model.notification = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };
    const pullActiveGroup = () => pullTargets(model.repositories, "Group pull");

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

    const changeExclusions = async (change, message) => {
        model.busy = true;
        model.activity = "Saving excluded directories";
        draw();
        try {
            const latest = await readExclusions(options.exclusionsPath);
            model.excludedDirectories = await writeExclusions(await change(latest), options.exclusionsPath);
            applyGroupFilter();
            await load(false);
            model.notification = `${message} ${model.notification}`;
        } catch (error) {
            model.notification = `Cannot save excluded directories: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const hideSelectedRepository = () => {
        const targets = actionRepositories();
        if (!targets.length) {
            model.notification = "Select a repository to hide.";
            draw();
            return;
        }
        const repository = targets[0];
        model.modal = {
            kind: "confirm",
            compactTitle: targets.length > 1 ? `Hide ${targets.length} marked repositories? Files stay on disk. Continue?` : undefined,
            title: targets.length > 1 ? `Hide ${targets.length} marked repositories from Autopull? ${targets.map((repository) => repository.path).join(", ")}. Directories, files, and group membership stay. Do you want to continue?`
                : `Hide ${repository.path} from Autopull? Its directory and files stay on disk. Press Ctrl+A then h later to edit or restore it.`,
            submit: () => changeExclusions((directories) => [...directories, ...targets.map((repository) => repository.path)], `${targets.length === 1 ? repository.name : `${targets.length} repositories`} hidden. Press Ctrl+A then h to restore it.`),
        };
        draw();
    };

    const openExclusions = async () => {
        model.busy = true;
        model.activity = "Loading hidden directories";
        model.notification = "";
        draw();
        try {
            model.excludedDirectories = await readExclusions(options.exclusionsPath);
            if (!active) return;
            applyGroupFilter();
            model.view = "exclusions";
        } catch (error) {
            model.notification = error instanceof Error ? error.message : String(error);
        } finally {
            model.busy = false;
            model.activity = "";
            draw();
        }
    };

    const editExcludedDirectory = (adding = false) => {
        const previous = adding ? null : model.excludedDirectories[model.excludedIndex];
        if (!adding && !previous) return;
        model.modal = {
            kind: "input", heading: "excluded directory", value: previous ?? "",
            title: "Enter a directory to hide from Autopull, including its repositories. Paths can be absolute, relative, or ~/path. Files stay on disk.",
            submit: (value) => changeExclusions(async (directories) => {
                const path = await canonicalDirectory(value);
                if (previous && !directories.includes(previous)) throw new Error("This exclusion changed. Reopen the hidden directories list before editing it.");
                return previous ? directories.map((current) => current === previous ? path : current) : [...directories, path];
            }, "Excluded directory saved."),
        };
        draw();
    };

    const restoreExcludedDirectory = () => {
        const path = model.excludedDirectories[model.excludedIndex];
        if (!path) return;
        void changeExclusions((directories) => directories.filter((directory) => directory !== path), `Exclusion removed: ${path}.`);
    };

    const changeRootFolder = () => {
        model.modal = {
            kind: "input",
            heading: "root folder",
            title: `Current roots: ${model.roots.join(" · ")}\nEnter a new root folder (absolute, relative, or ~/path). Applies to this session.`,
            value: "",
            submit: (value) => load(false, value),
        };
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
            clearTimeout(animationTimer);
            input.off("keypress", onKeypress);
            output.off?.("resize", onResize);
            if (!wasRaw) input.setRawMode(false);
            if (wasPaused) input.pause();
            output.write(LEAVE_ALTERNATE_SCREEN);
            resolve(0);
        };

        const onResize = () => draw();

        const openAgent = async (agent, repository) => {
            if (!active) return;
            model.modal = null;
            model.busy = true;
            suspended = true;
            clearTimeout(animationTimer);
            input.off("keypress", onKeypress);
            output.off?.("resize", onResize);
            input.setRawMode(false);
            input.pause?.();
            output.write(`${ANSI_RESET}${LEAVE_ALTERNATE_SCREEN}`);
            let message;
            try {
                const result = await launchAgent(agent, repository.path);
                message = result.code === 0 ? `${agent.name} closed.`
                    : `${agent.name} exited with ${result.signal ?? result.code}.`;
            } catch (error) {
                message = `Cannot open ${agent.name}: ${error instanceof Error ? error.message : String(error)}`;
            } finally {
                suspended = false;
                output.write(ENTER_ALTERNATE_SCREEN);
                input.setRawMode(true);
                input.resume();
                input.on("keypress", onKeypress);
                output.on?.("resize", onResize);
            }
            await load(false);
            model.notification = `${message} ${model.notification}`;
            draw();
        };

        const openCustomAgent = (repository) => {
            model.modal = {
                kind: "input",
                heading: "coding CLI",
                submitLabel: "open",
                title: "Enter a CLI command, including any arguments. Quote paths with spaces. Example: kiro-cli chat",
                value: "",
                submit: async (value) => {
                    model.busy = true;
                    model.activity = "Finding CLI";
                    draw();
                    try {
                        const agent = await resolveAgent(value);
                        if (!active) return;
                        await openAgent(agent, repository);
                    } catch (error) {
                        model.notification = error instanceof Error ? error.message : String(error);
                    } finally {
                        model.busy = false;
                        model.activity = "";
                        draw();
                    }
                },
            };
            draw();
        };

        const openFixPicker = async () => {
            const repository = model.repositories[model.selectedIndex];
            if (!repository) {
                model.notification = "Select a repository to fix.";
                draw();
                return;
            }
            model.busy = true;
            model.activity = "Finding coding CLIs";
            model.notification = "";
            draw();
            try {
                const agents = await findAgents();
                if (!active) return;
                model.modal = {
                    kind: "agents", repository, selectedIndex: 0,
                    agents: [...agents, { name: "Other CLI…" }],
                };
            } catch (error) {
                model.notification = `Cannot find coding CLIs: ${error instanceof Error ? error.message : String(error)}`;
            } finally {
                model.busy = false;
                model.activity = "";
                draw();
            }
        };

        const handleModalKey = (text, key) => {
            if (!model.modal) return false;
            const modal = model.modal;
            if (modal.kind === "agents") {
                const action = tuiActionForKey(key);
                if (action === "up" || action === "down") {
                    modal.selectedIndex = Math.max(0, Math.min(modal.agents.length - 1,
                        modal.selectedIndex + (action === "up" ? -1 : 1)));
                    draw();
                } else if (action === "back" || action === "quit") {
                    model.modal = null;
                    draw();
                } else if (action === "enter") {
                    const agent = modal.agents[modal.selectedIndex];
                    model.modal = null;
                    if (agent.executable) void openAgent(agent, modal.repository);
                    else openCustomAgent(modal.repository);
                }
                return true;
            }
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
                : model.view === "members" ? "memberIndex" : model.view === "exclusions" ? "excludedIndex" : "selectedIndex";
            const length = model.view === "groups"
                ? model.groups.length + 1
                : model.view === "members" ? model.allRepositories.length
                    : model.view === "exclusions" ? model.excludedDirectories.length : model.repositories.length;
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
            if (action === "prefix") {
                if (model.view === "repositories") {
                    model.prefixArmed = true;
                    model.notification = "";
                    draw();
                }
                return;
            }
            if (model.view === "repositories") {
                if (model.prefixArmed) {
                    model.prefixArmed = false;
                    if (!PREFIX_ACTIONS.has(action)) {
                        model.notification = action === "back" ? "" : "Command canceled.";
                        draw();
                        return;
                    }
                } else if (PREFIX_ACTIONS.has(action)) {
                    model.notification = "Press Ctrl+A first for more commands.";
                    draw();
                    return;
                }
            }
            if (action === "up") {
                moveSelection(-1);
            } else if (action === "down") {
                moveSelection(1);
            } else if (action === "back") {
                if (model.view === "members") model.view = "groups";
                else if (model.view === "groups" || model.view === "exclusions") model.view = "repositories";
                else {
                    finish();
                    return;
                }
                model.notification = "";
                draw();
            } else if (action === "exclusions") {
                void openExclusions();
            } else if (model.view === "exclusions" && (action === "enter" || action === "fetch" && key.name === "r")) {
                restoreExcludedDirectory();
            } else if (model.view === "exclusions" && action === "edit") {
                editExcludedDirectory();
            } else if (model.view === "exclusions" && action === "new") {
                editExcludedDirectory(true);
            } else if (model.view === "groups" && action === "new") {
                createRepositoryGroup();
            } else if (model.view === "groups" && action === "edit") {
                openMembershipEditor();
            } else if (model.view === "groups" && action === "fetch" && key.name === "r") {
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
            } else if (action === "fetch") {
                if (model.markedPaths.length) void fetchMarked();
                else void load(true);
            } else if (action === "toggle") {
                const path = model.repositories[model.selectedIndex]?.path;
                if (path) model.markedPaths = model.markedPaths.includes(path)
                    ? model.markedPaths.filter((marked) => marked !== path) : [...model.markedPaths, path];
                model.notification = "";
                draw();
            } else if (action === "select-all") {
                model.markedPaths = model.repositories.map((repository) => repository.path);
                model.notification = "";
                draw();
            } else if (action === "clear-selection") {
                model.markedPaths = [];
                model.notification = "";
                draw();
            } else if (action === "root") {
                changeRootFolder();
            } else if (action === "fix") {
                void openFixPicker();
            } else if (action === "stash") {
                confirmStashChanges();
            } else if (action === "delete") {
                hideSelectedRepository();
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
