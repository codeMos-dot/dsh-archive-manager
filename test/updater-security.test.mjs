import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PLUGIN_UPDATE_HEADER, registerPluginUpdater } from "../src/plugin-updater.ts";

const root = resolve(import.meta.dirname, "..");
const manifestUrl = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const PACKAGE = manifest.name;
const CURRENT = manifest.version;
const LATEST = "9.9.9";

function verified(version = LATEST) {
  return {
    verified: true,
    packageName: PACKAGE,
    version,
    integrity: "sha512-fixture",
    tarball: `https://registry.npmjs.org/${PACKAGE}/-/fixture.tgz`,
    signerKeyId: "SHA256:fixture",
    provenanceVerified: true,
    provenance: {
      builder: "https://github.com/actions/runner/github-hosted",
      repository: "https://github.com/MichengAI/dsh-archive-manager",
      workflow: ".github/workflows/publish.yml",
      sourceCommit: "0123456789abcdef",
    },
  };
}

function harness({ latest = verified(), verification = verified(), installer } = {}) {
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === "desktopProfiles") return { current: { name: "desktop", dir: root } };
      if (name === "desktopPnpm") return { runPlugin() { throw new Error("installer hook should be used"); } };
      return undefined;
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    logger: { warn() {} },
  };
  const calls = [];
  const securityClient = {
    async latest() { return latest; },
    async verifyVersion(_packageName, version) { calls.push(["verify", version]); return verification; },
  };
  let installAttempts = 0;
  const activeInstaller = async (target, spec) => {
    calls.push(["install", spec]);
    if (installer !== undefined) return installer(target, spec);
    installAttempts += 1;
    if (installAttempts === 1 && spec.endsWith(`@${LATEST}`)) throw new Error("install failed");
  };
  const dispose = registerPluginUpdater(ctx, {
    endpoint: "/api/michengai/dsh-archive-manager/update",
    packageName: PACKAGE,
    manifestUrl,
    securityClient,
    installer: activeInstaller,
  });
  const handler = routes.get("/api/michengai/dsh-archive-manager/update").handler;
  async function post() {
    let statusCode = 0;
    let body = "";
    const request = {
      method: "POST",
      headers: { [PLUGIN_UPDATE_HEADER]: "1", host: "127.0.0.1:19387" },
      socket: { remoteAddress: "127.0.0.1" },
    };
    const response = {
      writeHead(code) { statusCode = code; },
      end(value) { body = typeof value === "string" ? value : ""; },
    };
    await handler(request, response);
    return { statusCode, body: body === "" ? undefined : JSON.parse(body) };
  }
  return { dispose, calls, post };
}

test("更新前必须再次验证精确版本，状态通过也不能跳过 POST 校验", async () => {
  const rejected = { verified: false, packageName: PACKAGE, version: LATEST, code: "invalid-provenance", message: "provenance mismatch", provenanceVerified: false };
  const run = harness({ verification: rejected });
  try {
    const response = await run.post();
    assert.equal(response.statusCode, 503);
    assert.match(response.body.error, /provenance mismatch/);
    assert.deepEqual(run.calls, [["verify", LATEST]]);
  } finally { run.dispose(); }
});

test("状态本身未通过安全校验时不会执行安装", async () => {
  const rejected = { verified: false, packageName: PACKAGE, version: LATEST, code: "invalid-signature", message: "bad signature", provenanceVerified: false };
  const run = harness({ latest: rejected });
  try {
    const response = await run.post();
    assert.equal(response.statusCode, 503);
    assert.match(response.body.error, /bad signature/);
    assert.deepEqual(run.calls, []);
  } finally { run.dispose(); }
});

test("安装前校验返回其他包名或版本时拒绝安装", async () => {
  for (const verification of [
    { ...verified("9.9.8") },
    { ...verified(), packageName: "@michengai/other-plugin" },
  ]) {
    const run = harness({ verification });
    try {
      const response = await run.post();
      assert.equal(response.statusCode, 503);
      assert.match(response.body.error, /不一致/);
      assert.deepEqual(run.calls, [["verify", LATEST]]);
    } finally { run.dispose(); }
  }
});

test("安装失败时自动重新安装当前版本并返回回滚结果", async () => {
  const run = harness();
  try {
    const response = await run.post();
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.rolledBack, true);
    assert.deepEqual(run.calls, [
      ["verify", LATEST],
      ["install", `${PACKAGE}@${LATEST}`],
      ["install", `${PACKAGE}@${CURRENT}`],
    ]);
    assert.match(response.body.error, new RegExp(`已自动回滚到 v${CURRENT.replaceAll(".", "\\.")}`));
  } finally { run.dispose(); }
});

test("成功安装只使用已验证并钉死的精确版本", async () => {
  const run = harness({ installer: async () => {} });
  try {
    const response = await run.post();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(run.calls, [["verify", LATEST], ["install", `${PACKAGE}@${LATEST}`]]);
    assert.equal(response.body.updatedVersion, LATEST);
    assert.equal(response.body.securityVerified, true);
    assert.equal(response.body.provenanceVerified, true);
    assert.equal(response.body.sourceRepository, "https://github.com/MichengAI/dsh-archive-manager");
  } finally { run.dispose(); }
});
