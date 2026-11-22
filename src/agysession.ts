import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgyLease } from './agylock.ts';
import type { PoolPaths } from './config.ts';
import type { AccountRecord, AgyHealthEntry, AgyHealthReport, RenewalAlert } from './types.ts';

/**
 * agy CLI session swapper.
 *
 * agy lưu phiên đăng nhập Google trong macOS Keychain qua zalando/go-keyring
 * (shell ra /usr/bin/security): generic password service "gemini", account
 * "antigravity". Module này snapshot/restore item đó theo từng tài khoản pool,
 * kèm file "credential-user-scope" và các file secrets fallback của agy, để
 * đổi tài khoản agy mà không cần đăng nhập lại.
 */

export const AGY_KEYCHAIN_SERVICE = 'gemini';
export const AGY_KEYCHAIN_ACCOUNT = 'antigravity';
export const AGY_KEYCHAIN_LABEL = 'gemini';
const SECURITY_BIN = '/usr/bin/security';
const PGREP_BIN = '/usr/bin/pgrep';
const MAX_SECRET_FILE_BYTES = 512 * 1024;

const AGY_SCOPE_RELATIVE = path.join(
  'Library',
  'Application Support',
  'Antigravity',
  'credential-user-scope',
);
const AGY_CLI_DIR_RELATIVE = path.join('.gemini', 'antigravity-cli');
const AGY_SECRET_FILE_CANDIDATES = [
  'antigravity-oauth-token',
  'secrets.json',
  'auth-secrets.json',
  'private-secrets.json',
];

const ACTIVE_MARKER_FILE = '_active.json';
const ORPHAN_SNAPSHOT_FILE = '_orphan.json';

export interface SecurityRunResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type SecurityRunner = (args: string[]) => SecurityRunResult;
export type ProcessLister = () => string[];

export interface AccountRecordLike {
  alias: string;
  email: string;
}

export interface AgySessionDeps {
  securityRun?: SecurityRunner;
  listClients?: ProcessLister;
  osHome?: string;
}

export interface AgySessionSnapshot {
  version: 1;
  alias: string;
  detected_email: string | null;
  captured_at: string;
  blob_sha256: string;
  keychain_blob_b64: string;
  user_scope: string | null;
  extra_files: Record<string, string>;
}

export interface AgyCaptureResult {
  ok: true;
  alias: string;
  captured_at: string;
  detected_email: string | null;
  blob_sha256: string;
  warning?: string;
}

export interface AgyActivateResult {
  ok: true;
  alias: string;
  recaptured_alias: string | null;
  orphan_saved: boolean;
  skipped_running_check?: boolean;
}

export interface AgySessionMeta {
  alias: string;
  captured_at: string;
  detected_email: string | null;
  blob_sha256: string;
}

export interface AgyStatusResult {
  keychain_present: boolean;
  live_owner_alias: string | null;
  live_unknown: boolean;
  marker_alias: string | null;
  running_clients: string[];
  sessions: Array<AgySessionMeta & { is_live: boolean }>;
}

export interface AgySessionInfo {
  captured: boolean;
  captured_at: string | null;
  detected_email: string | null;
  is_live_owner: boolean;
  active_alias: string | null;
}

export interface LiveKeychainContext {
  present: boolean;
  live_sha: string | null;
  live_email: string | null;
  live_owner_alias: string | null;
  live_unknown: boolean;
  marker_alias: string | null;
}

function sessionsDir(paths: PoolPaths): string {
  return paths.agySessionsDir;
}

function snapshotFilePath(paths: PoolPaths, alias: string): string {
  return path.join(sessionsDir(paths), `${alias}.json`);
}

function markerFilePath(paths: PoolPaths): string {
  return path.join(sessionsDir(paths), ACTIVE_MARKER_FILE);
}

function orphanFilePath(paths: PoolPaths): string {
  return path.join(sessionsDir(paths), ORPHAN_SNAPSHOT_FILE);
}

function ensureSessionsDir(paths: PoolPaths): void {
  const dir = sessionsDir(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort.
  }
}

function defaultSecurityRun(args: string[]): SecurityRunResult {
  // `security` có thể bật dialog GUI "unlock login keychain" và treo vô hạn nếu
  // keychain bị lock — timeout để daemon/CLI không bị đơ.
  const res = spawnSync(SECURITY_BIN, args, { encoding: 'buffer', timeout: 15_000 });
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        timedOut
          ? 'security timed out — login keychain có thể đang bị khóa (dialog mở khóa chưa được trả lời).'
          : String(res.error),
      ),
    };
  }
  return {
    status: res.status ?? 1,
    stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? ''),
    stderr: Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.from(res.stderr ?? ''),
  };
}

function defaultProcessLister(): string[] {
  const names: string[] = [];
  const pushMatches = (label: string, args: string[]) => {
    const res = spawnSync(PGREP_BIN, args, { encoding: 'utf8' });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim()) {
      const pids = res.stdout.trim().split(/\s+/).slice(0, 5).join(',');
      names.push(`${label} (PID ${pids})`);
    }
  };
  pushMatches('agy CLI', ['-x', 'agy']);
  pushMatches('Antigravity app', ['-x', 'Antigravity']);
  pushMatches('Antigravity app', ['-f', 'Antigravity\\.app/Contents/MacOS']);
  return names;
}

function resolveDeps(deps?: AgySessionDeps): Required<AgySessionDeps> {
  const resolved: Required<AgySessionDeps> = {
    securityRun: deps?.securityRun ?? defaultSecurityRun,
    listClients: deps?.listClients ?? defaultProcessLister,
    osHome: deps?.osHome ?? os.homedir(),
  };
  if (!deps?.securityRun && process.platform !== 'darwin') {
    throw new Error('Quản lý phiên agy qua Keychain chỉ hỗ trợ macOS.');
  }
  return resolved;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Reads the agy credential blob from the login keychain. Returns null when the
 * item does not exist. Trailing newline emitted by `security -w` is stripped.
 */
export function readKeychainBlob(deps?: AgySessionDeps): Buffer | null {
  const { securityRun } = resolveDeps(deps);
  const res = securityRun([
    'find-generic-password',
    '-s',
    AGY_KEYCHAIN_SERVICE,
    '-a',
    AGY_KEYCHAIN_ACCOUNT,
    '-w',
  ]);
  if (res.status !== 0) {
    return null;
  }
  let blob = res.stdout;
  if (blob.length > 0 && blob[blob.length - 1] === 0x0a) {
    blob = blob.subarray(0, blob.length - 1);
  }
  return blob;
}

/**
 * Writes a credential blob back into the login keychain, updating the existing
 * item (-U) and keeping the same label that agy writes ("gemini").
 */
export function writeKeychainBlob(blob: Buffer, deps?: AgySessionDeps): void {
  const { securityRun } = resolveDeps(deps);
  const text = blob.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(blob)) {
    throw new Error('Credential blob không phải UTF-8 hợp lệ — chưa hỗ trợ ghi đè dạng binary.');
  }
  const res = securityRun([
    'add-generic-password',
    '-s',
    AGY_KEYCHAIN_SERVICE,
    '-a',
    AGY_KEYCHAIN_ACCOUNT,
    '-l',
    AGY_KEYCHAIN_LABEL,
    '-w',
    text,
    '-U',
  ]);
  if (res.status !== 0) {
    const detail = res.stderr.toString('utf8').trim();
    throw new Error(`Không ghi được phiên vào Keychain: ${detail || `mã lỗi ${res.status}`}`);
  }
}

/**
 * Lists agy-related processes currently running (they cache the credential in
 * memory and would overwrite the keychain item on refresh/exit).
 */
export function listRunningAgyClients(deps?: AgySessionDeps): string[] {
  const { listClients } = resolveDeps(deps);
  return listClients();
}

function scopeFilePath(osHome: string): string {
  return path.join(osHome, AGY_SCOPE_RELATIVE);
}

function readUserScope(osHome: string): string | null {
  try {
    const raw = fs.readFileSync(scopeFilePath(osHome));
    return raw.toString('utf8');
  } catch {
    return null;
  }
}

function writeUserScope(osHome: string, value: string | null): void {
  const file = scopeFilePath(osHome);
  if (value === null) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Không có file thì thôi.
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
}

function collectExtraSecretFiles(osHome: string): Record<string, string> {
  const dir = path.join(osHome, AGY_CLI_DIR_RELATIVE);
  const out: Record<string, string> = {};
  for (const name of AGY_SECRET_FILE_CANDIDATES) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= MAX_SECRET_FILE_BYTES) {
        out[name] = fs.readFileSync(file).toString('base64');
      }
    } catch {
      // File không tồn tại — bỏ qua.
    }
  }
  return out;
}

function restoreExtraSecretFiles(osHome: string, files: Record<string, string>): void {
  const dir = path.join(osHome, AGY_CLI_DIR_RELATIVE);
  for (const [name, b64] of Object.entries(files)) {
    if (!AGY_SECRET_FILE_CANDIDATES.includes(name)) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
}

function detectEmailInBlob(blob: Buffer): string | null {
  let text = blob.toString('utf8');
  // go-keyring bọc payload dạng "go-keyring-base64:<b64(JSON)>"; JSON trong có
  // field id_token_email — giải lớp bọc trước khi soi email.
  if (text.startsWith('go-keyring-base64:')) {
    try {
      const inner = JSON.parse(Buffer.from(text.slice('go-keyring-base64:'.length).trim(), 'base64').toString('utf8')) as Record<string, unknown>;
      if (typeof inner.id_token_email === 'string' && inner.id_token_email.includes('@')) {
        return inner.id_token_email.toLowerCase();
      }
      text = JSON.stringify(inner);
    } catch {
      // Fall through to regex on raw text.
    }
  }
  const match = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.exec(text);
  return match ? match[0].toLowerCase() : null;
}

function loadSnapshot(paths: PoolPaths, alias: string): AgySessionSnapshot | null {
  const file = snapshotFilePath(paths, alias);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AgySessionSnapshot;
    if (parsed.version !== 1 || typeof parsed.keychain_blob_b64 !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasSessionSnapshot(paths: PoolPaths, alias: string): boolean {
  return loadSnapshot(paths, alias) !== null;
}

function writeSnapshotFile(filePath: string, snapshot: AgySessionSnapshot): void {
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function readMarker(paths: PoolPaths): { alias: string; updated_at: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFilePath(paths), 'utf8')) as {
      alias?: string;
      updated_at?: string;
    };
    return typeof parsed.alias === 'string' && parsed.alias
      ? { alias: parsed.alias, updated_at: parsed.updated_at ?? '' }
      : null;
  } catch {
    return null;
  }
}

function writeMarker(paths: PoolPaths, alias: string): void {
  ensureSessionsDir(paths);
  fs.writeFileSync(
    markerFilePath(paths),
    JSON.stringify({ alias, updated_at: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
}

/**
 * Returns alias -> session metadata for every snapshot stored by gpool.
 */
export function listSessionMetas(paths: PoolPaths): Map<string, AgySessionMeta> {
  const dir = sessionsDir(paths);
  const out = new Map<string, AgySessionMeta>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const snap = loadSnapshot(paths, name.slice(0, -'.json'.length));
    if (snap) {
      out.set(snap.alias, {
        alias: snap.alias,
        captured_at: snap.captured_at,
        detected_email: snap.detected_email,
        blob_sha256: snap.blob_sha256,
      });
    }
  }
  return out;
}

function findSnapshotAliasBySha(paths: PoolPaths, sha: string): string | null {
  for (const meta of listSessionMetas(paths).values()) {
    if (meta.blob_sha256 === sha) return meta.alias;
  }
  return null;
}

function buildSnapshotFromLive(
  alias: string,
  blob: Buffer,
  osHome: string,
): AgySessionSnapshot {
  return {
    version: 1,
    alias,
    detected_email: detectEmailInBlob(blob),
    captured_at: new Date().toISOString(),
    blob_sha256: sha256Hex(blob),
    keychain_blob_b64: blob.toString('base64'),
    user_scope: readUserScope(osHome),
    extra_files: collectExtraSecretFiles(osHome),
  };
}

/**
 * Captures the agy credential currently stored in the login keychain and saves
 * it as this account's session. Refuses when the credential clearly belongs to
 * a different Google account (email detected inside the blob mismatches).
 */
export function captureAgySession(
  paths: PoolPaths,
  account: AccountRecordLike,
  deps?: AgySessionDeps,
): AgyCaptureResult {
  const { osHome } = resolveDeps(deps);
  const blob = readKeychainBlob(deps);
  if (!blob) {
    throw new Error(
      `Chưa thấy phiên agy trong Keychain (item "${AGY_KEYCHAIN_SERVICE}"/"${AGY_KEYCHAIN_ACCOUNT}"). ` +
        'Hãy đăng nhập trong agy trước rồi chạy lại lệnh này.',
    );
  }

  const snapshot = buildSnapshotFromLive(account.alias, blob, osHome);
  let warning: string | undefined;
  if (snapshot.detected_email && snapshot.detected_email !== account.email.toLowerCase()) {
    throw new Error(
      `Phiên agy trong Keychain đang thuộc "${snapshot.detected_email}", không khớp tài khoản ` +
        `"${account.alias}" (${account.email}). Hãy đăng nhập agy bằng đúng tài khoản rồi capture lại.`,
    );
  }
  if (!snapshot.detected_email) {
    warning = 'Không đọc được email trong credential — đã lưu nguyên trạng, hãy chắc agy đang đúng tài khoản.';
  }

  ensureSessionsDir(paths);
  writeSnapshotFile(snapshotFilePath(paths, account.alias), snapshot);
  writeMarker(paths, account.alias);

  return {
    ok: true,
    alias: account.alias,
    captured_at: snapshot.captured_at,
    detected_email: snapshot.detected_email,
    blob_sha256: snapshot.blob_sha256,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Restores an account's captured agy session into the login keychain.
 *
 * - Từ chối khi agy / Antigravity đang chạy (chúng rewrite keychain lúc refresh).
 * - Trước khi ghi đè: nếu item hiện tại thuộc acc khác đã biết (khớp sha hoặc
 *   marker), snapshot của acc đó được cập nhật lại (token refresh drift). Nếu
 *   không rõ chủ, lưu dự phòng vào _orphan.json thay vì mất phiên.
 */
export function activateAgySession(
  paths: PoolPaths,
  account: AccountRecordLike,
  options: { force?: boolean } = {},
  deps?: AgySessionDeps,
): AgyActivateResult {
  const { osHome } = resolveDeps(deps);
  const snapshot = loadSnapshot(paths, account.alias);
  if (!snapshot) {
    throw new Error(
      `Tài khoản "${account.alias}" chưa có phiên agy đã lưu. ` +
        `Đăng nhập agy bằng đúng tài khoản rồi chạy "gpool agy-capture ${account.alias}".`,
    );
  }

  const running = listRunningAgyClients(deps);
  if (running.length > 0 && !options.force) {
    throw new Error(
      `Đang có tiến trình agy chạy (${running.join('; ')}). ` +
        'Chúng giữ credential trong RAM và sẽ ghi đè Keychain lúc refresh — hãy đóng hẳn agy/Antigravity rồi chạy lại, ' +
        'hoặc dùng --force nếu chắc chắn.',
    );
  }

  const current = readKeychainBlob(deps);
  let recapturedAlias: string | null = null;
  let orphanSaved = false;

  if (current) {
    const currentSha = sha256Hex(current);
    const marker = readMarker(paths);
    let ownerAlias = findSnapshotAliasBySha(paths, currentSha) ?? marker?.alias ?? null;

    // Nếu blob hiện tại detect được email khác chủ snapshot -> chủ thực sự
    // không rõ (user có thể đã login tay acc khác): lưu orphan thay vì ghi đè
    // nhầm snapshot.
    if (ownerAlias) {
      const ownerSnap = loadSnapshot(paths, ownerAlias);
      const liveEmail = detectEmailInBlob(current);
      if (ownerSnap?.detected_email && liveEmail && ownerSnap.detected_email !== liveEmail) {
        ownerAlias = null;
      }
    }

    if (ownerAlias && ownerAlias !== account.alias) {
      const refreshed = buildSnapshotFromLive(ownerAlias, current, osHome);
      writeSnapshotFile(snapshotFilePath(paths, ownerAlias), refreshed);
      recapturedAlias = ownerAlias;
    } else if (!ownerAlias || ownerAlias !== account.alias) {
      writeSnapshotFile(orphanFilePath(paths), buildSnapshotFromLive('_orphan', current, osHome));
      orphanSaved = true;
    }
  }

  writeKeychainBlob(Buffer.from(snapshot.keychain_blob_b64, 'base64'), deps);
  writeUserScope(osHome, snapshot.user_scope);
  restoreExtraSecretFiles(osHome, snapshot.extra_files);
  writeMarker(paths, account.alias);

  return {
    ok: true,
    alias: account.alias,
    recaptured_alias: recapturedAlias,
    orphan_saved: orphanSaved,
    ...(running.length > 0 ? { skipped_running_check: true } : {}),
  };
}

export function getLiveKeychainContext(paths: PoolPaths, deps?: AgySessionDeps): LiveKeychainContext {
  resolveDeps(deps);
  const current = readKeychainBlob(deps);
  const metas = [...listSessionMetas(paths).values()];
  const marker = readMarker(paths);
  const markerAlias = marker?.alias ?? null;

  if (!current) {
    return {
      present: false,
      live_sha: null,
      live_email: null,
      live_owner_alias: null,
      live_unknown: false,
      marker_alias: markerAlias,
    };
  }

  const liveSha = sha256Hex(current);
  const liveEmail = detectEmailInBlob(current);

  let ownerAlias: string | null = metas.find((m) => m.blob_sha256 === liveSha)?.alias ?? null;

  if (!ownerAlias && liveEmail) {
    const emailMatches = metas.filter((m) => m.detected_email?.toLowerCase() === liveEmail);
    if (emailMatches.length > 0) {
      ownerAlias = emailMatches.find((m) => m.alias === markerAlias)?.alias ?? emailMatches[0].alias;
    }
  }

  if (!ownerAlias && markerAlias) {
    const markerMeta = metas.find((m) => m.alias === markerAlias);
    if (markerMeta) {
      const emailMismatches =
        Boolean(markerMeta.detected_email && liveEmail) &&
        markerMeta.detected_email!.toLowerCase() !== liveEmail;
      if (!emailMismatches) {
        ownerAlias = markerAlias;
      }
    }
  }

  return {
    present: true,
    live_sha: liveSha,
    live_email: liveEmail,
    live_owner_alias: ownerAlias,
    live_unknown: ownerAlias === null,
    marker_alias: markerAlias,
  };
}

export function getAgySessionStatus(paths: PoolPaths, deps?: AgySessionDeps): AgyStatusResult {
  const ctx = getLiveKeychainContext(paths, deps);
  const metas = [...listSessionMetas(paths).values()];

  return {
    keychain_present: ctx.present,
    live_owner_alias: ctx.live_owner_alias,
    live_unknown: ctx.live_unknown,
    marker_alias: ctx.marker_alias,
    running_clients: listRunningAgyClients(deps),
    sessions: metas
      .map((m) => ({
        ...m,
        is_live:
          ctx.present &&
          ((ctx.live_sha !== null && m.blob_sha256 === ctx.live_sha) || ctx.live_owner_alias === m.alias),
      }))
      .sort((a, b) => b.captured_at.localeCompare(a.captured_at)),
  };
}

/**
 * Per-account session info for views (dashboard / gpool show).
 */
export function sessionInfoForAlias(
  paths: PoolPaths,
  alias: string,
  liveSha: string | null,
  markerAlias: string | null,
  liveOwnerAlias?: string | null,
): AgySessionInfo | null {
  const snap = loadSnapshot(paths, alias);
  if (!snap) return null;
  const isLiveOwner =
    liveOwnerAlias !== undefined
      ? liveOwnerAlias === alias
      : liveSha !== null && snap.blob_sha256 === liveSha;
  return {
    captured: true,
    captured_at: snap.captured_at,
    detected_email: snap.detected_email,
    is_live_owner: isLiveOwner,
    active_alias: liveOwnerAlias !== undefined ? liveOwnerAlias : markerAlias,
  };
}

/**
 * SHA-256 of the credential currently in the login keychain (one security call,
 * for decorating many account views at once).
 */
export function liveBlobSha(paths: PoolPaths, deps?: AgySessionDeps): string | null {
  void paths;
  const blob = readKeychainBlob(deps);
  return blob ? sha256Hex(blob) : null;
}

export function readMarkerAlias(paths: PoolPaths): string | null {
  return readMarker(paths)?.alias ?? null;
}

/**
 * Returns the set of aliases that have a valid stored agy session snapshot.
 */
export function listCapturedAliases(paths: PoolPaths): Set<string> {
  return new Set(listSessionMetas(paths).keys());
}

interface ParsedBlobMetadata {
  valid: boolean;
  detected_email: string | null;
  has_refresh_token: boolean;
  has_access_token: boolean;
  token_expiry: string | null;
  auth_method: string | null;
}

function inspectBlobMetadata(blob: Buffer): ParsedBlobMetadata {
  const text = blob.toString('utf8').trim();
  if (!text) {
    return {
      valid: false,
      detected_email: null,
      has_refresh_token: false,
      has_access_token: false,
      token_expiry: null,
      auth_method: null,
    };
  }

  let jsonText = text;
  if (text.startsWith('go-keyring-base64:')) {
    try {
      jsonText = Buffer.from(text.slice('go-keyring-base64:'.length).trim(), 'base64').toString('utf8');
    } catch {
      return {
        valid: false,
        detected_email: null,
        has_refresh_token: false,
        has_access_token: false,
        token_expiry: null,
        auth_method: null,
      };
    }
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const tokenObj =
      parsed.token && typeof parsed.token === 'object' ? (parsed.token as Record<string, unknown>) : parsed;
    const access = typeof tokenObj.access_token === 'string' && tokenObj.access_token.trim().length > 0;
    const refresh = typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token.trim().length > 0;
    const expiry = typeof tokenObj.expiry === 'string' && tokenObj.expiry.trim() ? tokenObj.expiry.trim() : null;
    const authMethod =
      typeof parsed.auth_method === 'string' && parsed.auth_method.trim() ? parsed.auth_method.trim() : null;
    const email = detectEmailInBlob(blob);
    return {
      valid: access || refresh,
      detected_email: email,
      has_refresh_token: refresh,
      has_access_token: access,
      token_expiry: expiry,
      auth_method: authMethod,
    };
  } catch {
    // Non-JSON opaque credential blob (still treat as valid if non-empty)
    return {
      valid: text.length > 8,
      detected_email: detectEmailInBlob(blob),
      has_refresh_token: text.includes('refresh_token'),
      has_access_token: text.length > 8,
      token_expiry: null,
      auth_method: null,
    };
  }
}

/**
 * Inspects health of all accounts' stored `agy` session snapshots without exposing
 * secret values, combined with active Keychain owner, lease status, and renewal alerts.
 */
export function inspectAgyHealth(
  paths: PoolPaths,
  accounts: AccountRecord[],
  renewalAlerts: RenewalAlert[] = [],
  deps?: AgySessionDeps,
): AgyHealthReport {
  let ctx: LiveKeychainContext | null = null;
  let runningClients: string[] = [];
  try {
    ctx = getLiveKeychainContext(paths, deps);
    runningClients = listRunningAgyClients(deps);
  } catch {
    ctx = null;
    runningClients = [];
  }

  const nowMs = Date.now();
  const entries: AgyHealthEntry[] = [];

  for (const acc of accounts) {
    const snap = loadSnapshot(paths, acc.alias);
    if (!snap) {
      entries.push({
        alias: acc.alias,
        email: acc.email,
        plan_tier: acc.plan_tier,
        captured: false,
        captured_at: null,
        detected_email: null,
        email_matches: false,
        has_refresh_token: false,
        token_expiry: null,
        access_token_expired: null,
        auth_method: null,
        health: 'missing_snapshot',
        detail: `Chưa lưu phiên agy — đăng nhập agy rồi chạy "gpool agy-capture ${acc.alias}"`,
        is_live: false,
      });
      continue;
    }

    let blob: Buffer;
    try {
      blob = Buffer.from(snap.keychain_blob_b64, 'base64');
    } catch {
      blob = Buffer.alloc(0);
    }

    const meta = inspectBlobMetadata(blob);
    const detectedEmail = meta.detected_email ?? snap.detected_email;
    const emailMatches = !detectedEmail || detectedEmail.toLowerCase() === acc.email.toLowerCase();
    const expiryMs = meta.token_expiry ? Date.parse(meta.token_expiry) : NaN;
    const accessExpired = Number.isNaN(expiryMs) ? null : expiryMs <= nowMs;
    const isLive = Boolean(ctx?.present && ctx.live_owner_alias === acc.alias);

    let health: AgyHealthEntry['health'];
    let detail: string;
    if (!meta.valid) {
      health = 'corrupt';
      detail = 'Snapshot không hợp lệ hoặc thiếu token — hãy đăng nhập agy và capture lại.';
    } else if (!emailMatches) {
      health = 'email_mismatch';
      detail = `Email trong snapshot (${detectedEmail}) không khớp tài khoản (${acc.email}).`;
    } else if (accessExpired && !meta.has_refresh_token) {
      health = 'corrupt';
      detail = 'Access token đã hết hạn và không có refresh_token — cần login lại.';
    } else if (accessExpired) {
      health = 'needs_refresh';
      detail = 'Access token đã hết hạn nhưng có refresh_token (agy sẽ tự làm mới khi chạy).';
    } else {
      health = 'healthy';
      detail = meta.has_refresh_token
        ? 'Snapshot khỏe mạnh (có refresh_token & access_token còn hạn).'
        : 'Snapshot hợp lệ.';
    }

    entries.push({
      alias: acc.alias,
      email: acc.email,
      plan_tier: acc.plan_tier,
      captured: true,
      captured_at: snap.captured_at,
      detected_email: detectedEmail,
      email_matches: emailMatches,
      has_refresh_token: meta.has_refresh_token,
      token_expiry: meta.token_expiry,
      access_token_expired: accessExpired,
      auth_method: meta.auth_method,
      health,
      detail,
      is_live: isLive,
    });
  }

  return {
    checked_at: new Date(nowMs).toISOString(),
    keychain_present: ctx?.present ?? false,
    live_owner_alias: ctx?.live_owner_alias ?? null,
    running_clients: runningClients,
    lease: readAgyLease(paths),
    summary: {
      total: entries.length,
      healthy: entries.filter((e) => e.health === 'healthy').length,
      needs_refresh: entries.filter((e) => e.health === 'needs_refresh').length,
      missing_snapshot: entries.filter((e) => e.health === 'missing_snapshot').length,
      issues: entries.filter((e) => e.health === 'corrupt' || e.health === 'email_mismatch').length,
      renewal_alerts: renewalAlerts.length,
    },
    accounts: entries,
    renewal_alerts: renewalAlerts,
  };
}

/**
 * Renames a stored agy session snapshot (and active marker) when an account alias changes.
 */
export function renameSessionFilesForAlias(paths: PoolPaths, oldAlias: string, newAlias: string): void {
  if (oldAlias === newAlias) return;
  const snap = loadSnapshot(paths, oldAlias);
  if (snap) {
    ensureSessionsDir(paths);
    writeSnapshotFile(snapshotFilePath(paths, newAlias), { ...snap, alias: newAlias });
    try {
      fs.unlinkSync(snapshotFilePath(paths, oldAlias));
    } catch {
      // Best-effort cleanup.
    }
  }
  const marker = readMarker(paths);
  if (marker?.alias === oldAlias) {
    writeMarker(paths, newAlias);
  }
}

/**
 * Removes an account's stored agy session (called when the account is deleted).
 */
export function deleteSessionFilesForAlias(paths: PoolPaths, alias: string): void {
  const file = snapshotFilePath(paths, alias);
  try {
    fs.unlinkSync(file);
  } catch {
    // Không có snapshot thì thôi.
  }
  const marker = readMarker(paths);
  if (marker?.alias === alias) {
    try {
      fs.unlinkSync(markerFilePath(paths));
    } catch {
      // Best-effort.
    }
  }
}
