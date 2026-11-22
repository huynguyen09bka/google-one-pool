import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  discoverBrowserProfiles,
  extractEmailsFromText,
  generateUniqueAlias,
  getDefaultBrowserRoots,
  type BrowserScanRoot,
} from './browser-import.ts';
import { decryptBackupBundle, encryptBackupBundle, isEncryptedBackupBundle } from './agycrypto.ts';
import { readAgyLease, releaseAgyLease } from './agylock.ts';
import {
  activateAgySession,
  captureAgySession,
  exportDecryptedSessions,
  getAgySessionStatus,
  getLiveKeychainContext,
  importSessionsFromBackup,
  inspectAgyHealth,
  migrateSessionsToEncrypted,
  sessionInfoForAlias,
  type AgySessionSnapshot,
  type LiveKeychainContext,
} from './agysession.ts';
import { computePoolAnalytics } from './analytics.ts';
import { isAccountChromeRunning } from './chrome.ts';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureDaemonToken,
  tokensEqual,
  validateAlias,
  validateChromeProfileName,
  validateEmail,
  type PoolPaths,
} from './config.ts';
import type { PoolDB } from './db.ts';
import type { KeepAliveScheduler } from './keepalive.ts';
import type { PoolSwitcher } from './switcher.ts';
import type {
  AccountView,
  BulkImportItemInput,
  CreateAccountInput,
  DaemonSettings,
  EffectiveState,
  EncryptedBackupBundle,
  PlanTier,
  PoolExportPayload,
  ProfileMode,
  RotationPolicy,
  UpdateAccountInput,
} from './types.ts';

export interface CreateDaemonServerOptions {
  db: PoolDB;
  switcher: PoolSwitcher;
  keepalive: KeepAliveScheduler;
  paths: PoolPaths;
  host?: string;
  port?: number;
  webDir?: string;
  discoverRoots?: BrowserScanRoot[];
  authToken?: string;
}

export interface DaemonServerHandle {
  server: http.Server;
  host: string;
  port: number;
  authToken: string;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  broadcastSnapshot: () => void;
}

const SESSION_COOKIE_NAME = 'gpool_session';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const STATIC_ROUTE_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
  '/i18n.js': 'i18n.js',
};

export function createDaemonServer(options: CreateDaemonServerOptions): DaemonServerHandle {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const webDir = options.webDir ?? path.resolve(import.meta.dirname, '..', 'web');
  const authToken = options.authToken ?? ensureDaemonToken(options.paths);
  const expectedSessionCookie = crypto
    .createHmac('sha256', authToken)
    .update('gpool-web-session:v1')
    .digest('hex');
  const sseClients = new Set<ServerResponse>();
  let actualPort = requestedPort;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function safeLiveKeychainContext(): LiveKeychainContext | null {
    try {
      return getLiveKeychainContext(options.paths);
    } catch {
      return null;
    }
  }

  function decorateWithAgySessions(views: AccountView[], liveCtx?: LiveKeychainContext | null): AccountView[] {
    try {
      const ctx = liveCtx !== undefined ? liveCtx : safeLiveKeychainContext();
      if (!ctx) return views;
      return views.map((view) => ({
        ...view,
        agy_session: sessionInfoForAlias(
          options.paths,
          view.alias,
          ctx.live_sha,
          ctx.marker_alias,
          ctx.live_owner_alias,
        ),
      }));
    } catch {
      return views;
    }
  }

  function buildSnapshot(precomputedLiveCtx?: LiveKeychainContext | null) {
    options.db.expireElapsedCooldowns();
    const liveCtx = precomputedLiveCtx !== undefined ? precomputedLiveCtx : safeLiveKeychainContext();
    const accounts = decorateWithAgySessions(
      options.db.listAccounts().map((acc) => {
        const running = isAccountChromeRunning(acc).running;
        return options.db.computeAccountView(acc, running);
      }),
      liveCtx,
    );
    const active = accounts.find((a) => a.is_active) ?? null;
    const summary = {
      total: accounts.length,
      ready: accounts.filter((a) => a.effective_state === 'ready' || a.effective_state === 'active').length,
      cooldown: accounts.filter((a) => a.effective_state === 'cooldown').length,
      needs_login: accounts.filter((a) => a.effective_state === 'needs_login').length,
      unknown: accounts.filter((a) => a.effective_state === 'unknown').length,
      error: accounts.filter((a) => a.effective_state === 'error').length,
    };

    const settings = options.db.getSettings();
    const renewalAlerts = options.db.getRenewalAlerts(settings.renewal_alert_days);

    return {
      accounts,
      activeAlias: active?.alias ?? null,
      summary,
      keepalive: options.keepalive.getStatus(),
      settings,
      events: options.db.listEvents(40),
      agyLease: readAgyLease(options.paths),
      renewalAlerts,
      agyStatus: liveCtx
        ? {
            keychain_present: liveCtx.present,
            live_owner_alias: liveCtx.live_owner_alias,
            live_unknown: liveCtx.live_unknown,
            live_email: liveCtx.live_email,
            marker_alias: liveCtx.marker_alias,
          }
        : null,
    };
  }

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function broadcastSnapshot(): void {
    if (sseClients.size === 0) return;
    broadcast('state_changed', buildSnapshot());
  }

  function isRequestAuthenticated(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      const provided = authHeader.slice(7).trim();
      if (provided && tokensEqual(provided, authToken)) {
        return true;
      }
    }
    const cookieHeader = req.headers.cookie;
    if (typeof cookieHeader === 'string') {
      const sessionCookie = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
      if (sessionCookie && tokensEqual(sessionCookie, expectedSessionCookie)) {
        return true;
      }
    }
    return false;
  }

  function requireAuthenticated(req: IncomingMessage): void {
    if (!isRequestAuthenticated(req)) {
      throw new HttpError(
        401,
        'Yêu cầu xác thực daemon token (Authorization: Bearer <token> hoặc mở bằng "gpool dashboard").',
      );
    }
  }

  function validateLoopbackRequest(req: IncomingMessage): void {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      throw new HttpError(403, 'Thiếu Host header — chỉ chấp nhận localhost hoặc 127.0.0.1.');
    }
    const hostname = extractHostname(hostHeader);
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      throw new HttpError(403, 'Host header không hợp lệ — chỉ chấp nhận localhost hoặc 127.0.0.1.');
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const secFetchSite = req.headers['sec-fetch-site'];
      if (typeof secFetchSite === 'string') {
        const normalizedSite = secFetchSite.trim().toLowerCase();
        if (normalizedSite && normalizedSite !== 'same-origin' && normalizedSite !== 'none') {
          throw new HttpError(403, 'Từ chối yêu cầu cross-site tới Google One Pool daemon.');
        }
      }

      const origin = req.headers.origin;
      if (origin !== undefined) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          throw new HttpError(403, 'Origin header không hợp lệ.');
        }
        const originHost = parsed.hostname.toLowerCase();
        const originPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'http:' ? 80 : 443;
        if (
          parsed.protocol !== 'http:' ||
          (originHost !== '127.0.0.1' && originHost !== 'localhost') ||
          originPort !== actualPort
        ) {
          throw new HttpError(403, 'Từ chối yêu cầu cross-origin tới Google One Pool daemon.');
        }
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      validateLoopbackRequest(req);

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = url.pathname;

      if (method === 'GET' && pathname === '/favicon.ico') {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4f8cff"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-weight="800" font-size="22">G1P</text></svg>';
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(svg);
        return;
      }

      if (method === 'GET' && pathname === '/auth') {
        const tokenParam = url.searchParams.get('token')?.trim() ?? '';
        if (!tokenParam || !tokensEqual(tokenParam, authToken)) {
          throw new HttpError(401, 'Daemon token không hợp lệ.');
        }
        res.writeHead(302, {
          ...SECURITY_HEADERS,
          Location: '/',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${SESSION_COOKIE_NAME}=${expectedSessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end();
        return;
      }

      if (method === 'GET' && pathname in STATIC_ROUTE_FILES) {
        serveStaticFile(webDir, STATIC_ROUTE_FILES[pathname], res);
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        if (isRequestAuthenticated(req)) {
          sendJson(res, 200, {
            ok: true,
            pid: process.pid,
            port: actualPort,
            homeDir: options.paths.homeDir,
            keepalive: options.keepalive.getStatus(),
          });
        } else {
          sendJson(res, 200, { ok: true });
        }
        return;
      }

      if (method === 'POST' && pathname === '/api/auth/session') {
        const body = await readJsonBody<{ token?: string }>(req);
        const provided = typeof body.token === 'string' ? body.token.trim() : '';
        if (!provided || !tokensEqual(provided, authToken)) {
          throw new HttpError(401, 'Daemon token không hợp lệ.');
        }
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': `${SESSION_COOKIE_NAME}=${expectedSessionCookie}; HttpOnly; SameSite=Strict; Path=/`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (pathname.startsWith('/api/')) {
        requireAuthenticated(req);
      }

      if (method === 'GET' && pathname === '/api/events/stream') {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/accounts') {
        const liveCtx = safeLiveKeychainContext();
        const allSnapshot = buildSnapshot(liveCtx);
        const q = url.searchParams.get('q') ?? undefined;
        const tag = url.searchParams.get('tag') ?? undefined;
        const statusParam = url.searchParams.get('status');
        const status = (statusParam as EffectiveState | 'all' | null) ?? undefined;
        const hasFilter = Boolean(q || tag || (status && status !== 'all'));
        const filtered = hasFilter
          ? decorateWithAgySessions(
              options.db.listAccounts({ q, tag, status }).map((acc) => {
                const running = isAccountChromeRunning(acc).running;
                return options.db.computeAccountView(acc, running);
              }),
              liveCtx,
            )
          : allSnapshot.accounts;
        sendJson(res, 200, {
          accounts: filtered,
          activeAlias: allSnapshot.activeAlias,
          summary: allSnapshot.summary,
          keepalive: allSnapshot.keepalive,
          settings: allSnapshot.settings,
          agyStatus: allSnapshot.agyStatus,
          agyLease: allSnapshot.agyLease,
          renewalAlerts: allSnapshot.renewalAlerts,
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/accounts') {
        const body = await readJsonBody<CreateAccountInput>(req);
        if (!body.alias || !body.email) {
          throw new HttpError(400, 'Cần nhập đầy đủ alias và email.');
        }
        try {
          const created = options.db.createAccount(body);
          const view = options.db.computeAccountView(created, isAccountChromeRunning(created).running);
          broadcast('state_changed', buildSnapshot());
          sendJson(res, 201, { ok: true, account: view });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('đã tồn tại')) {
            throw new HttpError(409, msg);
          }
          throw new HttpError(400, msg);
        }
      }

      if (method === 'GET' && pathname === '/api/import/chrome/discover') {
        const currentAccounts = options.db.listAccounts();
        const existingEmails = new Set(currentAccounts.map((a) => a.email.toLowerCase()));
        const existingAliases = new Set(currentAccounts.map((a) => a.alias.toLowerCase()));
        const discovered = discoverBrowserProfiles({
          roots: options.discoverRoots,
          existingEmails,
          existingAliases,
        });
        sendJson(res, 200, { ok: true, ...discovered });
        return;
      }

      if (method === 'POST' && pathname === '/api/import/chrome') {
        const body = await readJsonBody<{
          mode?: ProfileMode;
          chrome_user_data_dir?: string | null;
          chrome_profile_name?: string | null;
          plan_tier?: PlanTier;
          tags?: string[];
          rawText?: string;
          items?: BulkImportItemInput[];
        }>(req);

        const existingAccounts = options.db.listAccounts();
        const existingEmails = new Set(existingAccounts.map((a) => a.email.toLowerCase()));
        const existingAliases = new Set(existingAccounts.map((a) => a.alias.toLowerCase()));

        let inputItems: BulkImportItemInput[] = Array.isArray(body.items) ? body.items : [];
        if (inputItems.length === 0 && typeof body.rawText === 'string' && body.rawText.trim()) {
          inputItems = extractEmailsFromText(body.rawText, new Set(existingAliases)).map((parsed) => ({
            alias: parsed.alias,
            email: parsed.email,
            display_name: parsed.display_name,
            notes: parsed.notes,
          }));
        }

        if (inputItems.length === 0) {
          throw new HttpError(400, 'Không tìm thấy email hợp lệ nào trong danh sách cần nhập.');
        }

        const mode: ProfileMode = body.mode === 'isolated' ? 'isolated' : 'linked';
        const defaultUserDataDir =
          options.discoverRoots?.[0]?.userDataDir ?? getDefaultBrowserRoots()[0].userDataDir;

        const created: AccountView[] = [];
        const skipped: Array<{ email: string; reason: string }> = [];
        const errors: Array<{ email: string; error: string }> = [];

        for (const item of inputItems) {
          const rawEmail = typeof item?.email === 'string' ? item.email : '';
          let normalizedEmail: string;
          try {
            normalizedEmail = validateEmail(rawEmail);
          } catch (err) {
            errors.push({
              email: rawEmail || '(trống)',
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }

          if (existingEmails.has(normalizedEmail)) {
            skipped.push({ email: normalizedEmail, reason: 'Email đã có trong pool' });
            continue;
          }

          let chosenAlias: string;
          if (item.alias && item.alias.trim()) {
            try {
              const candidate = validateAlias(item.alias);
              if (existingAliases.has(candidate)) {
                chosenAlias = generateUniqueAlias(normalizedEmail, existingAliases);
              } else {
                existingAliases.add(candidate);
                chosenAlias = candidate;
              }
            } catch {
              chosenAlias = generateUniqueAlias(normalizedEmail, existingAliases);
            }
          } else {
            chosenAlias = generateUniqueAlias(normalizedEmail, existingAliases);
          }

          const userDataDir = (item.chrome_user_data_dir ?? body.chrome_user_data_dir ?? defaultUserDataDir).trim();
          const rawProfileName = (item.chrome_profile_name ?? body.chrome_profile_name ?? 'Default').trim() || 'Default';
          let profileName: string;
          try {
            profileName = validateChromeProfileName(rawProfileName);
          } catch (err) {
            errors.push({
              email: normalizedEmail,
              error: err instanceof Error ? err.message : String(err),
            });
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
            const record = options.db.createAccount({
              alias: chosenAlias,
              email: normalizedEmail,
              display_name: item.display_name ?? '',
              plan_tier: item.plan_tier ?? body.plan_tier ?? 'Google AI Pro',
              renewal_date: item.renewal_date ?? null,
              tags: item.tags ?? body.tags ?? ['pro'],
              notes: item.notes ?? '',
              proxy_url: item.proxy_url ?? null,
              profile_mode: mode,
              chrome_user_data_dir: mode === 'linked' ? userDataDir : null,
              chrome_profile_name: mode === 'linked' ? profileName : null,
              google_authuser: mode === 'linked' ? (item.google_authuser?.trim() || normalizedEmail) : null,
              initial_session_status: mode === 'linked' && hasCookies ? 'live' : 'unknown',
              initial_session_detail:
                mode === 'linked'
                  ? hasCookies
                    ? `Liên kết trực tiếp Chrome (${profileName}) — sẵn sàng dùng ngay`
                    : `Chế độ Link (${profileName}) — hãy mở Chrome để đăng nhập Google`
                  : 'Đã nhập vào pool — bấm "Đăng nhập Chrome" để xác nhận 1 lần',
            });

            existingEmails.add(normalizedEmail);
            created.push(options.db.computeAccountView(record, isAccountChromeRunning(record).running));
          } catch (err) {
            errors.push({
              email: normalizedEmail,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (created.length > 0) {
          broadcast('state_changed', buildSnapshot());
        }
        sendJson(res, 200, { ok: true, created, skipped, errors });
        return;
      }

      if (method === 'POST' && pathname === '/api/pool/next') {
        const body = await readJsonBody<{
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
        }>(req, true);
        try {
          const result = await options.switcher.rotateNext(body);
          broadcast('state_changed', buildSnapshot());
          sendJson(res, result.ok ? 200 : 409, result);
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'POST' && pathname === '/api/sync') {
        broadcastSnapshot();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && pathname === '/api/keepalive/sweep') {
        const results = await options.keepalive.sweepAll();
        broadcast('state_changed', buildSnapshot());
        sendJson(res, 200, { ok: true, results });
        return;
      }

      if (method === 'GET' && pathname === '/api/events') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : 50;
        sendJson(res, 200, { events: options.db.listEvents(Number.isFinite(limit) ? limit : 50) });
        return;
      }

      if (method === 'GET' && pathname === '/api/agy/status') {
        try {
          sendJson(res, 200, { ok: true, ...getAgySessionStatus(options.paths) });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/agy/health') {
        try {
          options.db.expireElapsedCooldowns();
          const settings = options.db.getSettings();
          const alerts = options.db.getRenewalAlerts(settings.renewal_alert_days);
          const report = inspectAgyHealth(options.paths, options.db.listAccounts(), alerts);
          sendJson(res, 200, { ok: true, ...report });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/agy/lease') {
        sendJson(res, 200, { ok: true, lease: readAgyLease(options.paths) });
        return;
      }

      if (method === 'DELETE' && pathname === '/api/agy/lease') {
        const released = releaseAgyLease(options.paths, { force: true });
        broadcast('state_changed', buildSnapshot());
        sendJson(res, 200, { ok: true, released });
        return;
      }

      if (method === 'POST' && pathname === '/api/agy/encrypt') {
        try {
          const result = migrateSessionsToEncrypted(options.paths);
          if (result.encrypted.length > 0) {
            options.db.addEvent(
              null,
              null,
              'agy_sessions_encrypted',
              `Đã mã hóa AES-256-GCM cho ${result.encrypted.length} phiên agy`,
            );
            broadcast('state_changed', buildSnapshot());
          }
          sendJson(res, 200, result);
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'GET' && pathname === '/api/analytics') {
        const daysRaw = url.searchParams.get('days');
        const days = daysRaw ? Number(daysRaw) : 7;
        const report = computePoolAnalytics(options.db, options.paths, {
          days: Number.isFinite(days) ? days : 7,
        });
        sendJson(res, 200, { ok: true, ...report });
        return;
      }

      if (method === 'POST' && pathname === '/api/export/encrypted') {
        const body = await readJsonBody<{ passphrase?: string; withSessions?: boolean }>(req);
        try {
          const withSessions = Boolean(body.withSessions);
          const metadata = options.db.exportMetadata({ includeSensitiveProxyCredentials: true });
          const sessions = withSessions ? exportDecryptedSessions(options.paths) : [];
          const bundle = encryptBackupBundle({ metadata, agy_sessions: sessions }, body.passphrase ?? '', withSessions);
          sendJson(res, 200, { ok: true, bundle, sessions_count: sessions.length });
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'POST' && pathname === '/api/import/encrypted') {
        const body = await readJsonBody<{ passphrase?: string; bundle?: EncryptedBackupBundle }>(req);
        try {
          if (!isEncryptedBackupBundle(body.bundle)) {
            throw new Error('Payload thiếu file backup mã hóa hợp lệ.');
          }
          const decrypted = decryptBackupBundle<{
            metadata: PoolExportPayload;
            agy_sessions?: AgySessionSnapshot[];
          }>(body.bundle, body.passphrase ?? '');
          const metaRes = options.db.importMetadata(decrypted.metadata);
          let sessionsImported = 0;
          let sessionsEncrypted = 0;
          if (Array.isArray(decrypted.agy_sessions) && decrypted.agy_sessions.length > 0) {
            const sesRes = importSessionsFromBackup(options.paths, decrypted.agy_sessions, {
              encrypt: process.platform === 'darwin',
            });
            sessionsImported = sesRes.imported;
            sessionsEncrypted = sesRes.encrypted;
          }
          broadcast('state_changed', buildSnapshot());
          sendJson(res, 200, {
            ok: true,
            ...metaRes,
            sessions_imported: sessionsImported,
            sessions_encrypted: sessionsEncrypted,
          });
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'GET' && pathname === '/api/settings') {
        sendJson(res, 200, { settings: options.db.getSettings() });
        return;
      }

      if (method === 'PATCH' && pathname === '/api/settings') {
        const body = await readJsonBody<Partial<DaemonSettings>>(req);
        try {
          const updated = options.db.updateSettings(body);
          broadcast('state_changed', buildSnapshot());
          sendJson(res, 200, { ok: true, settings: updated });
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'GET' && pathname === '/api/export') {
        sendJson(res, 200, options.db.exportMetadata());
        return;
      }

      if (method === 'POST' && pathname === '/api/import') {
        const payload = await readJsonBody<PoolExportPayload>(req);
        try {
          const result = options.db.importMetadata(payload);
          broadcast('state_changed', buildSnapshot());
          sendJson(res, 200, { ok: true, ...result });
          return;
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (method === 'POST' && pathname === '/api/accounts/isolate-all') {
        const result = options.switcher.isolateAllLinked();
        broadcast('state_changed', buildSnapshot());
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      const accountMatch = /^\/api\/accounts\/([^/]+)(?:\/(switch|open|oauth|check|cooldown|isolate|confirm-login|login|agy-capture|agy-activate))?$/.exec(pathname);
      if (accountMatch) {
        let aliasParam: string;
        try {
          aliasParam = decodeURIComponent(accountMatch[1]);
        } catch {
          throw new HttpError(400, 'Alias trên URL không hợp lệ.');
        }
        const action = accountMatch[2] ?? '';

        if (!action && method === 'GET') {
          const acc = options.db.getAccount(aliasParam);
          if (!acc) throw new HttpError(404, `Không tìm thấy tài khoản "${aliasParam}".`);
          const running = isAccountChromeRunning(acc).running;
          const [view] = decorateWithAgySessions([options.db.computeAccountView(acc, running)]);
          sendJson(res, 200, { account: view });
          return;
        }

        if (!action && method === 'PATCH') {
          const body = await readJsonBody<UpdateAccountInput>(req);
          try {
            const updated = options.db.updateAccount(aliasParam, body);
            const running = isAccountChromeRunning(updated).running;
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, account: options.db.computeAccountView(updated, running) });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            if (msg.includes('đã được dùng')) throw new HttpError(409, msg);
            throw new HttpError(400, msg);
          }
        }

        if (!action && method === 'DELETE') {
          const purgeProfile = url.searchParams.get('purgeProfile') === 'true';
          try {
            const deleted = options.db.deleteAccount(aliasParam, { purgeProfile });
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, deleted });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'switch' && method === 'POST') {
          const body = await readJsonBody<{
            openChrome?: boolean;
            openUrl?: string;
            oauthUrl?: string;
            cooldownPreviousHours?: number;
            cooldownReason?: string;
          }>(req, true);
          try {
            const result = await options.switcher.switchTo(aliasParam, body);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, result);
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'open' && method === 'POST') {
          const body = await readJsonBody<{ openUrl?: string }>(req, true);
          try {
            const result = await options.switcher.openProfile(aliasParam, body.openUrl);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, ...result });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'oauth' && method === 'POST') {
          const body = await readJsonBody<{ oauthUrl?: string; url?: string }>(req);
          const oauthUrl = body.oauthUrl ?? body.url ?? '';
          try {
            const result = await options.switcher.openOAuthInAccount(aliasParam, oauthUrl);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, ...result });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'isolate' && method === 'POST') {
          const body = await readJsonBody<{ openChrome?: boolean }>(req, true);
          try {
            const result = await options.switcher.isolateAccount(aliasParam, body);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, ...result });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'login' && method === 'POST') {
          try {
            const result = await options.switcher.openLogin(aliasParam);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, ...result });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'confirm-login' && method === 'POST') {
          try {
            const account = options.switcher.confirmLogin(aliasParam);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, account });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'check' && method === 'POST') {
          try {
            const result = await options.keepalive.probeAccount(aliasParam);
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, result });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'cooldown' && method === 'POST') {
          const body = await readJsonBody<{ hours?: number; until?: string; reason?: string; bucket?: string }>(req);
          let untilIso: string;
          if (body.until) {
            untilIso = body.until;
          } else {
            const hours = Number(body.hours ?? options.db.getSettings().default_cooldown_hours);
            if (!Number.isFinite(hours) || hours <= 0) {
              throw new HttpError(400, 'Số giờ cooldown phải lớn hơn 0.');
            }
            untilIso = new Date(Date.now() + hours * 3_600_000).toISOString();
          }

          try {
            const updated = body.bucket
              ? options.db.setBucketCooldown(aliasParam, body.bucket, untilIso, body.reason ?? '')
              : options.db.setCooldown(aliasParam, untilIso, body.reason ?? '');
            const running = isAccountChromeRunning(updated).running;
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, account: options.db.computeAccountView(updated, running) });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }

        if (action === 'agy-capture' && method === 'POST') {
          const account = options.db.getAccount(aliasParam);
          if (!account) throw new HttpError(404, `Không tìm thấy tài khoản "${aliasParam}".`);
          try {
            const result = captureAgySession(options.paths, account, {
              encrypt: process.platform === 'darwin',
            });
            options.db.addEvent(
              account.id,
              account.alias,
              'agy_session_captured',
              `Đã lưu phiên đăng nhập agy của ${account.alias}${result.encrypted ? ' (AES-256-GCM)' : ''}`,
            );
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, result);
            return;
          } catch (err) {
            throw new HttpError(400, err instanceof Error ? err.message : String(err));
          }
        }

        if (action === 'agy-activate' && method === 'POST') {
          const account = options.db.getAccount(aliasParam);
          if (!account) throw new HttpError(404, `Không tìm thấy tài khoản "${aliasParam}".`);
          const body = await readJsonBody<{ force?: boolean }>(req, true);
          try {
            const result = activateAgySession(options.paths, account, { force: Boolean(body.force) });
            options.db.addEvent(
              account.id,
              account.alias,
              'agy_session_activated',
              `Đã nạp phiên agy của ${account.alias} vào Keychain`,
            );
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, result);
            return;
          } catch (err) {
            throw new HttpError(400, err instanceof Error ? err.message : String(err));
          }
        }

        if (action === 'cooldown' && method === 'DELETE') {
          const bucketParam = url.searchParams.get('bucket') ?? undefined;
          try {
            const updated = options.db.clearCooldown(aliasParam, bucketParam);
            const running = isAccountChromeRunning(updated).running;
            broadcast('state_changed', buildSnapshot());
            sendJson(res, 200, { ok: true, account: options.db.computeAccountView(updated, running) });
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('Không tìm thấy')) throw new HttpError(404, msg);
            throw new HttpError(400, msg);
          }
        }
      }

      sendJson(res, 404, { ok: false, error: `Không tìm thấy endpoint ${method} ${pathname}` });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, { ok: false, error: err.message });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : 'Lỗi máy chủ nội bộ',
      });
    }
  });

  return {
    server,
    host,
    get port() {
      return actualPort;
    },
    authToken,
    broadcast,
    broadcastSnapshot,
    start: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, host, () => {
          server.off('error', reject);
          const addr = server.address();
          if (addr && typeof addr !== 'string') {
            actualPort = addr.port;
          }
          heartbeatTimer = setInterval(() => {
            for (const client of sseClients) {
              try {
                client.write(': heartbeat\n\n');
              } catch {
                sseClients.delete(client);
              }
            }
          }, 25_000);
          heartbeatTimer.unref();
          resolve(actualPort);
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            // Ignore.
          }
        }
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
}

function serveStaticFile(webDir: string, filename: string, res: ServerResponse): void {
  const safeBase = path.resolve(webDir);
  const filePath = path.resolve(safeBase, filename);
  if (!filePath.startsWith(safeBase + path.sep) || !fs.existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: 'Không tìm thấy tệp giao diện' });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

async function readJsonBody<T>(req: IncomingMessage, allowEmpty = false): Promise<T> {
  const rawContentType = req.headers['content-type'];
  const contentType = typeof rawContentType === 'string' ? rawContentType.split(';')[0].trim().toLowerCase() : '';
  if (contentType && contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type phải là application/json.');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = 1_048_576;

  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, 'Payload quá lớn (tối đa 1MB).');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    if (allowEmpty) return {} as T;
    throw new HttpError(400, 'Body JSON không được để trống.');
  }

  if (contentType !== 'application/json') {
    throw new HttpError(415, 'Content-Type phải là application/json.');
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Body JSON không hợp lệ.');
  }
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === name) {
      return part.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

function extractHostname(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
}
