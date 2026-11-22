import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';

function createTempPool(): { homeDir: string; db: PoolDB } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-db-test-'));
  const paths = resolvePaths(homeDir);
  const db = new PoolDB(paths);
  return { homeDir, db };
}

describe('PoolDB', () => {
  const tempDirs: string[] = [];
  let db: PoolDB;
  let homeDir: string;

  beforeEach(() => {
    const created = createTempPool();
    homeDir = created.homeDir;
    db = created.db;
    tempDirs.push(homeDir);
  });

  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initializes schema with strict file permissions (0700 dir, 0600 db)', () => {
    const paths = resolvePaths(homeDir);
    const homeMode = fs.statSync(paths.homeDir).mode & 0o777;
    const dbMode = fs.statSync(paths.dbPath).mode & 0o777;
    assert.equal(homeMode, 0o700);
    assert.equal(dbMode, 0o600);
    db.close();
  });

  it('validates account fields and rejects duplicates or malformed inputs', () => {
    const acc = db.createAccount({
      alias: 'Pro_One',
      email: 'ProOne@Gmail.com',
      tags: ['Pro', 'work', 'pro'],
      renewal_date: '2026-12-31',
      proxy_url: 'http://127.0.0.1:8080',
    });

    assert.equal(acc.alias, 'pro_one');
    assert.equal(acc.email, 'proone@gmail.com');
    assert.deepEqual(acc.tags, ['pro', 'work']);
    assert.ok(fs.existsSync(acc.chrome_profile_dir));

    assert.throws(() => db.createAccount({ alias: 'pro_one', email: 'other@gmail.com' }), /đã tồn tại/);
    assert.throws(() => db.createAccount({ alias: 'pro_two', email: 'PROONE@gmail.com' }), /đã tồn tại/);
    assert.throws(() => db.createAccount({ alias: 'bad alias!', email: 'a@b.com' }), /Alias không hợp lệ/);
    assert.throws(
      () => db.createAccount({ alias: 'ok', email: 'a@b.com', proxy_url: 'ftp://127.0.0.1:21' }),
      /Giao thức proxy không hỗ trợ/,
    );
    assert.throws(
      () => db.createAccount({ alias: 'ok', email: 'a@b.com', renewal_date: '2026-02-30' }),
      /không tồn tại/,
    );
    db.close();
  });

  it('keeps at most one active account and updates usage stats', () => {
    db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    db.createAccount({ alias: 'a2', email: 'a2@example.com' });

    const first = db.setActiveAccount('a1');
    assert.equal(first.previous, null);
    assert.equal(first.active.is_active, true);
    assert.equal(first.active.use_count, 1);
    assert.ok(first.active.last_used_at);

    const second = db.setActiveAccount('a2');
    assert.equal(second.previous?.alias, 'a1');
    assert.equal(second.active.alias, 'a2');

    assert.equal(db.getAccount('a1')?.is_active, false);
    assert.equal(db.getAccount('a2')?.is_active, true);
    db.close();
  });

  it('sets, clears, and auto-expires cooldowns', () => {
    db.createAccount({ alias: 'acc1', email: 'acc1@example.com' });
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const cooled = db.setCooldown('acc1', futureIso, 'Hết quota');
    assert.equal(db.computeAccountView(cooled).effective_state, 'cooldown');
    assert.ok(db.computeAccountView(cooled).cooldown_remaining_ms > 0);

    const pastIso = new Date(Date.now() - 10_000).toISOString();
    db.setCooldown('acc1', pastIso, 'Đã qua hạn');
    const expired = db.expireElapsedCooldowns();
    assert.deepEqual(expired, ['acc1']);
    assert.equal(db.getAccount('acc1')?.cooldown_until, null);

    db.setCooldown('acc1', futureIso, 'Manual');
    db.clearCooldown('acc1');
    assert.equal(db.getAccount('acc1')?.cooldown_until, null);
    db.close();
  });

  it('picks next ready account respecting cooldown, status, live preference, LRU, and tag filter', () => {
    db.createAccount({ alias: 'acc_needs', email: 'needs@example.com', tags: ['pro'] });
    db.createAccount({ alias: 'acc_cool', email: 'cool@example.com', tags: ['pro'] });
    db.createAccount({ alias: 'acc_unknown', email: 'unk@example.com', tags: ['pro'] });
    db.createAccount({ alias: 'acc_live_old', email: 'old@example.com', tags: ['pro', 'work'] });
    db.createAccount({ alias: 'acc_live_new', email: 'new@example.com', tags: ['pro'] });

    db.updateSessionStatus('acc_needs', 'needs_login', 'expired');
    db.updateSessionStatus('acc_cool', 'live', 'ok');
    db.setCooldown('acc_cool', new Date(Date.now() + 3_600_000).toISOString(), 'quota');

    // Mark acc_live_new as used recently, then acc_live_old as never used.
    db.updateSessionStatus('acc_live_new', 'live', 'ok');
    db.setActiveAccount('acc_live_new');
    db.updateSessionStatus('acc_live_old', 'live', 'ok');

    // Excluding acc_live_new should pick acc_live_old (live + never used, ahead of acc_unknown).
    const pick1 = db.pickNextReadyAccount({ excludeAlias: 'acc_live_new' });
    assert.equal(pick1?.alias, 'acc_live_old');

    // Tag filter 'work' only matches acc_live_old.
    const pickWork = db.pickNextReadyAccount({ tag: 'work' });
    assert.equal(pickWork?.alias, 'acc_live_old');

    // Tag filter 'missing' returns null.
    assert.equal(db.pickNextReadyAccount({ tag: 'missing' }), null);
    db.close();
  });

  it('exports and idempotently imports metadata without touching profiles', () => {
    db.createAccount({
      alias: 'acc1',
      email: 'acc1@example.com',
      tags: ['pro'],
      notes: 'Primary account',
    });
    const exported = db.exportMetadata();
    assert.equal(exported.accounts.length, 1);
    assert.equal(exported.accounts[0].alias, 'acc1');

    // Import onto same DB updates existing without duplicating, plus adds new one.
    exported.accounts[0].notes = 'Updated note';
    exported.accounts.push({
      alias: 'acc2',
      email: 'acc2@example.com',
      display_name: 'Backup',
      plan_tier: 'Google AI Pro',
      renewal_date: '2026-12-31',
      tags: ['backup'],
      notes: '',
      proxy_url: null,
      adc_credentials_path: null,
    });

    const res = db.importMetadata(exported);
    assert.equal(res.created, 1);
    assert.equal(res.updated, 1);
    assert.equal(db.getAccount('acc1')?.notes, 'Updated note');
    assert.equal(db.getAccount('acc2')?.email, 'acc2@example.com');
    db.close();
  });

  it('migrates legacy accounts tables and safely manages linked -> isolated graduation without deleting linked dirs', () => {
    db.close();

    // Create a legacy pool.db without the 4 linked-profile columns.
    const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-legacy-db-'));
    const fakeChromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-fake-chrome-'));
    const linkedProfileDir = path.join(fakeChromeRoot, 'Default');
    fs.mkdirSync(linkedProfileDir, { recursive: true });
    fs.writeFileSync(path.join(linkedProfileDir, 'Preferences'), '{}');
    tempDirs.push(legacyHome, fakeChromeRoot);

    const legacyPaths = resolvePaths(legacyHome);
    fs.mkdirSync(legacyPaths.homeDir, { recursive: true, mode: 0o700 });
    const rawDb = new DatabaseSync(legacyPaths.dbPath);
    rawDb.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alias TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        plan_tier TEXT NOT NULL DEFAULT 'Google AI Pro',
        renewal_date TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        proxy_url TEXT,
        adc_credentials_path TEXT,
        chrome_profile_dir TEXT NOT NULL,
        session_status TEXT NOT NULL DEFAULT 'unknown',
        session_detail TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        cooldown_reason TEXT,
        last_checked_at TEXT,
        last_live_at TEXT,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO accounts (alias, email, chrome_profile_dir, created_at, updated_at)
      VALUES ('old1', 'old1@gmail.com', '/tmp/old1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    rawDb.close();

    const migratedDb = new PoolDB(legacyPaths);
    const oldAcc = migratedDb.getAccount('old1');
    assert.ok(oldAcc);
    assert.equal(oldAcc.profile_mode, 'isolated');
    assert.equal(oldAcc.chrome_profile_name, null);

    // Create linked account pointing to fakeChromeRoot/Default.
    const linked = migratedDb.createAccount({
      alias: 'linked1',
      email: 'linked1@gmail.com',
      profile_mode: 'linked',
      chrome_user_data_dir: fakeChromeRoot,
      chrome_profile_name: 'Default',
      initial_session_status: 'live',
      initial_session_detail: 'Sẵn có từ Chrome',
    });
    assert.equal(linked.profile_mode, 'linked');
    assert.equal(linked.session_status, 'live');
    assert.equal(linked.google_authuser, 'linked1@gmail.com');

    // Deleting a linked account with purgeProfile=true MUST NEVER delete the browser's directory.
    const linked2 = migratedDb.createAccount({
      alias: 'linked2',
      email: 'linked2@gmail.com',
      profile_mode: 'linked',
      chrome_user_data_dir: fakeChromeRoot,
      chrome_profile_name: 'Default',
    });
    migratedDb.deleteAccount(linked2.alias, { purgeProfile: true });
    assert.equal(fs.existsSync(linkedProfileDir), true);

    // Graduate linked1 -> isolated.
    const isolated = migratedDb.isolateAccount('linked1');
    assert.equal(isolated.profile_mode, 'isolated');
    assert.equal(isolated.chrome_user_data_dir, null);
    assert.equal(isolated.chrome_profile_name, null);
    assert.equal(isolated.session_status, 'unknown');
    assert.ok(isolated.chrome_profile_dir.startsWith(legacyPaths.chromeProfilesDir));
    assert.equal(fs.existsSync(isolated.chrome_profile_dir), true);

    // Create two more linked accounts and test isolateAllLinkedAccounts.
    migratedDb.createAccount({
      alias: 'linked3',
      email: 'linked3@gmail.com',
      profile_mode: 'linked',
      chrome_user_data_dir: fakeChromeRoot,
      chrome_profile_name: 'Default',
    });
    migratedDb.createAccount({
      alias: 'linked4',
      email: 'linked4@gmail.com',
      profile_mode: 'linked',
      chrome_user_data_dir: fakeChromeRoot,
      chrome_profile_name: 'Default',
    });
    const batchIsolated = migratedDb.isolateAllLinkedAccounts();
    assert.deepEqual(
      batchIsolated.map((a) => a.alias).sort(),
      ['linked3', 'linked4'],
    );
    assert.equal(migratedDb.getAccount('linked3')?.profile_mode, 'isolated');
    assert.equal(migratedDb.getAccount('linked4')?.profile_mode, 'isolated');

    migratedDb.close();
  });
});
