import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("插件列表元信息从 locale 导出，图标文件随包发布", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.exports["./locale/*.json"], "./locale/*.json");
	assert.ok(manifest.files.includes("locale"));
	assert.ok(manifest.files.includes("assets"));
	assert.equal(manifest.icon, "assets/icon.svg");
	await access(new URL("../assets/icon.svg", import.meta.url));
	for (const file of ["en.json", "zh.json"]) {
		const title = "Archive Manager";
		const locale = JSON.parse(await readFile(new URL(`../locale/${file}`, import.meta.url), "utf8"));
		assert.equal(locale.meta.title, title);
		assert.equal(typeof locale.meta.description, "string");
		assert.ok(locale.meta.description.length > 0);
	}
});
