import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildChromeLaunchArgs,
  classifySessionUrls,
  decorateUrlForAccount,
  isProfileRunning,
  isSafeHttpUrl,
  resolveBrowserBinaryForUserDataDir,
} from '../src/chrome.ts';

describe('Chrome helpers', () => {
  const tempDirs: string[] = [];

  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies live and needs_login Google session URLs accurately', () => {
    assert.equal(
      classifySessionUrls([
        { url: 'https://myaccount.google.com/personal-info', type: 'page' },
        { url: 'https://gemini.google.com/app', type: 'page' },
      ]).status,
      'live',
    );

    assert.equal(
      classifySessionUrls([
        { url: 'https://myaccount.google.com/intro', type: 'page' },
      ]).status,
      'needs_login',
    );

    assert.equal(
      classifySessionUrls([
        { url: 'https://accounts.google.com/v3/signin/identifier?continue=...', type: 'page' },
      ]).status,
      'needs_login',
    );

    assert.equal(
      classifySessionUrls([
        { url: 'https://accounts.google.com/signin/v2/challenge/pwd', type: 'page' },
      ]).status,
      'needs_login',
    );

    assert.equal(
      classifySessionUrls([{ url: 'about:blank', type: 'page' }]).status,
      'error',
    );
  });

  it('builds real Chrome launch flags and never includes --enable-automation', () => {
    const visibleArgs = buildChromeLaunchArgs({
      profileDir: '/tmp/prof1',
      urls: ['https://gemini.google.com/app'],
      headless: false,
      proxyUrl: 'socks5://127.0.0.1:1080',
    });

    assert.ok(visibleArgs.includes('--user-data-dir=/tmp/prof1'));
    assert.ok(visibleArgs.includes('--proxy-server=socks5://127.0.0.1:1080'));
    assert.ok(visibleArgs.includes('https://gemini.google.com/app'));
    assert.equal(visibleArgs.includes('--enable-automation'), false);
    assert.equal(visibleArgs.includes('--headless=new'), false);

    const headlessArgs = buildChromeLaunchArgs({
      profileDir: '/tmp/prof1',
      urls: ['https://myaccount.google.com/personal-info'],
      headless: true,
      debugPort: 9222,
    });

    assert.ok(headlessArgs.includes('--headless=new'));
    assert.ok(headlessArgs.includes('--remote-debugging-port=9222'));
    assert.ok(headlessArgs.includes('--remote-debugging-address=127.0.0.1'));
    assert.equal(headlessArgs.includes('--enable-automation'), false);
  });

  it('validates safe http/https URLs strictly', () => {
    assert.equal(isSafeHttpUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
    assert.equal(isSafeHttpUrl('http://127.0.0.1:8080/callback'), true);
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
    assert.equal(isSafeHttpUrl('not-a-url'), false);
  });

  it('detects macOS Chrome SingletonLock dangling symlinks safely', () => {
    const dirLive = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-lock-live-'));
    const dirDead = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-lock-dead-'));
    const dirNone = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-lock-none-'));
    tempDirs.push(dirLive, dirDead, dirNone);

    // Symlink pointing to current live test PID (target file does not exist on disk).
    fs.symlinkSync(`macbook.local-${process.pid}`, path.join(dirLive, 'SingletonLock'));
    const liveStatus = isProfileRunning(dirLive);
    assert.equal(liveStatus.running, true);
    assert.equal(liveStatus.pid, process.pid);

    // Symlink pointing to a non-existent PID.
    fs.symlinkSync('macbook.local-999999', path.join(dirDead, 'SingletonLock'));
    const deadStatus = isProfileRunning(dirDead);
    assert.equal(deadStatus.running, false);

    // Missing symlink.
    const noneStatus = isProfileRunning(dirNone);
    assert.equal(noneStatus.running, false);
  });

  it('decorates Google and OAuth URLs with authuser/login_hint without overwriting existing hints or non-Google URLs', () => {
    assert.equal(
      decorateUrlForAccount('https://gemini.google.com/app', 'u2@gmail.com'),
      'https://gemini.google.com/app?authuser=u2%40gmail.com',
    );

    const oauthDecorated = decorateUrlForAccount(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz123',
      'u2@gmail.com',
    );
    const parsedOAuth = new URL(oauthDecorated);
    assert.equal(parsedOAuth.searchParams.get('client_id'), 'abc');
    assert.equal(parsedOAuth.searchParams.get('state'), 'xyz123');
    assert.equal(parsedOAuth.searchParams.get('login_hint'), 'u2@gmail.com');
    assert.equal(parsedOAuth.searchParams.get('authuser'), 'u2@gmail.com');

    // Never overwrite explicit login_hint already in URL.
    const preserved = decorateUrlForAccount(
      'https://accounts.google.com/o/oauth2/v2/auth?login_hint=explicit%40gmail.com',
      'u2@gmail.com',
    );
    assert.equal(new URL(preserved).searchParams.get('login_hint'), 'explicit@gmail.com');

    // Non-Google URLs remain untouched.
    assert.equal(decorateUrlForAccount('https://example.com/path', 'u2@gmail.com'), 'https://example.com/path');
  });

  it('supports --profile-directory and omitUserDataDir for linked Chrome profiles', () => {
    const args = buildChromeLaunchArgs({
      profileDir: '/Users/demo/Library/Application Support/Google/Chrome',
      profileDirectory: 'Profile 1',
      omitUserDataDir: true,
      urls: ['https://gemini.google.com/app?authuser=u2%40gmail.com'],
      headless: false,
    });

    assert.equal(args.some((a) => a.startsWith('--user-data-dir=')), false);
    assert.ok(args.includes('--profile-directory=Profile 1'));
    assert.ok(args.includes('https://gemini.google.com/app?authuser=u2%40gmail.com'));
  });

  it('resolves browser binary matching userDataDir when installed, or falls back cleanly', () => {
    const fallback = '/custom/browser';
    assert.equal(resolveBrowserBinaryForUserDataDir('/tmp/custom-dir', fallback), fallback);

    const braveDir = '/Users/demo/Library/Application Support/BraveSoftware/Brave-Browser';
    const resolvedBrave = resolveBrowserBinaryForUserDataDir(braveDir, fallback);
    if (fs.existsSync('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')) {
      assert.equal(resolvedBrave, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    } else {
      assert.equal(resolvedBrave, fallback);
    }
  });
});
