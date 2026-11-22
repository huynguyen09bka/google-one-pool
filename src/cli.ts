import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  BACKUP_MIN_PASSPHRASE_LENGTH,
  decryptBackupBundle,
  encryptBackupBundle,
  isEncryptedBackupBundle,
} from './agycrypto.ts';
import { readAgyLease, releaseAgyLease } from './agylock.ts';
import { runAgyOnboardWizard } from './agy-onboard.ts';
import { runAgyWithFailover } from './agy-runner.ts';
import {
  activateAgySession,
  captureAgySession,
  exportDecryptedSessions,
  getAgySessionStatus,
  getLiveKeychainContext,
  hasSessionSnapshot,
  importSessionsFromBackup,
  inspectAgyHealth,
  migrateSessionsToEncrypted,
  sessionInfoForAlias,
  type AgyActivateResult,
  type AgyCaptureResult,
  type AgySessionSnapshot,
  type AgyStatusResult,
} from './agysession.ts';
import { computePoolAnalytics } from './analytics.ts';
import {
  discoverBrowserProfiles,
  extractEmailsFromText,
  generateUniqueAlias,
  getDefaultBrowserRoots,
} from './browser-import.ts';
import { isAccountChromeRunning } from './chrome.ts';
import {
  DEFAULT_HOST,
  readDaemonToken,
  redactProxyUrl,
  resolvePaths,
  resolvePort,
  validateAlias,
  validateChromeProfileName,
  validateEmail,
  validateLocale,
  validateRotationPolicy,
  writeFileRestricted,
  type PoolPaths,
} from './config.ts';
import { PoolDB } from './db.ts';
import { getCommandHelpText, getMainHelpText, pick, resolveLocale } from './i18n.ts';
import { KeepAliveScheduler } from './keepalive.ts';
import { getLaunchAgentStatus, installLaunchAgent, uninstallLaunchAgent } from './launchagent.ts';
import { runMcpServer } from './mcp.ts';
import { createDaemonServer } from './server.ts';
import { PoolSwitcher } from './switcher.ts';
import { runTui } from './tui.ts';
import type {
  AccountView,
  AgyEncryptMigrationResult,
  AgyHealthReport,
  AgyLeaseInfo,
  BulkImportItemInput,
  BulkImportResult,
  EffectiveState,
  EncryptedBackupBundle,
  Locale,
  PlanTier,
  PoolAnalyticsReport,
  PoolExportPayload,
  ProfileMode,
  RotationPolicy,
} from './types.ts';

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
  passthrough: string[];
}

async function loadCliLocale(paths: PoolPaths, port: number, flagLang?: string): Promise<Locale> {
  if (flagLang) return validateLocale(flagLang);
  if (process.env.GPOOL_LANG?.trim()) return resolveLocale(process.env.GPOOL_LANG);
  try {
    if (await isDaemonAlive(port)) {
      const res = await callDaemon<{ settings?: { language?: Locale } }>(port, '/api/settings');
      return resolveLocale(undefined, res.settings?.language);
    }
    if (fs.existsSync(paths.dbPath)) {
      const db = new PoolDB(paths);
      try {
        return resolveLocale(undefined, db.getSettings().language);
      } finally {
        db.close();
      }
    }
  } catch {
    // Fall back to default locale.
  }
  return resolveLocale();
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const asJson = Boolean(parsed.flags.get('json'));
  const wantHelp = Boolean(parsed.flags.get('help'));
  const paths = resolvePaths();
  const port = resolvePort(
    typeof parsed.flags.get('port') === 'string' ? Number(parsed.flags.get('port')) : undefined,
  );
  const flagLang = getStrFlag(parsed.flags, 'lang');
  const locale = await loadCliLocale(paths, port, flagLang);

  if (argv.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return await runTui({ paths, port, locale, runCliSubcommand: runCli });
    }
    printHelp(locale);
    return 0;
  }

  const cmd = parsed.positionals[0] ?? 'help';
  const rest = parsed.positionals.slice(1);

  if (wantHelp && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
    printCommandHelp(locale, cmd);
    return 0;
  }

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        if (rest[0]) {
          printCommandHelp(locale, rest[0]);
        } else {
          printHelp(locale);
        }
        return 0;

      case 'lang':
      case 'language':
        return await handleLang(rest, paths, port, locale, asJson);

      case 'tui':
      case 'ui':
      case 'interactive':
        return await runTui({ paths, port, locale, runCliSubcommand: runCli });

      case 'add':
        return await handleAdd(rest, parsed.flags, paths, port, asJson);

      case 'list':
      case 'ls':
        return await handleList(parsed.flags, paths, port, asJson);

      case 'show':
      case 'info':
        return await handleShow(rest, paths, port, asJson);

      case 'edit':
        return await handleEdit(rest, parsed.flags, paths, port, asJson);

      case 'rm':
      case 'delete':
        return await handleDelete(rest, parsed.flags, paths, port, asJson);

      case 'login':
        return await handleLogin(rest, paths, port, asJson);

      case 'login-wizard':
        return await handleLoginWizard(paths, port);

      case 'open':
        return await handleOpen(rest, parsed.flags, paths, port, asJson);

      case 'switch':
      case 'use':
        return await handleSwitch(rest, parsed.flags, paths, port, asJson);

      case 'next':
      case 'rotate':
        return await handleNext(parsed.flags, paths, port, asJson);

      case 'auth':
        return await handleAuth(rest, paths, port, asJson);

      case 'cooldown':
        return await handleCooldown(rest, parsed.flags, paths, port, asJson);

      case 'check':
        return await handleCheck(rest, paths, port, asJson);

      case 'isolate':
        return await handleIsolate(rest, parsed.flags, paths, port, asJson);

      case 'import-chrome':
        return await handleImportChrome(parsed.flags, paths, port, asJson);

      case 'import-emails':
        return await handleImportEmails(rest, parsed.flags, paths, port, asJson);

      case 'import-clipboard':
        return await handleImportClipboard(parsed.flags, paths, port, asJson);

      case 'agy':
        return await handleAgyWrapper(rest, parsed.passthrough, parsed.flags, paths, port, asJson);

      case 'agy-next':
        return await handleAgyNext(parsed.flags, paths, port, asJson);

      case 'agy-capture':
        return await handleAgyCapture(rest, paths, port, asJson);

      case 'agy-activate':
        return await handleAgyActivate(rest, parsed.flags, paths, port, asJson);

      case 'agy-status':
        return await handleAgyStatus(paths, port, asJson);

      case 'agy-health':
        return await handleAgyHealth(paths, port, asJson);

      case 'agy-lock':
        return await handleAgyLock(rest, paths, port, asJson);

      case 'agy-encrypt':
        return await handleAgyEncrypt(paths, port, asJson);

      case 'agy-onboard':
        return await handleAgyOnboard(rest, parsed.flags, paths, port);

      case 'stats':
      case 'analytics':
        return await handleStats(parsed.flags, paths, port, asJson);

      case 'mcp':
        return await runMcpServer({ paths, port });

      case 'run':
        return await handleRun(rest, parsed.passthrough, parsed.flags, paths);

      case 'daemon':
        return await handleDaemon(rest, parsed.flags, paths, port, asJson);

      case 'dashboard':
        return await handleDashboard(paths, port);

      case 'menubar':
        return await handleMenubar(rest, paths, port);

      case 'launchagent':
        return await handleLaunchAgent(rest, paths, port, asJson);

      case 'export':
        return await handleExport(rest, parsed.flags, paths, port);

      case 'import':
        return await handleImport(rest, parsed.flags, paths, port, asJson);

      default:
        throw new Error(
          pick(
            locale,
            `Lệnh không hợp lệ: "${cmd}". Chạy "gpool help" để xem hướng dẫn.`,
            `Unknown command: "${cmd}". Run "gpool help" for usage.`,
          ),
        );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`${pick(locale, 'Lỗi', 'Error')}: ${msg}`);
    }
    return 1;
  }
}

async function handleLang(
  args: string[],
  paths: PoolPaths,
  port: number,
  currentLocale: Locale,
  asJson: boolean,
): Promise<number> {
  const [nextRaw] = args;
  if (!nextRaw) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, language: currentLocale }, null, 2));
    } else {
      console.log(
        pick(
          currentLocale,
          `Ngôn ngữ hiện tại: ${currentLocale} (Tiếng Việt). Đổi sang tiếng Anh: gpool lang en`,
          `Current language: ${currentLocale} (English). Switch to Vietnamese: gpool lang vi`,
        ),
      );
    }
    return 0;
  }

  const next = validateLocale(nextRaw);
  if (await isDaemonAlive(port)) {
    await callDaemon(port, '/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ language: next }),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      db.updateSettings({ language: next });
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, language: next }, null, 2));
  } else {
    console.log(
      next === 'en'
        ? 'Language switched to English (en). All CLI, TUI, Web Dashboard, and Menu Bar interfaces will use English.'
        : 'Đã chuyển ngôn ngữ sang Tiếng Việt (vi). CLI, TUI, Web Dashboard và Menu Bar sẽ dùng Tiếng Việt.',
    );
  }
  return 0;
}

async function handleAdd(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias, email] = args;
  if (!alias || !email) {
    throw new Error('Cú pháp: gpool add <alias> <email> [--name "..."] [--plan "..."] [--renewal YYYY-MM-DD] [--tags a,b] [--proxy <url>] [--notes "..."]');
  }

  const payload = {
    alias,
    email,
    display_name: getStrFlag(flags, 'name') ?? '',
    plan_tier: (getStrFlag(flags, 'plan') as PlanTier | undefined) ?? 'Google AI Pro',
    renewal_date: getStrFlag(flags, 'renewal') ?? null,
    tags: getStrFlag(flags, 'tags')?.split(',').map((t) => t.trim()).filter(Boolean) ?? [],
    notes: getStrFlag(flags, 'notes') ?? '',
    proxy_url: getStrFlag(flags, 'proxy') ?? null,
    adc_credentials_path: getStrFlag(flags, 'adc') ?? null,
  };

  if (await isDaemonAlive(port)) {
    const data = await callDaemon<{ ok: boolean; account: AccountView }>(port, '/api/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Đã thêm "${data.account.alias}" (${data.account.email}). Chạy "gpool login ${data.account.alias}" để đăng nhập Chrome lần đầu.`);
    }
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const created = db.createAccount(payload);
    const view = db.computeAccountView(created, false);
    if (asJson) {
      console.log(JSON.stringify({ ok: true, account: view }, null, 2));
    } else {
      console.log(`Đã thêm "${view.alias}" (${view.email}). Chạy "gpool login ${view.alias}" để đăng nhập Chrome lần đầu.`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function handleList(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const q = getStrFlag(flags, 'q');
  const tag = getStrFlag(flags, 'tag');
  const status = getStrFlag(flags, 'status') as EffectiveState | undefined;

  let accounts: AccountView[];
  let activeAlias: string | null = null;

  if (await isDaemonAlive(port)) {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (tag) qs.set('tag', tag);
    if (status) qs.set('status', status);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const data = await callDaemon<{ accounts: AccountView[]; activeAlias: string | null }>(port, `/api/accounts${query}`);
    accounts = data.accounts;
    activeAlias = data.activeAlias;
  } else {
    const db = new PoolDB(paths);
    try {
      db.expireElapsedCooldowns();
      accounts = db.listAccounts({ q, tag, status }).map((acc) => {
        const running = isAccountChromeRunning(acc).running;
        return db.computeAccountView(acc, running);
      });
      activeAlias = accounts.find((a) => a.is_active)?.alias ?? null;
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ activeAlias, accounts }, null, 2));
    return 0;
  }

  if (accounts.length === 0) {
    console.log('Chưa có tài khoản nào trong pool. Chạy "gpool add <alias> <email>" hoặc "gpool import-chrome" để bắt đầu.');
    return 0;
  }

  const lines = accounts.map((acc) => {
    const marker = acc.is_active ? '*' : ' ';
    const mode = acc.profile_mode === 'linked' ? `link:${acc.chrome_profile_name ?? 'Default'}` : 'isolated';
    const cd = acc.cooldown_remaining_ms > 0 ? `cd:${formatShortMs(acc.cooldown_remaining_ms)}` : '-';
    const tags = acc.tags.length > 0 ? acc.tags.join(',') : '-';
    return `${marker} ${pad(acc.alias, 14)} ${pad(acc.email, 28)} ${pad(acc.effective_state, 12)} ${pad(mode, 14)} ${pad(cd, 9)} ${tags}`;
  });
  console.log(
    `  ${pad('ALIAS', 14)} ${pad('EMAIL', 28)} ${pad('TRẠNG THÁI', 12)} ${pad('CHẾ ĐỘ', 14)} ${pad('COOLDOWN', 9)} TAGS`,
  );
  for (const line of lines) console.log(line);
  return 0;
}

async function handleShow(args: string[], paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool show <alias>');

  let account: AccountView;
  if (await isDaemonAlive(port)) {
    const res = await callDaemon<{ account: AccountView }>(port, `/api/accounts/${encodeURIComponent(alias)}`);
    account = res.account;
  } else {
    const db = new PoolDB(paths);
    try {
      db.expireElapsedCooldowns();
      const found = db.getAccount(alias);
      if (!found) throw new Error(`Không tìm thấy tài khoản "${alias}".`);
      account = db.computeAccountView(found, isAccountChromeRunning(found).running);
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify(account, null, 2));
  } else {
    console.log(`Alias:          ${account.alias}${account.is_active ? ' (ACTIVE)' : ''}`);
    console.log(`Email:          ${account.email}`);
    console.log(`Gói:            ${account.plan_tier}`);
    console.log(`Chế độ profile: ${account.profile_mode}${account.chrome_profile_name ? ` (${account.chrome_profile_name})` : ''}`);
    if (account.google_authuser) console.log(`Authuser:       ${account.google_authuser}`);
    console.log(`Trạng thái:     ${account.effective_state} (session: ${account.session_status})`);
    console.log(`Chrome profile: ${account.chrome_profile_dir}`);
    if (account.renewal_date) console.log(`Gia hạn:        ${account.renewal_date}`);
    if (account.tags.length) console.log(`Tags:           ${account.tags.join(', ')}`);
    if (account.proxy_url) console.log(`Proxy:          ${redactProxyUrl(account.proxy_url)}`);
    if (account.cooldown_remaining_ms > 0) console.log(`Cooldown còn:   ${formatShortMs(account.cooldown_remaining_ms)}`);
    if (account.bucket_cooldowns && account.bucket_cooldowns.length > 0) {
      const bList = account.bucket_cooldowns
        .map((b) => `${b.bucket}:${formatShortMs(b.remaining_ms)}`)
        .join(', ');
      console.log(`Cooldown nhóm:  ${bList}`);
    }
    if (account.notes) console.log(`Ghi chú:        ${account.notes}`);
    let agyInfo = account.agy_session;
    if (agyInfo === undefined) {
      try {
        const ctx = getLiveKeychainContext(paths);
        agyInfo = sessionInfoForAlias(paths, account.alias, ctx.live_sha, ctx.marker_alias, ctx.live_owner_alias);
      } catch {
        agyInfo = null;
      }
    }
    if (agyInfo) {
      const liveTag = agyInfo.is_live_owner ? ' — đang nạp trong Keychain' : '';
      console.log(`Phiên agy:      đã lưu (${agyInfo.captured_at})${liveTag}`);
    } else {
      console.log('Phiên agy:      chưa lưu (chạy "gpool agy-capture" sau khi đăng nhập agy)');
    }
  }
  return 0;
}

async function handleEdit(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool edit <alias> [--alias ...] [--email ...] [--tags ...] [--renewal ...] [--notes ...] [--proxy ...]');

  const patch: Record<string, unknown> = {};
  if (flags.has('alias')) patch.alias = getStrFlag(flags, 'alias');
  if (flags.has('email')) patch.email = getStrFlag(flags, 'email');
  if (flags.has('name')) patch.display_name = getStrFlag(flags, 'name') ?? '';
  if (flags.has('plan')) patch.plan_tier = getStrFlag(flags, 'plan');
  if (flags.has('renewal')) patch.renewal_date = getStrFlag(flags, 'renewal') || null;
  if (flags.has('tags')) {
    const raw = getStrFlag(flags, 'tags') ?? '';
    patch.tags = raw.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (flags.has('notes')) patch.notes = getStrFlag(flags, 'notes') ?? '';
  if (flags.has('proxy')) patch.proxy_url = getStrFlag(flags, 'proxy') || null;
  if (flags.has('adc')) patch.adc_credentials_path = getStrFlag(flags, 'adc') || null;
  if (flags.has('authuser')) patch.google_authuser = getStrFlag(flags, 'authuser') || null;

  if (await isDaemonAlive(port)) {
    const res = await callDaemon<{ ok: boolean; account: AccountView }>(port, `/api/accounts/${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`Đã cập nhật "${res.account.alias}".`);
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const updated = db.updateAccount(alias, patch);
    const view = db.computeAccountView(updated, isAccountChromeRunning(updated).running);
    if (asJson) console.log(JSON.stringify({ ok: true, account: view }, null, 2));
    else console.log(`Đã cập nhật "${view.alias}".`);
    return 0;
  } finally {
    db.close();
  }
}

async function handleDelete(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool rm <alias> [--purge]');
  const purge = Boolean(flags.get('purge'));

  if (await isDaemonAlive(port)) {
    const res = await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}?purgeProfile=${purge ? 'true' : 'false'}`, {
      method: 'DELETE',
    });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`Đã xóa tài khoản "${alias}".`);
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const deleted = db.deleteAccount(alias, { purgeProfile: purge });
    if (asJson) console.log(JSON.stringify({ ok: true, deleted }, null, 2));
    else console.log(`Đã xóa tài khoản "${deleted.alias}".`);
    return 0;
  } finally {
    db.close();
  }
}

async function handleLogin(args: string[], paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool login <alias>');

  if (await isDaemonAlive(port)) {
    const res = await callDaemon<{ ok: boolean; alias: string; url: string }>(
      port,
      `/api/accounts/${encodeURIComponent(alias)}/login`,
      { method: 'POST' },
    );
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`Đã mở Chrome đăng nhập "${res.alias}" (điền sẵn email).`);
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const switcher = new PoolSwitcher({ db, paths });
    const res = await switcher.openLogin(alias);
    if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    else console.log(`Đã mở Chrome đăng nhập "${res.alias}" (điền sẵn email).`);
    return 0;
  } finally {
    db.close();
  }
}

async function handleLoginWizard(paths: PoolPaths, port: number): Promise<number> {
  const daemonAlive = await isDaemonAlive(port);
  let accounts: AccountView[];

  if (daemonAlive) {
    const data = await callDaemon<{ accounts: AccountView[] }>(port, '/api/accounts');
    accounts = data.accounts;
  } else {
    const db = new PoolDB(paths);
    try {
      accounts = db
        .listAccounts()
        .map((acc) => db.computeAccountView(acc, isAccountChromeRunning(acc).running));
    } finally {
      db.close();
    }
  }

  const pending = accounts.filter(
    (a) =>
      a.profile_mode === 'isolated' &&
      (a.session_status === 'unknown' || a.session_status === 'needs_login'),
  );

  if (pending.length === 0) {
    console.log('Không có profile riêng nào đang chờ đăng nhập.');
    return 0;
  }

  console.log(`Tìm thấy ${pending.length} profile riêng cần đăng nhập nối tiếp.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let i = 0; i < pending.length; i += 1) {
      const acc = pending[i];
      console.log(`\n[${i + 1}/${pending.length}] Đang mở Chrome profile riêng cho "${acc.alias}" (${acc.email})...`);

      if (daemonAlive) {
        await callDaemon(port, `/api/accounts/${encodeURIComponent(acc.alias)}/login`, { method: 'POST' });
      } else {
        const db = new PoolDB(paths);
        try {
          const switcher = new PoolSwitcher({ db, paths });
          await switcher.openLogin(acc.alias);
        } finally {
          db.close();
        }
      }

      const answer = (
        await rl.question('Nhấn Enter sau khi đăng nhập xong trong Chrome (gõ s để bỏ qua, q để thoát): ')
      )
        .trim()
        .toLowerCase();

      if (answer === 'q' || answer === 'quit') {
        console.log('Đã tạm dừng Wizard.');
        break;
      }
      if (answer === 's' || answer === 'skip') {
        console.log(`Đã bỏ qua ${acc.alias}.`);
        continue;
      }

      if (daemonAlive) {
        await callDaemon(port, `/api/accounts/${encodeURIComponent(acc.alias)}/confirm-login`, {
          method: 'POST',
        });
      } else {
        const db = new PoolDB(paths);
        try {
          const switcher = new PoolSwitcher({ db, paths });
          switcher.confirmLogin(acc.alias);
        } finally {
          db.close();
        }
      }
      console.log(`Đã xác nhận "${acc.alias}" là Live.`);
    }
  } finally {
    rl.close();
  }

  return 0;
}

async function handleOpen(
  args: string[],
  _flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
  defaultUrl?: string,
): Promise<number> {
  const [alias, explicitUrl] = args;
  if (!alias) throw new Error('Cú pháp: gpool open <alias> [url]');
  const openUrl = explicitUrl ?? defaultUrl;

  if (await isDaemonAlive(port)) {
    const res = await callDaemon<{ ok: boolean; alias: string; url: string }>(
      port,
      `/api/accounts/${encodeURIComponent(alias)}/open`,
      {
        method: 'POST',
        body: JSON.stringify(openUrl ? { openUrl } : {}),
      },
    );
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`Đã mở Chrome profile "${res.alias}" tại ${res.url}`);
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const switcher = new PoolSwitcher({ db, paths });
    const res = await switcher.openProfile(alias, openUrl);
    if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    else console.log(`Đã mở Chrome profile "${res.alias}" tại ${res.url}`);
    return 0;
  } finally {
    db.close();
  }
}

async function handleSwitch(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool switch <alias> [--cooldown-prev <hours>] [--reason "..."] [--no-open] [--url <url>]');

  const openChrome = !Boolean(flags.get('no-open'));
  const cooldownPrevRaw = getStrFlag(flags, 'cooldown-prev');
  const payload = {
    openChrome,
    openUrl: getStrFlag(flags, 'url'),
    cooldownPreviousHours: cooldownPrevRaw ? Number(cooldownPrevRaw) : undefined,
    cooldownReason: getStrFlag(flags, 'reason'),
  };

  let res;
  if (await isDaemonAlive(port)) {
    res = await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/switch`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      const switcher = new PoolSwitcher({ db, paths });
      res = await switcher.switchTo(alias, payload);
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const r = res as { active: AccountView; openedChrome: boolean; agyGuide: string };
    console.log(`Đã chuyển sang "${r.active.alias}" (${r.active.email})${r.openedChrome ? ' và mở Chrome profile' : ''}.`);
    console.log(r.agyGuide);
  }
  return 0;
}

async function handleNext(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const cooldownRaw = getStrFlag(flags, 'cooldown');
  const activateAgy = Boolean(flags.get('agy'));
  const explicitOpen = Boolean(flags.get('open'));
  const noOpen = Boolean(flags.get('no-open'));
  const openChrome = noOpen ? false : explicitOpen ? true : !activateAgy;
  const policyRaw = getStrFlag(flags, 'policy');
  const waitRaw = getStrFlag(flags, 'wait');

  const payload = {
    cooldownHours: cooldownRaw !== undefined ? Number(cooldownRaw) : undefined,
    reason: getStrFlag(flags, 'reason'),
    tag: getStrFlag(flags, 'tag'),
    bucket: getStrFlag(flags, 'bucket'),
    policy: policyRaw ? validateRotationPolicy(policyRaw) : undefined,
    activateAgy,
    requireAgy: activateAgy,
    forceAgy: Boolean(flags.get('force')),
    waitLockSeconds: waitRaw ? Number(waitRaw) : undefined,
    openChrome,
  };

  let res;
  if (await isDaemonAlive(port)) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...daemonAuthHeaders(paths) };
    const httpRes = await fetch(`http://${DEFAULT_HOST}:${port}/api/pool/next`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    res = await httpRes.json().catch(() => ({ ok: false, error: `HTTP ${httpRes.status}` }));
  } else {
    const db = new PoolDB(paths);
    try {
      const switcher = new PoolSwitcher({ db, paths });
      res = await switcher.rotateNext(payload);
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return (res as { ok: boolean }).ok ? 0 : 1;
  }

  const r = res as {
    ok: boolean;
    active?: AccountView;
    error?: string;
    agyGuide?: string;
    agyActivated?: boolean;
    recapturedAlias?: string | null;
    bucket?: string;
    nextAvailableAt?: string | null;
  };
  if (!r.ok) {
    console.error(r.error);
    if (r.nextAvailableAt) {
      console.error(`Tài khoản sớm nhất hết cooldown lúc: ${r.nextAvailableAt}`);
    }
    return 1;
  }
  const bucketSuffix = r.bucket && r.bucket !== 'all' ? ` [bucket: ${r.bucket}]` : '';
  console.log(`Đã xoay vòng sang "${r.active!.alias}" (${r.active!.email})${bucketSuffix}.`);
  if (r.agyActivated) {
    console.log(
      `Đã nạp luôn phiên agy của "${r.active!.alias}" vào Keychain` +
        (r.recapturedAlias ? ` (đã cập nhật snapshot "${r.recapturedAlias}")` : '') +
        ' — mở lại agy là chạy đúng acc.',
    );
  } else if (r.agyGuide) {
    console.log(r.agyGuide);
  }
  return 0;
}

async function handleAgyNext(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const merged = new Map(flags);
  merged.set('agy', true);
  if (!merged.has('open')) merged.set('no-open', true);
  return await handleNext(merged, paths, port, asJson);
}

async function handleAgyWrapper(
  args: string[],
  passthrough: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const agyArgs = passthrough.length > 0 ? passthrough : args;
  const maxRetriesRaw = getStrFlag(flags, 'max-retries');
  const cooldownRaw = getStrFlag(flags, 'cooldown');
  const waitRaw = getStrFlag(flags, 'wait');
  const timeoutRaw = getStrFlag(flags, 'timeout');
  const policyRaw = getStrFlag(flags, 'policy');
  const forceAutoRotate = Boolean(flags.get('auto-rotate'));
  const explicitInteractive = Boolean(flags.get('interactive'));

  const isInteractive =
    explicitInteractive ||
    (!forceAutoRotate && !asJson && agyArgs.length === 0 && Boolean(process.stdin.isTTY && process.stdout.isTTY));

  const db = new PoolDB(paths);
  let result;
  try {
    result = await runAgyWithFailover({
      db,
      paths,
      agyArgs,
      alias: getStrFlag(flags, 'alias'),
      tag: getStrFlag(flags, 'tag'),
      bucket: getStrFlag(flags, 'bucket') ?? 'all',
      policy: policyRaw ? (validateRotationPolicy(policyRaw) as RotationPolicy) : undefined,
      cooldownHoursOverride: cooldownRaw ? Number(cooldownRaw) : undefined,
      maxRetries: maxRetriesRaw ? Number(maxRetriesRaw) : 3,
      waitSeconds: waitRaw ? Number(waitRaw) : 0,
      timeoutSeconds: timeoutRaw ? Number(timeoutRaw) : undefined,
      forceAgy: Boolean(flags.get('force')),
      interactive: isInteractive,
      mirrorStdio: !asJson,
      holder: 'gpool-agy',
      onStatus: asJson ? undefined : (msg) => console.error(msg),
    });
  } finally {
    db.close();
  }

  // Best-effort sync running daemon so Web Dashboard updates live
  if (await isDaemonAlive(port)) {
    await fetch(`http://${DEFAULT_HOST}:${port}/api/sync`, {
      method: 'POST',
      headers: daemonAuthHeaders(paths),
    }).catch(() => {});
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok && result.error) {
    console.error(`Lỗi: ${result.error}`);
    if (result.nextAvailableAt) {
      console.error(`Tài khoản sớm nhất hết cooldown lúc: ${result.nextAvailableAt}`);
    }
  }
  return result.exitCode;
}

async function handleAgyHealth(paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  let report: AgyHealthReport;
  if (await isDaemonAlive(port)) {
    report = await callDaemon<AgyHealthReport>(port, '/api/agy/health');
  } else {
    const db = new PoolDB(paths);
    try {
      db.expireElapsedCooldowns();
      const settings = db.getSettings();
      const alerts = db.getRenewalAlerts(settings.renewal_alert_days);
      report = inspectAgyHealth(paths, db.listAccounts(), alerts);
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return report.summary.issues > 0 ? 1 : 0;
  }

  console.log(
    `Sức khỏe phiên agy: ${report.summary.healthy} khỏe mạnh • ${report.summary.needs_refresh} chờ refresh • ` +
      `${report.summary.missing_snapshot} chưa lưu • ${report.summary.issues} lỗi • ` +
      `Mã hóa AES-256-GCM: ${report.summary.encrypted}/${report.summary.encrypted + report.summary.unencrypted}`,
  );
  if (report.summary.unencrypted > 0) {
    console.log(`Gợi ý: Có ${report.summary.unencrypted} snapshot chưa mã hóa — chạy "gpool agy-encrypt" để bảo vệ bằng AES-256-GCM.`);
  }
  console.log(
    `Keychain hiện tại: ${report.live_owner_alias ?? (report.keychain_present ? 'có phiên (chưa khớp pool)' : 'trống')}` +
      (report.running_clients.length > 0 ? ` • Đang chạy: ${report.running_clients.join(', ')}` : ''),
  );
  if (report.lease) {
    console.log(
      `Khóa agy.lock: ${report.lease.stale ? 'STALE (đã cũ)' : 'ĐANG GIỮ'} — holder=${report.lease.holder}, acc=${report.lease.alias}, PID=${report.lease.pid}`,
    );
  }
  if (report.accounts.length > 0) {
    console.log(`\n  ${pad('ALIAS', 18)} ${pad('SỨC KHỎE', 18)} ${pad('REFRESH', 9)} ${pad('HẠN TOKEN', 22)} GHI CHÚ`);
    for (const acc of report.accounts) {
      const liveMark = acc.is_live ? '*' : ' ';
      const exp = acc.token_expiry ? acc.token_expiry.slice(0, 19).replace('T', ' ') : '-';
      const rt = acc.captured ? (acc.has_refresh_token ? 'có' : 'không') : '-';
      console.log(
        `${liveMark} ${pad(acc.alias, 18)} ${pad(acc.health, 18)} ${pad(rt, 9)} ${pad(exp, 22)} ${acc.detail}`,
      );
    }
  }
  if (report.renewal_alerts.length > 0) {
    console.log('\nCảnh báo ngày gia hạn gói:');
    for (const alert of report.renewal_alerts) {
      const when = alert.days_left <= 0 ? `QUÁ HẠN (${alert.days_left} ngày)` : `còn ${alert.days_left} ngày`;
      console.log(`  ! ${alert.alias} (${alert.plan_tier}) — gia hạn ${alert.renewal_date} (${when})`);
    }
  }
  return report.summary.issues > 0 ? 1 : 0;
}

async function handleAgyLock(args: string[], paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  const sub = (args[0] ?? 'status').toLowerCase();
  if (sub === 'status') {
    const lease: AgyLeaseInfo | null = (await isDaemonAlive(port))
      ? (await callDaemon<{ lease: AgyLeaseInfo | null }>(port, '/api/agy/lease')).lease
      : readAgyLease(paths);
    if (asJson) {
      console.log(JSON.stringify({ ok: true, lease }, null, 2));
    } else if (!lease) {
      console.log('Không có tiến trình nào đang giữ khóa agy.lock (sẵn sàng).');
    } else {
      console.log(
        `agy.lock: ${lease.stale ? 'STALE (có thể tự thu hồi)' : 'ĐANG KHÓA'} — holder="${lease.holder}", acc="${lease.alias}", PID=${lease.pid}, hết hạn=${lease.expires_at}`,
      );
    }
    return 0;
  }

  if (sub === 'unlock' || sub === 'release' || sub === 'clear') {
    const released = (await isDaemonAlive(port))
      ? (await callDaemon<{ released: boolean }>(port, '/api/agy/lease', { method: 'DELETE' })).released
      : releaseAgyLease(paths, { force: true });
    if (asJson) {
      console.log(JSON.stringify({ ok: true, released }, null, 2));
    } else {
      console.log(released ? 'Đã mở khóa agy.lock.' : 'Không có file agy.lock để xóa.');
    }
    return 0;
  }

  throw new Error('Cú pháp: gpool agy-lock <status|unlock> [--json]');
}

async function handleAgyEncrypt(paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  let res: AgyEncryptMigrationResult;
  if (await isDaemonAlive(port)) {
    res = await callDaemon<AgyEncryptMigrationResult>(port, '/api/agy/encrypt', { method: 'POST' });
  } else {
    res = migrateSessionsToEncrypted(paths);
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return res.failed.length > 0 ? 1 : 0;
  }

  console.log(
    `Mã hóa kho phiên agy (AES-256-GCM + macOS Keychain master key): ` +
      `mới mã hóa ${res.encrypted.length}, đã mã hóa sẵn ${res.already_encrypted.length}, lỗi ${res.failed.length}.`,
  );
  if (res.encrypted.length > 0) {
    console.log(`  Đã nâng cấp: ${res.encrypted.join(', ')}`);
  }
  for (const f of res.failed) {
    console.error(`  Lỗi (${f.alias}): ${f.error}`);
  }
  return res.failed.length > 0 ? 1 : 0;
}

async function handleAgyOnboard(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
): Promise<number> {
  const alias = args[0] ?? getStrFlag(flags, 'alias');
  const includeAll = Boolean(flags.get('all'));
  const timeoutRaw = getStrFlag(flags, 'timeout');
  const loginCmdRaw = getStrFlag(flags, 'login-cmd');

  let loginCommand: { bin: string; args: string[] } | null = null;
  if (loginCmdRaw && loginCmdRaw.trim()) {
    const parts = loginCmdRaw.trim().split(/\s+/);
    loginCommand = { bin: parts[0], args: parts.slice(1) };
  }

  const db = new PoolDB(paths);
  try {
    await runAgyOnboardWizard({
      db,
      paths,
      alias,
      includeAll,
      loginCommand,
      timeoutSeconds: timeoutRaw ? Number(timeoutRaw) : 180,
      onAccountCaptured: async () => {
        if (await isDaemonAlive(port)) {
          await fetch(`http://${DEFAULT_HOST}:${port}/api/sync`, {
            method: 'POST',
            headers: daemonAuthHeaders(paths),
          }).catch(() => {});
        }
      },
    });
  } finally {
    db.close();
  }
  return 0;
}

async function handleStats(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const daysRaw = getStrFlag(flags, 'days');
  const days = daysRaw ? Number(daysRaw) : 7;

  let report: PoolAnalyticsReport;
  if (await isDaemonAlive(port)) {
    report = await callDaemon<PoolAnalyticsReport>(port, `/api/analytics?days=${encodeURIComponent(String(days))}`);
  } else {
    const db = new PoolDB(paths);
    try {
      report = computePoolAnalytics(db, paths, { days });
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    return 0;
  }

  const s = report.summary;
  console.log(`=== Thống kê & Hiệu suất Pool (${report.window_days} ngày gần đây) ===`);
  console.log(
    `Sẵn sàng: ${s.ready_accounts}/${s.total_accounts} (${s.availability_percent}%)  •  ` +
      `Cooldown: ${s.cooldown_accounts}  •  Cần login: ${s.needs_login_accounts}`,
  );
  console.log(
    `Phiên agy đã lưu: ${s.agy_captured_accounts}/${s.total_accounts} (Mã hóa AES-256: ${s.agy_encrypted_accounts})`,
  );
  console.log(
    `Tổng lượt switch: ${s.total_switches}  •  Lượt nạp agy: ${s.total_agy_activations}  •  ` +
      `Đụng quota (${report.window_days}n / tổng): ${s.quota_hits_window} / ${s.quota_hits_total}` +
      (s.switches_per_quota_hit !== null ? `  •  TB ${s.switches_per_quota_hit} lượt/quota hit` : ''),
  );

  console.log('\nHoạt động theo ngày (Switch + Nạp agy | Đụng quota):');
  const maxVal = Math.max(1, ...report.daily.map((d) => d.switches + d.agy_activations + d.quota_hits));
  for (const d of report.daily) {
    const ops = d.switches + d.agy_activations;
    const barLen = Math.round((ops / maxVal) * 24);
    const bar = '█'.repeat(barLen) + '░'.repeat(Math.max(0, 24 - barLen));
    const qBar = d.quota_hits > 0 ? `  [quota: ${'▲'.repeat(Math.min(10, d.quota_hits))} ${d.quota_hits}]` : '';
    console.log(`  ${d.date.slice(5)}  ${bar}  ${String(ops).padStart(3)} lượt${qBar}`);
  }

  if (report.accounts.length > 0) {
    console.log(`\n  ${pad('ALIAS', 18)} ${pad('GÓI', 16)} ${pad('LƯỢT DÙNG', 10)} ${pad('QUOTA(7N)', 10)} ${pad('MÃ HÓA', 10)} TRẠNG THÁI`);
    for (const a of report.accounts) {
      const encTxt = !a.agy_captured ? '-' : a.agy_encrypted ? 'AES-256' : 'plain';
      console.log(
        `  ${pad(a.alias, 18)} ${pad(a.plan_tier, 16)} ${pad(String(a.use_count), 10)} ${pad(String(a.quota_hits_window), 10)} ${pad(encTxt, 10)} ${a.effective_state}`,
      );
    }
  }
  return 0;
}

async function handleAuth(
  args: string[],
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  let [alias, oauthUrl] = args;
  if (!alias) throw new Error('Cú pháp: gpool auth <alias> [oauth-url]');

  if (!oauthUrl) {
    oauthUrl = await readClipboardText();
    if (!oauthUrl) {
      throw new Error('Không thấy link OAuth trong tham số hoặc clipboard. Copy link OAuth từ agy rồi chạy lại.');
    }
  }

  if (await isDaemonAlive(port)) {
    const res = await callDaemon<{ ok: boolean; alias: string; url: string }>(
      port,
      `/api/accounts/${encodeURIComponent(alias)}/oauth`,
      {
        method: 'POST',
        body: JSON.stringify({ oauthUrl }),
      },
    );
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`Đã mở link OAuth trong Chrome profile "${res.alias}".`);
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const switcher = new PoolSwitcher({ db, paths });
    const res = await switcher.openOAuthInAccount(alias, oauthUrl);
    if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    else console.log(`Đã mở link OAuth trong Chrome profile "${res.alias}".`);
    return 0;
  } finally {
    db.close();
  }
}

async function handleAgyCapture(args: string[], paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool agy-capture <alias>');

  let res: AgyCaptureResult;
  if (await isDaemonAlive(port)) {
    res = await callDaemon<AgyCaptureResult>(port, `/api/accounts/${encodeURIComponent(alias)}/agy-capture`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      const account = db.getAccount(alias);
      if (!account) throw new Error(`Không tìm thấy tài khoản "${alias}".`);
      res = captureAgySession(paths, account, { encrypt: process.platform === 'darwin' });
      db.addEvent(
        account.id,
        account.alias,
        'agy_session_captured',
        `Đã lưu phiên đăng nhập agy của ${account.alias}${res.encrypted ? ' (AES-256-GCM)' : ''}`,
      );
    } finally {
      db.close();
    }
  }

  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`Đã lưu phiên agy hiện tại vào "${res.alias}"${res.detected_email ? ` (${res.detected_email})` : ''}.`);
    console.log('Từ giờ có thể đổi tức thì bằng "gpool agy-activate" hoặc "gpool run <alias> -- agy".');
    if (res.warning) console.error(`Cảnh báo: ${res.warning}`);
  }
  return 0;
}

async function handleAgyActivate(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias] = args;
  if (!alias) throw new Error('Cú pháp: gpool agy-activate <alias> [--force]');
  const force = Boolean(flags.get('force'));

  let res: AgyActivateResult;
  if (await isDaemonAlive(port)) {
    res = await callDaemon<AgyActivateResult>(port, `/api/accounts/${encodeURIComponent(alias)}/agy-activate`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      const account = db.getAccount(alias);
      if (!account) throw new Error(`Không tìm thấy tài khoản "${alias}".`);
      res = activateAgySession(paths, account, { force });
      const extra = res.recaptured_alias ? ` (đã cập nhật lại snapshot của "${res.recaptured_alias}")` : '';
      db.addEvent(account.id, account.alias, 'agy_session_activated', `Đã nạp phiên agy của ${account.alias} vào Keychain${extra}`);
    } finally {
      db.close();
    }
  }

  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`Đã nạp phiên agy của "${res.alias}" vào Keychain — mở lại agy là đang đúng tài khoản này (không cần đăng nhập lại).`);
    if (res.recaptured_alias) console.log(`Đã đồng thời cập nhật snapshot mới cho "${res.recaptured_alias}" (token vừa được refresh).`);
    if (res.orphan_saved) console.log('Phiên keychain vừa bị ghi đè không khớp acc nào trong pool — đã lưu dự phòng vào agy-sessions/_orphan.json.');
  }
  return 0;
}

async function handleAgyStatus(paths: PoolPaths, port: number, asJson: boolean): Promise<number> {
  let res: AgyStatusResult;
  if (await isDaemonAlive(port)) {
    res = await callDaemon<AgyStatusResult>(port, '/api/agy/status');
  } else {
    res = getAgySessionStatus(paths);
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }

  console.log(`Keychain agy ("gemini"/"antigravity"): ${res.keychain_present ? 'có phiên' : 'trống'}`);
  if (res.keychain_present) {
    console.log(`Chủ phiên hiện tại: ${res.live_owner_alias ?? (res.live_unknown ? 'không rõ (chưa capture)' : 'không rõ')}`);
  }
  if (res.running_clients.length > 0) {
    console.log(`Đang chạy: ${res.running_clients.join('; ')}`);
  }
  console.log(`Marker activate gần nhất: ${res.marker_alias ?? '-'}`);
  if (res.sessions.length === 0) {
    console.log('Chưa có phiên nào được lưu. Đăng nhập agy rồi chạy "gpool agy-capture <alias>".');
  } else {
    console.log(`\n  ${pad('ALIAS', 14)} ${pad('EMAIL PHÁT HIỆN', 30)} ${pad('CAPTURED', 26)} LIVE`);
    for (const s of res.sessions) {
      console.log(`  ${pad(s.alias, 14)} ${pad(s.detected_email ?? '-', 30)} ${pad(s.captured_at, 26)} ${s.is_live ? '*' : ''}`);
    }
  }
  return 0;
}

async function handleCooldown(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias, durationArg] = args;
  if (!alias || !durationArg) {
    throw new Error('Cú pháp: gpool cooldown <alias> <hours|clear> [--bucket all|pro|claude|flash] [--reason "..."]');
  }

  const isClear = durationArg.toLowerCase() === 'clear' || durationArg === '0';
  const reason = getStrFlag(flags, 'reason') ?? '';
  const bucket = getStrFlag(flags, 'bucket');
  const bucketTag = bucket && bucket !== 'all' ? ` [${bucket}]` : '';

  if (await isDaemonAlive(port)) {
    const bucketQs = bucket ? `?bucket=${encodeURIComponent(bucket)}` : '';
    const res = isClear
      ? await callDaemon<{ ok: boolean; account: AccountView }>(
          port,
          `/api/accounts/${encodeURIComponent(alias)}/cooldown${bucketQs}`,
          { method: 'DELETE' },
        )
      : await callDaemon<{ ok: boolean; account: AccountView }>(
          port,
          `/api/accounts/${encodeURIComponent(alias)}/cooldown`,
          {
            method: 'POST',
            body: JSON.stringify({ hours: Number(durationArg), reason, ...(bucket ? { bucket } : {}) }),
          },
        );
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(
        isClear
          ? `Đã gỡ cooldown${bucketTag} cho "${res.account.alias}".`
          : `Đã đặt cooldown${bucketTag} ${durationArg}h cho "${res.account.alias}".`,
      );
    }
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    let updated;
    if (isClear) {
      updated = db.clearCooldown(alias, bucket);
    } else {
      const hours = Number(durationArg);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error('Số giờ cooldown phải lớn hơn 0 (hoặc dùng "clear").');
      }
      const untilIso = new Date(Date.now() + hours * 3_600_000).toISOString();
      updated = bucket ? db.setBucketCooldown(alias, bucket, untilIso, reason) : db.setCooldown(alias, untilIso, reason);
    }
    const view = db.computeAccountView(updated, isAccountChromeRunning(updated).running);
    if (asJson) console.log(JSON.stringify({ ok: true, account: view }, null, 2));
    else {
      console.log(
        isClear
          ? `Đã gỡ cooldown${bucketTag} cho "${view.alias}".`
          : `Đã đặt cooldown${bucketTag} ${durationArg}h cho "${view.alias}".`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

async function handleCheck(
  args: string[],
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [alias] = args;

  if (await isDaemonAlive(port)) {
    if (alias) {
      const res = await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/check`, { method: 'POST' });
      if (asJson) console.log(JSON.stringify(res, null, 2));
      else {
        const r = (res as { result: { alias: string; status: string; detail: string } }).result;
        console.log(`${r.alias}: ${r.status} — ${r.detail}`);
      }
      return 0;
    }
    const res = await callDaemon(port, '/api/keepalive/sweep', { method: 'POST' });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else {
      for (const r of (res as { results: Array<{ alias: string; status: string; detail: string }> }).results) {
        console.log(`${r.alias}: ${r.status} — ${r.detail}`);
      }
    }
    return 0;
  }

  const db = new PoolDB(paths);
  try {
    const scheduler = new KeepAliveScheduler({ db, staggerDelayMs: 500 });
    if (alias) {
      const res = await scheduler.probeAccount(alias);
      if (asJson) console.log(JSON.stringify({ ok: true, result: res }, null, 2));
      else console.log(`${res.alias}: ${res.status} — ${res.detail}`);
      return 0;
    }
    const results = await scheduler.sweepAll();
    if (asJson) console.log(JSON.stringify({ ok: true, results }, null, 2));
    else {
      for (const r of results) {
        console.log(`${r.alias}: ${r.status} — ${r.detail}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function handleIsolate(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const isolateAll = Boolean(flags.get('all'));
  const [alias] = args;

  if (isolateAll) {
    let res: { ok: boolean; count: number; isolated: AccountView[] };
    if (await isDaemonAlive(port)) {
      res = await callDaemon(port, '/api/accounts/isolate-all', { method: 'POST' });
    } else {
      const db = new PoolDB(paths);
      try {
        const switcher = new PoolSwitcher({ db, paths });
        res = { ok: true, ...switcher.isolateAllLinked() };
      } finally {
        db.close();
      }
    }

    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.count === 0) {
      console.log('Không có tài khoản nào đang ở chế độ Link để tách.');
    } else {
      console.log(`Đã tách ${res.count} tài khoản sang các Chrome profile riêng độc lập:`);
      for (const acc of res.isolated) {
        console.log(`  - ${acc.alias} (${acc.email}) -> ${acc.chrome_profile_dir}`);
      }
      console.log('Chạy "gpool login-wizard" hoặc mở Web Dashboard để đăng nhập nối tiếp từng tài khoản 1 lần.');
    }
    return 0;
  }

  if (!alias) throw new Error('Cú pháp: gpool isolate <alias | --all> [--no-open] [--json]');
  const openChrome = !Boolean(flags.get('no-open'));

  let res: { ok: boolean; account: AccountView; openedChrome: boolean; openedUrl: string | null };
  if (await isDaemonAlive(port)) {
    res = await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/isolate`, {
      method: 'POST',
      body: JSON.stringify({ openChrome }),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      const switcher = new PoolSwitcher({ db, paths });
      const isolated = await switcher.isolateAccount(alias, { openChrome });
      res = { ok: true, ...isolated };
    } finally {
      db.close();
    }
  }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(
      `Đã tách "${res.account.alias}" (${res.account.email}) sang Chrome profile độc lập (${res.account.chrome_profile_dir}).`,
    );
    if (res.openedChrome) {
      console.log('Đã mở cửa sổ Chrome mới — hãy đăng nhập tài khoản này 1 lần để kích hoạt Keep-Alive riêng.');
    }
  }
  return 0;
}

async function handleImportChrome(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const mode: ProfileMode = Boolean(flags.get('isolated')) ? 'isolated' : 'linked';
  const dryRun = Boolean(flags.get('dry-run'));
  const planTier = (getStrFlag(flags, 'plan') as PlanTier | undefined) ?? 'Google AI Pro';
  const tags = getStrFlag(flags, 'tags')?.split(',').map((t) => t.trim()).filter(Boolean) ?? ['pro'];

  let discovered;
  if (await isDaemonAlive(port)) {
    discovered = await callDaemon<{
      profiles: ReturnType<typeof discoverBrowserProfiles>['profiles'];
      discoveredAccounts: ReturnType<typeof discoverBrowserProfiles>['discoveredAccounts'];
      warnings?: ReturnType<typeof discoverBrowserProfiles>['warnings'];
      permissionBlocked?: boolean;
    }>(port, '/api/import/chrome/discover');
  } else {
    const db = new PoolDB(paths);
    try {
      const existing = db.listAccounts();
      discovered = discoverBrowserProfiles({
        existingEmails: new Set(existing.map((a) => a.email.toLowerCase())),
        existingAliases: new Set(existing.map((a) => a.alias.toLowerCase())),
      });
    } finally {
      db.close();
    }
  }

  if (dryRun) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...discovered }, null, 2));
    } else {
      if (discovered.warnings && discovered.warnings.length > 0) {
        for (const w of discovered.warnings) {
          console.error(`Cảnh báo (${w.browser}): ${w.message}`);
        }
      }
      console.log(`Tìm thấy ${discovered.profiles.length} profile, ${discovered.discoveredAccounts.length} tài khoản:`);
      for (const acc of discovered.discoveredAccounts) {
        const mark = acc.alreadyInPool ? '[đã có]' : `[mới -> ${acc.suggestedAlias}]`;
        console.log(`  - ${acc.email} (${acc.browser} / ${acc.profileName}) ${mark}`);
      }
    }
    return 0;
  }

  const toImport: BulkImportItemInput[] = discovered.discoveredAccounts
    .filter((a) => !a.alreadyInPool)
    .map((a) => ({
      alias: a.suggestedAlias,
      email: a.email,
      display_name: a.fullName,
      plan_tier: planTier,
      tags,
      chrome_user_data_dir: a.userDataDir,
      chrome_profile_name: a.profileName,
      google_authuser: a.email,
      has_cookies: a.hasCookies,
    }));

  if (toImport.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, created: [], skipped: [], errors: [], discovered }, null, 2));
    } else {
      if (discovered.warnings && discovered.warnings.length > 0) {
        for (const w of discovered.warnings) {
          console.error(`Cảnh báo (${w.browser}): ${w.message}`);
        }
      }
      console.log(
        discovered.discoveredAccounts.length === 0
          ? 'Không tự phát hiện được email nào trong metadata Chrome/Brave. Dùng "gpool import-clipboard" sau khi ⌘A ⌘C trên https://accounts.google.com/SignOutOptions hoặc "gpool import-emails".'
          : 'Tất cả tài khoản phát hiện được từ Chrome/Brave đều đã có sẵn trong pool.',
      );
    }
    return 0;
  }

  const result = await executeBulkImport(
    { mode, plan_tier: planTier, tags, items: toImport },
    paths,
    port,
  );

  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `Đã nhập từ Chrome (${mode}): thêm ${result.created.length}, bỏ qua ${result.skipped.length}, lỗi ${result.errors.length}.`,
    );
    for (const acc of result.created) {
      console.log(`  + ${acc.alias} (${acc.email}) [${acc.profile_mode}]`);
    }
  }
  return 0;
}

async function handleImportEmails(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const inlineEmails = getStrFlag(flags, 'emails');
  const [filePath] = args;

  let rawText = inlineEmails ?? '';
  if (!rawText && filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Không tìm thấy file "${filePath}".`);
    }
    rawText = fs.readFileSync(filePath, 'utf8');
  }

  if (!rawText.trim()) {
    throw new Error(
      'Cú pháp: gpool import-emails <file.txt> [--profile "Default"] [--tags pro] OR gpool import-emails --emails "a@gmail.com,b@gmail.com"',
    );
  }

  return await importFreeformText(rawText, flags, paths, port, asJson);
}

async function handleImportClipboard(
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const rawText = await readClipboardText();
  if (!rawText.trim()) {
    throw new Error('Clipboard đang trống. Hãy mở https://accounts.google.com/SignOutOptions, nhấn ⌘A ⌘C rồi chạy lại.');
  }
  return await importFreeformText(rawText, flags, paths, port, asJson);
}

async function importFreeformText(
  rawText: string,
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const mode: ProfileMode = Boolean(flags.get('isolated')) ? 'isolated' : 'linked';
  const dryRun = Boolean(flags.get('dry-run'));
  const profileName = getStrFlag(flags, 'profile') ?? 'Default';
  const browserPref = (getStrFlag(flags, 'browser') ?? 'chrome').toLowerCase();
  const explicitUserDataDir = getStrFlag(flags, 'user-data-dir');
  const planTier = (getStrFlag(flags, 'plan') as PlanTier | undefined) ?? 'Google AI Pro';
  const tags = getStrFlag(flags, 'tags')?.split(',').map((t) => t.trim()).filter(Boolean) ?? ['pro'];

  const roots = getDefaultBrowserRoots();
  const chosenRoot =
    browserPref === 'brave'
      ? roots.find((r) => r.browser.toLowerCase().includes('brave')) ?? roots[0]
      : roots[0];
  const userDataDir = explicitUserDataDir ? path.resolve(explicitUserDataDir) : chosenRoot.userDataDir;

  const parsedItems = extractEmailsFromText(rawText);
  if (parsedItems.length === 0) {
    throw new Error('Không tìm thấy email hợp lệ nào trong nội dung đã nhập.');
  }

  if (dryRun) {
    if (asJson) {
      console.log(JSON.stringify({ ok: true, extracted: parsedItems }, null, 2));
    } else {
      console.log(`Trích xuất được ${parsedItems.length} email:`);
      for (const item of parsedItems) {
        console.log(`  - ${item.alias}: ${item.email}${item.display_name ? ` (${item.display_name})` : ''}`);
      }
    }
    return 0;
  }

  const items: BulkImportItemInput[] = parsedItems.map((item) => ({
    alias: item.alias,
    email: item.email,
    display_name: item.display_name ?? '',
    notes: item.notes ?? '',
    plan_tier: planTier,
    tags,
    chrome_user_data_dir: mode === 'linked' ? userDataDir : null,
    chrome_profile_name: mode === 'linked' ? profileName : null,
    google_authuser: mode === 'linked' ? item.email : null,
  }));

  const result = await executeBulkImport(
    {
      mode,
      chrome_user_data_dir: mode === 'linked' ? userDataDir : null,
      chrome_profile_name: mode === 'linked' ? profileName : null,
      plan_tier: planTier,
      tags,
      items,
    },
    paths,
    port,
  );

  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `Đã nhập danh sách email (${mode}${mode === 'linked' ? ` • ${profileName}` : ''}): thêm ${result.created.length}, bỏ qua ${result.skipped.length}, lỗi ${result.errors.length}.`,
    );
    for (const acc of result.created) {
      console.log(`  + ${acc.alias} (${acc.email})`);
    }
  }
  return 0;
}

async function executeBulkImport(
  payload: {
    mode: ProfileMode;
    chrome_user_data_dir?: string | null;
    chrome_profile_name?: string | null;
    plan_tier?: PlanTier;
    tags?: string[];
    items: BulkImportItemInput[];
  },
  paths: PoolPaths,
  port: number,
): Promise<BulkImportResult> {
  if (await isDaemonAlive(port)) {
    return await callDaemon<BulkImportResult>(port, '/api/import/chrome', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  const db = new PoolDB(paths);
  try {
    const existing = db.listAccounts();
    const existingEmails = new Set(existing.map((a) => a.email.toLowerCase()));
    const existingAliases = new Set(existing.map((a) => a.alias.toLowerCase()));
    const defaultUserDataDir = getDefaultBrowserRoots()[0].userDataDir;

    const created: AccountView[] = [];
    const skipped: Array<{ email: string; reason: string }> = [];
    const errors: Array<{ email: string; error: string }> = [];

    for (const item of payload.items) {
      let email: string;
      try {
        email = validateEmail(item.email);
      } catch (err) {
        errors.push({ email: item.email, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      if (existingEmails.has(email)) {
        skipped.push({ email, reason: 'Email đã có trong pool' });
        continue;
      }

      let alias: string;
      if (item.alias?.trim()) {
        try {
          const candidate = validateAlias(item.alias);
          if (existingAliases.has(candidate)) {
            alias = generateUniqueAlias(email, existingAliases);
          } else {
            existingAliases.add(candidate);
            alias = candidate;
          }
        } catch {
          alias = generateUniqueAlias(email, existingAliases);
        }
      } else {
        alias = generateUniqueAlias(email, existingAliases);
      }

      const userDataDir = (item.chrome_user_data_dir ?? payload.chrome_user_data_dir ?? defaultUserDataDir).trim();
      const rawProfileName = (item.chrome_profile_name ?? payload.chrome_profile_name ?? 'Default').trim() || 'Default';
      let profileName: string;
      try {
        profileName = validateChromeProfileName(rawProfileName);
      } catch (err) {
        errors.push({ email, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      let hasCookies = false;
      if (typeof item.has_cookies === 'boolean') {
        hasCookies = item.has_cookies;
      } else {
        const cookiePath = path.join(path.resolve(userDataDir), profileName, 'Cookies');
        try {
          fs.statSync(cookiePath);
          hasCookies = true;
        } catch (statErr) {
          const code = (statErr as NodeJS.ErrnoException)?.code;
          hasCookies = code === 'EPERM' || code === 'EACCES';
        }
      }

      try {
        const rec = db.createAccount({
          alias,
          email,
          display_name: item.display_name ?? '',
          plan_tier: item.plan_tier ?? payload.plan_tier ?? 'Google AI Pro',
          renewal_date: item.renewal_date ?? null,
          tags: item.tags ?? payload.tags ?? ['pro'],
          notes: item.notes ?? '',
          proxy_url: item.proxy_url ?? null,
          profile_mode: payload.mode,
          chrome_user_data_dir: payload.mode === 'linked' ? userDataDir : null,
          chrome_profile_name: payload.mode === 'linked' ? profileName : null,
          google_authuser: payload.mode === 'linked' ? (item.google_authuser?.trim() || email) : null,
          initial_session_status: payload.mode === 'linked' && hasCookies ? 'live' : 'unknown',
          initial_session_detail:
            payload.mode === 'linked'
              ? hasCookies
                ? `Liên kết trực tiếp Chrome (${profileName}) — sẵn sàng dùng ngay`
                : `Chế độ Link (${profileName}) — hãy mở Chrome để đăng nhập Google`
              : 'Đã nhập vào pool — bấm "Đăng nhập Chrome" để xác nhận 1 lần',
        });
        existingEmails.add(email);
        created.push(db.computeAccountView(rec, isAccountChromeRunning(rec).running));
      } catch (err) {
        errors.push({ email, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { created, skipped, errors };
  } finally {
    db.close();
  }
}

async function handleRun(
  args: string[],
  passthrough: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
): Promise<number> {
  const [alias] = args;
  const cmdParts = passthrough.length > 0 ? passthrough : args.slice(1);
  if (!alias || cmdParts.length === 0) {
    throw new Error('Cú pháp: gpool run <alias> -- <command...>');
  }

  const db = new PoolDB(paths);
  let officialEnv: ReturnType<PoolSwitcher['buildOfficialRunEnv']>;
  let agyActivated = false;
  try {
    const account = db.getAccount(alias);
    if (!account) throw new Error(`Không tìm thấy tài khoản "${alias}".`);

    if (path.basename(cmdParts[0]).toLowerCase() === 'agy' && hasSessionSnapshot(paths, account.alias)) {
      const res = activateAgySession(paths, account, { force: Boolean(flags.get('force')) });
      agyActivated = true;
      console.error(
        `Đã nạp phiên agy của "${account.alias}" vào Keychain` +
          (res.recaptured_alias ? ` (đã cập nhật lại snapshot của "${res.recaptured_alias}")` : '') +
          '.',
      );
      db.addEvent(account.id, account.alias, 'agy_session_activated', `gpool run nạp phiên agy cho ${account.alias}`);
    }

    const switcher = new PoolSwitcher({ db, paths });
    officialEnv = switcher.buildOfficialRunEnv(account, cmdParts[0]);
  } finally {
    db.close();
  }

  if (officialEnv.warning && !agyActivated) {
    console.error(officialEnv.warning);
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(cmdParts[0], cmdParts.slice(1), {
      env: officialEnv.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 0));
  });
}

async function handleDaemon(
  args: string[],
  _flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const sub = args[0] ?? 'status';

  if (sub === 'run') {
    const db = new PoolDB(paths);
    let serverHandle: ReturnType<typeof createDaemonServer> | null = null;
    const scheduler = new KeepAliveScheduler({
      db,
      onUpdate: (eventType, payload) => {
        if (serverHandle) {
          serverHandle.broadcast('keepalive_event', { eventType, payload });
          serverHandle.broadcastSnapshot();
        }
      },
    });
    const switcher = new PoolSwitcher({ db, paths });
    serverHandle = createDaemonServer({ db, switcher, keepalive: scheduler, paths, host: DEFAULT_HOST, port });

    const actualPort = await serverHandle.start();
    scheduler.start();
    writeFileRestricted(paths.pidPath, String(process.pid));

    console.log(`Google One Pool daemon đang chạy tại http://${DEFAULT_HOST}:${actualPort} (PID ${process.pid})`);

    const shutdown = async () => {
      scheduler.stop();
      await serverHandle?.stop();
      try {
        if (fs.existsSync(paths.pidPath)) fs.unlinkSync(paths.pidPath);
      } catch {
        // Ignore.
      }
      db.close();
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    await new Promise(() => {});
    return 0;
  }

  if (sub === 'start') {
    if (await isDaemonAlive(port)) {
      if (asJson) console.log(JSON.stringify({ ok: true, alreadyRunning: true, port }));
      else console.log(`Daemon đang chạy sẵn tại http://${DEFAULT_HOST}:${port}`);
      return 0;
    }

    fs.mkdirSync(paths.homeDir, { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(paths.logPath, 'a', 0o600);
    const cliEntry = path.resolve(import.meta.dirname, '..', 'bin', 'gpool.ts');
    const child = spawn(process.execPath, [cliEntry, 'daemon', 'run', '--port', String(port)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, GPOOL_HOME: paths.homeDir, GPOOL_PORT: String(port) },
    });
    child.unref();
    fs.closeSync(logFd);

    for (let i = 0; i < 30; i += 1) {
      if (await isDaemonAlive(port)) {
        if (asJson) console.log(JSON.stringify({ ok: true, pid: child.pid, port }));
        else console.log(`Đã khởi động daemon (PID ${child.pid}) tại http://${DEFAULT_HOST}:${port}`);
        return 0;
      }
      await sleep(150);
    }

    throw new Error(`Daemon không phản hồi sau khi khởi động. Kiểm tra log tại ${paths.logPath}`);
  }

  if (sub === 'stop') {
    if (!fs.existsSync(paths.pidPath)) {
      console.log('Daemon không có PID file (có thể chưa chạy).');
      return 0;
    }
    const pid = Number(fs.readFileSync(paths.pidPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.unlinkSync(paths.pidPath);
      console.log('Đã dọn PID file không hợp lệ.');
      return 0;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        fs.unlinkSync(paths.pidPath);
        console.log('Daemon đã dừng từ trước (đã dọn PID file).');
        return 0;
      }
      throw err;
    }

    for (let i = 0; i < 20; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        if (fs.existsSync(paths.pidPath)) fs.unlinkSync(paths.pidPath);
        console.log(`Đã dừng daemon (PID ${pid}).`);
        return 0;
      }
      await sleep(150);
    }

    throw new Error(`Đã gửi SIGTERM tới PID ${pid} nhưng tiến trình chưa thoát.`);
  }

  if (sub === 'status') {
    const alive = await isDaemonAlive(port);
    if (!alive) {
      if (asJson) console.log(JSON.stringify({ ok: false, running: false, port }));
      else console.log(`Daemon chưa chạy trên cổng ${port}.`);
      return 1;
    }
    const health = await callDaemon(port, '/api/health');
    if (asJson) console.log(JSON.stringify(health, null, 2));
    else console.log(`Daemon đang chạy: ${JSON.stringify(health)}`);
    return 0;
  }

  throw new Error('Cú pháp: gpool daemon <start|stop|status|run>');
}

async function handleDashboard(paths: PoolPaths, port: number): Promise<number> {
  if (!(await isDaemonAlive(port))) {
    await handleDaemon(['start'], new Map(), paths, port, false);
  }
  const baseUrl = `http://${DEFAULT_HOST}:${port}`;
  const token = readDaemonToken(paths);
  const openUrl = token ? `${baseUrl}/auth?token=${encodeURIComponent(token)}` : baseUrl;
  if (process.platform === 'darwin') {
    execFile('/usr/bin/open', [openUrl], () => {});
  }
  console.log(`Web Dashboard đang mở tại: ${baseUrl}`);
  return 0;
}

async function handleMenubar(args: string[], paths: PoolPaths, port: number): Promise<number> {
  const sub = args[0] ?? 'start';
  const rootDir = path.resolve(import.meta.dirname, '..');
  const scriptPath = path.join(rootDir, 'macos', 'build-menubar.sh');
  const appPath = path.join(rootDir, 'dist', 'GoogleOnePoolMenu.app');

  if (sub === 'build') {
    await execAsync('bash', [scriptPath]);
    console.log(`Đã build Menu Bar app tại ${appPath}`);
    return 0;
  }

  if (sub === 'start') {
    if (!fs.existsSync(appPath)) {
      await execAsync('bash', [scriptPath]);
    }
    if (!(await isDaemonAlive(port))) {
      await handleDaemon(['start'], new Map(), paths, port, false);
    }
    await execAsync('/usr/bin/open', ['-a', appPath]);
    console.log('Đã khởi chạy GoogleOnePoolMenu trên thanh Menu Bar macOS.');
    return 0;
  }

  if (sub === 'stop') {
    await new Promise<void>((resolve) => {
      execFile('/usr/bin/pkill', ['-x', 'GoogleOnePoolMenu'], () => resolve());
    });
    console.log('Đã đóng GoogleOnePoolMenu.');
    return 0;
  }

  throw new Error('Cú pháp: gpool menubar <build|start|stop>');
}

async function handleLaunchAgent(
  args: string[],
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const sub = args[0] ?? 'status';
  const cliEntryPath = path.resolve(import.meta.dirname, '..', 'bin', 'gpool.ts');

  if (sub === 'install') {
    const res = await installLaunchAgent({
      nodeBinary: process.execPath,
      cliEntryPath,
      paths,
      port,
    });
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(res.message);
    return 0;
  }

  if (sub === 'uninstall' || sub === 'remove') {
    const res = await uninstallLaunchAgent();
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(res.message);
    return 0;
  }

  if (sub === 'status') {
    const res = await getLaunchAgentStatus();
    if (asJson) console.log(JSON.stringify(res, null, 2));
    else console.log(`${res.detail} (${res.plistPath})`);
    return 0;
  }

  throw new Error('Cú pháp: gpool launchagent <install|uninstall|status>');
}

async function promptPassphrase(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Cần truyền --passphrase-file <file> hoặc biến môi trường GPOOL_BACKUP_PASSPHRASE khi chạy không tương tác.',
    );
  }
  return await new Promise<string>((resolve, reject) => {
    process.stderr.write(promptText);
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    const cleanup = () => {
      stdin.off('data', onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Đã hủy nhập mật khẩu.'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = Array.from(buf).slice(0, -1).join('');
          }
          continue;
        }
        if (ch >= ' ') {
          buf += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function resolveBackupPassphrase(flags: Map<string, string | boolean>, promptText: string): Promise<string> {
  const passFile = getStrFlag(flags, 'passphrase-file');
  if (passFile) {
    return fs.readFileSync(passFile, 'utf8').replace(/\r?\n$/, '');
  }
  const envPass = process.env.GPOOL_BACKUP_PASSPHRASE;
  if (envPass && envPass.length > 0) {
    return envPass;
  }
  const cliPass = getStrFlag(flags, 'passphrase');
  if (cliPass !== undefined) {
    console.error(
      'Cảnh báo bảo mật: --passphrase qua dòng lệnh có thể lưu trong shell history/ps. Hãy dùng --passphrase-file hoặc nhập tương tác.',
    );
    return cliPass;
  }
  return await promptPassphrase(promptText);
}

async function handleExport(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
): Promise<number> {
  const [outFile] = args;
  const withSessions = Boolean(flags.get('with-sessions'));
  const encrypted = Boolean(flags.get('encrypted')) || withSessions;

  if (encrypted) {
    const passphrase = await resolveBackupPassphrase(
      flags,
      `Nhập mật khẩu mã hóa backup (>= ${BACKUP_MIN_PASSPHRASE_LENGTH} ký tự): `,
    );

    let bundle: EncryptedBackupBundle;
    let sessionsCount = 0;
    if (await isDaemonAlive(port)) {
      const res = await callDaemon<{ ok: boolean; bundle: EncryptedBackupBundle; sessions_count: number }>(
        port,
        '/api/export/encrypted',
        {
          method: 'POST',
          body: JSON.stringify({ passphrase, withSessions }),
        },
      );
      bundle = res.bundle;
      sessionsCount = res.sessions_count;
    } else {
      const db = new PoolDB(paths);
      try {
        const metadata = db.exportMetadata({ includeSensitiveProxyCredentials: true });
        const sessions = withSessions ? exportDecryptedSessions(paths) : [];
        sessionsCount = sessions.length;
        bundle = encryptBackupBundle({ metadata, agy_sessions: sessions }, passphrase, withSessions);
      } finally {
        db.close();
      }
    }

    const text = JSON.stringify(bundle, null, 2);
    if (outFile) {
      writeFileRestricted(outFile, text);
      console.log(
        `Đã xuất backup mã hóa AES-256-GCM ra ${outFile}` +
          (withSessions ? ` (kèm ${sessionsCount} phiên agy).` : ' (chỉ metadata).'),
      );
    } else {
      console.log(text);
    }
    return 0;
  }

  let payload: PoolExportPayload;
  if (await isDaemonAlive(port)) {
    payload = await callDaemon<PoolExportPayload>(port, '/api/export');
  } else {
    const db = new PoolDB(paths);
    try {
      payload = db.exportMetadata();
    } finally {
      db.close();
    }
  }
  const text = JSON.stringify(payload, null, 2);
  if (outFile) {
    writeFileRestricted(outFile, text);
    console.log(`Đã xuất metadata ra ${outFile}`);
  } else {
    console.log(text);
  }
  return 0;
}

async function handleImport(
  args: string[],
  flags: Map<string, string | boolean>,
  paths: PoolPaths,
  port: number,
  asJson: boolean,
): Promise<number> {
  const [inFile] = args;
  if (!inFile) throw new Error('Cú pháp: gpool import <file.json> [--passphrase-file <file>]');
  const rawObj = JSON.parse(fs.readFileSync(inFile, 'utf8')) as unknown;

  if (isEncryptedBackupBundle(rawObj)) {
    const passphrase = await resolveBackupPassphrase(flags, 'Nhập mật khẩu giải mã file backup: ');

    let res: { created: number; updated: number; sessions_imported: number; sessions_encrypted: number };
    if (await isDaemonAlive(port)) {
      res = await callDaemon(port, '/api/import/encrypted', {
        method: 'POST',
        body: JSON.stringify({ passphrase, bundle: rawObj }),
      });
    } else {
      const decrypted = decryptBackupBundle<{
        metadata: PoolExportPayload;
        agy_sessions?: AgySessionSnapshot[];
      }>(rawObj, passphrase);
      const db = new PoolDB(paths);
      try {
        const metaRes = db.importMetadata(decrypted.metadata);
        let sessionsImported = 0;
        let sessionsEncrypted = 0;
        if (Array.isArray(decrypted.agy_sessions) && decrypted.agy_sessions.length > 0) {
          const sesRes = importSessionsFromBackup(paths, decrypted.agy_sessions, {
            encrypt: process.platform === 'darwin',
          });
          sessionsImported = sesRes.imported;
          sessionsEncrypted = sesRes.encrypted;
        }
        res = { ...metaRes, sessions_imported: sessionsImported, sessions_encrypted: sessionsEncrypted };
      } finally {
        db.close();
      }
    }

    if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
    else {
      console.log(
        `Đã khôi phục backup mã hóa: thêm ${res.created}, cập nhật ${res.updated} tài khoản` +
          (res.sessions_imported > 0
            ? `, khôi phục ${res.sessions_imported} phiên agy (${res.sessions_encrypted} đã mã hóa AES-256-GCM).`
            : '.'),
      );
    }
    return 0;
  }

  const payload = rawObj as PoolExportPayload;
  let res: { created: number; updated: number };
  if (await isDaemonAlive(port)) {
    res = await callDaemon<{ created: number; updated: number }>(port, '/api/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } else {
    const db = new PoolDB(paths);
    try {
      res = db.importMetadata(payload);
    } finally {
      db.close();
    }
  }
  if (asJson) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  else console.log(`Đã import metadata: thêm ${res.created}, cập nhật ${res.updated} tài khoản.`);
  return 0;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const dashDashIdx = argv.indexOf('--');
  const mainArgs = dashDashIdx >= 0 ? argv.slice(0, dashDashIdx) : argv;
  const passthrough = dashDashIdx >= 0 ? argv.slice(dashDashIdx + 1) : [];

  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < mainArgs.length; i += 1) {
    const token = mainArgs[i];
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx >= 0) {
        flags.set(token.slice(2, eqIdx), token.slice(eqIdx + 1));
      } else {
        const key = token.slice(2);
        const next = mainArgs[i + 1];
        if (next !== undefined && !next.startsWith('--') && !isBooleanFlag(key)) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
    } else if (token === '-h') {
      flags.set('help', true);
    } else if (token === '-q' && mainArgs[i + 1] !== undefined) {
      flags.set('q', mainArgs[i + 1]);
      i += 1;
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags, passthrough };
}

function isBooleanFlag(key: string): boolean {
  return (
    key === 'json' ||
    key === 'no-open' ||
    key === 'open' ||
    key === 'purge' ||
    key === 'help' ||
    key === 'isolated' ||
    key === 'all' ||
    key === 'dry-run' ||
    key === 'force' ||
    key === 'agy' ||
    key === 'auto-rotate' ||
    key === 'interactive' ||
    key === 'encrypted' ||
    key === 'with-sessions'
  );
}

function getStrFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const val = flags.get(key);
  return typeof val === 'string' ? val : undefined;
}

async function isDaemonAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function daemonAuthHeaders(paths: PoolPaths = resolvePaths()): Record<string, string> {
  const token = readDaemonToken(paths);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function callDaemon<T>(port: number, route: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...daemonAuthHeaders(),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://${DEFAULT_HOST}:${port}${route}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Daemon trả lỗi HTTP ${res.status}`);
  }
  return data as T;
}

async function readClipboardText(): Promise<string> {
  if (process.platform !== 'darwin') return '';
  return await new Promise<string>((resolve) => {
    execFile('/usr/bin/pbpaste', [], (err, stdout) => {
      if (err) resolve('');
      else resolve(stdout.trim());
    });
  });
}

function execAsync(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve();
    });
  });
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width - 1) + ' ' : text + ' '.repeat(width - text.length);
}

function formatShortMs(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}g${m}p` : `${h}g`;
  }
  return `${mins}p`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(locale: Locale = 'vi'): void {
  console.log(getMainHelpText(locale));
}

function printCommandHelp(locale: Locale, rawCmd: string): void {
  const doc = getCommandHelpText(locale, rawCmd);
  if (doc) {
    console.log(doc);
    return;
  }
  const fallback = COMMAND_HELP[rawCmd];
  if (fallback && locale === 'vi') {
    console.log(fallback);
    return;
  }
  console.log(
    pick(
      locale,
      `Không có hướng dẫn riêng cho "${rawCmd}".\n`,
      `No dedicated help found for "${rawCmd}".\n`,
    ),
  );
  printHelp(locale);
}

const COMMAND_HELP: Record<string, string> = {
  tui: `gpool tui (alias: gpool ui, hoặc chạy "gpool" không tham số)
Mở giao diện tương tác toàn màn hình (TUI) ngay trên Terminal.

Phím tắt chính trong TUI:
  ↑/↓ hoặc j/k   Chọn tài khoản (1-9 nhảy nhanh)
  Enter hoặc s   Chọn tài khoản làm active & mở Chrome (S = không mở Chrome)
  g              Tự nạp phiên agy rồi chạy thẳng lệnh "agy"
  a / c / A      Nạp phiên agy / Lưu phiên agy / Xem trạng thái Keychain agy
  n              Hết quota → đặt cooldown & xoay sang acc kế tiếp
  o / l / u      Mở Chrome / Đăng nhập Chrome / Mở link OAuth từ Clipboard
  x / p / P      Đặt hoặc gỡ Cooldown / Kiểm tra phiên 1 acc / Quét cả pool
  + / i / t      Thêm mới / Nhập từ Chrome-Clipboard / Tách profile riêng
  e / d          Sửa thông tin / Xóa tài khoản
  / / f          Tìm kiếm trực tiếp / Lọc theo trạng thái
  v / D / ? / q  Nhật ký hoạt động / Hệ thống (Daemon-Web-MenuBar) / Trợ giúp / Thoát`,

  add: `gpool add <alias> <email> [flags]
Thêm một tài khoản mới vào pool (mặc định tạo Chrome profile riêng độc lập).

Flags:
  --name "<tên>"           Tên hiển thị
  --plan "<gói>"           Google AI Pro (mặc định), Google AI Ultra, Free, Enterprise
  --renewal YYYY-MM-DD     Ngày gia hạn gói
  --tags a,b,c             Danh sách tag cách nhau bằng dấu phẩy
  --proxy <url>            Proxy riêng (http://, https://, socks4://, socks5://)
  --adc <path.json>        File Google Cloud ADC JSON (nếu dùng agy Enterprise/ADC)
  --notes "<ghi chú>"      Ghi chú cá nhân
  --json                   Xuất kết quả dạng JSON

Ví dụ:
  gpool add pro1 acc1@gmail.com --tags pro,chinh --renewal 2026-12-31 --notes "Acc chính"`,

  list: `gpool list (alias: ls) [--status <trạng thái>] [--tag <tag>] [-q <từ khóa>] [--json]
Hiển thị danh sách tài khoản trong pool.

Flags:
  --status <state>   active | ready | cooldown | needs_login | unknown | error
  --tag <tag>        Lọc theo tag
  -q <text>          Tìm theo alias, email, tên hiển thị, ghi chú, tag
  --json             Xuất JSON để dùng trong script

Ví dụ:
  gpool list --status ready --tag pro
  gpool list -q gmail --json`,

  show: `gpool show <alias> [--json] (alias: info)
Xem đầy đủ chi tiết một tài khoản (bao gồm đường dẫn profile, cooldown, trạng thái phiên agy).

Ví dụ:
  gpool show pro1`,

  edit: `gpool edit <alias> [flags]
Cập nhật thông tin tài khoản. Đổi --alias tự động đổi tên thư mục profile riêng và snapshot agy.

Flags:
  --alias <mới>       Đổi alias
  --email <mới>       Đổi email
  --name "<tên>"      Đổi tên hiển thị
  --plan "<gói>"      Đổi gói cước
  --renewal YYYY-MM-DD|""  Đặt hoặc xóa ngày gia hạn
  --tags a,b          Ghi đè danh sách tag
  --proxy <url>|""    Đặt hoặc gỡ proxy
  --adc <path>|""     Đặt hoặc gỡ file ADC
  --authuser <val>    Đổi authuser / login_hint (cho chế độ linked)
  --notes "<text>"    Cập nhật ghi chú`,

  rm: `gpool rm <alias> [--purge] (alias: delete)
Xóa tài khoản khỏi pool và xóa snapshot phiên agy tương ứng.

Flags:
  --purge   Xóa luôn thư mục Chrome profile dưới ~/.google-one-pool/chrome-profiles/
            (chỉ áp dụng cho chế độ isolated — KHÔNG BAO GIỜ xóa Chrome gốc).`,

  'import-chrome': `gpool import-chrome [--dry-run] [--isolated] [--plan "..."] [--tags a,b] [--json]
Quét metadata Chrome / Brave (Local State & Preferences — không đọc mật khẩu/cookie) và nhập vào pool.

Flags:
  --dry-run    Chỉ xem trước danh sách phát hiện được, không lưu
  --isolated   Tạo Chrome profile riêng thay vì liên kết Chrome gốc (mặc định: linked)
  --tags a,b   Gắn tag mặc định (mặc định: pro)

Mẹo: Nếu macOS báo lỗi quyền (EPERM) hoặc bạn login kiểu multi-login Web, hãy dùng "gpool import-clipboard".`,

  'import-clipboard': `gpool import-clipboard [--profile "Default"] [--browser chrome|brave] [--dry-run] [--isolated] [--tags pro]
Đọc nội dung Clipboard (sau khi mở https://accounts.google.com/SignOutOptions và nhấn ⌘A ⌘C),
tự động lọc toàn bộ email Gmail & tên hiển thị để nhập hàng loạt vào pool.

Ví dụ:
  gpool import-clipboard --dry-run
  gpool import-clipboard --profile "Default" --tags pro`,

  'import-emails': `gpool import-emails <file.txt | --emails "a@gmail.com,b@gmail.com"> [--profile "Default"] [--isolated] [--tags pro]
Nhập hàng loạt nhiều email từ file text hoặc tham số --emails.
Hỗ trợ các dòng: "email", "alias email", "email | ghi chú", hoặc danh sách cách nhau bởi dấu phẩy.

Ví dụ:
  gpool import-emails --emails "acc1@gmail.com,acc2@gmail.com" --tags pro
  gpool import-emails accounts.txt --isolated`,

  switch: `gpool switch <alias> [--no-open] [--cooldown-prev <giờ>] [--reason "..."] [--url <url>] (alias: use)
Đặt tài khoản làm active và mở cửa sổ Chrome đúng profile.

Ví dụ:
  gpool switch pro2
  gpool switch pro2 --cooldown-prev 5 --reason "Hết quota"`,

  agy: `gpool agy [flags] [-- <agy-args...>]
Smart Auto-Failover Wrapper cho agy CLI:
  - Tự lấy khóa agy.lock (chống 2 tiến trình tranh chấp Keychain)
  - Tự chọn acc sẵn sàng đã lưu snapshot agy và nạp Keychain
  - Ở chế độ batch/agent: tự phát hiện lỗi hết quota (429 / RESOURCE_EXHAUSTED / resets in ...),
    đặt cooldown theo đúng thời gian reset, xoay sang acc kế tiếp và tự chạy lại!

Flags:
  --alias <alias>        Ưu tiên bắt đầu từ tài khoản này
  --tag <tag>            Chỉ dùng các tài khoản có tag này
  --bucket <name|auto>   Bucket cooldown (all, pro, claude, flash, opus, sonnet, hoặc auto)
  --policy <p>           Chiến lược xoay: lru | round-robin | tier-first
  --cooldown <giờ>       Ghi đè số giờ cooldown nếu lỗi không báo giờ reset cụ thể
  --max-retries <N>      Số lần tự xoay vòng tối đa (mặc định: 3)
  --wait <giây>          Chờ tối đa N giây nếu agy.lock đang bận
  --timeout <giây>       Giới hạn thời gian mỗi lần chạy agy
  --auto-rotate          Ép chế độ bắt lỗi quota & auto-failover
  --force                Bỏ qua kiểm tra tiến trình agy đang chạy
  --json                 Xuất kết quả JSON (cho script/agent)

Ví dụ:
  gpool agy                                   # mở agy tương tác với acc sẵn sàng + giữ khóa
  gpool agy --bucket auto --max-retries 5 -- -p "Review PR này"`,

  'agy-next': `gpool agy-next [--cooldown <giờ>] [--bucket <name>] [--tag <tag>] [--policy <p>] [--wait <giây>] [--force] [--open] [--json]
Lệnh gọn 1 bước: đặt cooldown acc hiện tại, chọn acc sẵn sàng ĐÃ LƯU PHIÊN AGY kế tiếp, và nạp thẳng vào Keychain (không bật Chrome trừ khi truyền --open).

Ví dụ:
  gpool agy-next
  gpool agy-next --cooldown 5 --bucket claude --policy tier-first`,

  'agy-health': `gpool agy-health [--json]
Kiểm tra sức khỏe toàn bộ snapshot agy (refresh_token, hạn access_token, khớp email, trạng thái mã hóa AES-256-GCM, acc chưa capture), trạng thái khóa agy.lock và cảnh báo các tài khoản sắp đến ngày gia hạn gói.`,

  'agy-encrypt': `gpool agy-encrypt [--json]
Tạo 1 master key AES-256 duy nhất trong macOS Keychain ("google-one-pool"/"master-key") và mã hóa toàn bộ snapshot agy v1 hiện có trên đĩa sang định dạng v2 AES-256-GCM (kèm AAD gắn với alias).`,

  'agy-onboard': `gpool agy-onboard [alias] [--all] [--timeout <giây>] [--login-cmd "<lệnh>"]
Wizard 1/N nạp nhanh nhiều tài khoản mới vào agy:
  - Tự động theo dõi Clipboard (và stdout nếu có --login-cmd) để bắt link OAuth Google
  - Tự mở link OAuth đó thẳng vào đúng Chrome profile của từng tài khoản (gắn sẵn login_hint/authuser)
  - Tự theo dõi macOS Keychain và tự động capture (mã hóa AES-256-GCM) ngay khi bạn bấm Allow xong!`,

  stats: `gpool stats (alias: analytics) [--days 7] [--json]
Hiển thị thống kê hiệu suất toàn pool: tỷ lệ sẵn sàng, độ phủ mã hóa AES-256-GCM, biểu đồ hoạt động N ngày gần đây (lượt switch/nạp agy vs số lần đụng quota) và bảng chi tiết từng tài khoản.`,

  'agy-lock': `gpool agy-lock <status|unlock> [--json]
Xem tiến trình/agent nào đang giữ khóa agy.lock hoặc ép mở khóa (unlock) nếu cần.`,

  mcp: `gpool mcp
Khởi chạy Model Context Protocol (MCP) Server qua stdio (JSON-RPC 2.0) để AI Agents (Devin, Claude Code, Codex, Cursor, Hermes...) tự quản lý và xoay vòng pool agy.

Các MCP tools tích hợp:
  pool_status, agy_health, agy_acquire, agy_release,
  agy_report_quota, agy_clear_cooldown, agy_run

Xem cấu hình mẫu trong docs/CLI-GUIDE.md.`,

  next: `gpool next [--cooldown <giờ>] [--reason "..."] [--tag <tag>] [--bucket <name>] [--policy lru|round-robin|tier-first] [--agy] [--force] [--no-open] (alias: rotate)
Đặt cooldown cho tài khoản đang active rồi tự động xoay sang tài khoản sẵn sàng kế tiếp.
Thêm --agy để chỉ chọn acc đã lưu snapshot agy và tự nạp luôn vào Keychain (mặc định không mở Chrome).

Ví dụ:
  gpool next --cooldown 5
  gpool next --agy --bucket pro --policy tier-first`,

  cooldown: `gpool cooldown <alias> <giờ | clear> [--bucket all|pro|claude|flash] [--reason "..."]
Đặt hoặc gỡ cooldown thủ công cho một tài khoản (toàn tài khoản hoặc riêng 1 bucket model).

Ví dụ:
  gpool cooldown pro1 5 --reason "Hết hạn mức Gemini"
  gpool cooldown pro1 3 --bucket claude --reason "Hết quota Claude"
  gpool cooldown pro1 clear --bucket claude
  gpool cooldown pro1 clear`,

  'agy-capture': `gpool agy-capture <alias>
Lưu snapshot phiên đăng nhập agy hiện tại trong macOS Keychain ("gemini"/"antigravity") vào tài khoản <alias>.
Nếu email trong Keychain không khớp tài khoản <alias>, lệnh sẽ từ chối để tránh lưu nhầm.

Quy trình:
  1) Đăng nhập agy bằng đúng tài khoản <alias>
  2) Chạy: gpool agy-capture <alias>`,

  'agy-activate': `gpool agy-activate <alias> [--force]
Nạp snapshot phiên agy đã lưu của <alias> vào macOS Keychain để đổi tài khoản tức thì KHÔNG cần OAuth lại.
Tự động lưu lại token mới nhất của acc đang dùng trước khi ghi đè.

Lưu ý quan trọng:
  - Đóng agy/Antigravity trước khi chạy (hoặc dùng --force nếu chắc chắn).
  - KHÔNG dùng "/logout" trong agy để đổi acc vì sẽ thu hồi refresh token!

Ví dụ:
  gpool agy-activate pro2`,

  'agy-status': `gpool agy-status [--json]
Hiển thị trạng thái macOS Keychain của agy: đang nạp phiên của acc nào, tiến trình agy nào đang chạy, và danh sách tất cả snapshot đã lưu.`,

  run: `gpool run <alias> [--force] -- <lệnh...>
Chạy một lệnh CLI theo ngữ cảnh của tài khoản <alias>:
  - Với "agy": tự động nạp phiên agy đã lưu vào Keychain (nếu có) rồi mở agy.
  - Với "agy" + ADC: đặt AGY_ADC_AUTH=true và GOOGLE_APPLICATION_CREDENTIALS.
  - Với "gemini": đặt GEMINI_CLI_HOME riêng cho từng tài khoản.

Ví dụ:
  gpool run pro2 -- agy
  gpool run pro2 -- gemini`,

  auth: `gpool auth <alias> [oauth-url]
Mở link OAuth của Google vào đúng Chrome profile của <alias> (tự gắn login_hint & authuser nếu đang dùng chế độ linked).
Nếu bỏ trống [oauth-url], tự động đọc URL từ Clipboard macOS (pbpaste).`,

  isolate: `gpool isolate <alias | --all> [--no-open]
Chuyển 1 hoặc tất cả tài khoản từ chế độ Link Chrome gốc sang Chrome profile riêng độc lập (dưới ~/.google-one-pool/chrome-profiles/).
Sau khi tách, chạy "gpool login-wizard" để đăng nhập từng profile 1 lần.`,

  check: `gpool check [alias] [--json]
Kiểm tra và làm mới phiên Google (Keep-Alive). Truyền [alias] để kiểm tra 1 acc, hoặc bỏ trống để quét toàn bộ pool.`,

  login: `gpool login <alias>
Mở Chrome profile của <alias> tại trang đăng nhập Google đã điền sẵn email.`,

  'login-wizard': `gpool login-wizard
Mở nối tiếp từng Chrome profile riêng đang chờ đăng nhập (1/N) và xác nhận Live ngay trên Terminal.`,

  open: `gpool open <alias> [url]
Mở hoặc focus cửa sổ Chrome của tài khoản <alias> tại URL mặc định hoặc [url] chỉ định.`,

  daemon: `gpool daemon <start|stop|status|run> [--port 47891] [--json]
Quản lý dịch vụ nền HTTP (Web Dashboard + API + lịch Keep-Alive).
  start   Chạy ngầm dưới nền và ghi log ra ~/.google-one-pool/daemon.log
  stop    Dừng daemon đang chạy
  status  Kiểm tra trạng thái hoạt động
  run     Chạy ở foreground (dùng cho LaunchAgent hoặc debug)`,

  dashboard: `gpool dashboard [--port 47891]
Tự khởi động daemon nếu chưa chạy và mở Web Dashboard tại http://127.0.0.1:47891.`,

  menubar: `gpool menubar <build|start|stop>
Build (bằng swiftc) và bật/tắt ứng dụng Menu Bar gốc trên thanh trạng thái macOS.`,

  launchagent: `gpool launchagent <install|uninstall|status> [--json]
Cài hoặc gỡ macOS LaunchAgent (~/Library/LaunchAgents/local.googleonepool.daemon.plist) để tự chạy daemon mỗi khi đăng nhập máy.`,

  export: `gpool export [file.json]
Xuất toàn bộ metadata tài khoản & cài đặt ra JSON (KHÔNG bao gồm cookie hay mật khẩu).`,

  import: `gpool import <file.json> [--json]
Khôi phục/cập nhật danh sách tài khoản từ file JSON đã xuất bằng "gpool export".`,
};
