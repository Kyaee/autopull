import { defineConfig } from "@gtkx/config";

export default defineConfig({
    libraries: ["Gtk-4.0"],
    applicationId: "com.autopull.app",
    deploy: {
        name: "Autopull",
        summary: "Safely inspect and update local Git repositories",
        description: [
            "Autopull shows the working-tree and upstream state of local Git repositories before "
            + "running explicit, fast-forward-only updates.",
        ],
        categories: ["Utility"],
    },
});
