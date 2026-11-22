import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  activateAgySession,
  captureAgySession,
  deleteSessionFilesForAlias,
  exportDecryptedSessions,
  getAgySessionStatus,
  getLiveKeychainContext,
  hasSessionSnapshot,
  renameSessionFilesForAlias,
  sessionInfoForAlias,
  type SecurityRunResult,
} from '../src/agysession.ts';
import { resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';

function tokenizeInteractiveLine(line: string): string[] {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return tokens;
}

/**
 * Mô phỏng `/usr/bin/security` cho item generic password "gemini"/"antigravity"
 * bằng Map trong RAM — không đụng keychain thật.
 */
function makeFakeKeychain(initial?: Buffer) {
  const store = new Map<string, Buffer>();
  if (initial) store.set('gemini\0antigravity', Buffer.from(initial));
  const run = (args: string[], stdin?: string): SecurityRunResult => {
    const tokens = args[0] === '-i' && stdin ? tokenizeInteractiveLine(stdin.trim()) : args;
    const val = (flag: string) => tokens[tokens.indexOf(flag) + 1];
    if (tokens[0] === 'find-generic-password') {
      const blob = store.get(`${val('-s')}\0${val('-a')}`);
      if (!blob) {
        return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from('could not be found') };
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
  const current = () => store.get('gemini\0antigravity');
  const set = (b: Buffer | string) => store.set('gemini\0antigravity', Buffer.from(b));
  return { run, current, set };
}

// Format thật mà go-keyring ghi vào keychain: "go-keyring-base64:<b64(JSON)>"
// với JSON trong chứa token{...} + id_token_email.
function blobFor(email: string, tag = ''): Buffer {
  const inner = Buffer.from(
    JSON.stringify({
      token: {
        access_token: `ya29.${tag || email.split('@')[0]}`,
        refresh_token: `rt-${tag || email.split('@')[0]}`,
        token_type: 'Bearer',
        expiry: '2026-12-31T00:00:00Z',
      },
      auth_method: 'consumer',
      id_token_email: email,
    }),
    'utf8',
  );
  return Buffer.from(`go-keyring-base64:${inner.toString('base64')}`, 'utf8');
}

// Lấy email từ blob để assert — decode cùng cách production.
function emailOf(blob: Buffer): string {
  const o = JSON.parse(Buffer.from(blob.toString('utf8').slice(18), 'base64').toString('utf8'));
  return o.id_token_email;
}

function makeDeps(opts: { home: string; kc: ReturnType<typeof makeFakeKeychain>; clients?: string[] }) {
  return {
    osHome: opts.home,
    securityRun: opts.kc.run,
    listClients: () => opts.clients ?? [],
  };
}

function seedOsHome(home: string) {
  const scopeFile = path.join(home, 'Library', 'Application Support', 'Antigravity', 'credential-user-scope');
  fs.mkdirSync(path.dirname(scopeFile), { recursive: true });
  fs.writeFileSync(scopeFile, 'u-scope-AAA');
  const secretsDir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, 'antigravity-oauth-token'), '{"token":"file-token"}');
}

function readScope(home: string): string | null {
  try {
    return fs.readFileSync(path.join(home, 'Library', 'Application Support', 'Antigravity', 'credential-user-scope'), 'utf8');
  } catch {
    return null;
  }
}

describe('agysession', () => {
  const tempDirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-agy-'));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('capture fails when keychain has no agy item', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain();
    const db = new PoolDB(resolvePaths(poolHome));
    const acc = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    assert.throws(() => captureAgySession(resolvePaths(poolHome), acc, makeDeps({ home, kc })), /Chưa thấy phiên agy/);
    db.close();
  });

  it('capture stores snapshot, marker, scope + extra files, and detects email', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    seedOsHome(home);
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const acc = db.createAccount({ alias: 'a1', email: 'a1@example.com' });

    const res = captureAgySession(paths, acc, makeDeps({ home, kc }));
    assert.equal(res.detected_email, 'a1@example.com');
    assert.equal(res.encrypted, true);
    assert.equal(hasSessionSnapshot(paths, 'a1'), true);

    const onDisk = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, 'a1.json'), 'utf8'));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.encrypted, true);
    assert.equal(onDisk.keychain_blob_b64, undefined);

    const [snap] = exportDecryptedSessions(paths, makeDeps({ home, kc }));
    assert.equal(snap.user_scope, 'u-scope-AAA');
    assert.ok(snap.extra_files['antigravity-oauth-token']);
    const marker = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, '_active.json'), 'utf8'));
    assert.equal(marker.alias, 'a1');
    db.close();
  });

  it('capture refuses when blob email belongs to another account', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain(blobFor('other@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const acc = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    assert.throws(() => captureAgySession(paths, acc, makeDeps({ home, kc })), /other@example\.com/);
    assert.equal(hasSessionSnapshot(paths, 'a1'), false);
    db.close();
  });

  it('activate writes target blob + scope and refuses while agy is running', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    seedOsHome(home);
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    const a2 = db.createAccount({ alias: 'a2', email: 'a2@example.com' });

    captureAgySession(paths, a1, makeDeps({ home, kc }));
    kc.set(blobFor('a2@example.com'));
    fs.writeFileSync(path.join(home, 'Library', 'Application Support', 'Antigravity', 'credential-user-scope'), 'u-scope-BBB');
    captureAgySession(paths, a2, makeDeps({ home, kc }));

    // agy đang chạy -> từ chối
    assert.throws(
      () => activateAgySession(paths, a1, {}, makeDeps({ home, kc, clients: ['agy CLI (PID 1)'] })),
      /tiến trình agy/i,
    );
    // force vẫn cho qua
    const forced = activateAgySession(paths, a1, { force: true }, makeDeps({ home, kc, clients: ['agy'] }));
    assert.equal(forced.ok, true);

    const res = activateAgySession(paths, a1, {}, makeDeps({ home, kc }));
    assert.equal(res.ok, true);
    assert.equal(emailOf(kc.current()!), 'a1@example.com');
    assert.equal(readScope(home), 'u-scope-AAA');
    const marker = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, '_active.json'), 'utf8'));
    assert.equal(marker.alias, 'a1');
    db.close();
  });

  it('activate re-captures refreshed blob into the outgoing account', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    seedOsHome(home);
    const kc = makeFakeKeychain(blobFor('a1@example.com', 'v1'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    const a2 = db.createAccount({ alias: 'a2', email: 'a2@example.com' });

    // a2 được capture trước, rồi a1 -> marker đang trỏ a1
    kc.set(blobFor('a2@example.com', 'v1'));
    captureAgySession(paths, a2, makeDeps({ home, kc }));
    kc.set(blobFor('a1@example.com', 'v1'));
    captureAgySession(paths, a1, makeDeps({ home, kc }));
    // agy refresh token của a1 -> blob mới cùng email, sha khác snapshot
    kc.set(blobFor('a1@example.com', 'v2'));

    const res = activateAgySession(paths, a2, {}, makeDeps({ home, kc }));
    // chủ hiện tại = a1 theo marker -> recapture blob mới vào a1 (vẫn mã hóa AES-256-GCM)
    assert.equal(res.recaptured_alias, 'a1');
    const onDiskA1 = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, 'a1.json'), 'utf8'));
    assert.equal(onDiskA1.version, 2);
    assert.equal(onDiskA1.encrypted, true);
    const decryptedA1 = exportDecryptedSessions(paths, makeDeps({ home, kc })).find((s) => s.alias === 'a1');
    assert.ok(decryptedA1?.keychain_blob_b64 === Buffer.from(blobFor('a1@example.com', 'v2')).toString('base64'));
    assert.equal(emailOf(kc.current()!), 'a2@example.com');
    db.close();
  });

  it('activate saves unknown current blob to _orphan instead of losing it', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    seedOsHome(home);
    const kc = makeFakeKeychain(blobFor('stranger@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    // capture a1 bằng cách set blob a1 rồi capture, sau đó trả blob stranger
    kc.set(blobFor('a1@example.com'));
    captureAgySession(paths, a1, makeDeps({ home, kc }));
    kc.set(blobFor('stranger@example.com'));

    const res = activateAgySession(paths, a1, {}, makeDeps({ home, kc }));
    assert.equal(res.orphan_saved, true);
    const orphan = JSON.parse(fs.readFileSync(path.join(paths.agySessionsDir, '_orphan.json'), 'utf8'));
    assert.equal(orphan.detected_email, 'stranger@example.com');
    db.close();
  });

  it('status reports live owner and session list', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    db.createAccount({ alias: 'a2', email: 'a2@example.com' });
    captureAgySession(paths, a1, makeDeps({ home, kc }));

    const st = getAgySessionStatus(paths, makeDeps({ home, kc }));
    assert.equal(st.keychain_present, true);
    assert.equal(st.live_owner_alias, 'a1');
    assert.equal(st.sessions.length, 1);
    assert.equal(st.sessions[0].is_live, true);
    db.close();
  });

  it('deleteSessionFilesForAlias removes snapshot and clears marker', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    captureAgySession(paths, a1, makeDeps({ home, kc }));

    deleteSessionFilesForAlias(paths, 'a1');
    assert.equal(hasSessionSnapshot(paths, 'a1'), false);
    assert.throws(() => fs.readFileSync(path.join(paths.agySessionsDir, '_active.json')));
    db.close();
  });

  it('recognizes live owner even after access token refresh changes blob sha256', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain(blobFor('a1@example.com', 'v1'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    captureAgySession(paths, a1, makeDeps({ home, kc }));

    // Simulate agy refreshing access_token in Keychain -> different sha, same email
    kc.set(blobFor('a1@example.com', 'v2-refreshed'));

    const ctx = getLiveKeychainContext(paths, makeDeps({ home, kc }));
    assert.equal(ctx.present, true);
    assert.equal(ctx.live_owner_alias, 'a1');
    assert.equal(ctx.live_unknown, false);

    const st = getAgySessionStatus(paths, makeDeps({ home, kc }));
    assert.equal(st.live_owner_alias, 'a1');
    assert.equal(st.sessions[0].is_live, true);

    const info = sessionInfoForAlias(paths, 'a1', ctx.live_sha, ctx.marker_alias, ctx.live_owner_alias);
    assert.equal(info?.is_live_owner, true);

    // Stranger email in Keychain must NOT falsely match marker alias
    kc.set(blobFor('stranger@example.com', 'v1'));
    const strangerCtx = getLiveKeychainContext(paths, makeDeps({ home, kc }));
    assert.equal(strangerCtx.live_owner_alias, null);
    assert.equal(strangerCtx.live_unknown, true);
    db.close();
  });

  it('preserves agy session snapshot and active marker when renaming alias', () => {
    const home = mkTemp();
    const poolHome = mkTemp();
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const paths = resolvePaths(poolHome);
    const db = new PoolDB(paths);
    const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    captureAgySession(paths, a1, { ...makeDeps({ home, kc }), encrypt: false });

    db.updateAccount('a1', { alias: 'pro-main' });
    assert.equal(hasSessionSnapshot(paths, 'a1'), false);
    assert.equal(hasSessionSnapshot(paths, 'pro-main'), true);

    const ctx = getLiveKeychainContext(paths, makeDeps({ home, kc }));
    assert.equal(ctx.live_owner_alias, 'pro-main');
    assert.equal(ctx.marker_alias, 'pro-main');

    renameSessionFilesForAlias(paths, 'pro-main', 'pro-main');
    assert.equal(hasSessionSnapshot(paths, 'pro-main'), true);
    db.close();
  });
});
