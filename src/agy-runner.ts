import { spawn } from 'node:child_process';
import { acquireAgyLease, DEFAULT_LEASE_TTL_MS } from './agylock.ts';
import {
  activateAgySession,
  captureAgySession,
  listCapturedAliases,
  type AgySessionDeps,
} from './agysession.ts';
import { validateBucketName, validateRotationPolicy, type PoolPaths } from './config.ts';
import type { PoolDB } from './db.ts';
import { PoolSwitcher } from './switcher.ts';
import type { AccountRecord, RotationPolicy } from './types.ts';

export interface ParsedQuotaSignal {
  isQuotaError: boolean;
  cooldownHours: number;
  cooldownUntilIso: string;
  detectedDurationMs: number | null;
  detectedBucket: string | null;
  matchedPattern: string | null;
  reason: string;
}

export interface SpawnAgyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgyProcessRunner = (options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  mirrorStdio: boolean;
  timeoutMs?: number;
}) => Promise<SpawnAgyResult>;

export interface RunAgyFailoverOptions {
  db: PoolDB;
  paths: PoolPaths;
  agyArgs: string[];
  command?: string;
  alias?: string;
  tag?: string;
  bucket?: string;
  policy?: RotationPolicy;
  cooldownHoursOverride?: number;
  maxRetries?: number;
  waitSeconds?: number;
  timeoutSeconds?: number;
  forceAgy?: boolean;
  interactive?: boolean;
  mirrorStdio?: boolean;
  holder?: string;
  onStatus?: (message: string) => void;
  processRunner?: AgyProcessRunner;
  agyDeps?: AgySessionDeps;
  nowFn?: () => Date;
}

export interface AgyFailoverRotation {
  fromAlias: string;
  toAlias: string | null;
  bucket: string;
  cooldownHours: number;
  reason: string;
}

export interface RunAgyFailoverResult {
  ok: boolean;
  exitCode: number;
  usedAlias: string | null;
  attempts: number;
  rotations: AgyFailoverRotation[];
  stdout: string;
  stderr: string;
  error?: string;
  nextAvailableAt?: string | null;
}

const QUOTA_PATTERNS: Array<[string, RegExp]> = [
  ['RESOURCE_EXHAUSTED', /\bRESOURCE_EXHAUSTED\b/i],
  ['HTTP 429', /\b(?:status|code|error|http)[\s:=]*429\b|\b429\s+too\s+many\s+requests\b/i],
  ['quota exceeded', /\b(?:quota|usage|rate|credit|capacity)\s*(?:limit\s*)?(?:exceeded|exhausted|reached|depleted)\b/i],
  ['too many requests', /\btoo\s+many\s+requests\b/i],
  ['rate limited', /\brate[\s-]?limit(?:ed|ing)?\b/i],
  ['reset countdown', /\b(?:quota|limit)\s+resets?\s+(?:in|at)\b/i],
  ['Vietnamese quota', /hết\s+(?:quota|hạn\s+mức|lượt)/i],
];

const MODEL_BUCKET_PATTERNS: Array<[string, RegExp]> = [
  ['opus', /\bclaude[-_\s/]*(?:\d+(?:\.\d+)?[-_\s]*)?opus\b|\bopus\b/i],
  ['sonnet', /\bclaude[-_\s/]*(?:\d+(?:\.\d+)?[-_\s]*)?sonnet\b|\bsonnet\b/i],
  ['claude', /\bclaude\b/i],
  ['flash', /\bgemini[-_\s/]*[\d.]*[-_\s]*flash\b/i],
  ['pro', /\bgemini[-_\s/]*[\d.]*[-_\s]*pro\b/i],
];

/**
 * Inspects command output (stderr/stdout) to detect quota / rate-limit errors,
 * extract exact reset duration or timestamp when available, and optionally infer
 * a model bucket (`pro`, `claude`, `opus`, `sonnet`, `flash`).
 */
export function parseQuotaError(
  output: string,
  defaultCooldownHours: number,
  now: Date = new Date(),
): ParsedQuotaSignal {
  const clean = output || '';
  let matchedPattern: string | null = null;
  for (const [label, regex] of QUOTA_PATTERNS) {
    if (regex.test(clean)) {
      matchedPattern = label;
      break;
    }
  }

  const fallbackHours = Number.isFinite(defaultCooldownHours) && defaultCooldownHours > 0 ? defaultCooldownHours : 5;
  const fallbackMs = fallbackHours * 3_600_000;

  if (!matchedPattern) {
    return {
      isQuotaError: false,
      cooldownHours: fallbackHours,
      cooldownUntilIso: new Date(now.getTime() + fallbackMs).toISOString(),
      detectedDurationMs: null,
      detectedBucket: null,
      matchedPattern: null,
      reason: '',
    };
  }

  const detectedMs = extractResetDurationMs(clean, now);
  const clampedMs =
    detectedMs !== null
      ? Math.max(60_000, Math.min(720 * 3_600_000, detectedMs))
      : fallbackMs;
  const cooldownHours = Math.round((clampedMs / 3_600_000) * 100) / 100;

  let detectedBucket: string | null = null;
  for (const [bucketName, regex] of MODEL_BUCKET_PATTERNS) {
    if (regex.test(clean)) {
      detectedBucket = bucketName;
      break;
    }
  }

  const reason =
    detectedMs !== null
      ? `Tự phát hiện hết quota (${matchedPattern}, reset sau ~${formatHoursReadable(cooldownHours)})`
      : `Tự phát hiện hết quota (${matchedPattern})`;

  return {
    isQuotaError: true,
    cooldownHours,
    cooldownUntilIso: new Date(now.getTime() + clampedMs).toISOString(),
    detectedDurationMs: detectedMs,
    detectedBucket,
    matchedPattern,
    reason,
  };
}

function extractResetDurationMs(text: string, now: Date): number | null {
  // 1) ISO-8601 timestamp near reset/retry keywords
  const isoMatch = /(?:reset(?:s)?\s+(?:at|on)|available\s+(?:at|after)|until)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2}))/i.exec(
    text,
  );
  if (isoMatch) {
    const ts = Date.parse(isoMatch[1]);
    if (!Number.isNaN(ts) && ts > now.getTime()) {
      return ts - now.getTime();
    }
  }

  // 2) Relative compound durations: "in 3h 42m", "in 2 hours 15 minutes", "after 1d 2h", "in 45m 30s"
  const relClause =
    /(?:resets?\s+in|try\s+again\s+in|retry\s+(?:in|after)|wait(?:\s+for)?|available\s+in|sau)\s+([0-9]+(?:\.[0-9]+)?\s*(?:days?|d|ngày|hours?|hrs?|hr|h|giờ|minutes?|mins?|min|m|phút|seconds?|secs?|sec|s|giây)(?:[\s,]*(?:and\s+)?[0-9]+(?:\.[0-9]+)?\s*(?:hours?|hrs?|hr|h|giờ|minutes?|mins?|min|m|phút|seconds?|secs?|sec|s|giây))*)/i.exec(
      text,
    );
  if (relClause) {
    const parsed = parseCompoundDurationMs(relClause[1]);
    if (parsed !== null && parsed > 0) return parsed;
  }

  // 3) Retry-After header style: "retry-after: 120" (seconds)
  const retryAfter = /retry-after\s*[:=]\s*([0-9]+)\b/i.exec(text);
  if (retryAfter) {
    const secs = Number(retryAfter[1]);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }

  return null;
}

function parseCompoundDurationMs(clause: string): number | null {
  const tokenRegex = /([0-9]+(?:\.[0-9]+)?)\s*(days?|d|ngày|hours?|hrs?|hr|h|giờ|minutes?|mins?|min|m|phút|seconds?|secs?|sec|s|giây)/gi;
  let totalMs = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(clause)) !== null) {
    const val = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(val)) continue;
    matched = true;
    if (unit === 'd' || unit.startsWith('day') || unit === 'ngày') totalMs += val * 86_400_000;
    else if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour') || unit === 'giờ') totalMs += val * 3_600_000;
    else if (unit === 'm' || unit.startsWith('min') || unit === 'phút') totalMs += val * 60_000;
    else totalMs += val * 1000;
  }
  return matched ? Math.round(totalMs) : null;
}

function formatHoursReadable(hours: number): string {
  if (hours < 1) {
    return `${Math.max(1, Math.round(hours * 60))}p`;
  }
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}g${m}p` : `${h}g`;
}

async function defaultProcessRunner(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  mirrorStdio: boolean;
  timeoutMs?: number;
}): Promise<SpawnAgyResult> {
  if (options.interactive) {
    return await new Promise<SpawnAgyResult>((resolve, reject) => {
      const child = spawn(options.command, options.args, {
        env: options.env,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ exitCode: code ?? 0, stdout: '', stderr: '' }));
    });
  }

  return await new Promise<SpawnAgyResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      env: options.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBuffer = 2 * 1024 * 1024;
    let timedOut = false;

    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore.
        }
      }, options.timeoutMs);
      timer.unref();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (options.mirrorStdio) process.stdout.write(chunk);
      if (stdoutBytes < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (options.mirrorStdio) process.stderr.write(chunk);
      if (stderrBytes < maxBuffer) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        exitCode: timedOut ? 124 : code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: timedOut ? `${stderr}\n[gpool] Lệnh agy quá thời gian chờ (${Math.round((options.timeoutMs ?? 0) / 1000)}s).`.trim() : stderr,
      });
    });
  });
}

function isAccountEligibleForBucket(
  db: PoolDB,
  acc: AccountRecord,
  bucket: string,
  now: Date,
  tag?: string,
): boolean {
  if (acc.session_status === 'needs_login' || acc.session_status === 'error') return false;
  if (tag && !acc.tags.includes(tag.trim().toLowerCase())) return false;
  if (acc.cooldown_until) {
    const ms = Date.parse(acc.cooldown_until);
    if (!Number.isNaN(ms) && ms > now.getTime()) return false;
  }
  if (bucket !== 'all') {
    const activeBuckets = db.listBucketCooldowns(acc.id, now);
    if (activeBuckets.some((b) => b.bucket === bucket && b.remaining_ms > 0)) return false;
  }
  return true;
}

/**
 * Runs `agy` with lease locking, automatic Keychain session activation,
 * smart quota-error detection, and automatic failover rotation across ready pool accounts.
 */
export async function runAgyWithFailover(options: RunAgyFailoverOptions): Promise<RunAgyFailoverResult> {
  const { db, paths } = options;
  const nowFn = options.nowFn ?? (() => new Date());
  const settings = db.getSettings();
  const rawBucket = options.bucket?.trim().toLowerCase() || 'all';
  const autoBucket = rawBucket === 'auto';
  const lookupBucket = autoBucket ? 'all' : validateBucketName(rawBucket);
  const policy = options.policy ? validateRotationPolicy(options.policy) : settings.rotation_policy;
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const interactive = options.interactive ?? false;
  const mirrorStdio = options.mirrorStdio ?? true;
  const command = options.command ?? 'agy';
  const runner = options.processRunner ?? defaultProcessRunner;

  db.expireElapsedCooldowns(nowFn());

  const capturedAliases = listCapturedAliases(paths);
  const pickAccount = (excludeAliases: Set<string>): AccountRecord | null => {
    if (options.alias && excludeAliases.size === 0) {
      const explicit = db.getAccount(options.alias);
      if (!explicit) throw new Error(`Không tìm thấy tài khoản "${options.alias}".`);
      if (!capturedAliases.has(explicit.alias) && !explicit.adc_credentials_path) {
        throw new Error(
          `Tài khoản "${explicit.alias}" chưa có phiên agy đã lưu. Hãy chạy "gpool agy-capture ${explicit.alias}" trước.`,
        );
      }
      return explicit;
    }

    // Prefer currently active account if captured and eligible
    const active = db.getActiveAccount();
    if (
      active &&
      !excludeAliases.has(active.alias) &&
      capturedAliases.has(active.alias) &&
      isAccountEligibleForBucket(db, active, lookupBucket, nowFn(), options.tag)
    ) {
      return active;
    }

    return db.pickNextReadyAccount({
      tag: options.tag,
      excludeAliases,
      bucket: lookupBucket,
      policy,
      requireAgyAliases: capturedAliases,
      now: nowFn(),
    });
  };

  const triedAliases = new Set<string>();
  let current = pickAccount(triedAliases);
  if (!current) {
    const nextAvailableAt = db.getEarliestCooldownEnd(options.tag, nowFn(), lookupBucket, capturedAliases);
    return {
      ok: false,
      exitCode: 1,
      usedAlias: null,
      attempts: 0,
      rotations: [],
      stdout: '',
      stderr: '',
      error:
        capturedAliases.size === 0
          ? 'Chưa có tài khoản nào được lưu phiên agy. Hãy đăng nhập agy rồi chạy "gpool agy-capture <alias>".'
          : `Không còn tài khoản agy sẵn sàng nào${lookupBucket !== 'all' ? ` cho bucket "${lookupBucket}"` : ''}${options.tag ? ` với tag "${options.tag}"` : ''}.`,
      nextAvailableAt,
    };
  }

  const leaseHandle = await acquireAgyLease(paths, {
    alias: current.alias,
    holder: options.holder ?? 'gpool-agy',
    ttlMs: DEFAULT_LEASE_TTL_MS,
    waitMs: Math.max(0, (options.waitSeconds ?? 0) * 1000),
  });

  const renewTimer = setInterval(() => {
    try {
      leaseHandle.renew(DEFAULT_LEASE_TTL_MS);
    } catch {
      // Best-effort lease renewal.
    }
  }, 120_000);
  renewTimer.unref();

  const rotations: AgyFailoverRotation[] = [];
  const switcher = new PoolSwitcher({ db, paths });
  let attempts = 0;
  let lastResult: SpawnAgyResult = { exitCode: 1, stdout: '', stderr: '' };
  let lastAlias: string | null = null;

  try {
    while (current && attempts < maxRetries) {
      attempts += 1;
      lastAlias = current.alias;
      triedAliases.add(current.alias);

      if (capturedAliases.has(current.alias)) {
        const actRes = activateAgySession(
          paths,
          current,
          { force: Boolean(options.forceAgy) },
          options.agyDeps,
        );
        db.addEvent(
          current.id,
          current.alias,
          'agy_session_activated',
          `gpool agy nạp phiên cho ${current.alias}` +
            (actRes.recaptured_alias ? ` (cập nhật snapshot ${actRes.recaptured_alias})` : ''),
        );
      }

      db.setActiveAccount(current.alias);
      options.onStatus?.(
        `[gpool] Chạy agy với "${current.alias}" (${current.email})${attempts > 1 ? ` — lần thử ${attempts}/${maxRetries}` : ''}...`,
      );

      const envResult = switcher.buildOfficialRunEnv(current, command);
      lastResult = await runner({
        command,
        args: options.agyArgs,
        env: envResult.env,
        interactive,
        mirrorStdio,
        timeoutMs: options.timeoutSeconds ? options.timeoutSeconds * 1000 : undefined,
      });

      // Best-effort re-capture refreshed token after clean exit
      if (lastResult.exitCode === 0) {
        if (capturedAliases.has(current.alias)) {
          try {
            captureAgySession(paths, current, {
              ...options.agyDeps,
              encrypt: options.agyDeps?.encrypt ?? (process.platform === 'darwin' || Boolean(options.agyDeps?.securityRun)),
            });
          } catch {
            // Non-fatal if keychain unchanged or locked.
          }
        }
        return {
          ok: true,
          exitCode: 0,
          usedAlias: current.alias,
          attempts,
          rotations,
          stdout: lastResult.stdout,
          stderr: lastResult.stderr,
        };
      }

      // Interactive TTY mode doesn't capture stderr; stop here
      if (interactive) {
        return {
          ok: false,
          exitCode: lastResult.exitCode,
          usedAlias: current.alias,
          attempts,
          rotations,
          stdout: lastResult.stdout,
          stderr: lastResult.stderr,
        };
      }

      const combinedOutput = `${lastResult.stderr}\n${lastResult.stdout}`;
      const quota = parseQuotaError(
        combinedOutput,
        options.cooldownHoursOverride ?? settings.default_cooldown_hours,
        nowFn(),
      );

      if (!quota.isQuotaError) {
        return {
          ok: false,
          exitCode: lastResult.exitCode,
          usedAlias: current.alias,
          attempts,
          rotations,
          stdout: lastResult.stdout,
          stderr: lastResult.stderr,
        };
      }

      const targetBucket = autoBucket ? (quota.detectedBucket ?? 'all') : lookupBucket;
      const appliedHours =
        options.cooldownHoursOverride !== undefined && quota.detectedDurationMs === null
          ? options.cooldownHoursOverride
          : quota.cooldownHours;
      const untilIso =
        options.cooldownHoursOverride !== undefined && quota.detectedDurationMs === null
          ? new Date(nowFn().getTime() + options.cooldownHoursOverride * 3_600_000).toISOString()
          : quota.cooldownUntilIso;

      db.setBucketCooldown(current.alias, targetBucket, untilIso, quota.reason);

      const next = db.pickNextReadyAccount({
        tag: options.tag,
        excludeAliases: triedAliases,
        bucket: targetBucket,
        policy,
        requireAgyAliases: capturedAliases,
        now: nowFn(),
      });

      rotations.push({
        fromAlias: current.alias,
        toAlias: next?.alias ?? null,
        bucket: targetBucket,
        cooldownHours: appliedHours,
        reason: quota.reason,
      });

      if (!next || attempts >= maxRetries) {
        const nextAvailableAt = db.getEarliestCooldownEnd(options.tag, nowFn(), targetBucket, capturedAliases);
        const exhaustedMsg = !next
          ? `Tài khoản "${current.alias}" hết quota (đã đặt cooldown ${formatHoursReadable(appliedHours)}${targetBucket !== 'all' ? ` [${targetBucket}]` : ''}) và không còn acc agy sẵn sàng nào khác.`
          : `Đã đạt giới hạn ${maxRetries} lần xoay vòng tự động.`;
        options.onStatus?.(`[gpool] ${exhaustedMsg}`);
        return {
          ok: false,
          exitCode: lastResult.exitCode,
          usedAlias: current.alias,
          attempts,
          rotations,
          stdout: lastResult.stdout,
          stderr: lastResult.stderr,
          error: exhaustedMsg,
          nextAvailableAt,
        };
      }

      options.onStatus?.(
        `[gpool] "${current.alias}" hết quota (cooldown ${formatHoursReadable(appliedHours)}${targetBucket !== 'all' ? ` [${targetBucket}]` : ''}) → tự xoay sang "${next.alias}"...`,
      );
      current = next;
    }

    return {
      ok: false,
      exitCode: lastResult.exitCode,
      usedAlias: lastAlias,
      attempts,
      rotations,
      stdout: lastResult.stdout,
      stderr: lastResult.stderr,
    };
  } finally {
    clearInterval(renewTimer);
    leaseHandle.release();
  }
}
