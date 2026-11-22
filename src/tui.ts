import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  activateAgySession,
  captureAgySession,
  getAgySessionStatus,
  getLiveKeychainContext,
  hasSessionSnapshot,
  sessionInfoForAlias,
  type AgyStatusResult,
} from './agysession.ts';
import {
  discoverBrowserProfiles,
  extractEmailsFromText,
  generateUniqueAlias,
  getDefaultBrowserRoots,
} from './browser-import.ts';
import { isAccountChromeRunning } from './chrome.ts';
import {
  DEFAULT_HOST,
  VALID_PLAN_TIERS,
  validateAlias,
  validateEmail,
  type PoolPaths,
} from './config.ts';
import { PoolDB } from './db.ts';
import { KeepAliveScheduler } from './keepalive.ts';
import { getLaunchAgentStatus, installLaunchAgent, uninstallLaunchAgent } from './launchagent.ts';
import { PoolSwitcher } from './switcher.ts';
import type {
  AccountView,
  BulkImportItemInput,
  BulkImportResult,
  DaemonSettings,
  PlanTier,
  PoolEvent,
  ProfileMode,
} from './types.ts';

export type TuiStatusFilter = 'all' | 'ready' | 'cooldown' | 'needs_login' | 'unknown';

export interface TuiAgySummary {
  keychain_present: boolean;
  live_owner_alias: string | null;
  live_unknown: boolean;
  live_email: string | null;
  marker_alias: string | null;
}

export interface TuiSnapshot {
  daemonOnline: boolean;
  accounts: AccountView[];
  activeAlias: string | null;
  summary: {
    total: number;
    ready: number;
    cooldown: number;
    needs_login: number;
    unknown: number;
    error: number;
  };
  keepalive: {
    running: boolean;
    sweeping: boolean;
    activeProbes: string[];
    lastSweepAt: string | null;
  };
  settings: DaemonSettings;
  events: PoolEvent[];
  agyStatus: TuiAgySummary | null;
}

export interface TuiState {
  snapshot: TuiSnapshot | null;
  selectedIndex: number;
  scrollOffset: number;
  filterStatus: TuiStatusFilter;
  searchQuery: string;
  searchActive: boolean;
  busyMessage: string | null;
  notice: { text: string; kind: 'info' | 'success' | 'warn' | 'error' } | null;
  modal: TuiModal | null;
}

export interface MenuChoice {
  id: string;
  label: string;
  hint?: string;
}

export interface FormField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  options?: readonly string[];
  required?: boolean;
}

export type TuiModal =
  | { type: 'menu'; title: string; subtitle?: string; items: MenuChoice[]; cursor: number; kind: 'cooldown' | 'import' | 'isolate' | 'system' }
  | { type: 'input'; title: string; subtitle?: string; label: string; value: string; placeholder?: string; kind: 'rotate' | 'cooldown-custom' | 'oauth' | 'import-emails' | 'export-file' }
  | { type: 'form'; title: string; editingAlias: string | null; fields: FormField[]; cursor: number; error: string | null }
  | { type: 'confirm-delete'; alias: string; email: string; isIsolated: boolean; purgeProfile: boolean }
  | { type: 'confirm-force-agy'; alias: string; reason: string }
  | { type: 'events'; scroll: number }
  | { type: 'agy-status'; status: AgyStatusResult }
  | { type: 'help'; scroll: number };

const USE_COLOR = !process.env.NO_COLOR;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  brightBlue: '\x1b[94m',
  green: '\x1b[32m',
  brightGreen: '\x1b[92m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',
};

function paint(code: string, text: string): string {
  return USE_COLOR ? `${code}${text}${ANSI.reset}` : text;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Computes terminal display column width accurately for ASCII, Vietnamese NFC/NFD
 * combining marks, box drawing, and wide East Asian characters.
 */
export function displayWidth(text: string): number {
  const clean = stripAnsi(text);
  let width = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0) continue;
    // Combining diacritical marks & zero-width joiners
    if (
      (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) ||
      (cp >= 0xfe20 && cp <= 0xfe2f) ||
      cp === 0x200d ||
      cp === 0xfe0f ||
      cp === 0xfe0e
    ) {
      continue;
    }
    // Wide CJK / fullwidth / emoji blocks
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp >= 0x1f300
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function truncateWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(text) <= maxWidth) return text;
  const target = Math.max(0, maxWidth - 1);
  let out = '';
  let w = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(text.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = displayWidth(ch);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (maxWidth >= 1 ? '…' : '') + (USE_COLOR && text.includes('\x1b[') ? ANSI.reset : '');
}

export function padRightWidth(text: string, width: number): string {
  const truncated = truncateWidth(text, width);
  const diff = Math.max(0, width - displayWidth(truncated));
  return truncated + ' '.repeat(diff);
}

export function formatShortDuration(ms: number): string {
  if (!ms || ms <= 0) return '0p';
  const totalSec = Math.ceil(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}n${hours}g`;
  if (hours > 0) return mins > 0 ? `${hours}g${mins}p` : `${hours}g`;
  return `${Math.max(1, mins)}p`;
}

export function filterTuiAccounts(
  accounts: AccountView[],
  filterStatus: TuiStatusFilter,
  searchQuery: string,
): AccountView[] {
  const q = searchQuery.trim().toLowerCase();
  return accounts.filter((acc) => {
    if (filterStatus !== 'all') {
      if (filterStatus === 'ready') {
        if (acc.effective_state !== 'ready' && acc.effective_state !== 'active') return false;
      } else if (filterStatus === 'needs_login') {
        if (acc.effective_state !== 'needs_login' && acc.effective_state !== 'error') return false;
      } else if (acc.effective_state !== filterStatus) {
        return false;
      }
    }
    if (q) {
      const hay = [acc.alias, acc.email, acc.display_name, acc.notes, ...(acc.tags || [])]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function boxLine(inner: string, innerWidth: number, borderColor = ANSI.gray): string {
  return paint(borderColor, '│') + ' ' + padRightWidth(inner, innerWidth) + ' ' + paint(borderColor, '│');
}

function boxTop(title: string, width: number, borderColor = ANSI.gray): string {
  const innerW = Math.max(4, width - 2);
  if (!title) {
    return paint(borderColor, '┌' + '─'.repeat(innerW) + '┐');
  }
  const clippedTitle = truncateWidth(` ${title} `, Math.max(1, innerW - 2));
  const titleW = displayWidth(clippedTitle);
  const rightFill = Math.max(1, innerW - 1 - titleW);
  return (
    paint(borderColor, '┌─') +
    paint(ANSI.bold + ANSI.cyan, clippedTitle) +
    paint(borderColor, '─'.repeat(rightFill) + '┐')
  );
}

function boxSep(width: number, borderColor = ANSI.gray): string {
  return paint(borderColor, '├' + '─'.repeat(Math.max(4, width - 2)) + '┤');
}

function boxBottom(width: number, borderColor = ANSI.gray): string {
  return paint(borderColor, '└' + '─'.repeat(Math.max(4, width - 2)) + '┘');
}

function formatStateLabel(acc: AccountView): string {
  switch (acc.effective_state) {
    case 'active':
      return paint(ANSI.brightBlue + ANSI.bold, '★ Đang chọn');
    case 'ready':
      return paint(ANSI.brightGreen, '● Sẵn sàng');
    case 'cooldown':
      return paint(ANSI.yellow, `◐ CD ${formatShortDuration(acc.cooldown_remaining_ms)}`);
    case 'needs_login':
      return paint(ANSI.red, '✕ Cần login');
    case 'error':
      return paint(ANSI.red, '! Lỗi quét');
    case 'checking':
      return paint(ANSI.cyan, '◌ Đang quét');
    default:
      return paint(ANSI.gray, '○ Chưa quét');
  }
}

function formatAgyCell(acc: AccountView): string {
  if (!acc.agy_session?.captured) return paint(ANSI.gray, '—');
  if (acc.agy_session.is_live_owner) return paint(ANSI.brightGreen + ANSI.bold, '★ đang dùng');
  return paint(ANSI.cyan, '● đã lưu');
}

function formatFilterName(filter: TuiStatusFilter): string {
  switch (filter) {
    case 'all':
      return 'Tất cả';
    case 'ready':
      return 'Sẵn sàng';
    case 'cooldown':
      return 'Cooldown';
    case 'needs_login':
      return 'Cần login/Lỗi';
    case 'unknown':
      return 'Chưa quét';
  }
}

function formatTimeShort(iso: string | null): string {
  if (!iso) return 'Chưa có';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

/**
 * Pure frame renderer — returns the complete array of terminal lines for a given
 * state and viewport size (width x height). Exported for deterministic unit testing.
 */
export function renderTuiFrame(state: TuiState, cols: number, rows: number): string[] {
  const width = Math.max(68, cols);
  const height = Math.max(20, rows);
  const innerW = width - 4;
  const snap = state.snapshot;
  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────
  lines.push(boxTop('Google One Pool (gpool) — TUI', width, ANSI.blue));

  if (!snap) {
    lines.push(boxLine(paint(ANSI.yellow, 'Đang tải dữ liệu pool...'), innerW, ANSI.blue));
    lines.push(boxBottom(width, ANSI.blue));
    return lines;
  }

  const daemonTag = snap.daemonOnline
    ? paint(ANSI.brightGreen, '● Daemon Online')
    : paint(ANSI.yellow, '○ Local DB (Daemon tắt)');
  const kaTag = snap.keepalive.sweeping
    ? paint(ANSI.cyan, '◌ Đang quét phiên...')
    : snap.settings.keepalive_enabled
      ? paint(ANSI.green, `Keep-Alive ${snap.settings.keepalive_interval_minutes}p`)
      : paint(ANSI.gray, 'Keep-Alive tắt');
  const agyOwner = snap.agyStatus?.live_owner_alias
    ? paint(ANSI.brightGreen, `agy: ${snap.agyStatus.live_owner_alias}`)
    : snap.agyStatus?.keychain_present
      ? paint(ANSI.yellow, `agy: ${snap.agyStatus.live_email ?? 'chưa lưu'}`)
      : paint(ANSI.gray, 'agy: trống');

  const kpiParts = [
    `Tổng: ${paint(ANSI.bold, String(snap.summary.total))}`,
    paint(ANSI.brightGreen, `Sẵn sàng: ${snap.summary.ready}`),
    paint(ANSI.yellow, `Cooldown: ${snap.summary.cooldown}`),
    paint(ANSI.red, `Cần login: ${snap.summary.needs_login + snap.summary.error}`),
  ];

  lines.push(boxLine(`${daemonTag}  │  ${kaTag}  │  ${agyOwner}`, innerW, ANSI.blue));
  const filterInfo = `Lọc: ${paint(ANSI.cyan, formatFilterName(state.filterStatus))}` +
    (state.searchQuery || state.searchActive
      ? `  │  Tìm: ${paint(ANSI.bold + ANSI.yellow, state.searchQuery)}${state.searchActive ? paint(ANSI.inverse, ' ') : ''}`
      : '');
  lines.push(boxLine(`${kpiParts.join('  •  ')}  │  ${filterInfo}`, innerW, ANSI.blue));
  lines.push(boxBottom(width, ANSI.blue));

  // If a modal is open, render the modal cleanly inside the frame body
  if (state.modal) {
    const modalLines = renderModal(state, width, Math.max(10, height - lines.length - 3));
    lines.push(...modalLines);
    lines.push(...renderNoticeAndFooter(state, width, true));
    return lines.slice(0, height);
  }

  // ── Main Account Table ───────────────────────────────────
  const filtered = filterTuiAccounts(snap.accounts, state.filterStatus, state.searchQuery);
  const clampedIdx = filtered.length > 0 ? Math.max(0, Math.min(state.selectedIndex, filtered.length - 1)) : 0;
  const selectedAcc = filtered[clampedIdx] ?? null;

  // Reserve space: header(5) + table chrome(4) + detail(6) + notice(1) + footer(2) = 18
  const detailLinesCount = 6;
  const footerLinesCount = 3;
  const availableTableRows = Math.max(4, height - lines.length - detailLinesCount - footerLinesCount - 4);

  let scrollOffset = state.scrollOffset;
  if (clampedIdx < scrollOffset) scrollOffset = clampedIdx;
  if (clampedIdx >= scrollOffset + availableTableRows) scrollOffset = clampedIdx - availableTableRows + 1;
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, filtered.length - availableTableRows)));

  // Adaptive column widths
  const prefixW = 3; // "▸★ " or "   "
  const aliasW = width >= 110 ? 20 : 15;
  const stateW = 14;
  const modeW = width >= 100 ? 14 : 11;
  const agyW = 12;
  const tagsW = width >= 115 ? 14 : 0;
  const gaps = tagsW > 0 ? 6 : 5;
  const emailW = Math.max(12, innerW - prefixW - aliasW - stateW - modeW - agyW - tagsW - gaps);

  const tableTitle =
    filtered.length === snap.accounts.length
      ? `Danh sách tài khoản (${filtered.length})`
      : `Danh sách tài khoản (${filtered.length}/${snap.accounts.length})`;
  lines.push(boxTop(tableTitle, width, ANSI.gray));

  const headerCols = [
    '   ',
    padRightWidth(paint(ANSI.bold + ANSI.gray, 'ALIAS'), aliasW),
    padRightWidth(paint(ANSI.bold + ANSI.gray, 'EMAIL'), emailW),
    padRightWidth(paint(ANSI.bold + ANSI.gray, 'TRẠNG THÁI'), stateW),
    padRightWidth(paint(ANSI.bold + ANSI.gray, 'CHẾ ĐỘ'), modeW),
    padRightWidth(paint(ANSI.bold + ANSI.gray, 'AGY'), agyW),
  ];
  if (tagsW > 0) headerCols.push(padRightWidth(paint(ANSI.bold + ANSI.gray, 'TAGS'), tagsW));
  lines.push(boxLine(headerCols.join(' '), innerW, ANSI.gray));
  lines.push(boxSep(width, ANSI.gray));

  if (filtered.length === 0) {
    const emptyMsg =
      snap.accounts.length === 0
        ? 'Chưa có tài khoản nào — nhấn [i] Nhập Chrome/Clipboard hoặc [+] Thêm thủ công'
        : 'Không có tài khoản khớp bộ lọc — nhấn [f] đổi bộ lọc hoặc [Esc] xóa tìm kiếm';
    lines.push(boxLine(paint(ANSI.yellow, emptyMsg), innerW, ANSI.gray));
    for (let r = 1; r < availableTableRows; r += 1) {
      lines.push(boxLine('', innerW, ANSI.gray));
    }
  } else {
    const visible = filtered.slice(scrollOffset, scrollOffset + availableTableRows);
    for (let i = 0; i < availableTableRows; i += 1) {
      const acc = visible[i];
      if (!acc) {
        lines.push(boxLine('', innerW, ANSI.gray));
        continue;
      }
      const absIdx = scrollOffset + i;
      const isSelected = absIdx === clampedIdx;
      const cursor = isSelected ? paint(ANSI.cyan + ANSI.bold, '▸') : ' ';
      const star = acc.is_active ? paint(ANSI.brightBlue + ANSI.bold, '★') : ' ';
      const modeText =
        acc.profile_mode === 'linked'
          ? paint(ANSI.cyan, `Link:${acc.chrome_profile_name ?? 'Default'}`)
          : paint(ANSI.gray, 'Riêng');

      const rowParts = [
        `${cursor}${star} `,
        padRightWidth(isSelected ? paint(ANSI.bold + ANSI.white, acc.alias) : acc.alias, aliasW),
        padRightWidth(acc.email, emailW),
        padRightWidth(formatStateLabel(acc), stateW),
        padRightWidth(modeText, modeW),
        padRightWidth(formatAgyCell(acc), agyW),
      ];
      if (tagsW > 0) {
        const tagStr = acc.tags.length > 0 ? acc.tags.map((t) => `#${t}`).join(' ') : '—';
        rowParts.push(padRightWidth(paint(ANSI.gray, tagStr), tagsW));
      }
      const rowText = rowParts.join(' ');
      if (isSelected && USE_COLOR) {
        const bg = '\x1b[48;5;236m';
        const padded = padRightWidth(rowText, innerW).replaceAll(ANSI.reset, ANSI.reset + bg);
        const highlighted = `${bg}${padded}${ANSI.reset}`;
        lines.push(paint(ANSI.gray, '│') + ' ' + highlighted + ' ' + paint(ANSI.gray, '│'));
      } else {
        lines.push(boxLine(rowText, innerW, ANSI.gray));
      }
    }
  }
  lines.push(boxBottom(width, ANSI.gray));

  // ── Detail Box ───────────────────────────────────────────
  lines.push(boxTop(selectedAcc ? `Chi tiết: ${selectedAcc.alias}` : 'Chi tiết tài khoản', width, ANSI.gray));
  if (!selectedAcc) {
    lines.push(boxLine(paint(ANSI.gray, 'Chọn một tài khoản để xem thông tin chi tiết và thao tác nhanh.'), innerW));
    lines.push(boxLine('', innerW));
    lines.push(boxLine('', innerW));
    lines.push(boxLine('', innerW));
  } else {
    const namePart = selectedAcc.display_name ? `${selectedAcc.display_name} • ` : '';
    const renewalPart = selectedAcc.renewal_date
      ? `  │  Gia hạn: ${selectedAcc.renewal_date}${selectedAcc.renewal_days_left !== null ? ` (còn ${selectedAcc.renewal_days_left}n)` : ''}`
      : '';
    lines.push(
      boxLine(
        `${paint(ANSI.bold, selectedAcc.alias)} (${namePart}${selectedAcc.email})  │  ${selectedAcc.plan_tier}${renewalPart}`,
        innerW,
      ),
    );
    const chromeStr = selectedAcc.chrome_running ? paint(ANSI.magenta, 'Chrome đang mở') : paint(ANSI.gray, 'Chrome đóng');
    const modeDetail =
      selectedAcc.profile_mode === 'linked'
        ? `Link (${selectedAcc.chrome_profile_name ?? 'Default'})`
        : `Profile riêng (${selectedAcc.chrome_profile_dir})`;
    lines.push(
      boxLine(
        `Chế độ: ${modeDetail}  │  ${chromeStr}  │  Đã dùng: ${selectedAcc.use_count} lần  │  Kiểm tra: ${formatTimeShort(selectedAcc.last_checked_at)}`,
        innerW,
      ),
    );

    const agyDetail = selectedAcc.agy_session?.captured
      ? selectedAcc.agy_session.is_live_owner
        ? paint(ANSI.brightGreen, `★ Đang nạp trong Keychain (lưu lúc ${formatTimeShort(selectedAcc.agy_session.captured_at)})`)
        : paint(ANSI.cyan, `● Đã lưu snapshot (${formatTimeShort(selectedAcc.agy_session.captured_at)}) — nhấn [a] để nạp hoặc [g] để chạy agy`)
      : paint(ANSI.yellow, 'Chưa lưu phiên agy — đăng nhập agy rồi nhấn [c] để lưu');
    lines.push(boxLine(`Phiên agy: ${agyDetail}`, innerW));

    const extraParts: string[] = [];
    if (selectedAcc.cooldown_remaining_ms > 0) {
      extraParts.push(
        paint(
          ANSI.yellow,
          `Cooldown còn ${formatShortDuration(selectedAcc.cooldown_remaining_ms)}${selectedAcc.cooldown_reason ? ` (${selectedAcc.cooldown_reason})` : ''}`,
        ),
      );
    }
    if (selectedAcc.proxy_url) extraParts.push(`Proxy: ${selectedAcc.proxy_url}`);
    if (selectedAcc.notes) extraParts.push(`Ghi chú: ${selectedAcc.notes}`);
    if (selectedAcc.session_detail && (selectedAcc.session_status === 'needs_login' || selectedAcc.session_status === 'error')) {
      extraParts.push(paint(ANSI.red, selectedAcc.session_detail));
    }
    lines.push(
      boxLine(
        extraParts.length > 0 ? extraParts.join('  │  ') : paint(ANSI.gray, 'Lệnh nhanh: gpool run ' + selectedAcc.alias + ' -- agy'),
        innerW,
      ),
    );
  }
  lines.push(boxBottom(width, ANSI.gray));

  // ── Notice + Hotkey Footer ───────────────────────────────
  lines.push(...renderNoticeAndFooter(state, width, false));
  return lines.slice(0, height);
}

function renderNoticeAndFooter(state: TuiState, width: number, inModal: boolean): string[] {
  const out: string[] = [];
  if (state.busyMessage) {
    out.push(truncateWidth(' ' + paint(ANSI.cyan + ANSI.bold, `◌ ${state.busyMessage}`), width));
  } else if (state.notice) {
    const color =
      state.notice.kind === 'success'
        ? ANSI.brightGreen
        : state.notice.kind === 'warn'
          ? ANSI.yellow
          : state.notice.kind === 'error'
            ? ANSI.red
            : ANSI.cyan;
    const prefix =
      state.notice.kind === 'success'
        ? '✓'
        : state.notice.kind === 'warn'
          ? '!'
          : state.notice.kind === 'error'
            ? '✕'
            : 'i';
    out.push(truncateWidth(' ' + paint(color, `${prefix} ${state.notice.text}`), width));
  } else {
    out.push('');
  }

  if (inModal) {
    out.push(
      truncateWidth(
        ' ' + paint(ANSI.gray, '[↑/↓] Di chuyển  [Enter] Xác nhận  [Esc] Quay lại'),
        width,
      ),
    );
    return out;
  }

  if (state.searchActive) {
    out.push(
      truncateWidth(
        ' ' + paint(ANSI.yellow, 'Đang tìm kiếm: gõ từ khóa để lọc trực tiếp • [Enter] Áp dụng • [Esc] Xóa tìm kiếm'),
        width,
      ),
    );
    out.push('');
    return out;
  }

  const k = (key: string, label: string) => `${paint(ANSI.cyan + ANSI.bold, `[${key}]`)}${paint(ANSI.gray, label)}`;
  const compact = width < 105;
  const row1 = compact
    ? [
        k('↑↓', 'Chọn'),
        k('s', 'Switch'),
        k('g', 'agy'),
        k('a', 'Nạp'),
        k('c', 'Lưu'),
        k('n', 'Kế'),
        k('o', 'Chrome'),
        k('x', 'CD'),
        k('p', 'Check'),
      ].join(' ')
    : [
        k('↑↓/jk', 'Chọn'),
        k('s', 'Switch'),
        k('g', 'Chạy agy'),
        k('a', 'Nạp agy'),
        k('c', 'Lưu agy'),
        k('n', 'Đổi kế'),
        k('o', 'Chrome'),
        k('l', 'Login'),
        k('x', 'Cooldown'),
        k('p', 'Check'),
      ].join(' ');
  const row2 = compact
    ? [
        k('+', 'Thêm'),
        k('i', 'Nhập'),
        k('t', 'Tách'),
        k('u', 'OAuth'),
        k('e', 'Sửa'),
        k('d', 'Xóa'),
        k('/', 'Tìm'),
        k('f', 'Lọc'),
        k('D', 'Menu'),
        k('?', 'Help'),
        k('q', 'Thoát'),
      ].join(' ')
    : [
        k('+', 'Thêm'),
        k('i', 'Nhập Chrome'),
        k('t', 'Tách riêng'),
        k('u', 'OAuth'),
        k('e', 'Sửa'),
        k('d', 'Xóa'),
        k('/', 'Tìm'),
        k('f', 'Lọc'),
        k('A', 'agy Status'),
        k('v', 'Log'),
        k('D', 'Hệ thống'),
        k('?', 'Help'),
        k('q', 'Thoát'),
      ].join(' ');
  out.push(truncateWidth(' ' + row1, width));
  out.push(truncateWidth(' ' + row2, width));
  return out;
}

function renderModal(state: TuiState, width: number, maxBodyRows: number): string[] {
  const modal = state.modal!;
  const innerW = width - 4;
  const out: string[] = [];

  if (modal.type === 'menu') {
    out.push(boxTop(modal.title, width, ANSI.cyan));
    if (modal.subtitle) {
      out.push(boxLine(paint(ANSI.gray, modal.subtitle), innerW, ANSI.cyan));
      out.push(boxSep(width, ANSI.cyan));
    }
    for (let i = 0; i < modal.items.length; i += 1) {
      const item = modal.items[i];
      const active = i === modal.cursor;
      const prefix = active ? paint(ANSI.cyan + ANSI.bold, '▸ ') : '  ';
      const label = active ? paint(ANSI.bold + ANSI.white, item.label) : item.label;
      const hint = item.hint ? `  ${paint(ANSI.gray, item.hint)}` : '';
      out.push(boxLine(`${prefix}${label}${hint}`, innerW, ANSI.cyan));
    }
    out.push(boxBottom(width, ANSI.cyan));
    return out;
  }

  if (modal.type === 'input') {
    out.push(boxTop(modal.title, width, ANSI.cyan));
    if (modal.subtitle) {
      out.push(boxLine(paint(ANSI.gray, modal.subtitle), innerW, ANSI.cyan));
    }
    out.push(boxLine('', innerW, ANSI.cyan));
    out.push(boxLine(paint(ANSI.bold, modal.label), innerW, ANSI.cyan));
    const displayVal = modal.value
      ? paint(ANSI.white, modal.value) + paint(ANSI.inverse, ' ')
      : paint(ANSI.gray, modal.placeholder ?? '') + paint(ANSI.inverse, ' ');
    out.push(boxLine(`> ${displayVal}`, innerW, ANSI.cyan));
    out.push(boxLine('', innerW, ANSI.cyan));
    out.push(boxLine(paint(ANSI.gray, 'Nhấn [Enter] để xác nhận • [Esc] để hủy'), innerW, ANSI.cyan));
    out.push(boxBottom(width, ANSI.cyan));
    return out;
  }

  if (modal.type === 'form') {
    out.push(boxTop(modal.title, width, ANSI.cyan));
    out.push(
      boxLine(
        paint(ANSI.gray, '[↑/↓ hoặc Tab] Chuyển trường • [←/→] Đổi lựa chọn • [Ctrl+S / Enter dòng cuối] Lưu • [Esc] Hủy'),
        innerW,
        ANSI.cyan,
      ),
    );
    out.push(boxSep(width, ANSI.cyan));
    for (let i = 0; i < modal.fields.length; i += 1) {
      const f = modal.fields[i];
      const active = i === modal.cursor;
      const mark = active ? paint(ANSI.cyan + ANSI.bold, '▸ ') : '  ';
      const labelStr = padRightWidth((active ? paint(ANSI.bold, f.label) : f.label) + (f.required ? '*' : ''), 24);
      let valStr: string;
      if (f.options) {
        valStr = active
          ? paint(ANSI.brightGreen + ANSI.bold, `◂ ${f.value} ▸`)
          : paint(ANSI.cyan, f.value);
      } else if (active) {
        valStr = (f.value ? paint(ANSI.white, f.value) : paint(ANSI.gray, f.placeholder ?? '')) + paint(ANSI.inverse, ' ');
      } else {
        valStr = f.value || paint(ANSI.gray, f.placeholder ?? '(trống)');
      }
      out.push(boxLine(`${mark}${labelStr} ${valStr}`, innerW, ANSI.cyan));
    }
    if (modal.error) {
      out.push(boxSep(width, ANSI.cyan));
      out.push(boxLine(paint(ANSI.red, `Lỗi: ${modal.error}`), innerW, ANSI.cyan));
    }
    out.push(boxBottom(width, ANSI.cyan));
    return out;
  }

  if (modal.type === 'confirm-delete') {
    out.push(boxTop(`Xóa tài khoản: ${modal.alias}`, width, ANSI.red));
    out.push(boxLine(`Bạn chắc chắn muốn xóa "${paint(ANSI.bold, modal.alias)}" (${modal.email}) khỏi pool?`, innerW, ANSI.red));
    if (modal.isIsolated) {
      const box = modal.purgeProfile ? paint(ANSI.red + ANSI.bold, '[x]') : '[ ]';
      out.push(boxLine(`${box} Xóa luôn thư mục Chrome profile riêng (nhấn [Space] để bật/tắt)`, innerW, ANSI.red));
    } else {
      out.push(boxLine(paint(ANSI.gray, 'Tài khoản đang ở chế độ Link — KHÔNG bao giờ xóa Chrome profile gốc.'), innerW, ANSI.red));
    }
    out.push(boxLine('', innerW, ANSI.red));
    out.push(boxLine(paint(ANSI.yellow, 'Nhấn [y] hoặc [Enter] để XÓA • [n] hoặc [Esc] để hủy'), innerW, ANSI.red));
    out.push(boxBottom(width, ANSI.red));
    return out;
  }

  if (modal.type === 'confirm-force-agy') {
    out.push(boxTop(`Không thể nạp phiên agy cho "${modal.alias}"`, width, ANSI.yellow));
    out.push(boxLine(paint(ANSI.yellow, modal.reason), innerW, ANSI.yellow));
    out.push(boxLine('', innerW, ANSI.yellow));
    out.push(boxLine('Khuyên dùng: đóng cửa sổ/CLI agy trước rồi nhấn [r] thử lại.', innerW, ANSI.yellow));
    out.push(boxLine(paint(ANSI.red, 'Hoặc nhấn [F] để ép nạp (--force) nếu bạn chắc chắn.'), innerW, ANSI.yellow));
    out.push(boxLine(paint(ANSI.gray, '[r] Thử lại  •  [F] Ép nạp (--force)  •  [Esc] Hủy'), innerW, ANSI.yellow));
    out.push(boxBottom(width, ANSI.yellow));
    return out;
  }

  if (modal.type === 'agy-status') {
    const st = modal.status;
    out.push(boxTop('Trạng thái phiên agy CLI (macOS Keychain)', width, ANSI.cyan));
    out.push(
      boxLine(
        `Keychain ("gemini"/"antigravity"): ${st.keychain_present ? paint(ANSI.brightGreen, 'Có phiên') : paint(ANSI.gray, 'Trống')}`,
        innerW,
        ANSI.cyan,
      ),
    );
    out.push(
      boxLine(
        `Chủ phiên hiện tại: ${st.live_owner_alias ? paint(ANSI.brightGreen + ANSI.bold, st.live_owner_alias) : paint(ANSI.yellow, st.live_unknown ? 'Không rõ (chưa capture)' : '—')}  │  Marker: ${st.marker_alias ?? '—'}`,
        innerW,
        ANSI.cyan,
      ),
    );
    out.push(
      boxLine(
        `Tiến trình agy đang chạy: ${st.running_clients.length > 0 ? paint(ANSI.yellow, st.running_clients.join('; ')) : paint(ANSI.green, 'Không có (sẵn sàng đổi phiên)')}`,
        innerW,
        ANSI.cyan,
      ),
    );
    out.push(boxSep(width, ANSI.cyan));
    if (st.sessions.length === 0) {
      out.push(boxLine(paint(ANSI.gray, 'Chưa có snapshot nào. Đăng nhập agy rồi nhấn [c] để lưu.'), innerW, ANSI.cyan));
    } else {
      out.push(
        boxLine(
          `${padRightWidth(paint(ANSI.bold, 'ALIAS'), 18)} ${padRightWidth(paint(ANSI.bold, 'EMAIL PHÁT HIỆN'), 30)} ${padRightWidth(paint(ANSI.bold, 'LƯU LÚC'), 16)} LIVE`,
          innerW,
          ANSI.cyan,
        ),
      );
      for (const s of st.sessions.slice(0, Math.max(4, maxBodyRows - 7))) {
        out.push(
          boxLine(
            `${padRightWidth(s.alias, 18)} ${padRightWidth(s.detected_email ?? '—', 30)} ${padRightWidth(formatTimeShort(s.captured_at), 16)} ${s.is_live ? paint(ANSI.brightGreen + ANSI.bold, '★ LIVE') : ''}`,
            innerW,
            ANSI.cyan,
          ),
        );
      }
    }
    out.push(boxBottom(width, ANSI.cyan));
    return out;
  }

  if (modal.type === 'events') {
    const events = state.snapshot?.events ?? [];
    const visibleH = Math.max(6, maxBodyRows - 3);
    const start = Math.max(0, Math.min(modal.scroll, Math.max(0, events.length - visibleH)));
    out.push(boxTop(`Nhật ký hoạt động gần đây (${events.length}) — [↑/↓] Cuộn`, width, ANSI.cyan));
    if (events.length === 0) {
      out.push(boxLine(paint(ANSI.gray, 'Chưa có sự kiện nào.'), innerW, ANSI.cyan));
    } else {
      for (const ev of events.slice(start, start + visibleH)) {
        const ts = paint(ANSI.gray, formatTimeShort(ev.created_at));
        const msg = truncateWidth(ev.message, innerW - 14);
        out.push(boxLine(`${ts}  ${msg}`, innerW, ANSI.cyan));
      }
    }
    out.push(boxBottom(width, ANSI.cyan));
    return out;
  }

  // Help modal
  const helpEntries: Array<[string, string, string]> = [
    ['↑/↓ hoặc j/k', 'Di chuyển chọn tài khoản (1-9 nhảy nhanh)', 'gpool list'],
    ['Enter hoặc s', 'Chọn (Switch) tài khoản & mở Chrome Profile', 'gpool switch <alias>'],
    ['S (Shift+s)', 'Chọn (Switch) tài khoản KHÔNG mở Chrome', 'gpool switch <alias> --no-open'],
    ['g', 'Nạp phiên agy & chạy trực tiếp lệnh agy CLI', 'gpool run <alias> -- agy'],
    ['a', 'Nạp phiên agy đã lưu vào macOS Keychain', 'gpool agy-activate <alias>'],
    ['c', 'Lưu phiên agy đang đăng nhập vào tài khoản', 'gpool agy-capture <alias>'],
    ['A (Shift+a)', 'Xem trạng thái Keychain agy & danh sách snapshot', 'gpool agy-status'],
    ['n', 'Đặt cooldown acc hiện tại & xoay sang acc kế tiếp', 'gpool next --cooldown 5'],
    ['o / l', 'Mở Chrome Profile / Mở trang đăng nhập điền sẵn email', 'gpool open / login <alias>'],
    ['u', 'Mở link OAuth (tự lấy từ Clipboard) vào đúng profile', 'gpool auth <alias> [url]'],
    ['x', 'Đặt cooldown (+1h/+5h/+24h/+7d/tùy chỉnh) hoặc gỡ', 'gpool cooldown <alias> 5'],
    ['p / P', 'Kiểm tra phiên 1 acc / Quét giữ phiên toàn bộ pool', 'gpool check [alias]'],
    ['+', 'Thêm tài khoản mới bằng form tương tác', 'gpool add <alias> <email>'],
    ['i', 'Nhập nhanh từ Chrome / Clipboard SignOutOptions / danh sách', 'gpool import-chrome / clipboard'],
    ['t', 'Tách tài khoản Link sang Chrome profile riêng độc lập', 'gpool isolate <alias|--all>'],
    ['e / d', 'Sửa thông tin / Xóa tài khoản khỏi pool', 'gpool edit / rm <alias>'],
    ['/ và f', 'Tìm kiếm trực tiếp và lọc theo trạng thái', 'gpool list -q ... --status ...'],
    ['v / D / r', 'Xem nhật ký / Quản lý Daemon-Web-MenuBar / Làm mới', 'gpool daemon / dashboard'],
    ['? / q', 'Mở bảng hướng dẫn này / Thoát TUI', 'gpool help [command]'],
  ];

  const visibleH = Math.max(6, maxBodyRows - 4);
  const start = Math.max(0, Math.min(modal.scroll, Math.max(0, helpEntries.length - visibleH)));
  out.push(boxTop('Hướng dẫn phím tắt TUI & Lệnh CLI tương ứng ([↑/↓] cuộn, [Esc] đóng)', width, ANSI.cyan));
  out.push(
    boxLine(
      `${padRightWidth(paint(ANSI.bold, 'PHÍM TẮT'), 15)} ${padRightWidth(paint(ANSI.bold, 'CÔNG DỤNG'), Math.max(24, innerW - 47))} ${paint(ANSI.bold, 'LỆNH CLI TƯƠNG ĐƯƠNG')}`,
      innerW,
      ANSI.cyan,
    ),
  );
  out.push(boxSep(width, ANSI.cyan));
  const descW = Math.max(24, innerW - 47);
  for (const [key, desc, cmd] of helpEntries.slice(start, start + visibleH)) {
    out.push(
      boxLine(
        `${padRightWidth(paint(ANSI.cyan + ANSI.bold, key), 15)} ${padRightWidth(desc, descW)} ${paint(ANSI.gray, cmd)}`,
        innerW,
        ANSI.cyan,
      ),
    );
  }
  out.push(boxBottom(width, ANSI.cyan));
  return out;
}

// ── Backend Adapter (Daemon HTTP when online, Local DB fallback when offline) ──

async function isDaemonAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${DEFAULT_HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(600),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function callDaemon<T>(port: number, route: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://${DEFAULT_HOST}:${port}${route}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Daemon trả lỗi HTTP ${res.status}`);
  }
  return data as T;
}

async function readClipboard(): Promise<string> {
  if (process.platform !== 'darwin') return '';
  return await new Promise<string>((resolve) => {
    execFile('/usr/bin/pbpaste', [], (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function openExternalUrl(url: string): void {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/open', [url], () => {});
  }
}

async function fetchSnapshot(paths: PoolPaths, port: number): Promise<TuiSnapshot> {
  if (await isDaemonAlive(port)) {
    const [accData, evData, setData] = await Promise.all([
      callDaemon<{
        accounts: AccountView[];
        activeAlias: string | null;
        summary: TuiSnapshot['summary'];
        keepalive: TuiSnapshot['keepalive'];
        settings?: DaemonSettings;
        agyStatus?: TuiAgySummary | null;
      }>(port, '/api/accounts'),
      callDaemon<{ events: PoolEvent[] }>(port, '/api/events?limit=40'),
      callDaemon<{ settings: DaemonSettings }>(port, '/api/settings'),
    ]);
    let agyStatus = accData.agyStatus ?? null;
    if (!agyStatus) {
      try {
        const ctx = getLiveKeychainContext(paths);
        agyStatus = {
          keychain_present: ctx.present,
          live_owner_alias: ctx.live_owner_alias,
          live_unknown: ctx.live_unknown,
          live_email: ctx.live_email,
          marker_alias: ctx.marker_alias,
        };
      } catch {
        agyStatus = null;
      }
    }
    return {
      daemonOnline: true,
      accounts: accData.accounts,
      activeAlias: accData.activeAlias,
      summary: accData.summary,
      keepalive: accData.keepalive,
      settings: setData.settings ?? accData.settings!,
      events: evData.events,
      agyStatus,
    };
  }

  const db = new PoolDB(paths);
  try {
    db.expireElapsedCooldowns();
    let liveCtx: ReturnType<typeof getLiveKeychainContext> | null = null;
    try {
      liveCtx = getLiveKeychainContext(paths);
    } catch {
      liveCtx = null;
    }

    const accounts = db.listAccounts().map((acc) => {
      const view = db.computeAccountView(acc, isAccountChromeRunning(acc).running);
      if (liveCtx) {
        view.agy_session = sessionInfoForAlias(
          paths,
          view.alias,
          liveCtx.live_sha,
          liveCtx.marker_alias,
          liveCtx.live_owner_alias,
        );
      }
      return view;
    });
    const active = accounts.find((a) => a.is_active) ?? null;
    return {
      daemonOnline: false,
      accounts,
      activeAlias: active?.alias ?? null,
      summary: {
        total: accounts.length,
        ready: accounts.filter((a) => a.effective_state === 'ready' || a.effective_state === 'active').length,
        cooldown: accounts.filter((a) => a.effective_state === 'cooldown').length,
        needs_login: accounts.filter((a) => a.effective_state === 'needs_login').length,
        unknown: accounts.filter((a) => a.effective_state === 'unknown').length,
        error: accounts.filter((a) => a.effective_state === 'error').length,
      },
      keepalive: { running: false, sweeping: false, activeProbes: [], lastSweepAt: null },
      settings: db.getSettings(),
      events: db.listEvents(40),
      agyStatus: liveCtx
        ? {
            keychain_present: liveCtx.present,
            live_owner_alias: liveCtx.live_owner_alias,
            live_unknown: liveCtx.live_unknown,
            live_email: liveCtx.live_email,
            marker_alias: liveCtx.marker_alias,
          }
        : null,
    };
  } finally {
    db.close();
  }
}

async function runBulkImportLocalOrDaemon(
  payload: {
    mode: ProfileMode;
    chrome_user_data_dir?: string | null;
    chrome_profile_name?: string | null;
    plan_tier?: PlanTier;
    tags?: string[];
    items: BulkImportItemInput[];
  },
  paths: PoolPaths,
  port: number,
): Promise<BulkImportResult> {
  if (await isDaemonAlive(port)) {
    return await callDaemon<BulkImportResult>(port, '/api/import/chrome', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  const db = new PoolDB(paths);
  try {
    const existing = db.listAccounts();
    const existingEmails = new Set(existing.map((a) => a.email.toLowerCase()));
    const existingAliases = new Set(existing.map((a) => a.alias.toLowerCase()));
    const defaultUserDataDir = getDefaultBrowserRoots()[0].userDataDir;
    const created: AccountView[] = [];
    const skipped: Array<{ email: string; reason: string }> = [];
    const errors: Array<{ email: string; error: string }> = [];

    for (const item of payload.items) {
      let email: string;
      try {
        email = validateEmail(item.email);
      } catch (err) {
        errors.push({ email: item.email, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (existingEmails.has(email)) {
        skipped.push({ email, reason: 'Email đã có trong pool' });
        continue;
      }
      let alias: string;
      if (item.alias?.trim()) {
        try {
          const candidate = validateAlias(item.alias);
          if (existingAliases.has(candidate)) {
            alias = generateUniqueAlias(email, existingAliases);
          } else {
            existingAliases.add(candidate);
            alias = candidate;
          }
        } catch {
          alias = generateUniqueAlias(email, existingAliases);
        }
      } else {
        alias = generateUniqueAlias(email, existingAliases);
      }
      const userDataDir = (item.chrome_user_data_dir ?? payload.chrome_user_data_dir ?? defaultUserDataDir).trim();
      const profileName = (item.chrome_profile_name ?? payload.chrome_profile_name ?? 'Default').trim() || 'Default';
      let hasCookies = false;
      if (typeof item.has_cookies === 'boolean') {
        hasCookies = item.has_cookies;
      } else {
        try {
          fs.statSync(path.join(path.resolve(userDataDir), profileName, 'Cookies'));
          hasCookies = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          hasCookies = code === 'EPERM' || code === 'EACCES';
        }
      }
      try {
        const rec = db.createAccount({
          alias,
          email,
          display_name: item.display_name ?? '',
          plan_tier: item.plan_tier ?? payload.plan_tier ?? 'Google AI Pro',
          tags: item.tags ?? payload.tags ?? ['pro'],
          notes: item.notes ?? '',
          profile_mode: payload.mode,
          chrome_user_data_dir: payload.mode === 'linked' ? userDataDir : null,
          chrome_profile_name: payload.mode === 'linked' ? profileName : null,
          google_authuser: payload.mode === 'linked' ? (item.google_authuser?.trim() || email) : null,
          initial_session_status: payload.mode === 'linked' && hasCookies ? 'live' : 'unknown',
          initial_session_detail:
            payload.mode === 'linked'
              ? `Liên kết trực tiếp Chrome (${profileName})`
              : 'Đã nhập vào pool — bấm Đăng nhập Chrome 1 lần',
        });
        existingEmails.add(email);
        created.push(db.computeAccountView(rec, isAccountChromeRunning(rec).running));
      } catch (err) {
        errors.push({ email, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { created, skipped, errors };
  } finally {
    db.close();
  }
}

export interface RunTuiOptions {
  paths: PoolPaths;
  port: number;
  runCliSubcommand: (argv: string[]) => Promise<number>;
}

/**
 * Starts the interactive full-screen Terminal UI for Google One Pool.
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Lỗi: Chế độ TUI yêu cầu terminal tương tác (TTY). Dùng "gpool help" để xem các lệnh CLI.');
    return 1;
  }

  const { paths, port } = options;
  const state: TuiState = {
    snapshot: null,
    selectedIndex: 0,
    scrollOffset: 0,
    filterStatus: 'all',
    searchQuery: '',
    searchActive: false,
    busyMessage: null,
    notice: { text: 'Nhấn [?] để xem bảng phím tắt & lệnh CLI tương ứng.', kind: 'info' },
    modal: null,
  };

  let exited = false;
  let suspended = false;
  let actionLock = false;
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const enterAltScreen = () => {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
  };

  const leaveAltScreen = () => {
    if (process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore.
      }
    }
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  };

  const draw = () => {
    if (exited || suspended) return;
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const frame = renderTuiFrame(state, cols, rows);
    const paddedLines = frame.map((l) => l + '\x1b[K');
    while (paddedLines.length < rows) paddedLines.push('\x1b[K');
    process.stdout.write('\x1b[H' + paddedLines.slice(0, rows).join('\r\n'));
  };

  const setNotice = (text: string, kind: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    state.notice = { text, kind };
  };

  const getFiltered = (): AccountView[] => {
    if (!state.snapshot) return [];
    return filterTuiAccounts(state.snapshot.accounts, state.filterStatus, state.searchQuery);
  };

  const getSelected = (): AccountView | null => {
    const list = getFiltered();
    if (list.length === 0) return null;
    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, list.length - 1));
    return list[state.selectedIndex];
  };

  const refresh = async (silent = false) => {
    try {
      const prevAlias = getSelected()?.alias ?? null;
      state.snapshot = await fetchSnapshot(paths, port);
      const list = getFiltered();
      if (prevAlias) {
        const idx = list.findIndex((a) => a.alias === prevAlias);
        if (idx >= 0) state.selectedIndex = idx;
      }
      state.selectedIndex = list.length > 0 ? Math.max(0, Math.min(state.selectedIndex, list.length - 1)) : 0;
    } catch (err) {
      if (!silent) {
        setNotice(`Lỗi tải dữ liệu: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    draw();
  };

  const runAction = async (busyLabel: string, fn: () => Promise<void>) => {
    if (actionLock) return;
    actionLock = true;
    state.busyMessage = busyLabel;
    draw();
    try {
      await fn();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      state.busyMessage = null;
      actionLock = false;
      await refresh(true);
    }
  };

  const suspendAndRun = async (fn: () => Promise<void>) => {
    suspended = true;
    process.stdin.off('keypress', onKeypress);
    leaveAltScreen();
    try {
      await fn();
    } finally {
      suspended = false;
      enterAltScreen();
      process.stdin.on('keypress', onKeypress);
      await refresh(true);
    }
  };

  const cleanupAndExit = (code = 0) => {
    if (exited) return;
    exited = true;
    clearInterval(refreshTimer);
    clearInterval(tickTimer);
    process.stdin.off('keypress', onKeypress);
    process.stdout.off('resize', draw);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    leaveAltScreen();
    process.stdin.pause();
    resolveExit(code);
  };

  const onSignal = () => cleanupAndExit(0);

  // ── Action Implementations ───────────────────────────────

  const doSwitch = async (alias: string, openChrome: boolean) => {
    await runAction(`Đang chuyển sang "${alias}"...`, async () => {
      if (await isDaemonAlive(port)) {
        await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/switch`, {
          method: 'POST',
          body: JSON.stringify({ openChrome }),
        });
      } else {
        const db = new PoolDB(paths);
        try {
          const sw = new PoolSwitcher({ db, paths });
          await sw.switchTo(alias, { openChrome });
        } finally {
          db.close();
        }
      }
      setNotice(`Đã chuyển sang "${alias}"${openChrome ? ' và mở Chrome' : ''}.`, 'success');
    });
  };

  const doOpenChrome = async (alias: string, loginMode: boolean) => {
    await runAction(`Đang mở Chrome cho "${alias}"...`, async () => {
      const route = loginMode ? 'login' : 'open';
      if (await isDaemonAlive(port)) {
        await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/${route}`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } else {
        const db = new PoolDB(paths);
        try {
          const sw = new PoolSwitcher({ db, paths });
          if (loginMode) await sw.openLogin(alias);
          else await sw.openProfile(alias);
        } finally {
          db.close();
        }
      }
      setNotice(
        loginMode ? `Đã mở Chrome đăng nhập cho "${alias}" (điền sẵn email).` : `Đã mở Chrome profile "${alias}".`,
        'success',
      );
    });
  };

  const doAgyCapture = async (alias: string) => {
    await runAction(`Đang lưu phiên agy vào "${alias}"...`, async () => {
      let res;
      if (await isDaemonAlive(port)) {
        res = await callDaemon<{ alias: string; detected_email: string | null; warning?: string }>(
          port,
          `/api/accounts/${encodeURIComponent(alias)}/agy-capture`,
          { method: 'POST', body: JSON.stringify({}) },
        );
      } else {
        const db = new PoolDB(paths);
        try {
          const acc = db.getAccount(alias);
          if (!acc) throw new Error(`Không tìm thấy "${alias}".`);
          res = captureAgySession(paths, acc);
          db.addEvent(acc.id, acc.alias, 'agy_session_captured', `Đã lưu phiên đăng nhập agy của ${acc.alias}`);
        } finally {
          db.close();
        }
      }
      setNotice(
        `Đã lưu phiên agy vào "${res.alias}"${res.detected_email ? ` (${res.detected_email})` : ''}.${res.warning ? ` ${res.warning}` : ''}`,
        res.warning ? 'warn' : 'success',
      );
    });
  };

  const doAgyActivate = async (alias: string, force = false) => {
    await runAction(`Đang nạp phiên agy của "${alias}"...`, async () => {
      try {
        let res;
        if (await isDaemonAlive(port)) {
          res = await callDaemon<{ alias: string; recaptured_alias: string | null }>(
            port,
            `/api/accounts/${encodeURIComponent(alias)}/agy-activate`,
            { method: 'POST', body: JSON.stringify({ force }) },
          );
        } else {
          const db = new PoolDB(paths);
          try {
            const acc = db.getAccount(alias);
            if (!acc) throw new Error(`Không tìm thấy "${alias}".`);
            res = activateAgySession(paths, acc, { force });
            db.addEvent(acc.id, acc.alias, 'agy_session_activated', `Đã nạp phiên agy của ${acc.alias} vào Keychain`);
          } finally {
            db.close();
          }
        }
        state.modal = null;
        setNotice(
          `Đã nạp phiên agy "${res.alias}" vào Keychain${res.recaptured_alias ? ` (đã cập nhật snapshot "${res.recaptured_alias}")` : ''}.`,
          'success',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!force && /tiến trình agy/i.test(msg)) {
          state.modal = { type: 'confirm-force-agy', alias, reason: msg };
          setNotice('agy đang chạy — đóng agy trước hoặc nhấn [F] để ép nạp.', 'warn');
        } else {
          throw err;
        }
      }
    });
  };

  const doLaunchAgy = async (alias: string) => {
    await suspendAndRun(async () => {
      console.log(`\n[gpool] Đang khởi chạy "agy" với tài khoản "${alias}"...\n`);
      const db = new PoolDB(paths);
      let env: NodeJS.ProcessEnv;
      try {
        const acc = db.getAccount(alias);
        if (!acc) {
          console.error(`Không tìm thấy tài khoản "${alias}".`);
          return;
        }
        if (hasSessionSnapshot(paths, acc.alias)) {
          const res = activateAgySession(paths, acc, { force: false });
          console.log(
            `✓ Đã nạp phiên agy của "${acc.alias}" vào Keychain` +
              (res.recaptured_alias ? ` (đã cập nhật snapshot "${res.recaptured_alias}")` : '') +
              '.',
          );
          db.addEvent(acc.id, acc.alias, 'agy_session_activated', `gpool tui nạp phiên agy cho ${acc.alias}`);
        } else {
          console.log(
            `! "${acc.alias}" chưa lưu phiên agy — mở agy với phiên Keychain hiện tại. Sau khi login, nhấn [c] trong TUI để lưu.`,
          );
        }
        const sw = new PoolSwitcher({ db, paths });
        env = sw.buildOfficialRunEnv(acc, 'agy').env;
      } catch (err) {
        console.error(`Lỗi nạp phiên agy: ${err instanceof Error ? err.message : String(err)}`);
        await waitEnterOnCookedStdin();
        return;
      } finally {
        db.close();
      }

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn('agy', [], { env, stdio: 'inherit' });
        child.once('error', (err) => {
          console.error(`Không chạy được lệnh "agy": ${err.message}`);
          resolve(1);
        });
        child.once('exit', (code) => resolve(code ?? 0));
      });
      if (exitCode !== 0) {
        console.log(`\nagy thoát với mã ${exitCode}.`);
        await waitEnterOnCookedStdin();
      }
    });
    setNotice(`Đã quay lại TUI sau khi chạy agy (${alias}).`, 'info');
  };

  const doRotateNext = async (cooldownHours: number) => {
    await runAction('Đang xoay vòng sang tài khoản sẵn sàng kế tiếp...', async () => {
      let res: { ok: boolean; active?: AccountView; error?: string };
      if (await isDaemonAlive(port)) {
        try {
          res = await callDaemon(port, '/api/pool/next', {
            method: 'POST',
            body: JSON.stringify({ cooldownHours, openChrome: true }),
          });
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        const db = new PoolDB(paths);
        try {
          const sw = new PoolSwitcher({ db, paths });
          res = await sw.rotateNext({ cooldownHours, openChrome: true });
        } finally {
          db.close();
        }
      }
      if (!res.ok || !res.active) {
        setNotice(res.error ?? 'Không còn tài khoản sẵn sàng.', 'warn');
      } else {
        setNotice(`Đã xoay vòng sang "${res.active.alias}" (${res.active.email})!`, 'success');
      }
    });
  };

  const doCooldown = async (alias: string, hours: number | 'clear') => {
    await runAction(hours === 'clear' ? `Đang gỡ cooldown ${alias}...` : `Đang đặt cooldown +${hours}h...`, async () => {
      if (await isDaemonAlive(port)) {
        if (hours === 'clear') {
          await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/cooldown`, { method: 'DELETE' });
        } else {
          await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/cooldown`, {
            method: 'POST',
            body: JSON.stringify({ hours, reason: `Đặt từ TUI (+${hours}h)` }),
          });
        }
      } else {
        const db = new PoolDB(paths);
        try {
          if (hours === 'clear') {
            db.clearCooldown(alias);
          } else {
            db.setCooldown(alias, new Date(Date.now() + hours * 3_600_000).toISOString(), `Đặt từ TUI (+${hours}h)`);
          }
        } finally {
          db.close();
        }
      }
      setNotice(
        hours === 'clear' ? `Đã gỡ cooldown cho "${alias}".` : `Đã đặt cooldown +${hours}h cho "${alias}".`,
        hours === 'clear' ? 'success' : 'warn',
      );
    });
  };

  const doCheck = async (alias?: string) => {
    await runAction(alias ? `Đang kiểm tra phiên "${alias}"...` : 'Đang quét Keep-Alive toàn bộ pool...', async () => {
      if (await isDaemonAlive(port)) {
        if (alias) {
          const res = await callDaemon<{ result: { alias: string; status: string; detail: string } }>(
            port,
            `/api/accounts/${encodeURIComponent(alias)}/check`,
            { method: 'POST' },
          );
          setNotice(
            `${res.result.alias}: ${res.result.status} — ${res.result.detail}`,
            res.result.status === 'needs_login' || res.result.status === 'error' ? 'warn' : 'success',
          );
        } else {
          const res = await callDaemon<{ results: Array<{ alias: string; status: string }> }>(
            port,
            '/api/keepalive/sweep',
            { method: 'POST' },
          );
          setNotice(`Đã quét xong ${res.results.length} tài khoản.`, 'success');
        }
      } else {
        const db = new PoolDB(paths);
        try {
          const scheduler = new KeepAliveScheduler({ db, staggerDelayMs: 500 });
          if (alias) {
            const res = await scheduler.probeAccount(alias);
            setNotice(`${res.alias}: ${res.status} — ${res.detail}`, res.status === 'needs_login' ? 'warn' : 'success');
          } else {
            const results = await scheduler.sweepAll();
            setNotice(`Đã quét xong ${results.length} tài khoản.`, 'success');
          }
        } finally {
          db.close();
        }
      }
    });
  };

  const doOpenOAuth = async (alias: string, oauthUrl: string) => {
    await runAction(`Đang mở link OAuth trong "${alias}"...`, async () => {
      if (await isDaemonAlive(port)) {
        await callDaemon(port, `/api/accounts/${encodeURIComponent(alias)}/oauth`, {
          method: 'POST',
          body: JSON.stringify({ oauthUrl }),
        });
      } else {
        const db = new PoolDB(paths);
        try {
          const sw = new PoolSwitcher({ db, paths });
          await sw.openOAuthInAccount(alias, oauthUrl);
        } finally {
          db.close();
        }
      }
      setNotice(`Đã mở link OAuth trong Chrome cho "${alias}".`, 'success');
    });
  };

  const doIsolate = async (aliasOrAll: string | 'all') => {
    await runAction(
      aliasOrAll === 'all' ? 'Đang tách tất cả tài khoản Link...' : `Đang tách "${aliasOrAll}" sang profile riêng...`,
      async () => {
        if (await isDaemonAlive(port)) {
          if (aliasOrAll === 'all') {
            const res = await callDaemon<{ count: number }>(port, '/api/accounts/isolate-all', { method: 'POST' });
            setNotice(`Đã tách ${res.count} tài khoản sang Chrome profile riêng.`, 'success');
          } else {
            await callDaemon(port, `/api/accounts/${encodeURIComponent(aliasOrAll)}/isolate`, {
              method: 'POST',
              body: JSON.stringify({ openChrome: true }),
            });
            setNotice(`Đã tách "${aliasOrAll}" sang profile riêng và mở Chrome đăng nhập.`, 'success');
          }
        } else {
          const db = new PoolDB(paths);
          try {
            const sw = new PoolSwitcher({ db, paths });
            if (aliasOrAll === 'all') {
              const res = sw.isolateAllLinked();
              setNotice(`Đã tách ${res.count} tài khoản sang Chrome profile riêng.`, 'success');
            } else {
              await sw.isolateAccount(aliasOrAll, { openChrome: true });
              setNotice(`Đã tách "${aliasOrAll}" sang profile riêng và mở Chrome đăng nhập.`, 'success');
            }
          } finally {
            db.close();
          }
        }
      },
    );
  };

  const doDelete = async (alias: string, purgeProfile: boolean) => {
    await runAction(`Đang xóa tài khoản "${alias}"...`, async () => {
      if (await isDaemonAlive(port)) {
        await callDaemon(
          port,
          `/api/accounts/${encodeURIComponent(alias)}?purgeProfile=${purgeProfile ? 'true' : 'false'}`,
          { method: 'DELETE' },
        );
      } else {
        const db = new PoolDB(paths);
        try {
          db.deleteAccount(alias, { purgeProfile });
        } finally {
          db.close();
        }
      }
      setNotice(`Đã xóa tài khoản "${alias}".`, 'success');
    });
  };

  const openAccountForm = (existing: AccountView | null) => {
    const fields: FormField[] = [
      { key: 'alias', label: 'Alias', value: existing?.alias ?? '', placeholder: 'vd: pro1', required: true },
      { key: 'email', label: 'Email Google', value: existing?.email ?? '', placeholder: 'ten@gmail.com', required: true },
      { key: 'display_name', label: 'Tên hiển thị', value: existing?.display_name ?? '', placeholder: 'Tuỳ chọn' },
      { key: 'plan_tier', label: 'Gói cước', value: existing?.plan_tier ?? 'Google AI Pro', options: VALID_PLAN_TIERS },
      { key: 'tags', label: 'Tags (dấu phẩy)', value: existing ? existing.tags.join(', ') : 'pro', placeholder: 'pro, work' },
      { key: 'renewal_date', label: 'Ngày gia hạn', value: existing?.renewal_date ?? '', placeholder: 'YYYY-MM-DD' },
      { key: 'proxy_url', label: 'Proxy riêng', value: existing?.proxy_url ?? '', placeholder: 'http://127.0.0.1:8080' },
      { key: 'notes', label: 'Ghi chú', value: existing?.notes ?? '', placeholder: 'Ghi chú nội bộ' },
    ];
    state.modal = {
      type: 'form',
      title: existing ? `Sửa tài khoản: ${existing.alias}` : 'Thêm tài khoản mới',
      editingAlias: existing?.alias ?? null,
      fields,
      cursor: 0,
      error: null,
    };
    draw();
  };

  const submitAccountForm = async () => {
    if (state.modal?.type !== 'form') return;
    const m = state.modal;
    const val = (k: string) => m.fields.find((f) => f.key === k)?.value.trim() ?? '';
    const alias = val('alias');
    const email = val('email');
    if (!alias || !email) {
      m.error = 'Cần nhập đầy đủ Alias và Email.';
      draw();
      return;
    }

    const payload = {
      alias,
      email,
      display_name: val('display_name'),
      plan_tier: val('plan_tier') as PlanTier,
      tags: val('tags').split(',').map((t) => t.trim()).filter(Boolean),
      renewal_date: val('renewal_date') || null,
      proxy_url: val('proxy_url') || null,
      notes: val('notes'),
    };

    try {
      state.busyMessage = m.editingAlias ? `Đang cập nhật "${m.editingAlias}"...` : `Đang thêm "${alias}"...`;
      draw();
      if (await isDaemonAlive(port)) {
        if (m.editingAlias) {
          await callDaemon(port, `/api/accounts/${encodeURIComponent(m.editingAlias)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
        } else {
          await callDaemon(port, '/api/accounts', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }
      } else {
        const db = new PoolDB(paths);
        try {
          if (m.editingAlias) db.updateAccount(m.editingAlias, payload);
          else db.createAccount(payload);
        } finally {
          db.close();
        }
      }
      state.modal = null;
      state.busyMessage = null;
      setNotice(m.editingAlias ? `Đã cập nhật "${alias}".` : `Đã thêm "${alias}" (${email}).`, 'success');
      await refresh(true);
    } catch (err) {
      state.busyMessage = null;
      m.error = err instanceof Error ? err.message : String(err);
      draw();
    }
  };

  const handleMenuSelection = async (modal: Extract<TuiModal, { type: 'menu' }>) => {
    const chosen = modal.items[modal.cursor];
    if (!chosen) return;
    const sel = getSelected();

    if (modal.kind === 'cooldown') {
      state.modal = null;
      if (!sel) return;
      if (chosen.id === 'clear') {
        await doCooldown(sel.alias, 'clear');
      } else if (chosen.id === 'custom') {
        state.modal = {
          type: 'input',
          kind: 'cooldown-custom',
          title: `Đặt cooldown tùy chỉnh cho "${sel.alias}"`,
          label: 'Nhập số giờ cooldown (ví dụ: 2.5, 12, 48):',
          value: String(state.snapshot?.settings.default_cooldown_hours ?? 5),
        };
        draw();
      } else {
        await doCooldown(sel.alias, Number(chosen.id));
      }
      return;
    }

    if (modal.kind === 'isolate') {
      state.modal = null;
      if (chosen.id === 'all') {
        await doIsolate('all');
      } else if (sel) {
        await doIsolate(sel.alias);
      }
      return;
    }

    if (modal.kind === 'import') {
      state.modal = null;
      if (chosen.id === 'discover') {
        await runAction('Đang quét tài khoản từ Chrome / Brave...', async () => {
          const existing = state.snapshot?.accounts ?? [];
          const discovered = discoverBrowserProfiles({
            existingEmails: new Set(existing.map((a) => a.email.toLowerCase())),
            existingAliases: new Set(existing.map((a) => a.alias.toLowerCase())),
          });
          const toImport: BulkImportItemInput[] = discovered.discoveredAccounts
            .filter((a) => !a.alreadyInPool)
            .map((a) => ({
              alias: a.suggestedAlias,
              email: a.email,
              display_name: a.fullName,
              chrome_user_data_dir: a.userDataDir,
              chrome_profile_name: a.profileName,
              google_authuser: a.email,
              has_cookies: a.hasCookies,
            }));
          if (toImport.length === 0) {
            const warn = discovered.warnings[0]?.message;
            setNotice(
              warn || 'Không thấy email mới từ metadata Chrome. Hãy dùng "Nhập từ Clipboard" sau khi ⌘A ⌘C SignOutOptions.',
              'warn',
            );
            return;
          }
          const res = await runBulkImportLocalOrDaemon({ mode: 'linked', tags: ['pro'], items: toImport }, paths, port);
          setNotice(`Đã nhập ${res.created.length} tài khoản từ Chrome (bỏ qua ${res.skipped.length}).`, 'success');
        });
      } else if (chosen.id === 'open-signout') {
        openExternalUrl('https://accounts.google.com/SignOutOptions');
        setNotice('Đã mở SignOutOptions — hãy nhấn ⌘A ⌘C rồi chọn [i] → Nhập từ Clipboard.', 'info');
        draw();
      } else if (chosen.id === 'clipboard') {
        await runAction('Đang lọc email từ Clipboard...', async () => {
          const clip = await readClipboard();
          if (!clip) {
            setNotice('Clipboard đang trống. Mở SignOutOptions rồi nhấn ⌘A ⌘C trước.', 'warn');
            return;
          }
          const extracted = extractEmailsFromText(clip);
          if (extracted.length === 0) {
            setNotice('Không tìm thấy email hợp lệ nào trong Clipboard.', 'warn');
            return;
          }
          const rootDir = getDefaultBrowserRoots()[0].userDataDir;
          const items: BulkImportItemInput[] = extracted.map((it) => ({
            alias: it.alias,
            email: it.email,
            display_name: it.display_name,
            notes: it.notes,
            chrome_user_data_dir: rootDir,
            chrome_profile_name: 'Default',
            google_authuser: it.email,
          }));
          const res = await runBulkImportLocalOrDaemon(
            { mode: 'linked', chrome_user_data_dir: rootDir, chrome_profile_name: 'Default', tags: ['pro'], items },
            paths,
            port,
          );
          setNotice(
            `Nhập từ Clipboard xong: thêm ${res.created.length}, bỏ qua ${res.skipped.length}, lỗi ${res.errors.length}.`,
            res.errors.length > 0 ? 'warn' : 'success',
          );
        });
      } else if (chosen.id === 'manual-emails') {
        state.modal = {
          type: 'input',
          kind: 'import-emails',
          title: 'Nhập nhanh danh sách Email (chế độ Link: Default)',
          subtitle: 'Nhập nhiều email cách nhau bởi dấu phẩy hoặc khoảng trắng.',
          label: 'Danh sách email:',
          value: '',
          placeholder: 'acc1@gmail.com, acc2@gmail.com',
        };
        draw();
      } else if (chosen.id === 'login-wizard') {
        await suspendAndRun(async () => {
          await options.runCliSubcommand(['login-wizard']);
          await waitEnterOnCookedStdin();
        });
      }
      return;
    }

    if (modal.kind === 'system') {
      state.modal = null;
      if (chosen.id === 'dashboard') {
        await runAction('Đang mở Web Dashboard...', async () => {
          if (!(await isDaemonAlive(port))) {
            await options.runCliSubcommand(['daemon', 'start', '--port', String(port)]);
          }
          openExternalUrl(`http://${DEFAULT_HOST}:${port}`);
          setNotice(`Đã mở Web Dashboard tại http://${DEFAULT_HOST}:${port}`, 'success');
        });
      } else if (chosen.id === 'daemon-start') {
        await runAction('Đang khởi động daemon nền...', async () => {
          await options.runCliSubcommand(['daemon', 'start', '--port', String(port)]);
          setNotice(`Daemon đã chạy tại http://${DEFAULT_HOST}:${port}`, 'success');
        });
      } else if (chosen.id === 'daemon-stop') {
        await runAction('Đang dừng daemon nền...', async () => {
          await options.runCliSubcommand(['daemon', 'stop', '--port', String(port)]);
          setNotice('Đã dừng daemon nền.', 'info');
        });
      } else if (chosen.id === 'sweep') {
        await doCheck();
      } else if (chosen.id === 'menubar-start') {
        await runAction('Đang bật Menu Bar macOS...', async () => {
          await options.runCliSubcommand(['menubar', 'start', '--port', String(port)]);
          setNotice('Đã mở GoogleOnePoolMenu trên thanh Menu Bar.', 'success');
        });
      } else if (chosen.id === 'menubar-stop') {
        await runAction('Đang tắt Menu Bar macOS...', async () => {
          await options.runCliSubcommand(['menubar', 'stop']);
          setNotice('Đã tắt Menu Bar app.', 'info');
        });
      } else if (chosen.id === 'launchagent-install') {
        await runAction('Đang cài LaunchAgent...', async () => {
          const cliEntryPath = path.resolve(import.meta.dirname, '..', 'bin', 'gpool.ts');
          const res = await installLaunchAgent({ nodeBinary: process.execPath, cliEntryPath, paths, port });
          setNotice(res.message, res.loaded ? 'success' : 'warn');
        });
      } else if (chosen.id === 'launchagent-uninstall') {
        await runAction('Đang gỡ LaunchAgent...', async () => {
          const res = await uninstallLaunchAgent();
          setNotice(res.message, 'info');
        });
      } else if (chosen.id === 'launchagent-status') {
        await runAction('Đang kiểm tra LaunchAgent...', async () => {
          const res = await getLaunchAgentStatus();
          setNotice(`${res.detail} (${res.plistPath})`, res.running ? 'success' : 'info');
        });
      } else if (chosen.id === 'export') {
        const defaultOut = `google-one-pool-backup-${new Date().toISOString().slice(0, 10)}.json`;
        state.modal = {
          type: 'input',
          kind: 'export-file',
          title: 'Xuất backup metadata JSON (không xuất cookie)',
          label: 'Đường dẫn file xuất:',
          value: defaultOut,
        };
        draw();
      }
    }
  };

  const handleInputSubmit = async (modal: Extract<TuiModal, { type: 'input' }>) => {
    const value = modal.value.trim();
    const sel = getSelected();
    state.modal = null;

    if (modal.kind === 'rotate') {
      const hours = Number(value || state.snapshot?.settings.default_cooldown_hours || 5);
      if (!Number.isFinite(hours) || hours < 0) {
        setNotice('Số giờ cooldown không hợp lệ.', 'error');
        draw();
        return;
      }
      await doRotateNext(hours);
      return;
    }

    if (modal.kind === 'cooldown-custom') {
      if (!sel) return;
      const hours = Number(value);
      if (!Number.isFinite(hours) || hours <= 0) {
        setNotice('Số giờ cooldown phải lớn hơn 0.', 'error');
        draw();
        return;
      }
      await doCooldown(sel.alias, hours);
      return;
    }

    if (modal.kind === 'oauth') {
      if (!sel) return;
      if (!value) {
        setNotice('Chưa nhập link OAuth.', 'warn');
        draw();
        return;
      }
      await doOpenOAuth(sel.alias, value);
      return;
    }

    if (modal.kind === 'import-emails') {
      if (!value) return;
      await runAction('Đang nhập danh sách email...', async () => {
        const extracted = extractEmailsFromText(value);
        if (extracted.length === 0) {
          setNotice('Không tìm thấy email hợp lệ nào.', 'warn');
          return;
        }
        const rootDir = getDefaultBrowserRoots()[0].userDataDir;
        const items: BulkImportItemInput[] = extracted.map((it) => ({
          alias: it.alias,
          email: it.email,
          display_name: it.display_name,
          notes: it.notes,
          chrome_user_data_dir: rootDir,
          chrome_profile_name: 'Default',
          google_authuser: it.email,
        }));
        const res = await runBulkImportLocalOrDaemon(
          { mode: 'linked', chrome_user_data_dir: rootDir, chrome_profile_name: 'Default', tags: ['pro'], items },
          paths,
          port,
        );
        setNotice(`Đã nhập ${res.created.length} tài khoản (bỏ qua ${res.skipped.length}).`, 'success');
      });
      return;
    }

    if (modal.kind === 'export-file') {
      if (!value) return;
      await runAction(`Đang xuất metadata ra ${value}...`, async () => {
        const payload = (await isDaemonAlive(port))
          ? await callDaemon(port, '/api/export')
          : (() => {
              const db = new PoolDB(paths);
              try {
                return db.exportMetadata();
              } finally {
                db.close();
              }
            })();
        fs.writeFileSync(value, JSON.stringify(payload, null, 2), 'utf8');
        setNotice(`Đã xuất metadata ra ${path.resolve(value)}`, 'success');
      });
    }
  };

  // ── Keypress Handler ─────────────────────────────────────

  const onKeypress = (str: string, key: readline.Key) => {
    if (exited || suspended || actionLock) return;

    if (key.ctrl && key.name === 'c') {
      cleanupAndExit(0);
      return;
    }

    // Modal key handling
    if (state.modal) {
      const m = state.modal;

      if (key.name === 'escape') {
        state.modal = null;
        draw();
        return;
      }

      if (m.type === 'menu') {
        if (key.name === 'up' || str === 'k') {
          m.cursor = (m.cursor - 1 + m.items.length) % m.items.length;
          draw();
        } else if (key.name === 'down' || str === 'j') {
          m.cursor = (m.cursor + 1) % m.items.length;
          draw();
        } else if (key.name === 'return') {
          void handleMenuSelection(m);
        } else if (str && /^[1-9]$/.test(str)) {
          const idx = Number(str) - 1;
          if (idx < m.items.length) {
            m.cursor = idx;
            void handleMenuSelection(m);
          }
        }
        return;
      }

      if (m.type === 'input') {
        if (key.name === 'return') {
          void handleInputSubmit(m);
        } else if (key.name === 'backspace') {
          m.value = Array.from(m.value).slice(0, -1).join('');
          draw();
        } else if (key.ctrl && key.name === 'u') {
          m.value = '';
          draw();
        } else if (str && !key.ctrl && !key.meta && str >= ' ') {
          m.value += str;
          draw();
        }
        return;
      }

      if (m.type === 'form') {
        const cur = m.fields[m.cursor];
        if (key.ctrl && key.name === 's') {
          void submitAccountForm();
          return;
        }
        if (key.name === 'up' || (key.shift && key.name === 'tab')) {
          m.cursor = (m.cursor - 1 + m.fields.length) % m.fields.length;
          draw();
          return;
        }
        if (key.name === 'down' || key.name === 'tab') {
          m.cursor = (m.cursor + 1) % m.fields.length;
          draw();
          return;
        }
        if (key.name === 'return') {
          if (m.cursor === m.fields.length - 1) {
            void submitAccountForm();
          } else {
            m.cursor += 1;
            draw();
          }
          return;
        }
        if (cur.options) {
          if (key.name === 'left' || key.name === 'right' || key.name === 'space') {
            const idx = cur.options.indexOf(cur.value);
            const delta = key.name === 'left' ? -1 : 1;
            cur.value = cur.options[(idx + delta + cur.options.length) % cur.options.length];
            draw();
          }
          return;
        }
        if (key.name === 'backspace') {
          cur.value = Array.from(cur.value).slice(0, -1).join('');
          draw();
        } else if (key.ctrl && key.name === 'u') {
          cur.value = '';
          draw();
        } else if (str && !key.ctrl && !key.meta && str >= ' ') {
          cur.value += str;
          draw();
        }
        return;
      }

      if (m.type === 'confirm-delete') {
        if (key.name === 'space' && m.isIsolated) {
          m.purgeProfile = !m.purgeProfile;
          draw();
        } else if (str === 'y' || str === 'Y' || key.name === 'return') {
          const { alias, purgeProfile } = m;
          state.modal = null;
          void doDelete(alias, purgeProfile);
        } else if (str === 'n' || str === 'N') {
          state.modal = null;
          draw();
        }
        return;
      }

      if (m.type === 'confirm-force-agy') {
        if (str === 'F') {
          const alias = m.alias;
          state.modal = null;
          void doAgyActivate(alias, true);
        } else if (str === 'r' || str === 'R') {
          const alias = m.alias;
          state.modal = null;
          void doAgyActivate(alias, false);
        }
        return;
      }

      if (m.type === 'events' || m.type === 'help') {
        if (key.name === 'up' || str === 'k') {
          m.scroll = Math.max(0, m.scroll - 1);
          draw();
        } else if (key.name === 'down' || str === 'j') {
          m.scroll += 1;
          draw();
        } else if (str === 'q' || str === '?') {
          state.modal = null;
          draw();
        }
        return;
      }

      if (m.type === 'agy-status') {
        if (str === 'q' || key.name === 'return') {
          state.modal = null;
          draw();
        }
        return;
      }
      return;
    }

    // Live Search input mode
    if (state.searchActive) {
      if (key.name === 'escape') {
        state.searchActive = false;
        state.searchQuery = '';
        state.selectedIndex = 0;
        draw();
      } else if (key.name === 'return') {
        state.searchActive = false;
        draw();
      } else if (key.name === 'backspace') {
        state.searchQuery = Array.from(state.searchQuery).slice(0, -1).join('');
        state.selectedIndex = 0;
        draw();
      } else if (str && !key.ctrl && !key.meta && str >= ' ') {
        state.searchQuery += str;
        state.selectedIndex = 0;
        draw();
      }
      return;
    }

    // ── Main View Keybindings ──────────────────────────────
    const filtered = getFiltered();
    const sel = getSelected();

    if (str === 'q') {
      cleanupAndExit(0);
      return;
    }

    if (key.name === 'escape') {
      if (state.searchQuery || state.filterStatus !== 'all') {
        state.searchQuery = '';
        state.filterStatus = 'all';
        state.selectedIndex = 0;
        setNotice('Đã xóa bộ lọc.', 'info');
        draw();
      }
      return;
    }

    if (key.name === 'up' || str === 'k') {
      if (filtered.length > 0) {
        state.selectedIndex = (state.selectedIndex - 1 + filtered.length) % filtered.length;
        draw();
      }
      return;
    }
    if (key.name === 'down' || str === 'j') {
      if (filtered.length > 0) {
        state.selectedIndex = (state.selectedIndex + 1) % filtered.length;
        draw();
      }
      return;
    }
    if (key.name === 'pageup') {
      state.selectedIndex = Math.max(0, state.selectedIndex - 5);
      draw();
      return;
    }
    if (key.name === 'pagedown') {
      state.selectedIndex = Math.min(Math.max(0, filtered.length - 1), state.selectedIndex + 5);
      draw();
      return;
    }
    if (str && /^[1-9]$/.test(str)) {
      const idx = Number(str) - 1;
      if (idx < filtered.length) {
        state.selectedIndex = idx;
        draw();
      }
      return;
    }

    if (str === '/') {
      state.searchActive = true;
      draw();
      return;
    }

    if (str === 'f') {
      const order: TuiStatusFilter[] = ['all', 'ready', 'cooldown', 'needs_login', 'unknown'];
      const next = order[(order.indexOf(state.filterStatus) + 1) % order.length];
      state.filterStatus = next;
      state.selectedIndex = 0;
      setNotice(`Đang lọc: ${formatFilterName(next)}`, 'info');
      draw();
      return;
    }

    if (str === 'r') {
      void runAction('Đang làm mới dữ liệu...', async () => {
        setNotice('Đã làm mới danh sách.', 'info');
      });
      return;
    }

    if (str === '?') {
      state.modal = { type: 'help', scroll: 0 };
      draw();
      return;
    }

    if (str === 'v') {
      state.modal = { type: 'events', scroll: 0 };
      draw();
      return;
    }

    if (str === 'A') {
      void runAction('Đang kiểm tra trạng thái Keychain agy...', async () => {
        const st = (await isDaemonAlive(port))
          ? await callDaemon<AgyStatusResult>(port, '/api/agy/status')
          : getAgySessionStatus(paths);
        state.modal = { type: 'agy-status', status: st };
      });
      return;
    }

    if (str === '+') {
      openAccountForm(null);
      return;
    }

    if (str === 'i') {
      state.modal = {
        type: 'menu',
        kind: 'import',
        title: 'Nhập tài khoản vào pool',
        subtitle: 'Chọn cách nhập nhanh từ trình duyệt Chrome / Brave hoặc Clipboard',
        cursor: 0,
        items: [
          { id: 'discover', label: '1. Quét tự động Chrome / Brave', hint: '(import-chrome)' },
          { id: 'open-signout', label: '2. Mở Google SignOutOptions để copy ⌘A ⌘C', hint: '(accounts.google.com)' },
          { id: 'clipboard', label: '3. Nhập từ Clipboard (tự lọc mọi Gmail)', hint: '(import-clipboard)' },
          { id: 'manual-emails', label: '4. Nhập danh sách nhiều email thủ công', hint: '(import-emails)' },
          { id: 'login-wizard', label: '5. Chạy Wizard đăng nhập Profile riêng (1/N)', hint: '(login-wizard)' },
        ],
      };
      draw();
      return;
    }

    if (str === 'D') {
      const online = state.snapshot?.daemonOnline ?? false;
      state.modal = {
        type: 'menu',
        kind: 'system',
        title: 'Quản lý Daemon, Web Dashboard & macOS',
        subtitle: online ? `Daemon đang chạy tại http://${DEFAULT_HOST}:${port}` : 'Daemon nền hiện chưa chạy',
        cursor: 0,
        items: [
          { id: 'dashboard', label: '1. Mở Web Dashboard trong trình duyệt', hint: `http://${DEFAULT_HOST}:${port}` },
          { id: 'daemon-start', label: '2. Khởi động Daemon nền', hint: '(daemon start)' },
          { id: 'daemon-stop', label: '3. Dừng Daemon nền', hint: '(daemon stop)' },
          { id: 'sweep', label: '4. Quét giữ phiên toàn bộ pool ngay', hint: '(Keep-Alive sweep)' },
          { id: 'menubar-start', label: '5. Bật ứng dụng Menu Bar macOS', hint: '(menubar start)' },
          { id: 'menubar-stop', label: '6. Tắt ứng dụng Menu Bar macOS', hint: '(menubar stop)' },
          { id: 'launchagent-install', label: '7. Cài tự khởi động cùng macOS', hint: '(launchagent install)' },
          { id: 'launchagent-uninstall', label: '8. Gỡ tự khởi động cùng macOS', hint: '(launchagent uninstall)' },
          { id: 'launchagent-status', label: '9. Xem trạng thái LaunchAgent', hint: '(launchagent status)' },
          { id: 'export', label: 'Xuất backup metadata ra file JSON', hint: '(không xuất cookie)' },
        ],
      };
      draw();
      return;
    }

    if (str === 'P') {
      void doCheck();
      return;
    }

    if (str === 'n') {
      const defCd = state.snapshot?.settings.default_cooldown_hours ?? 5;
      state.modal = {
        type: 'input',
        kind: 'rotate',
        title: 'Xoay vòng sang tài khoản kế tiếp (Hết quota)',
        subtitle: `Đặt cooldown cho acc hiện tại (${state.snapshot?.activeAlias ?? 'không có'}) rồi chọn acc sẵn sàng kế tiếp.`,
        label: 'Số giờ cooldown cho acc hiện tại (Enter để dùng mặc định):',
        value: String(defCd),
      };
      draw();
      return;
    }

    // Account-specific actions require a selected account
    if (!sel) {
      setNotice('Chưa có tài khoản nào được chọn.', 'warn');
      draw();
      return;
    }

    if (key.name === 'return' || str === 's') {
      void doSwitch(sel.alias, true);
      return;
    }

    if (str === 'S') {
      void doSwitch(sel.alias, false);
      return;
    }

    if (str === 'o') {
      void doOpenChrome(sel.alias, false);
      return;
    }

    if (str === 'l') {
      void doOpenChrome(sel.alias, true);
      return;
    }

    if (str === 'a') {
      void doAgyActivate(sel.alias, false);
      return;
    }

    if (str === 'c') {
      void doAgyCapture(sel.alias);
      return;
    }

    if (str === 'g') {
      void doLaunchAgy(sel.alias);
      return;
    }

    if (str === 'p') {
      void doCheck(sel.alias);
      return;
    }

    if (str === 'x') {
      const defH = state.snapshot?.settings.default_cooldown_hours ?? 5;
      state.modal = {
        type: 'menu',
        kind: 'cooldown',
        title: `Đặt / Gỡ Cooldown cho "${sel.alias}"`,
        subtitle: sel.cooldown_remaining_ms > 0 ? `Hiện còn: ${formatShortDuration(sel.cooldown_remaining_ms)}` : 'Hiện không có cooldown',
        cursor: 0,
        items: [
          { id: String(defH), label: `1. +${defH} giờ (mặc định)` },
          { id: '1', label: '2. +1 giờ' },
          { id: '24', label: '3. +24 giờ (1 ngày)' },
          { id: '168', label: '4. +168 giờ (7 ngày)' },
          { id: 'custom', label: '5. Nhập số giờ tùy chỉnh...' },
          { id: 'clear', label: '6. Gỡ cooldown ngay (clear)' },
        ],
      };
      draw();
      return;
    }

    if (str === 'u') {
      void (async () => {
        const clip = await readClipboard();
        const prefill = clip.startsWith('http://') || clip.startsWith('https://') ? clip : '';
        state.modal = {
          type: 'input',
          kind: 'oauth',
          title: `Mở link OAuth vào Chrome profile "${sel.alias}"`,
          subtitle: prefill ? 'Đã tự điền URL từ Clipboard — nhấn Enter để mở ngay.' : 'Dán link https://accounts.google.com/o/oauth2/... vào ô dưới.',
          label: 'Link OAuth:',
          value: prefill,
          placeholder: 'https://accounts.google.com/o/oauth2/...',
        };
        draw();
      })();
      return;
    }

    if (str === 't') {
      const linkedCount = (state.snapshot?.accounts ?? []).filter((a) => a.profile_mode === 'linked').length;
      if (linkedCount === 0) {
        setNotice('Tất cả tài khoản đều đã là Profile riêng (isolated).', 'info');
        draw();
        return;
      }
      const items: MenuChoice[] = [];
      if (sel.profile_mode === 'linked') {
        items.push({ id: 'one', label: `1. Tách riêng "${sel.alias}" & mở Chrome đăng nhập` });
      }
      items.push({ id: 'all', label: `2. Tách TẤT CẢ (${linkedCount} acc Link) sang Profile riêng` });
      state.modal = {
        type: 'menu',
        kind: 'isolate',
        title: 'Tách sang Chrome Profile độc lập',
        subtitle: 'Profile độc lập giúp Keep-Alive chạy ngầm và cô lập hoàn toàn cookie.',
        cursor: 0,
        items,
      };
      draw();
      return;
    }

    if (str === 'e') {
      openAccountForm(sel);
      return;
    }

    if (str === 'd') {
      state.modal = {
        type: 'confirm-delete',
        alias: sel.alias,
        email: sel.email,
        isIsolated: sel.profile_mode === 'isolated',
        purgeProfile: false,
      };
      draw();
    }
  };

  readline.emitKeypressEvents(process.stdin);
  enterAltScreen();
  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', draw);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  draw();
  await refresh();

  const refreshTimer = setInterval(() => {
    if (!actionLock && !suspended && !state.modal) {
      void refresh(true);
    }
  }, 5000);
  refreshTimer.unref();

  const tickTimer = setInterval(() => {
    if (!actionLock && !suspended && !state.modal && state.snapshot) {
      let changed = false;
      for (const acc of state.snapshot.accounts) {
        if (acc.cooldown_until && acc.cooldown_remaining_ms > 0) {
          const rem = Math.max(0, Date.parse(acc.cooldown_until) - Date.now());
          acc.cooldown_remaining_ms = rem;
          changed = true;
        }
      }
      if (changed) draw();
    }
  }, 1000);
  tickTimer.unref();

  return await exitPromise;
}

async function waitEnterOnCookedStdin(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('\nNhấn Enter để quay lại TUI...', () => {
      rl.close();
      resolve();
    });
  });
}
