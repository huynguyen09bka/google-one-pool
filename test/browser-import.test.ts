import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  discoverBrowserProfiles,
  extractEmailsFromText,
  generateUniqueAlias,
  parseBulkEmailLines,
} from '../src/browser-import.ts';

describe('Browser import & bulk email parser', () => {
  const tempDirs: string[] = [];

  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers Chrome profiles and multi-login accounts without touching secrets', () => {
    const chromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-chrome-scan-'));
    tempDirs.push(chromeRoot);

    fs.mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true });
    fs.mkdirSync(path.join(chromeRoot, 'Profile 1'), { recursive: true });

    // Intentionally include an ignored secret key in Local State to verify it is never exposed.
    fs.writeFileSync(
      path.join(chromeRoot, 'Local State'),
      JSON.stringify({
        os_crypt: { encrypted_key: 'SHOULD_NOT_APPEAR' },
        profile: {
          info_cache: {
            Default: { name: 'Chinh', user_name: 'primary@gmail.com', gaia_name: 'Main User' },
            'Profile 1': { name: 'Work', user_name: 'work@gmail.com', gaia_name: 'Work User' },
          },
        },
      }),
    );

    fs.writeFileSync(
      path.join(chromeRoot, 'Default', 'Preferences'),
      JSON.stringify({
        account_info: [
          { email: 'primary@gmail.com', full_name: 'Main User' },
          { email: 'second.pro@gmail.com', full_name: 'Second Pro' },
          { email: 'third.pro@gmail.com', full_name: '' },
        ],
      }),
    );
    fs.writeFileSync(path.join(chromeRoot, 'Default', 'Cookies'), 'sqlite-placeholder');

    fs.writeFileSync(
      path.join(chromeRoot, 'Profile 1', 'Preferences'),
      JSON.stringify({
        account_info: [{ email: 'work@gmail.com', full_name: 'Work User' }],
      }),
    );

    const res = discoverBrowserProfiles({
      roots: [
        {
          browser: 'Google Chrome',
          chromeBinary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          userDataDir: chromeRoot,
        },
      ],
      existingEmails: new Set(['second.pro@gmail.com']),
      existingAliases: new Set(['primary']),
    });

    assert.equal(res.profiles.length, 2);
    assert.equal(res.discoveredAccounts.length, 4);

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);

    const primaryAcc = res.discoveredAccounts.find((a) => a.email === 'primary@gmail.com');
    assert.ok(primaryAcc);
    assert.equal(primaryAcc.alreadyInPool, false);
    assert.equal(primaryAcc.suggestedAlias, 'primary-2');
    assert.equal(primaryAcc.hasCookies, true);

    const secondAcc = res.discoveredAccounts.find((a) => a.email === 'second.pro@gmail.com');
    assert.ok(secondAcc);
    assert.equal(secondAcc.alreadyInPool, true);

    const workAcc = res.discoveredAccounts.find((a) => a.email === 'work@gmail.com');
    assert.ok(workAcc);
    assert.equal(workAcc.profileName, 'Profile 1');
    assert.equal(workAcc.hasCookies, false);
  });

  it('generates collision-free valid aliases and parses multi-format bulk email lines', () => {
    const used = new Set(['alex']);
    assert.equal(generateUniqueAlias('alex@gmail.com', used), 'alex-2');
    assert.equal(generateUniqueAlias('alex@yahoo.com', used), 'alex-3');

    const parsed = parseBulkEmailLines(
      `
      # Danh sách Gmail AI Pro
      pro1@gmail.com
      mywork pro2@gmail.com | gói tháng 12
      pro3@gmail.com,pro4@gmail.com
      pro1@gmail.com
      not-an-email
      `,
      new Set(['mywork']),
    );

    assert.equal(parsed.items.length, 4);
    assert.deepEqual(
      parsed.items.map((i) => ({ alias: i.alias, email: i.email, notes: i.notes })),
      [
        { alias: 'pro1', email: 'pro1@gmail.com', notes: undefined },
        { alias: 'pro2', email: 'pro2@gmail.com', notes: 'gói tháng 12' },
        { alias: 'pro3', email: 'pro3@gmail.com', notes: undefined },
        { alias: 'pro4', email: 'pro4@gmail.com', notes: undefined },
      ],
    );
    assert.deepEqual(parsed.invalidLines, ['not-an-email']);
  });

  it('extracts emails and display names cleanly from messy Google SignOutOptions webpage pastes', () => {
    const pasted = `
      Chọn tài khoản
      Nguyen Huy
      huy1@gmail.com
      Đã đăng nhập
      Work Pro
      huy2@gmail.com
      Signed in
      customalias huy3@gmail.com | tài khoản phụ
      Đăng xuất khỏi tất cả tài khoản
      Quản lý tài khoản Google của bạn
    `;

    const extracted = extractEmailsFromText(pasted);
    assert.equal(extracted.length, 3);
    assert.deepEqual(extracted[0], {
      alias: 'huy1',
      email: 'huy1@gmail.com',
      display_name: 'Nguyen Huy',
      notes: undefined,
    });
    assert.deepEqual(extracted[1], {
      alias: 'huy2',
      email: 'huy2@gmail.com',
      display_name: 'Work Pro',
      notes: undefined,
    });
    assert.deepEqual(extracted[2], {
      alias: 'customalias',
      email: 'huy3@gmail.com',
      display_name: undefined,
      notes: 'tài khoản phụ',
    });
  });

  it('reports permissionBlocked and warnings when browser metadata files reject read access (EACCES/EPERM)', () => {
    const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-chrome-perm-'));
    const localStatePath = path.join(blockedRoot, 'Local State');
    const defaultDir = path.join(blockedRoot, 'Default');
    const prefsPath = path.join(defaultDir, 'Preferences');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(localStatePath, '{}');
    fs.writeFileSync(prefsPath, '{}');

    try {
      fs.chmodSync(localStatePath, 0o000);
      fs.chmodSync(prefsPath, 0o000);
      const res = discoverBrowserProfiles({
        roots: [
          {
            browser: 'Google Chrome',
            chromeBinary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            userDataDir: blockedRoot,
          },
        ],
      });
      assert.equal(res.permissionBlocked, true);
      assert.equal(res.warnings.length, 1);
      assert.equal(res.warnings[0].browser, 'Google Chrome');
      assert.ok(res.warnings[0].code === 'EACCES' || res.warnings[0].code === 'EPERM');
    } finally {
      fs.chmodSync(localStatePath, 0o600);
      fs.chmodSync(prefsPath, 0o600);
      fs.rmSync(blockedRoot, { recursive: true, force: true });
    }
  });
});
