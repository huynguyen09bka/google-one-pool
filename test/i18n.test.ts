import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_HOST, getDefaultSettings, resolvePaths, validateLocale } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import { getCommandHelpText, getMainHelpText, resolveLocale } from '../src/i18n.ts';
import { KeepAliveScheduler } from '../src/keepalive.ts';
import { createDaemonServer } from '../src/server.ts';
import { PoolSwitcher } from '../src/switcher.ts';
import { displayWidth, renderTuiFrame, stripAnsi, type TuiState } from '../src/tui.ts';

describe('Bilingual i18n (English & Vietnamese)', () => {
  const tempDirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-i18n-'));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('validates and resolves locales and persists language in PoolDB settings', () => {
    assert.equal(validateLocale('en'), 'en');
    assert.equal(validateLocale('en-US'), 'en');
    assert.equal(validateLocale('vi'), 'vi');
    assert.equal(validateLocale('vi_VN'), 'vi');
    assert.throws(() => validateLocale('fr'), /Unsupported language/);

    assert.equal(resolveLocale('en', 'vi'), 'en');
    assert.equal(resolveLocale(undefined, 'en'), 'en');

    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    try {
      assert.equal(db.getSettings().language, 'vi');
      db.updateSettings({ language: 'en' });
      assert.equal(db.getSettings().language, 'en');
    } finally {
      db.close();
    }
  });

  it('provides full CLI help and TUI rendering in both English and Vietnamese', () => {
    assert.ok(getMainHelpText('en').includes('Multi-account Google AI Pro manager'));
    assert.ok(getMainHelpText('vi').includes('Quản lý nhiều tài khoản Google AI Pro'));
    assert.ok(getCommandHelpText('en', 'agy')?.includes('Smart Auto-Failover Wrapper'));
    assert.ok(getCommandHelpText('vi', 'agy')?.includes('Smart Auto-Failover Wrapper cho agy CLI'));

    const makeState = (locale: 'en' | 'vi'): TuiState => ({
      locale,
      snapshot: {
        daemonOnline: true,
        accounts: [],
        activeAlias: null,
        summary: { total: 0, ready: 0, cooldown: 0, needs_login: 0, unknown: 0, error: 0 },
        keepalive: { running: true, sweeping: false, activeProbes: [], lastSweepAt: null },
        settings: { ...getDefaultSettings(), language: locale },
        events: [],
        agyStatus: null,
      },
      selectedIndex: 0,
      scrollOffset: 0,
      filterStatus: 'all',
      searchQuery: '',
      searchActive: false,
      busyMessage: null,
      notice: null,
      modal: null,
    });

    const enLines = renderTuiFrame(makeState('en'), 100, 26);
    const enPlain = enLines.map(stripAnsi).join('\n');
    assert.ok(enPlain.includes('TUI [EN]'));
    assert.ok(enPlain.includes('Accounts (0)'));
    assert.ok(enPlain.includes('STATUS'));
    for (const line of enLines) assert.ok(displayWidth(line) <= 100);

    const viLines = renderTuiFrame(makeState('vi'), 100, 26);
    const viPlain = viLines.map(stripAnsi).join('\n');
    assert.ok(viPlain.includes('TUI [VI]'));
    assert.ok(viPlain.includes('Danh sách tài khoản (0)'));
    assert.ok(viPlain.includes('TRẠNG THÁI'));
    for (const line of viLines) assert.ok(displayWidth(line) <= 100);
  });

  it('serves /i18n.js and persists language updates via Daemon HTTP API', async () => {
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

    try {
      const i18nRes = await fetch(`${base}/i18n.js`);
      assert.equal(i18nRes.status, 200);
      const jsText = await i18nRes.text();
      assert.ok(jsText.includes('applyStaticI18n'));

      const patchRes = await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'en' }),
      });
      assert.equal(patchRes.status, 200);
      const patched = (await patchRes.json()) as { settings: { language: string } };
      assert.equal(patched.settings.language, 'en');
    } finally {
      keepalive.stop();
      await srv.stop();
      db.close();
    }
  });
});
