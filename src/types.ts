export type SessionStatus = 'unknown' | 'live' | 'needs_login' | 'checking' | 'error';

export type EffectiveState =
  | 'active'
  | 'ready'
  | 'cooldown'
  | 'needs_login'
  | 'checking'
  | 'unknown'
  | 'error';

export type PlanTier = 'Google AI Pro' | 'Google AI Ultra' | 'Free' | 'Enterprise';

export type ProfileMode = 'isolated' | 'linked';

export type RotationPolicy = 'lru' | 'round-robin' | 'tier-first';

export type Locale = 'vi' | 'en';

export interface BucketCooldown {
  bucket: string;
  cooldown_until: string;
  cooldown_reason: string | null;
  remaining_ms: number;
}

export interface AgyLeaseInfo {
  pid: number;
  alias: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
  stale: boolean;
}

export type AgyHealthStatus =
  | 'healthy'
  | 'needs_refresh'
  | 'missing_snapshot'
  | 'email_mismatch'
  | 'corrupt';

export interface AgyHealthEntry {
  alias: string;
  email: string;
  plan_tier: PlanTier;
  captured: boolean;
  encrypted: boolean;
  captured_at: string | null;
  detected_email: string | null;
  email_matches: boolean;
  has_refresh_token: boolean;
  token_expiry: string | null;
  access_token_expired: boolean | null;
  auth_method: string | null;
  health: AgyHealthStatus;
  detail: string;
  is_live: boolean;
}

export interface RenewalAlert {
  alias: string;
  email: string;
  plan_tier: PlanTier;
  renewal_date: string;
  days_left: number;
}

export interface AgyHealthReport {
  checked_at: string;
  keychain_present: boolean;
  live_owner_alias: string | null;
  running_clients: string[];
  lease: AgyLeaseInfo | null;
  summary: {
    total: number;
    healthy: number;
    needs_refresh: number;
    missing_snapshot: number;
    issues: number;
    encrypted: number;
    unencrypted: number;
    renewal_alerts: number;
  };
  accounts: AgyHealthEntry[];
  renewal_alerts: RenewalAlert[];
}

export interface EncryptedBackupBundle {
  format: 'gpool-encrypted-backup';
  version: 1;
  kdf: 'scrypt';
  alg: 'aes-256-gcm';
  salt_b64: string;
  iv_b64: string;
  tag_b64: string;
  includes_sessions: boolean;
  exported_at: string;
  ciphertext_b64: string;
}

export interface AgyEncryptMigrationResult {
  ok: true;
  encrypted: string[];
  already_encrypted: string[];
  failed: Array<{ alias: string; error: string }>;
}

export interface DailyActivityPoint {
  date: string;
  switches: number;
  agy_activations: number;
  quota_hits: number;
}

export interface AccountAnalyticsRow {
  alias: string;
  email: string;
  plan_tier: PlanTier;
  effective_state: EffectiveState;
  use_count: number;
  quota_hits_window: number;
  quota_hits_total: number;
  agy_captured: boolean;
  agy_encrypted: boolean;
  last_used_at: string | null;
}

export interface PoolAnalyticsReport {
  generated_at: string;
  window_days: number;
  summary: {
    total_accounts: number;
    ready_accounts: number;
    cooldown_accounts: number;
    needs_login_accounts: number;
    agy_captured_accounts: number;
    agy_encrypted_accounts: number;
    availability_percent: number;
    total_switches: number;
    total_agy_activations: number;
    quota_hits_window: number;
    quota_hits_total: number;
    switches_per_quota_hit: number | null;
  };
  daily: DailyActivityPoint[];
  accounts: AccountAnalyticsRow[];
}

export interface AccountRecord {
  id: number;
  alias: string;
  email: string;
  display_name: string;
  plan_tier: PlanTier;
  renewal_date: string | null;
  tags: string[];
  notes: string;
  proxy_url: string | null;
  adc_credentials_path: string | null;
  profile_mode: ProfileMode;
  chrome_user_data_dir: string | null;
  chrome_profile_name: string | null;
  google_authuser: string | null;
  chrome_profile_dir: string;
  session_status: SessionStatus;
  session_detail: string | null;
  is_active: boolean;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  last_checked_at: string | null;
  last_live_at: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface AgySessionInfo {
  captured: boolean;
  captured_at: string | null;
  detected_email: string | null;
  is_live_owner: boolean;
  active_alias: string | null;
}

export interface AccountView extends AccountRecord {
  effective_state: EffectiveState;
  cooldown_remaining_ms: number;
  bucket_cooldowns?: BucketCooldown[];
  renewal_days_left: number | null;
  chrome_running: boolean;
  agy_session?: AgySessionInfo | null;
}

export interface CreateAccountInput {
  alias: string;
  email: string;
  display_name?: string;
  plan_tier?: PlanTier;
  renewal_date?: string | null;
  tags?: string[];
  notes?: string;
  proxy_url?: string | null;
  adc_credentials_path?: string | null;
  profile_mode?: ProfileMode;
  chrome_user_data_dir?: string | null;
  chrome_profile_name?: string | null;
  google_authuser?: string | null;
  initial_session_status?: SessionStatus;
  initial_session_detail?: string | null;
}

export interface UpdateAccountInput {
  alias?: string;
  email?: string;
  display_name?: string;
  plan_tier?: PlanTier;
  renewal_date?: string | null;
  tags?: string[];
  notes?: string;
  proxy_url?: string | null;
  adc_credentials_path?: string | null;
  profile_mode?: ProfileMode;
  chrome_user_data_dir?: string | null;
  chrome_profile_name?: string | null;
  google_authuser?: string | null;
}

export interface PoolEvent {
  id: number;
  account_id: number | null;
  account_alias: string | null;
  event_type: string;
  message: string;
  created_at: string;
}

export interface DaemonSettings {
  keepalive_enabled: boolean;
  keepalive_interval_minutes: number;
  keepalive_jitter_percent: number;
  keepalive_stagger_seconds: number;
  default_cooldown_hours: number;
  notify_on_expiry: boolean;
  chrome_binary: string;
  default_open_url: string;
  rotation_policy: RotationPolicy;
  renewal_alert_days: number;
  language: Locale;
}

export interface SwitchResult {
  ok: boolean;
  previousAlias: string | null;
  active: AccountView;
  openedChrome: boolean;
  openedUrl: string | null;
  agyGuide: string;
}

export interface RotateResult {
  ok: boolean;
  previousAlias: string | null;
  active?: AccountView;
  openedChrome?: boolean;
  openedUrl?: string | null;
  agyGuide?: string;
  agyActivated?: boolean;
  recapturedAlias?: string | null;
  bucket?: string;
  policy?: RotationPolicy;
  error?: string;
  nextAvailableAt?: string | null;
}

export type KeepAliveProbeOutcome = SessionStatus | 'skipped_open';

export interface KeepAliveResult {
  alias: string;
  previousStatus: SessionStatus;
  status: KeepAliveProbeOutcome;
  detail: string;
  checkedAt: string;
  notified: boolean;
}

export interface KeepAliveStatus {
  running: boolean;
  sweeping: boolean;
  activeProbes: string[];
  lastSweepAt: string | null;
  lastError: string | null;
}

export interface PoolExportPayload {
  version: number;
  exportedAt: string;
  settings: Partial<DaemonSettings>;
  accounts: Array<{
    alias: string;
    email: string;
    display_name: string;
    plan_tier: PlanTier;
    renewal_date: string | null;
    tags: string[];
    notes: string;
    proxy_url: string | null;
    adc_credentials_path: string | null;
    profile_mode?: ProfileMode;
    chrome_user_data_dir?: string | null;
    chrome_profile_name?: string | null;
    google_authuser?: string | null;
  }>;
}

export interface DiscoveredBrowserProfile {
  browser: string;
  chromeBinary: string;
  userDataDir: string;
  profileName: string;
  displayName: string;
  primaryEmail: string | null;
  hasCookies: boolean;
  accounts: Array<{
    email: string;
    fullName: string;
    isPrimary: boolean;
  }>;
}

export interface DiscoveredBrowserAccount {
  browser: string;
  chromeBinary: string;
  userDataDir: string;
  profileName: string;
  profileDisplayName: string;
  email: string;
  fullName: string;
  suggestedAlias: string;
  alreadyInPool: boolean;
  hasCookies: boolean;
}

export interface BulkImportItemInput {
  alias?: string;
  email: string;
  display_name?: string;
  plan_tier?: PlanTier;
  renewal_date?: string | null;
  tags?: string[];
  notes?: string;
  proxy_url?: string | null;
  chrome_user_data_dir?: string | null;
  chrome_profile_name?: string | null;
  google_authuser?: string | null;
  has_cookies?: boolean;
}

export interface BrowserDiscoveryWarning {
  browser: string;
  code: string;
  message: string;
}

export interface BulkImportResult {
  created: AccountView[];
  skipped: Array<{ email: string; reason: string }>;
  errors: Array<{ email: string; error: string }>;
}
