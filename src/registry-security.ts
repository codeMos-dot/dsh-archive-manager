import { createPublicKey, createVerify, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";
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

type FetchResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
type FetchLike = (input: string, init: { headers: Record<string, string>; redirect: "error"; signal?: AbortSignal }) => Promise<FetchResponseLike>;

export type RegistrySecurityFailureCode =
  | "invalid-package"
  | "invalid-metadata"
  | "invalid-integrity"
  | "invalid-tarball"
  | "invalid-signature"
  | "expired-signing-key"
  | "missing-provenance"
  | "invalid-provenance"
  | "network";

export interface ProvenanceSummary {
  builder: string;
  repository: string;
  workflow: string;
  sourceCommit?: string;
}

export interface VerifiedRegistryPackage {
  verified: true;
  packageName: string;
  version: string;
  integrity: string;
  tarball: string;
  signerKeyId: string;
  provenanceVerified: true;
  provenance: ProvenanceSummary;
}

export interface RejectedRegistryPackage {
  verified: false;
  packageName: string;
  version?: string;
  signerKeyId?: string;
  provenanceVerified: false;
  code: RegistrySecurityFailureCode;
  message: string;
}

export type RegistryVerification = VerifiedRegistryPackage | RejectedRegistryPackage;

export interface RegistrySecurityOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  keysTtlMs?: number;
  latestTtlMs?: number;
}

interface VerifiedSigningKey {
  keyid: string;
  publicKey: KeyObject;
  expiresAt?: number;
  revokedAt?: number;
}

class RegistrySecurityError extends Error {
  constructor(readonly code: RegistrySecurityFailureCode, message: string) {
    super(message);
    this.name = "RegistrySecurityError";
  }
}

const defaultFetch: FetchLike = async (input, init) => globalThis.fetch(input, init);

function failureMessage(code: RegistrySecurityFailureCode) {
  switch (code) {
    case "invalid-package": return "npm 包名或版本无效";
    case "invalid-metadata": return "npm 版本元数据无效";
    case "invalid-integrity": return "npm tarball 的 SHA-512 integrity 无效";
    case "invalid-tarball": return "npm tarball 地址不是官方 HTTPS registry";
    case "invalid-signature": return "npm 包签名无效";
    case "expired-signing-key": return "npm 包签名使用的密钥已过期或撤销";
    case "missing-provenance": return "npm 包缺少 SLSA provenance";
    case "invalid-provenance": return "npm 包的 SLSA provenance 校验失败";
    case "network": return "无法连接 npm registry 完成安全校验";
  }
}

function invalid(code: RegistrySecurityFailureCode, detail?: string): never {
  throw new RegistrySecurityError(code, detail === undefined ? failureMessage(code) : `${failureMessage(code)}：${detail}`);
}

function boundedString(value: unknown, max: number, label: string, code: RegistrySecurityFailureCode = "invalid-metadata") {
  if (typeof value !== "string" || value.length === 0 || value.length > max) invalid(code, `${label}无效`);
  return value;
}

function object(value: unknown, code: RegistrySecurityFailureCode, label: string) {
  try { return record(value); }
  catch { invalid(code, `${label}缺失或不是对象`); }
}

function officialRegistryUrl(value: unknown, code: RegistrySecurityFailureCode, label: string) {
  if (typeof value !== "string") invalid(code, `${label}缺失`);
  let url: URL;
  try { url = new URL(value); }
  catch { invalid(code, `${label}不是有效 URL`); }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    invalid(code, `${label}不是 npm 官方 HTTPS 地址`);
  }
  return url.toString();
}

function decodeBase64(value: unknown, maxBytes: number, code: RegistrySecurityFailureCode, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) invalid(code, `${label}缺失或过长`);
  let bytes: Buffer;
  try { bytes = Buffer.from(value, "base64"); }
  catch { invalid(code, `${label}不是有效 Base64`); }
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) invalid(code, `${label}不是规范 Base64`);
  return bytes;
}

function parseIntegrity(value: unknown) {
  if (typeof value !== "string") invalid("invalid-integrity");
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (match === null) invalid("invalid-integrity");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== match[1]) invalid("invalid-integrity");
  return { integrity: value, sha512Hex: bytes.toString("hex") };
}

function parseOptionalTime(value: unknown, code: RegistrySecurityFailureCode, label: string) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") invalid(code, `${label}无效`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) invalid(code, `${label}无效`);
  return time;
}

function parseSigningKeys(input: unknown): VerifiedSigningKey[] {
  const value = record(input);
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 100) invalid("invalid-signature", "npm 签名密钥列表无效");
  const keys: VerifiedSigningKey[] = [];
  for (const item of value.keys) {
    try {
      const candidate = record(item);
      const keyid = boundedString(candidate.keyid, 256, "keyid");
      if (candidate.keytype !== "ecdsa-sha2-nistp256" || candidate.scheme !== "ecdsa-sha2-nistp256") continue;
      const keyBytes = decodeBase64(candidate.key, 4096, "invalid-signature", "公钥");
      const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
      const curve = publicKey.asymmetricKeyDetails?.namedCurve;
      if (publicKey.asymmetricKeyType !== "ec" || (curve !== undefined && curve !== "prime256v1" && curve !== "P-256")) continue;
      const expiresAt = parseOptionalTime(candidate.expires, "invalid-signature", "密钥过期时间");
      const revokedAt = candidate.revoked === true ? 0 : parseOptionalTime(candidate.revoked, "invalid-signature", "密钥撤销时间");
      keys.push({ keyid, publicKey, ...expiresAt === undefined ? {} : { expiresAt }, ...revokedAt === undefined ? {} : { revokedAt } });
    } catch (error) {
      if (error instanceof RegistrySecurityError) continue;
      continue;
    }
  }
  if (keys.length === 0) invalid("invalid-signature", "npm registry 未提供可用的 ECDSA P-256 公钥");
  return keys;
}

function signingKeyUsable(key: VerifiedSigningKey, nowMs: number) {
  if (key.revokedAt !== undefined && key.revokedAt <= nowMs) return false;
  if (key.expiresAt !== undefined && key.expiresAt <= nowMs) return false;
  return true;
}

function verifyPackageSignature(packageName: string, version: string, integrity: string, dist: Record<string, unknown>, keys: readonly VerifiedSigningKey[], nowMs: number) {
  if (!Array.isArray(dist.signatures) || dist.signatures.length === 0 || dist.signatures.length > 20) invalid("invalid-signature", "缺少 npm 包签名");
  const byId = new Map(keys.map((key) => [key.keyid, key]));
  const message = `${packageName}@${version}:${integrity}`;
  let sawKnownKey = false;
  let sawExpiredKey = false;
  for (const item of dist.signatures) {
    try {
      const signature = record(item);
      if (typeof signature.keyid !== "string" || typeof signature.sig !== "string") continue;
      const key = byId.get(signature.keyid);
      if (key === undefined) continue;
      sawKnownKey = true;
      if (!signingKeyUsable(key, nowMs)) {
        sawExpiredKey = true;
        continue;
      }
      const bytes = decodeBase64(signature.sig, 1024, "invalid-signature", "包签名");
      const okay = createVerify("sha256").update(message).verify({ key: key.publicKey, dsaEncoding: "der" }, bytes);
      if (okay) return key.keyid;
    } catch (error) {
      if (error instanceof RegistrySecurityError) continue;
      continue;
    }
  }
  if (sawExpiredKey && !sawKnownKey) invalid("expired-signing-key");
  if (sawExpiredKey) invalid("expired-signing-key", "没有使用未过期密钥的有效签名");
  invalid("invalid-signature");
}

function dssePae(payloadType: string, payload: Buffer) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, "utf8")} ${payloadType} ${payload.length} `, "utf8"),
    payload,
  ]);
}

function bundlePublicKey(bundle: Record<string, unknown>, nowMs: number, integratedTime: number) {
  const material = object(bundle.verificationMaterial, "invalid-provenance", "verificationMaterial");
  if (material.certificate !== undefined) {
    const certificate = object(material.certificate, "invalid-provenance", "Sigstore 证书");
    const bytes = decodeBase64(certificate.rawBytes, 64 * 1024, "invalid-provenance", "Sigstore 证书");
    let cert: X509Certificate;
    try { cert = new X509Certificate(bytes); }
    catch { invalid("invalid-provenance", "Sigstore 证书无法解析"); }
    const timestamp = integratedTime * 1000;
    if (timestamp < cert.validFromDate.getTime() || timestamp > cert.validToDate.getTime()) invalid("invalid-provenance", "Rekor 时间不在 Sigstore 证书有效期内");
    void nowMs;
    return cert.publicKey;
  }
  if (material.publicKey !== undefined) {
    const publicKey = object(material.publicKey, "invalid-provenance", "provenance 公钥");
    const bytes = decodeBase64(publicKey.rawBytes, 4096, "invalid-provenance", "provenance 公钥");
    try { return createPublicKey({ key: bytes, format: "der", type: "spki" }); }
    catch { invalid("invalid-provenance", "provenance 公钥无法解析"); }
  }
  invalid("invalid-provenance", "缺少 Sigstore 证书或公钥");
}

function verifyProvenanceBundle(bundleInput: unknown, packageName: string, version: string, sha512Hex: string, nowMs: number): ProvenanceSummary {
  const bundle = object(bundleInput, "invalid-provenance", "Sigstore bundle");
  if (typeof bundle.mediaType !== "string" || !bundle.mediaType.startsWith(SIGSTORE_BUNDLE_PREFIX)) invalid("invalid-provenance", "Sigstore bundle 类型无效");
  const envelope = object(bundle.dsseEnvelope, "invalid-provenance", "DSSE envelope");
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) invalid("invalid-provenance", "in-toto payload 类型无效");
  const payload = decodeBase64(envelope.payload, MAX_JSON_BYTES, "invalid-provenance", "in-toto payload");
  let statement: Record<string, unknown>;
  try { statement = record(JSON.parse(payload.toString("utf8"))); }
  catch { invalid("invalid-provenance", "in-toto statement 无法解析"); }
  if (statement._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) invalid("invalid-provenance", "provenance 不是 SLSA v1");

  if (!Array.isArray(statement.subject) || statement.subject.length === 0) invalid("invalid-provenance", "provenance subject 缺失");
  const encodedName = packageName.startsWith("@") ? `%40${packageName.slice(1)}` : packageName;
  const names = new Set([`pkg:npm/${encodedName}@${version}`, `pkg:npm/${packageName}@${version}`]);
  const subject = statement.subject.map((item) => object(item, "invalid-provenance", "provenance subject")).find((item) => typeof item.name === "string" && names.has(item.name));
  if (subject === undefined) invalid("invalid-provenance", "provenance subject 与包版本不匹配");
  const digest = object(subject.digest, "invalid-provenance", "provenance subject digest");
  if (digest.sha512 !== sha512Hex) invalid("invalid-provenance", "provenance subject 的 SHA-512 与 integrity 不一致");

  const predicate = object(statement.predicate, "invalid-provenance", "SLSA predicate");
  const buildDefinition = object(predicate.buildDefinition, "invalid-provenance", "SLSA buildDefinition");
  const externalParameters = object(buildDefinition.externalParameters, "invalid-provenance", "SLSA externalParameters");
  const workflow = object(externalParameters.workflow, "invalid-provenance", "SLSA workflow");
  const runDetails = object(predicate.runDetails, "invalid-provenance", "SLSA runDetails");
  const builder = object(runDetails.builder, "invalid-provenance", "SLSA builder");
  const builderId = boundedString(builder.id, 4096, "SLSA builder", "invalid-provenance");
  const repository = boundedString(workflow.repository, 4096, "SLSA repository", "invalid-provenance");
  const workflowPath = boundedString(workflow.path, 4096, "SLSA workflow", "invalid-provenance");
  if (typeof buildDefinition.buildType !== "string" || buildDefinition.buildType.length === 0) invalid("invalid-provenance", "SLSA buildType 缺失");
  const resolvedDependencies = buildDefinition.resolvedDependencies;
  let sourceCommit: string | undefined;
  if (Array.isArray(resolvedDependencies)) {
    for (const dependency of resolvedDependencies) {
      const item = object(dependency, "invalid-provenance", "SLSA dependency");
      if (item.digest === undefined) continue;
      const dependencyDigest = object(item.digest, "invalid-provenance", "SLSA dependency digest");
      if (typeof dependencyDigest.gitCommit === "string" && dependencyDigest.gitCommit.length > 0) {
        sourceCommit = dependencyDigest.gitCommit;
        break;
      }
    }
  }

  const entries = object(bundle.verificationMaterial, "invalid-provenance", "verificationMaterial").tlogEntries;
  if (!Array.isArray(entries) || entries.length === 0) invalid("invalid-provenance", "缺少 Rekor 透明日志记录");
  const entry = object(entries[0], "invalid-provenance", "Rekor 记录");
  const integratedTime = Number(entry.integratedTime);
  if (!Number.isSafeInteger(integratedTime) || integratedTime <= 0) invalid("invalid-provenance", "Rekor 时间戳无效");
  const logId = object(entry.logId, "invalid-provenance", "Rekor 日志 ID");
  if (typeof logId.keyId !== "string" || logId.keyId.length === 0) invalid("invalid-provenance", "Rekor 日志 ID 缺失");
  if (entry.inclusionPromise === undefined && entry.inclusionProof === undefined) invalid("invalid-provenance", "Rekor 记录缺少包含证明");

  const signatures = envelope.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) invalid("invalid-provenance", "provenance 缺少 DSSE 签名");
  const signature = object(signatures[0], "invalid-provenance", "DSSE 签名");
  const signatureBytes = decodeBase64(signature.sig, 1024, "invalid-provenance", "DSSE 签名");
  const publicKey = bundlePublicKey(bundle, nowMs, integratedTime);
  const okay = createVerify("sha256").update(dssePae(IN_TOTO_PAYLOAD_TYPE, payload)).verify({ key: publicKey, dsaEncoding: "der" }, signatureBytes);
  if (!okay) invalid("invalid-provenance", "DSSE 签名无效");
  return { builder: builderId, repository, workflow: workflowPath, ...sourceCommit === undefined ? {} : { sourceCommit } };
}

async function requestJson(fetchImpl: FetchLike, url: string, timeoutMs: number) {
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...timeoutMs > 0 && typeof AbortSignal.timeout === "function" ? { signal: AbortSignal.timeout(timeoutMs) } : {},
    });
  } catch (error) {
    invalid("network", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) invalid("network", `HTTP ${String(response.status)}`);
  try { return await response.json(); }
  catch { invalid("invalid-metadata", "registry 返回的不是 JSON"); }
}

function packageVersionPath(packageName: string, version: string) {
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

export class RegistrySecurityClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly keysTtlMs: number;
  private readonly latestTtlMs: number;
  private keysCache?: { keys: VerifiedSigningKey[]; expiresAt: number };
  private latestCache = new Map<string, { expiresAt: number; value: RegistryVerification }>();

  constructor(options: RegistrySecurityOptions = {}) {
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.keysTtlMs = options.keysTtlMs ?? 5 * 60_000;
    this.latestTtlMs = options.latestTtlMs ?? 60_000;
  }

  clearCache() {
    this.keysCache = undefined;
    this.latestCache.clear();
  }

  private async signingKeys(nowMs: number) {
    if (this.keysCache !== undefined && nowMs < this.keysCache.expiresAt) return this.keysCache.keys;
    try {
      const keys = parseSigningKeys(await requestJson(this.fetchImpl, REGISTRY_KEYS_URL, this.timeoutMs));
      this.keysCache = { keys, expiresAt: nowMs + this.keysTtlMs };
      return keys;
    } catch (error) {
      if (this.keysCache !== undefined && this.keysCache.keys.some((key) => signingKeyUsable(key, nowMs))) return this.keysCache.keys;
      throw error;
    }
  }

  async latest(packageName: string, options: { fresh?: boolean } = {}): Promise<RegistryVerification> {
    const cached = this.latestCache.get(packageName);
    if (options.fresh !== true && cached !== undefined && this.now() < cached.expiresAt) return cached.value;
    try {
      if (packageName.length === 0 || packageName.length > 214 || !PACKAGE_NAME_PATTERN.test(packageName)) invalid("invalid-package");
      const latestUrl = `${REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/latest`;
      const metadata = object(await requestJson(this.fetchImpl, latestUrl, this.timeoutMs), "invalid-metadata", "latest 元数据");
      if (metadata.name !== packageName) invalid("invalid-metadata", "latest 元数据包名不匹配");
      const version = boundedString(metadata.version, 256, "latest 版本");
      const value = await this.verifyVersion(packageName, version);
      this.latestCache.set(packageName, { expiresAt: this.now() + (value.verified ? this.latestTtlMs : 15_000), value });
      return value;
    } catch (error) {
      const value = this.rejected(packageName, error);
      this.latestCache.set(packageName, { expiresAt: this.now() + 15_000, value });
      return value;
    }
  }

  async verifyVersion(packageName: string, version: string, options: { freshKeys?: boolean } = {}): Promise<RegistryVerification> {
    try {
      if (options.freshKeys === true) this.keysCache = undefined;
      this.validatePackage(packageName, version);
      const nowMs = this.now();
      const [metadataInput, keys] = await Promise.all([
        requestJson(this.fetchImpl, packageVersionPath(packageName, version), this.timeoutMs),
        this.signingKeys(nowMs),
      ]);
      const metadata = object(metadataInput, "invalid-metadata", "版本元数据");
      if (metadata.name !== packageName || metadata.version !== version) invalid("invalid-metadata", "元数据包名或版本不匹配");
      const dist = object(metadata.dist, "invalid-metadata", "dist 元数据");
      const { integrity, sha512Hex } = parseIntegrity(dist.integrity);
      const tarball = officialRegistryUrl(dist.tarball, "invalid-tarball", "tarball 地址");
      const signerKeyId = verifyPackageSignature(packageName, version, integrity, dist, keys, nowMs);

      const attestations = object(dist.attestations, "missing-provenance", "dist.attestations");
      const attestationUrl = officialRegistryUrl(attestations.url, "missing-provenance", "attestation 地址");
      const provenanceHint = object(attestations.provenance, "missing-provenance", "provenance 声明");
      if (provenanceHint.predicateType !== SLSA_PROVENANCE_V1) invalid("missing-provenance", "dist 未声明 SLSA v1 provenance");
      let attestationResponse: Record<string, unknown>;
      try { attestationResponse = object(await requestJson(this.fetchImpl, attestationUrl, this.timeoutMs), "invalid-metadata", "attestation 响应"); }
      catch (error) {
        const rejected = this.rejected(packageName, error, version, signerKeyId);
        return rejected;
      }
      if (!Array.isArray(attestationResponse.attestations)) invalid("missing-provenance", "attestation 响应无效");
      const attestation = attestationResponse.attestations
        .map((item) => { try { return object(item, "invalid-provenance", "attestation"); } catch { return undefined; } })
        .find((item) => item?.predicateType === SLSA_PROVENANCE_V1);
      if (attestation === undefined) invalid("missing-provenance");
      let provenance: ProvenanceSummary;
      try { provenance = verifyProvenanceBundle(attestation.bundle, packageName, version, sha512Hex, nowMs); }
      catch (error) {
        const normalized = error instanceof RegistrySecurityError ? error : new RegistrySecurityError("invalid-provenance", error instanceof Error ? error.message : String(error));
        return this.rejected(packageName, normalized, version, signerKeyId);
      }
      return { verified: true, packageName, version, integrity, tarball, signerKeyId, provenanceVerified: true, provenance };
    } catch (error) {
      const normalized = error instanceof RegistrySecurityError
        ? error
        : new RegistrySecurityError("invalid-metadata", error instanceof Error ? error.message : String(error));
      return this.rejected(packageName, normalized, version);
    }
  }

  private validatePackage(packageName: string, version: string) {
    if (packageName.length === 0 || packageName.length > 214 || !PACKAGE_NAME_PATTERN.test(packageName)) invalid("invalid-package");
    if (version.length === 0 || version.length > 256 || !VERSION_PATTERN.test(version)) invalid("invalid-package");
  }

  private rejected(packageName: string, error: unknown, version?: string, signerKeyId?: string): RejectedRegistryPackage {
    const securityError = error instanceof RegistrySecurityError
      ? error
      : new RegistrySecurityError("network", error instanceof Error ? error.message : String(error));
    return {
      verified: false,
      packageName,
      ...version === undefined ? {} : { version },
      ...signerKeyId === undefined ? {} : { signerKeyId },
      provenanceVerified: false,
      code: securityError.code,
      message: securityError.message,
    };
  }
}

export { REGISTRY_ORIGIN, REGISTRY_KEYS_URL, SLSA_PROVENANCE_V1 };
