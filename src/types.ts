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
