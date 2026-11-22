import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PoolPaths } from './config.ts';

export const LAUNCH_AGENT_LABEL = 'local.googleonepool.daemon';
const LAUNCHCTL_BIN = '/bin/launchctl';

export function getLaunchAgentPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function generateLaunchAgentPlist(options: {
  nodeBinary: string;
  cliEntryPath: string;
  paths: PoolPaths;
  port?: number;
}): string {
  const envEntries: Array<[string, string]> = [
    ['PATH', process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'],
    ['GPOOL_HOME', options.paths.homeDir],
  ];
  if (options.port) {
    envEntries.push(['GPOOL_PORT', String(options.port)]);
  }

  const envXml = envEntries
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodeBinary)}</string>
    <string>${escapeXml(options.cliEntryPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.paths.logPath)}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(options: {
  nodeBinary: string;
  cliEntryPath: string;
  paths: PoolPaths;
  port?: number;
}): Promise<{ plistPath: string; loaded: boolean; message: string }> {
  if (process.platform !== 'darwin') {
    throw new Error('LaunchAgent chỉ hỗ trợ trên macOS.');
  }

  const plistPath = getLaunchAgentPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(options.paths.homeDir, { recursive: true, mode: 0o700 });

  const xml = generateLaunchAgentPlist(options);
  fs.writeFileSync(plistPath, xml, { encoding: 'utf8', mode: 0o644 });

  const uid = process.getuid ? process.getuid() : 501;
  const domain = `gui/${uid}`;

  // Attempt clean unload first in case an older service is active.
  await runLaunchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]);
  const res = await runLaunchctl(['bootstrap', domain, plistPath]);

  if (res.code === 0) {
    return {
      plistPath,
      loaded: true,
      message: `Đã cài đặt và bật LaunchAgent (${LAUNCH_AGENT_LABEL}) tại ${plistPath}`,
    };
  }

  return {
    plistPath,
    loaded: false,
    message: `Đã ghi file plist tại ${plistPath}, nhưng launchctl bootstrap trả mã ${res.code}: ${res.stderr || res.stdout}. Anh có thể chạy lại ngoài Terminal thường.`,
  };
}

export async function uninstallLaunchAgent(): Promise<{ plistPath: string; removed: boolean; message: string }> {
  const plistPath = getLaunchAgentPlistPath();
  const uid = process.getuid ? process.getuid() : 501;
  const domain = `gui/${uid}`;

  await runLaunchctl(['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`]);

  let removed = false;
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    removed = true;
  }

  return {
    plistPath,
    removed,
    message: removed
      ? `Đã gỡ LaunchAgent ${LAUNCH_AGENT_LABEL} và xóa ${plistPath}`
      : `Đã bootout ${LAUNCH_AGENT_LABEL} (file plist không tồn tại)`,
  };
}

export async function getLaunchAgentStatus(): Promise<{
  installed: boolean;
  running: boolean;
  plistPath: string;
  detail: string;
}> {
  const plistPath = getLaunchAgentPlistPath();
  const installed = fs.existsSync(plistPath);
  const uid = process.getuid ? process.getuid() : 501;
  const target = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
  const res = await runLaunchctl(['print', target]);
  return {
    installed,
    running: res.code === 0,
    plistPath,
    detail: res.code === 0 ? 'Đang chạy qua launchd' : res.stderr || 'Chưa nạp vào launchd',
  };
}

function runLaunchctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(LAUNCHCTL_BIN, args, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function escapeXml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
