import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEditorSettings } from "../../src/lib/ai-edition/store/editorSettings";
import { DEFAULT_PROJECT_APPEARANCE } from "../../src/lib/projectDefaults";
import { DocumentService } from "./document-service";

const dirs: string[] = [];
function temp() {
	const root = mkdtempSync(path.join(os.tmpdir(), "openscreen-default-doc-"));
	dirs.push(root);
	return root;
}
afterEach(() => {
	for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DocumentService project appearance defaults", () => {
	it("materializes the current defaults before the new project's first write", async () => {
		const root = temp();
		const projects = path.join(root, "projects");
		const service = new DocumentService(projects, path.join(root, "media"), undefined, () => ({
			...DEFAULT_PROJECT_APPEARANCE,
			wallpaper: "#123456",
			padding: 22,
		}));
		const created = await service.createProject("New recording or CLI project");
		const onDisk = JSON.parse(
			readFileSync(path.join(projects, `${created.project.id}.openscreen`), "utf8"),
		);
		expect(getEditorSettings(onDisk)).toMatchObject({ wallpaper: "#123456", padding: 22 });
		expect(onDisk.assets).toEqual([]);
		expect(onDisk.annotations).toEqual([]);
	});

	it("never reapplies changed defaults while opening an existing project", async () => {
		const root = temp();
		let padding = 11;
		const service = new DocumentService(
			path.join(root, "projects"),
			path.join(root, "media"),
			undefined,
			() => ({ ...DEFAULT_PROJECT_APPEARANCE, padding }),
		);
		const created = await service.createProject("Existing");
		padding = 44;
		const reopened = await service.getProject(created.project.id);
		expect(getEditorSettings(reopened).padding).toBe(11);
	});
});
