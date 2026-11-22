import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireAgyLease, readAgyLease, releaseAgyLease } from '../src/agylock.ts';
import { parseQuotaError, runAgyWithFailover } from '../src/agy-runner.ts';
import {
  captureAgySession,
  inspectAgyHealth,
  listCapturedAliases,
  type SecurityRunResult,
} from '../src/agysession.ts';
import { DEFAULT_HOST, resolvePaths } from '../src/config.ts';
import { PoolDB } from '../src/db.ts';
import { KeepAliveScheduler } from '../src/keepalive.ts';
import { createMcpHandler } from '../src/mcp.ts';
import { createDaemonServer } from '../src/server.ts';
import { PoolSwitcher } from '../src/switcher.ts';

function tokenizeInteractiveLine(line: string): string[] {
  const tokens: string[] = [];
  const regex = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return tokens;
}

function makeFakeKeychain(initial?: Buffer) {
  const store = new Map<string, Buffer>();
  if (initial) store.set('gemini\0antigravity', Buffer.from(initial));
  const run = (args: string[], stdin?: string): SecurityRunResult => {
    const tokens = args[0] === '-i' && stdin ? tokenizeInteractiveLine(stdin.trim()) : args;
    const val = (flag: string) => tokens[tokens.indexOf(flag) + 1];
    if (tokens[0] === 'find-generic-password') {
      const blob = store.get(`${val('-s')}\0${val('-a')}`);
      if (!blob) {
        return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.from('not found') };
      }
      return { status: 0, stdout: Buffer.concat([blob, Buffer.from('\n')]), stderr: Buffer.alloc(0) };
    }
    if (tokens[0] === 'add-generic-password') {
      const data = tokens.includes('-X') ? Buffer.from(val('-X'), 'hex') : Buffer.from(val('-w'), 'utf8');
      store.set(`${val('-s')}\0${val('-a')}`, data);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported') };
  };
  return {
    run,
    current: () => store.get('gemini\0antigravity'),
    set: (b: Buffer | string) => store.set('gemini\0antigravity', Buffer.from(b)),
  };
}

function blobFor(email: string, opts: { tag?: string; expiry?: string; refresh?: boolean } = {}): Buffer {
  const inner = Buffer.from(
    JSON.stringify({
      token: {
        access_token: `ya29.${opts.tag || email.split('@')[0]}`,
        ...(opts.refresh === false ? {} : { refresh_token: `rt-${opts.tag || email.split('@')[0]}` }),
        token_type: 'Bearer',
        expiry: opts.expiry ?? '2099-12-31T00:00:00Z',
      },
      auth_method: 'consumer',
      id_token_email: email,
    }),
    'utf8',
  );
  return Buffer.from(`go-keyring-base64:${inner.toString('base64')}`, 'utf8');
}

describe('Phase 1 + Phase 2: Lease Lock, Bucketed Cooldowns, Health, Failover & MCP', () => {
  const tempDirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpool-p12-'));
    tempDirs.push(dir);
    return dir;
  };

  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, enforces exclusivity, reclaims stale locks, waits, and releases agy.lock', async () => {
    const paths = resolvePaths(mkTemp());
    const h1 = await acquireAgyLease(paths, { alias: 'pro1', holder: 'agent-1', ttlMs: 30_000 });
    assert.equal(h1.lease.alias, 'pro1');
    assert.equal(readAgyLease(paths)?.stale, false);

    // Concurrent acquire without wait fails clearly
    await assert.rejects(
      () => acquireAgyLease(paths, { alias: 'pro2', holder: 'agent-2', ttlMs: 30_000, waitMs: 0 }),
      /đang được giữ bởi "agent-1"/,
    );

    // Wait-until-release succeeds once h1 releases
    setTimeout(() => h1.release(), 80);
    const h2 = await acquireAgyLease(paths, { alias: 'pro2', holder: 'agent-2', ttlMs: 30_000, waitMs: 1000, pollMs: 30 });
    assert.equal(h2.lease.alias, 'pro2');
    h2.release();
    assert.equal(readAgyLease(paths), null);

    // Dead PID lock is automatically detected as stale and reclaimed
    fs.writeFileSync(
      paths.agyLockPath,
      JSON.stringify({
        pid: 999_999,
        alias: 'ghost',
        holder: 'dead-agent',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    assert.equal(readAgyLease(paths, { isPidAlive: () => false })?.stale, true);
    const h3 = await acquireAgyLease(paths, {
      alias: 'pro3',
      holder: 'agent-3',
      isPidAlive: (pid) => pid === process.pid,
    });
    assert.equal(h3.lease.alias, 'pro3');
    assert.equal(releaseAgyLease(paths, { force: true }), true);
  });

  it('supports bucketed cooldowns, rotation policies (lru/round-robin/tier-first), and renewal alerts', () => {
    const paths = resolvePaths(mkTemp());
    const db = new PoolDB(paths);
    try {
      const a1 = db.createAccount({ alias: 'pro1', email: 'pro1@example.com', plan_tier: 'Google AI Pro', renewal_date: '2026-11-25' });
      const a2 = db.createAccount({ alias: 'ultra1', email: 'ultra1@example.com', plan_tier: 'Google AI Ultra', renewal_date: '2027-06-01' });
      const a3 = db.createAccount({ alias: 'pro2', email: 'pro2@example.com', plan_tier: 'Google AI Pro' });
      db.updateSessionStatus(a1.id, 'live');
      db.updateSessionStatus(a2.id, 'live');
      db.updateSessionStatus(a3.id, 'live');

      // Tier-first prefers Google AI Ultra
      assert.equal(db.pickNextReadyAccount({ policy: 'tier-first' })?.alias, 'ultra1');

      // Round-robin prefers lowest use_count
      db.setActiveAccount('ultra1'); // use_count=1
      db.setActiveAccount('pro1'); // use_count=1
      assert.equal(db.pickNextReadyAccount({ policy: 'round-robin' })?.alias, 'pro2');

      // Bucketed cooldown: cooldown 'claude' on ultra1 does NOT block 'flash'
      const futureIso = new Date(Date.now() + 3 * 3_600_000).toISOString();
      db.setBucketCooldown('ultra1', 'claude', futureIso, 'Claude limit');
      const ultraView = db.computeAccountView(db.getAccount('ultra1')!);
      assert.equal(ultraView.effective_state, 'ready'); // account-wide still ready!
      assert.equal(ultraView.bucket_cooldowns?.length, 1);
      assert.equal(ultraView.bucket_cooldowns?.[0].bucket, 'claude');

      assert.equal(db.pickNextReadyAccount({ policy: 'tier-first', bucket: 'claude' })?.alias, 'pro2');
      assert.equal(db.pickNextReadyAccount({ policy: 'tier-first', bucket: 'flash' })?.alias, 'ultra1');

      // Clear only 'claude' bucket restores ultra1 for 'claude'
      db.clearCooldown('ultra1', 'claude');
      assert.equal(db.pickNextReadyAccount({ policy: 'tier-first', bucket: 'claude' })?.alias, 'ultra1');

      // Renewal alerts within 7 days of 2026-11-22
      const alerts = db.getRenewalAlerts(7, new Date('2026-11-22T00:00:00Z'));
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].alias, 'pro1');
      assert.equal(alerts[0].days_left, 3);
    } finally {
      db.close();
    }
  });

  it('parses quota errors, reset durations, timestamps, and model buckets accurately', () => {
    const now = new Date('2026-11-22T10:00:00Z');

    const r1 = parseQuotaError('Error 429 RESOURCE_EXHAUSTED: claude-opus quota resets in 3h 30m', 5, now);
    assert.equal(r1.isQuotaError, true);
    assert.equal(r1.cooldownHours, 3.5);
    assert.equal(r1.detectedBucket, 'opus');

    const r2 = parseQuotaError('Quota exceeded for gemini-2.5-pro. Reset at 2026-11-22T12:00:00Z', 5, now);
    assert.equal(r2.isQuotaError, true);
    assert.equal(r2.cooldownHours, 2);
    assert.equal(r2.detectedBucket, 'pro');

    const r3 = parseQuotaError('Rate limit reached. Retry-After: 1800', 5, now);
    assert.equal(r3.isQuotaError, true);
    assert.equal(r3.cooldownHours, 0.5);

    const r4 = parseQuotaError('SyntaxError: unexpected token', 5, now);
    assert.equal(r4.isQuotaError, false);
  });

  it('auto-failovers agy execution across pool accounts when quota is hit and inspects health', async () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeFakeKeychain(blobFor('a1@example.com'));
    const agyDeps = { osHome, securityRun: kc.run, listClients: () => [] };
    const db = new PoolDB(paths);

    try {
      const a1 = db.createAccount({ alias: 'a1', email: 'a1@example.com', renewal_date: '2026-11-24' });
      const a2 = db.createAccount({ alias: 'a2', email: 'a2@example.com' });
      const a3 = db.createAccount({ alias: 'a3', email: 'a3@example.com' }); // no agy snapshot!
      db.updateSessionStatus(a1.id, 'live');
      db.updateSessionStatus(a2.id, 'live');
      db.updateSessionStatus(a3.id, 'live');

      captureAgySession(paths, a1, agyDeps);
      kc.set(blobFor('a2@example.com', { expiry: '2020-01-01T00:00:00Z' })); // expired access token, valid RT
      captureAgySession(paths, a2, agyDeps);
      db.setActiveAccount('a1');

      // Inspect health
      const health = inspectAgyHealth(
        paths,
        db.listAccounts(),
        db.getRenewalAlerts(7, new Date('2026-11-22T00:00:00Z')),
        agyDeps,
      );
      assert.equal(health.summary.healthy, 1);
      assert.equal(health.summary.needs_refresh, 1);
      assert.equal(health.summary.missing_snapshot, 1);
      assert.equal(health.summary.renewal_alerts, 1);
      assert.equal(listCapturedAliases(paths).size, 2);

      // Run with auto-failover: attempt 1 on a1 hits 429 for claude -> rotates to a2 -> succeeds!
      let calls = 0;
      const runRes = await runAgyWithFailover({
        db,
        paths,
        agyArgs: ['-p', 'hello'],
        bucket: 'auto',
        maxRetries: 3,
        mirrorStdio: false,
        agyDeps,
        processRunner: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'Error 429 RESOURCE_EXHAUSTED: claude quota resets in 2h 0m',
            };
          }
          return { exitCode: 0, stdout: 'OK from a2', stderr: '' };
        },
      });

      assert.equal(runRes.ok, true);
      assert.equal(runRes.usedAlias, 'a2');
      assert.equal(runRes.attempts, 2);
      assert.equal(runRes.rotations.length, 1);
      assert.equal(runRes.rotations[0].fromAlias, 'a1');
      assert.equal(runRes.rotations[0].toAlias, 'a2');
      assert.equal(runRes.rotations[0].bucket, 'claude');
      assert.equal(runRes.rotations[0].cooldownHours, 2);
      // Lock released after run
      assert.equal(readAgyLease(paths), null);
      // a1 now has a 'claude' bucket cooldown
      const a1View = db.computeAccountView(db.getAccount('a1')!);
      assert.equal(a1View.bucket_cooldowns?.[0].bucket, 'claude');
    } finally {
      db.close();
    }
  });

  it('handles full MCP JSON-RPC lifecycle (initialize, tools/list, acquire, report_quota, health, run)', async () => {
    const osHome = mkTemp();
    const paths = resolvePaths(mkTemp());
    const kc = makeFakeKeychain(blobFor('m1@example.com'));
    const agyDeps = { osHome, securityRun: kc.run, listClients: () => [] };

    const db = new PoolDB(paths);
    const m1 = db.createAccount({ alias: 'm1', email: 'm1@example.com' });
    const m2 = db.createAccount({ alias: 'm2', email: 'm2@example.com' });
    db.updateSessionStatus(m1.id, 'live');
    db.updateSessionStatus(m2.id, 'live');
    captureAgySession(paths, m1, agyDeps);
    kc.set(blobFor('m2@example.com'));
    captureAgySession(paths, m2, agyDeps);
    db.close();

    const handle = createMcpHandler({
      paths,
      agyDeps,
      notifyDaemon: false,
      processRunner: async () => ({ exitCode: 0, stdout: 'mcp-ok', stderr: '' }),
    });

    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal((init?.result as { serverInfo: { name: string } }).serverInfo.name, 'google-one-pool');

    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list?.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 8);

    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await handle({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } });
      const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
      return JSON.parse(text) as Record<string, unknown>;
    };

    const acq = await callTool('agy_acquire', { holder: 'test-agent' });
    assert.equal(acq.ok, true);
    assert.equal(acq.alias, 'm1');
    assert.equal(readAgyLease(paths)?.holder, 'test-agent');

    const rel = await callTool('agy_release');
    assert.equal(rel.released, true);

    const rep = await callTool('agy_report_quota', {
      alias: 'm1',
      error_text: '429 quota exceeded, resets in 4h',
      bucket: 'pro',
      rotate: true,
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.cooldown_hours, 4);
    assert.equal(rep.next_alias, 'm2');
    assert.equal(rep.agy_activated, true);

    const health = await callTool('agy_health');
    assert.equal(health.ok, true);
    assert.equal((health.summary as { healthy: number }).healthy, 2);

    const runRes = await callTool('agy_run', { args: ['--version'] });
    assert.equal(runRes.ok, true);
    assert.equal(runRes.stdout, 'mcp-ok');
  });

  it('exposes /api/agy/health, /api/agy/lease, /api/sync, and bucketed cooldowns over Daemon HTTP API', async () => {
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

    const authHeaders = { Authorization: `Bearer ${srv.authToken}` };

    try {
      db.createAccount({ alias: 'api1', email: 'api1@example.com' });

      const cdPost = await fetch(`${base}/api/accounts/api1/cooldown`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: 2, bucket: 'claude', reason: 'test' }),
      });
      assert.equal(cdPost.status, 200);
      const cdJson = (await cdPost.json()) as { account: { bucket_cooldowns: Array<{ bucket: string }> } };
      assert.equal(cdJson.account.bucket_cooldowns[0].bucket, 'claude');

      const healthRes = await fetch(`${base}/api/agy/health`, { headers: authHeaders });
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { ok: boolean; summary: { missing_snapshot: number } };
      assert.equal(healthJson.ok, true);
      assert.equal(healthJson.summary.missing_snapshot, 1);

      const leaseRes = await fetch(`${base}/api/agy/lease`, { headers: authHeaders });
      assert.equal(leaseRes.status, 200);

      const syncRes = await fetch(`${base}/api/sync`, { method: 'POST', headers: authHeaders });
      assert.equal(syncRes.status, 200);

      const cdDel = await fetch(`${base}/api/accounts/api1/cooldown?bucket=claude`, { method: 'DELETE', headers: authHeaders });
      assert.equal(cdDel.status, 200);
      const cdDelJson = (await cdDel.json()) as { account: { bucket_cooldowns: unknown[] } };
      assert.equal(cdDelJson.account.bucket_cooldowns.length, 0);
    } finally {
      keepalive.stop();
      await srv.stop();
      db.close();
    }
  });
});
