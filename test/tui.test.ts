import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDefaultSettings } from '../src/config.ts';
import {
  displayWidth,
  filterTuiAccounts,
  formatShortDuration,
  padRightWidth,
  renderTuiFrame,
  stripAnsi,
  truncateWidth,
  type TuiSnapshot,
  type TuiState,
} from '../src/tui.ts';
import type { AccountView } from '../src/types.ts';

function makeAccount(overrides: Partial<AccountView> & { alias: string; email: string }): AccountView {
  return {
    id: 1,
    display_name: '',
    plan_tier: 'Google AI Pro',
    renewal_date: null,
    tags: ['pro'],
    notes: '',
    proxy_url: null,
    adc_credentials_path: null,
    profile_mode: 'linked',
    chrome_user_data_dir: '/tmp/chrome',
    chrome_profile_name: 'Default',
    google_authuser: overrides.email,
    chrome_profile_dir: '/tmp/chrome/Default',
    session_status: 'live',
    session_detail: null,
    is_active: false,
    cooldown_until: null,
    cooldown_reason: null,
    last_checked_at: '2026-11-22T01:00:00.000Z',
    last_live_at: '2026-11-22T01:00:00.000Z',
    last_used_at: '2026-11-22T01:00:00.000Z',
    use_count: 2,
    created_at: '2026-11-21T00:00:00.000Z',
    updated_at: '2026-11-22T01:00:00.000Z',
    effective_state: 'ready',
    cooldown_remaining_ms: 0,
    renewal_days_left: null,
    chrome_running: true,
    agy_session: null,
    ...overrides,
  };
}

function makeSnapshot(accounts: AccountView[]): TuiSnapshot {
  return {
    daemonOnline: true,
    accounts,
    activeAlias: accounts.find((a) => a.is_active)?.alias ?? null,
    summary: {
      total: accounts.length,
      ready: accounts.filter((a) => a.effective_state === 'ready' || a.effective_state === 'active').length,
      cooldown: accounts.filter((a) => a.effective_state === 'cooldown').length,
      needs_login: accounts.filter((a) => a.effective_state === 'needs_login').length,
      unknown: accounts.filter((a) => a.effective_state === 'unknown').length,
      error: accounts.filter((a) => a.effective_state === 'error').length,
    },
    keepalive: { running: true, sweeping: false, activeProbes: [], lastSweepAt: null },
    settings: getDefaultSettings(),
    events: [
      {
        id: 1,
        account_id: 1,
        account_alias: 'alpha-pro-01',
        event_type: 'switch',
        message: 'Chuyển sang alpha-pro-01',
        created_at: '2026-11-22T01:10:00.000Z',
      },
    ],
    agyStatus: {
      keychain_present: true,
      live_owner_alias: 'alpha-pro-01',
      live_unknown: false,
      live_email: 'alpha-pro-01@example.com',
      marker_alias: 'alpha-pro-01',
    },
  };
}

describe('TUI layout, width, filtering & modal rendering', () => {
  it('computes accurate terminal widths with ANSI codes and Vietnamese diacritics', () => {
    assert.equal(displayWidth('Sẵn sàng'), 8);
    assert.equal(displayWidth('S\u0103\u0303n sa\u0300ng'), 8);
    assert.equal(displayWidth('\x1b[32m★ Đang chọn\x1b[0m'), 11);
    assert.equal(displayWidth(truncateWidth('beta-account-longname@example.com', 15)), 15);
    assert.equal(displayWidth(padRightWidth('Tiếng Việt', 16)), 16);
    assert.equal(formatShortDuration(5 * 3_600_000), '5g');
    assert.equal(formatShortDuration(90 * 60_000), '1g30p');
  });

  it('filters accounts by status (including error under needs_login) and search query', () => {
    const accounts = [
      makeAccount({ id: 1, alias: 'acc-active', email: 'active@example.com', is_active: true, effective_state: 'active' }),
      makeAccount({ id: 2, alias: 'acc-ready', email: 'ready@example.com', effective_state: 'ready', tags: ['work'] }),
      makeAccount({ id: 3, alias: 'acc-cd', email: 'cd@example.com', effective_state: 'cooldown', cooldown_remaining_ms: 3_600_000 }),
      makeAccount({ id: 4, alias: 'acc-expired', email: 'exp@example.com', effective_state: 'needs_login', session_status: 'needs_login' }),
      makeAccount({ id: 5, alias: 'acc-err', email: 'err@example.com', effective_state: 'error', session_status: 'error' }),
    ];

    assert.equal(filterTuiAccounts(accounts, 'all', '').length, 5);
    assert.equal(filterTuiAccounts(accounts, 'ready', '').length, 2);
    assert.equal(filterTuiAccounts(accounts, 'cooldown', '').length, 1);
    assert.equal(filterTuiAccounts(accounts, 'needs_login', '').length, 2);
    assert.equal(filterTuiAccounts(accounts, 'all', 'work').length, 1);
  });

  it('renders bordered main view and modals without exceeding viewport width at 80 and 120 cols', () => {
    const accounts = [
      makeAccount({
        id: 1,
        alias: 'alpha-pro-01',
        email: 'alpha-pro-01@example.com',
        is_active: true,
        effective_state: 'active',
        agy_session: {
          captured: true,
          captured_at: '2026-11-21T15:10:17.000Z',
          detected_email: 'alpha-pro-01@example.com',
          is_live_owner: true,
          active_alias: 'alpha-pro-01',
        },
      }),
      makeAccount({
        id: 2,
        alias: 'beta-account-longname',
        email: 'beta-account-longname@example.com',
        display_name: 'Beta User',
        effective_state: 'ready',
        agy_session: {
          captured: true,
          captured_at: '2026-11-21T15:10:42.000Z',
          detected_email: 'beta-account-longname@example.com',
          is_live_owner: false,
          active_alias: 'alpha-pro-01',
        },
      }),
    ];

    const baseState: TuiState = {
      snapshot: makeSnapshot(accounts),
      selectedIndex: 0,
      scrollOffset: 0,
      filterStatus: 'all',
      searchQuery: '',
      searchActive: false,
      busyMessage: null,
      notice: { text: 'Sẵn sàng.', kind: 'info' },
      modal: null,
    };

    for (const cols of [80, 120]) {
      const frame = renderTuiFrame(baseState, cols, 28);
      assert.ok(frame.length <= 28);
      const plain = frame.map(stripAnsi).join('\n');
      assert.ok(plain.includes('alpha-pro-01'));
      assert.ok(plain.includes('★ đang dùng'));
      for (const line of frame) {
        assert.ok(
          displayWidth(line) <= cols,
          `Line exceeded ${cols} cols (${displayWidth(line)}): ${stripAnsi(line)}`,
        );
      }
      // Every box row must be exact width
      for (const line of frame) {
        const clean = stripAnsi(line);
        if (clean.startsWith('┌') || clean.startsWith('│') || clean.startsWith('├') || clean.startsWith('└')) {
          assert.equal(displayWidth(line), cols, `Box border misaligned at ${cols}: ${clean}`);
        }
      }
    }

    // Verify help, events, and delete confirm modals render cleanly
    for (const modal of [
      { type: 'help', scroll: 0 } as const,
      { type: 'events', scroll: 0 } as const,
      { type: 'confirm-delete', alias: 'alpha-pro-01', email: 'alpha-pro-01@example.com', isIsolated: true, purgeProfile: false } as const,
    ]) {
      const frame = renderTuiFrame({ ...baseState, modal }, 90, 26);
      for (const line of frame) {
        assert.ok(displayWidth(line) <= 90);
      }
    }
  });
});
