# Autopull

Autopull scans local Git repositories, shows which ones have personal changes or remote updates, and blocks unsafe pulls. It includes a terminal interface and a native GTK4 dashboard powered by the same versioned JSON protocol.

## Safety model

- `scan` is read-only. It reports against the remote-tracking state already stored by Git.
- `refresh` runs `git fetch --prune` to update remote-tracking metadata. It does not change working trees.
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

## CLI

Install dependencies, then run the package script:

```sh
pnpm install
pnpm autopull -- scan ~/Repos
pnpm autopull -- refresh ~/Repos
pnpm autopull -- status ~/Repos/example
pnpm autopull -- pull ~/Repos/example
```

Add `--json` to any command for the protocol consumed by the GTK app. `scan` and `refresh` accept `--max-depth N`; the default is four directory levels.

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
