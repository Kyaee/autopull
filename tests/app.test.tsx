import * as Gtk from "@gtkx/gi/gtk";
import { rootElement } from "@gtkx/react";
import { render, screen } from "@gtkx/testing";
import { describe, expect, it } from "vitest";
import App from "../src/app.js";

describe("App", () => {
    it("renders the repository scanner", async () => {
        process.env.AUTOPULL_ROOTS = process.cwd();
        await render(<App />, { container: rootElement });
        const button = await screen.findByRole(Gtk.AccessibleRole.BUTTON, { name: "Scan again" });
        expect(button).toBeDefined();
    });
});
