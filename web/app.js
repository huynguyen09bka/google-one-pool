const state = {
  accounts: [],
  activeAlias: null,
  lastSyncedActiveAlias: null,
  summary: { total: 0, ready: 0, cooldown: 0, needs_login: 0, unknown: 0, error: 0 },
  keepalive: { running: false, sweeping: false, activeProbes: [], lastSweepAt: null },
  agyStatus: null,
  agyLease: null,
  renewalAlerts: [],
  settings: null,
  events: [],
  filterStatus: 'all',
  filterTag: '',
  searchQuery: '',
  deleteTargetAlias: null,
  cooldownTickTriggeredRefresh: false,
  discoveredAccounts: [],
  discoveredProfiles: [],
  wizardDismissed: false,
  wizardSkippedAliases: [],
  wizardCurrentAlias: null,
  busyActions: new Set(),
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function showToast(message, kind = 'info') {
  const container = el('toast-container');
  const item = document.createElement('div');
  item.className = `toast toast-${kind}`;
  item.textContent = message;
  item.title = 'Bấm để đóng thông báo';
  item.addEventListener('click', () => item.remove());
  container.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 4500);
}

function formatDurationMs(ms) {
  if (!ms || ms <= 0) return '0p';
  const totalSec = Math.ceil(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}n ${hours}g`;
  if (hours > 0) return `${hours}g ${mins}p`;
  if (mins > 0) return `${mins}p ${secs}s`;
  return `${secs}s`;
}

function formatRelativeTime(iso) {
  if (!iso) return 'Chưa có';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return 'vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  return `${Math.floor(diffSec / 86400)} ngày trước`;
}

function formatEventTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const timePart = d.toLocaleTimeString('vi-VN', { hour12: false });
  if (sameDay) return timePart;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month} ${timePart}`;
}

function formatHoursBadge(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return '5h';
  return Number.isInteger(n) ? `${n}h` : `${n}h`;
}

function getEffectiveStateBadge(acc) {
  const map = {
    active: ['Đang chọn', 'badge-active'],
    ready: ['Sẵn sàng', 'badge-ready'],
    cooldown: ['Đang Cooldown', 'badge-cooldown'],
    needs_login: ['Cần đăng nhập', 'badge-danger'],
    checking: ['Đang kiểm tra', 'badge-neutral'],
    error: ['Lỗi kiểm tra', 'badge-danger'],
    unknown: ['Chưa kiểm tra', 'badge-neutral'],
  };
  return map[acc.effective_state] || ['Không rõ', 'badge-neutral'];
}

function getSessionText(acc) {
  switch (acc.session_status) {
    case 'live':
      return 'Live';
    case 'needs_login':
      return 'Hết phiên (cần login)';
    case 'error':
      return 'Lỗi quét';
    case 'checking':
      return 'Đang quét...';
    default:
      return 'Chưa quét';
  }
}

function setSseConnected() {
  const sseDot = el('sse-dot');
  const sseText = el('sse-text');
  sseDot.className = 'dot dot-live';
  sseText.textContent = 'Trực tuyến';
}

function applySnapshot(snapshot) {
  state.accounts = snapshot.accounts || [];
  state.activeAlias = snapshot.activeAlias || null;
  state.summary = snapshot.summary || state.summary;
  state.keepalive = snapshot.keepalive || state.keepalive;
  if (snapshot.settings) state.settings = snapshot.settings;
  if (snapshot.events) state.events = snapshot.events;
  if (snapshot.agyStatus !== undefined) state.agyStatus = snapshot.agyStatus;
  if (snapshot.agyLease !== undefined) state.agyLease = snapshot.agyLease;
  if (snapshot.renewalAlerts !== undefined) state.renewalAlerts = snapshot.renewalAlerts || [];
  state.cooldownTickTriggeredRefresh = false;
  renderAll();
}

async function refreshAll() {
  try {
    const [accData, evData, setData] = await Promise.all([
      api('/api/accounts'),
      api('/api/events?limit=40'),
      api('/api/settings'),
    ]);
    state.accounts = accData.accounts || [];
    state.activeAlias = accData.activeAlias || null;
    state.summary = accData.summary || state.summary;
    state.keepalive = accData.keepalive || state.keepalive;
    if (accData.agyStatus !== undefined) state.agyStatus = accData.agyStatus;
    if (accData.agyLease !== undefined) state.agyLease = accData.agyLease;
    if (accData.renewalAlerts !== undefined) state.renewalAlerts = accData.renewalAlerts || [];
    state.events = evData.events || [];
    state.settings = setData.settings || accData.settings || state.settings;
    state.cooldownTickTriggeredRefresh = false;
    renderAll();
  } catch (err) {
    showToast(`Không tải được dữ liệu: ${err.message}`, 'error');
  }
}

function renderAll() {
  renderKeepAlivePill();
  renderHeroPanel();
  renderLoginWizard();
  renderKpis();
  renderStatusFilterChips();
  renderTagFilters();
  renderAccountsGrid();
  renderEvents();
  renderOAuthAccountSelect();
}

function getPendingWizardAccounts() {
  const pending = state.accounts.filter(
    (a) =>
      a.profile_mode === 'isolated' &&
      (a.session_status === 'unknown' || a.session_status === 'needs_login'),
  );
  if (pending.length <= 1 || state.wizardSkippedAliases.length === 0) {
    return pending;
  }
  const skippedSet = new Set(state.wizardSkippedAliases);
  const front = pending.filter((a) => !skippedSet.has(a.alias));
  const back = pending.filter((a) => skippedSet.has(a.alias));
  return [...front, ...back];
}

function renderLoginWizard() {
  const panel = el('login-wizard-panel');
  const body = el('wizard-body');
  const isolateAllBtn = el('btn-wizard-isolate-all');
  const titleEl = el('wizard-title');
  const subtitleEl = el('wizard-subtitle');
  const eyebrowEl = el('wizard-eyebrow');
  const fillEl = el('wizard-progress-fill');

  const linkedAccounts = state.accounts.filter((a) => a.profile_mode === 'linked');
  const isolatedAccounts = state.accounts.filter((a) => a.profile_mode === 'isolated');
  const pending = getPendingWizardAccounts();

  if (state.wizardDismissed || (linkedAccounts.length === 0 && pending.length === 0)) {
    panel.hidden = true;
    state.wizardCurrentAlias = null;
    return;
  }

  panel.hidden = false;
  if (linkedAccounts.length > 0) {
    isolateAllBtn.hidden = false;
    isolateAllBtn.textContent = `Tách tất cả (${linkedAccounts.length} acc Link) sang Profile riêng`;
  } else {
    isolateAllBtn.hidden = true;
  }

  if (pending.length === 0) {
    state.wizardCurrentAlias = null;
    body.hidden = true;
    eyebrowEl.textContent = 'CHUYỂN SANG PROFILE ĐỘC LẬP';
    titleEl.textContent = `Đang có ${linkedAccounts.length} tài khoản dùng chế độ Link Chrome gốc`;
    subtitleEl.textContent =
      'Bấm "Tách tất cả" để tạo thư mục Chrome profile riêng cho từng tài khoản cùng lúc, sau đó Wizard sẽ mở nối tiếp từng acc để bạn đăng nhập 1 lần.';
    return;
  }

  body.hidden = false;
  const totalIso = Math.max(isolatedAccounts.length, pending.length);
  const doneCount = isolatedAccounts.filter((a) => a.session_status === 'live').length;
  const pct = totalIso > 0 ? Math.round((doneCount / totalIso) * 100) : 0;
  fillEl.style.width = `${pct}%`;

  const current = pending[0];
  state.wizardCurrentAlias = current.alias;

  eyebrowEl.textContent = 'WIZARD ĐĂNG NHẬP PROFILE RIÊNG (1/N)';
  titleEl.textContent = `Còn ${pending.length} acc chờ đăng nhập (${doneCount}/${totalIso} hoàn tất)`;
  subtitleEl.textContent =
    'Mở từng cửa sổ Chrome một để tránh quá tải máy — đăng nhập xong acc hiện tại rồi bấm nút vàng để chuyển sang acc kế tiếp.';

  el('wizard-target-alias').textContent = current.alias;
  el('wizard-target-email').textContent = current.display_name
    ? `${current.display_name} • ${current.email}`
    : current.email;
  el('wizard-target-path').textContent = current.chrome_profile_dir;
}

function renderKeepAlivePill() {
  const dot = el('keepalive-dot');
  const text = el('keepalive-text');
  const sweepBtn = el('btn-sweep');

  if (state.keepalive.sweeping) {
    dot.className = 'dot dot-live';
    const current = state.keepalive.activeProbes?.[0];
    text.textContent = current ? `Đang quét: ${current}` : 'Đang quét...';
    sweepBtn.disabled = true;
  } else if (state.settings?.keepalive_enabled) {
    dot.className = 'dot dot-live';
    text.textContent = `Keep-Alive (${state.settings.keepalive_interval_minutes}p)`;
    sweepBtn.disabled = false;
  } else {
    dot.className = 'dot dot-muted';
    text.textContent = 'Keep-Alive: Tắt';
    sweepBtn.disabled = false;
  }
}

function renderHeroPanel() {
  const active = state.accounts.find((a) => a.alias === state.activeAlias) || null;
  const aliasEl = el('active-alias');
  const badgeEl = el('active-status-badge');
  const planEl = el('active-plan-badge');
  const modeEl = el('active-mode-badge');
  const agyBadgeEl = el('active-agy-badge');
  const keychainPillEl = el('hero-agy-keychain');
  const leasePillEl = el('hero-agy-lease');
  const renewalPillEl = el('hero-renewal-alert');
  const emailEl = el('active-email');
  const metaEl = el('active-meta');
  const openBtn = el('btn-active-open');
  const agyBtn = el('btn-active-agy');
  const rotateBtn = el('btn-rotate-next');
  const rotateAgyBtn = el('btn-rotate-agy-next');

  const cooldownHours = state.settings?.default_cooldown_hours ?? 5;
  rotateAgyBtn.textContent = `Xoay agy kế (+${formatHoursBadge(cooldownHours)})`;
  rotateAgyBtn.disabled = state.accounts.length === 0 || state.busyActions.has('rotate-agy');
  rotateBtn.textContent = `Đổi Chrome kế`;
  rotateBtn.disabled = state.accounts.length === 0 || state.busyActions.has('rotate');

  if (state.agyLease && !state.agyLease.stale) {
    leasePillEl.hidden = false;
    leasePillEl.textContent = `Khóa agy.lock: ${state.agyLease.holder} (${state.agyLease.alias})`;
    leasePillEl.title = `PID ${state.agyLease.pid} — bấm "Sức khỏe agy" để xem hoặc mở khóa`;
  } else {
    leasePillEl.hidden = true;
  }

  if (state.renewalAlerts && state.renewalAlerts.length > 0) {
    renewalPillEl.hidden = false;
    renewalPillEl.textContent = `${state.renewalAlerts.length} acc sắp gia hạn`;
    renewalPillEl.title = state.renewalAlerts
      .map((a) => `${a.alias}: ${a.renewal_date} (${a.days_left <= 0 ? 'quá hạn' : `còn ${a.days_left} ngày`})`)
      .join('\n');
  } else {
    renewalPillEl.hidden = true;
  }

  if (state.agyStatus?.keychain_present) {
    keychainPillEl.hidden = false;
    if (state.agyStatus.live_owner_alias) {
      keychainPillEl.className = 'badge badge-ready';
      keychainPillEl.textContent = `agy Keychain: ${state.agyStatus.live_owner_alias}`;
    } else if (state.agyStatus.live_email) {
      keychainPillEl.className = 'badge badge-cooldown';
      keychainPillEl.textContent = `agy Keychain: ${state.agyStatus.live_email} (chưa lưu)`;
    } else {
      keychainPillEl.className = 'badge badge-neutral';
      keychainPillEl.textContent = 'agy Keychain: chưa xác định';
    }
  } else if (state.agyStatus && !state.agyStatus.keychain_present) {
    keychainPillEl.hidden = false;
    keychainPillEl.className = 'badge badge-neutral';
    keychainPillEl.textContent = 'agy Keychain: trống';
  } else {
    keychainPillEl.hidden = true;
  }

  if (!active) {
    aliasEl.textContent = 'Chưa chọn tài khoản';
    badgeEl.textContent = '—';
    badgeEl.className = 'badge badge-neutral';
    planEl.hidden = true;
    modeEl.hidden = true;
    agyBadgeEl.hidden = true;
    emailEl.textContent = 'Hãy bấm "Nhập Chrome" hoặc "+ Thêm" ở phía trên.';
    metaEl.textContent = '';
    openBtn.disabled = true;
    openBtn.textContent = 'Mở Chrome Profile';
    agyBtn.disabled = true;
    agyBtn.textContent = 'Nạp phiên agy';
    agyBtn.className = 'btn btn-secondary';
    return;
  }

  aliasEl.textContent = active.alias;
  const [label, cls] = getEffectiveStateBadge(active);
  badgeEl.textContent = label;
  badgeEl.className = `badge ${cls}`;
  planEl.textContent = active.plan_tier;
  planEl.hidden = false;

  modeEl.hidden = false;
  if (active.profile_mode === 'linked') {
    modeEl.className = 'badge badge-link';
    modeEl.textContent = `Link: ${active.chrome_profile_name || 'Default'}`;
  } else {
    modeEl.className = 'badge badge-neutral';
    modeEl.textContent = 'Profile riêng';
  }

  if (active.agy_session?.captured) {
    agyBadgeEl.hidden = false;
    if (active.agy_session.is_live_owner) {
      agyBadgeEl.className = 'badge badge-ready';
      agyBadgeEl.textContent = 'agy: đang dùng';
      agyBtn.className = 'btn btn-ghost';
      agyBtn.textContent = 'Cập nhật phiên agy';
      agyBtn.title = 'Lưu lại snapshot phiên agy hiện tại trong Keychain vào tài khoản này';
    } else {
      agyBadgeEl.className = 'badge badge-link';
      agyBadgeEl.textContent = 'agy: đã lưu';
      agyBtn.className = 'btn btn-success-soft';
      agyBtn.textContent = 'Nạp phiên agy';
      agyBtn.title = 'Ghi phiên đã lưu của tài khoản này vào Keychain (đóng agy trước)';
    }
  } else {
    agyBadgeEl.hidden = true;
    agyBtn.className = 'btn btn-secondary';
    agyBtn.textContent = 'Lưu phiên agy';
    agyBtn.title = 'Lưu phiên agy đang đăng nhập trong Keychain vào tài khoản này';
  }
  agyBtn.disabled = state.busyActions.has(`agy:${active.alias}`);

  emailEl.textContent = active.display_name ? `${active.display_name} • ${active.email}` : active.email;

  const parts = [`Phiên: ${getSessionText(active)}`, `Đã dùng ${active.use_count} lần`];
  if (active.renewal_date) {
    const daysTxt =
      active.renewal_days_left !== null ? ` (còn ${active.renewal_days_left} ngày)` : '';
    parts.push(`Gia hạn: ${active.renewal_date}${daysTxt}`);
  }
  if (active.chrome_running) parts.push('Chrome đang mở');
  metaEl.textContent = parts.join(' • ');

  const isNeedsLogin = active.session_status === 'needs_login' || active.session_status === 'unknown';
  openBtn.textContent = isNeedsLogin ? 'Đăng nhập Chrome' : 'Mở Chrome Profile';
  openBtn.disabled = state.busyActions.has(`open:${active.alias}`);
}

function renderKpis() {
  el('kpi-total').textContent = String(state.summary.total ?? state.accounts.length);
  el('kpi-ready').textContent = String(state.summary.ready ?? 0);
  el('kpi-cooldown').textContent = String(state.summary.cooldown ?? 0);
  el('kpi-needs-login').textContent = String(
    (state.summary.needs_login ?? 0) + (state.summary.error ?? 0),
  );

  for (const card of document.querySelectorAll('[data-kpi-filter]')) {
    card.classList.toggle('kpi-active', card.dataset.kpiFilter === state.filterStatus);
  }
}

function renderStatusFilterChips() {
  const unknownChip = el('chip-status-unknown');
  if (unknownChip) {
    unknownChip.hidden = (state.summary.unknown ?? 0) === 0 && state.filterStatus !== 'unknown';
  }
  for (const btn of document.querySelectorAll('#status-filters .chip')) {
    btn.classList.toggle('chip-active', (btn.dataset.status || 'all') === state.filterStatus);
  }
}

function setStatusFilter(status) {
  state.filterStatus = status || 'all';
  renderKpis();
  renderStatusFilterChips();
  renderAccountsGrid();
}

function renderTagFilters() {
  const container = el('tag-filters');
  const allTags = new Set();
  for (const acc of state.accounts) {
    for (const tag of acc.tags || []) {
      allTags.add(tag);
    }
  }

  if (state.filterTag && !allTags.has(state.filterTag)) {
    state.filterTag = '';
  }

  container.replaceChildren();
  for (const tag of Array.from(allTags).sort()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${state.filterTag === tag ? 'chip-active' : ''}`;
    btn.textContent = `#${tag}`;
    btn.addEventListener('click', () => {
      state.filterTag = state.filterTag === tag ? '' : tag;
      renderTagFilters();
      renderAccountsGrid();
    });
    container.appendChild(btn);
  }
}

function renderOAuthAccountSelect() {
  const select = el('oauth-account-select');
  const prevValue = select.value;
  const activeChanged = state.activeAlias !== state.lastSyncedActiveAlias;
  state.lastSyncedActiveAlias = state.activeAlias;

  select.replaceChildren();

  if (state.accounts.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Chưa có tài khoản';
    select.appendChild(opt);
    return;
  }

  for (const acc of state.accounts) {
    const opt = document.createElement('option');
    opt.value = acc.alias;
    opt.textContent = `${acc.alias} (${acc.email})`;
    select.appendChild(opt);
  }

  if (activeChanged && state.activeAlias && state.accounts.some((a) => a.alias === state.activeAlias)) {
    select.value = state.activeAlias;
  } else if (prevValue && state.accounts.some((a) => a.alias === prevValue)) {
    select.value = prevValue;
  } else if (state.activeAlias && state.accounts.some((a) => a.alias === state.activeAlias)) {
    select.value = state.activeAlias;
  }
}

function getFilteredAccounts() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.accounts.filter((acc) => {
    if (state.filterStatus !== 'all') {
      if (state.filterStatus === 'ready') {
        if (acc.effective_state !== 'ready' && acc.effective_state !== 'active') return false;
      } else if (state.filterStatus === 'needs_login') {
        if (acc.effective_state !== 'needs_login' && acc.effective_state !== 'error') return false;
      } else if (acc.effective_state !== state.filterStatus) {
        return false;
      }
    }
    if (state.filterTag && !(acc.tags || []).includes(state.filterTag)) {
      return false;
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

function renderAccountsGrid() {
  const grid = el('account-grid');
  grid.replaceChildren();
  const filtered = getFilteredAccounts();

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('p');
    title.textContent =
      state.accounts.length === 0
        ? 'Chưa có tài khoản Google AI Pro nào trong pool.'
        : 'Không có tài khoản nào khớp với bộ lọc hiện tại.';
    empty.appendChild(title);

    const btnRow = document.createElement('div');
    btnRow.className = 'empty-actions';

    if (state.accounts.length === 0) {
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'btn btn-primary';
      importBtn.textContent = 'Nhập nhanh từ Chrome có sẵn';
      importBtn.addEventListener('click', () => openImportChromeModal());

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-secondary';
      addBtn.textContent = '+ Thêm thủ công';
      addBtn.addEventListener('click', () => openAccountModal());

      btnRow.appendChild(importBtn);
      btnRow.appendChild(addBtn);
    } else {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn btn-secondary btn-sm';
      clearBtn.textContent = 'Xóa bộ lọc hiện tại';
      clearBtn.addEventListener('click', () => {
        state.filterStatus = 'all';
        state.filterTag = '';
        state.searchQuery = '';
        el('search-input').value = '';
        renderAll();
      });
      btnRow.appendChild(clearBtn);
    }

    empty.appendChild(btnRow);
    grid.appendChild(empty);
    return;
  }

  for (const acc of filtered) {
    grid.appendChild(createAccountCard(acc));
  }
}

function createAccountCard(acc) {
  const card = document.createElement('article');
  card.className = `account-card ${acc.is_active ? 'is-active' : ''}`;

  const head = document.createElement('div');
  head.className = 'account-card-head';

  const ident = document.createElement('div');
  ident.className = 'account-card-ident';

  const h3 = document.createElement('h3');
  h3.className = 'account-title';
  h3.textContent = acc.alias;
  ident.appendChild(h3);

  const emailP = document.createElement('p');
  emailP.className = 'account-email';
  emailP.textContent = acc.display_name ? `${acc.display_name} • ${acc.email}` : acc.email;
  ident.appendChild(emailP);

  const [badgeLabel, badgeClass] = getEffectiveStateBadge(acc);
  const badge = document.createElement('span');
  badge.className = `badge ${badgeClass}`;
  badge.textContent = badgeLabel;

  head.appendChild(ident);
  head.appendChild(badge);
  card.appendChild(head);

  // Dedicated wrapping badge strip — never pushes status badge out of the card
  const badgeRow = document.createElement('div');
  badgeRow.className = 'card-badges';

  const modePill = document.createElement('span');
  if (acc.profile_mode === 'linked') {
    modePill.className = 'badge badge-link';
    modePill.textContent = `Link: ${acc.chrome_profile_name || 'Default'}`;
  } else {
    modePill.className = 'badge badge-neutral';
    modePill.textContent = 'Profile riêng';
  }
  badgeRow.appendChild(modePill);

  if (acc.chrome_running) {
    const chromePill = document.createElement('span');
    chromePill.className = 'badge badge-accent';
    chromePill.textContent = 'Chrome mở';
    badgeRow.appendChild(chromePill);
  }

  if (acc.agy_session?.captured) {
    const agyPill = document.createElement('span');
    if (acc.agy_session.is_live_owner) {
      agyPill.className = 'badge badge-ready';
      agyPill.textContent = 'agy: đang dùng';
      agyPill.title = `Phiên agy trong Keychain đang thuộc ${acc.alias}`;
    } else {
      agyPill.className = 'badge badge-neutral';
      agyPill.textContent = 'agy: đã lưu';
      agyPill.title = `Đã lưu phiên agy lúc ${acc.agy_session.captured_at || ''}`;
    }
    badgeRow.appendChild(agyPill);
  }

  card.appendChild(badgeRow);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  const metaParts = [
    acc.plan_tier,
    `Phiên: ${getSessionText(acc)}`,
    `Kiểm tra: ${formatRelativeTime(acc.last_checked_at)}`,
  ];
  if (acc.renewal_date) {
    const warnSuffix =
      acc.renewal_days_left !== null && acc.renewal_days_left <= 7
        ? ` (còn ${acc.renewal_days_left} ngày!)`
        : '';
    metaParts.push(`Gia hạn: ${acc.renewal_date}${warnSuffix}`);
  }
  if (acc.proxy_url) metaParts.push(`Proxy: ${acc.proxy_url}`);
  meta.textContent = metaParts.join(' • ');
  card.appendChild(meta);

  if (acc.tags && acc.tags.length > 0) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'tags-row';
    for (const tag of acc.tags) {
      const span = document.createElement('span');
      span.className = 'tag-pill';
      span.textContent = `#${tag}`;
      tagsRow.appendChild(span);
    }
    card.appendChild(tagsRow);
  }

  if (acc.notes) {
    const notesP = document.createElement('p');
    notesP.className = 'account-notes';
    notesP.textContent = acc.notes;
    card.appendChild(notesP);
  }

  if (acc.session_detail && (acc.session_status === 'needs_login' || acc.session_status === 'error')) {
    const detailP = document.createElement('p');
    detailP.className = 'form-error';
    detailP.textContent = acc.session_detail;
    card.appendChild(detailP);
  }

  if (acc.cooldown_until && acc.cooldown_remaining_ms > 0) {
    const cdBox = document.createElement('div');
    cdBox.className = 'cooldown-box';

    const cdText = document.createElement('span');
    cdText.dataset.cooldownUntil = acc.cooldown_until;
    cdText.dataset.cooldownReason = acc.cooldown_reason || '';
    cdText.textContent = `Còn ${formatDurationMs(acc.cooldown_remaining_ms)}${acc.cooldown_reason ? ` — ${acc.cooldown_reason}` : ''}`;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-xs btn-secondary';
    clearBtn.textContent = 'Gỡ';
    clearBtn.addEventListener('click', () => clearCooldown(acc.alias));

    cdBox.appendChild(cdText);
    cdBox.appendChild(clearBtn);
    card.appendChild(cdBox);
  }

  if (acc.bucket_cooldowns && acc.bucket_cooldowns.length > 0) {
    const bRow = document.createElement('div');
    bRow.className = 'bucket-cooldowns-row';
    for (const b of acc.bucket_cooldowns) {
      const pill = document.createElement('span');
      pill.className = 'bucket-pill';
      const labelSpan = document.createElement('span');
      labelSpan.dataset.cooldownUntil = b.cooldown_until;
      labelSpan.dataset.cooldownPrefix = `[${b.bucket}] `;
      labelSpan.dataset.cooldownReason = '';
      labelSpan.textContent = `[${b.bucket}] Còn ${formatDurationMs(b.remaining_ms)}`;
      pill.title = b.cooldown_reason || `Bucket ${b.bucket} cooldown đến ${b.cooldown_until}`;
      const xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.textContent = '✕';
      xBtn.title = `Gỡ cooldown bucket ${b.bucket}`;
      xBtn.addEventListener('click', () => clearCooldown(acc.alias, b.bucket));
      pill.appendChild(labelSpan);
      pill.appendChild(xBtn);
      bRow.appendChild(pill);
    }
    card.appendChild(bRow);
  }

  // Primary action row
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const isNeedsLogin = acc.session_status === 'needs_login' || acc.session_status === 'unknown';

  if (!acc.is_active) {
    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'btn btn-sm btn-primary';
    switchBtn.textContent = 'Chọn (Switch)';
    switchBtn.disabled = state.busyActions.has(`switch:${acc.alias}`);
    switchBtn.addEventListener('click', () => switchAccount(acc.alias));
    actions.appendChild(switchBtn);
  }

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = acc.is_active ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary';
  openBtn.textContent = isNeedsLogin ? 'Đăng nhập Chrome' : 'Mở Chrome';
  openBtn.disabled = state.busyActions.has(`open:${acc.alias}`);
  openBtn.addEventListener('click', () =>
    isNeedsLogin ? openAccountLogin(acc.alias) : openAccountChrome(acc.alias),
  );
  actions.appendChild(openBtn);

  const agyBtn = document.createElement('button');
  agyBtn.type = 'button';
  agyBtn.disabled = state.busyActions.has(`agy:${acc.alias}`);
  if (acc.agy_session?.captured) {
    if (acc.agy_session.is_live_owner) {
      agyBtn.className = 'btn btn-sm btn-ghost';
      agyBtn.textContent = 'Cập nhật agy';
      agyBtn.title = 'Phiên Keychain đang là acc này — bấm để lưu lại snapshot mới nhất';
      agyBtn.addEventListener('click', () => agyCapture(acc.alias));
    } else {
      agyBtn.className = 'btn btn-sm btn-success-soft';
      agyBtn.textContent = 'Nạp phiên agy';
      agyBtn.title = 'Ghi phiên đã lưu của acc này vào Keychain (đóng agy trước)';
      agyBtn.addEventListener('click', () => agyActivate(acc.alias));
    }
  } else {
    agyBtn.className = 'btn btn-sm btn-secondary';
    agyBtn.textContent = 'Lưu phiên agy';
    agyBtn.title = 'Lưu phiên agy hiện tại trong Keychain vào acc này';
    agyBtn.addEventListener('click', () => agyCapture(acc.alias));
  }
  actions.appendChild(agyBtn);

  const checkBtn = document.createElement('button');
  checkBtn.type = 'button';
  checkBtn.className = 'btn btn-sm btn-secondary';
  const isProbing =
    Boolean(state.keepalive.activeProbes?.includes(acc.alias)) ||
    state.busyActions.has(`check:${acc.alias}`);
  checkBtn.textContent = isProbing ? 'Đang quét...' : 'Kiểm tra';
  checkBtn.disabled = isProbing;
  checkBtn.addEventListener('click', () => checkAccount(acc.alias));
  actions.appendChild(checkBtn);

  card.appendChild(actions);

  // Secondary utility row
  const secondary = document.createElement('div');
  secondary.className = 'card-actions-secondary';

  if (acc.profile_mode === 'linked') {
    const isolateBtn = document.createElement('button');
    isolateBtn.type = 'button';
    isolateBtn.className = 'btn btn-xs btn-ghost';
    isolateBtn.title = 'Tạo Chrome profile riêng biệt để Keep-Alive chạy độc lập';
    isolateBtn.textContent = 'Tách profile riêng';
    isolateBtn.disabled = state.busyActions.has(`isolate:${acc.alias}`);
    isolateBtn.addEventListener('click', () => isolateAccount(acc.alias));
    secondary.appendChild(isolateBtn);
  }

  const oauthSelectBtn = document.createElement('button');
  oauthSelectBtn.type = 'button';
  oauthSelectBtn.className = 'btn btn-xs btn-ghost';
  oauthSelectBtn.textContent = 'Dán OAuth';
  oauthSelectBtn.addEventListener('click', () => {
    el('oauth-account-select').value = acc.alias;
    el('oauth-url-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
    el('oauth-url-input').focus();
    showToast(`Đã chọn ${acc.alias} để dán link OAuth.`, 'info');
  });
  secondary.appendChild(oauthSelectBtn);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-xs btn-ghost';
  editBtn.textContent = 'Sửa';
  editBtn.addEventListener('click', () => openAccountModal(acc));
  secondary.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn-xs btn-danger-ghost';
  delBtn.textContent = 'Xóa';
  delBtn.addEventListener('click', () => openDeleteModal(acc));
  secondary.appendChild(delBtn);

  card.appendChild(secondary);

  // Cooldown quick chips (supports account-wide or model bucket)
  const cdChips = document.createElement('div');
  cdChips.className = 'cooldown-chips';
  const cdLabel = document.createElement('span');
  cdLabel.textContent = 'Cooldown:';
  cdChips.appendChild(cdLabel);

  const bucketSelect = document.createElement('select');
  bucketSelect.className = 'bucket-select';
  bucketSelect.setAttribute('aria-label', 'Phạm vi cooldown');
  for (const [bVal, bLabel] of [
    ['all', 'Toàn acc'],
    ['pro', 'pro'],
    ['claude', 'claude'],
    ['flash', 'flash'],
  ]) {
    const opt = document.createElement('option');
    opt.value = bVal;
    opt.textContent = bLabel;
    bucketSelect.appendChild(opt);
  }
  cdChips.appendChild(bucketSelect);

  for (const [label, hours] of [
    ['+1h', 1],
    ['+5h', 5],
    ['+24h', 24],
    ['+7d', 168],
  ]) {
    const chipBtn = document.createElement('button');
    chipBtn.type = 'button';
    chipBtn.className = 'btn btn-xs btn-secondary';
    chipBtn.textContent = label;
    chipBtn.addEventListener('click', () => setCooldown(acc.alias, hours, bucketSelect.value));
    cdChips.appendChild(chipBtn);
  }
  card.appendChild(cdChips);

  return card;
}

function renderEvents() {
  const list = el('events-list');
  list.replaceChildren();
  if (!state.events || state.events.length === 0) {
    const li = document.createElement('li');
    li.className = 'event-item';
    li.textContent = 'Chưa có sự kiện nào.';
    list.appendChild(li);
    return;
  }

  for (const ev of state.events) {
    const li = document.createElement('li');
    li.className = 'event-item';
    const msg = document.createElement('span');
    msg.className = 'event-msg';
    msg.textContent = ev.message;
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = formatEventTimestamp(ev.created_at);
    time.title = new Date(ev.created_at).toLocaleString('vi-VN', { hour12: false });
    li.appendChild(msg);
    li.appendChild(time);
    list.appendChild(li);
  }
}

async function withBusy(key, fn) {
  if (state.busyActions.has(key)) return;
  state.busyActions.add(key);
  renderHeroPanel();
  renderAccountsGrid();
  try {
    return await fn();
  } finally {
    state.busyActions.delete(key);
    renderHeroPanel();
    renderAccountsGrid();
  }
}

async function switchAccount(alias) {
  await withBusy(`switch:${alias}`, async () => {
    try {
      const res = await api(`/api/accounts/${encodeURIComponent(alias)}/switch`, {
        method: 'POST',
        body: JSON.stringify({ openChrome: true }),
      });
      showToast(`Đã chuyển sang ${res.active.alias} và mở Chrome.`, 'success');
      await refreshAll();
    } catch (err) {
      showToast(`Lỗi chuyển tài khoản: ${err.message}`, 'error');
    }
  });
}

async function openAccountChrome(alias, openUrl) {
  await withBusy(`open:${alias}`, async () => {
    try {
      await api(`/api/accounts/${encodeURIComponent(alias)}/open`, {
        method: 'POST',
        body: JSON.stringify(openUrl ? { openUrl } : {}),
      });
      showToast(`Đã mở Chrome cho ${alias}.`, 'success');
      await refreshAll();
    } catch (err) {
      showToast(`Không mở được Chrome: ${err.message}`, 'error');
    }
  });
}

async function agyCapture(alias) {
  await withBusy(`agy:${alias}`, async () => {
    try {
      const res = await api(`/api/accounts/${encodeURIComponent(alias)}/agy-capture`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      showToast(
        `Đã lưu phiên agy vào ${res.alias}${res.detected_email ? ` (${res.detected_email})` : ''}.`,
        'success',
      );
      if (res.warning) showToast(res.warning, 'warn');
      await refreshAll();
    } catch (err) {
      showToast(`Lưu phiên agy thất bại: ${err.message}`, 'error');
    }
  });
}

async function agyActivate(alias) {
  await withBusy(`agy:${alias}`, async () => {
    try {
      const res = await api(`/api/accounts/${encodeURIComponent(alias)}/agy-activate`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      showToast(`Đã nạp phiên agy của ${res.alias} vào Keychain — mở lại agy là đúng acc.`, 'success');
      if (res.recaptured_alias) {
        showToast(`Đã cập nhật lại snapshot cho ${res.recaptured_alias}.`, 'info');
      }
      await refreshAll();
    } catch (err) {
      showToast(`Nạp phiên agy thất bại: ${err.message}`, 'error');
    }
  });
}

async function openAccountLogin(alias) {
  await withBusy(`open:${alias}`, async () => {
    try {
      await api(`/api/accounts/${encodeURIComponent(alias)}/login`, { method: 'POST' });
      showToast(`Đã mở Chrome đăng nhập cho ${alias} (đã điền sẵn email).`, 'success');
      await refreshAll();
    } catch (err) {
      showToast(`Không mở được Chrome: ${err.message}`, 'error');
    }
  });
}

async function isolateAccount(alias) {
  await withBusy(`isolate:${alias}`, async () => {
    try {
      state.wizardDismissed = false;
      const res = await api(`/api/accounts/${encodeURIComponent(alias)}/isolate`, {
        method: 'POST',
        body: JSON.stringify({ openChrome: true }),
      });
      showToast(
        `Đã tách "${res.account.alias}" sang Chrome profile riêng. Hãy đăng nhập 1 lần trên cửa sổ Chrome vừa mở.`,
        'success',
      );
      await refreshAll();
    } catch (err) {
      showToast(`Lỗi tách profile: ${err.message}`, 'error');
    }
  });
}

async function isolateAllAccounts() {
  try {
    state.wizardDismissed = false;
    state.wizardSkippedAliases = [];
    const res = await api('/api/accounts/isolate-all', { method: 'POST' });
    if (res.count === 0) {
      showToast('Không có tài khoản nào đang ở chế độ Link.', 'info');
      return;
    }
    showToast(
      `Đã tạo ${res.count} thư mục Chrome profile riêng! Bấm "1. Mở Chrome acc này" trong Wizard để đăng nhập lần lượt.`,
      'success',
    );
    await refreshAll();
  } catch (err) {
    showToast(`Lỗi tách hàng loạt: ${err.message}`, 'error');
  }
}

async function confirmWizardLoginAndNext() {
  const currentAlias = state.wizardCurrentAlias;
  if (!currentAlias) return;

  try {
    await api(`/api/accounts/${encodeURIComponent(currentAlias)}/confirm-login`, {
      method: 'POST',
    });
    await refreshAll();
    const remaining = getPendingWizardAccounts();
    if (remaining.length > 0) {
      const next = remaining[0];
      await api(`/api/accounts/${encodeURIComponent(next.alias)}/login`, { method: 'POST' });
      showToast(`Đã xong ${currentAlias}! Đang mở Chrome cho acc tiếp theo: ${next.alias}.`, 'success');
      await refreshAll();
    } else {
      showToast('Hoàn tất! Tất cả profile riêng đã sẵn sàng sử dụng.', 'success');
    }
  } catch (err) {
    showToast(`Lỗi xác nhận đăng nhập: ${err.message}`, 'error');
  }
}

async function checkAccount(alias) {
  await withBusy(`check:${alias}`, async () => {
    try {
      showToast(`Đang kiểm tra phiên ${alias}...`, 'info');
      const res = await api(`/api/accounts/${encodeURIComponent(alias)}/check`, { method: 'POST' });
      showToast(
        `${alias}: ${res.result.status} — ${res.result.detail}`,
        res.result.status === 'needs_login' || res.result.status === 'error' ? 'warn' : 'success',
      );
      await refreshAll();
    } catch (err) {
      showToast(`Lỗi kiểm tra phiên: ${err.message}`, 'error');
    }
  });
}

async function setCooldown(alias, hours, bucket = 'all') {
  try {
    const cleanBucket = bucket && bucket !== 'all' ? bucket : undefined;
    await api(`/api/accounts/${encodeURIComponent(alias)}/cooldown`, {
      method: 'POST',
      body: JSON.stringify({
        hours,
        reason: `Đặt thủ công (+${hours}h${cleanBucket ? ` [${cleanBucket}]` : ''})`,
        ...(cleanBucket ? { bucket: cleanBucket } : {}),
      }),
    });
    showToast(`Đã đặt cooldown +${hours}h${cleanBucket ? ` [${cleanBucket}]` : ''} cho ${alias}.`, 'warn');
    await refreshAll();
  } catch (err) {
    showToast(`Lỗi đặt cooldown: ${err.message}`, 'error');
  }
}

async function clearCooldown(alias, bucket) {
  try {
    const qs = bucket && bucket !== 'all' ? `?bucket=${encodeURIComponent(bucket)}` : '';
    await api(`/api/accounts/${encodeURIComponent(alias)}/cooldown${qs}`, { method: 'DELETE' });
    showToast(`Đã gỡ cooldown${bucket && bucket !== 'all' ? ` [${bucket}]` : ''} cho ${alias}.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Lỗi gỡ cooldown: ${err.message}`, 'error');
  }
}

async function rotateNext(activateAgy = false) {
  const busyKey = activateAgy ? 'rotate-agy' : 'rotate';
  await withBusy(busyKey, async () => {
    try {
      const res = await api('/api/pool/next', {
        method: 'POST',
        body: JSON.stringify(
          activateAgy
            ? { activateAgy: true, requireAgy: true, openChrome: false }
            : { openChrome: true },
        ),
      });
      if (activateAgy && res.agyActivated) {
        showToast(
          `Đã xoay vòng và nạp phiên agy sang ${res.active.alias}! Mở lại agy là chạy đúng acc.`,
          'success',
        );
      } else {
        showToast(`Đã xoay vòng sang ${res.active.alias}!`, 'success');
      }
      await refreshAll();
    } catch (err) {
      showToast(err.message, 'warn');
      await refreshAll();
    }
  });
}

async function openAgyHealthModal() {
  el('agy-health-modal').hidden = false;
  await refreshAgyHealth();
}

async function refreshAgyHealth() {
  const summaryEl = el('health-summary-bar');
  const listEl = el('health-list');
  const leaseBox = el('health-lease-box');
  const renewalsBox = el('health-renewals-box');
  summaryEl.replaceChildren();
  listEl.replaceChildren();
  leaseBox.hidden = true;
  renewalsBox.hidden = true;

  const loading = document.createElement('p');
  loading.className = 'muted-small';
  loading.textContent = 'Đang kiểm tra sức khỏe các snapshot agy...';
  listEl.appendChild(loading);

  try {
    const data = await api('/api/agy/health');
    summaryEl.replaceChildren();
    for (const [label, cls] of [
      [`Khỏe mạnh: ${data.summary.healthy}`, 'badge-ready'],
      [`Chờ refresh: ${data.summary.needs_refresh}`, 'badge-link'],
      [`Chưa lưu: ${data.summary.missing_snapshot}`, 'badge-neutral'],
      [`Lỗi: ${data.summary.issues}`, data.summary.issues > 0 ? 'badge-danger' : 'badge-neutral'],
    ]) {
      const span = document.createElement('span');
      span.className = `badge ${cls}`;
      span.textContent = label;
      summaryEl.appendChild(span);
    }

    if (data.lease) {
      leaseBox.hidden = false;
      el('health-lease-text').textContent =
        `Khóa agy.lock: ${data.lease.stale ? 'STALE (đã quá hạn/PID đã thoát)' : 'ĐANG GIỮ'} — ` +
        `holder="${data.lease.holder}", acc="${data.lease.alias}", PID=${data.lease.pid}`;
    }

    listEl.replaceChildren();
    if (!data.accounts || data.accounts.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted-small';
      p.textContent = 'Chưa có tài khoản nào trong pool.';
      listEl.appendChild(p);
    } else {
      const badgeMap = {
        healthy: ['Khỏe mạnh', 'badge-ready'],
        needs_refresh: ['Chờ refresh', 'badge-link'],
        missing_snapshot: ['Chưa lưu', 'badge-neutral'],
        email_mismatch: ['Lệch email', 'badge-danger'],
        corrupt: ['Lỗi snapshot', 'badge-danger'],
      };
      for (const acc of data.accounts) {
        const row = document.createElement('div');
        row.className = 'health-row';

        const left = document.createElement('div');
        left.className = 'health-row-left';

        const title = document.createElement('div');
        title.className = 'health-row-title';
        title.textContent = acc.alias;
        if (acc.is_live) {
          const liveBadge = document.createElement('span');
          liveBadge.className = 'badge badge-ready';
          liveBadge.textContent = 'Keychain live';
          title.appendChild(liveBadge);
        }
        const [stLabel, stCls] = badgeMap[acc.health] || ['Không rõ', 'badge-neutral'];
        const stBadge = document.createElement('span');
        stBadge.className = `badge ${stCls}`;
        stBadge.textContent = stLabel;
        title.appendChild(stBadge);

        const detail = document.createElement('div');
        detail.className = 'health-row-detail';
        detail.textContent = `${acc.email} — ${acc.detail}`;

        left.appendChild(title);
        left.appendChild(detail);
        row.appendChild(left);
        listEl.appendChild(row);
      }
    }

    if (data.renewal_alerts && data.renewal_alerts.length > 0) {
      renewalsBox.hidden = false;
      const rList = el('health-renewals-list');
      rList.replaceChildren();
      for (const a of data.renewal_alerts) {
        const p = document.createElement('p');
        p.className = 'muted-small';
        p.textContent = `${a.alias} (${a.plan_tier}) — gia hạn ${a.renewal_date} (${a.days_left <= 0 ? 'đã quá hạn!' : `còn ${a.days_left} ngày`})`;
        rList.appendChild(p);
      }
    }
  } catch (err) {
    listEl.replaceChildren();
    const errP = document.createElement('p');
    errP.className = 'form-error';
    errP.textContent = `Không kiểm tra được sức khỏe agy: ${err.message}`;
    listEl.appendChild(errP);
  }
}

async function unlockAgyLease() {
  try {
    await api('/api/agy/lease', { method: 'DELETE' });
    showToast('Đã mở khóa agy.lock.', 'success');
    await Promise.all([refreshAgyHealth(), refreshAll()]);
  } catch (err) {
    showToast(`Lỗi mở khóa: ${err.message}`, 'error');
  }
}

async function runKeepAliveSweep() {
  const sweepBtn = el('btn-sweep');
  sweepBtn.disabled = true;
  try {
    showToast('Đang chạy Keep-Alive kiểm tra lần lượt các profile...', 'info');
    const res = await api('/api/keepalive/sweep', { method: 'POST' });
    showToast(`Đã quét xong ${res.results.length} tài khoản.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Lỗi quét Keep-Alive: ${err.message}`, 'error');
    renderKeepAlivePill();
  }
}

async function openImportChromeModal(defaultTab = 'discover') {
  el('discover-error').hidden = true;
  el('bulk-error').hidden = true;
  el('discover-notice').hidden = true;
  switchImportTab(defaultTab);
  updateBulkPreview();
  el('import-chrome-modal').hidden = false;
  await discoverChromeAccounts();
}

function switchImportTab(tab) {
  const isDiscover = tab === 'discover';
  el('tab-btn-discover').classList.toggle('tab-active', isDiscover);
  el('tab-btn-bulk').classList.toggle('tab-active', !isDiscover);
  el('panel-discover').hidden = !isDiscover;
  el('bulk-import-form').hidden = isDiscover;
}

async function discoverChromeAccounts() {
  const listEl = el('discovered-list');
  const noticeEl = el('discover-notice');
  const noticeTextEl = el('discover-notice-text');
  noticeEl.hidden = true;
  el('discover-error').hidden = true;
  listEl.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'muted-small';
  loading.textContent = 'Đang quét Chrome / Brave trên máy...';
  listEl.appendChild(loading);

  try {
    const res = await api('/api/import/chrome/discover');
    state.discoveredAccounts = res.discoveredAccounts || [];
    state.discoveredProfiles = res.profiles || [];
    const warnings = res.warnings || [];
    const permissionBlocked = Boolean(res.permissionBlocked);

    if (permissionBlocked && warnings.length > 0) {
      noticeTextEl.textContent = warnings.map((w) => w.message).join(' ');
      noticeEl.hidden = false;
    } else if (state.discoveredAccounts.length === 0) {
      const profileNames = state.discoveredProfiles
        .map((p) => `${p.browser} (${p.profileName})`)
        .join(', ');
      noticeTextEl.textContent = profileNames
        ? `Đã thấy ${profileNames} đang có cookie hoạt động, nhưng các Gmail của anh đăng nhập kiểu Multi-login trên Web (không bật Chrome Sync) nên Chrome không ghi email ra file cấu hình. Hãy dùng nút bên dưới để nhập hết trong 5 giây.`
        : 'Không tự phát hiện được email từ metadata Chrome/Brave. Hãy chuyển sang tab nhập nhanh bằng Copy/Paste ngay bên dưới.';
      noticeEl.hidden = false;
    }

    renderDiscoveredAccounts();
    renderBulkProfileSelect();
  } catch (err) {
    listEl.replaceChildren();
    el('discover-error').textContent = `Không quét được trình duyệt: ${err.message}`;
    el('discover-error').hidden = false;
  }
}

function renderDiscoveredAccounts() {
  const listEl = el('discovered-list');
  const submitBtn = el('btn-submit-discover');
  listEl.replaceChildren();

  const selectableCount = state.discoveredAccounts.filter((a) => !a.alreadyInPool).length;
  submitBtn.disabled = selectableCount === 0;

  if (state.discoveredAccounts.length === 0) {
    return;
  }

  for (let i = 0; i < state.discoveredAccounts.length; i += 1) {
    const item = state.discoveredAccounts[i];
    const row = document.createElement('div');
    row.className = 'discovered-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !item.alreadyInPool;
    checkbox.disabled = item.alreadyInPool;
    checkbox.dataset.discoverIdx = String(i);

    const info = document.createElement('div');
    info.className = 'discovered-info';

    const emailSpan = document.createElement('span');
    emailSpan.className = 'discovered-email';
    emailSpan.textContent = item.fullName ? `${item.email} (${item.fullName})` : item.email;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'discovered-meta';
    const cookieState = item.hasCookies ? 'Có sẵn phiên cookie' : 'Chưa thấy cookie';
    const poolState = item.alreadyInPool ? ' • Đã có trong pool' : '';
    metaSpan.textContent = `${item.browser} • ${item.profileDisplayName} (${item.profileName}) • ${cookieState}${poolState}`;

    info.appendChild(emailSpan);
    info.appendChild(metaSpan);

    const aliasInput = document.createElement('input');
    aliasInput.type = 'text';
    aliasInput.value = item.suggestedAlias;
    aliasInput.disabled = item.alreadyInPool;
    aliasInput.placeholder = 'alias';
    aliasInput.dataset.discoverAliasIdx = String(i);

    row.appendChild(checkbox);
    row.appendChild(info);
    row.appendChild(aliasInput);
    listEl.appendChild(row);
  }
}

function renderBulkProfileSelect() {
  const select = el('bulk-profile-select');
  select.replaceChildren();

  for (const prof of state.discoveredProfiles) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ userDataDir: prof.userDataDir, profileName: prof.profileName });
    const extra = prof.primaryEmail ? ` — ${prof.primaryEmail}` : '';
    opt.textContent = `${prof.browser}: ${prof.displayName} (${prof.profileName})${extra}`;
    select.appendChild(opt);
  }

  const manualOpt = document.createElement('option');
  manualOpt.value = '__custom__';
  manualOpt.textContent = 'Nhập tên profile Chrome thủ công (vd: Default, Profile 1)...';
  select.appendChild(manualOpt);

  el('bulk-custom-profile-wrap').hidden = select.value !== '__custom__';
}

function toggleAccountLinkedFields() {
  const isLinked = el('acc-profile-mode').value === 'linked';
  el('acc-linked-fields').hidden = !isLinked;
  el('acc-authuser-wrap').hidden = !isLinked;
}

function openAccountModal(existing = null) {
  el('account-form-error').hidden = true;
  el('account-modal-title').textContent = existing ? `Sửa tài khoản: ${existing.alias}` : 'Thêm tài khoản mới';
  el('acc-editing-alias').value = existing ? existing.alias : '';
  el('acc-alias').value = existing ? existing.alias : '';
  el('acc-email').value = existing ? existing.email : '';
  el('acc-display-name').value = existing ? existing.display_name : '';
  el('acc-plan-tier').value = existing ? existing.plan_tier : 'Google AI Pro';
  el('acc-renewal-date').value = existing?.renewal_date || '';
  el('acc-tags').value = existing ? (existing.tags || []).join(', ') : '';
  el('acc-profile-mode').value = existing ? existing.profile_mode || 'isolated' : 'isolated';
  el('acc-google-authuser').value = existing?.google_authuser || '';
  el('acc-chrome-user-data-dir').value = existing?.chrome_user_data_dir || '';
  el('acc-chrome-profile-name').value = existing?.chrome_profile_name || 'Default';
  el('acc-proxy-url').value = existing?.proxy_url || '';
  el('acc-adc-path').value = existing?.adc_credentials_path || '';
  el('acc-notes').value = existing?.notes || '';
  toggleAccountLinkedFields();
  el('account-modal').hidden = false;
  el('acc-alias').focus();
}

async function openSettingsModal() {
  if (!state.settings) {
    try {
      const data = await api('/api/settings');
      state.settings = data.settings;
    } catch (err) {
      showToast(`Không tải được cài đặt: ${err.message}`, 'error');
      return;
    }
  }
  el('settings-form-error').hidden = true;
  el('set-keepalive-enabled').checked = Boolean(state.settings.keepalive_enabled);
  el('set-interval').value = String(state.settings.keepalive_interval_minutes);
  el('set-jitter').value = String(state.settings.keepalive_jitter_percent);
  el('set-stagger').value = String(state.settings.keepalive_stagger_seconds);
  el('set-cooldown-hours').value = String(state.settings.default_cooldown_hours);
  el('set-rotation-policy').value = state.settings.rotation_policy || 'lru';
  el('set-renewal-alert-days').value = String(state.settings.renewal_alert_days ?? 7);
  el('set-notify').checked = Boolean(state.settings.notify_on_expiry);
  el('set-chrome-bin').value = state.settings.chrome_binary || '';
  el('set-open-url').value = state.settings.default_open_url || '';
  el('settings-modal').hidden = false;
}

function openDeleteModal(acc) {
  state.deleteTargetAlias = acc.alias;
  el('delete-message').textContent = `Bạn chắc chắn muốn xóa tài khoản "${acc.alias}" khỏi pool?`;
  el('delete-purge-profile').checked = false;
  el('delete-purge-wrap').hidden = acc.profile_mode === 'linked';
  el('delete-modal').hidden = false;
}

function closeModal(id) {
  const node = el(id);
  if (node) node.hidden = true;
}

function connectSSE() {
  const sseDot = el('sse-dot');
  const sseText = el('sse-text');
  const source = new EventSource('/api/events/stream');

  source.addEventListener('open', () => {
    setSseConnected();
  });

  source.addEventListener('snapshot', (ev) => {
    setSseConnected();
    try {
      applySnapshot(JSON.parse(ev.data));
    } catch {
      // Ignore malformed payload.
    }
  });

  source.addEventListener('state_changed', (ev) => {
    setSseConnected();
    try {
      applySnapshot(JSON.parse(ev.data));
    } catch {
      void refreshAll();
    }
  });

  source.addEventListener('keepalive_event', () => {
    setSseConnected();
  });

  source.onerror = () => {
    sseDot.className = 'dot dot-danger';
    sseText.textContent = 'Đang kết nối lại...';
  };
}

function initTheme() {
  const saved = localStorage.getItem('gpool_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = el('btn-theme');
  const syncThemeBtn = (theme) => {
    btn.title = theme === 'dark' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Tối';
  };
  syncThemeBtn(saved);
  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('gpool_theme', next);
    syncThemeBtn(next);
  });
}

function bindEvents() {
  el('btn-add-account').addEventListener('click', () => openAccountModal());
  el('btn-import-chrome').addEventListener('click', () => openImportChromeModal('discover'));
  el('btn-rescan-chrome').addEventListener('click', () => discoverChromeAccounts());
  el('btn-settings').addEventListener('click', () => openSettingsModal());
  el('btn-agy-health').addEventListener('click', () => openAgyHealthModal());
  el('btn-refresh-health').addEventListener('click', () => refreshAgyHealth());
  el('btn-unlock-lease').addEventListener('click', () => unlockAgyLease());
  el('btn-sweep').addEventListener('click', () => runKeepAliveSweep());
  el('btn-rotate-agy-next').addEventListener('click', () => rotateNext(true));
  el('btn-rotate-next').addEventListener('click', () => rotateNext(false));
  el('btn-wizard-isolate-all').addEventListener('click', () => isolateAllAccounts());
  el('btn-wizard-dismiss').addEventListener('click', () => {
    state.wizardDismissed = true;
    renderLoginWizard();
  });
  el('btn-wizard-open').addEventListener('click', () => {
    if (state.wizardCurrentAlias) void openAccountLogin(state.wizardCurrentAlias);
  });
  el('btn-wizard-done-next').addEventListener('click', () => confirmWizardLoginAndNext());
  el('btn-wizard-skip').addEventListener('click', () => {
    if (!state.wizardCurrentAlias) return;
    state.wizardSkippedAliases = state.wizardSkippedAliases.filter((a) => a !== state.wizardCurrentAlias);
    state.wizardSkippedAliases.push(state.wizardCurrentAlias);
    renderLoginWizard();
  });
  el('acc-profile-mode').addEventListener('change', () => toggleAccountLinkedFields());

  for (const card of document.querySelectorAll('[data-kpi-filter]')) {
    card.addEventListener('click', () => {
      const target = card.dataset.kpiFilter || 'all';
      setStatusFilter(state.filterStatus === target && target !== 'all' ? 'all' : target);
    });
  }

  for (const tabBtn of document.querySelectorAll('[data-import-tab]')) {
    tabBtn.addEventListener('click', () => switchImportTab(tabBtn.dataset.importTab));
  }

  el('bulk-profile-select').addEventListener('change', (e) => {
    el('bulk-custom-profile-wrap').hidden = e.target.value !== '__custom__';
  });

  el('btn-open-signout-options').addEventListener('click', () => {
    window.open('https://accounts.google.com/SignOutOptions', '_blank', 'noopener');
  });

  el('btn-jump-to-bulk').addEventListener('click', () => {
    switchImportTab('bulk');
    el('bulk-emails-text').focus();
  });

  el('btn-paste-clipboard').addEventListener('click', async () => {
    el('bulk-error').hidden = true;
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast('Clipboard đang trống. Hãy bấm "1. Mở trang tài khoản Google", nhấn ⌘A rồi ⌘C.', 'warn');
        return;
      }
      el('bulk-emails-text').value = text;
      const found = updateBulkPreview();
      if (found.length === 0) {
        showToast('Không thấy email nào trong Clipboard. Hãy nhấn ⌘A ⌘C trên trang SignOutOptions.', 'warn');
      } else {
        showToast(`Đã lọc ra ${found.length} email từ Clipboard!`, 'success');
      }
    } catch {
      el('bulk-emails-text').focus();
      showToast('Trình duyệt không cho đọc clipboard tự động — anh nhấn ⌘V trực tiếp vào ô bên dưới nhé.', 'info');
    }
  });

  el('bulk-emails-text').addEventListener('input', () => {
    updateBulkPreview();
  });

  el('btn-submit-discover').addEventListener('click', async () => {
    const errEl = el('discover-error');
    const submitBtn = el('btn-submit-discover');
    errEl.hidden = true;
    const items = [];
    for (const cb of document.querySelectorAll('[data-discover-idx]')) {
      if (!cb.checked) continue;
      const idx = Number(cb.dataset.discoverIdx);
      const item = state.discoveredAccounts[idx];
      if (!item) continue;
      const aliasInput = document.querySelector(`[data-discover-alias-idx="${idx}"]`);
      items.push({
        alias: aliasInput?.value.trim() || item.suggestedAlias,
        email: item.email,
        display_name: item.fullName,
        chrome_user_data_dir: item.userDataDir,
        chrome_profile_name: item.profileName,
        google_authuser: item.email,
        has_cookies: item.hasCookies,
      });
    }

    if (items.length === 0) {
      errEl.textContent = 'Hãy tick chọn ít nhất một tài khoản mới để nhập.';
      errEl.hidden = false;
      return;
    }

    const mode = el('discover-mode').value;
    const plan_tier = el('discover-plan').value;
    const tags = el('discover-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    submitBtn.disabled = true;
    try {
      const res = await api('/api/import/chrome', {
        method: 'POST',
        body: JSON.stringify({ mode, plan_tier, tags, items }),
      });
      closeModal('import-chrome-modal');
      showToast(
        `Đã nhập ${res.created.length} tài khoản (${mode === 'linked' ? 'Link Chrome' : 'Profile riêng'})${res.skipped.length ? `, bỏ qua ${res.skipped.length}` : ''}.`,
        'success',
      );
      await refreshAll();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  el('bulk-import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = el('bulk-error');
    const submitBtn = el('btn-submit-bulk');
    errEl.hidden = true;

    const rawText = el('bulk-emails-text').value;
    const previewEmails = extractEmailsPreview(rawText);
    if (previewEmails.length === 0) {
      errEl.textContent = 'Không tìm thấy email Google hợp lệ nào trong ô nhập.';
      errEl.hidden = false;
      return;
    }

    const mode = el('bulk-mode').value;
    const profileChoice = el('bulk-profile-select').value;
    let chrome_user_data_dir = null;
    let chrome_profile_name = 'Default';
    if (profileChoice && profileChoice !== '__custom__') {
      try {
        const parsed = JSON.parse(profileChoice);
        chrome_user_data_dir = parsed.userDataDir || null;
        chrome_profile_name = parsed.profileName || 'Default';
      } catch {
        chrome_profile_name = 'Default';
      }
    } else {
      chrome_profile_name = el('bulk-custom-profile').value.trim() || 'Default';
    }

    const plan_tier = el('bulk-plan').value;
    const tags = el('bulk-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    submitBtn.disabled = true;
    try {
      const res = await api('/api/import/chrome', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          chrome_user_data_dir,
          chrome_profile_name,
          plan_tier,
          tags,
          rawText,
        }),
      });
      if (res.errors.length > 0 && res.created.length === 0) {
        errEl.textContent = res.errors.map((er) => `${er.email}: ${er.error}`).join('; ');
        errEl.hidden = false;
        return;
      }
      if (mode === 'isolated') {
        state.wizardDismissed = false;
      }
      el('bulk-emails-text').value = '';
      updateBulkPreview();
      closeModal('import-chrome-modal');
      showToast(
        `Đã nhập ${res.created.length} tài khoản${res.skipped.length ? `, bỏ qua ${res.skipped.length}` : ''}${res.errors.length ? `, lỗi ${res.errors.length}` : ''}.`,
        res.errors.length ? 'warn' : 'success',
      );
      await refreshAll();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  el('btn-active-open').addEventListener('click', () => {
    const active = state.accounts.find((a) => a.alias === state.activeAlias);
    if (!active) return;
    const isNeedsLogin = active.session_status === 'needs_login' || active.session_status === 'unknown';
    if (isNeedsLogin) void openAccountLogin(active.alias);
    else void openAccountChrome(active.alias);
  });

  el('btn-active-agy').addEventListener('click', () => {
    const active = state.accounts.find((a) => a.alias === state.activeAlias);
    if (!active) return;
    if (active.agy_session?.captured && !active.agy_session.is_live_owner) {
      void agyActivate(active.alias);
    } else {
      void agyCapture(active.alias);
    }
  });

  el('oauth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const alias = el('oauth-account-select').value;
    const oauthUrl = el('oauth-url-input').value.trim();
    const submitBtn = el('btn-oauth-submit');
    if (!alias) {
      showToast('Hãy thêm hoặc chọn một tài khoản trước.', 'warn');
      return;
    }
    if (!oauthUrl) {
      showToast('Hãy dán link OAuth vào ô nhập.', 'warn');
      return;
    }
    submitBtn.disabled = true;
    try {
      await api(`/api/accounts/${encodeURIComponent(alias)}/oauth`, {
        method: 'POST',
        body: JSON.stringify({ oauthUrl }),
      });
      el('oauth-url-input').value = '';
      showToast(`Đã mở link OAuth trong Chrome cho "${alias}".`, 'success');
      await refreshAll();
    } catch (err) {
      showToast(`Không mở được OAuth: ${err.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  el('search-input').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderAccountsGrid();
  });

  for (const btn of document.querySelectorAll('#status-filters .chip')) {
    btn.addEventListener('click', () => {
      setStatusFilter(btn.dataset.status || 'all');
    });
  }

  el('btn-toggle-events').addEventListener('click', () => {
    const list = el('events-list');
    const hidden = !list.hidden;
    list.hidden = hidden;
    el('btn-toggle-events').textContent = hidden ? 'Mở rộng' : 'Thu gọn';
  });

  for (const btn of document.querySelectorAll('[data-close-modal]')) {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  }

  // Click backdrop outside modal to close
  for (const backdrop of document.querySelectorAll('.modal-backdrop')) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.hidden = true;
      }
    });
  }

  el('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = el('account-form-error');
    const saveBtn = el('btn-save-account');
    errEl.hidden = true;

    const editingAlias = el('acc-editing-alias').value;
    const profileMode = el('acc-profile-mode').value;
    const payload = {
      alias: el('acc-alias').value.trim(),
      email: el('acc-email').value.trim(),
      display_name: el('acc-display-name').value.trim(),
      plan_tier: el('acc-plan-tier').value,
      renewal_date: el('acc-renewal-date').value.trim() || null,
      tags: el('acc-tags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      profile_mode: profileMode,
      chrome_user_data_dir:
        profileMode === 'linked' ? el('acc-chrome-user-data-dir').value.trim() || null : null,
      chrome_profile_name:
        profileMode === 'linked' ? el('acc-chrome-profile-name').value.trim() || 'Default' : null,
      google_authuser:
        profileMode === 'linked' ? el('acc-google-authuser').value.trim() || null : null,
      proxy_url: el('acc-proxy-url').value.trim() || null,
      adc_credentials_path: el('acc-adc-path').value.trim() || null,
      notes: el('acc-notes').value.trim(),
    };

    saveBtn.disabled = true;
    try {
      if (editingAlias) {
        await api(`/api/accounts/${encodeURIComponent(editingAlias)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        showToast(`Đã cập nhật ${payload.alias}.`, 'success');
      } else {
        await api('/api/accounts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast(`Đã thêm ${payload.alias}.`, 'success');
      }
      closeModal('account-modal');
      await refreshAll();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  el('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = el('settings-form-error');
    const saveBtn = el('btn-save-settings');
    errEl.hidden = true;

    const payload = {
      keepalive_enabled: el('set-keepalive-enabled').checked,
      keepalive_interval_minutes: Number(el('set-interval').value),
      keepalive_jitter_percent: Number(el('set-jitter').value),
      keepalive_stagger_seconds: Number(el('set-stagger').value),
      default_cooldown_hours: Number(el('set-cooldown-hours').value),
      rotation_policy: el('set-rotation-policy').value,
      renewal_alert_days: Number(el('set-renewal-alert-days').value),
      notify_on_expiry: el('set-notify').checked,
      chrome_binary: el('set-chrome-bin').value.trim(),
      default_open_url: el('set-open-url').value.trim(),
    };

    saveBtn.disabled = true;
    try {
      const res = await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      state.settings = res.settings;
      closeModal('settings-modal');
      renderKeepAlivePill();
      renderHeroPanel();
      showToast('Đã lưu cài đặt.', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  el('btn-export-json').addEventListener('click', async () => {
    try {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `google-one-pool-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Đã xuất metadata JSON.', 'success');
    } catch (err) {
      showToast(`Lỗi xuất JSON: ${err.message}`, 'error');
    }
  });

  el('input-import-json').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await api('/api/import', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast(`Import xong: thêm ${res.created}, cập nhật ${res.updated}.`, 'success');
      await refreshAll();
    } catch (err) {
      showToast(`Lỗi import JSON: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });

  el('btn-confirm-delete').addEventListener('click', async () => {
    if (!state.deleteTargetAlias) return;
    const delBtn = el('btn-confirm-delete');
    const purge = !el('delete-purge-wrap').hidden && el('delete-purge-profile').checked;
    delBtn.disabled = true;
    try {
      await api(
        `/api/accounts/${encodeURIComponent(state.deleteTargetAlias)}?purgeProfile=${purge ? 'true' : 'false'}`,
        { method: 'DELETE' },
      );
      showToast(`Đã xóa ${state.deleteTargetAlias}.`, 'success');
      closeModal('delete-modal');
      await refreshAll();
    } catch (err) {
      showToast(`Lỗi xóa tài khoản: ${err.message}`, 'error');
    } finally {
      delBtn.disabled = false;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el('search-input').focus();
    } else if (e.key === 'Escape') {
      closeModal('account-modal');
      closeModal('settings-modal');
      closeModal('delete-modal');
      closeModal('import-chrome-modal');
      closeModal('agy-health-modal');
    }
  });
}

function startCooldownTicker() {
  setInterval(() => {
    const nodes = document.querySelectorAll('[data-cooldown-until]');
    for (const node of nodes) {
      const untilMs = Date.parse(node.dataset.cooldownUntil || '');
      if (Number.isNaN(untilMs)) continue;
      const remaining = untilMs - Date.now();
      if (remaining <= 0) {
        if (!state.cooldownTickTriggeredRefresh) {
          state.cooldownTickTriggeredRefresh = true;
          void refreshAll();
        }
      } else {
        const prefix = node.dataset.cooldownPrefix || '';
        const reason = node.dataset.cooldownReason || '';
        node.textContent = `${prefix}Còn ${formatDurationMs(remaining)}${reason ? ` — ${reason}` : ''}`;
      }
    }
  }, 1000);
}

function extractEmailsPreview(rawText) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const seen = new Set();
  const out = [];
  for (const m of (rawText || '').match(emailRegex) || []) {
    const clean = m.trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function updateBulkPreview() {
  const text = el('bulk-emails-text')?.value || '';
  const emails = extractEmailsPreview(text);
  const strip = el('bulk-preview-strip');
  const titleEl = el('bulk-preview-title');
  const chipsEl = el('bulk-preview-chips');
  if (!strip || !titleEl || !chipsEl) return emails;

  chipsEl.replaceChildren();
  if (emails.length === 0) {
    strip.hidden = true;
    return emails;
  }

  strip.hidden = false;
  titleEl.textContent = `Phát hiện ${emails.length} email trong nội dung vừa dán:`;
  for (const email of emails) {
    const chip = document.createElement('span');
    chip.className = 'preview-chip';
    chip.textContent = email;
    chipsEl.appendChild(chip);
  }
  return emails;
}

initTheme();
bindEvents();
connectSSE();
void refreshAll();
startCooldownTicker();
