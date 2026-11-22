import { probeAndRefreshProfile, sendMacNotification, type ProbeProfileResult } from './chrome.ts';
import type { PoolDB } from './db.ts';
import type { AccountRecord, KeepAliveResult, KeepAliveStatus } from './types.ts';

export type ProbeProfileFn = (account: AccountRecord, chromeBinary: string) => Promise<ProbeProfileResult>;
export type NotifyExpiryFn = (title: string, message: string) => Promise<void>;
export type KeepAliveUpdateFn = (eventType: string, payload: unknown) => void;

export interface KeepAliveSchedulerOptions {
  db: PoolDB;
  probeFn?: ProbeProfileFn;
  notifyFn?: NotifyExpiryFn;
  onUpdate?: KeepAliveUpdateFn;
  tickMs?: number;
  staggerDelayMs?: number;
}

/**
 * Computes randomized keep-alive interval delay in milliseconds around `intervalMinutes`
 * using `+/- jitterPercent`.
 */
export function computeNextCheckDelayMs(
  intervalMinutes: number,
  jitterPercent: number,
  rng: () => number = Math.random,
): number {
  const baseMs = Math.max(1, intervalMinutes) * 60_000;
  const clampedJitter = Math.max(0, Math.min(50, jitterPercent)) / 100;
  if (clampedJitter === 0) return baseMs;
  const factor = 1 + (rng() * 2 - 1) * clampedJitter;
  return Math.max(60_000, Math.round(baseMs * factor));
}

/**
 * Determines whether an account is due for a keep-alive check at `nowMs`.
 */
export function isAccountDueForCheck(
  account: AccountRecord,
  intervalMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!account.last_checked_at) return true;
  const lastMs = Date.parse(account.last_checked_at);
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= intervalMs;
}

export class KeepAliveScheduler {
  private readonly db: PoolDB;
  private readonly probeFn: ProbeProfileFn;
  private readonly notifyFn: NotifyExpiryFn;
  private readonly onUpdate?: KeepAliveUpdateFn;
  private readonly tickMs: number;
  private readonly staggerDelayMsOverride?: number;
  private readonly activeProbes = new Set<string>();
  private readonly nextCheckAfterMs = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweeping = false;
  private sweepPromise: Promise<KeepAliveResult[]> | null = null;
  private lastSweepAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: KeepAliveSchedulerOptions) {
    this.db = options.db;
    this.probeFn =
      options.probeFn ??
      ((account, chromeBinary) =>
        probeAndRefreshProfile({
          chromeBinary,
          profileDir: account.chrome_profile_dir,
          proxyUrl: account.proxy_url,
          profileMode: account.profile_mode,
          chromeUserDataDir: account.chrome_user_data_dir,
          chromeProfileName: account.chrome_profile_name,
          googleAuthuser: account.google_authuser,
        }));
    this.notifyFn = options.notifyFn ?? sendMacNotification;
    this.onUpdate = options.onUpdate;
    this.tickMs = options.tickMs ?? 60_000;
    this.staggerDelayMsOverride = options.staggerDelayMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): KeepAliveStatus {
    return {
      running: this.running,
      sweeping: this.sweeping,
      activeProbes: Array.from(this.activeProbes),
      lastSweepAt: this.lastSweepAt,
      lastError: this.lastError,
    };
  }

  async tick(now: Date = new Date()): Promise<void> {
    try {
      const expired = this.db.expireElapsedCooldowns(now);
      if (expired.length > 0) {
        this.onUpdate?.('cooldown_expired', { aliases: expired });
      }

      const settings = this.db.getSettings();
      if (!settings.keepalive_enabled || this.sweeping) {
        return;
      }

      const intervalMs = settings.keepalive_interval_minutes * 60_000;
      const nowMs = now.getTime();
      const due = this.db.listAccounts().filter((acc) => {
        const scheduledAfter = this.nextCheckAfterMs.get(acc.alias);
        if (scheduledAfter !== undefined) {
          return nowMs >= scheduledAfter;
        }
        return isAccountDueForCheck(acc, intervalMs, nowMs);
      });

      if (due.length > 0) {
        await this.sweepAccounts(due);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Probes all accounts sequentially right now. Reuses an active sweep if one is already running.
   */
  async sweepAll(): Promise<KeepAliveResult[]> {
    if (this.sweepPromise) {
      return this.sweepPromise;
    }
    this.db.expireElapsedCooldowns();
    const accounts = this.db.listAccounts();
    return this.sweepAccounts(accounts);
  }

  private sweepAccounts(accounts: AccountRecord[]): Promise<KeepAliveResult[]> {
    if (this.sweepPromise) {
      return this.sweepPromise;
    }

    this.sweeping = true;
    this.onUpdate?.('keepalive_sweep_started', { count: accounts.length });

    const run = (async () => {
      const results: KeepAliveResult[] = [];
      try {
        const settings = this.db.getSettings();
        const staggerMs =
          this.staggerDelayMsOverride !== undefined
            ? this.staggerDelayMsOverride
            : settings.keepalive_stagger_seconds * 1000;

        for (let i = 0; i < accounts.length; i += 1) {
          const fresh = this.db.getAccount(accounts[i].id);
          if (!fresh) continue;

          const res = await this.probeAccount(fresh.alias);
          results.push(res);

          if (i < accounts.length - 1 && staggerMs > 0) {
            await sleep(staggerMs);
          }
        }

        this.lastSweepAt = new Date().toISOString();
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        this.sweeping = false;
        this.sweepPromise = null;
        this.onUpdate?.('keepalive_sweep_finished', {
          lastSweepAt: this.lastSweepAt,
          count: results.length,
        });
      }
      return results;
    })();

    this.sweepPromise = run;
    return run;
  }

  /**
   * Probes a single account safely with per-account in-flight protection.
   */
  async probeAccount(aliasOrId: string | number): Promise<KeepAliveResult> {
    const account = this.db.getAccount(aliasOrId);
    if (!account) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    if (this.activeProbes.has(account.alias)) {
      return {
        alias: account.alias,
        previousStatus: account.session_status,
        status: account.session_status,
        detail: 'Tài khoản này đang được kiểm tra phiên...',
        checkedAt: new Date().toISOString(),
        notified: false,
      };
    }

    this.activeProbes.add(account.alias);
    this.onUpdate?.('probe_started', { alias: account.alias });

    const settings = this.db.getSettings();
    const previousStatus = account.session_status;
    const checkedAt = new Date();
    let notified = false;

    try {
      const probe = await this.probeFn(account, settings.chrome_binary);

      if (probe.status === 'skipped_open') {
        const preservedStatus = previousStatus === 'checking' ? 'live' : previousStatus;
        this.db.updateSessionStatus(account.id, preservedStatus, probe.detail, checkedAt);
      } else {
        this.db.updateSessionStatus(account.id, probe.status, probe.detail, checkedAt);

        if (probe.status === 'needs_login' && previousStatus !== 'needs_login') {
          this.db.addEvent(
            account.id,
            account.alias,
            'session_expired',
            `${account.alias} (${account.email}) cần đăng nhập lại: ${probe.detail}`,
          );
          if (settings.notify_on_expiry && previousStatus === 'live') {
            await this.notifyFn(
              'Google One Pool — Cần đăng nhập lại',
              `Tài khoản ${account.alias} (${account.email}) đã hết phiên Google.`,
            );
            notified = true;
          }
        } else if (probe.status === 'live' && previousStatus !== 'live') {
          this.db.addEvent(
            account.id,
            account.alias,
            'session_live',
            `${account.alias} xác nhận phiên Google đang hoạt động`,
          );
        } else if (probe.status === 'error' && previousStatus !== 'error') {
          this.db.addEvent(
            account.id,
            account.alias,
            'session_error',
            `Kiểm tra phiên ${account.alias} gặp lỗi: ${probe.detail}`,
          );
        }
      }

      const nextDelay = computeNextCheckDelayMs(
        settings.keepalive_interval_minutes,
        settings.keepalive_jitter_percent,
      );
      this.nextCheckAfterMs.set(account.alias, checkedAt.getTime() + nextDelay);

      const result: KeepAliveResult = {
        alias: account.alias,
        previousStatus,
        status: probe.status,
        detail: probe.detail,
        checkedAt: checkedAt.toISOString(),
        notified,
      };
      this.onUpdate?.('probe_finished', result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.updateSessionStatus(account.id, 'error', message, checkedAt);
      const result: KeepAliveResult = {
        alias: account.alias,
        previousStatus,
        status: 'error',
        detail: message,
        checkedAt: checkedAt.toISOString(),
        notified: false,
      };
      this.onUpdate?.('probe_finished', result);
      return result;
    } finally {
      this.activeProbes.delete(account.alias);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
