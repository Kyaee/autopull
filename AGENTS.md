<!-- BEGIN:gtkx-agent-rules -->

# GTKX

This is not the GTK you have seen before. Most GTK code in your training data is C, PyGObject, Vala or GJS, and almost none of it is valid here. Check the rules below against what you are about to write.

- Children are JSX, never `.append()`, `pack_start()`, `set_child()` or `add()`.
- Signals are props: `onClicked`, not `widget.connect("clicked", ...)`.
- Props are camelCase: `marginTop`, not `margin-top` or `margin_top`.
- There is no `Gtk.Template`, no `.ui` XML, and no `GtkBuilder`. The JSX tree is the definition.
- Elements come from `@gtkx/jsx/<namespace>` and classes, enums and functions from `@gtkx/gi/<namespace>`. Both are generated for this project by `gtkx codegen`, not installed from npm, so they match the GIR libraries this project declares.

Read `.gtkx/reference/index.md` before writing widget code. It is generated from this project's own GIR libraries and is the authority on which props, signals and methods exist. Do not infer a prop from another toolkit, from a C function name, or from a similar element.

| Command | What it does |
| --- | --- |
| `gtkx dev` | Run the app with fast refresh |
| `gtkx codegen` | Regenerate bindings and this reference |
| `tsc --noEmit` | Typecheck |
| `vitest run` | Run the tests |

Never call UI work done without looking at the running app. With `gtkx dev` up, the gtkx MCP server exposes the live widget tree, queries, clicks and screenshots; use them to confirm the change landed.

This block is written by `gtkx codegen`. Anything outside the markers is yours and is left alone, and committing the block with your work keeps the tree clean.

<!-- END:gtkx-agent-rules -->
