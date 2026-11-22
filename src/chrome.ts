import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { validateChromeBinary } from './config.ts';
import type { AccountRecord, ProfileMode, SessionStatus } from './types.ts';

export interface DevToolsPageTarget {
  url?: string;
  title?: string;
  type?: string;
}

export interface SessionClassification {
  status: SessionStatus;
  detail: string;
}

export interface BuildChromeArgsOptions {
  profileDir: string;
  profileDirectory?: string | null;
  omitUserDataDir?: boolean;
  urls?: string[];
  headless?: boolean;
  debugPort?: number;
  proxyUrl?: string | null;
}

export interface OpenProfileWindowOptions {
  chromeBinary: string;
  profileDir: string;
  urls: string[];
  proxyUrl?: string | null;
  profileMode?: ProfileMode;
  chromeUserDataDir?: string | null;
  chromeProfileName?: string | null;
  googleAuthuser?: string | null;
}

export interface ProbeProfileOptions {
  chromeBinary: string;
  profileDir: string;
  proxyUrl?: string | null;
  profileMode?: ProfileMode;
  chromeUserDataDir?: string | null;
  chromeProfileName?: string | null;
  googleAuthuser?: string | null;
  timeoutMs?: number;
  settleMs?: number;
}

export interface ProbeProfileResult {
  status: SessionStatus | 'skipped_open';
  detail: string;
}

const SIGNIN_PATH_PREFIXES = [
  '/v3/signin',
  '/servicelogin',
  '/interactivelogin',
  '/accountchooser',
  '/signin/v2',
  '/challenge',
  '/checkcookie',
  '/signoutoptions',
];

export function isSafeHttpUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks whether `userDataDir` points to macOS Chrome/Brave/Chromium's default system User Data directory.
 */
export function isDefaultSystemBrowserDataDir(userDataDir: string | null | undefined): boolean {
  if (!userDataDir || !userDataDir.trim()) return false;
  const resolved = path.resolve(userDataDir.trim());
  const defaults = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
  ].map((p) => path.resolve(p));

  return defaults.includes(resolved);
}

/**
 * Resolves the matching installed browser binary when `userDataDir` belongs to Brave or Chrome.
 */
export function resolveBrowserBinaryForUserDataDir(
  userDataDir: string | null | undefined,
  fallbackBinary: string,
): string {
  if (!userDataDir || !userDataDir.trim()) return fallbackBinary;
  const lower = userDataDir.toLowerCase();
  if (lower.includes('bravesoftware') || lower.includes('brave-browser')) {
    const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    if (fs.existsSync(brave)) return brave;
  }
  if (lower.includes('google/chrome') || lower.includes('google\\chrome')) {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(chrome)) return chrome;
  }
  return fallbackBinary;
}

/**
 * Appends standard Google multi-login (`authuser` / `login_hint`) query parameters
 * without overwriting existing parameters or touching non-Google URLs.
 */
export function decorateUrlForAccount(rawUrl: string, authuser: string | null | undefined): string {
  const hint = authuser?.trim();
  if (!hint) return rawUrl;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return rawUrl;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return rawUrl;
  }

  const host = parsed.hostname.toLowerCase();
  const isOAuth = host === 'accounts.google.com' && parsed.pathname.toLowerCase().startsWith('/o/oauth2');
  const isGoogleDomain =
    host === 'google.com' || host.endsWith('.google.com') || host === 'labs.google';

  if (!isGoogleDomain) {
    return rawUrl;
  }

  if (isOAuth) {
    if (hint.includes('@') && !parsed.searchParams.has('login_hint')) {
      parsed.searchParams.set('login_hint', hint);
    }
    if (!parsed.searchParams.has('authuser')) {
      parsed.searchParams.set('authuser', hint);
    }
    return parsed.toString();
  }

  if (!parsed.searchParams.has('authuser')) {
    parsed.searchParams.set('authuser', hint);
  }
  return parsed.toString();
}

/**
 * Classifies DevTools open page targets into Google session state without touching credentials.
 */
export function classifySessionUrls(pages: DevToolsPageTarget[]): SessionClassification {
  const candidates = pages.filter((p) => !p.type || p.type === 'page');

  for (const page of candidates) {
    if (!page.url) continue;
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (host === 'accounts.google.com') {
      if (SIGNIN_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return {
          status: 'needs_login',
          detail: `Google yêu cầu đăng nhập lại (${parsed.pathname})`,
        };
      }
    }

    if (host === 'myaccount.google.com' && pathname.startsWith('/intro')) {
      return {
        status: 'needs_login',
        detail: 'Phiên Google đã đăng xuất (myaccount.google.com/intro)',
      };
    }
  }

  for (const page of candidates) {
    if (!page.url) continue;
    let parsed: URL;
    try {
      parsed = new URL(page.url);
    } catch {
      continue;
    }

    if (parsed.hostname.toLowerCase() === 'myaccount.google.com' && !parsed.pathname.toLowerCase().startsWith('/intro')) {
      return {
        status: 'live',
        detail: `Phiên đang hoạt động (${parsed.hostname}${parsed.pathname})`,
      };
    }
  }

  return {
    status: 'error',
    detail: 'Không xác định được trạng thái phiên từ Chrome headless',
  };
}

/**
 * Builds real Chrome launch flags without automation-detection flags.
 */
export function buildChromeLaunchArgs(options: BuildChromeArgsOptions): string[] {
  const args: string[] = [];

  if (!options.omitUserDataDir && options.profileDir) {
    args.push(`--user-data-dir=${options.profileDir}`);
  }
  if (options.profileDirectory && options.profileDirectory.trim()) {
    args.push(`--profile-directory=${options.profileDirectory.trim()}`);
  }

  args.push('--no-first-run', '--no-default-browser-check');

  if (options.proxyUrl && options.proxyUrl.trim()) {
    args.push(`--proxy-server=${options.proxyUrl.trim()}`);
  }

  if (options.headless) {
    args.push('--headless=new', '--disable-gpu', '--mute-audio');
    if (options.debugPort && options.debugPort > 0) {
      args.push(`--remote-debugging-port=${options.debugPort}`, '--remote-debugging-address=127.0.0.1');
    }
  }

  for (const url of options.urls ?? []) {
    if (isSafeHttpUrl(url)) {
      args.push(url.trim());
    }
  }

  return args;
}

/**
 * Checks whether a Chrome user-data-dir currently has a live Chrome process holding `SingletonLock`.
 * Note: On macOS, `SingletonLock` is a symlink to `<hostname>-<pid>` (dangling on disk),
 * so `fs.existsSync` returns false — always use `fs.readlinkSync`.
 */
export function isProfileRunning(lockRootDir: string): { running: boolean; pid: number | null } {
  const lockPath = path.join(lockRootDir, 'SingletonLock');
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return { running: false, pid: null };
  }

  const lastDash = target.lastIndexOf('-');
  if (lastDash === -1) {
    return { running: false, pid: null };
  }

  const pidStr = target.slice(lastDash + 1).trim();
  if (!/^\d+$/.test(pidStr)) {
    return { running: false, pid: null };
  }

  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, pid: null };
  }

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') {
      return { running: true, pid };
    }
    return { running: false, pid: null };
  }
}

/**
 * Checks whether the Chrome instance owning `account` is currently running.
 */
export function isAccountChromeRunning(account: AccountRecord): { running: boolean; pid: number | null } {
  const root =
    account.profile_mode === 'linked' && account.chrome_user_data_dir
      ? account.chrome_user_data_dir
      : account.chrome_profile_dir;
  return isProfileRunning(root);
}

/**
 * Checks whether Chrome has persisted a Cookies database for an isolated profile.
 */
export function hasProfileCookies(profileDir: string): boolean {
  return (
    fs.existsSync(path.join(profileDir, 'Default', 'Cookies')) ||
    fs.existsSync(path.join(profileDir, 'Profile 1', 'Cookies'))
  );
}

/**
 * Checks whether Cookies exist on disk for either an isolated or linked account.
 */
export function hasAccountCookies(account: AccountRecord): boolean {
  if (account.profile_mode === 'linked') {
    return fs.existsSync(path.join(account.chrome_profile_dir, 'Cookies'));
  }
  return hasProfileCookies(account.chrome_profile_dir);
}

/**
 * Launches or adds tabs to a real Chrome window bound strictly to `account`'s profile mode.
 */
export async function openProfileWindow(options: OpenProfileWindowOptions): Promise<{ pid: number | undefined }> {
  const isLinked = options.profileMode === 'linked';
  const rawBinary = isLinked
    ? resolveBrowserBinaryForUserDataDir(options.chromeUserDataDir, options.chromeBinary)
    : options.chromeBinary;
  const targetBinary = validateChromeBinary(rawBinary);

  if (!fs.existsSync(targetBinary)) {
    throw new Error(`Không tìm thấy Chrome tại "${targetBinary}". Hãy kiểm tra lại đường dẫn trong Cài đặt.`);
  }

  const safeUrls = options.urls.filter((u) => isSafeHttpUrl(u));
  if (safeUrls.length === 0) {
    throw new Error('Không có URL http/https hợp lệ để mở trong Chrome.');
  }

  const targetUrls = isLinked
    ? safeUrls.map((u) => decorateUrlForAccount(u, options.googleAuthuser))
    : safeUrls;

  if (!isLinked) {
    fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  }

  const userDataDir = isLinked ? (options.chromeUserDataDir || options.profileDir) : options.profileDir;
  const omitUserDataDir = isLinked && isDefaultSystemBrowserDataDir(userDataDir);

  const args = buildChromeLaunchArgs({
    profileDir: userDataDir,
    profileDirectory: isLinked ? options.chromeProfileName : null,
    omitUserDataDir,
    urls: targetUrls,
    headless: false,
    proxyUrl: options.proxyUrl,
  });

  const child = spawn(targetBinary, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  if (process.platform === 'darwin') {
    const appName = targetBinary.toLowerCase().includes('brave') ? 'Brave Browser' : 'Google Chrome';
    execFile('/usr/bin/osascript', ['-e', `tell application "${appName}" to activate`], () => {
      // Best-effort window focus.
    });
  }

  return { pid: child.pid };
}

/**
 * Probes and gently refreshes Google & Gemini cookies in an isolated headless Chrome window.
 */
export async function probeAndRefreshProfile(options: ProbeProfileOptions): Promise<ProbeProfileResult> {
  let safeBinary: string;
  try {
    safeBinary = validateChromeBinary(options.chromeBinary);
  } catch (err) {
    return {
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!fs.existsSync(safeBinary)) {
    return {
      status: 'error',
      detail: `Không tìm thấy Chrome tại "${safeBinary}"`,
    };
  }

  const isLinked = options.profileMode === 'linked';

  // Chrome 136+ blocks remote-debugging-port on the default User Data directory.
  if (isLinked && isDefaultSystemBrowserDataDir(options.chromeUserDataDir)) {
    const cookiePath = path.join(options.profileDir, 'Cookies');
    if (!fs.existsSync(cookiePath)) {
      return {
        status: 'needs_login',
        detail: 'Profile Chrome gốc chưa có cookie Google.',
      };
    }
    return {
      status: 'skipped_open',
      detail:
        'Đang dùng chế độ Link với Chrome gốc (phiên được duy trì bởi Chrome). Bấm "Tách profile riêng" nếu muốn Keep-Alive quét ngầm độc lập.',
    };
  }

  const lockRoot = isLinked && options.chromeUserDataDir ? options.chromeUserDataDir : options.profileDir;
  if (isProfileRunning(lockRoot).running) {
    return {
      status: 'skipped_open',
      detail: 'Profile đang mở trong Chrome — bỏ qua quét ngầm để tránh xung đột khóa',
    };
  }

  const hasCookies = isLinked
    ? fs.existsSync(path.join(options.profileDir, 'Cookies'))
    : hasProfileCookies(options.profileDir);

  if (!hasCookies) {
    return {
      status: 'needs_login',
      detail: 'Profile mới tạo chưa có phiên Google — hãy mở Chrome để đăng nhập lần đầu',
    };
  }

  const timeoutMs = options.timeoutMs ?? 25_000;
  const settleMs = options.settleMs ?? 8_000;
  const debugPort = await reserveEphemeralPort();

  const rawProbeUrls = ['https://myaccount.google.com/personal-info', 'https://gemini.google.com/app'];
  const probeUrls = isLinked
    ? rawProbeUrls.map((u) => decorateUrlForAccount(u, options.googleAuthuser))
    : rawProbeUrls;

  const args = buildChromeLaunchArgs({
    profileDir: lockRoot,
    profileDirectory: isLinked ? options.chromeProfileName : null,
    urls: probeUrls,
    headless: true,
    debugPort,
    proxyUrl: options.proxyUrl,
  });

  const child = spawn(safeBinary, args, {
    stdio: 'ignore',
  });

  let exited = false;
  let exitError: string | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', (err) => {
      exited = true;
      exitError = err.message;
      resolve();
    });
  });

  let result: ProbeProfileResult = {
    status: 'error',
    detail: 'Hết thời gian chờ Chrome headless phản hồi',
  };

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !exited) {
      const pages = await fetchDevToolsTargets(debugPort);
      if (pages.length > 0) {
        const classified = classifySessionUrls(pages);
        if (classified.status === 'needs_login') {
          result = classified;
          break;
        }
        if (classified.status === 'live') {
          await sleep(Math.min(settleMs, Math.max(500, deadline - Date.now())));
          const recheck = await fetchDevToolsTargets(debugPort);
          const finalClass = recheck.length > 0 ? classifySessionUrls(recheck) : classified;
          result = finalClass.status === 'needs_login' ? finalClass : classified;
          break;
        }
      }
      await sleep(1000);
    }

    if (exitError) {
      result = { status: 'error', detail: `Lỗi khởi chạy Chrome: ${exitError}` };
    }
  } finally {
    if (!exited && child.pid) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore if already exited.
      }
      await Promise.race([exitPromise, sleep(5000)]);
      if (!exited && child.pid) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore.
        }
        await Promise.race([exitPromise, sleep(1500)]);
      }
    }
  }

  return result;
}

/**
 * Displays a native macOS Notification Center alert via osascript without shell interpolation.
 */
export async function sendMacNotification(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  await new Promise<void>((resolve) => {
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv)\nend run',
        message,
        title,
      ],
      () => resolve(),
    );
  });
}

async function fetchDevToolsTargets(port: number): Promise<DevToolsPageTarget[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as DevToolsPageTarget[]) : [];
  } catch {
    return [];
  }
}

async function reserveEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Không cấp phát được cổng localhost tạm cho DevTools.')));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
