import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { acquireAgyLease, DEFAULT_LEASE_TTL_MS } from './agylock.ts';
import {
  captureAgySession,
  detectEmailInBlob,
  hasSessionSnapshot,
  readKeychainBlob,
  type AgyCaptureResult,
  type AgySessionDeps,
} from './agysession.ts';
import type { PoolPaths } from './config.ts';
import type { PoolDB } from './db.ts';
import { PoolSwitcher } from './switcher.ts';
import type { AccountRecord } from './types.ts';

const OAUTH_URL_REGEX = /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>)\]]+/gi;

/**
 * Extracts the first Google OAuth2 authorization URL from arbitrary CLI output or clipboard text.
 */
export function extractGoogleOAuthUrl(text: string): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  OAUTH_URL_REGEX.lastIndex = 0;
  const match = OAUTH_URL_REGEX.exec(cleaned);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, '');
}

export interface WaitKeychainOptions {
  targetEmail: string;
  previousSha: string | null;
  allowExistingMatch?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  agyDeps?: AgySessionDeps;
}

export interface WaitKeychainResult {
  matched: boolean;
  detectedEmail: string | null;
  blobSha: string | null;
}

/**
 * Polls the login Keychain until an agy credential matching `targetEmail` appears
 * (or until aborted / timed out).
 */
export async function waitForKeychainAccount(options: WaitKeychainOptions): Promise<WaitKeychainResult> {
  const targetLower = options.targetEmail.trim().toLowerCase();
  const timeoutMs = Math.max(500, options.timeoutMs ?? 180_000);
  const pollMs = Math.max(50, options.pollMs ?? 1_200);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) {
      return { matched: false, detectedEmail: null, blobSha: null };
    }

    const blob = readKeychainBlob(options.agyDeps);
    if (blob) {
      const sha = crypto.createHash('sha256').update(blob).digest('hex');
      const email = detectEmailInBlob(blob);
      const changed = options.previousSha === null || sha !== options.previousSha;
      if (email && email.toLowerCase() === targetLower && (changed || options.allowExistingMatch)) {
        return { matched: true, detectedEmail: email, blobSha: sha };
      }
    }

    if (Date.now() >= deadline) break;
    await sleepAbortable(Math.min(pollMs, Math.max(20, deadline - Date.now())), options.signal);
  }

  return { matched: false, detectedEmail: null, blobSha: null };
}

export interface OnboardSingleOptions {
  db: PoolDB;
  paths: PoolPaths;
  account: AccountRecord;
  switcher?: PoolSwitcher;
  loginCommand?: { bin: string; args: string[] } | null;
  watchClipboard?: boolean;
  readClipboardFn?: () => Promise<string>;
  timeoutMs?: number;
  pollMs?: number;
  encrypt?: boolean;
  agyDeps?: AgySessionDeps;
  onLog?: (msg: string) => void;
  signal?: AbortSignal;
}

export interface OnboardSingleResult {
  ok: boolean;
  alias: string;
  email: string;
  oauthUrlsOpened: string[];
  capture?: AgyCaptureResult;
  reason?: string;
}

/**
 * Automates onboarding a single account into agy:
 * 1) Records baseline Keychain hash
 * 2) Optionally spawns a login command and intercepts Google OAuth2 URLs from stdout/stderr
 * 3) Optionally watches clipboard for Google OAuth2 URLs
 * 4) Opens any detected OAuth URL straight into the target account's Chrome profile (with login_hint/authuser)
 * 5) Watches macOS Keychain and auto-captures the encrypted snapshot the moment the target email signs in!
 */
export async function onboardSingleAccount(options: OnboardSingleOptions): Promise<OnboardSingleResult> {
  const { db, paths, account } = options;
  const switcher = options.switcher ?? new PoolSwitcher({ db, paths });
  const log = options.onLog ?? (() => {});
  const oauthUrlsOpened: string[] = [];
  const seenUrls = new Set<string>();

  await switcher.switchTo(account.alias, { openChrome: false });

  const initialBlob = readKeychainBlob(options.agyDeps);
  const initialEmail = initialBlob ? detectEmailInBlob(initialBlob) : null;
  const initialSha = initialBlob ? crypto.createHash('sha256').update(initialBlob).digest('hex') : null;

  // If Keychain ALREADY holds this exact account right now, capture immediately!
  if (initialEmail && initialEmail.toLowerCase() === account.email.toLowerCase()) {
    const cap = captureAgySession(paths, account, { ...options.agyDeps, encrypt: options.encrypt ?? true });
    db.addEvent(account.id, account.alias, 'agy_onboard_captured', `Auto-Onboard lưu ngay phiên agy cho ${account.alias}`);
    log(`✓ Keychain hiện đã đăng nhập sẵn ${account.email} — đã tự động capture!`);
    return { ok: true, alias: account.alias, email: account.email, oauthUrlsOpened, capture: cap };
  }

  const abortCtrl = new AbortController();
  const forwardAbort = () => abortCtrl.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });

  const openDetectedOAuth = async (url: string, source: string) => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    oauthUrlsOpened.push(url);
    log(`→ Phát hiện link OAuth từ ${source} — đang tự mở vào Chrome profile "${account.alias}"...`);
    try {
      await switcher.openOAuthInAccount(account.alias, url);
    } catch (err) {
      log(`! Không mở được OAuth tự động: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let loginChild: ReturnType<typeof spawn> | null = null;
  if (options.loginCommand) {
    try {
      loginChild = spawn(options.loginCommand.bin, options.loginCommand.args, {
        env: { ...process.env, BROWSER: 'echo' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onData = (chunk: Buffer) => {
        const url = extractGoogleOAuthUrl(chunk.toString('utf8'));
        if (url) void openDetectedOAuth(url, options.loginCommand!.bin);
      };
      loginChild.stdout?.on('data', onData);
      loginChild.stderr?.on('data', onData);
      loginChild.once('error', (err) => {
        log(`! Không khởi chạy được "${options.loginCommand!.bin}": ${err.message}`);
      });
    } catch (err) {
      log(`! Lỗi khởi chạy login command: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const readClip = options.readClipboardFn ?? defaultReadClipboard;
  let clipTimer: NodeJS.Timeout | null = null;
  if (options.watchClipboard !== false) {
    const initialClip = await readClip();
    const initialClipUrl = extractGoogleOAuthUrl(initialClip);
    if (initialClipUrl) seenUrls.add(initialClipUrl);

    clipTimer = setInterval(() => {
      if (abortCtrl.signal.aborted) return;
      void readClip().then((txt) => {
        const url = extractGoogleOAuthUrl(txt);
        if (url && !seenUrls.has(url)) {
          void openDetectedOAuth(url, 'Clipboard');
        }
      });
    }, Math.max(150, options.pollMs ?? 1_200));
    clipTimer.unref();
  }

  try {
    const waitRes = await waitForKeychainAccount({
      targetEmail: account.email,
      previousSha: initialSha,
      timeoutMs: options.timeoutMs ?? 180_000,
      pollMs: options.pollMs ?? 1_200,
      signal: abortCtrl.signal,
      agyDeps: options.agyDeps,
    });

    if (!waitRes.matched) {
      return {
        ok: false,
        alias: account.alias,
        email: account.email,
        oauthUrlsOpened,
        reason: abortCtrl.signal.aborted ? 'Đã hủy/bỏ qua' : 'Hết thời gian chờ đăng nhập OAuth vào Keychain',
      };
    }

    const cap = captureAgySession(paths, account, { ...options.agyDeps, encrypt: options.encrypt ?? true });
    db.addEvent(
      account.id,
      account.alias,
      'agy_onboard_captured',
      `Auto-Onboard đã tự động lưu phiên agy${cap.encrypted ? ' (AES-256-GCM)' : ''} cho ${account.alias}`,
    );
    log(`✓ Đã phát hiện ${account.email} trong Keychain và tự động lưu snapshot${cap.encrypted ? ' (mã hóa AES-256-GCM)' : ''}!`);
    return { ok: true, alias: account.alias, email: account.email, oauthUrlsOpened, capture: cap };
  } finally {
    abortCtrl.abort();
    if (clipTimer) clearInterval(clipTimer);
    if (loginChild && !loginChild.killed) {
      try {
        loginChild.kill('SIGTERM');
      } catch {
        // Ignore.
      }
    }
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export interface RunOnboardWizardOptions {
  db: PoolDB;
  paths: PoolPaths;
  alias?: string;
  includeAll?: boolean;
  loginCommand?: { bin: string; args: string[] } | null;
  timeoutSeconds?: number;
  onAccountCaptured?: (alias: string) => Promise<void> | void;
}

/**
 * Interactive 1/N Auto-Onboard CLI Wizard for capturing agy sessions across multiple accounts.
 */
export async function runAgyOnboardWizard(options: RunOnboardWizardOptions): Promise<{
  captured: string[];
  skipped: string[];
  failed: Array<{ alias: string; reason: string }>;
}> {
  const { db, paths } = options;
  let targets: AccountRecord[];
  if (options.alias) {
    const found = db.getAccount(options.alias);
    if (!found) throw new Error(`Không tìm thấy tài khoản "${options.alias}".`);
    targets = [found];
  } else {
    const all = db.listAccounts();
    targets = options.includeAll ? all : all.filter((acc) => !hasSessionSnapshot(paths, acc.alias));
  }

  if (targets.length === 0) {
    console.log('Tất cả tài khoản trong pool đều đã có phiên agy được lưu! (Dùng --all để onboard lại.)');
    return { captured: [], skipped: [], failed: [] };
  }

  const lease = await acquireAgyLease(paths, {
    alias: targets[0].alias,
    holder: 'gpool-onboard',
    ttlMs: DEFAULT_LEASE_TTL_MS,
  });

  const captured: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ alias: string; reason: string }> = [];
  const switcher = new PoolSwitcher({ db, paths });

  console.log(`\n=== Auto-Onboard phiên agy (${targets.length} tài khoản) ===`);
  console.log('Cơ chế tự động:');
  console.log('  • Copy link OAuth từ agy (/login) → gpool tự mở thẳng vào đúng Chrome profile của từng acc.');
  console.log('  • Ngay khi bạn bấm "Allow" xong trên Chrome → gpool tự phát hiện Keychain và lưu snapshot mã hóa!\n');

  try {
    for (let i = 0; i < targets.length; i += 1) {
      const acc = targets[i];
      console.log(`\n[${i + 1}/${targets.length}] Tài khoản: ${acc.alias} (${acc.email}) [${acc.profile_mode}]`);
      console.log('  → Mở Chrome profile sẵn & chờ đăng nhập agy (tự động bắt link OAuth từ Clipboard/stdout)...');
      console.log('  → Phím nhanh trên Terminal: [s]+Enter bỏ qua | [o]+Enter mở Chrome | [q]+Enter dừng Wizard');

      const abortCtrl = new AbortController();
      let userAction: 'none' | 'skip' | 'quit' = 'none';

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const onLine = (line: string) => {
        const cmd = line.trim().toLowerCase();
        if (cmd === 'q' || cmd === 'quit') {
          userAction = 'quit';
          abortCtrl.abort();
        } else if (cmd === 's' || cmd === 'skip') {
          userAction = 'skip';
          abortCtrl.abort();
        } else if (cmd === 'o' || cmd === 'open') {
          void switcher.openProfile(acc.alias).then(() => {
            console.log(`  → Đã mở cửa sổ Chrome cho "${acc.alias}".`);
          });
        }
      };
      rl.on('line', onLine);

      try {
        const res = await onboardSingleAccount({
          db,
          paths,
          account: acc,
          switcher,
          loginCommand: options.loginCommand ?? null,
          watchClipboard: true,
          timeoutMs: (options.timeoutSeconds ?? 180) * 1000,
          encrypt: true,
          onLog: (m) => console.log(`  ${m}`),
          signal: abortCtrl.signal,
        });

        if (res.ok) {
          captured.push(acc.alias);
          await options.onAccountCaptured?.(acc.alias);
        } else if (userAction === 'quit') {
          console.log('Đã tạm dừng Auto-Onboard Wizard.');
          break;
        } else if (userAction === 'skip') {
          skipped.push(acc.alias);
          console.log(`  → Đã bỏ qua "${acc.alias}".`);
        } else {
          failed.push({ alias: acc.alias, reason: res.reason ?? 'Không rõ nguyên nhân' });
          console.log(`  ! Chưa lưu được "${acc.alias}": ${res.reason}`);
        }
      } finally {
        rl.off('line', onLine);
        rl.close();
      }
    }
  } finally {
    lease.release();
  }

  console.log(
    `\nKết quả Auto-Onboard: đã lưu ${captured.length}, bỏ qua ${skipped.length}, chưa hoàn tất ${failed.length}.`,
  );
  return { captured, skipped, failed };
}

async function defaultReadClipboard(): Promise<string> {
  if (process.platform !== 'darwin') return '';
  return await new Promise<string>((resolve) => {
    execFile('/usr/bin/pbpaste', [], (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
