import * as Gtk from "@gtkx/gi/gtk";
import { GtkApplication, GtkApplicationWindow, GtkBox, GtkButton, GtkLabel, GtkScrolledWindow } from "@gtkx/jsx/gtk";
import { quit } from "@gtkx/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    defaultRepositoryRoots,
    pullRepository,
    refreshRepositories,
    scanRepositories,
    type Repository,
    type Summary,
} from "./autopull-client.js";

const emptySummary: Summary = {
    total: 0,
    current: 0,
    updatesReady: 0,
    dirty: 0,
    conflicts: 0,
    errors: 0,
};

const workingTreeLabel = (repository: Repository) => {
    if (repository.conflicts > 0) return `${repository.conflicts} conflict${repository.conflicts === 1 ? "" : "s"}`;
    const changes = repository.staged + repository.modified + repository.untracked;
    return changes > 0 ? `${changes} change${changes === 1 ? "" : "s"}` : "Clean";
};

const remoteLabel = (repository: Repository) => {
    if (!repository.upstream) return "No upstream";
    if (repository.diverged) return `Ahead ${repository.ahead}, behind ${repository.behind}`;
    if (repository.behind > 0) return `Behind ${repository.behind}`;
    if (repository.ahead > 0) return `Ahead ${repository.ahead}`;
    return "Current";
};

const actionLabel = (repository: Repository, pulling: boolean) => {
    if (pulling) return "Updating…";
    if (repository.conflicts > 0) return "Resolve";
    if (!repository.canPull) return "Blocked";
    if (repository.needsPull) return "Update";
    return "Check & update";
};

const stateClasses = (repository: Repository) => {
    if (repository.conflicts > 0) return ["error", "heading"];
    if (repository.dirty || repository.diverged) return ["warning", "heading"];
    return ["dim-label"];
};

type RepositoryRowProps = {
    repository: Repository;
    selected: boolean;
    pulling: boolean;
    onSelect: () => void;
    onPull: () => void;
};

const RepositoryRow = ({ repository, selected, pulling, onSelect, onPull }: RepositoryRowProps) => (
    <GtkBox
        orientation={Gtk.Orientation.HORIZONTAL}
        spacing={12}
        marginTop={7}
        marginBottom={7}
        marginStart={12}
        marginEnd={12}
        cssClasses={selected ? ["card"] : []}
    >
        <GtkButton
            label={`${repository.name}\n${repository.branch ?? "Detached HEAD"}`}
            onClicked={onSelect}
            cssClasses={["flat"]}
            hexpand
            halign={Gtk.Align.FILL}
        />
        <GtkLabel
            label={workingTreeLabel(repository)}
            widthChars={13}
            xalign={0}
            cssClasses={stateClasses(repository)}
        />
        <GtkLabel label={remoteLabel(repository)} widthChars={18} xalign={0} />
        <GtkButton
            label={actionLabel(repository, pulling)}
            onClicked={onPull}
            sensitive={repository.canPull && !pulling}
            widthRequest={126}
            cssClasses={repository.needsPull && repository.canPull ? ["suggested-action"] : []}
        />
    </GtkBox>
);

const SummaryBar = ({ summary }: { summary: Summary }) => (
    <GtkBox
        orientation={Gtk.Orientation.HORIZONTAL}
        spacing={8}
        marginTop={12}
        marginBottom={12}
        marginStart={16}
        marginEnd={16}
    >
        <GtkLabel label={`${summary.total} repositories`} cssClasses={["heading"]} />
        <GtkLabel label={`· ${summary.current} current`} />
        <GtkLabel label={`· ${summary.updatesReady} updates`} />
        <GtkLabel label={`· ${summary.dirty} local changes`} />
        <GtkLabel label={`· ${summary.conflicts} conflicts`} />
        {summary.errors > 0 && <GtkLabel label={`· ${summary.errors} errors`} cssClasses={["error"]} />}
    </GtkBox>
);

const DetailPanel = ({ repository, message }: { repository: Repository | null; message: string | null }) => {
    if (!repository) {
        return (
            <GtkBox
                orientation={Gtk.Orientation.VERTICAL}
                spacing={8}
                marginTop={32}
                marginStart={24}
                marginEnd={24}
                widthRequest={360}
            >
                <GtkLabel label="Select a repository" cssClasses={["title-3"]} />
                <GtkLabel label="Its branch, upstream, changed files, and safe next action will appear here." wrap />
            </GtkBox>
        );
    }

    const changedFiles = repository.changedFiles.slice(0, 8);
    const reason = repository.blockers.length > 0
        ? `Update blocked: ${repository.blockers.join("; ")}.`
        : repository.needsPull
            ? "This repository is clean and can be fast-forwarded."
            : "This repository is safe to check for remote updates.";

    return (
        <GtkBox
            orientation={Gtk.Orientation.VERTICAL}
            spacing={10}
            marginTop={20}
            marginBottom={20}
            marginStart={20}
            marginEnd={20}
            widthRequest={380}
            valign={Gtk.Align.START}
        >
            <GtkLabel label={repository.name} cssClasses={["title-2"]} xalign={0} />
            <GtkLabel label={repository.path} cssClasses={["dim-label"]} xalign={0} wrap />
            <GtkLabel label={reason} cssClasses={repository.canPull ? ["card"] : ["card", "warning"]} xalign={0} wrap />
            {message && <GtkLabel label={message} cssClasses={["card"]} xalign={0} wrap />}
            <GtkLabel label={`Branch: ${repository.branch ?? "Detached HEAD"}`} xalign={0} />
            <GtkLabel label={`Upstream: ${repository.upstream ?? "None"}`} xalign={0} />
            <GtkLabel label={`Remote: ${remoteLabel(repository)}`} xalign={0} />
            <GtkLabel label="Changed files" cssClasses={["heading"]} xalign={0} marginTop={8} />
            {changedFiles.length === 0
                ? <GtkLabel label="None" cssClasses={["dim-label"]} xalign={0} />
                : changedFiles.map((file) => (
                    <GtkLabel
                        key={`${file.kind}:${file.path}`}
                        label={`${file.kind === "untracked" ? "??" : file.kind === "conflict" ? "UU" : "M "} ${file.path}`}
                        xalign={0}
                    />
                ))}
            {repository.changedFiles.length > changedFiles.length && (
                <GtkLabel label={`+ ${repository.changedFiles.length - changedFiles.length} more`} cssClasses={["dim-label"]} xalign={0} />
            )}
            <GtkLabel
                label={`CLI: autopull status ${JSON.stringify(repository.path)}`}
                cssClasses={["dim-label"]}
                xalign={0}
                wrap
                marginTop={8}
            />
        </GtkBox>
    );
};

const MainWindow = () => {
    const roots = useMemo(defaultRepositoryRoots, []);
    const [repositories, setRepositories] = useState<Repository[]>([]);
    const [summary, setSummary] = useState<Summary>(emptySummary);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullingPath, setPullingPath] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [lastScan, setLastScan] = useState<string | null>(null);

    const scan = useCallback(async () => {
        setLoading(true);
        setError(null);
        setMessage(null);

        try {
            const document = await scanRepositories(roots);
            setRepositories(document.repositories);
            setSummary(document.summary);
            setLastScan(new Date(document.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
            setSelectedPath((current) => current && document.repositories.some((repository) => repository.path === current)
                ? current
                : document.repositories[0]?.path ?? null);
            if (document.discoveryErrors?.length) {
                setMessage(`${document.discoveryErrors.length} configured path${document.discoveryErrors.length === 1 ? " was" : "s were"} not readable.`);
            }
        } catch (scanError) {
            setError(scanError instanceof Error ? scanError.message : String(scanError));
        } finally {
            setLoading(false);
        }
    }, [roots]);

    useEffect(() => {
        void scan();
    }, [scan]);

    const selected = repositories.find((repository) => repository.path === selectedPath) ?? null;

    const refresh = async () => {
        setRefreshing(true);
        setError(null);
        setMessage(null);

        try {
            const document = await refreshRepositories(roots);
            setRepositories(document.repositories);
            setSummary(document.summary);
            setLastScan(new Date(document.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
            const failures = document.refreshResults?.filter((result) => !result.ok) ?? [];
            const firstFailure = failures[0];
            const failed = failures.length;
            setMessage(failed > 0
                ? `${failed} remote refresh${failed === 1 ? "" : "es"} failed. ${firstFailure.repository.name}: ${firstFailure.message}`
                : "Remote state is current.");
        } catch (refreshError) {
            setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        } finally {
            setRefreshing(false);
        }
    };

    const update = async (repository: Repository) => {
        setPullingPath(repository.path);
        setError(null);
        setMessage(null);

        try {
            const document = await pullRepository(repository.path);
            await scan();
            setSelectedPath(repository.path);
            setMessage(document.result.message);
        } catch (pullError) {
            setError(pullError instanceof Error ? pullError.message : String(pullError));
        } finally {
            setPullingPath(null);
        }
    };

    return (
        <GtkApplicationWindow
            title="Autopull"
            defaultWidth={1120}
            defaultHeight={720}
            onCloseRequest={quit}
        >
            <GtkBox orientation={Gtk.Orientation.VERTICAL}>
                <GtkBox
                    orientation={Gtk.Orientation.HORIZONTAL}
                    spacing={12}
                    marginTop={14}
                    marginBottom={14}
                    marginStart={16}
                    marginEnd={16}
                >
                    <GtkBox orientation={Gtk.Orientation.VERTICAL} spacing={2} hexpand>
                        <GtkLabel label="Autopull" cssClasses={["title-1"]} xalign={0} />
                        <GtkLabel label={roots.join(" · ")} cssClasses={["dim-label"]} xalign={0} />
                    </GtkBox>
                    <GtkLabel label={lastScan ? `Last scan: ${lastScan}` : "Not scanned yet"} cssClasses={["dim-label"]} />
                    <GtkButton
                        label={refreshing ? "Refreshing…" : "Refresh remotes"}
                        onClicked={() => void refresh()}
                        sensitive={!loading && !refreshing}
                    />
                    <GtkButton
                        label={loading ? "Scanning…" : "Scan again"}
                        onClicked={() => void scan()}
                        sensitive={!loading}
                        cssClasses={["suggested-action"]}
                    />
                </GtkBox>

                <SummaryBar summary={summary} />
                {error && (
                    <GtkLabel
                        label={`Could not scan repositories: ${error}`}
                        cssClasses={["error", "card"]}
                        wrap
                        marginStart={16}
                        marginEnd={16}
                    />
                )}
                {loading && repositories.length === 0 && <GtkLabel label="Scanning configured folders…" marginTop={40} />}
                {!loading && repositories.length === 0 && !error && (
                    <GtkLabel label="No Git repositories found. Set AUTOPULL_ROOTS or pass folders to the CLI." marginTop={40} wrap />
                )}

                {repositories.length > 0 && (
                    <GtkScrolledWindow vexpand hscrollbarPolicy={Gtk.PolicyType.NEVER}>
                    <GtkBox orientation={Gtk.Orientation.HORIZONTAL} homogeneous>
                        <GtkBox orientation={Gtk.Orientation.VERTICAL} hexpand>
                            <GtkBox
                                orientation={Gtk.Orientation.HORIZONTAL}
                                spacing={12}
                                marginStart={24}
                                marginEnd={12}
                                marginBottom={4}
                            >
                                <GtkLabel label="Repository" cssClasses={["dim-label"]} hexpand xalign={0} />
                                <GtkLabel label="Working tree" cssClasses={["dim-label"]} widthChars={13} xalign={0} />
                                <GtkLabel label="Remote" cssClasses={["dim-label"]} widthChars={18} xalign={0} />
                                <GtkLabel label="Action" cssClasses={["dim-label"]} widthChars={14} xalign={0} />
                            </GtkBox>
                            {repositories.map((repository) => (
                                <RepositoryRow
                                    key={repository.path}
                                    repository={repository}
                                    selected={repository.path === selectedPath}
                                    pulling={repository.path === pullingPath}
                                    onSelect={() => {
                                        setSelectedPath(repository.path);
                                        setMessage(null);
                                    }}
                                    onPull={() => void update(repository)}
                                />
                            ))}
                        </GtkBox>
                        <DetailPanel repository={selected} message={message} />
                    </GtkBox>
                    </GtkScrolledWindow>
                )}
            </GtkBox>
        </GtkApplicationWindow>
    );
};

export const App = () => (
    <GtkApplication>
        <MainWindow />
    </GtkApplication>
);

export default App;
