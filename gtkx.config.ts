import { defineConfig } from "@gtkx/config";

export default defineConfig({
    libraries: ["Gtk-4.0"],
    applicationId: "com.autopull.app",
    deploy: {
        name: "Autopull",
        summary: "A GTK4 application built with GTKX",
        description: [
            "Autopull is a GTK4 and Adwaita application built with GTKX, which renders native GObject "
            + "widgets from React. Replace this paragraph with a description of what your application does.",
        ],
        categories: ["Utility"],
    },
});
