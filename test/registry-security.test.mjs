import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { RegistrySecurityClient, REGISTRY_KEYS_URL, REGISTRY_ORIGIN, SLSA_PROVENANCE_V1 } from "../src/registry-security.ts";

const PACKAGE = "@michengai/dsh-archive-manager";
const VERSION = "9.8.7";
const PAYLOAD_TYPE = "application/vnd.in-toto+json";
const KEY_ID = "SHA256:fixture-key";
const NOW = Date.parse("2026-10-26T00:00:00.000Z");
const TARBALL = `https://registry.npmjs.org/${PACKAGE}/-/dsh-archive-manager-${VERSION}.tgz`;
const VERSION_URL = `${REGISTRY_ORIGIN}/${encodeURIComponent(PACKAGE)}/${VERSION}`;
const ATTESTATION_URL = `${REGISTRY_ORIGIN}/-/npm/v1/attestations/${encodeURIComponent(PACKAGE)}@${VERSION}`;

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicDer = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const tarballBytes = Buffer.from("deterministic npm tarball fixture", "utf8");
const integrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
const sha512Hex = createHash("sha512").update(tarballBytes).digest("hex");

function sign(value) {
  return createSign("sha256").update(value).sign(privateKey).toString("base64");
}

function pae(payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(PAYLOAD_TYPE)} ${PAYLOAD_TYPE} ${payload.length} `, "utf8"),
    payload,
  ]);
}

function provenanceBundle(overrides = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/%40michengai/dsh-archive-manager@${VERSION}`, digest: { sha512: sha512Hex } }],
    predicateType: SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: "https://github.com/MichengAI/dsh-archive-manager", path: ".github/workflows/publish.yml", ref: `refs/tags/v${VERSION}` } },
        resolvedDependencies: [{ uri: `git+https://github.com/MichengAI/dsh-archive-manager@refs/tags/v${VERSION}`, digest: { gitCommit: "0123456789abcdef" } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
    ...overrides.statement,
  };
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      publicKey: { rawBytes: publicDer },
      tlogEntries: [{ integratedTime: "1700000000", logId: { keyId: "rekor-fixture" }, inclusionPromise: { signedEntryTimestamp: "fixture" } }],
    },
    dsseEnvelope: {
      payloadType: PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signatures: [{ sig: overrides.signature ?? sign(pae(payload)), keyid: "" }],
    },
  };
}

function registryFixture(overrides = {}) {
  const packageSignature = overrides.packageSignature ?? sign(`${PACKAGE}@${VERSION}:${overrides.integrity ?? integrity}`);
  const metadata = {
    name: PACKAGE,
    version: VERSION,
    dist: {
      integrity: overrides.integrity ?? integrity,
      tarball: overrides.tarball ?? TARBALL,
      signatures: [{ keyid: KEY_ID, sig: packageSignature }],
      attestations: {
        url: overrides.attestationUrl ?? ATTESTATION_URL,
        provenance: { predicateType: overrides.predicateType ?? SLSA_PROVENANCE_V1 },
      },
    },
  };
  const keys = {
    keys: [{
      keyid: KEY_ID,
      keytype: "ecdsa-sha2-nistp256",
      scheme: "ecdsa-sha2-nistp256",
      key: publicDer,
      expires: overrides.keyExpires === undefined ? null : overrides.keyExpires,
    }],
  };
  const attestations = overrides.attestations ?? { attestations: [{ predicateType: SLSA_PROVENANCE_V1, bundle: provenanceBundle() }] };
  return { metadata, keys, attestations };
}

function clientFor(fixture, options = {}) {
  const requests = [];
  const responses = new Map([
    [REGISTRY_KEYS_URL, fixture.keys],
    [VERSION_URL, fixture.metadata],
    [ATTESTATION_URL, fixture.attestations],
  ]);
  const fetch = async (url) => {
    requests.push(url);
    if (!responses.has(url)) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    return { ok: true, status: 200, json: async () => structuredClone(responses.get(url)) };
  };
  return { client: new RegistrySecurityClient({ fetch, now: () => NOW, ...options }), requests, responses };
}

test("npm 包签名与 SLSA provenance 同时通过才允许更新", async () => {
  const { client } = clientFor(registryFixture());
  const result = await client.verifyVersion(PACKAGE, VERSION);
  assert.equal(result.verified, true);
  assert.equal(result.signerKeyId, KEY_ID);
  assert.equal(result.provenanceVerified, true);
  assert.equal(result.provenance.repository, "https://github.com/MichengAI/dsh-archive-manager");
  assert.equal(result.provenance.sourceCommit, "0123456789abcdef");
  assert.equal(result.integrity, integrity);
  assert.equal(result.tarball, TARBALL);
});

test("篡改包签名、integrity 或 tarball 协议都会被拒绝", async () => {
  const badSignature = registryFixture({ packageSignature: sign("different message") });
  assert.equal((await clientFor(badSignature).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-signature");

  const malformedIntegrity = registryFixture({ integrity: "sha512-not-base64" });
  assert.equal((await clientFor(malformedIntegrity).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-integrity");

  const otherIntegrity = `sha512-${createHash("sha512").update("other tarball").digest("base64")}`;
  const swappedIntegrity = registryFixture({ integrity: otherIntegrity });
  assert.equal((await clientFor(swappedIntegrity).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-provenance");

  const insecureTarball = registryFixture({ tarball: TARBALL.replace("https://", "http://") });
  assert.equal((await clientFor(insecureTarball).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-tarball");

  const foreignTarball = registryFixture({ tarball: "https://example.com/archive.tgz" });
  assert.equal((await clientFor(foreignTarball).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-tarball");
});

test("过期签名密钥不会被接受", async () => {
  const fixture = registryFixture({ keyExpires: "2020-01-01T00:00:00.000Z" });
  const result = await clientFor(fixture).client.verifyVersion(PACKAGE, VERSION);
  assert.equal(result.verified, false);
  assert.equal(result.code, "expired-signing-key");
});

test("provenance 必须绑定同一个包、版本、tarball 摘要和 DSSE 签名", async () => {
  const missing = registryFixture({ attestations: { attestations: [] } });
  assert.equal((await clientFor(missing).client.verifyVersion(PACKAGE, VERSION)).code, "missing-provenance");

  const wrongPredicate = registryFixture({ predicateType: "https://example.com/not-slsa" });
  assert.equal((await clientFor(wrongPredicate).client.verifyVersion(PACKAGE, VERSION)).code, "missing-provenance");

  const wrongDigest = registryFixture({ attestations: { attestations: [{ predicateType: SLSA_PROVENANCE_V1, bundle: provenanceBundle({ statement: { subject: [{ name: `pkg:npm/%40michengai/dsh-archive-manager@${VERSION}`, digest: { sha512: "0".repeat(128) } }] } }) }] } });
  assert.equal((await clientFor(wrongDigest).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-provenance");

  const wrongName = registryFixture({ attestations: { attestations: [{ predicateType: SLSA_PROVENANCE_V1, bundle: provenanceBundle({ statement: { subject: [{ name: "pkg:npm/other@1.0.0", digest: { sha512: sha512Hex } }] } }) }] } });
  assert.equal((await clientFor(wrongName).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-provenance");

  const forgedSignature = registryFixture({ attestations: { attestations: [{ predicateType: SLSA_PROVENANCE_V1, bundle: provenanceBundle({ signature: sign(Buffer.from("forged")) }) }] } });
  assert.equal((await clientFor(forgedSignature).client.verifyVersion(PACKAGE, VERSION)).code, "invalid-provenance");
});

test("latest 会验证精确版本，官方地址之外的 attestation 被拒绝", async () => {
  const fixture = registryFixture();
  const { client, responses } = clientFor(fixture);
  responses.set(`${REGISTRY_ORIGIN}/${encodeURIComponent(PACKAGE)}/latest`, { name: PACKAGE, version: VERSION });
  const latest = await client.latest(PACKAGE, { fresh: true });
  assert.equal(latest.verified, true);
  assert.equal(latest.version, VERSION);

  const foreign = registryFixture({ attestationUrl: "https://example.com/attestation" });
  const result = await clientFor(foreign).client.verifyVersion(PACKAGE, VERSION);
  assert.equal(result.code, "missing-provenance");
});
