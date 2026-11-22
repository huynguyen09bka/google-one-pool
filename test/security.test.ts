import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  BACKUP_MIN_PASSPHRASE_LENGTH,
  decryptBackupBundle,
  encryptBackupBundle,
  getOrCreateMasterKey,
  isEncryptedBackupBundle,
} from '../src/agycrypto.ts';
import { acquireAgyLease, readAgyLease } from '../src/agylock.ts';
import {
  activateAgySession,
  captureAgySession,
  importSessionsFromBackup,
  inspectAgyHealth,
  writeKeychainBlob,
  type SecurityRunResult,
} from '../src/agysession.ts';
import {
  DEFAULT_HOST,
  redactProxyUrl,
  resolvePaths,
  validateAdcCredentialsPath,
  validateChromeBinary,
  validateChromeProfileName,
} from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import { KeepAliveScheduler } from '../src/keepalive.ts';
import { createMcpHandler } from '../src/mcp.ts';
import { createDaemonServer } from '../src/server.ts';
import { PoolSwitcher } from '../src/switcher.ts';
import type { EncryptedBackupBundle } from '../src/types.ts';

function tokenizeInteractiveLine(line: string): string[] {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return tokens;
}

function makeAuditedFakeKeychain(initial?: Buffer) {
  const store = new Map<string, Buffer>();
  const recordedCalls: Array<{ args: string[]; stdin?: string }> = [];
  if (initial) store.set('gemini\0antigravity', Buffer.from(initial));

  const run = (args: string[], stdin?: string): SecurityRunResult => {
    recordedCalls.push({ args: [...args], stdin });
    const tokens = args[0] === '-i' && stdin ? tokenizeInteractiveLine(stdin.trim()) : args;
    const val = (flag: string) => tokens[tokens.indexOf(flag) + 1];
    if (tokens[0] === 'find-generic-password') {
      const blob = store.get(`${val('-s')}\0${val('-a')}`);
      if (!blob) {
        return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from('not found') };
      }
      return { status: 0, stdout: Buffer.concat([blob, Buffer.from('\n')]), stderr: Buffer.alloc(0) };
    }
    if (tokens[0] === 'add-generic-password') {
      const data = tokens.includes('-X') ? Buffer.from(val('-X'), 'hex') : Buffer.from(val('-w'), 'utf8');
      store.set(`${val('-s')}\0${val('-a')}`, data);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported') };
  };

  return {
    run,
    recordedCalls,
    store,
    set: (b: Buffer | string) => store.set('gemini\0antigravity', Buffer.from(b)),
  };
}

function blobFor(email: string, tag = ''): Buffer {
  const inner = Buffer.from(
    JSON.stringify({
      token: {
        access_token: `ya29.${tag || email.split('@')[0]}`,
        refresh_token: `rt-${tag || email.split('@')[0]}`,
        token_type: 'Bearer',
        expiry: '2099-12-31T00:00:00Z',
      },
      auth_method: 'consumer',
      id_token_email: email,
    }),
    'utf8',
  );
  return Buffer.from(`go-keyring-base64:${inner.toString('base64')}`, 'utf8');
}

describe('Security Hardening Regressions', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
  });

  function mkTemp(prefix = 'gpool-sec-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('enforces daemon bearer token & HttpOnly session cookie auth, CSP/clickjacking headers, and loopback checks', async () => {
    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    const switcher = new PoolSwitcher({ db, paths, openWindowFn: async () => ({ pid: 1 }) });
    const keepalive = new KeepAliveScheduler({
      db,
      staggerDelayMs: 0,
      probeFn: async () => ({ status: 'live', detail: 'OK' }),
      notifyFn: async () => {},
    });
    const srv = createDaemonServer({ db, switcher, keepalive, paths, host: DEFAULT_HOST, port: 0 });
    const port = await srv.start();
    const base = `http://${DEFAULT_HOST}:${port}`;
    cleanups.push(async () => {
      keepalive.stop();
      await srv.stop();
      db.close();
    });

    // Token file created with strict 0o600 permissions
    const tokenMode = fs.statSync(paths.tokenPath).mode & 0o777;
    assert.equal(tokenMode, 0o600);

    // Unauthenticated API requests are rejected with 401
    for (const [method, endpoint, body] of [
      ['GET', '/api/accounts', undefined],
      ['GET', '/api/export', undefined],
      ['GET', '/api/events/stream', undefined],
      ['POST', '/api/export/encrypted', JSON.stringify({ passphrase: 'strong-passphrase-123', withSessions: true })],
      ['PATCH', '/api/settings', JSON.stringify({ language: 'en' })],
    ] as const) {
      const res = await fetch(`${base}${endpoint}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      });
      assert.equal(res.status, 401, `${method} ${endpoint} should require auth`);
    }

    // Unauthenticated /api/health returns minimal liveness only (no homeDir / pid leak)
    const healthAnon = await fetch(`${base}/api/health`);
    assert.equal(healthAnon.status, 200);
    const anonJson = (await healthAnon.json()) as Record<string, unknown>;
    assert.equal(anonJson.ok, true);
    assert.equal(anonJson.homeDir, undefined);
    assert.equal(anonJson.pid, undefined);

    // Authenticated /api/health returns full details
    const healthAuth = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${srv.authToken}` },
    });
    assert.equal(healthAuth.status, 200);
    const authJson = (await healthAuth.json()) as Record<string, unknown>;
    assert.equal(authJson.homeDir, paths.homeDir);

    // Security headers present on HTML and JSON
    const indexRes = await fetch(`${base}/`);
    assert.equal(indexRes.headers.get('x-frame-options'), 'DENY');
    assert.equal(indexRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(indexRes.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(indexRes.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));

    // /auth?token=<valid> sets HttpOnly; SameSite=Strict cookie and redirects to /
    const badAuth = await fetch(`${base}/auth?token=wrong`, { redirect: 'manual' });
    assert.equal(badAuth.status, 401);

    const goodAuth = await fetch(`${base}/auth?token=${srv.authToken}`, { redirect: 'manual' });
    assert.equal(goodAuth.status, 302);
    assert.equal(goodAuth.headers.get('location'), '/');
    const setCookie = goodAuth.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('gpool_session='));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Strict'));

    // Cookie authenticates subsequent API requests
    const cookiePair = setCookie.split(';')[0];
    const cookieAccRes = await fetch(`${base}/api/accounts`, { headers: { Cookie: cookiePair } });
    assert.equal(cookieAccRes.status, 200);

    // POST /api/auth/session also mints cookie
    const sessRes = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: srv.authToken }),
    });
    assert.equal(sessRes.status, 200);
    assert.ok((sessRes.headers.get('set-cookie') ?? '').includes('gpool_session='));

    // Cross-site Sec-Fetch-Site rejected with 403
    const crossSite = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.authToken}`,
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ alias: 'x', email: 'x@example.com' }),
    });
    assert.equal(crossSite.status, 403);

    // Non-JSON Content-Type rejected with 415
    const wrongCt = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${srv.authToken}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ alias: 'x', email: 'x@example.com' }),
    });
    assert.equal(wrongCt.status, 415);

    // HTTP/1.0 request missing Host header rejected with 403
    const rawStatus = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ host: DEFAULT_HOST, port }, () => {
        sock.write('GET /api/health HTTP/1.0\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      sock.on('end', () => resolve(buf.split('\r\n')[0] ?? ''));
      sock.on('error', reject);
    });
    assert.ok(rawStatus.includes('403'), `Expected 403 for missing Host, got: ${rawStatus}`);
  });

  it('blocks path traversal aliases in importSessionsFromBackup and invalid chrome_profile_name on import', async () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeAuditedFakeKeychain(blobFor('safe@example.com'));
    const deps = { osHome, securityRun: kc.run, listClients: () => [] };

    const escapeTarget = path.join(paths.homeDir, 'escaped-pwn.json');
    assert.throws(
      () =>
        importSessionsFromBackup(
          paths,
          [
            {
              version: 1,
              alias: '../escaped-pwn',
              detected_email: 'evil@example.com',
              captured_at: new Date().toISOString(),
              blob_sha256: 'abc',
              keychain_blob_b64: Buffer.from('secret').toString('base64'),
              user_scope: null,
              extra_files: {},
            },
          ],
          deps,
        ),
      /Alias không hợp lệ/,
    );
    assert.equal(fs.existsSync(escapeTarget), false);

    assert.throws(() => validateChromeProfileName('../etc'), /Tên Chrome profile không hợp lệ/);
    assert.throws(() => validateChromeProfileName('Default/../../x'), /Tên Chrome profile không hợp lệ/);
  });

  it('rejects arbitrary binaries in chrome_binary and strips host executable paths in importMetadata', () => {
    assert.throws(() => validateChromeBinary('/bin/sh'), /không nằm trong danh sách Chromium/);
    assert.throws(() => validateChromeBinary('/usr/bin/python3'), /không nằm trong danh sách Chromium/);
    assert.throws(() => validateChromeBinary('/tmp/chrome'), /thư mục ứng dụng hệ thống/);
    assert.throws(() => validateChromeBinary('chrome'), /đường dẫn tuyệt đối/);
    assert.equal(
      validateChromeBinary('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );

    assert.throws(() => validateAdcCredentialsPath('relative.json'), /đường dẫn tuyệt đối/);
    assert.throws(() => validateAdcCredentialsPath('/etc/passwd'), /\.json/);

    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    try {
      const originalBinary = db.getSettings().chrome_binary;
      assert.throws(() => db.updateSettings({ chrome_binary: '/bin/sh' }), /không nằm trong danh sách Chromium/);

      // Importing untrusted metadata must NOT overwrite chrome_binary or inject adc_credentials_path
      db.importMetadata({
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: {
          chrome_binary: '/bin/sh',
          default_cooldown_hours: 6,
        },
        accounts: [
          {
            alias: 'imp1',
            email: 'imp1@example.com',
            display_name: 'Imp',
            plan_tier: 'Google AI Pro',
            renewal_date: null,
            tags: ['pro'],
            notes: '',
            proxy_url: null,
            adc_credentials_path: '/etc/evil-adc.json',
          },
        ],
      });
      assert.equal(db.getSettings().chrome_binary, originalBinary);
      assert.equal(db.getSettings().default_cooldown_hours, 6);
      assert.equal(db.getAccount('imp1')?.adc_credentials_path, null);
    } finally {
      db.close();
    }
  });

  it('passes Keychain master keys and OAuth blobs via security -i stdin, never in argv', () => {
    const kc = makeAuditedFakeKeychain();
    const masterKey = getOrCreateMasterKey({ securityRun: kc.run });
    const blob = blobFor('secret-user@example.com', 'sensitive-token-xyz');
    writeKeychainBlob(blob, { securityRun: kc.run });

    const writeCalls = kc.recordedCalls.filter((c) => c.args[0] === '-i');
    assert.equal(writeCalls.length, 2);
    for (const call of writeCalls) {
      assert.deepEqual(call.args, ['-i']);
      assert.ok(!call.args.includes('-w'));
      assert.ok(!call.args.join(' ').includes(masterKey.toString('hex')));
      assert.ok(!call.args.join(' ').includes('sensitive-token-xyz'));
      assert.ok(call.stdin?.includes('add-generic-password'));
      assert.ok(call.stdin?.includes('-X '));
    }
  });

  it('prevents silent downgrade of encrypted v2 snapshots and rejects swapped snapshot files via strict AAD', () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeAuditedFakeKeychain(blobFor('enc1@example.com'));
    const deps = { osHome, securityRun: kc.run, listClients: () => [] };
    const db = new PoolDB(paths);

    try {
      const a1 = db.createAccount({ alias: 'enc1', email: 'enc1@example.com' });
      const a2 = db.createAccount({ alias: 'enc2', email: 'enc2@example.com' });

      // Default capture encrypts v2 automatically
      const cap1 = captureAgySession(paths, a1, deps);
      assert.equal(cap1.encrypted, true);

      // Trying to recapture with encrypt: false must NOT downgrade existing v2 to plaintext!
      const cap1Again = captureAgySession(paths, a1, { ...deps, encrypt: false });
      assert.equal(cap1Again.encrypted, true);
      const raw1 = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, 'enc1.json'), 'utf8'));
      assert.equal(raw1.version, 2);
      assert.equal(raw1.encrypted, true);

      // Copy enc1.json onto enc2.json (cross-account swap attack) -> must FAIL strict alias + AAD check!
      fs.copyFileSync(
        path.join(paths.agySessionsDir, 'enc1.json'),
        path.join(paths.agySessionsDir, 'enc2.json'),
      );
      assert.throws(() => activateAgySession(paths, a2, {}, deps), /không khớp alias|Không giải mã được/);

      const health = inspectAgyHealth(paths, [a2], [], deps);
      assert.equal(health.accounts[0].health, 'corrupt');
    } finally {
      db.close();
    }
  });

  it('enforces >=12 char backup passphrases, scrypt v2 N=131072, rejects invalid KDF params, and decrypts legacy v1', () => {
    assert.throws(() => encryptBackupBundle({ ok: true }, 'short123', false), new RegExp(String(BACKUP_MIN_PASSPHRASE_LENGTH)));

    const v2 = encryptBackupBundle({ hello: 'world' }, 'very-strong-passphrase-2026', true);
    assert.equal(v2.version, 2);
    assert.equal(v2.kdf_params?.N, 131072);
    assert.equal(isEncryptedBackupBundle(v2), true);
    assert.deepEqual(decryptBackupBundle(v2, 'very-strong-passphrase-2026'), { hello: 'world' });

    // Reject malicious DoS KDF params
    const badKdf: EncryptedBackupBundle = { ...v2, kdf_params: { N: 1048576, r: 8, p: 1 } };
    assert.throws(() => decryptBackupBundle(badKdf, 'very-strong-passphrase-2026'), /ngưỡng an toàn/);

    // Backward compatibility with legacy v1 bundle (N=16384, AAD v1)
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync('legacy-passphrase-123', salt, 32, { N: 16384, r: 8, p: 1 });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('gpool-encrypted-backup:v1', 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ legacy: true }), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const v1: EncryptedBackupBundle = {
      format: 'gpool-encrypted-backup',
      version: 1,
      kdf: 'scrypt',
      alg: 'aes-256-gcm',
      salt_b64: salt.toString('base64'),
      iv_b64: iv.toString('base64'),
      tag_b64: tag.toString('base64'),
      includes_sessions: false,
      exported_at: new Date().toISOString(),
      ciphertext_b64: ct.toString('base64'),
    };
    assert.deepEqual(decryptBackupBundle(v1, 'legacy-passphrase-123'), { legacy: true });
  });

  it('respects force=false in MCP agy_release when another live PID holds the lease', async () => {
    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    db.close();

    // Acquire lease under parent PID (a real live PID different from process.pid)
    const otherPid = process.ppid && process.ppid !== process.pid ? process.ppid : 1;
    await acquireAgyLease(paths, { alias: 'other', holder: 'other-worker', pid: otherPid, ttlMs: 60_000 });
    assert.equal(readAgyLease(paths)?.pid, otherPid);

    const mcp = createMcpHandler({ paths, notifyDaemon: false });
    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      return JSON.parse((res?.result as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;
    };

    // Without force, MCP must NOT unlock another process's active lease
    const nonForced = await callTool('agy_release', { force: false });
    assert.equal(nonForced.released, false);
    assert.equal(readAgyLease(paths)?.pid, otherPid);

    // With explicit force: true, MCP can break the lease
    const forced = await callTool('agy_release', { force: true });
    assert.equal(forced.released, true);
    assert.equal(readAgyLease(paths), null);
  });

  it('redacts proxy credentials in plaintext metadata exports and removes innerHTML from web/i18n.js', () => {
    assert.equal(redactProxyUrl('http://alice:s3cr3t@127.0.0.1:8080'), 'http://***@127.0.0.1:8080');
    assert.equal(redactProxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');

    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    try {
      db.createAccount({
        alias: 'prox1',
        email: 'prox1@example.com',
        proxy_url: 'http://user:hunter2@proxy.internal:8080',
      });
      const plainExport = db.exportMetadata();
      assert.equal(plainExport.accounts[0].proxy_url, 'http://***@proxy.internal:8080');
      assert.ok(!JSON.stringify(plainExport).includes('hunter2'));

      const encExport = db.exportMetadata({ includeSensitiveProxyCredentials: true });
      assert.equal(encExport.accounts[0].proxy_url, 'http://user:hunter2@proxy.internal:8080');
    } finally {
      db.close();
    }

    const i18nJs = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'i18n.js'), 'utf8');
    assert.equal(i18nJs.includes('.innerHTML'), false);
  });
});
