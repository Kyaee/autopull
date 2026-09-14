# Design: Autopull

Status: APPROVED  
Mode: Internal developer utility  
Date: 2026-09-14

## Problem

A developer maintaining about ten local repositories currently repeats `cd`, `git status`, `git diff`, `git pull`, and sometimes `git merge` for each repository. A routine check takes 30–40 minutes, and pulling while personal changes are present has already caused a merge conflict.

Autopull should make every repository's update risk visible before changing anything.

## Product boundaries

- Autopull is local and single-user. It sends no repository data elsewhere and stores no Git credentials.
- Discovery searches only explicit paths or configured roots.
- Scanning is read-only. It reports local state against the currently known upstream reference.
- Pulling is always explicit, targets one repository, and uses fast-forward-only behavior.
- Dirty, conflicted, detached, untracked, or diverged repositories explain why an update is blocked.

## Architecture

The CLI is the source of truth. It owns discovery, Git status classification, safe pulling, human-readable output, and a versioned JSON protocol. The GTK app invokes the CLI and renders that protocol. It never reimplements Git rules.

Initial commands:

- `autopull scan [roots...]` discovers and reports repositories.
- `autopull status <repository>` reports one repository.
- `autopull pull <repository>` runs a guarded `git pull --ff-only`.
- `--json` returns the stable protocol used by the GTK app.

Repository results distinguish:

- clean and current
- behind and safe to update
- ahead
- diverged
- modified, staged, or untracked files
- unresolved merge conflicts
- detached HEAD
- missing upstream
- inaccessible or invalid repositories

Git commands must be spawned with argument arrays rather than interpolated shell strings. A failed command returns a structured error and must not crash the full scan.

## GTK workflow

The main window shows configured roots, scan time, summary counts, and repository rows. Each row shows repository, branch, working-tree state, remote state, and the only valid next action.

Selecting a row opens a detail panel with the upstream, ahead/behind counts, changed files, the reason an update is blocked, and the equivalent CLI result. The update button is enabled only when the CLI says the repository is safe.

## Success criteria

- Ten repositories can be scanned in one command and one GTK view.
- A read-only scan does not alter the working tree, index, branch, or remote-tracking references.
- A dirty repository is never pulled.
- A diverged repository is never merged automatically.
- Existing unmerged paths are reported as conflicts.
- GTK and CLI display the same classification from the same JSON response.
- One repository's failure does not hide results for the others.

## Distribution

The first release runs from the checked-out project and exposes the CLI through the package's `bin` entry. GTKX builds the desktop bundle, while the CLI remains a plain Node executable included with the application. Public packaging is deferred until the workflow is proven on the initial ten repositories.

## Implementation order

1. Build and test repository discovery, status parsing, and guarded pull behavior.
2. Add the CLI commands, human output, and versioned JSON output.
3. Replace the GTK starter with the repository dashboard backed by the CLI protocol.
4. Validate failure states and document local installation and use.

## Assignment

Run Autopull against the same ten repositories that caused the 30–40 minute workflow, and record every state it classifies incorrectly or cannot explain.
