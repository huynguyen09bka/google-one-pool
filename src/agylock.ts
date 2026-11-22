import fs from 'node:fs';
import { ensureDirectories, type PoolPaths } from './config.ts';
import type { AgyLeaseInfo } from './types.ts';

export const DEFAULT_LEASE_TTL_MS = 10 * 60_000; // 10 phút

interface RawLeaseFile {
  pid: number;
  alias: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

export interface AcquireLeaseOptions {
  alias: string;
  holder?: string;
  pid?: number;
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

export interface AcquiredLeaseHandle {
  lease: AgyLeaseInfo;
  renew: (ttlMs?: number) => AgyLeaseInfo;
  release: () => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads the current `agy.lock` lease metadata (if present) and reports whether it is stale.
 */
export function readAgyLease(
  paths: PoolPaths,
  options: { now?: Date; isPidAlive?: (pid: number) => boolean } = {},
): AgyLeaseInfo | null {
  const isAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nowMs = (options.now ?? new Date()).getTime();
  let raw: string;
  try {
    raw = fs.readFileSync(paths.agyLockPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: Partial<RawLeaseFile>;
  try {
    parsed = JSON.parse(raw) as Partial<RawLeaseFile>;
  } catch {
    return {
      pid: 0,
      alias: '(corrupt)',
      holder: 'unknown',
      acquired_at: '',
      expires_at: '',
      stale: true,
    };
  }

  const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  const expiresMs = parsed.expires_at ? Date.parse(parsed.expires_at) : 0;
  const expired = !expiresMs || Number.isNaN(expiresMs) || expiresMs <= nowMs;
  const deadPid = !isAlive(pid);

  return {
    pid,
    alias: typeof parsed.alias === 'string' ? parsed.alias : '',
    holder: typeof parsed.holder === 'string' ? parsed.holder : 'unknown',
    acquired_at: typeof parsed.acquired_at === 'string' ? parsed.acquired_at : '',
    expires_at: typeof parsed.expires_at === 'string' ? parsed.expires_at : '',
    stale: expired || deadPid,
  };
}

/**
 * Atomically acquires the `agy.lock` lease using `O_CREAT | O_EXCL` (`wx`).
 * Automatically reclaims stale leases (expired TTL or dead PID). Optionally waits up to `waitMs`.
 */
export async function acquireAgyLease(
  paths: PoolPaths,
  options: AcquireLeaseOptions,
): Promise<AcquiredLeaseHandle> {
  ensureDirectories(paths);
  const pid = options.pid ?? process.pid;
  const holder = (options.holder ?? 'gpool').trim() || 'gpool';
  const ttlMs = Math.max(5_000, options.ttlMs ?? DEFAULT_LEASE_TTL_MS);
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const pollMs = Math.max(25, options.pollMs ?? 200);
  const isAlive = options.isPidAlive ?? defaultIsPidAlive;

  const deadline = Date.now() + waitMs;

  while (true) {
    const now = new Date();
    const payload: RawLeaseFile = {
      pid,
      alias: options.alias,
      holder,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    };

    try {
      const fd = fs.openSync(paths.agyLockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }

      const lease: AgyLeaseInfo = { ...payload, stale: false };
      return {
        lease,
        renew: (nextTtlMs = ttlMs) => {
          const renewedNow = new Date();
          const updated: RawLeaseFile = {
            ...payload,
            expires_at: new Date(renewedNow.getTime() + Math.max(5_000, nextTtlMs)).toISOString(),
          };
          const current = readAgyLease(paths, { isPidAlive: isAlive });
          if (current && current.pid === pid && current.acquired_at === payload.acquired_at) {
            fs.writeFileSync(paths.agyLockPath, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
          }
          return { ...updated, stale: false };
        },
        release: () => releaseAgyLease(paths, { expectedPid: pid, expectedAcquiredAt: payload.acquired_at }),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      const existing = readAgyLease(paths, { isPidAlive: isAlive });
      if (!existing) {
        continue;
      }

      // Same process re-entering or stale lock -> reclaim cleanly
      if (existing.stale) {
        try {
          fs.unlinkSync(paths.agyLockPath);
        } catch {
          // Another waiter reclaimed it first; retry loop.
        }
        continue;
      }

      if (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(10, deadline - Date.now()))));
        continue;
      }

      const remainSec = Math.max(1, Math.ceil((Date.parse(existing.expires_at) - Date.now()) / 1000));
      throw new Error(
        `Phiên agy Keychain đang được giữ bởi "${existing.holder}" (PID ${existing.pid}, acc "${existing.alias}", hết hạn sau ~${remainSec}s). ` +
          `Chờ tiến trình đó xong, truyền --wait <giây>, hoặc dùng "gpool agy-lock unlock" nếu chắc chắn không còn chạy.`,
      );
    }
  }
}

/**
 * Releases `agy.lock` safely (only removes if owned by `expectedPid`, unless `force: true`).
 */
export function releaseAgyLease(
  paths: PoolPaths,
  options: { expectedPid?: number; expectedAcquiredAt?: string; force?: boolean } = {},
): boolean {
  if (!fs.existsSync(paths.agyLockPath)) return false;

  if (!options.force && options.expectedPid !== undefined) {
    const current = readAgyLease(paths);
    if (current && !current.stale && current.pid !== options.expectedPid) {
      return false;
    }
    if (
      current &&
      options.expectedAcquiredAt &&
      current.acquired_at &&
      current.acquired_at !== options.expectedAcquiredAt
    ) {
      return false;
    }
  }

  try {
    fs.unlinkSync(paths.agyLockPath);
    return true;
  } catch {
    return false;
  }
}
