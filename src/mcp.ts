import readline from 'node:readline';
import { acquireAgyLease, DEFAULT_LEASE_TTL_MS, readAgyLease, releaseAgyLease } from './agylock.ts';
import { parseQuotaError, runAgyWithFailover, type AgyProcessRunner } from './agy-runner.ts';
import {
  activateAgySession,
  getLiveKeychainContext,
  inspectAgyHealth,
  listCapturedAliases,
  sessionInfoForAlias,
  type AgySessionDeps,
} from './agysession.ts';
import { isAccountChromeRunning } from './chrome.ts';
import { DEFAULT_HOST, validateBucketName, validateRotationPolicy, type PoolPaths } from './config.ts';
import { PoolDB } from './db.ts';
import { PoolSwitcher } from './switcher.ts';
import type { RotationPolicy } from './types.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpHandlerOptions {
  paths: PoolPaths;
  port?: number;
  agyDeps?: AgySessionDeps;
  processRunner?: AgyProcessRunner;
  notifyDaemon?: boolean;
}

const SERVER_INFO = {
  name: 'google-one-pool',
  version: '0.2.0',
};

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'pool_status',
    description:
      'Xem tổng quan pool tài khoản Google AI Pro: số acc sẵn sàng, cooldown (kể cả theo bucket), acc đang active, chủ phiên agy Keychain hiện tại và trạng thái khóa agy.lock.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Lọc danh sách tài khoản theo tag (tuỳ chọn).' },
        bucket: {
          type: 'string',
          description: 'Kiểm tra thời gian hết cooldown sớm nhất cho bucket cụ thể (vd: pro, claude, flash, all).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_health',
    description:
      'Kiểm tra sức khỏe toàn bộ snapshot phiên agy (có refresh_token hay không, hạn access_token, khớp email, acc chưa capture) và cảnh báo ngày gia hạn gói sắp tới.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'agy_acquire',
    description:
      'Chọn tài khoản agy sẵn sàng tốt nhất (hoặc alias chỉ định), lấy khóa agy.lock chống xung đột Keychain, nạp phiên agy vào macOS Keychain và đặt làm active.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Chọn đích danh 1 alias (bỏ trống để tự chọn acc tốt nhất).' },
        tag: { type: 'string', description: 'Chỉ chọn tài khoản có tag này.' },
        bucket: { type: 'string', description: 'Bucket quota cần kiểm tra (vd: all, pro, claude, flash). Mặc định: all.' },
        policy: {
          type: 'string',
          enum: ['lru', 'round-robin', 'tier-first'],
          description: 'Chiến lược chọn tài khoản (mặc định lấy từ cài đặt).',
        },
        holder: { type: 'string', description: 'Tên agent/job giữ khóa agy.lock (vd: devin-worker-1).' },
        ttl_seconds: { type: 'number', description: 'Thời hạn khóa agy.lock tính bằng giây (mặc định 600s).' },
        wait_seconds: { type: 'number', description: 'Số giây chờ nếu agy.lock đang bị tiến trình khác giữ (mặc định 0).' },
        force: { type: 'boolean', description: 'Bỏ qua kiểm tra tiến trình agy đang chạy (chỉ dùng khi chắc chắn).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_release',
    description: 'Giải phóng khóa agy.lock sau khi agent dùng xong phiên agy.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Ép gỡ khóa kể cả khi do PID khác tạo.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_report_quota',
    description:
      'Báo cáo tài khoản vừa đụng giới hạn quota (tự phân tích thời gian reset từ error_text nếu có), đặt cooldown (toàn acc hoặc theo bucket) và tự động xoay + nạp Keychain sang tài khoản agy sẵn sàng kế tiếp.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Alias tài khoản hết quota (bỏ trống = acc đang active).' },
        hours: { type: 'number', description: 'Số giờ cooldown thủ công (nếu bỏ trống sẽ tự parse từ error_text hoặc dùng mặc định).' },
        error_text: { type: 'string', description: 'Nội dung lỗi thô từ agy để tự phân tích thời gian reset & model bucket.' },
        bucket: { type: 'string', description: 'Bucket cooldown: all, pro, claude, flash, opus, sonnet, hoặc auto.' },
        reason: { type: 'string', description: 'Lý do đặt cooldown.' },
        rotate: { type: 'boolean', description: 'Có tự động xoay và nạp phiên agy sang acc kế tiếp hay không (mặc định true).' },
        tag: { type: 'string', description: 'Chỉ xoay trong các acc có tag này.' },
        policy: { type: 'string', enum: ['lru', 'round-robin', 'tier-first'] },
        force: { type: 'boolean', description: 'Ép nạp Keychain kể cả khi phát hiện tiến trình agy đang mở.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'agy_clear_cooldown',
    description: 'Gỡ cooldown cho một tài khoản (toàn bộ hoặc chỉ 1 bucket cụ thể).',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Alias tài khoản cần gỡ cooldown.' },
        bucket: { type: 'string', description: 'Tên bucket cần gỡ (bỏ trống để gỡ toàn bộ cooldown của acc).' },
      },
      required: ['alias'],
      additionalProperties: false,
    },
  },
  {
    name: 'agy_run',
    description:
      'Chạy trực tiếp một lệnh agy với auto-failover hoàn chỉnh: tự giữ khóa agy.lock, nạp Keychain, phát hiện lỗi quota từ output, đặt cooldown thông minh và tự xoay sang acc kế tiếp để thử lại.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Danh sách tham số truyền cho lệnh agy.',
        },
        alias: { type: 'string', description: 'Alias ưu tiên bắt đầu (bỏ trống để tự chọn).' },
        tag: { type: 'string', description: 'Lọc pool theo tag.' },
        bucket: { type: 'string', description: 'Bucket quota (all, pro, claude, flash, auto). Mặc định: all.' },
        policy: { type: 'string', enum: ['lru', 'round-robin', 'tier-first'] },
        max_retries: { type: 'number', description: 'Số lần thử tối đa qua các acc khác nhau (mặc định 3).' },
        wait_seconds: { type: 'number', description: 'Số giây chờ nếu agy.lock đang bận.' },
        timeout_seconds: { type: 'number', description: 'Giới hạn thời gian chạy cho mỗi lần gọi agy (mặc định 300s).' },
        force: { type: 'boolean', description: 'Bỏ qua kiểm tra tiến trình agy đang chạy.' },
      },
      required: ['args'],
      additionalProperties: false,
    },
  },
];

async function pingDaemonSync(port: number | undefined): Promise<void> {
  if (!port) return;
  try {
    await fetch(`http://${DEFAULT_HOST}:${port}/api/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(400),
    });
  } catch {
    // Daemon may not be running — ignore silently.
  }
}

export function createMcpHandler(options: McpHandlerOptions) {
  const { paths, port, agyDeps, processRunner } = options;
  const shouldNotifyDaemon = options.notifyDaemon !== false;

  async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const db = new PoolDB(paths);
    try {
      db.expireElapsedCooldowns();

      if (name === 'pool_status') {
        const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;
        const bucket = typeof args.bucket === 'string' && args.bucket.trim() ? validateBucketName(args.bucket) : 'all';
        let liveCtx = null;
        try {
          liveCtx = getLiveKeychainContext(paths, agyDeps);
        } catch {
          liveCtx = null;
        }

        const accounts = db.listAccounts({ tag }).map((acc) => {
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

        const capturedAliases = listCapturedAliases(paths);
        const readyAgy = accounts.filter(
          (a) =>
            capturedAliases.has(a.alias) &&
            a.session_status !== 'needs_login' &&
            a.session_status !== 'error' &&
            a.cooldown_remaining_ms === 0 &&
            (bucket === 'all' || !(a.bucket_cooldowns ?? []).some((b) => b.bucket === bucket)),
        );

        return {
          ok: true,
          active_alias: accounts.find((a) => a.is_active)?.alias ?? null,
          agy_keychain_owner: liveCtx?.live_owner_alias ?? null,
          keychain_present: liveCtx?.present ?? false,
          lease: readAgyLease(paths),
          settings: {
            default_cooldown_hours: db.getSettings().default_cooldown_hours,
            rotation_policy: db.getSettings().rotation_policy,
          },
          summary: {
            total: accounts.length,
            captured_agy: accounts.filter((a) => a.agy_session?.captured).length,
            ready_for_agy: readyAgy.length,
            cooldown: accounts.filter((a) => a.effective_state === 'cooldown').length,
            needs_login: accounts.filter((a) => a.effective_state === 'needs_login' || a.effective_state === 'error').length,
          },
          next_available_at: db.getEarliestCooldownEnd(tag, new Date(), bucket, capturedAliases),
          accounts: accounts.map((a) => ({
            alias: a.alias,
            email: a.email,
            plan_tier: a.plan_tier,
            effective_state: a.effective_state,
            is_active: a.is_active,
            tags: a.tags,
            use_count: a.use_count,
            cooldown_remaining_ms: a.cooldown_remaining_ms,
            bucket_cooldowns: a.bucket_cooldowns ?? [],
            agy_captured: Boolean(a.agy_session?.captured),
            agy_is_live_owner: Boolean(a.agy_session?.is_live_owner),
          })),
        };
      }

      if (name === 'agy_health') {
        const settings = db.getSettings();
        const alerts = db.getRenewalAlerts(settings.renewal_alert_days);
        const report = inspectAgyHealth(paths, db.listAccounts(), alerts, agyDeps);
        return { ok: true, ...report };
      }

      if (name === 'agy_acquire') {
        const aliasArg = typeof args.alias === 'string' && args.alias.trim() ? args.alias.trim() : undefined;
        const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;
        const bucket = typeof args.bucket === 'string' && args.bucket.trim() ? validateBucketName(args.bucket) : 'all';
        const policy =
          typeof args.policy === 'string' && args.policy.trim()
            ? validateRotationPolicy(args.policy)
            : db.getSettings().rotation_policy;
        const holder = typeof args.holder === 'string' && args.holder.trim() ? args.holder.trim() : 'mcp-agent';
        const ttlMs =
          typeof args.ttl_seconds === 'number' && Number.isFinite(args.ttl_seconds) && args.ttl_seconds > 0
            ? args.ttl_seconds * 1000
            : DEFAULT_LEASE_TTL_MS;
        const waitMs =
          typeof args.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) && args.wait_seconds > 0
            ? args.wait_seconds * 1000
            : 0;
        const force = Boolean(args.force);

        const capturedAliases = listCapturedAliases(paths);
        let target = aliasArg ? db.getAccount(aliasArg) : null;
        if (aliasArg && !target) {
          throw new Error(`Không tìm thấy tài khoản "${aliasArg}".`);
        }
        if (target && !capturedAliases.has(target.alias)) {
          throw new Error(`Tài khoản "${target.alias}" chưa lưu phiên agy.`);
        }
        if (!target) {
          target = db.pickNextReadyAccount({
            tag,
            bucket,
            policy,
            requireAgyAliases: capturedAliases,
          });
        }
        if (!target) {
          return {
            ok: false,
            error: `Không còn tài khoản agy sẵn sàng nào${bucket !== 'all' ? ` cho bucket "${bucket}"` : ''}${tag ? ` (tag "${tag}")` : ''}.`,
            next_available_at: db.getEarliestCooldownEnd(tag, new Date(), bucket, capturedAliases),
          };
        }

        const leaseHandle = await acquireAgyLease(paths, {
          alias: target.alias,
          holder,
          ttlMs,
          waitMs,
        });

        try {
          const actRes = activateAgySession(paths, target, { force }, agyDeps);
          db.setActiveAccount(target.alias);
          db.addEvent(
            target.id,
            target.alias,
            'agy_session_activated',
            `MCP (${holder}) thuê và nạp phiên agy cho ${target.alias}`,
          );
          if (shouldNotifyDaemon) void pingDaemonSync(port);
          return {
            ok: true,
            alias: target.alias,
            email: target.email,
            plan_tier: target.plan_tier,
            recaptured_alias: actRes.recaptured_alias,
            lease: leaseHandle.lease,
          };
        } catch (err) {
          leaseHandle.release();
          throw err;
        }
      }

      if (name === 'agy_release') {
        const released = releaseAgyLease(paths, { force: Boolean(args.force) || true });
        if (shouldNotifyDaemon) void pingDaemonSync(port);
        return { ok: true, released };
      }

      if (name === 'agy_report_quota') {
        const active = db.getActiveAccount();
        const alias =
          typeof args.alias === 'string' && args.alias.trim()
            ? args.alias.trim()
            : active?.alias;
        if (!alias) {
          throw new Error('Không xác định được tài khoản để đặt cooldown (hãy truyền tham số alias).');
        }
        const target = db.getAccount(alias);
        if (!target) {
          throw new Error(`Không tìm thấy tài khoản "${alias}".`);
        }

        const settings = db.getSettings();
        const errorText = typeof args.error_text === 'string' ? args.error_text : '';
        const parsed = errorText ? parseQuotaError(errorText, settings.default_cooldown_hours) : null;
        const rawBucket = typeof args.bucket === 'string' && args.bucket.trim() ? args.bucket.trim().toLowerCase() : 'all';
        const bucket =
          rawBucket === 'auto'
            ? parsed?.detectedBucket ?? 'all'
            : validateBucketName(rawBucket);

        let cooldownHours: number;
        if (typeof args.hours === 'number' && Number.isFinite(args.hours) && args.hours > 0) {
          cooldownHours = args.hours;
        } else if (parsed?.detectedDurationMs !== null && parsed) {
          cooldownHours = parsed.cooldownHours;
        } else {
          cooldownHours = settings.default_cooldown_hours;
        }

        const reason =
          (typeof args.reason === 'string' && args.reason.trim()) ||
          parsed?.reason ||
          `MCP báo hết quota (+${cooldownHours}h)`;
        const untilIso = new Date(Date.now() + cooldownHours * 3_600_000).toISOString();
        db.setBucketCooldown(target.alias, bucket, untilIso, reason);

        const shouldRotate = args.rotate !== false;
        let rotation = null;
        if (shouldRotate) {
          const switcher = new PoolSwitcher({ db, paths });
          rotation = await switcher.rotateNext({
            cooldownHours: 0, // Already set above with exact bucket/reason
            tag: typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined,
            bucket,
            policy:
              typeof args.policy === 'string' && args.policy.trim()
                ? (validateRotationPolicy(args.policy) as RotationPolicy)
                : undefined,
            activateAgy: true,
            forceAgy: Boolean(args.force),
            openChrome: false,
            agyDeps,
          });
        }

        if (shouldNotifyDaemon) void pingDaemonSync(port);
        return {
          ok: rotation ? rotation.ok : true,
          reported_alias: target.alias,
          bucket,
          cooldown_hours: cooldownHours,
          cooldown_until: untilIso,
          reason,
          ...(rotation
            ? {
                next_alias: rotation.active?.alias ?? null,
                next_email: rotation.active?.email ?? null,
                agy_activated: Boolean(rotation.agyActivated),
                next_available_at: rotation.nextAvailableAt ?? null,
                rotation_error: rotation.error ?? null,
              }
            : {}),
        };
      }

      if (name === 'agy_clear_cooldown') {
        const alias = typeof args.alias === 'string' ? args.alias.trim() : '';
        if (!alias) throw new Error('Cần truyền tham số alias.');
        const bucket = typeof args.bucket === 'string' && args.bucket.trim() ? args.bucket.trim() : undefined;
        const updated = db.clearCooldown(alias, bucket);
        if (shouldNotifyDaemon) void pingDaemonSync(port);
        return {
          ok: true,
          alias: updated.alias,
          cleared_bucket: bucket ?? 'all',
        };
      }

      if (name === 'agy_run') {
        const rawArgs = Array.isArray(args.args)
          ? args.args.filter((x): x is string => typeof x === 'string')
          : [];
        const result = await runAgyWithFailover({
          db,
          paths,
          agyArgs: rawArgs,
          alias: typeof args.alias === 'string' && args.alias.trim() ? args.alias.trim() : undefined,
          tag: typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined,
          bucket: typeof args.bucket === 'string' && args.bucket.trim() ? args.bucket.trim() : 'all',
          policy:
            typeof args.policy === 'string' && args.policy.trim()
              ? validateRotationPolicy(args.policy)
              : undefined,
          maxRetries: typeof args.max_retries === 'number' ? args.max_retries : 3,
          waitSeconds: typeof args.wait_seconds === 'number' ? args.wait_seconds : 0,
          timeoutSeconds: typeof args.timeout_seconds === 'number' ? args.timeout_seconds : 300,
          forceAgy: Boolean(args.force),
          interactive: false,
          mirrorStdio: false,
          holder: 'mcp-agy-run',
          processRunner,
          agyDeps,
        });
        if (shouldNotifyDaemon) void pingDaemonSync(port);
        return result;
      }

      throw new Error(`Tool không tồn tại: "${name}"`);
    } finally {
      db.close();
    }
  }

  return async function handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const hasId = msg.id !== undefined && msg.id !== null;
    const id = msg.id ?? null;

    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
      return null;
    }

    if (msg.method === 'initialize') {
      const requestedVersion =
        typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        },
      };
    }

    if (msg.method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS,
        },
      };
    }

    if (msg.method === 'tools/call') {
      const toolName = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const toolArgs =
        msg.params?.arguments && typeof msg.params.arguments === 'object'
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      try {
        const data = await executeTool(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
            isError: typeof data === 'object' && data !== null && 'ok' in data && (data as { ok: unknown }).ok === false,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: message }, null, 2),
              },
            ],
            isError: true,
          },
        };
      }
    }

    if (!hasId) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${msg.method}`,
      },
    };
  };
}

/**
 * Starts the newline-delimited JSON-RPC 2.0 MCP server over stdin/stdout.
 */
export async function runMcpServer(options: McpHandlerOptions): Promise<number> {
  const handleMessage = createMcpHandler(options);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const writeResponse = (res: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(res) + '\n');
  };

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      continue;
    }

    try {
      const response = await handleMessage(parsed);
      if (response) writeResponse(response);
    } catch (err) {
      writeResponse({
        jsonrpc: '2.0',
        id: parsed.id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return 0;
}
