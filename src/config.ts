import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonSettings, Locale, PlanTier, RotationPolicy } from './types.ts';

export const DEFAULT_PORT = 47891;
export const DEFAULT_HOST = '127.0.0.1';

const ALLOWED_CHROME_BIN_NAMES = new Set([
  'google chrome',
  'google chrome canary',
  'google chrome beta',
  'google chrome dev',
  'brave browser',
  'brave browser beta',
  'brave browser nightly',
  'chromium',
  'microsoft edge',
  'vivaldi',
  'chrome',
  'google-chrome',
  'google-chrome-stable',
  'brave-browser',
  'chromium-browser',
  'msedge',
  'ungoogled-chromium',
]);

export const VALID_PLAN_TIERS: readonly PlanTier[] = [
  'Google AI Pro',
  'Google AI Ultra',
  'Free',
  'Enterprise',
];

export const VALID_ROTATION_POLICIES: readonly RotationPolicy[] = [
  'lru',
  'round-robin',
  'tier-first',
];

export const VALID_LOCALES: readonly Locale[] = ['vi', 'en'];

export interface PoolPaths {
  homeDir: string;
  dbPath: string;
  chromeProfilesDir: string;
  geminiHomesDir: string;
  agySessionsDir: string;
  agyLockPath: string;
  pidPath: string;
  logPath: string;
  tokenPath: string;
}

/**
 * Resolves all local data paths under GPOOL_HOME (defaulting to ~/.google-one-pool).
 */
export function resolvePaths(homeOverride?: string): PoolPaths {
  const rawHome = homeOverride ?? process.env.GPOOL_HOME ?? path.join(os.homedir(), '.google-one-pool');
  const homeDir = path.resolve(rawHome);
  return {
    homeDir,
    dbPath: path.join(homeDir, 'pool.db'),
    chromeProfilesDir: path.join(homeDir, 'chrome-profiles'),
    geminiHomesDir: path.join(homeDir, 'gemini-homes'),
    agySessionsDir: path.join(homeDir, 'agy-sessions'),
    agyLockPath: path.join(homeDir, 'agy.lock'),
    pidPath: path.join(homeDir, 'daemon.pid'),
    logPath: path.join(homeDir, 'daemon.log'),
    tokenPath: path.join(homeDir, 'daemon.token'),
  };
}

/**
 * Writes a file and explicitly enforces owner-only permissions (0o600), including pre-existing files.
 */
export function writeFileRestricted(filePath: string, data: string | Buffer): void {
  if (typeof data === 'string') {
    fs.writeFileSync(filePath, data, { encoding: 'utf8', mode: 0o600 });
  } else {
    fs.writeFileSync(filePath, data, { mode: 0o600 });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms without POSIX chmod.
  }
}

/**
 * Reads the persisted daemon bearer token from `daemon.token`, returning null if missing or malformed.
 */
export function readDaemonToken(paths: PoolPaths): string | null {
  try {
    const raw = fs.readFileSync(paths.tokenPath, 'utf8').trim();
    return /^[0-9a-f]{64}$/i.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Loads or generates the 256-bit local daemon API authentication token stored with mode 0o600.
 */
export function ensureDaemonToken(paths: PoolPaths): string {
  ensureDirectories(paths);
  const existing = readDaemonToken(paths);
  if (existing) {
    try {
      fs.chmodSync(paths.tokenPath, 0o600);
    } catch {
      // Best-effort.
    }
    return existing;
  }
  const token = crypto.randomBytes(32).toString('hex');
  writeFileRestricted(paths.tokenPath, token + '\n');
  return token;
}

/**
 * Constant-time string comparison for bearer tokens and session cookies.
 */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Ensures required directories exist with owner-only permissions (0o700).
 */
export function ensureDirectories(paths: PoolPaths): void {
  for (const dir of [paths.homeDir, paths.chromeProfilesDir, paths.geminiHomesDir, paths.agySessionsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best-effort permission tightening on platforms that support chmod.
    }
  }
}

/**
 * Detects the best installed Chromium-based browser binary on macOS.
 */
export function detectDefaultChromeBinary(): string {
  const envBin = process.env.GPOOL_CHROME_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) {
    return envBin;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function getDefaultSettings(): DaemonSettings {
  return {
    keepalive_enabled: true,
    keepalive_interval_minutes: 240,
    keepalive_jitter_percent: 20,
    keepalive_stagger_seconds: 20,
    default_cooldown_hours: 5,
    notify_on_expiry: true,
    chrome_binary: detectDefaultChromeBinary(),
    default_open_url: 'https://gemini.google.com/app',
    rotation_policy: 'lru',
    renewal_alert_days: 7,
    language: 'vi',
  };
}

/**
 * Validates and normalizes an account alias (`^[a-z0-9][a-z0-9_-]{0,31}$`).
 */
export function validateAlias(alias: string): string {
  const normalized = alias.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error(
      `Alias không hợp lệ ("${alias}"). Chỉ dùng chữ thường a-z, số 0-9, dấu gạch ngang (-) hoặc gạch dưới (_), dài 1–32 ký tự.`,
    );
  }
  return normalized;
}

/**
 * Validates and normalizes an email address.
 */
export function validateEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Email không hợp lệ ("${email}").`);
  }
  return normalized;
}

/**
 * Validates an optional proxy URL (http, https, socks4, socks5, socks5h).
 */
export function validateProxyUrl(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl == null) return null;
  const trimmed = proxyUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Proxy URL không hợp lệ ("${trimmed}"). Ví dụ: http://127.0.0.1:8080 hoặc socks5://127.0.0.1:1080`);
  }
  const allowedProtocols = new Set(['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(`Giao thức proxy không hỗ trợ ("${parsed.protocol}"). Chỉ hỗ trợ http, https, socks4, socks5, socks5h.`);
  }
  if (!parsed.hostname) {
    throw new Error(`Proxy URL thiếu hostname ("${trimmed}").`);
  }
  return trimmed;
}

/**
 * Validates an optional renewal date in strict YYYY-MM-DD calendar format.
 */
export function validateRenewalDate(dateStr: string | null | undefined): string | null {
  if (dateStr == null) return null;
  const trimmed = dateStr.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Ngày gia hạn không hợp lệ ("${trimmed}"). Dùng định dạng YYYY-MM-DD (ví dụ 2026-12-31).`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Ngày gia hạn không tồn tại trên lịch ("${trimmed}").`);
  }
  return trimmed;
}

/**
 * Validates plan tier string.
 */
export function validatePlanTier(tier: string | undefined): PlanTier {
  if (!tier) return 'Google AI Pro';
  const matched = VALID_PLAN_TIERS.find((item) => item.toLowerCase() === tier.trim().toLowerCase());
  if (!matched) {
    throw new Error(`Gói cước không hợp lệ ("${tier}"). Chọn: ${VALID_PLAN_TIERS.join(', ')}.`);
  }
  return matched;
}

/**
 * Normalizes a tag list by trimming, lowercasing, deduplicating, and dropping blanks.
 */
export function normalizeTags(tags: string[] | string | undefined): string[] {
  const rawList = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawList) {
    const clean = raw.trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

export function validateRotationPolicy(policy: string | undefined): RotationPolicy {
  if (!policy || !policy.trim()) return 'lru';
  const normalized = policy.trim().toLowerCase();
  const matched = VALID_ROTATION_POLICIES.find((p) => p === normalized);
  if (!matched) {
    throw new Error(
      `Chiến lược xoay vòng không hợp lệ ("${policy}"). Chọn: ${VALID_ROTATION_POLICIES.join(', ')}.`,
    );
  }
  return matched;
}

export function validateBucketName(bucket: string | null | undefined): string {
  if (!bucket || !bucket.trim()) return 'all';
  const normalized = bucket.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(normalized)) {
    throw new Error(
      `Tên bucket cooldown không hợp lệ ("${bucket}"). Chỉ dùng a-z, 0-9, ".", "-", "_", dài 1–32 ký tự (ví dụ: all, pro, claude, flash).`,
    );
  }
  return normalized;
}

export function validateLocale(lang: string | undefined): Locale {
  if (!lang || !lang.trim()) return 'vi';
  const normalized = lang.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-') || normalized.startsWith('en_')) return 'en';
  if (normalized === 'vi' || normalized.startsWith('vi-') || normalized.startsWith('vi_')) return 'vi';
  throw new Error(`Ngôn ngữ không hợp lệ / Unsupported language ("${lang}"). Supported: en, vi.`);
}

export function resolvePort(portOverride?: number): number {
  const raw = portOverride ?? (process.env.GPOOL_PORT ? Number(process.env.GPOOL_PORT) : DEFAULT_PORT);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    return DEFAULT_PORT;
  }
  return raw;
}

/**
 * Validates that `chrome_binary` points to an absolute path of a recognized Chromium-based browser
 * within standard application/binary directories (preventing arbitrary executable invocation).
 */
export function validateChromeBinary(raw: string): string {
  const clean = raw.trim();
  if (!clean || /[\x00-\x1f\x7f]/.test(clean)) {
    throw new Error('Đường dẫn trình duyệt Chrome không hợp lệ.');
  }
  if (!path.isAbsolute(clean)) {
    throw new Error(`Đường dẫn trình duyệt phải là đường dẫn tuyệt đối ("${clean}").`);
  }
  const normalized = path.resolve(clean);
  if (normalized !== clean && normalized !== clean.replace(/\/+$/, '')) {
    throw new Error(`Đường dẫn trình duyệt không được chứa thành phần tương đối ("${clean}").`);
  }
  const base = path.basename(normalized).toLowerCase();
  if (!ALLOWED_CHROME_BIN_NAMES.has(base)) {
    throw new Error(
      `Trình duyệt không nằm trong danh sách Chromium được phép ("${path.basename(normalized)}"). Chỉ chấp nhận Google Chrome, Brave Browser, Chromium, Edge hoặc Vivaldi.`,
    );
  }
  const allowedRoots = [
    '/Applications/',
    path.join(os.homedir(), 'Applications') + path.sep,
    '/opt/homebrew/',
    '/usr/local/',
    '/usr/bin/',
    '/snap/bin/',
    '/opt/',
  ];
  if (!allowedRoots.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(
      `Đường dẫn trình duyệt phải nằm trong thư mục ứng dụng hệ thống (/Applications, ~/Applications, /opt, /usr/local, /usr/bin): "${normalized}".`,
    );
  }
  return normalized;
}

/**
 * Validates a Chrome profile folder name (e.g. "Default", "Profile 1") preventing path traversal.
 */
export function validateChromeProfileName(raw: string): string {
  const clean = raw.trim();
  if (
    !clean ||
    /[\x00-\x1f\x7f]/.test(clean) ||
    clean.includes('/') ||
    clean.includes('\\') ||
    clean === '.' ||
    clean === '..'
  ) {
    throw new Error(`Tên Chrome profile không hợp lệ ("${raw}"). Ví dụ: "Default" hoặc "Profile 1".`);
  }
  return clean;
}

/**
 * Validates an optional GCP ADC credentials file path (absolute .json path without control characters).
 */
export function validateAdcCredentialsPath(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const clean = raw.trim();
  if (!clean) return null;
  if (/[\x00-\x1f\x7f]/.test(clean) || !path.isAbsolute(clean)) {
    throw new Error(`Đường dẫn file ADC không hợp lệ ("${clean}") — phải là đường dẫn tuyệt đối.`);
  }
  const normalized = path.resolve(clean);
  if (!normalized.toLowerCase().endsWith('.json')) {
    throw new Error(`File ADC phải có phần mở rộng .json ("${clean}").`);
  }
  return normalized;
}

/**
 * Redacts embedded username/password credentials from a proxy URL before UI/CLI display or metadata export.
 */
export function redactProxyUrl(proxyUrl: string | null | undefined): string | null {
  if (proxyUrl == null) return null;
  const clean = proxyUrl.trim();
  if (!clean) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.username || parsed.password) {
      const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      return `${parsed.protocol}//***@${hostPort}`;
    }
    return clean;
  } catch {
    return clean.replace(/\/\/[^/@]+@/, '//***@');
  }
}
