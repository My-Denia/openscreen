import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMainLocale, listMainLocales, mainT, setMainLocale } from "./i18n";

const localeRoot = resolve(process.cwd(), "src/i18n/locales");

function localeDirectories(): string[] {
	const dirs = readdirSync(localeRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	if (dirs.length < 1) {
		throw new Error(`locale directory listing at ${localeRoot} was empty`);
	}
	return dirs;
}

describe("main-process locale map", () => {
	afterEach(() => {
		setMainLocale("en");
	});

	it("covers every locale directory on disk", () => {
		const onDisk = localeDirectories();
		expect(onDisk.length).toBeGreaterThanOrEqual(13);
		expect([...listMainLocales()].sort()).toEqual(onDisk);
	});

	it("renders pt-BR main-process strings instead of falling back to English", () => {
		expect(mainT("common", "actions.open")).toBe("Open");
		setMainLocale("pt-BR");
		expect(getMainLocale()).toBe("pt-BR");
		expect(mainT("common", "actions.open")).toBe("Abrir");
		expect(mainT("common", "actions.quit")).toBe("Sair");
	});

	it("ignores an unknown locale instead of throwing", () => {
		setMainLocale("not-a-locale");
		expect(getMainLocale()).toBe("en");
	});
});
