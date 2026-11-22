import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  decryptBackupBundle,
  decryptSnapshotSecret,
  encryptBackupBundle,
  encryptSnapshotSecret,
  getOrCreateMasterKey,
  isEncryptedBackupBundle,
  readMasterKeyIfPresent,
} from '../src/agycrypto.ts';
import {
  extractGoogleOAuthUrl,
  onboardSingleAccount,
  waitForKeychainAccount,
} from '../src/agy-onboard.ts';
import {
  activateAgySession,
  captureAgySession,
  exportDecryptedSessions,
  importSessionsFromBackup,
  inspectAgyHealth,
  migrateSessionsToEncrypted,
  renameSessionFilesForAlias,
  type SecurityRunResult,
} from '../src/agysession.ts';
import { computePoolAnalytics } from '../src/analytics.ts';
import { DEFAULT_HOST, resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import { KeepAliveScheduler } from '../src/keepalive.ts';
import { createMcpHandler } from '../src/mcp.ts';
import { createDaemonServer } from '../src/server.ts';
import { PoolSwitcher } from '../src/switcher.ts';

function tokenizeInteractiveLine(line: string): string[] {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return tokens;
}

function makeFakeKeychain(initial?: Buffer) {
  const store = new Map<string, Buffer>();
  if (initial) store.set('gemini\0antigravity', Buffer.from(initial));
  const run = (args: string[], stdin?: string): SecurityRunResult => {
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
    current: () => store.get('gemini\0antigravity'),
    set: (b: Buffer | string) => store.set('gemini\0antigravity', Buffer.from(b)),
    hasKey: (s: string, a: string) => store.has(`${s}\0${a}`),
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

describe('Phase 3: AES-256-GCM Encryption, Encrypted Backup, Auto-Onboard & Analytics', () => {
  const tempDirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-p3-'));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('encrypts/decrypts snapshots with AES-256-GCM, enforces alias AAD, and migrates legacy v1 files', () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeFakeKeychain(blobFor('enc1@example.com'));
    const deps = { osHome, securityRun: kc.run, listClients: () => [] };

    // Unit-level AAD binding check
    assert.equal(readMasterKeyIfPresent(deps), null);
    const masterKey = getOrCreateMasterKey(deps);
    assert.equal(masterKey.length, 32);
    assert.equal(kc.hasKey('google-one-pool', 'master-key'), true);

    const enc = encryptSnapshotSecret(
      { keychain_blob_b64: 'c2VjcmV0', user_scope: 'scope1', extra_files: {} },
      masterKey,
      'enc1',
    );
    const dec = decryptSnapshotSecret(enc, masterKey, 'enc1');
    assert.equal(dec.keychain_blob_b64, 'c2VjcmV0');
    // Wrong alias AAD must fail authentication!
    assert.throws(() => decryptSnapshotSecret(enc, masterKey, 'wrong-alias'), /Không giải mã được/);

    // Test migration from legacy plaintext v1 -> encrypted v2
    const paths2 = resolvePaths(mkTemp());
    const kc2 = makeFakeKeychain(blobFor('v1acc@example.com'));
    const deps2 = { osHome, securityRun: kc2.run, listClients: () => [] };
    const db = new PoolDB(paths2);
    try {
      const a1 = db.createAccount({ alias: 'v1acc', email: 'v1acc@example.com' });
      const cap1 = captureAgySession(paths2, a1, { ...deps2, encrypt: false });
      assert.equal(cap1.encrypted, false);
      const rawV1 = JSON.parse(fs.readFileSync(path.join(paths2.agySessionsDir, 'v1acc.json'), 'utf8'));
      assert.equal(rawV1.version, 1);

      const hBefore = inspectAgyHealth(paths2, db.listAccounts(), [], deps2);
      assert.equal(hBefore.summary.unencrypted, 1);
      assert.equal(hBefore.summary.encrypted, 0);

      // Migrate to encrypted v2
      const mig = migrateSessionsToEncrypted(paths2, deps2);
      assert.deepEqual(mig.encrypted, ['v1acc']);
      assert.equal(mig.failed.length, 0);

      const rawV2 = JSON.parse(fs.readFileSync(path.join(paths2.agySessionsDir, 'v1acc.json'), 'utf8'));
      assert.equal(rawV2.version, 2);
      assert.equal(rawV2.encrypted, true);
      assert.equal(rawV2.keychain_blob_b64, undefined);
      assert.ok(typeof rawV2.ciphertext_b64 === 'string');

      // Activate & Health work transparently on encrypted v2
      const hAfter = inspectAgyHealth(paths2, db.listAccounts(), [], deps2);
      assert.equal(hAfter.summary.encrypted, 1);
      assert.equal(hAfter.summary.unencrypted, 0);
      assert.equal(hAfter.summary.healthy, 1);

      kc2.set(blobFor('v1acc@example.com', 'older'));
      const act = activateAgySession(paths2, a1, {}, deps2);
      assert.equal(act.ok, true);

      // Rename preserves encryption and re-binds AAD cleanly
      renameSessionFilesForAlias(paths2, 'v1acc', 'v1acc-renamed', deps2);
      const renamedRaw = JSON.parse(fs.readFileSync(path.join(paths2.agySessionsDir, 'v1acc-renamed.json'), 'utf8'));
      assert.equal(renamedRaw.version, 2);
      assert.equal(renamedRaw.alias, 'v1acc-renamed');
      const actRenamed = activateAgySession(paths2, { alias: 'v1acc-renamed', email: 'v1acc@example.com' }, {}, deps2);
      assert.equal(actRenamed.ok, true);
    } finally {
      db.close();
    }
  });

  it('creates and restores passphrase-encrypted portable backups including agy sessions', () => {
    const osHome = mkTemp();
    const srcPaths = resolvePaths(mkTemp());
    const dstPaths = resolvePaths(mkTemp());
    const kcSrc = makeFakeKeychain(blobFor('port1@example.com'));
    const kcDst = makeFakeKeychain();
    const depsSrc = { osHome, securityRun: kcSrc.run, listClients: () => [] };
    const depsDst = { osHome, securityRun: kcDst.run, listClients: () => [] };

    const srcDb = new PoolDB(srcPaths);
    const dstDb = new PoolDB(dstPaths);
    try {
      const a1 = srcDb.createAccount({ alias: 'port1', email: 'port1@example.com', tags: ['pro'] });
      captureAgySession(srcPaths, a1, { ...depsSrc, encrypt: true });

      const bundle = encryptBackupBundle(
        { metadata: srcDb.exportMetadata(), agy_sessions: exportDecryptedSessions(srcPaths, depsSrc) },
        'my-strong-passphrase',
        true,
      );
      assert.equal(isEncryptedBackupBundle(bundle), true);
      assert.equal(bundle.includes_sessions, true);

      // Wrong passphrase fails clearly
      assert.throws(() => decryptBackupBundle(bundle, 'wrong-pass'), /Sai mật khẩu/);

      // Restore on fresh destination machine with its OWN Keychain master key
      const dec = decryptBackupBundle<{
        metadata: ReturnType<PoolDB['exportMetadata']>;
        agy_sessions: ReturnType<typeof exportDecryptedSessions>;
      }>(bundle, 'my-strong-passphrase');
      const metaRes = dstDb.importMetadata(dec.metadata);
      assert.equal(metaRes.created, 1);
      const sesRes = importSessionsFromBackup(dstPaths, dec.agy_sessions, { ...depsDst, encrypt: true });
      assert.equal(sesRes.imported, 1);
      assert.equal(sesRes.encrypted, 1);

      const actDst = activateAgySession(dstPaths, dstDb.getAccount('port1')!, {}, depsDst);
      assert.equal(actDst.ok, true);
      assert.ok(kcDst.current() !== undefined);
    } finally {
      srcDb.close();
      dstDb.close();
    }
  });

  it('extracts Google OAuth URLs and automates onboarding capture when Keychain updates', async () => {
    const extracted = extractGoogleOAuthUrl(
      'Open this link:\n  \x1b[36mhttps://accounts.google.com/o/oauth2/v2/auth?client_id=123&scope=email\x1b[0m.\nDone.',
    );
    assert.equal(extracted, 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123&scope=email');

    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeFakeKeychain(blobFor('old@example.com'));
    const agyDeps = { osHome, securityRun: kc.run, listClients: () => [] };
    const db = new PoolDB(paths);
    const openedOAuth: string[] = [];

    try {
      const acc = db.createAccount({ alias: 'newpro', email: 'newpro@example.com' });
      const switcher = new PoolSwitcher({
        db,
        paths,
        openWindowFn: async (opts) => {
          openedOAuth.push(...opts.urls);
          return { pid: 1 };
        },
      });

      let clipText = '';
      setTimeout(() => {
        clipText = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=onboard-test';
      }, 60);
      setTimeout(() => {
        kc.set(blobFor('newpro@example.com'));
      }, 140);

      const res = await onboardSingleAccount({
        db,
        paths,
        account: acc,
        switcher,
        watchClipboard: true,
        readClipboardFn: async () => clipText,
        pollMs: 30,
        timeoutMs: 2000,
        encrypt: true,
        agyDeps,
      });

      assert.equal(res.ok, true);
      assert.equal(res.capture?.encrypted, true);
      assert.equal(res.oauthUrlsOpened.length, 1);
      assert.ok(openedOAuth[0].includes('client_id=onboard-test'));

      // Also verify waitForKeychainAccount directly
      const w = await waitForKeychainAccount({
        targetEmail: 'newpro@example.com',
        previousSha: null,
        allowExistingMatch: true,
        timeoutMs: 500,
        pollMs: 20,
        agyDeps,
      });
      assert.equal(w.matched, true);
    } finally {
      db.close();
    }
  });

  it('computes pool analytics, exposes MCP pool_analytics, and serves Phase 3 HTTP endpoints', async () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeFakeKeychain(blobFor('an1@example.com'));
    const agyDeps = { osHome, securityRun: kc.run, listClients: () => [] };
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

    try {
      const a1 = db.createAccount({ alias: 'an1', email: 'an1@example.com' });
      const a2 = db.createAccount({ alias: 'an2', email: 'an2@example.com' });
      db.updateSessionStatus(a1.id, 'live');
      db.updateSessionStatus(a2.id, 'live');
      captureAgySession(paths, a1, { ...agyDeps, encrypt: true });
      db.setActiveAccount('an1');
      db.setBucketCooldown('an1', 'claude', new Date(Date.now() + 3_600_000).toISOString(), 'quota hit');

      const report = computePoolAnalytics(db, paths, { days: 7 });
      assert.equal(report.window_days, 7);
      assert.equal(report.daily.length, 7);
      assert.equal(report.summary.total_accounts, 2);
      assert.equal(report.summary.agy_captured_accounts, 1);
      assert.equal(report.summary.agy_encrypted_accounts, 1);
      assert.equal(report.summary.quota_hits_window, 1);

      const authHeaders = { Authorization: `Bearer ${srv.authToken}` };

      // HTTP /api/analytics
      const httpRes = await fetch(`${base}/api/analytics?days=7`, { headers: authHeaders });
      assert.equal(httpRes.status, 200);
      const httpJson = (await httpRes.json()) as { ok: boolean; summary: { total_accounts: number } };
      assert.equal(httpJson.ok, true);
      assert.equal(httpJson.summary.total_accounts, 2);

      // HTTP encrypted export & import
      const expRes = await fetch(`${base}/api/export/encrypted`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: 'secret-backup-key', withSessions: false }),
      });
      assert.equal(expRes.status, 200);
      const expJson = (await expRes.json()) as { ok: boolean; bundle: unknown };
      assert.equal(isEncryptedBackupBundle(expJson.bundle), true);

      const impRes = await fetch(`${base}/api/import/encrypted`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: 'secret-backup-key', bundle: expJson.bundle }),
      });
      assert.equal(impRes.status, 200);

      // MCP pool_analytics tool
      const mcp = createMcpHandler({ paths, agyDeps, notifyDaemon: false });
      const mcpRes = await mcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'pool_analytics', arguments: { days: 7 } },
      });
      const parsed = JSON.parse(
        (mcpRes?.result as { content: Array<{ text: string }> }).content[0].text,
      ) as { ok: boolean; summary: { agy_encrypted_accounts: number } };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.summary.agy_encrypted_accounts, 1);
    } finally {
      keepalive.stop();
      await srv.stop();
      db.close();
    }
  });
});
