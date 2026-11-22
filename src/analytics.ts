import { listSessionMetas } from './agysession.ts';
import { isAccountChromeRunning } from './chrome.ts';
import type { PoolPaths } from './config.ts';
import type { PoolDB } from './db.ts';
import type { AccountAnalyticsRow, DailyActivityPoint, PoolAnalyticsReport } from './types.ts';

/**
 * Computes usage telemetry, 7-day (or N-day) activity timeline, quota hit rate,
 * availability percentage, and encryption coverage across the pool.
 */
export function computePoolAnalytics(
  db: PoolDB,
  paths: PoolPaths,
  options: { days?: number; now?: Date } = {},
): PoolAnalyticsReport {
  const now = options.now ?? new Date();
  const windowDays = Math.max(1, Math.min(30, Math.floor(options.days ?? 7)));
  db.expireElapsedCooldowns(now);

  const accounts = db.listAccounts().map((acc) =>
    db.computeAccountView(acc, isAccountChromeRunning(acc).running, now),
  );
  const events = db.listEvents(500);
  const sessionMetas = listSessionMetas(paths);

  // Prepare continuous N-day UTC date buckets ending today
  const dayBuckets = new Map<string, DailyActivityPoint>();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    const key = d.toISOString().slice(0, 10);
    dayBuckets.set(key, { date: key, switches: 0, agy_activations: 0, quota_hits: 0 });
  }

  const windowStartKey = Array.from(dayBuckets.keys())[0];
  let totalSwitches = 0;
  let totalAgyActivations = 0;
  let quotaHitsWindow = 0;
  let quotaHitsTotal = 0;

  const perAccountQuotaTotal = new Map<string, number>();
  const perAccountQuotaWindow = new Map<string, number>();

  for (const ev of events) {
    const dayKey = typeof ev.created_at === 'string' && ev.created_at.length >= 10 ? ev.created_at.slice(0, 10) : '';
    const inWindow = dayKey >= windowStartKey && dayBuckets.has(dayKey);
    const bucket = inWindow ? dayBuckets.get(dayKey)! : null;
    const alias = ev.account_alias ?? '';

    if (ev.event_type === 'switch') {
      totalSwitches += 1;
      if (bucket) bucket.switches += 1;
    } else if (ev.event_type === 'agy_session_activated') {
      totalAgyActivations += 1;
      if (bucket) bucket.agy_activations += 1;
    } else if (ev.event_type === 'cooldown_set' || ev.event_type === 'bucket_cooldown_set') {
      quotaHitsTotal += 1;
      if (alias) perAccountQuotaTotal.set(alias, (perAccountQuotaTotal.get(alias) ?? 0) + 1);
      if (bucket) {
        quotaHitsWindow += 1;
        bucket.quota_hits += 1;
        if (alias) perAccountQuotaWindow.set(alias, (perAccountQuotaWindow.get(alias) ?? 0) + 1);
      }
    }
  }

  const accountRows: AccountAnalyticsRow[] = accounts
    .map((acc) => {
      const meta = sessionMetas.get(acc.alias);
      return {
        alias: acc.alias,
        email: acc.email,
        plan_tier: acc.plan_tier,
        effective_state: acc.effective_state,
        use_count: acc.use_count,
        quota_hits_window: perAccountQuotaWindow.get(acc.alias) ?? 0,
        quota_hits_total: perAccountQuotaTotal.get(acc.alias) ?? 0,
        agy_captured: Boolean(meta),
        agy_encrypted: Boolean(meta?.encrypted),
        last_used_at: acc.last_used_at,
      };
    })
    .sort((a, b) => b.use_count - a.use_count || a.alias.localeCompare(b.alias));

  const totalAccounts = accounts.length;
  const readyAccounts = accounts.filter((a) => a.effective_state === 'ready' || a.effective_state === 'active').length;
  const cooldownAccounts = accounts.filter((a) => a.effective_state === 'cooldown').length;
  const needsLoginAccounts = accounts.filter(
    (a) => a.effective_state === 'needs_login' || a.effective_state === 'error',
  ).length;
  const agyCapturedAccounts = accountRows.filter((r) => r.agy_captured).length;
  const agyEncryptedAccounts = accountRows.filter((r) => r.agy_encrypted).length;
  const availabilityPercent = totalAccounts > 0 ? Math.round((readyAccounts / totalAccounts) * 100) : 0;
  const switchesPerQuotaHit =
    quotaHitsTotal > 0 ? Math.round(((totalSwitches + totalAgyActivations) / quotaHitsTotal) * 10) / 10 : null;

  return {
    generated_at: now.toISOString(),
    window_days: windowDays,
    summary: {
      total_accounts: totalAccounts,
      ready_accounts: readyAccounts,
      cooldown_accounts: cooldownAccounts,
      needs_login_accounts: needsLoginAccounts,
      agy_captured_accounts: agyCapturedAccounts,
      agy_encrypted_accounts: agyEncryptedAccounts,
      availability_percent: availabilityPercent,
      total_switches: totalSwitches,
      total_agy_activations: totalAgyActivations,
      quota_hits_window: quotaHitsWindow,
      quota_hits_total: quotaHitsTotal,
      switches_per_quota_hit: switchesPerQuotaHit,
    },
    daily: Array.from(dayBuckets.values()),
    accounts: accountRows,
  };
}
