import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { EncryptedBackupBundle, EncryptedBackupKdfParams } from './types.ts';

export const GPOOL_MASTER_KEY_SERVICE = 'google-one-pool';
export const GPOOL_MASTER_KEY_ACCOUNT = 'master-key';
export const GPOOL_MASTER_KEY_LABEL = 'google-one-pool master key';
export const BACKUP_MIN_PASSPHRASE_LENGTH = 12;
const BACKUP_V2_KDF: EncryptedBackupKdfParams = { N: 131072, r: 8, p: 1 };
const BACKUP_V1_KDF: EncryptedBackupKdfParams = { N: 16384, r: 8, p: 1 };
const SECURITY_BIN = '/usr/bin/security';

export interface CryptoSecurityResult {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type CryptoSecurityRunner = (args: string[], stdin?: string) => CryptoSecurityResult;

export interface CryptoDeps {
  securityRun?: CryptoSecurityRunner;
}

export interface SnapshotSecretPayload {
  keychain_blob_b64: string;
  user_scope: string | null;
  extra_files: Record<string, string>;
}

export interface EncryptedSnapshotEnvelope {
  alg: 'aes-256-gcm';
  iv_b64: string;
  tag_b64: string;
  ciphertext_b64: string;
}

function quoteSecurityInteractiveArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error('Tham số security interactive không được chứa ký tự xuống dòng hoặc NUL.');
  }
  if (/^[a-zA-Z0-9._:/-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Formats an `add-generic-password` interactive stdin command using `-X <hex>` so
 * secret key material and OAuth tokens are never exposed in process command-line arguments.
 */
export function buildAddGenericPasswordStdin(options: {
  service: string;
  account: string;
  label: string;
  data: Buffer;
}): string {
  const tokens = [
    'add-generic-password',
    '-s',
    options.service,
    '-a',
    options.account,
    '-l',
    options.label,
    '-X',
    options.data.toString('hex'),
    '-U',
  ];
  return tokens.map(quoteSecurityInteractiveArg).join(' ') + '\n';
}

function defaultCryptoSecurityRun(args: string[], stdin?: string): CryptoSecurityResult {
  const res = spawnSync(SECURITY_BIN, args, {
    encoding: 'buffer',
    timeout: 15_000,
    ...(stdin !== undefined ? { input: Buffer.from(stdin, 'utf8') } : {}),
  });
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        timedOut
          ? 'security timed out — login keychain có thể đang bị khóa.'
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

function resolveSecurityRun(deps?: CryptoDeps): CryptoSecurityRunner {
  if (deps?.securityRun) return deps.securityRun;
  if (process.platform !== 'darwin') {
    throw new Error('Lưu master key trong macOS Keychain chỉ hỗ trợ trên macOS.');
  }
  return defaultCryptoSecurityRun;
}

function decodeMasterKeyMaterial(raw: string): Buffer | null {
  const clean = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return Buffer.from(clean, 'hex');
  }
  try {
    const buf = Buffer.from(clean, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    // Ignore.
  }
  return null;
}

/**
 * Reads the 32-byte AES-256 master key from macOS Keychain if it exists.
 * Returns null if not yet created.
 */
export function readMasterKeyIfPresent(deps?: CryptoDeps): Buffer | null {
  const run = resolveSecurityRun(deps);
  const res = run([
    'find-generic-password',
    '-s',
    GPOOL_MASTER_KEY_SERVICE,
    '-a',
    GPOOL_MASTER_KEY_ACCOUNT,
    '-w',
  ]);
  if (res.status !== 0) return null;
  return decodeMasterKeyMaterial(res.stdout.toString('utf8'));
}

/**
 * Retrieves the 32-byte AES-256 master key from macOS Keychain, creating and storing
 * a fresh cryptographically random key on first use.
 */
export function getOrCreateMasterKey(deps?: CryptoDeps): Buffer {
  const existing = readMasterKeyIfPresent(deps);
  if (existing) return existing;

  const run = resolveSecurityRun(deps);
  const key = crypto.randomBytes(32);
  const stdinCmd = buildAddGenericPasswordStdin({
    service: GPOOL_MASTER_KEY_SERVICE,
    account: GPOOL_MASTER_KEY_ACCOUNT,
    label: GPOOL_MASTER_KEY_LABEL,
    data: Buffer.from(key.toString('hex'), 'utf8'),
  });
  const res = run(['-i'], stdinCmd);
  if (res.status !== 0) {
    const detail = res.stderr.toString('utf8').trim();
    throw new Error(`Không tạo được master key mã hóa trong Keychain: ${detail || `mã lỗi ${res.status}`}`);
  }
  return key;
}

/**
 * Encrypts sensitive agy session secret fields with AES-256-GCM bound to the account alias via AAD.
 */
export function encryptSnapshotSecret(
  payload: SnapshotSecretPayload,
  masterKey: Buffer,
  alias: string,
): EncryptedSnapshotEnvelope {
  if (masterKey.length !== 32) {
    throw new Error('Master key AES-256 phải dài đúng 32 byte.');
  }
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(`gpool-agy-session:v2:${alias}`, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    iv_b64: iv.toString('base64'),
    tag_b64: tag.toString('base64'),
    ciphertext_b64: encrypted.toString('base64'),
  };
}

/**
 * Decrypts a v2 encrypted agy snapshot secret payload and verifies GCM authentication tag & alias AAD.
 */
export function decryptSnapshotSecret(
  envelope: EncryptedSnapshotEnvelope,
  masterKey: Buffer,
  alias: string,
): SnapshotSecretPayload {
  if (masterKey.length !== 32) {
    throw new Error('Master key AES-256 phải dài đúng 32 byte.');
  }
  const iv = Buffer.from(envelope.iv_b64, 'base64');
  const tag = Buffer.from(envelope.tag_b64, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext_b64, 'base64');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error(
      `Không giải mã được snapshot agy của "${alias}" (IV hoặc GCM authentication tag không hợp lệ).`,
    );
  }
  const aad = Buffer.from(`gpool-agy-session:v2:${alias}`, 'utf8');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as SnapshotSecretPayload;
    if (typeof parsed.keychain_blob_b64 !== 'string') {
      throw new Error('Dữ liệu giải mã thiếu keychain_blob_b64.');
    }
    return parsed;
  } catch {
    throw new Error(
      `Không giải mã được snapshot agy của "${alias}" (master key không khớp hoặc file đã bị sửa đổi).`,
    );
  }
}

/**
 * Encrypts a portable pool backup payload (metadata + optional agy sessions) using scrypt + AES-256-GCM.
 */
export function encryptBackupBundle(
  payload: unknown,
  passphrase: string,
  includesSessions: boolean,
): EncryptedBackupBundle {
  const pass = passphrase ?? '';
  if (pass.length < BACKUP_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Mật khẩu mã hóa backup phải dài ít nhất ${BACKUP_MIN_PASSPHRASE_LENGTH} ký tự.`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const kdfParams = { ...BACKUP_V2_KDF };
  const key = crypto.scryptSync(pass, salt, 32, {
    ...kdfParams,
    maxmem: 256 * 1024 * 1024,
  });
  const aad = Buffer.from('gpool-encrypted-backup:v2', 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: 'gpool-encrypted-backup',
    version: 2,
    kdf: 'scrypt',
    kdf_params: kdfParams,
    alg: 'aes-256-gcm',
    salt_b64: salt.toString('base64'),
    iv_b64: iv.toString('base64'),
    tag_b64: tag.toString('base64'),
    includes_sessions: includesSessions,
    exported_at: new Date().toISOString(),
    ciphertext_b64: ciphertext.toString('base64'),
  };
}

function validateKdfParams(params: unknown): EncryptedBackupKdfParams {
  if (!params || typeof params !== 'object') {
    throw new Error('Tham số KDF của file backup không hợp lệ.');
  }
  const obj = params as Record<string, unknown>;
  const N = obj.N;
  const r = obj.r;
  const p = obj.p;
  const isPow2 = typeof N === 'number' && Number.isInteger(N) && N >= 16384 && N <= 262144 && (N & (N - 1)) === 0;
  if (
    !isPow2 ||
    typeof r !== 'number' ||
    !Number.isInteger(r) ||
    r < 1 ||
    r > 16 ||
    typeof p !== 'number' ||
    !Number.isInteger(p) ||
    p < 1 ||
    p > 4
  ) {
    throw new Error('Tham số scrypt KDF trong file backup nằm ngoài ngưỡng an toàn cho phép.');
  }
  return { N, r, p };
}

/**
 * Decrypts a passphrase-encrypted portable pool backup bundle (supports v1 and v2).
 */
export function decryptBackupBundle<T = unknown>(bundle: EncryptedBackupBundle, passphrase: string): T {
  if (!isEncryptedBackupBundle(bundle)) {
    throw new Error('Định dạng file backup mã hóa không hợp lệ.');
  }
  const pass = passphrase ?? '';
  if (!pass) {
    throw new Error('Cần nhập mật khẩu (--passphrase-file hoặc nhập tương tác) để giải mã file backup này.');
  }

  const salt = Buffer.from(bundle.salt_b64, 'base64');
  const iv = Buffer.from(bundle.iv_b64, 'base64');
  const tag = Buffer.from(bundle.tag_b64, 'base64');
  const ciphertext = Buffer.from(bundle.ciphertext_b64, 'base64');
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('File backup mã hóa không hợp lệ (salt/IV/tag bị hỏng).');
  }

  const kdfParams = bundle.version === 2 ? validateKdfParams(bundle.kdf_params) : BACKUP_V1_KDF;
  const requiredMem = 128 * kdfParams.N * kdfParams.r;
  const key = crypto.scryptSync(pass, salt, 32, {
    ...kdfParams,
    maxmem: Math.max(256 * 1024 * 1024, requiredMem * 2),
  });
  const aad = Buffer.from(`gpool-encrypted-backup:v${bundle.version}`, 'utf8');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error('Sai mật khẩu giải mã hoặc file backup đã bị hỏng.');
  }
}

export function isEncryptedBackupBundle(value: unknown): value is EncryptedBackupBundle {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const validVersion = obj.version === 1 || obj.version === 2;
  if (!validVersion) return false;
  if (obj.version === 2 && (!obj.kdf_params || typeof obj.kdf_params !== 'object')) {
    return false;
  }
  return (
    obj.format === 'gpool-encrypted-backup' &&
    obj.alg === 'aes-256-gcm' &&
    typeof obj.salt_b64 === 'string' &&
    typeof obj.iv_b64 === 'string' &&
    typeof obj.tag_b64 === 'string' &&
    typeof obj.ciphertext_b64 === 'string'
  );
}
