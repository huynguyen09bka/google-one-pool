import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import {
  computeNextCheckDelayMs,
  isAccountDueForCheck,
  KeepAliveScheduler,
} from '../src/keepalive.ts';

describe('KeepAliveScheduler', () => {
  const tempDirs: string[] = [];

  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes jittered intervals within bounds and checks due accounts', () => {
    assert.equal(computeNextCheckDelayMs(100, 20, () => 0), 80 * 60_000);
    assert.equal(computeNextCheckDelayMs(100, 20, () => 1), 120 * 60_000);
    assert.equal(computeNextCheckDelayMs(100, 20, () => 0.5), 100 * 60_000);

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-ka-due-'));
    tempDirs.push(homeDir);
    const db = new PoolDB(resolvePaths(homeDir));
    const acc = db.createAccount({ alias: 'a1', email: 'a1@example.com' });
    assert.equal(isAccountDueForCheck(acc, 60_000, Date.now()), true);

    const checked = db.updateSessionStatus('a1', 'live', 'ok', new Date(100_000));
    assert.equal(isAccountDueForCheck(checked, 60_000, 130_000), false);
    assert.equal(isAccountDueForCheck(checked, 60_000, 170_000), true);
    db.close();
  });

  it('probes accounts strictly serially, notifies on live->needs_login, and preserves live on skipped_open', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-ka-serial-'));
    tempDirs.push(homeDir);
    const db = new PoolDB(resolvePaths(homeDir));

    db.createAccount({ alias: 'acc1', email: 'acc1@example.com' });
    db.createAccount({ alias: 'acc2', email: 'acc2@example.com' });
    db.createAccount({ alias: 'acc3', email: 'acc3@example.com' });

    // acc1 was previously live; now expires.
    db.updateSessionStatus('acc1', 'live', 'was live');
    // acc2 was previously live; now open in Chrome so skipped.
    db.updateSessionStatus('acc2', 'live', 'was live');

    let inFlight = 0;
    let maxInFlight = 0;
    const notifications: Array<{ title: string; message: string }> = [];

    const scheduler = new KeepAliveScheduler({
      db,
      staggerDelayMs: 5,
      probeFn: async (account) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;

        if (account.alias === 'acc1') {
          return { status: 'needs_login', detail: 'Session expired' };
        }
        if (account.alias === 'acc2') {
          return { status: 'skipped_open', detail: 'Chrome đang mở' };
        }
        return { status: 'live', detail: 'Active session' };
      },
      notifyFn: async (title, message) => {
        notifications.push({ title, message });
      },
    });

    const results = await scheduler.sweepAll();
    assert.equal(results.length, 3);
    assert.equal(maxInFlight, 1);

    assert.equal(db.getAccount('acc1')?.session_status, 'needs_login');
    assert.equal(db.getAccount('acc2')?.session_status, 'live');
    assert.equal(db.getAccount('acc3')?.session_status, 'live');

    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].message.includes('acc1'));

    const events = db.listEvents(20);
    assert.ok(events.some((ev) => ev.event_type === 'session_expired' && ev.account_alias === 'acc1'));
    db.close();
  });
});
