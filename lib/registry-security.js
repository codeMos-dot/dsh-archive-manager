import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import { record } from "./contracts.js";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const REGISTRY_KEYS_URL = `${REGISTRY_ORIGIN}/-/npm/v1/keys`;
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const SIGSTORE_BUNDLE_PREFIX = "application/vnd.dev.sigstore.bundle";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
class RegistrySecurityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RegistrySecurityError";
  }
}
const defaultFetch = async (input, init) => globalThis.fetch(input, init);
function failureMessage(code) {
  switch (code) {
    case "invalid-package":
      return "npm \u5305\u540D\u6216\u7248\u672C\u65E0\u6548";
    case "invalid-metadata":
      return "npm \u7248\u672C\u5143\u6570\u636E\u65E0\u6548";
    case "invalid-integrity":
      return "npm tarball \u7684 SHA-512 integrity \u65E0\u6548";
    case "invalid-tarball":
      return "npm tarball \u5730\u5740\u4E0D\u662F\u5B98\u65B9 HTTPS registry";
    case "invalid-signature":
      return "npm \u5305\u7B7E\u540D\u65E0\u6548";
    case "expired-signing-key":
      return "npm \u5305\u7B7E\u540D\u4F7F\u7528\u7684\u5BC6\u94A5\u5DF2\u8FC7\u671F\u6216\u64A4\u9500";
    case "missing-provenance":
      return "npm \u5305\u7F3A\u5C11 SLSA provenance";
    case "invalid-provenance":
      return "npm \u5305\u7684 SLSA provenance \u6821\u9A8C\u5931\u8D25";
    case "network":
      return "\u65E0\u6CD5\u8FDE\u63A5 npm registry \u5B8C\u6210\u5B89\u5168\u6821\u9A8C";
  }
}
function invalid(code, detail) {
  throw new RegistrySecurityError(code, detail === void 0 ? failureMessage(code) : `${failureMessage(code)}\uFF1A${detail}`);
}
function boundedString(value, max, label, code = "invalid-metadata") {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(code, `${label}\u65E0\u6548`);
  return value;
}
function object(value, code, label) {
  try {
    return record(value);
  } catch {
    invalid(code, `${label}\u7F3A\u5931\u6216\u4E0D\u662F\u5BF9\u8C61`);
  }
}
function officialRegistryUrl(value, code, label) {
  if (typeof value !== "string") invalid(code, `${label}\u7F3A\u5931`);
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid(code, `${label}\u4E0D\u662F\u6709\u6548 URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    invalid(code, `${label}\u4E0D\u662F npm \u5B98\u65B9 HTTPS \u5730\u5740`);
  }
  return url.toString();
}
function decodeBase64(value, maxBytes, code, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) invalid(code, `${label}\u7F3A\u5931\u6216\u8FC7\u957F`);
  let bytes;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    invalid(code, `${label}\u4E0D\u662F\u6709\u6548 Base64`);
  }
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) invalid(code, `${label}\u4E0D\u662F\u89C4\u8303 Base64`);
  return bytes;
}
function parseIntegrity(value) {
  if (typeof value !== "string") invalid("invalid-integrity");
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (match === null) invalid("invalid-integrity");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1]) invalid("invalid-integrity");
  return { integrity: value, sha512Hex: bytes.toString("hex") };
}
function parseOptionalTime(value, code, label) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") invalid(code, `${label}\u65E0\u6548`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid(code, `${label}\u65E0\u6548`);
  return time;
}
function parseSigningKeys(input) {
  const value = record(input);
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100) invalid("invalid-signature", "npm \u7B7E\u540D\u5BC6\u94A5\u5217\u8868\u65E0\u6548");
  const keys = [];
  for (const item of value.keys) {
    try {
      const candidate = record(item);
      const keyid = boundedString(candidate.keyid, 256, "keyid");
      if (candidate.keytype !== "ecdsa-sha2-nistp256" || candidate.scheme !== "ecdsa-sha2-nistp256") continue;
      const keyBytes = decodeBase64(candidate.key, 4096, "invalid-signature", "\u516C\u94A5");
      const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
      const curve = publicKey.asymmetricKeyDetails?.namedCurve;
      if (publicKey.asymmetricKeyType !== "ec" || curve !== void 0 && curve !== "prime256v1" && curve !== "P-256") continue;
      const expiresAt = parseOptionalTime(candidate.expires, "invalid-signature", "\u5BC6\u94A5\u8FC7\u671F\u65F6\u95F4");
      const revokedAt = candidate.revoked === true ? 0 : parseOptionalTime(candidate.revoked, "invalid-signature", "\u5BC6\u94A5\u64A4\u9500\u65F6\u95F4");
      keys.push({ keyid, publicKey, ...expiresAt === void 0 ? {} : { expiresAt }, ...revokedAt === void 0 ? {} : { revokedAt } });
    } catch (error) {
      if (error instanceof RegistrySecurityError) continue;
      continue;
    }
  }
  if (keys.length === 0) invalid("invalid-signature", "npm registry \u672A\u63D0\u4F9B\u53EF\u7528\u7684 ECDSA P-256 \u516C\u94A5");
  return keys;
}
function signingKeyUsable(key, nowMs) {
  if (key.revokedAt !== void 0 && key.revokedAt <= nowMs) return false;
  if (key.expiresAt !== void 0 && key.expiresAt <= nowMs) return false;
  return true;
}
function verifyPackageSignature(packageName, version, integrity, dist, keys, nowMs) {
  if (!Array.isArray(dist.signatures) || dist.signatures.length === 0 || dist.signatures.length > 20) invalid("invalid-signature", "\u7F3A\u5C11 npm \u5305\u7B7E\u540D");
  const byId = new Map(keys.map((key) => [key.keyid, key]));
  const message = `${packageName}@${version}:${integrity}`;
  let sawKnownKey = false;
  let sawExpiredKey = false;
  for (const item of dist.signatures) {
    try {
      const signature = record(item);
      if (typeof signature.keyid !== "string" || typeof signature.sig !== "string") continue;
      const key = byId.get(signature.keyid);
      if (key === void 0) continue;
      sawKnownKey = true;
      if (!signingKeyUsable(key, nowMs)) {
        sawExpiredKey = true;
        continue;
      }
      const bytes = decodeBase64(signature.sig, 1024, "invalid-signature", "\u5305\u7B7E\u540D");
      const okay = createVerify("sha256").update(message).verify({ key: key.publicKey, dsaEncoding: "der" }, bytes);
      if (okay) return key.keyid;
    } catch (error) {
      if (error instanceof RegistrySecurityError) continue;
      continue;
    }
  }
  if (sawExpiredKey && !sawKnownKey) invalid("expired-signing-key");
  if (sawExpiredKey) invalid("expired-signing-key", "\u6CA1\u6709\u4F7F\u7528\u672A\u8FC7\u671F\u5BC6\u94A5\u7684\u6709\u6548\u7B7E\u540D");
  invalid("invalid-signature");
}
function dssePae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, "utf8")} ${payloadType} ${payload.length} `, "utf8"),
    payload
  ]);
}
function bundlePublicKey(bundle, nowMs, integratedTime) {
  const material = object(bundle.verificationMaterial, "invalid-provenance", "verificationMaterial");
  if (material.certificate !== void 0) {
    const certificate = object(material.certificate, "invalid-provenance", "Sigstore \u8BC1\u4E66");
    const bytes = decodeBase64(certificate.rawBytes, 64 * 1024, "invalid-provenance", "Sigstore \u8BC1\u4E66");
    let cert;
    try {
      cert = new X509Certificate(bytes);
    } catch {
      invalid("invalid-provenance", "Sigstore \u8BC1\u4E66\u65E0\u6CD5\u89E3\u6790");
    }
    const timestamp = integratedTime * 1e3;
    if (timestamp < cert.validFromDate.getTime() || timestamp > cert.validToDate.getTime()) invalid("invalid-provenance", "Rekor \u65F6\u95F4\u4E0D\u5728 Sigstore \u8BC1\u4E66\u6709\u6548\u671F\u5185");
    void nowMs;
    return cert.publicKey;
  }
  if (material.publicKey !== void 0) {
    const publicKey = object(material.publicKey, "invalid-provenance", "provenance \u516C\u94A5");
    const bytes = decodeBase64(publicKey.rawBytes, 4096, "invalid-provenance", "provenance \u516C\u94A5");
    try {
      return createPublicKey({ key: bytes, format: "der", type: "spki" });
    } catch {
      invalid("invalid-provenance", "provenance \u516C\u94A5\u65E0\u6CD5\u89E3\u6790");
    }
  }
  invalid("invalid-provenance", "\u7F3A\u5C11 Sigstore \u8BC1\u4E66\u6216\u516C\u94A5");
}
function verifyProvenanceBundle(bundleInput, packageName, version, sha512Hex, nowMs) {
  const bundle = object(bundleInput, "invalid-provenance", "Sigstore bundle");
  if (typeof bundle.mediaType !== "string" || !bundle.mediaType.startsWith(SIGSTORE_BUNDLE_PREFIX)) invalid("invalid-provenance", "Sigstore bundle \u7C7B\u578B\u65E0\u6548");
  const envelope = object(bundle.dsseEnvelope, "invalid-provenance", "DSSE envelope");
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) invalid("invalid-provenance", "in-toto payload \u7C7B\u578B\u65E0\u6548");
  const payload = decodeBase64(envelope.payload, MAX_JSON_BYTES, "invalid-provenance", "in-toto payload");
  let statement;
  try {
    statement = record(JSON.parse(payload.toString("utf8")));
  } catch {
    invalid("invalid-provenance", "in-toto statement \u65E0\u6CD5\u89E3\u6790");
  }
  if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) invalid("invalid-provenance", "provenance \u4E0D\u662F SLSA v1");
  if (!Array.isArray(statement.subject) || statement.subject.length === 0) invalid("invalid-provenance", "provenance subject \u7F3A\u5931");
  const encodedName = packageName.startsWith("@") ? `%40${packageName.slice(1)}` : packageName;
  const names = /* @__PURE__ */ new Set([`pkg:npm/${encodedName}@${version}`, `pkg:npm/${packageName}@${version}`]);
  const subject = statement.subject.map((item) => object(item, "invalid-provenance", "provenance subject")).find((item) => typeof item.name === "string" && names.has(item.name));
  if (subject === void 0) invalid("invalid-provenance", "provenance subject \u4E0E\u5305\u7248\u672C\u4E0D\u5339\u914D");
  const digest = object(subject.digest, "invalid-provenance", "provenance subject digest");
  if (digest.sha512 !== sha512Hex) invalid("invalid-provenance", "provenance subject \u7684 SHA-512 \u4E0E integrity \u4E0D\u4E00\u81F4");
  const predicate = object(statement.predicate, "invalid-provenance", "SLSA predicate");
  const buildDefinition = object(predicate.buildDefinition, "invalid-provenance", "SLSA buildDefinition");
  const externalParameters = object(buildDefinition.externalParameters, "invalid-provenance", "SLSA externalParameters");
  const workflow = object(externalParameters.workflow, "invalid-provenance", "SLSA workflow");
  const runDetails = object(predicate.runDetails, "invalid-provenance", "SLSA runDetails");
  const builder = object(runDetails.builder, "invalid-provenance", "SLSA builder");
  const builderId = boundedString(builder.id, 4096, "SLSA builder", "invalid-provenance");
  const repository = boundedString(workflow.repository, 4096, "SLSA repository", "invalid-provenance");
  const workflowPath = boundedString(workflow.path, 4096, "SLSA workflow", "invalid-provenance");
  if (typeof buildDefinition.buildType !== "string" || buildDefinition.buildType.length === 0) invalid("invalid-provenance", "SLSA buildType \u7F3A\u5931");
  const resolvedDependencies = buildDefinition.resolvedDependencies;
  let sourceCommit;
  if (Array.isArray(resolvedDependencies)) {
    for (const dependency of resolvedDependencies) {
      const item = object(dependency, "invalid-provenance", "SLSA dependency");
      if (item.digest === void 0) continue;
      const dependencyDigest = object(item.digest, "invalid-provenance", "SLSA dependency digest");
      if (typeof dependencyDigest.gitCommit === "string" && dependencyDigest.gitCommit.length > 0) {
        sourceCommit = dependencyDigest.gitCommit;
        break;
      }
    }
  }
  const entries = object(bundle.verificationMaterial, "invalid-provenance", "verificationMaterial").tlogEntries;
  if (!Array.isArray(entries) || entries.length === 0) invalid("invalid-provenance", "\u7F3A\u5C11 Rekor \u900F\u660E\u65E5\u5FD7\u8BB0\u5F55");
  const entry = object(entries[0], "invalid-provenance", "Rekor \u8BB0\u5F55");
  const integratedTime = Number(entry.integratedTime);
  if (!Number.isSafeInteger(integratedTime) || integratedTime <= 0) invalid("invalid-provenance", "Rekor \u65F6\u95F4\u6233\u65E0\u6548");
  const logId = object(entry.logId, "invalid-provenance", "Rekor \u65E5\u5FD7 ID");
  if (typeof logId.keyId !== "string" || logId.keyId.length === 0) invalid("invalid-provenance", "Rekor \u65E5\u5FD7 ID \u7F3A\u5931");
  if (entry.inclusionPromise === void 0 && entry.inclusionProof === void 0) invalid("invalid-provenance", "Rekor \u8BB0\u5F55\u7F3A\u5C11\u5305\u542B\u8BC1\u660E");
  const signatures = envelope.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) invalid("invalid-provenance", "provenance \u7F3A\u5C11 DSSE \u7B7E\u540D");
  const signature = object(signatures[0], "invalid-provenance", "DSSE \u7B7E\u540D");
  const signatureBytes = decodeBase64(signature.sig, 1024, "invalid-provenance", "DSSE \u7B7E\u540D");
  const publicKey = bundlePublicKey(bundle, nowMs, integratedTime);
  const okay = createVerify("sha256").update(dssePae(IN_TOTO_PAYLOAD_TYPE, payload)).verify({ key: publicKey, dsaEncoding: "der" }, signatureBytes);
  if (!okay) invalid("invalid-provenance", "DSSE \u7B7E\u540D\u65E0\u6548");
  return { builder: builderId, repository, workflow: workflowPath, ...sourceCommit === void 0 ? {} : { sourceCommit } };
}
async function requestJson(fetchImpl, url, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...timeoutMs > 0 && typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {}
    });
  } catch (error) {
    invalid("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) invalid("network", `HTTP ${String(response.status)}`);
  try {
    return await response.json();
  } catch {
    invalid("invalid-metadata", "registry \u8FD4\u56DE\u7684\u4E0D\u662F JSON");
  }
}
function packageVersionPath(packageName, version) {
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}
class RegistrySecurityClient {
  fetchImpl;
  now;
  timeoutMs;
  keysTtlMs;
  latestTtlMs;
  keysCache;
  latestCache = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8e3;
    this.keysTtlMs = options.keysTtlMs ?? 5 * 6e4;
    this.latestTtlMs = options.latestTtlMs ?? 6e4;
  }
  clearCache() {
    this.keysCache = void 0;
    this.latestCache.clear();
  }
  async signingKeys(nowMs) {
    if (this.keysCache !== void 0 && nowMs < this.keysCache.expiresAt) return this.keysCache.keys;
    try {
      const keys = parseSigningKeys(await requestJson(this.fetchImpl, REGISTRY_KEYS_URL, this.timeoutMs));
      this.keysCache = { keys, expiresAt: nowMs + this.keysTtlMs };
      return keys;
    } catch (error) {
      if (this.keysCache !== void 0 && this.keysCache.keys.some((key) => signingKeyUsable(key, nowMs))) return this.keysCache.keys;
      throw error;
    }
  }
  async latest(packageName, options = {}) {
    const cached = this.latestCache.get(packageName);
    if (options.fresh !== true && cached !== void 0 && this.now() < cached.expiresAt) return cached.value;
    try {
      if (packageName.length === 0 || packageName.length > 214 || !PACKAGE_NAME_PATTERN.test(packageName)) invalid("invalid-package");
      const latestUrl = `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/latest`;
      const metadata = object(await requestJson(this.fetchImpl, latestUrl, this.timeoutMs), "invalid-metadata", "latest \u5143\u6570\u636E");
      if (metadata.name !== packageName) invalid("invalid-metadata", "latest \u5143\u6570\u636E\u5305\u540D\u4E0D\u5339\u914D");
      const version = boundedString(metadata.version, 256, "latest \u7248\u672C");
      const value = await this.verifyVersion(packageName, version);
      this.latestCache.set(packageName, { expiresAt: this.now() + (value.verified ? this.latestTtlMs : 15e3), value });
      return value;
    } catch (error) {
      const value = this.rejected(packageName, error);
      this.latestCache.set(packageName, { expiresAt: this.now() + 15e3, value });
      return value;
    }
  }
  async verifyVersion(packageName, version, options = {}) {
    try {
      if (options.freshKeys === true) this.keysCache = void 0;
      this.validatePackage(packageName, version);
      const nowMs = this.now();
      const [metadataInput, keys] = await Promise.all([
        requestJson(this.fetchImpl, packageVersionPath(packageName, version), this.timeoutMs),
        this.signingKeys(nowMs)
      ]);
      const metadata = object(metadataInput, "invalid-metadata", "\u7248\u672C\u5143\u6570\u636E");
      if (metadata.name !== packageName || metadata.version !== version) invalid("invalid-metadata", "\u5143\u6570\u636E\u5305\u540D\u6216\u7248\u672C\u4E0D\u5339\u914D");
      const dist = object(metadata.dist, "invalid-metadata", "dist \u5143\u6570\u636E");
      const { integrity, sha512Hex } = parseIntegrity(dist.integrity);
      const tarball = officialRegistryUrl(dist.tarball, "invalid-tarball", "tarball \u5730\u5740");
      const signerKeyId = verifyPackageSignature(packageName, version, integrity, dist, keys, nowMs);
      const attestations = object(dist.attestations, "missing-provenance", "dist.attestations");
      const attestationUrl = officialRegistryUrl(attestations.url, "missing-provenance", "attestation \u5730\u5740");
      const provenanceHint = object(attestations.provenance, "missing-provenance", "provenance \u58F0\u660E");
      if (provenanceHint.predicateType !== SLSA_PROVENANCE_V1) invalid("missing-provenance", "dist \u672A\u58F0\u660E SLSA v1 provenance");
      let attestationResponse;
      try {
        attestationResponse = object(await requestJson(this.fetchImpl, attestationUrl, this.timeoutMs), "invalid-metadata", "attestation \u54CD\u5E94");
      } catch (error) {
        const rejected = this.rejected(packageName, error, version, signerKeyId);
        return rejected;
      }
      if (!Array.isArray(attestationResponse.attestations)) invalid("missing-provenance", "attestation \u54CD\u5E94\u65E0\u6548");
      const attestation = attestationResponse.attestations.map((item) => {
        try {
          return object(item, "invalid-provenance", "attestation");
        } catch {
          return void 0;
        }
      }).find((item) => item?.predicateType === SLSA_PROVENANCE_V1);
      if (attestation === void 0) invalid("missing-provenance");
      let provenance;
      try {
        provenance = verifyProvenanceBundle(attestation.bundle, packageName, version, sha512Hex, nowMs);
      } catch (error) {
        const normalized = error instanceof RegistrySecurityError ? error : new RegistrySecurityError("invalid-provenance", error instanceof Error ? error.message : String(error));
        return this.rejected(packageName, normalized, version, signerKeyId);
      }
      return { verified: true, packageName, version, integrity, tarball, signerKeyId, provenanceVerified: true, provenance };
    } catch (error) {
      const normalized = error instanceof RegistrySecurityError ? error : new RegistrySecurityError("invalid-metadata", error instanceof Error ? error.message : String(error));
      return this.rejected(packageName, normalized, version);
    }
  }
  validatePackage(packageName, version) {
    if (packageName.length === 0 || packageName.length > 214 || !PACKAGE_NAME_PATTERN.test(packageName)) invalid("invalid-package");
    if (version.length === 0 || version.length > 256 || !VERSION_PATTERN.test(version)) invalid("invalid-package");
  }
  rejected(packageName, error, version, signerKeyId) {
    const securityError = error instanceof RegistrySecurityError ? error : new RegistrySecurityError("network", error instanceof Error ? error.message : String(error));
    return {
      verified: false,
      packageName,
      ...version === void 0 ? {} : { version },
      ...signerKeyId === void 0 ? {} : { signerKeyId },
      provenanceVerified: false,
      code: securityError.code,
      message: securityError.message
    };
  }
}
export {
  REGISTRY_KEYS_URL,
  REGISTRY_ORIGIN,
  RegistrySecurityClient,
  SLSA_PROVENANCE_V1
};
