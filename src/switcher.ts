import fs from 'node:fs';
import path from 'node:path';
import { acquireAgyLease } from './agylock.ts';
import { activateAgySession, listCapturedAliases, type AgySessionDeps } from './agysession.ts';
import {
  decorateUrlForAccount,
  isAccountChromeRunning,
  isSafeHttpUrl,
  openProfileWindow,
  type OpenProfileWindowOptions,
} from './chrome.ts';
import { validateBucketName, validateRotationPolicy, type PoolPaths } from './config.ts';
import type { PoolDB } from './db.ts';
import type { AccountRecord, AccountView, ProfileMode, RotateResult, RotationPolicy, SwitchResult } from './types.ts';

export type OpenWindowFn = (options: OpenProfileWindowOptions) => Promise<{ pid: number | undefined }>;

export interface PoolSwitcherOptions {
  db: PoolDB;
  paths: PoolPaths;
  openWindowFn?: OpenWindowFn;
}

export interface SwitchToOptions {
  openChrome?: boolean;
  openUrl?: string;
  oauthUrl?: string;
  cooldownPreviousHours?: number;
  cooldownReason?: string;
}

export interface RotateNextOptions {
  cooldownHours?: number;
  reason?: string;
  tag?: string;
  bucket?: string;
  policy?: RotationPolicy;
  requireAgy?: boolean;
  activateAgy?: boolean;
  forceAgy?: boolean;
  waitLockSeconds?: number;
  openChrome?: boolean;
  openUrl?: string;
  agyDeps?: AgySessionDeps;
}

export interface OfficialRunEnvResult {
  env: NodeJS.ProcessEnv;
  mode: 'agy-adc' | 'agy-oauth-manual' | 'gemini-cli-home' | 'generic';
  warning?: string;
}

export function buildGoogleSignInUrl(email: string): string {
  return (
    `https://accounts.google.com/ServiceLogin?Email=${encodeURIComponent(email)}` +
    `&continue=${encodeURIComponent('https://gemini.google.com/app')}`
  );
}

export function buildAgyGuide(alias: string, email: string, profileMode: ProfileMode = 'isolated'): string {
  const modeNote =
    profileMode === 'linked'
      ? `Link OAuth sẽ tự động gắn login_hint/authuser=${email} để chọn đúng tài khoản trong Chrome profile đang liên kết.`
      : `Cửa sổ Chrome profile độc lập "${alias}" đã được mở.`;

  return [
    `Đã chọn tài khoản "${alias}" (${email}) làm tài khoản hiện tại.`,
    `Cho agy CLI: nếu đã lưu phiên, chạy "gpool agy-activate ${alias}" (hoặc "gpool run ${alias} -- agy") để đổi acc ngay không cần login lại.`,
    `Nếu chưa lưu: đăng nhập agy qua Chrome profile này (${modeNote} link OAuth dán vào "gpool auth ${alias}"), rồi chạy "gpool agy-capture ${alias}" để lưu phiên.`,
  ].join(' ');
}

export class PoolSwitcher {
  private readonly db: PoolDB;
  private readonly paths: PoolPaths;
  private readonly openWindowFn: OpenWindowFn;

  constructor(options: PoolSwitcherOptions) {
    this.db = options.db;
    this.paths = options.paths;
    this.openWindowFn = options.openWindowFn ?? openProfileWindow;
  }

  async switchTo(aliasOrId: string | number, options: SwitchToOptions = {}): Promise<SwitchResult> {
    const target = this.db.getAccount(aliasOrId);
    if (!target) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }

    const settings = this.db.getSettings();
    const previous = this.db.getActiveAccount();

    if (
      options.cooldownPreviousHours !== undefined &&
      options.cooldownPreviousHours > 0 &&
      previous &&
      previous.alias !== target.alias
    ) {
      const untilIso = new Date(Date.now() + options.cooldownPreviousHours * 3_600_000).toISOString();
      this.db.setCooldown(
        previous.alias,
        untilIso,
        options.cooldownReason ?? `Chuyển sang ${target.alias}`,
      );
    }

    let rawTargetUrl: string = settings.default_open_url;
    if (options.oauthUrl) {
      if (!isSafeHttpUrl(options.oauthUrl)) {
        throw new Error('Link OAuth không hợp lệ — chỉ chấp nhận URL http:// hoặc https://.');
      }
      rawTargetUrl = options.oauthUrl.trim();
    } else if (options.openUrl) {
      if (!isSafeHttpUrl(options.openUrl)) {
        throw new Error('URL mở Chrome không hợp lệ — chỉ chấp nhận http:// hoặc https://.');
      }
      rawTargetUrl = options.openUrl.trim();
    }

    const { active } = this.db.setActiveAccount(target.alias);
    const effectiveUrl =
      active.profile_mode === 'linked'
        ? decorateUrlForAccount(rawTargetUrl, active.google_authuser ?? active.email)
        : rawTargetUrl;

    const shouldOpen = options.openChrome !== false;
    let openedChrome = false;

    if (shouldOpen) {
      await this.openWindowFn({
        chromeBinary: settings.chrome_binary,
        profileDir: active.chrome_profile_dir,
        urls: [rawTargetUrl],
        proxyUrl: active.proxy_url,
        profileMode: active.profile_mode,
        chromeUserDataDir: active.chrome_user_data_dir,
        chromeProfileName: active.chrome_profile_name,
        googleAuthuser: active.google_authuser ?? active.email,
      });
      openedChrome = true;
    }

    const view = this.db.computeAccountView(
      active,
      openedChrome || isAccountChromeRunning(active).running,
    );

    return {
      ok: true,
      previousAlias: previous?.alias ?? null,
      active: view,
      openedChrome,
      openedUrl: openedChrome ? effectiveUrl : null,
      agyGuide: buildAgyGuide(active.alias, active.email, active.profile_mode),
    };
  }

  async rotateNext(options: RotateNextOptions = {}): Promise<RotateResult> {
    this.db.expireElapsedCooldowns();
    const settings = this.db.getSettings();
    const previous = this.db.getActiveAccount();
    const cooldownHours = options.cooldownHours ?? settings.default_cooldown_hours;
    const bucket = validateBucketName(options.bucket);
    const policy = options.policy ? validateRotationPolicy(options.policy) : settings.rotation_policy;
    const needAgy = Boolean(options.activateAgy || options.requireAgy);
    const capturedAliases = needAgy ? listCapturedAliases(this.paths) : undefined;

    if (previous && cooldownHours > 0) {
      const untilIso = new Date(Date.now() + cooldownHours * 3_600_000).toISOString();
      this.db.setBucketCooldown(
        previous.alias,
        bucket,
        untilIso,
        options.reason ?? 'Hết quota / chuyển vòng xoay',
      );
    }

    const next = this.db.pickNextReadyAccount({
      tag: options.tag,
      excludeAlias: previous?.alias,
      bucket,
      policy,
      requireAgyAliases: capturedAliases,
    });

    if (!next) {
      const nextAvailableAt = this.db.getEarliestCooldownEnd(options.tag, new Date(), bucket, capturedAliases);
      const scopeParts: string[] = [];
      if (needAgy) scopeParts.push('đã lưu phiên agy');
      if (bucket !== 'all') scopeParts.push(`bucket "${bucket}"`);
      if (options.tag) scopeParts.push(`tag "${options.tag}"`);
      const scopeHint = scopeParts.length > 0 ? ` (${scopeParts.join(', ')})` : '';
      return {
        ok: false,
        previousAlias: previous?.alias ?? null,
        bucket,
        policy,
        error: `Không còn tài khoản sẵn sàng nào${scopeHint} — tất cả đang cooldown, chưa lưu agy, hoặc cần đăng nhập lại.`,
        nextAvailableAt,
      };
    }

    let agyActivated = false;
    let recapturedAlias: string | null = null;
    if (options.activateAgy) {
      const lease = await acquireAgyLease(this.paths, {
        alias: next.alias,
        holder: 'gpool-next',
        ttlMs: 30_000,
        waitMs: Math.max(0, (options.waitLockSeconds ?? 0) * 1000),
      });
      try {
        const actRes = activateAgySession(
          this.paths,
          next,
          { force: Boolean(options.forceAgy) },
          options.agyDeps,
        );
        agyActivated = true;
        recapturedAlias = actRes.recaptured_alias;
        const extra = recapturedAlias ? ` (đã cập nhật snapshot "${recapturedAlias}")` : '';
        this.db.addEvent(
          next.id,
          next.alias,
          'agy_session_activated',
          `Xoay vòng nạp phiên agy của ${next.alias} vào Keychain${extra}`,
        );
      } finally {
        lease.release();
      }
    }

    const openChrome = options.openChrome !== undefined ? options.openChrome : !options.activateAgy;
    const switched = await this.switchTo(next.alias, {
      openChrome,
      openUrl: options.openUrl,
    });

    return {
      ok: true,
      previousAlias: previous?.alias ?? null,
      active: switched.active,
      openedChrome: switched.openedChrome,
      openedUrl: switched.openedUrl,
      agyGuide: switched.agyGuide,
      agyActivated,
      recapturedAlias,
      bucket,
      policy,
    };
  }

  async openProfile(aliasOrId: string | number, openUrl?: string): Promise<{ alias: string; url: string }> {
    const account = this.db.getAccount(aliasOrId);
    if (!account) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const settings = this.db.getSettings();
    const rawUrl = openUrl?.trim() || settings.default_open_url;
    if (!isSafeHttpUrl(rawUrl)) {
      throw new Error('URL mở Chrome không hợp lệ — chỉ chấp nhận http:// hoặc https://.');
    }

    const effectiveUrl =
      account.profile_mode === 'linked'
        ? decorateUrlForAccount(rawUrl, account.google_authuser ?? account.email)
        : rawUrl;

    await this.openWindowFn({
      chromeBinary: settings.chrome_binary,
      profileDir: account.chrome_profile_dir,
      urls: [rawUrl],
      proxyUrl: account.proxy_url,
      profileMode: account.profile_mode,
      chromeUserDataDir: account.chrome_user_data_dir,
      chromeProfileName: account.chrome_profile_name,
      googleAuthuser: account.google_authuser ?? account.email,
    });

    this.db.addEvent(account.id, account.alias, 'chrome_opened', `Mở Chrome profile ${account.alias} tại ${effectiveUrl}`);
    return { alias: account.alias, url: effectiveUrl };
  }

  async openOAuthInAccount(aliasOrId: string | number, oauthUrl: string): Promise<{ alias: string; url: string }> {
    if (!isSafeHttpUrl(oauthUrl)) {
      throw new Error('Link OAuth không hợp lệ — chỉ chấp nhận URL http:// hoặc https://.');
    }
    const account = this.db.getAccount(aliasOrId);
    if (!account) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const settings = this.db.getSettings();
    const cleanUrl = oauthUrl.trim();
    const effectiveUrl =
      account.profile_mode === 'linked'
        ? decorateUrlForAccount(cleanUrl, account.google_authuser ?? account.email)
        : cleanUrl;

    await this.openWindowFn({
      chromeBinary: settings.chrome_binary,
      profileDir: account.chrome_profile_dir,
      urls: [cleanUrl],
      proxyUrl: account.proxy_url,
      profileMode: account.profile_mode,
      chromeUserDataDir: account.chrome_user_data_dir,
      chromeProfileName: account.chrome_profile_name,
      googleAuthuser: account.google_authuser ?? account.email,
    });

    this.db.addEvent(account.id, account.alias, 'oauth_opened', `Mở link OAuth vào profile ${account.alias}`);
    return { alias: account.alias, url: effectiveUrl };
  }

  /**
   * Opens the account's Chrome profile at Google Sign-In with email pre-filled.
   */
  async openLogin(aliasOrId: string | number): Promise<{ alias: string; url: string }> {
    const account = this.db.getAccount(aliasOrId);
    if (!account) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    return this.openProfile(account.alias, buildGoogleSignInUrl(account.email));
  }

  /**
   * Marks an account as logged in / live after manual login confirmation.
   */
  confirmLogin(aliasOrId: string | number): AccountView {
    const account = this.db.getAccount(aliasOrId);
    if (!account) {
      throw new Error(`Không tìm thấy tài khoản "${aliasOrId}".`);
    }
    const updated = this.db.updateSessionStatus(
      account.id,
      'live',
      'Đã xác nhận đăng nhập (Keep-Alive sẽ tự kiểm tra định kỳ)',
    );
    this.db.addEvent(updated.id, updated.alias, 'login_confirmed', `Xác nhận đã đăng nhập thành công cho ${updated.alias}`);
    return this.db.computeAccountView(updated, isAccountChromeRunning(updated).running);
  }

  /**
   * Graduates all linked-mode accounts into independent isolated Chrome profiles.
   */
  isolateAllLinked(): { count: number; isolated: AccountView[] } {
    const records = this.db.isolateAllLinkedAccounts();
    const isolated = records.map((acc) =>
      this.db.computeAccountView(acc, isAccountChromeRunning(acc).running),
    );
    return { count: isolated.length, isolated };
  }

  /**
   * Graduates a linked-mode account into its own isolated Chrome profile directory.
   */
  async isolateAccount(
    aliasOrId: string | number,
    options: { openChrome?: boolean } = {},
  ): Promise<{ account: AccountView; openedChrome: boolean; openedUrl: string | null }> {
    const updated = this.db.isolateAccount(aliasOrId);
    const settings = this.db.getSettings();
    const signInUrl = buildGoogleSignInUrl(updated.email);
    const shouldOpen = options.openChrome !== false;

    if (shouldOpen) {
      await this.openWindowFn({
        chromeBinary: settings.chrome_binary,
        profileDir: updated.chrome_profile_dir,
        urls: [signInUrl],
        proxyUrl: updated.proxy_url,
        profileMode: 'isolated',
      });
    }

    const view = this.db.computeAccountView(
      updated,
      shouldOpen || isAccountChromeRunning(updated).running,
    );

    return {
      account: view,
      openedChrome: shouldOpen,
      openedUrl: shouldOpen ? signInUrl : null,
    };
  }

  /**
   * Builds documented, official environment variables for launching CLI tools with an account.
   * Never touches private Keychain items or undocumented internal auth state.
   */
  buildOfficialRunEnv(account: AccountRecord, commandName: string): OfficialRunEnvResult {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const binBase = path.basename(commandName).toLowerCase();

    if (binBase === 'agy') {
      if (account.adc_credentials_path) {
        env.AGY_ADC_AUTH = 'true';
        env.GOOGLE_APPLICATION_CREDENTIALS = account.adc_credentials_path;
        return { env, mode: 'agy-adc' };
      }
      return {
        env,
        mode: 'agy-oauth-manual',
        warning:
          `Lưu ý: "${account.alias}" chưa có phiên agy đã lưu — agy sẽ dùng phiên Keychain hệ thống hiện tại. ` +
          `Sau khi đăng nhập agy đúng acc, chạy "gpool agy-capture ${account.alias}" để lưu; các lần sau "gpool run ${account.alias} -- agy" sẽ tự nạp đúng phiên.`,
      };
    }

    if (binBase === 'gemini') {
      const geminiHome = path.join(this.paths.geminiHomesDir, account.alias);
      fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(geminiHome, 0o700);
      } catch {
        // Best-effort.
      }
      env.GEMINI_CLI_HOME = geminiHome;
      return { env, mode: 'gemini-cli-home' };
    }

    return { env, mode: 'generic' };
  }
}
