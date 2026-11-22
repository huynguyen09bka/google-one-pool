import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { BrowserScanRoot } from '../src/browser-import.ts';
import { decorateUrlForAccount } from '../src/chrome.ts';
import { DEFAULT_HOST, resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import { KeepAliveScheduler } from '../src/keepalive.ts';
import { createDaemonServer } from '../src/server.ts';
import { PoolSwitcher } from '../src/switcher.ts';

describe('Daemon HTTP Server', () => {
  const cleanups: Array<() => Promise<void>> = [];

  after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
  });

  async function startTestServer(discoverRoots?: BrowserScanRoot[]) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-server-test-'));
    const paths = resolvePaths(homeDir);
    const db = new PoolDB(paths);
    const openedCalls: Array<{
      profileDir: string;
      urls: string[];
      profileMode?: string;
      chromeProfileName?: string | null;
      googleAuthuser?: string | null;
    }> = [];

    const switcher = new PoolSwitcher({
      db,
      paths,
      openWindowFn: async (opts) => {
        const effectiveUrls =
          opts.profileMode === 'linked'
            ? opts.urls.map((u) => decorateUrlForAccount(u, opts.googleAuthuser))
            : opts.urls;
        openedCalls.push({
          profileDir: opts.profileDir,
          urls: effectiveUrls,
          profileMode: opts.profileMode,
          chromeProfileName: opts.chromeProfileName,
          googleAuthuser: opts.googleAuthuser,
        });
        return { pid: 12345 };
      },
    });

    const keepalive = new KeepAliveScheduler({
      db,
      staggerDelayMs: 0,
      probeFn: async (acc) => ({
        status: acc.alias === 'expired' ? 'needs_login' : 'live',
        detail: acc.alias === 'expired' ? 'Expired' : 'OK',
      }),
      notifyFn: async () => {},
    });

    const serverHandle = createDaemonServer({
      db,
      switcher,
      keepalive,
      paths,
      host: DEFAULT_HOST,
      port: 0,
      discoverRoots,
    });

    const port = await serverHandle.start();
    const baseUrl = `http://${DEFAULT_HOST}:${port}`;

    cleanups.push(async () => {
      keepalive.stop();
      await serverHandle.stop();
      db.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    return {
      baseUrl,
      port,
      db,
      openedCalls,
      authToken: serverHandle.authToken,
      authHeaders: { Authorization: `Bearer ${serverHandle.authToken}` },
    };
  }

  it('serves dashboard static assets and enforces loopback Origin CSRF protection', async () => {
    const { baseUrl, port, authHeaders } = await startTestServer();

    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('Google One Pool'));

    const cssRes = await fetch(`${baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);

    const jsRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);

    const faviconRes = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(faviconRes.status, 200);
    assert.ok(faviconRes.headers.get('content-type')?.includes('image/svg+xml'));

    const evilPost = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ alias: 'evil', email: 'evil@example.com' }),
    });
    assert.equal(evilPost.status, 403);

    const localPost = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ alias: 'pro1', email: 'pro1@example.com' }),
    });
    assert.equal(localPost.status, 201);
  });

  it('handles full account lifecycle, switching, rotation, OAuth validation, cooldowns, keepalive, and export/import', async () => {
    const { baseUrl, openedCalls, authHeaders } = await startTestServer();

    for (const acc of [
      { alias: 'pro1', email: 'pro1@example.com', tags: ['pro', 'primary'] },
      { alias: 'pro2', email: 'pro2@example.com', tags: ['pro'] },
      { alias: 'expired', email: 'expired@example.com', tags: ['backup'] },
    ]) {
      const r = await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(acc),
      });
      assert.equal(r.status, 201);
    }

    const sweepRes = await fetch(`${baseUrl}/api/keepalive/sweep`, { method: 'POST', headers: authHeaders });
    assert.equal(sweepRes.status, 200);
    const sweepJson = (await sweepRes.json()) as { results: Array<{ alias: string; status: string }> };
    assert.equal(sweepJson.results.length, 3);

    const swRes = await fetch(`${baseUrl}/api/accounts/pro1/switch`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ openChrome: true }),
    });
    assert.equal(swRes.status, 200);
    const swJson = (await swRes.json()) as { active: { alias: string }; openedChrome: boolean };
    assert.equal(swJson.active.alias, 'pro1');
    assert.equal(swJson.openedChrome, true);

    const nextRes = await fetch(`${baseUrl}/api/pool/next`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cooldownHours: 5, openChrome: true }),
    });
    assert.equal(nextRes.status, 200);
    const nextJson = (await nextRes.json()) as { active: { alias: string } };
    assert.equal(nextJson.active.alias, 'pro2');

    const badOAuth = await fetch(`${baseUrl}/api/accounts/pro2/oauth`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthUrl: 'javascript:alert(1)' }),
    });
    assert.equal(badOAuth.status, 400);

    const goodOAuth = await fetch(`${baseUrl}/api/accounts/pro2/oauth`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test' }),
    });
    assert.equal(goodOAuth.status, 200);
    assert.ok(openedCalls.some((c) => c.urls[0].includes('accounts.google.com/o/oauth2')));

    const clearRes = await fetch(`${baseUrl}/api/accounts/pro1/cooldown`, { method: 'DELETE', headers: authHeaders });
    assert.equal(clearRes.status, 200);

    const exportRes = await fetch(`${baseUrl}/api/export`, { headers: authHeaders });
    assert.equal(exportRes.status, 200);
    const exported = await exportRes.json();

    const delRes = await fetch(`${baseUrl}/api/accounts/expired?purgeProfile=true`, { method: 'DELETE', headers: authHeaders });
    assert.equal(delRes.status, 200);

    const importRes = await fetch(`${baseUrl}/api/import`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(exported),
    });
    assert.equal(importRes.status, 200);
    const importJson = (await importRes.json()) as { created: number; updated: number };
    assert.equal(importJson.created, 1);
    assert.equal(importJson.updated, 2);
  });

  it('discovers and bulk-imports multi-login browser accounts in linked mode and graduates them via /isolate', async () => {
    const fakeChromeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-server-chrome-'));
    fs.mkdirSync(path.join(fakeChromeDir, 'Default'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeChromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Main', user_name: 'first@gmail.com', gaia_name: 'First' },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(fakeChromeDir, 'Default', 'Preferences'),
      JSON.stringify({
        account_info: [
          { email: 'first@gmail.com', full_name: 'First' },
          { email: 'second@gmail.com', full_name: 'Second' },
        ],
      }),
    );
    fs.writeFileSync(path.join(fakeChromeDir, 'Default', 'Cookies'), 'placeholder');

    cleanups.push(async () => {
      fs.rmSync(fakeChromeDir, { recursive: true, force: true });
    });

    const { baseUrl, openedCalls, authHeaders } = await startTestServer([
      {
        browser: 'Google Chrome',
        chromeBinary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: fakeChromeDir,
      },
    ]);

    const discoverRes = await fetch(`${baseUrl}/api/import/chrome/discover`, { headers: authHeaders });
    assert.equal(discoverRes.status, 200);
    const discoverJson = (await discoverRes.json()) as {
      discoveredAccounts: Array<{ email: string; suggestedAlias: string; hasCookies: boolean }>;
    };
    assert.equal(discoverJson.discoveredAccounts.length, 2);

    // Bulk import both discovered accounts in linked mode (plus a duplicate to verify dedup).
    const importRes = await fetch(`${baseUrl}/api/import/chrome`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'linked',
        chrome_user_data_dir: fakeChromeDir,
        chrome_profile_name: 'Default',
        tags: ['pro'],
        items: [
          { alias: 'first', email: 'first@gmail.com' },
          { alias: 'second', email: 'second@gmail.com' },
          { alias: 'dup', email: 'first@gmail.com' },
        ],
      }),
    });
    assert.equal(importRes.status, 200);
    const importJson = (await importRes.json()) as {
      created: Array<{ alias: string; profile_mode: string; session_status: string }>;
      skipped: Array<{ email: string }>;
    };
    assert.equal(importJson.created.length, 2);
    assert.equal(importJson.created[0].profile_mode, 'linked');
    assert.equal(importJson.created[0].session_status, 'live');
    assert.equal(importJson.skipped.length, 1);

    // Switching & OAuth on linked account decorates URLs with authuser / login_hint.
    await fetch(`${baseUrl}/api/accounts/second/switch`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ openChrome: true }),
    });
    await fetch(`${baseUrl}/api/accounts/second/oauth`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ oauthUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc' }),
    });

    const lastCall = openedCalls[openedCalls.length - 1];
    assert.equal(lastCall.profileMode, 'linked');
    assert.equal(lastCall.chromeProfileName, 'Default');
    assert.ok(lastCall.urls[0].includes('login_hint=second%40gmail.com'));
    assert.ok(lastCall.urls[0].includes('authuser=second%40gmail.com'));

    // Graduate second -> isolated.
    const isoRes = await fetch(`${baseUrl}/api/accounts/second/isolate`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ openChrome: true }),
    });
    assert.equal(isoRes.status, 200);
    const isoJson = (await isoRes.json()) as {
      account: { alias: string; profile_mode: string; session_status: string };
      openedUrl: string;
    };
    assert.equal(isoJson.account.profile_mode, 'isolated');
    assert.equal(isoJson.account.session_status, 'unknown');
    assert.ok(isoJson.openedUrl.includes('Email=second%40gmail.com'));
  });

  it('imports messy rawText Google Account Chooser copy-pastes via POST /api/import/chrome', async () => {
    const { baseUrl, authHeaders } = await startTestServer();
    const res = await fetch(`${baseUrl}/api/import/chrome`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'linked',
        chrome_profile_name: 'Default',
        tags: ['pro'],
        rawText: `
          Nguyen Huy
          raw1@gmail.com
          Đã đăng nhập
          Backup Acc
          raw2@gmail.com
          Signed in
        `,
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      created: Array<{ alias: string; email: string; display_name: string; profile_mode: string }>;
      errors: unknown[];
    };
    assert.equal(json.errors.length, 0);
    assert.equal(json.created.length, 2);
    assert.equal(json.created[0].email, 'raw1@gmail.com');
    assert.equal(json.created[0].display_name, 'Nguyen Huy');
    assert.equal(json.created[0].profile_mode, 'linked');
    assert.equal(json.created[1].email, 'raw2@gmail.com');
    assert.equal(json.created[1].display_name, 'Backup Acc');

    // Batch isolate all linked accounts via POST /api/accounts/isolate-all.
    const isoAllRes = await fetch(`${baseUrl}/api/accounts/isolate-all`, { method: 'POST', headers: authHeaders });
    assert.equal(isoAllRes.status, 200);
    const isoAllJson = (await isoAllRes.json()) as {
      ok: boolean;
      count: number;
      isolated: Array<{ alias: string; profile_mode: string; session_status: string }>;
    };
    assert.equal(isoAllJson.ok, true);
    assert.equal(isoAllJson.count, 2);
    assert.equal(isoAllJson.isolated[0].profile_mode, 'isolated');
    assert.equal(isoAllJson.isolated[0].session_status, 'unknown');

    // Open pre-filled Google Sign-In via /login, then confirm login via /confirm-login.
    const loginRes = await fetch(`${baseUrl}/api/accounts/raw1/login`, { method: 'POST', headers: authHeaders });
    assert.equal(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as { ok: boolean; url: string };
    assert.equal(loginJson.ok, true);
    assert.ok(loginJson.url.includes('Email=raw1%40gmail.com'));

    const confirmRes = await fetch(`${baseUrl}/api/accounts/raw1/confirm-login`, { method: 'POST', headers: authHeaders });
    assert.equal(confirmRes.status, 200);
    const confirmJson = (await confirmRes.json()) as {
      ok: boolean;
      account: { alias: string; session_status: string; effective_state: string };
    };
    assert.equal(confirmJson.ok, true);
    assert.equal(confirmJson.account.session_status, 'live');
    assert.equal(confirmJson.account.effective_state, 'ready');
  });
});
