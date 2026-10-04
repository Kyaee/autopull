# Autopull

Autopull scans local Git repositories, shows which ones have personal changes or remote updates, and blocks unsafe pulls. It includes a terminal interface and a native GTK4 dashboard powered by the same versioned JSON protocol.

## Safety model

- `scan` is read-only. It reports against the remote-tracking state already stored by Git.
- `fetch` runs `git fetch --prune` to update remote-tracking metadata. It does not change working trees.
- `pull` is explicit and targets one repository. It runs `git pull --ff-only` only when the repository has an upstream and no local changes, conflicts, detached HEAD, or divergence.
- Git commands receive argument arrays, so repository paths are never interpolated into a shell command.

## Requirements

- Linux with Git and GTK4
- Node.js and pnpm
- GTK development metadata for GTKX code generation

On Fedora:

```sh
sudo dnf install gtk4-devel
```

The project includes a compatibility pkg-config entry because current GTKX releases query Fedora's older `gobject-introspection-1.0` package name.

## Terminal UI

Install dependencies, then open the interactive dashboard:

```sh
pnpm install
pnpm autopull
```

The dashboard uses rounded panels, colored state meters, and a highlighted repository selection. At 120 columns or wider, repository details sit beside the list; smaller terminals stack the panels. `NO_COLOR=1` disables colors while preserving the selection highlight. Each repository row shows its current branch, worktree state, and remote state. Use `j` or the up arrow to move up, and `k` or the down arrow to move down. Press `f` to fetch remote state, `p` to fast-forward the selected repository when it is safe, and `q` to exit. The previous `r` fetch shortcut still works in the repository view; in the group screen, `r` renames a group.

Select a repository and press `i` to open its full local diff in a centered, scrollable panel. It includes staged, unstaged, conflict, and untracked-file changes. Press `x` in the diff panel to choose a scanned coding CLI and edit the repository interactively; Autopull rescans and reopens the updated diff when the agent exits. Use the arrows or `j`/`k` to scroll, and Escape to close the panel.

Press **/** to focus the separate blue search panel above the overview. Results update as you type, matching repository names, paths, or branches without case sensitivity within the current group. Enter applies the filter; Escape cancels editing and restores the previous query, cursor, and selections. Ctrl+U clears the input while editing. Once a filter is applied, Escape clears it and returns to the full group. Selections follow the matching results, so batch actions use matching marked repositories. Scans retain the query; changing the root folder clears it. Short terminals omit the state meters to keep the search panel, repository list, and controls visible.

Press **Ctrl+A** (hold Control and press A), release it, then press one command key: `s` scan, `b` branch, `x` fix, `z` stash, `d` hide, `h` hidden directories, `g` groups, or `o` root folder. `a` pulls the active group and appears when a group is selected. `v` selects all visible repositories; when they are all selected, the menu changes to `v unselect all` and the same shortcut clears them. `c` also clears the selection. The options appear in a floating blue panel above the controls without shifting the dashboard. The panel wraps in narrow terminals and uses bold text with `NO_COLOR`. The prefix applies to one command; Escape or an unknown key cancels it. Group, hidden-directory, agent, and branch screens keep their own single-key controls.

Press **Ctrl+A**, then `b`, to change the highlighted repository's branch, including when other repositories are marked. Use `j`/`k` or the arrows to choose a branch, Enter to switch, or Escape to cancel. The picker marks the current branch and shows fetched remote branches that have no matching local branch. Choosing a remote branch creates a local branch with the same name and tracks that remote; existing local branches keep their commits and upstream. Fetch first to update the available remote branches. Stash or commit local changes before switching. Autopull also blocks conflicts, ongoing Git operations, and hidden directories, and protects ignored files from being overwritten.

Press **Space** to mark or unmark the highlighted repository, then move with `j`/`k` or the arrows to mark others. Marked rows show `[x]`, and the overview shows the selected count. With any repositories marked, `f` fetches only those repositories, `p` asks to pull their waiting updates, **Ctrl+A then z** asks to stash their local changes, and **Ctrl+A then d** asks to hide them. Each repository retains its Git safety checks; batch operations continue after individual failures and report counts. Stashes can be recovered using `git stash list` and `git stash apply --index <stash-reference>` in each repository. Without marks, these commands use their usual scope. Marks survive scans while the repositories remain visible; changing the root or filtering repositories out of view removes their marks. Fix still opens the highlighted repository interactively.

Press **Ctrl+A**, then `o`, in the repository view to change the root folder for the current session. Enter an absolute path, a path relative to the launch directory, or a `~/path`, then press Enter to scan it. Escape cancels. Autopull checks the folder before switching, clears the active group filter, and uses the new root for subsequent scans and fetches. The root appears in the overview panel border. Restarting restores the roots supplied at launch.

Repository names are red for errors or conflicts, yellow for other states needing attention, and uncolored when current. Selection remains highlighted, including when `NO_COLOR` is set.

Press **Ctrl+A**, then `z`, to **Stash changes** in the selected repository. Autopull names the repository and asks whether you want to continue; only `y` proceeds, and any other key cancels. This clears uncommitted staged edits, unstaged edits, and untracked files using `git stash push --include-untracked`. Commits and ignored files stay. Conflicts, ongoing Git operations, and submodule changes must be handled separately. The status line shows the recovery command. You can also find the entry named `Autopull: stash local changes` with `git stash list`, then restore it in that repository with `git stash apply --index <stash-reference>`. No pull runs automatically after stashing edits.

Press **Ctrl+A**, then `d`, in the repository view to hide the selected repository from Autopull. Confirm with `y`, or cancel with another key. Its directory, files, and group membership are kept. Hidden directories and their descendants are skipped by scans and fetches and blocked from pulls, including explicit CLI pulls.

Press **Ctrl+A**, then `h`, to manage hidden directories: Enter restores the selected directory, `e` edits its exclusion path, and `n` adds another directory to exclude. Escape returns to the repository list. Exclusions persist across restarts in `~/.config/autopull/exclusions.json`, or the file named by `AUTOPULL_EXCLUSIONS_FILE`. You can also edit this JSON directly; changes take effect on the next scan or fetch, and pulls check it again before proceeding. Remove a path from `directories` to restore it:

```json
{
  "version": 1,
  "directories": ["/home/you/Repos/example"]
}
```

Press **Ctrl+A**, then `x`, to fix the selected repository with an interactive coding agent. Autopull checks PATH for Codex, Claude Code, AGY, Copilot, Kiro CLI, OpenCode, Aider, Gemini CLI, Qwen Code, Amp, Cursor Agent, Droid, and Pi, and lists the installed tools. Use `j`/`k` or the arrows to select one, Enter to open it, or Escape to cancel. Kiro starts with `kiro-cli chat`; the other tools start with their default interactive command. You enter your own instructions in the agent session.

Choose “Other CLI…” to launch another executable, optionally with arguments, such as `my-agent chat`. Quote paths or arguments containing spaces. Commands run directly without shell expansion. The tool opens in the selected repository using its normal permissions. When it exits, Autopull restores the terminal dashboard and rescans the current roots.

Press **Ctrl+A**, then `g`, to manage repository groups. The group screen can create, rename, delete, and edit group membership. Select a group to filter the dashboard, then press **Ctrl+A**, followed by `a`, to pull every repository in that group with a waiting update. Autopull asks for confirmation and checks each repository again before running `git pull --ff-only`. Group definitions are stored in `~/.config/autopull/groups.json`. Set `AUTOPULL_GROUPS_FILE` to use another file.

Pass roots after the explicit `tui` command when you do not want the configured defaults:

```sh
pnpm autopull -- tui ~/Repos ~/work --max-depth 4
```

## Scriptable commands

The non-interactive commands remain available for scripts and for the GTK app:

```sh
pnpm install
pnpm autopull -- scan ~/Repos
pnpm autopull -- fetch ~/Repos
pnpm autopull -- status ~/Repos/example
pnpm autopull -- pull ~/Repos/example
```

Add `--json` to any command for the protocol consumed by the GTK app. `scan` and `fetch` accept `--max-depth N`; the default is four directory levels. `refresh` remains an alias for `fetch` and preserves its existing JSON response for compatibility with the GTK app and older scripts.

With no scan roots, Autopull uses `AUTOPULL_ROOTS`, split on `:`, then falls back to `~/Repos` or the current directory.

```sh
AUTOPULL_ROOTS="$HOME/Repos:$HOME/work" pnpm autopull -- scan
```

The package also exposes `cli/autopull.mjs` through its `autopull` bin entry for local package links or future releases.

## GTK app

```sh
pnpm codegen
pnpm dev
```

The app scans the same default roots as the CLI. Set `AUTOPULL_ROOTS` before starting it to choose different folders. “Scan again” reads local state, “Refresh remotes” fetches metadata, and each repository row enables an update only when the CLI marks it safe.

Build the production GTKX bundle with:

```sh
pnpm build
pnpm start
```

## Checks

```sh
pnpm test:cli
pnpm typecheck
pnpm test
pnpm build
```

The GTK test runner uses a headless Wayland compositor and expects `sway` or a configured `weston` installation.
