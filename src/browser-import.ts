import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAlias, validateEmail } from './config.ts';
import type {
  BrowserDiscoveryWarning,
  DiscoveredBrowserAccount,
  DiscoveredBrowserProfile,
} from './types.ts';

export interface BrowserScanRoot {
  browser: string;
  chromeBinary: string;
  userDataDir: string;
}

export interface DiscoverBrowserOptions {
  roots?: BrowserScanRoot[];
  existingEmails?: Set<string>;
  existingAliases?: Set<string>;
}

export interface DiscoverBrowserResult {
  profiles: DiscoveredBrowserProfile[];
  discoveredAccounts: DiscoveredBrowserAccount[];
  warnings: BrowserDiscoveryWarning[];
  permissionBlocked: boolean;
}

export interface ParsedBulkEmailItem {
  alias: string;
  email: string;
  display_name?: string;
  notes?: string;
}

export interface ParseBulkEmailResult {
  items: ParsedBulkEmailItem[];
  invalidLines: string[];
}

/**
 * Returns default macOS Google Chrome and Brave Browser User Data paths.
 */
export function getDefaultBrowserRoots(): BrowserScanRoot[] {
  const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
  return [
    {
      browser: 'Google Chrome',
      chromeBinary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      userDataDir: path.join(appSupport, 'Google', 'Chrome'),
    },
    {
      browser: 'Brave Browser',
      chromeBinary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      userDataDir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
    },
  ];
}

/**
 * Generates a unique, valid account alias derived from an email address.
 */
export function generateUniqueAlias(email: string, existingAliases: Set<string>): string {
  const localPart = email.split('@')[0] ?? 'acc';
  let base = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 26);

  if (!base) {
    base = 'acc';
  }

  let candidate = base;
  let counter = 2;
  while (existingAliases.has(candidate)) {
    const suffix = `-${counter}`;
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    counter += 1;
  }

  existingAliases.add(candidate);
  return candidate;
}

/**
 * Scans Chromium-based browser metadata (`Local State` and `<profile>/Preferences`)
 * strictly reading non-secret profile/account metadata (`profile.info_cache`, `account_info`).
 * Reports macOS TCC EPERM/EACCES permission blocks explicitly instead of failing silently.
 */
export function discoverBrowserProfiles(options: DiscoverBrowserOptions = {}): DiscoverBrowserResult {
  const roots = options.roots ?? getDefaultBrowserRoots();
  const existingEmails = new Set(Array.from(options.existingEmails ?? []).map((e) => e.toLowerCase()));
  const usedAliases = new Set(Array.from(options.existingAliases ?? []).map((a) => a.toLowerCase()));

  const profiles: DiscoveredBrowserProfile[] = [];
  const discoveredAccounts: DiscoveredBrowserAccount[] = [];
  const warnings: BrowserDiscoveryWarning[] = [];
  const warnedBrowsers = new Set<string>();
  let permissionBlocked = false;

  const recordPermissionWarning = (browser: string, code: string) => {
    permissionBlocked = true;
    if (warnedBrowsers.has(browser)) return;
    warnedBrowsers.add(browser);
    warnings.push({
      browser,
      code,
      message:
        `macOS đang chặn quyền đọc thư mục dữ liệu ${browser} (${code}). ` +
        `Dùng tab "Dán nhiều email" để nhập nhanh trong 5 giây (không cần cấp quyền), ` +
        `hoặc bật Full Disk Access cho Terminal/IDE trong System Settings → Privacy & Security rồi khởi động lại daemon.`,
    });
  };

  for (const root of roots) {
    if (!fs.existsSync(root.userDataDir)) continue;

    const localStatePath = path.join(root.userDataDir, 'Local State');
    const localStateRes = readLocalStateInfoCache(localStatePath);
    if (localStateRes.errorCode === 'EPERM' || localStateRes.errorCode === 'EACCES') {
      recordPermissionWarning(root.browser, localStateRes.errorCode);
    }

    const infoCache = localStateRes.data;
    const profileNames = new Set<string>(Object.keys(infoCache));

    if (profileNames.size === 0 && fs.existsSync(path.join(root.userDataDir, 'Default'))) {
      profileNames.add('Default');
    }

    for (const profileName of profileNames) {
      if (profileName === 'System Profile' || profileName === 'Guest Profile') continue;
      const profileDir = path.join(root.userDataDir, profileName);
      if (!fs.existsSync(profileDir)) continue;

      const cacheEntry = infoCache[profileName] ?? {};
      const displayName =
        (typeof cacheEntry.name === 'string' && cacheEntry.name.trim()) ||
        (typeof cacheEntry.gaia_name === 'string' && cacheEntry.gaia_name.trim()) ||
        profileName;
      const primaryEmailRaw =
        typeof cacheEntry.user_name === 'string' && cacheEntry.user_name.includes('@')
          ? cacheEntry.user_name.trim().toLowerCase()
          : null;

      const prefsPath = path.join(profileDir, 'Preferences');
      const prefsRes = readPreferencesMetadata(prefsPath);
      if (prefsRes.errorCode === 'EPERM' || prefsRes.errorCode === 'EACCES') {
        recordPermissionWarning(root.browser, prefsRes.errorCode);
      }

      const hasCookies = fs.existsSync(path.join(profileDir, 'Cookies'));

      const accountMap = new Map<string, { email: string; fullName: string; isPrimary: boolean }>();
      if (primaryEmailRaw) {
        accountMap.set(primaryEmailRaw, {
          email: primaryEmailRaw,
          fullName: (typeof cacheEntry.gaia_name === 'string' && cacheEntry.gaia_name.trim()) || '',
          isPrimary: true,
        });
      }

      for (const acc of prefsRes.data) {
        const lower = acc.email.toLowerCase();
        const existing = accountMap.get(lower);
        if (!existing) {
          accountMap.set(lower, {
            email: lower,
            fullName: acc.fullName,
            isPrimary: primaryEmailRaw === lower,
          });
        } else if (!existing.fullName && acc.fullName) {
          existing.fullName = acc.fullName;
        }
      }

      const accounts = Array.from(accountMap.values());
      profiles.push({
        browser: root.browser,
        chromeBinary: root.chromeBinary,
        userDataDir: root.userDataDir,
        profileName,
        displayName,
        primaryEmail: primaryEmailRaw,
        hasCookies,
        accounts,
      });

      for (const acc of accounts) {
        const alreadyInPool = existingEmails.has(acc.email);
        const suggestedAlias = generateUniqueAlias(acc.email, usedAliases);
        discoveredAccounts.push({
          browser: root.browser,
          chromeBinary: root.chromeBinary,
          userDataDir: root.userDataDir,
          profileName,
          profileDisplayName: displayName,
          email: acc.email,
          fullName: acc.fullName,
          suggestedAlias,
          alreadyInPool,
          hasCookies,
        });
      }
    }
  }

  return { profiles, discoveredAccounts, warnings, permissionBlocked };
}

/**
 * Extracts Google email addresses (and nearby display names) from arbitrary pasted webpage text
 * such as `⌘A ⌘C` on `https://accounts.google.com/SignOutOptions`, as well as structured
 * `alias email | notes` or comma-separated inputs.
 */
export function extractEmailsFromText(
  rawText: string,
  existingAliases: Set<string> = new Set(),
): ParsedBulkEmailItem[] {
  const usedAliases = new Set(Array.from(existingAliases).map((a) => a.toLowerCase()));
  const seenEmails = new Set<string>();
  const items: ParsedBulkEmailItem[] = [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  const lines = rawText.split(/\r?\n/);
  let prevCandidateName: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      prevCandidateName = null;
      continue;
    }

    let body = trimmed;
    let notes: string | undefined;
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx >= 0 && trimmed.slice(0, pipeIdx).includes('@')) {
      body = trimmed.slice(0, pipeIdx).trim();
      const rawNotes = trimmed.slice(pipeIdx + 1).trim();
      if (rawNotes) notes = rawNotes;
    }

    const matches = body.match(emailRegex);
    if (!matches || matches.length === 0) {
      prevCandidateName = isNoiseUiText(trimmed) ? null : trimmed;
      continue;
    }

    // Detect clean `alias email` or `email alias` structured line.
    let explicitAlias: string | undefined;
    let inlineAngleName: string | undefined;
    if (matches.length === 1) {
      const tokens = body.split(/[\s,]+/).filter(Boolean);
      if (tokens.length === 2) {
        if (!tokens[0].includes('@') && tokens[1] === matches[0]) {
          explicitAlias = tokens[0];
        } else if (tokens[0] === matches[0] && !tokens[1].includes('@')) {
          explicitAlias = tokens[1];
        }
      } else {
        const angleMatch = /^([^<>]{2,60})<([^<>]+@[^<>]+)>$/.exec(body);
        if (angleMatch) {
          const candidate = angleMatch[1].trim();
          if (!isNoiseUiText(candidate)) {
            inlineAngleName = candidate;
          }
        }
      }
    }

    for (const match of matches) {
      let email: string;
      try {
        email = validateEmail(match);
      } catch {
        continue;
      }

      if (seenEmails.has(email)) continue;
      seenEmails.add(email);

      let alias: string;
      if (explicitAlias) {
        try {
          const normalized = validateAlias(explicitAlias);
          if (usedAliases.has(normalized)) {
            alias = generateUniqueAlias(email, usedAliases);
          } else {
            usedAliases.add(normalized);
            alias = normalized;
          }
        } catch {
          alias = generateUniqueAlias(email, usedAliases);
        }
      } else {
        alias = generateUniqueAlias(email, usedAliases);
      }

      const displayName =
        matches.length === 1 && !explicitAlias
          ? inlineAngleName ?? prevCandidateName ?? undefined
          : undefined;

      items.push({
        alias,
        email,
        display_name: displayName,
        notes,
      });
    }

    prevCandidateName = null;
  }

  return items;
}

/**
 * Parses structured email lists (`email`, `alias email`, `a@g.com,b@g.com`, `email | notes`)
 * and reports non-comment malformed lines in `invalidLines`.
 */
export function parseBulkEmailLines(
  rawText: string,
  existingAliases: Set<string> = new Set(),
): ParseBulkEmailResult {
  const usedAliases = new Set(Array.from(existingAliases).map((a) => a.toLowerCase()));
  const seenEmails = new Set<string>();
  const items: ParsedBulkEmailItem[] = [];
  const invalidLines: string[] = [];

  const rawLines = rawText.split(/\r?\n/);
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let body = trimmed;
    let notes: string | undefined;
    const pipeIdx = trimmed.indexOf('|');
    if (pipeIdx >= 0) {
      body = trimmed.slice(0, pipeIdx).trim();
      const rawNotes = trimmed.slice(pipeIdx + 1).trim();
      if (rawNotes) notes = rawNotes;
    }

    if (!body) continue;

    const commaParts = body.split(',').map((p) => p.trim()).filter(Boolean);
    if (commaParts.length >= 2 && commaParts.every((p) => p.includes('@'))) {
      for (const part of commaParts) {
        tryAddEmailToken(part, undefined, notes, seenEmails, usedAliases, items, invalidLines);
      }
      continue;
    }

    const tokens = body.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 1) {
      tryAddEmailToken(tokens[0], undefined, notes, seenEmails, usedAliases, items, invalidLines);
    } else if (tokens.length === 2 && !tokens[0].includes('@') && tokens[1].includes('@')) {
      tryAddEmailToken(tokens[1], tokens[0], notes, seenEmails, usedAliases, items, invalidLines);
    } else if (tokens.length === 2 && tokens[0].includes('@') && !tokens[1].includes('@')) {
      tryAddEmailToken(tokens[0], tokens[1], notes, seenEmails, usedAliases, items, invalidLines);
    } else {
      invalidLines.push(trimmed);
    }
  }

  return { items, invalidLines };
}

function isNoiseUiText(line: string): boolean {
  if (line.length < 2 || line.length > 60) return true;
  if (line.includes('http://') || line.includes('https://') || line.includes('@')) return true;
  if (/^[\d\W]+$/.test(line)) return true;
  return /^(signed in|signed out|default|mặc định|đã đăng nhập|đã đăng xuất|đăng xuất|đăng nhập|chọn tài khoản|choose an account|use another account|sử dụng một tài khoản khác|sign out of all accounts|đăng xuất khỏi tất cả tài khoản|manage your google account|quản lý tài khoản google của bạn|remove an account|xóa tài khoản|session expired|phiên đã hết hạn|add account|thêm tài khoản|privacy|terms|quyền riêng tư|điều khoản)$/i.test(
    line,
  );
}

function tryAddEmailToken(
  rawEmail: string,
  explicitAlias: string | undefined,
  notes: string | undefined,
  seenEmails: Set<string>,
  usedAliases: Set<string>,
  items: ParsedBulkEmailItem[],
  invalidLines: string[],
): void {
  let email: string;
  try {
    email = validateEmail(rawEmail);
  } catch {
    invalidLines.push(rawEmail);
    return;
  }

  if (seenEmails.has(email)) return;
  seenEmails.add(email);

  let alias: string;
  if (explicitAlias) {
    try {
      const normalized = validateAlias(explicitAlias);
      if (usedAliases.has(normalized)) {
        alias = generateUniqueAlias(email, usedAliases);
      } else {
        usedAliases.add(normalized);
        alias = normalized;
      }
    } catch {
      alias = generateUniqueAlias(email, usedAliases);
    }
  } else {
    alias = generateUniqueAlias(email, usedAliases);
  }

  items.push({ alias, email, notes });
}

interface RawInfoCacheEntry {
  name?: unknown;
  user_name?: unknown;
  gaia_name?: unknown;
}

function readLocalStateInfoCache(filePath: string): {
  data: Record<string, RawInfoCacheEntry>;
  errorCode: string | null;
} {
  if (!fs.existsSync(filePath)) return { data: {}, errorCode: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { profile?: { info_cache?: Record<string, RawInfoCacheEntry> } };
    const cache = parsed?.profile?.info_cache;
    return {
      data: cache && typeof cache === 'object' ? cache : {},
      errorCode: null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'READ_ERROR';
    return { data: {}, errorCode: code };
  }
}

function readPreferencesMetadata(filePath: string): {
  data: Array<{ email: string; fullName: string }>;
  errorCode: string | null;
} {
  if (!fs.existsSync(filePath)) return { data: [], errorCode: null };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      account_info?: Array<{ email?: unknown; full_name?: unknown }>;
      google?: { services?: { username?: unknown; last_username?: unknown } };
      signin?: { last_used_username?: unknown };
    };

    const byEmail = new Map<string, { email: string; fullName: string }>();

    if (Array.isArray(parsed?.account_info)) {
      for (const item of parsed.account_info) {
        if (item && typeof item.email === 'string' && item.email.includes('@')) {
          const email = item.email.trim().toLowerCase();
          byEmail.set(email, {
            email,
            fullName: typeof item.full_name === 'string' ? item.full_name.trim() : '',
          });
        }
      }
    }

    const extraUsernames = [
      parsed?.google?.services?.username,
      parsed?.google?.services?.last_username,
      parsed?.signin?.last_used_username,
    ];
    for (const rawEmail of extraUsernames) {
      if (typeof rawEmail === 'string' && rawEmail.includes('@')) {
        const email = rawEmail.trim().toLowerCase();
        if (!byEmail.has(email)) {
          byEmail.set(email, { email, fullName: '' });
        }
      }
    }

    return { data: Array.from(byEmail.values()), errorCode: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'READ_ERROR';
    return { data: [], errorCode: code };
  }
}
