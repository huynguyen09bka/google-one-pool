import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deleteSessionFilesForAlias, renameSessionFilesForAlias } from './agysession.ts';
import {
  ensureDirectories,
  getDefaultSettings,
  normalizeTags,
  redactProxyUrl,
  validateAdcCredentialsPath,
  validateAlias,
  validateBucketName,
  validateChromeBinary,
  validateChromeProfileName,
  validateEmail,
  validateLocale,
  validatePlanTier,
  validateProxyUrl,
  validateRenewalDate,
  validateRotationPolicy,
  type PoolPaths,
} from './config.ts';
import type {
  AccountRecord,
  AccountView,
  BucketCooldown,
  CreateAccountInput,
  DaemonSettings,
  EffectiveState,
  Locale,
  PlanTier,
  PoolEvent,
  PoolExportPayload,
  ProfileMode,
  RenewalAlert,
  RotationPolicy,
  SessionStatus,
  UpdateAccountInput,
} from './types.ts';

interface AccountRow {
  id: number;
  alias: string;
  email: string;
  display_name: string;
  plan_tier: string;
  renewal_date: string | null;
  tags_json: string;
  notes: string;
  proxy_url: string | null;
  adc_credentials_path: string | null;
  profile_mode: string;
  chrome_user_data_dir: string | null;
  chrome_profile_name: string | null;
  google_authuser: string | null;
  chrome_profile_dir: string;
  session_status: string;
  session_detail: string | null;
  is_active: number;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  last_checked_at: string | null;
  last_live_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  account_id: number | null;
  account_alias: string | null;
  event_type: string;
  message: string;
  created_at: string;
}

interface SettingRow {
  key: string;
  value: string;
}

interface BucketCooldownRow {
  account_id: number;
  bucket: string;
  cooldown_until: string;
  cooldown_reason: string | null;
  updated_at: string;
}

export interface ListAccountsFilter {
  q?: string;
  tag?: string;
  status?: EffectiveState | 'all';
}

export interface PickNextOptions {
  tag?: string;
  excludeAlias?: string;
  excludeAliases?: Iterable<string>;
  bucket?: string;
  policy?: RotationPolicy;
  requireAgyAliases?: Set<string>;
  now?: Date;
}

export class PoolDB {
  private readonly db: DatabaseSync;
  private readonly paths: PoolPaths;

  constructor(paths: PoolPaths) {
    this.paths = paths;
    ensureDirectories(paths);
    this.db = new DatabaseSync(paths.dbPath);
    try {
      fs.chmodSync(paths.dbPath, 0o600);
    } catch {
      // Best-effort file mode restriction.
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        plan_tier TEXT NOT NULL DEFAULT 'Google AI Pro',
        renewal_date TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        proxy_url TEXT,
        adc_credentials_path TEXT,
        profile_mode TEXT NOT NULL DEFAULT 'isolated',
        chrome_user_data_dir TEXT,
        chrome_profile_name TEXT,
        google_authuser TEXT,
        chrome_profile_dir TEXT NOT NULL,
        session_status TEXT NOT NULL DEFAULT 'unknown',
        session_detail TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        cooldown_reason TEXT,
        last_checked_at TEXT,
        last_live_at TEXT,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        account_alias TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_cooldowns (
        account_id INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        cooldown_until TEXT NOT NULL,
        cooldown_reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, bucket),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
    `);

    this.migrateSchema();
  }

  private migrateSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all() as unknown as Array<{ name: string }>;
    const existing = new Set(columns.map((c) => c.name));

    const migrations: Array<[string, string]> = [
      ['profile_mode', "TEXT NOT NULL DEFAULT 'isolated'"],
      ['chrome_user_data_dir', 'TEXT'],
      ['chrome_profile_name', 'TEXT'],
      ['google_authuser', 'TEXT'],
    ];

    for (const [col, def] of migrations) {
      if (!existing.has(col)) {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
      }
    }
  }

  private rowToAccount(row: AccountRow): AccountRecord {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string');
      }
    } catch {
      tags = [];
    }

    return {
      id: row.id,
      alias: row.alias,
      email: row.email,
      display_name: row.display_name,
      plan_tier: row.plan_tier as PlanTier,
      renewal_date: row.renewal_date,
      tags,
      notes: row.notes,
      proxy_url: row.proxy_url,
      adc_credentials_path: row.adc_credentials_path,
      profile_mode: row.profile_mode === 'linked' ? 'linked' : 'isolated',
      chrome_user_data_dir: row.chrome_user_data_dir ?? null,
      chrome_profile_name: row.chrome_profile_name ?? null,
      google_authuser: row.google_authuser ?? null,
      chrome_profile_dir: row.chrome_profile_dir,
      session_status: row.session_status as SessionStatus,
      session_detail: row.session_detail,
      is_active: row.is_active === 1,
      cooldown_until: row.cooldown_until,
      cooldown_reason: row.cooldown_reason,
      last_checked_at: row.last_checked_at,
      last_live_at: row.last_live_at,
      last_used_at: row.last_used_at,
      use_count: row.use_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Computes UI/CLI derived fields for an account without modifying DB state.
   */
  computeAccountView(
    account: AccountRecord,
    chromeRunning = false,
    now: Date = new Date(),
  ): AccountView {
    const nowMs = now.getTime();
    let cooldownRemainingMs = 0;
    if (account.cooldown_until) {
      const untilMs = Date.parse(account.cooldown_until);
      if (!Number.isNaN(untilMs) && untilMs > nowMs) {
        cooldownRemainingMs = untilMs - nowMs;
      }
    }

    let renewalDaysLeft: number | null = null;
    if (account.renewal_date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(account.renewal_date);
      if (m) {
        const renewalUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        renewalDaysLeft = Math.round((renewalUtc - todayUtc) / 86_400_000);
      }
    }

    let effectiveState: EffectiveState;
    if (account.session_status === 'needs_login') {
      effectiveState = 'needs_login';
    } else if (account.session_status === 'error') {
      effectiveState = 'error';
    } else if (cooldownRemainingMs > 0) {
      effectiveState = 'cooldown';
    } else if (account.is_active) {
      effectiveState = 'active';
    } else if (account.session_status === 'checking') {
      effectiveState = 'checking';
    } else if (account.session_status === 'live') {
      effectiveState = 'ready';
    } else {
      effectiveState = 'unknown';
    }

    const bucketCooldowns = this.listBucketCooldowns(account.id, now);

    return {
      ...account,
      effective_state: effectiveState,
      cooldown_remaining_ms: cooldownRemainingMs,
      bucket_cooldowns: bucketCooldowns,
      renewal_days_left: renewalDaysLeft,
      chrome_running: chromeRunning,
    };
  }

  getSettings(): DaemonSettings {
    const defaults = getDefaultSettings();
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as SettingRow[];
    const merged: Record<string, unknown> = { ...defaults };

    for (const row of rows) {
      try {
        merged[row.key] = JSON.parse(row.value);
      } catch {
        merged[row.key] = row.value;
      }
    }

    let rotationPolicy: RotationPolicy = defaults.rotation_policy;
    if (typeof merged.rotation_policy === 'string') {
      try {
        rotationPolicy = validateRotationPolicy(merged.rotation_policy);
      } catch {
        rotationPolicy = defaults.rotation_policy;
      }
    }

    let language: Locale = defaults.language;
    if (typeof merged.language === 'string') {
      try {
        language = validateLocale(merged.language);
      } catch {
        language = defaults.language;
      }
    }

    let chromeBinary = defaults.chrome_binary;
    if (typeof merged.chrome_binary === 'string' && merged.chrome_binary.trim()) {
      try {
        chromeBinary = validateChromeBinary(merged.chrome_binary);
      } catch {
        chromeBinary = defaults.chrome_binary;
      }
    }

    return {
      keepalive_enabled: Boolean(merged.keepalive_enabled),
      keepalive_interval_minutes: clampNumber(merged.keepalive_interval_minutes, 10, 1440, defaults.keepalive_interval_minutes),
      keepalive_jitter_percent: clampNumber(merged.keepalive_jitter_percent, 0, 50, defaults.keepalive_jitter_percent),
      keepalive_stagger_seconds: clampNumber(merged.keepalive_stagger_seconds, 0, 300, defaults.keepalive_stagger_seconds),
      default_cooldown_hours: clampNumber(merged.default_cooldown_hours, 0.25, 720, defaults.default_cooldown_hours),
      notify_on_expiry: Boolean(merged.notify_on_expiry),
      chrome_binary: chromeBinary,
      default_open_url:
        typeof merged.default_open_url === 'string' && merged.default_open_url.trim()
          ? merged.default_open_url.trim()
          : defaults.default_open_url,
      rotation_policy: rotationPolicy,
      renewal_alert_days: clampNumber(merged.renewal_alert_days, 1, 90, defaults.renewal_alert_days),
      language,
    };
  }

  updateSettings(partial: Partial<DaemonSettings>): DaemonSettings {
    const current = this.getSettings();
    const next: DaemonSettings = {
      keepalive_enabled:
        partial.keepalive_enabled !== undefined ? Boolean(partial.keepalive_enabled) : current.keepalive_enabled,
      keepalive_interval_minutes:
        partial.keepalive_interval_minutes !== undefined
          ? clampNumber(partial.keepalive_interval_minutes, 10, 1440, current.keepalive_interval_minutes)
          : current.keepalive_interval_minutes,
      keepalive_jitter_percent:
        partial.keepalive_jitter_percent !== undefined
          ? clampNumber(partial.keepalive_jitter_percent, 0, 50, current.keepalive_jitter_percent)
          : current.keepalive_jitter_percent,
      keepalive_stagger_seconds:
        partial.keepalive_stagger_seconds !== undefined
          ? clampNumber(partial.keepalive_stagger_seconds, 0, 300, current.keepalive_stagger_seconds)
          : current.keepalive_stagger_seconds,
      default_cooldown_hours:
        partial.default_cooldown_hours !== undefined
          ? clampNumber(partial.default_cooldown_hours, 0.25, 720, current.default_cooldown_hours)
          : current.default_cooldown_hours,
      notify_on_expiry:
        partial.notify_on_expiry !== undefined ? Boolean(partial.notify_on_expiry) : current.notify_on_expiry,
      chrome_binary:
        partial.chrome_binary !== undefined && partial.chrome_binary.trim()
          ? validateChromeBinary(partial.chrome_binary)
          : current.chrome_binary,
      default_open_url:
        partial.default_open_url !== undefined && partial.default_open_url.trim()
          ? validateHttpOpenUrl(partial.default_open_url)
          : current.default_open_url,
      rotation_policy:
        partial.rotation_policy !== undefined
          ? validateRotationPolicy(partial.rotation_policy)
          : current.rotation_policy,
      renewal_alert_days:
        partial.renewal_alert_days !== undefined
          ? clampNumber(partial.renewal_alert_days, 1, 90, current.renewal_alert_days)
          : current.renewal_alert_days,
      language:
        partial.language !== undefined
          ? validateLocale(partial.language)
          : current.language,
    };

    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(next)) {
        stmt.run(k, JSON.stringify(v));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return next;
  }

  private ensureProfileDirectory(alias: string): string {
    const profileDir = path.join(this.paths.chromeProfilesDir, alias);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(profileDir, 0o700);
    } catch {
      // Best-effort.
    }
    return profileDir;
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    const alias = validateAlias(input.alias);
    const email = validateEmail(input.email);
    const displayName = (input.display_name ?? '').trim();
    const planTier = validatePlanTier(input.plan_tier);
    const renewalDate = validateRenewalDate(input.renewal_date);
    const tags = normalizeTags(input.tags);
    const notes = (input.notes ?? '').trim();
    const proxyUrl = validateProxyUrl(input.proxy_url);
    const adcPath = validateAdcCredentialsPath(input.adc_credentials_path);
    const profileMode: ProfileMode = input.profile_mode === 'linked' ? 'linked' : 'isolated';

    if (this.getAccountByAlias(alias)) {
      throw new Error(`Tài khoản với alias "${alias}" đã tồn tại.`);
    }
    if (this.getAccountByEmail(email)) {
      throw new Error(`Tài khoản với email "${email}" đã tồn tại.`);
    }

    let chromeUserDataDir: string | null = null;
    let chromeProfileName: string | null = null;
    let googleAuthuser: string | null = input.google_authuser?.trim() || null;
    let profileDir: string;

    if (profileMode === 'linked') {
      if (!input.chrome_user_data_dir?.trim() || !input.chrome_profile_name?.trim()) {
        throw new Error('Chế độ linked yêu cầu chrome_user_data_dir và chrome_profile_name.');
      }
      chromeUserDataDir = path.resolve(input.chrome_user_data_dir.trim());
      chromeProfileName = validateChromeProfileName(input.chrome_profile_name);
      profileDir = path.join(chromeUserDataDir, chromeProfileName);
      googleAuthuser = googleAuthuser || email;
    } else {
      profileDir = this.ensureProfileDirectory(alias);
    }

    const nowIso = new Date().toISOString();
    const initialStatus: SessionStatus = input.initial_session_status ?? 'unknown';
    const initialDetail = input.initial_session_detail ?? null;
    const initialLiveAt = initialStatus === 'live' ? nowIso : null;
    const initialCheckedAt = initialStatus !== 'unknown' ? nowIso : null;

    const insert = this.db.prepare(`
      INSERT INTO accounts (
        alias, email, display_name, plan_tier, renewal_date, tags_json, notes,
        proxy_url, adc_credentials_path, profile_mode, chrome_user_data_dir,
        chrome_profile_name, google_authuser, chrome_profile_dir,
        session_status, session_detail, last_checked_at, last_live_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = insert.run(
      alias,
      email,
      displayName,
      planTier,
      renewalDate,
      JSON.stringify(tags),
      notes,
      proxyUrl,
      adcPath,
      profileMode,
      chromeUserDataDir,
      chromeProfileName,
      googleAuthuser,
      profileDir,
      initialStatus,
      initialDetail,
      initialCheckedAt,
      initialLiveAt,
      nowIso,
      nowIso,
    );

    const created = this.getAccount(Number(info.lastInsertRowid));
    if (!created) {
      throw new Error('Không thể đọc lại tài khoản vừa tạo.');
    }

    const modeMsg = profileMode === 'linked' ? ` [Link: ${chromeProfileName}]` : '';
    this.addEvent(
      created.id,
      created.alias,
      'account_added',
      `Đã thêm tài khoản ${created.alias} (${created.email})${modeMsg}`,
    );
    return created;
  }

  private getAccountByAlias(alias: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE alias = ?').get(alias.trim().toLowerCase()) as
      | AccountRow
      | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  private getAccountByEmail(email: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email.trim().toLowerCase()) as
      | AccountRow
      | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  getAccount(aliasOrId: string | number): AccountRecord | null {
    if (typeof aliasOrId === 'number') {
      const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(aliasOrId) as AccountRow | undefined;
      return row ? this.rowToAccount(row) : null;
    }
    const byAlias = this.getAccountByAlias(aliasOrId);
    if (byAlias) return byAlias;
    if (/^\d+$/.test(aliasOrId.trim())) {
      const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(aliasOrId.trim())) as
        | AccountRow
        | undefined;
      return row ? this.rowToAccount(row) : null;
    }
    return null;
  }

  getActiveAccount(): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE is_active = 1 LIMIT 1').get() as AccountRow | undefined;
    return row ? this.rowToAccount(row) : null;
  }

  listAccounts(filter?: ListAccountsFilter): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY is_active DESC, alias ASC')
      .all() as unknown as AccountRow[];
    let accounts = rows.map((row) => this.rowToAccount(row));

    if (filter?.q) {
      const q = filter.q.trim().toLowerCase();
      if (q) {
        accounts = accounts.filter(
          (acc) =>
            acc.alias.toLowerCase().includes(q) ||
            acc.email.toLowerCase().includes(q) ||
            acc.display_name.toLowerCase().includes(q) ||
            acc.notes.toLowerCase().includes(q) ||
            acc.tags.some((t) => t.toLowerCase().includes(q)),
        );
      }
    }

    if (filter?.tag) {
      const tag = filter.tag.trim().toLowerCase();
      if (tag) {
        accounts = accounts.filter((acc) => acc.tags.includes(tag));
      }
    }

    if (filter?.status && filter.status !== 'all') {
      accounts = accounts.filter((acc) => this.computeAccountView(acc).effective_state === filter.status);
    }

    return accounts;
  }

  updateAccount(aliasOrId: string | number, patch: UpdateAccountInput): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    const nextAlias = patch.alias !== undefined ? validateAlias(patch.alias) : existing.alias;
    const nextEmail = patch.email !== undefined ? validateEmail(patch.email) : existing.email;
    const nextDisplayName = patch.display_name !== undefined ? patch.display_name.trim() : existing.display_name;
    const nextPlanTier = patch.plan_tier !== undefined ? validatePlanTier(patch.plan_tier) : existing.plan_tier;
    const nextRenewalDate =
      patch.renewal_date !== undefined ? validateRenewalDate(patch.renewal_date) : existing.renewal_date;
    const nextTags = patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags;
    const nextNotes = patch.notes !== undefined ? patch.notes.trim() : existing.notes;
    const nextProxyUrl = patch.proxy_url !== undefined ? validateProxyUrl(patch.proxy_url) : existing.proxy_url;
    const nextAdcPath =
      patch.adc_credentials_path !== undefined
        ? validateAdcCredentialsPath(patch.adc_credentials_path)
        : existing.adc_credentials_path;

    const nextProfileMode: ProfileMode =
      patch.profile_mode !== undefined
        ? patch.profile_mode === 'linked'
          ? 'linked'
          : 'isolated'
        : existing.profile_mode;

    let nextUserDataDir =
      patch.chrome_user_data_dir !== undefined
        ? patch.chrome_user_data_dir?.trim()
          ? path.resolve(patch.chrome_user_data_dir.trim())
          : null
        : existing.chrome_user_data_dir;

    let nextProfileName =
      patch.chrome_profile_name !== undefined
        ? patch.chrome_profile_name?.trim()
          ? validateChromeProfileName(patch.chrome_profile_name)
          : null
        : existing.chrome_profile_name;

    let nextGoogleAuthuser =
      patch.google_authuser !== undefined
        ? patch.google_authuser?.trim() || null
        : existing.google_authuser;

    if (nextAlias !== existing.alias) {
      const clash = this.getAccountByAlias(nextAlias);
      if (clash && clash.id !== existing.id) {
        throw new Error(`Alias "${nextAlias}" đã được dùng bởi tài khoản khác.`);
      }
    }
    if (nextEmail.toLowerCase() !== existing.email.toLowerCase()) {
      const clash = this.getAccountByEmail(nextEmail);
      if (clash && clash.id !== existing.id) {
        throw new Error(`Email "${nextEmail}" đã được dùng bởi tài khoản khác.`);
      }
    }

    let nextProfileDir = existing.chrome_profile_dir;
    if (nextProfileMode === 'linked') {
      if (!nextUserDataDir || !nextProfileName) {
        throw new Error('Chế độ linked yêu cầu chrome_user_data_dir và chrome_profile_name.');
      }
      nextProfileDir = path.join(nextUserDataDir, nextProfileName);
      nextGoogleAuthuser = nextGoogleAuthuser || nextEmail;
    } else {
      nextUserDataDir = null;
      nextProfileName = null;
      if (existing.profile_mode !== 'isolated') {
        nextProfileDir = this.ensureProfileDirectory(nextAlias);
      } else if (nextAlias !== existing.alias) {
        const renamedDir = path.join(this.paths.chromeProfilesDir, nextAlias);
        if (fs.existsSync(existing.chrome_profile_dir) && !fs.existsSync(renamedDir)) {
          fs.renameSync(existing.chrome_profile_dir, renamedDir);
        } else {
          fs.mkdirSync(renamedDir, { recursive: true, mode: 0o700 });
        }
        nextProfileDir = renamedDir;
      }
    }

    const nowIso = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE accounts
        SET alias = ?, email = ?, display_name = ?, plan_tier = ?, renewal_date = ?,
            tags_json = ?, notes = ?, proxy_url = ?, adc_credentials_path = ?,
            profile_mode = ?, chrome_user_data_dir = ?, chrome_profile_name = ?,
            google_authuser = ?, chrome_profile_dir = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        nextAlias,
        nextEmail,
        nextDisplayName,
        nextPlanTier,
        nextRenewalDate,
        JSON.stringify(nextTags),
        nextNotes,
        nextProxyUrl,
        nextAdcPath,
        nextProfileMode,
        nextUserDataDir,
        nextProfileName,
        nextGoogleAuthuser,
        nextProfileDir,
        nowIso,
        existing.id,
      );

    const updated = this.getAccount(existing.id);
    if (!updated) {
      throw new Error('Không thể đọc lại tài khoản sau khi cập nhật.');
    }
    if (nextAlias !== existing.alias) {
      renameSessionFilesForAlias(this.paths, existing.alias, nextAlias);
    }
    this.addEvent(updated.id, updated.alias, 'account_updated', `Đã cập nhật thông tin ${updated.alias}`);
    return updated;
  }

  /**
   * Converts a linked-mode account to its own isolated Chrome profile under GPOOL_HOME.
   */
  isolateAccount(aliasOrId: string | number): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    const profileDir = this.ensureProfileDirectory(existing.alias);
    if (existing.profile_mode === 'isolated') {
      return existing;
    }

    const nowIso = new Date().toISOString();
    const detail = 'Đã tách sang profile riêng — mở Chrome để đăng nhập 1 lần';

    this.db
      .prepare(`
        UPDATE accounts
        SET profile_mode = 'isolated',
            chrome_user_data_dir = NULL,
            chrome_profile_name = NULL,
            google_authuser = NULL,
            chrome_profile_dir = ?,
            session_status = 'unknown',
            session_detail = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(profileDir, detail, nowIso, existing.id);

    const updated = this.getAccount(existing.id)!;
    this.addEvent(
      updated.id,
      updated.alias,
      'account_isolated',
      `Đã tách ${updated.alias} sang Chrome profile độc lập`,
    );
    return updated;
  }

  /**
   * Converts all currently linked-mode accounts into independent isolated Chrome profiles.
   */
  isolateAllLinkedAccounts(): AccountRecord[] {
    const linkedAccounts = this.listAccounts().filter((acc) => acc.profile_mode === 'linked');
    const isolated: AccountRecord[] = [];
    for (const acc of linkedAccounts) {
      isolated.push(this.isolateAccount(acc.id));
    }
    return isolated;
  }

  deleteAccount(aliasOrId: string | number, options: { purgeProfile?: boolean } = {}): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(existing.id);
    this.addEvent(null, existing.alias, 'account_deleted', `Đã xóa tài khoản ${existing.alias} (${existing.email})`);
    deleteSessionFilesForAlias(this.paths, existing.alias);

    if (options.purgeProfile && existing.profile_mode === 'isolated') {
      const resolvedProfilesRoot = path.resolve(this.paths.chromeProfilesDir);
      const resolvedProfile = path.resolve(existing.chrome_profile_dir);
      if (
        resolvedProfile.startsWith(resolvedProfilesRoot + path.sep) &&
        fs.existsSync(resolvedProfile)
      ) {
        fs.rmSync(resolvedProfile, { recursive: true, force: true });
      }
    }

    return existing;
  }

  setActiveAccount(aliasOrId: string | number): { previous: AccountRecord | null; active: AccountRecord } {
    const target = this.getAccount(aliasOrId);
    if (!target) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    const previous = this.getActiveAccount();
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE accounts SET is_active = 0 WHERE is_active = 1').run();
      this.db
        .prepare(
          'UPDATE accounts SET is_active = 1, last_used_at = ?, use_count = use_count + 1, updated_at = ? WHERE id = ?',
        )
        .run(nowIso, nowIso, target.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const active = this.getAccount(target.id);
    if (!active) {
      throw new Error('Không thể đọc lại tài khoản đang kích hoạt.');
    }
    const msg =
      previous && previous.alias !== active.alias
        ? `Chuyển từ ${previous.alias} sang ${active.alias}`
        : `Kích hoạt tài khoản ${active.alias}`;
    this.addEvent(active.id, active.alias, 'switch', msg);
    return { previous, active };
  }

  setCooldown(aliasOrId: string | number, untilIso: string, reason = ''): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const untilMs = Date.parse(untilIso);
    if (Number.isNaN(untilMs)) {
      throw new Error(`Thời gian cooldown không hợp lệ: "${untilIso}".`);
    }

    const normalizedUntil = new Date(untilMs).toISOString();
    const nowIso = new Date().toISOString();
    const cleanReason = reason.trim();

    this.db
      .prepare('UPDATE accounts SET cooldown_until = ?, cooldown_reason = ?, updated_at = ? WHERE id = ?')
      .run(normalizedUntil, cleanReason || null, nowIso, existing.id);

    const updated = this.getAccount(existing.id)!;
    this.addEvent(
      updated.id,
      updated.alias,
      'cooldown_set',
      `Đặt cooldown cho ${updated.alias} đến ${normalizedUntil}${cleanReason ? ` (${cleanReason})` : ''}`,
    );
    return updated;
  }

  clearCooldown(aliasOrId: string | number, bucket?: string): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const cleanBucket = bucket ? validateBucketName(bucket) : undefined;
    const nowIso = new Date().toISOString();

    if (cleanBucket && cleanBucket !== 'all') {
      this.db
        .prepare('DELETE FROM account_cooldowns WHERE account_id = ? AND bucket = ?')
        .run(existing.id, cleanBucket);
      const updated = this.getAccount(existing.id)!;
      this.addEvent(
        updated.id,
        updated.alias,
        'cooldown_cleared',
        `Đã gỡ cooldown [${cleanBucket}] cho ${updated.alias}`,
      );
      return updated;
    }

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE accounts SET cooldown_until = NULL, cooldown_reason = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso, existing.id);
      if (!cleanBucket) {
        this.db.prepare('DELETE FROM account_cooldowns WHERE account_id = ?').run(existing.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const updated = this.getAccount(existing.id)!;
    this.addEvent(updated.id, updated.alias, 'cooldown_cleared', `Đã gỡ cooldown cho ${updated.alias}`);
    return updated;
  }

  /**
   * Sets a cooldown scoped to a specific model/quota bucket (e.g. `pro`, `claude`, `flash`),
   * or account-wide when `bucket` is `'all'`.
   */
  setBucketCooldown(
    aliasOrId: string | number,
    bucket: string,
    untilIso: string,
    reason = '',
  ): AccountRecord {
    const cleanBucket = validateBucketName(bucket);
    if (cleanBucket === 'all') {
      return this.setCooldown(aliasOrId, untilIso, reason);
    }

    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const untilMs = Date.parse(untilIso);
    if (Number.isNaN(untilMs)) {
      throw new Error(`Thời gian cooldown không hợp lệ: "${untilIso}".`);
    }

    const normalizedUntil = new Date(untilMs).toISOString();
    const nowIso = new Date().toISOString();
    const cleanReason = reason.trim();

    this.db
      .prepare(`
        INSERT INTO account_cooldowns (account_id, bucket, cooldown_until, cooldown_reason, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, bucket) DO UPDATE SET
          cooldown_until = excluded.cooldown_until,
          cooldown_reason = excluded.cooldown_reason,
          updated_at = excluded.updated_at
      `)
      .run(existing.id, cleanBucket, normalizedUntil, cleanReason || null, nowIso);

    const updated = this.getAccount(existing.id)!;
    this.addEvent(
      updated.id,
      updated.alias,
      'bucket_cooldown_set',
      `Đặt cooldown [${cleanBucket}] cho ${updated.alias} đến ${normalizedUntil}${cleanReason ? ` (${cleanReason})` : ''}`,
    );
    return updated;
  }

  listBucketCooldowns(accountId: number, now: Date = new Date()): BucketCooldown[] {
    const nowMs = now.getTime();
    const rows = this.db
      .prepare('SELECT * FROM account_cooldowns WHERE account_id = ? ORDER BY bucket ASC')
      .all(accountId) as unknown as BucketCooldownRow[];
    const active: BucketCooldown[] = [];
    for (const row of rows) {
      const untilMs = Date.parse(row.cooldown_until);
      if (!Number.isNaN(untilMs) && untilMs > nowMs) {
        active.push({
          bucket: row.bucket,
          cooldown_until: row.cooldown_until,
          cooldown_reason: row.cooldown_reason,
          remaining_ms: untilMs - nowMs,
        });
      }
    }
    return active;
  }

  /**
   * Clears elapsed cooldowns (both account-wide and per-bucket) and returns aliases that just became ready again.
   */
  expireElapsedCooldowns(now: Date = new Date()): string[] {
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const rows = this.db
      .prepare('SELECT id, alias, cooldown_until FROM accounts WHERE cooldown_until IS NOT NULL')
      .all() as unknown as Array<{ id: number; alias: string; cooldown_until: string }>;

    const expired: Array<{ id: number; alias: string }> = [];
    for (const row of rows) {
      const ms = Date.parse(row.cooldown_until);
      if (Number.isNaN(ms) || ms <= nowMs) {
        expired.push({ id: row.id, alias: row.alias });
      }
    }

    const bucketRows = this.db
      .prepare('SELECT account_id, bucket, cooldown_until FROM account_cooldowns')
      .all() as unknown as Array<{ account_id: number; bucket: string; cooldown_until: string }>;
    const expiredBuckets = bucketRows.filter((row) => {
      const ms = Date.parse(row.cooldown_until);
      return Number.isNaN(ms) || ms <= nowMs;
    });

    if (expired.length === 0 && expiredBuckets.length === 0) return [];

    const stmt = this.db.prepare(
      'UPDATE accounts SET cooldown_until = NULL, cooldown_reason = NULL, updated_at = ? WHERE id = ?',
    );
    const delBucket = this.db.prepare('DELETE FROM account_cooldowns WHERE account_id = ? AND bucket = ?');

    this.db.exec('BEGIN');
    try {
      for (const item of expired) {
        stmt.run(nowIso, item.id);
      }
      for (const b of expiredBuckets) {
        delBucket.run(b.account_id, b.bucket);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    for (const item of expired) {
      this.addEvent(item.id, item.alias, 'cooldown_expired', `${item.alias} đã hết thời gian cooldown`);
    }
    return expired.map((e) => e.alias);
  }

  updateSessionStatus(
    aliasOrId: string | number,
    status: SessionStatus,
    detail: string | null = null,
    checkedAt: Date = new Date(),
  ): AccountRecord {
    const existing = this.getAccount(aliasOrId);
    if (!existing) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const checkedIso = checkedAt.toISOString();
    const nextLiveAt = status === 'live' ? checkedIso : existing.last_live_at;

    this.db
      .prepare(`
        UPDATE accounts
        SET session_status = ?, session_detail = ?, last_checked_at = ?, last_live_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, detail, checkedIso, nextLiveAt, checkedIso, existing.id);

    return this.getAccount(existing.id)!;
  }

  /**
   * Picks the best next ready account for rotation:
   * - Excludes `excludeAlias` and `excludeAliases`
   * - Excludes accounts in active cooldown (account-wide or matching `bucket`)
   * - Excludes `needs_login` and `error`
   * - Filters by optional `tag` and `requireAgyAliases`
   * - Ranks `live` above `unknown`/`checking`, then by `policy`:
   *   - `lru` (default): least-recently-used first (never used first, oldest last_used_at)
   *   - `round-robin`: lowest use_count first, then oldest last_used_at
   *   - `tier-first`: highest plan tier (Enterprise > Ultra > Pro > Free) first, then LRU
   */
  pickNextReadyAccount(options: PickNextOptions = {}): AccountRecord | null {
    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    const excludeSet = new Set<string>();
    if (options.excludeAlias) excludeSet.add(options.excludeAlias.trim().toLowerCase());
    if (options.excludeAliases) {
      for (const a of options.excludeAliases) excludeSet.add(a.trim().toLowerCase());
    }
    const requiredTag = options.tag?.trim().toLowerCase();
    const bucket = validateBucketName(options.bucket);
    const policy = options.policy ?? this.getSettings().rotation_policy;
    const requireAgy = options.requireAgyAliases;

    const candidates = this.listAccounts().filter((acc) => {
      if (excludeSet.has(acc.alias)) return false;
      if (requireAgy && !requireAgy.has(acc.alias)) return false;
      if (acc.session_status === 'needs_login' || acc.session_status === 'error') return false;
      if (acc.cooldown_until) {
        const untilMs = Date.parse(acc.cooldown_until);
        if (!Number.isNaN(untilMs) && untilMs > nowMs) return false;
      }
      if (bucket !== 'all') {
        const buckets = this.listBucketCooldowns(acc.id, now);
        if (buckets.some((b) => b.bucket === bucket && b.remaining_ms > 0)) return false;
      }
      if (requiredTag && !acc.tags.includes(requiredTag)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    const tierRank = (tier: PlanTier): number => {
      switch (tier) {
        case 'Enterprise':
          return 0;
        case 'Google AI Ultra':
          return 1;
        case 'Google AI Pro':
          return 2;
        default:
          return 3;
      }
    };

    candidates.sort((a, b) => {
      const aLive = a.session_status === 'live' ? 0 : 1;
      const bLive = b.session_status === 'live' ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;

      if (policy === 'tier-first') {
        const tr = tierRank(a.plan_tier) - tierRank(b.plan_tier);
        if (tr !== 0) return tr;
      } else if (policy === 'round-robin') {
        if (a.use_count !== b.use_count) return a.use_count - b.use_count;
      }

      const aUsed = a.last_used_at ? Date.parse(a.last_used_at) : -1;
      const bUsed = b.last_used_at ? Date.parse(b.last_used_at) : -1;
      if (aUsed !== bUsed) return aUsed - bUsed;

      return a.id - b.id;
    });

    return candidates[0];
  }

  /**
   * Returns the earliest future cooldown_until timestamp across all eligible accounts
   * (considering account-wide cooldowns and optional bucket / agy filter).
   */
  getEarliestCooldownEnd(
    tag?: string,
    now: Date = new Date(),
    bucket?: string,
    requireAgyAliases?: Set<string>,
  ): string | null {
    const nowMs = now.getTime();
    const requiredTag = tag?.trim().toLowerCase();
    const cleanBucket = validateBucketName(bucket);
    let earliestMs: number | null = null;

    const consider = (iso: string | null) => {
      if (!iso) return;
      const untilMs = Date.parse(iso);
      if (!Number.isNaN(untilMs) && untilMs > nowMs) {
        if (earliestMs === null || untilMs < earliestMs) {
          earliestMs = untilMs;
        }
      }
    };

    for (const acc of this.listAccounts()) {
      if (requiredTag && !acc.tags.includes(requiredTag)) continue;
      if (requireAgyAliases && !requireAgyAliases.has(acc.alias)) continue;
      if (acc.session_status === 'needs_login' || acc.session_status === 'error') continue;
      consider(acc.cooldown_until);
      if (cleanBucket !== 'all') {
        for (const b of this.listBucketCooldowns(acc.id, now)) {
          if (b.bucket === cleanBucket) consider(b.cooldown_until);
        }
      }
    }

    return earliestMs !== null ? new Date(earliestMs).toISOString() : null;
  }

  /**
   * Returns accounts whose renewal_date falls within `daysThreshold` days (including overdue).
   */
  getRenewalAlerts(daysThreshold?: number, now: Date = new Date()): RenewalAlert[] {
    const limit = daysThreshold ?? this.getSettings().renewal_alert_days;
    const alerts: RenewalAlert[] = [];
    for (const acc of this.listAccounts()) {
      if (!acc.renewal_date) continue;
      const view = this.computeAccountView(acc, false, now);
      if (view.renewal_days_left !== null && view.renewal_days_left <= limit) {
        alerts.push({
          alias: acc.alias,
          email: acc.email,
          plan_tier: acc.plan_tier,
          renewal_date: acc.renewal_date,
          days_left: view.renewal_days_left,
        });
      }
    }
    alerts.sort((a, b) => a.days_left - b.days_left);
    return alerts;
  }

  addEvent(accountId: number | null, accountAlias: string | null, eventType: string, message: string): PoolEvent {
    const nowIso = new Date().toISOString();
    const info = this.db
      .prepare('INSERT INTO events (account_id, account_alias, event_type, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, accountAlias, eventType, message, nowIso);

    this.db
      .prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 500)')
      .run();

    return {
      id: Number(info.lastInsertRowid),
      account_id: accountId,
      account_alias: accountAlias,
      event_type: eventType,
      message,
      created_at: nowIso,
    };
  }

  listEvents(limit = 50): PoolEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      account_id: row.account_id,
      account_alias: row.account_alias,
      event_type: row.event_type,
      message: row.message,
      created_at: row.created_at,
    }));
  }

  exportMetadata(options: { includeSensitiveProxyCredentials?: boolean } = {}): PoolExportPayload {
    const accounts = this.listAccounts().map((acc) => ({
      alias: acc.alias,
      email: acc.email,
      display_name: acc.display_name,
      plan_tier: acc.plan_tier,
      renewal_date: acc.renewal_date,
      tags: acc.tags,
      notes: acc.notes,
      proxy_url: options.includeSensitiveProxyCredentials ? acc.proxy_url : redactProxyUrl(acc.proxy_url),
      adc_credentials_path: acc.adc_credentials_path,
      profile_mode: acc.profile_mode,
      chrome_user_data_dir: acc.chrome_user_data_dir,
      chrome_profile_name: acc.chrome_profile_name,
      google_authuser: acc.google_authuser,
    }));

    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: this.getSettings(),
      accounts,
    };
  }

  importMetadata(
    payload: PoolExportPayload,
    options: { allowHostPaths?: boolean } = {},
  ): { created: number; updated: number } {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) {
      throw new Error('Dữ liệu import không hợp lệ (thiếu danh sách accounts).');
    }

    let created = 0;
    let updated = 0;

    for (const item of payload.accounts) {
      if (!item || typeof item.alias !== 'string' || typeof item.email !== 'string') {
        throw new Error('Mỗi account trong file import cần có alias và email.');
      }
      const normalizedAlias = validateAlias(item.alias);
      const existing = this.getAccountByAlias(normalizedAlias) ?? this.getAccountByEmail(item.email);
      const safeAdcPath = options.allowHostPaths ? item.adc_credentials_path : undefined;
      if (existing) {
        this.updateAccount(existing.id, {
          alias: normalizedAlias,
          email: item.email,
          display_name: item.display_name,
          plan_tier: item.plan_tier,
          renewal_date: item.renewal_date,
          tags: item.tags,
          notes: item.notes,
          proxy_url: item.proxy_url,
          ...(safeAdcPath !== undefined ? { adc_credentials_path: safeAdcPath } : {}),
          profile_mode: item.profile_mode,
          chrome_user_data_dir: item.chrome_user_data_dir,
          chrome_profile_name: item.chrome_profile_name,
          google_authuser: item.google_authuser,
        });
        updated += 1;
      } else {
        this.createAccount({
          alias: normalizedAlias,
          email: item.email,
          display_name: item.display_name,
          plan_tier: item.plan_tier,
          renewal_date: item.renewal_date,
          tags: item.tags,
          notes: item.notes,
          proxy_url: item.proxy_url,
          adc_credentials_path: safeAdcPath ?? null,
          profile_mode: item.profile_mode,
          chrome_user_data_dir: item.chrome_user_data_dir,
          chrome_profile_name: item.chrome_profile_name,
          google_authuser: item.google_authuser,
        });
        created += 1;
      }
    }

    if (payload.settings && typeof payload.settings === 'object') {
      // Never allow imported metadata bundles to silently overwrite host executable paths.
      const { chrome_binary: _ignoredBinary, ...safeSettings } = payload.settings;
      this.updateSettings(safeSettings);
    }

    this.addEvent(null, null, 'import', `Import metadata: thêm ${created}, cập nhật ${updated} tài khoản`);
    return { created, updated };
  }

  close(): void {
    this.db.close();
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function validateHttpOpenUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`URL mặc định không hợp lệ ("${trimmed}").`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`URL mặc định phải là http:// hoặc https:// ("${trimmed}").`);
  }
  return trimmed;
}
