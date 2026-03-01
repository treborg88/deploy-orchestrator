// =============================================================================
// SSH Test Module
// =============================================================================
// Quick SSH connectivity test before running Ansible.
// Uses ssh command directly (no extra dependencies).
// Works on both Windows (OpenSSH built-in) and Unix.
// =============================================================================

import { spawn } from 'child_process';
import { resolve as resolvePath, join } from 'path';
import { existsSync } from 'fs';

/**
 * Normalize a key path: resolve ~, strip surrounding quotes,
 * and handle common user mistakes (pasting full ssh command).
 *
 * @param {string} raw - User-provided key path
 * @returns {string} - Cleaned absolute path
 */
function normalizeKeyPath(raw) {
  let p = raw.trim().replace(/^["']|["']$/g, '');

  // — User pasted full ssh command: extract the key path after -i
  const dashI = p.match(/-i\s+["']?([^\s"']+)["']?/);
  if (dashI) p = dashI[1];

  const home = process.env.USERPROFILE || process.env.HOME || '';

  // — Expand ~ to user home directory
  if (p.startsWith('~')) {
    p = p.replace(/^~/, home);
  }

  // — If path is relative (no drive letter / no leading slash), try home dir first
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
  if (!isAbsolute && home) {
    const fromHome = resolvePath(home, p);
    if (existsSync(fromHome)) return fromHome;
  }

  return resolvePath(p);
}

/**
 * Test SSH connectivity to a remote server.
 *
 * @param {string} host - Server IP or hostname
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH private key
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, message: string, os?: string}>}
 */
export async function testSSH(host, user, keyPath, broadcast) {
  return new Promise((resolve, reject) => {
    // — Clean up key path (handles pasted ssh commands, ~, quotes)
    const cleanKey = normalizeKeyPath(keyPath);

    // — Validate key file exists locally before attempting connection
    if (!existsSync(cleanKey)) {
      return reject(new Error(
        `SSH key file not found: ${cleanKey}\n` +
        `Provide the path to the .key/.pem file, not the full ssh command.`
      ));
    }

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-o', 'BatchMode=yes',
      '-i', cleanKey,
      `${user}@${host}`,
      // — Remote command: detect OS + confirm connection
      // — No pipes here — avoids Windows cmd.exe interpreting them locally
      'head -3 /etc/os-release && echo SSH_OK'
    ];

    broadcast('log', { text: `$ ssh -i ${cleanKey} ${user}@${host} (testing...)` });

    // — shell: false so Windows cmd.exe doesn't intercept the remote command
    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      broadcast('log', { text: data.toString(), source: 'ssh' });
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      // — SSH warnings are normal (host key, etc.), only broadcast non-empty
      const text = data.toString().trim();
      if (text) broadcast('log', { text, source: 'ssh' });
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('SSH_OK')) {
        // — Parse OS info from /etc/os-release
        const nameMatch = stdout.match(/PRETTY_NAME="(.+?)"/);
        const os = nameMatch ? nameMatch[1] : 'Linux';
        resolve({ success: true, message: `Connected to ${host}`, os });
      } else {
        reject(new Error(
          `SSH connection failed (exit code ${code}): ${stderr || 'Connection refused or timed out'}`
        ));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ssh: ${err.message}`));
    });
  });
}

/**
 * Gather detailed system info from a remote server via SSH.
 * Returns CPU, RAM, disk, uptime, load, running services, etc.
 *
 * @param {string} host - Server IP or hostname
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH private key
 * @returns {Promise<object>} - Parsed system info object
 */
export async function getSystemInfo(host, user, keyPath) {
  return new Promise((resolve, reject) => {
    const cleanKey = normalizeKeyPath(keyPath);
    if (!existsSync(cleanKey)) {
      return reject(new Error(`SSH key not found: ${cleanKey}`));
    }

    // — Single compound remote command, semicolon-separated
    // — Each section outputs a tagged line for easy parsing
    const remoteCmd = [
      // OS
      'echo "##OS##" && head -5 /etc/os-release',
      // Hostname
      'echo "##HOSTNAME##" && hostname',
      // Uptime
      'echo "##UPTIME##" && uptime -p 2>/dev/null || uptime',
      // CPU info
      'echo "##CPU##" && nproc && lscpu 2>/dev/null | grep -E "Model name|Architecture" || cat /proc/cpuinfo | grep "model name" | head -1',
      // RAM (free -m output)
      'echo "##RAM##" && free -m | grep -E "Mem|Swap"',
      // Disk usage (root + data partitions)
      'echo "##DISK##" && df -h --output=source,size,used,avail,pcent,target 2>/dev/null | grep -E "^/dev|^Filesystem" || df -h | grep -E "^/dev|^Filesystem"',
      // Load average
      'echo "##LOAD##" && cat /proc/loadavg',
      // Kernel
      'echo "##KERNEL##" && uname -r',
      // Docker running? (optional)
      'echo "##DOCKER##" && (docker ps --format "{{.Names}}: {{.Status}}" 2>/dev/null || echo "not installed")',
      // PM2 running? (optional)
      'echo "##PM2##" && (pm2 jlist 2>/dev/null || echo "not installed")',
      // Nginx running? (optional)
      'echo "##NGINX##" && (systemctl is-active nginx 2>/dev/null || echo "not installed")',
      // Network interfaces
      'echo "##NET##" && ip -4 addr show scope global 2>/dev/null | grep inet || hostname -I',
      // End marker
      'echo "##END##"'
    ].join(' && ');

    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-o', 'BatchMode=yes',
      '-i', cleanKey,
      `${user}@${host}`,
      remoteCmd
    ];

    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`SSH failed (exit ${code}): ${stderr}`));
      }
      resolve(parseSystemInfo(stdout));
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ssh: ${err.message}`));
    });
  });
}

/**
 * Parse the tagged output from getSystemInfo remote command.
 * @param {string} raw - Raw stdout from SSH
 * @returns {object} - Structured system info
 */
function parseSystemInfo(raw) {
  const info = {};

  // — Extract sections between ##TAG## markers (supports digits in tags like PM2)
  const section = (tag) => {
    const re = new RegExp(`##${tag}##\\s*([\\s\\S]*?)(?=##[A-Z0-9_]+##|$)`);
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };

  // — OS
  const osRaw = section('OS');
  const pretty = osRaw.match(/PRETTY_NAME="(.+?)"/);
  const idMatch = osRaw.match(/^ID=(.+)$/m);
  info.os = pretty ? pretty[1] : 'Linux';
  info.distro = idMatch ? idMatch[1].replace(/"/g, '') : '';

  // — Hostname
  info.hostname = section('HOSTNAME') || '';

  // — Uptime
  info.uptime = section('UPTIME') || '';

  // — CPU
  const cpuRaw = section('CPU');
  const cpuLines = cpuRaw.split('\n').map(l => l.trim()).filter(Boolean);
  info.cpuCores = parseInt(cpuLines[0]) || 0;
  const modelLine = cpuLines.find(l => /model name|Model name/i.test(l));
  info.cpuModel = modelLine ? modelLine.replace(/.*:\s*/, '') : '';
  const archLine = cpuLines.find(l => /Architecture/i.test(l));
  info.cpuArch = archLine ? archLine.replace(/.*:\s*/, '') : '';

  // — RAM (parse free -m output)
  const ramRaw = section('RAM');
  const memLine = ramRaw.split('\n').find(l => /^Mem/i.test(l));
  if (memLine) {
    const parts = memLine.split(/\s+/);
    info.ramTotalMB = parseInt(parts[1]) || 0;
    info.ramUsedMB = parseInt(parts[2]) || 0;
    info.ramFreeMB = parseInt(parts[3]) || 0;
    info.ramPercent = info.ramTotalMB
      ? Math.round((info.ramUsedMB / info.ramTotalMB) * 100)
      : 0;
  }
  const swapLine = ramRaw.split('\n').find(l => /^Swap/i.test(l));
  if (swapLine) {
    const parts = swapLine.split(/\s+/);
    info.swapTotalMB = parseInt(parts[1]) || 0;
    info.swapUsedMB = parseInt(parts[2]) || 0;
  }

  // — Disk (parse df -h output)
  const diskRaw = section('DISK');
  info.disks = diskRaw.split('\n')
    .filter(l => l.startsWith('/dev'))
    .map(l => {
      const p = l.split(/\s+/);
      return {
        device: p[0] || '',
        size: p[1] || '',
        used: p[2] || '',
        avail: p[3] || '',
        percent: p[4] || '',
        mount: p[5] || ''
      };
    });

  // — Load average
  const loadRaw = section('LOAD');
  const loadParts = loadRaw.split(/\s+/);
  info.load1 = parseFloat(loadParts[0]) || 0;
  info.load5 = parseFloat(loadParts[1]) || 0;
  info.load15 = parseFloat(loadParts[2]) || 0;

  // — Kernel
  info.kernel = section('KERNEL') || '';

  // — Docker
  const dockerRaw = section('DOCKER');
  info.docker = dockerRaw === 'not installed'
    ? null
    : dockerRaw.split('\n').filter(Boolean).map(l => l.trim());

  // — PM2
  const pm2Raw = section('PM2');
  if (pm2Raw === 'not installed') {
    info.pm2 = null;
  } else {
    try {
      const procs = JSON.parse(pm2Raw);
      info.pm2 = procs.map(p => ({
        name: p.name,
        status: p.pm2_env?.status || 'unknown',
        cpu: p.monit?.cpu || 0,
        memory: p.monit?.memory || 0
      }));
    } catch {
      info.pm2 = pm2Raw.trim() ? [{ name: pm2Raw.trim(), status: 'unknown' }] : null;
    }
  }

  // — Nginx
  const nginxRaw = section('NGINX');
  info.nginx = nginxRaw === 'not installed' ? null : nginxRaw;

  // — Network IPs
  const netRaw = section('NET');
  info.ips = netRaw.match(/\d+\.\d+\.\d+\.\d+/g) || [];

  return info;
}

// =============================================================================
// Wipe Server — Stop all services and remove app data
// =============================================================================

/**
 * Wipe a remote server: stop services, remove app files, cleanup Docker.
 * Streams progress via broadcast. Does NOT delete the VM itself.
 *
 * @param {string} host - Server IP
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH key
 * @param {'docker'|'native-supabase'|null} deployMode - How the app was deployed
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function wipeServer(host, user, keyPath, deployMode, broadcast) {
  const cleanKey = normalizeKeyPath(keyPath);
  if (!existsSync(cleanKey)) {
    throw new Error(`SSH key not found: ${cleanKey}`);
  }

  // — Build the remote wipe script based on deploy mode
  const steps = [
    'echo "=== WIPE STARTED ==="',
    // Stop Docker containers (if docker mode)
    'echo ">> Stopping Docker..."',
    'cd /home/ubuntu/TechStore && sudo docker compose down --volumes --remove-orphans 2>/dev/null || true',
    'sudo docker system prune -af 2>/dev/null || true',
    // Stop PM2 (if native mode)
    'echo ">> Stopping PM2..."',
    'pm2 kill 2>/dev/null || true',
    'pm2 unstartup 2>/dev/null || true',
    // Stop Nginx
    'echo ">> Stopping Nginx..."',
    'sudo systemctl stop nginx 2>/dev/null || true',
    'sudo rm -f /etc/nginx/sites-enabled/techstore* 2>/dev/null || true',
    // Remove app files
    'echo ">> Removing app files..."',
    'sudo rm -rf /home/ubuntu/TechStore',
    // Remove leftover downloads/artifacts in home dir
    'echo ">> Cleaning home directory..."',
    'rm -f /home/ubuntu/cloudflared.deb /home/ubuntu/*.deb /home/ubuntu/*.tar.gz /home/ubuntu/*.log 2>/dev/null || true',
    // Remove SSL certs
    'echo ">> Removing SSL certs..."',
    'sudo rm -rf /etc/ssl/cloudflare',
    // Remove swap (optional, reclaim disk)
    'echo ">> Removing swap..."',
    'sudo swapoff /swapfile 2>/dev/null || true',
    'sudo rm -f /swapfile',
    'sudo sed -i "/swapfile/d" /etc/fstab 2>/dev/null || true',
    // Verify
    'echo "=== WIPE COMPLETE ==="',
    'echo "App: $(ls /home/ubuntu/TechStore 2>/dev/null && echo EXISTS || echo REMOVED)"',
    'echo "Docker: $(docker ps -q 2>/dev/null | wc -l || echo 0) containers"',
    'echo "PM2: $(pm2 list 2>/dev/null | grep -c online || echo 0) processes"',
    'echo "Nginx: $(systemctl is-active nginx 2>/dev/null || echo stopped)"'
  ];

  const remoteCmd = steps.join(' && ');

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', cleanKey,
    `${user}@${host}`,
    remoteCmd
  ];

  broadcast('log', { text: `$ Wiping server ${host}...` });

  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      broadcast('log', { text, source: 'wipe' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      stderr += text;
      if (text) broadcast('log', { text, source: 'wipe' });
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('WIPE COMPLETE')) {
        resolve({ success: true, message: 'Server wiped successfully' });
      } else {
        reject(new Error(`Wipe failed (exit ${code}): ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to start ssh: ${err.message}`)));
  });
}

// =============================================================================
// Backup Database — Download a pg_dump from the remote server
// =============================================================================

/**
 * Backup the PostgreSQL database from a remote server via SSH.
 * For Docker mode: runs pg_dump inside the techstore-db container.
 * For native/supabase: skips (Supabase manages its own backups).
 * Downloads the SQL dump via SCP to a local backups directory.
 *
 * @param {string} host - Server IP
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH key
 * @param {'docker'|'native-supabase'|null} deployMode - How the app was deployed
 * @param {string} backupDir - Local directory to save the backup
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, file: string, message: string}>}
 */
export async function backupDatabase(host, user, keyPath, deployMode, backupDir, broadcast) {
  const cleanKey = normalizeKeyPath(keyPath);
  if (!existsSync(cleanKey)) {
    throw new Error(`SSH key not found: ${cleanKey}`);
  }

  // — Generate timestamped filename
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const remoteFile = `/tmp/techstore-backup-${ts}.sql`;
  const localFile = join(backupDir, `techstore-backup-${host}-${ts}.sql`);

  // — Build pg_dump command depending on deploy mode
  let dumpCmd;
  if (deployMode === 'docker') {
    // Docker: exec into the DB container
    dumpCmd = `docker exec techstore-db pg_dump -U techstore techstore > ${remoteFile}`;
  } else {
    // Native: try pg_dump via DATABASE_URL from .env, or direct
    dumpCmd = [
      'source /home/ubuntu/TechStore/backend/.env 2>/dev/null || true',
      `pg_dump "\${DATABASE_URL:-postgresql://techstore:techstore@localhost:5432/techstore}" > ${remoteFile} 2>/dev/null`,
      `|| echo "DB_DUMP_FAILED"`
    ].join(' && ');
  }

  broadcast('log', { text: `$ Creating database backup on ${host}...` });

  // Step 1: Run pg_dump on the remote server
  await new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-i', cleanKey,
      `${user}@${host}`,
      `${dumpCmd} && wc -c < ${remoteFile} && echo DUMP_OK`
    ];

    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      broadcast('log', { text: data.toString(), source: 'backup' });
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const text = data.toString().trim();
      if (text) broadcast('log', { text, source: 'backup' });
    });
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('DUMP_OK')) {
        resolve();
      } else {
        reject(new Error(`pg_dump failed (exit ${code}): ${stderr || stdout}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`SSH failed: ${err.message}`)));
  });

  // Step 2: Download the dump via SCP
  broadcast('log', { text: `$ Downloading backup to ${localFile}...` });

  await new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-i', cleanKey,
      `${user}@${host}:${remoteFile}`,
      localFile
    ];

    const proc = spawn('scp', args, { shell: false, windowsHide: true });
    let stderr = '';

    proc.stdout.on('data', (data) => {
      broadcast('log', { text: data.toString(), source: 'backup' });
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP download failed (exit ${code}): ${stderr}`));
    });
    proc.on('error', (err) => reject(new Error(`SCP failed: ${err.message}`)));
  });

  // Step 3: Backup uploaded images (Docker only)
  let imagesFile = null;
  if (deployMode === 'docker') {
    broadcast('log', { text: `$ Backing up uploaded images...` });
    const remoteImgTar = `/tmp/techstore-images-${ts}.tar.gz`;
    imagesFile = join(backupDir, `techstore-images-${host}-${ts}.tar.gz`);

    // — Tar the uploads directory from inside the Docker container (named volume)
    const tarOk = await new Promise((resolve) => {
      const tarCmd = [
        `if docker exec techstore-backend test -d /app/backend/uploads/products`,
        `&& [ "$(docker exec techstore-backend ls -A /app/backend/uploads/products 2>/dev/null)" ]; then`,
        `  docker exec -u 0 techstore-backend tar -czf /tmp/images-archive.tar.gz -C /app/backend/uploads products`,
        `  && docker cp techstore-backend:/tmp/images-archive.tar.gz ${remoteImgTar}`,
        `  && docker exec -u 0 techstore-backend rm -f /tmp/images-archive.tar.gz`,
        `  && echo IMAGES_OK;`,
        `else echo NO_IMAGES; fi`
      ].join(' ');

      const proc = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ConnectTimeout=15',
        '-i', cleanKey,
        `${user}@${host}`,
        tarCmd
      ], { shell: false, windowsHide: true });
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => {
        const t = d.toString().trim();
        if (t) broadcast('log', { text: t, source: 'backup' });
      });
      proc.on('close', () => resolve(stdout));
      proc.on('error', () => resolve(''));
    });

    if (tarOk.includes('IMAGES_OK')) {
      // — Download the tar.gz via SCP
      broadcast('log', { text: `$ Downloading images archive...` });
      await new Promise((resolve, reject) => {
        const proc = spawn('scp', [
          '-o', 'StrictHostKeyChecking=no',
          '-i', cleanKey,
          `${user}@${host}:${remoteImgTar}`,
          imagesFile
        ], { shell: false, windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`SCP images download failed (exit ${code}): ${stderr}`));
        });
        proc.on('error', (err) => reject(new Error(`SCP failed: ${err.message}`)));
      });

      // — Cleanup remote tar
      spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-i', cleanKey,
        `${user}@${host}`, `rm -f ${remoteImgTar}`
      ], { shell: false, windowsHide: true });

      broadcast('log', { text: `✅ Images backed up: ${imagesFile}` });
    } else {
      broadcast('log', { text: `ℹ️ No uploaded images found — skipping image backup.` });
      imagesFile = null;
    }
  }

  // Step 4: Cleanup remote SQL temp file
  spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-i', cleanKey,
    `${user}@${host}`,
    `rm -f ${remoteFile}`
  ], { shell: false, windowsHide: true });

  const msg = imagesFile
    ? `Backup saved: ${localFile} + ${imagesFile}`
    : `Backup saved: ${localFile}`;
  broadcast('log', { text: `✅ ${msg}` });
  return { success: true, file: localFile, imagesFile, message: msg };
}

/**
 * Restore a PostgreSQL database from a local .sql backup file.
 * Uploads the file via SCP, drops schema, restores via psql.
 *
 * @param {string} host - Server IP
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH key
 * @param {'docker'|'native-supabase'|null} deployMode - How the app was deployed
 * @param {string} localFile - Absolute path to the local .sql backup file
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function restoreDatabase(host, user, keyPath, deployMode, localFile, broadcast) {
  const cleanKey = normalizeKeyPath(keyPath);
  if (!existsSync(cleanKey)) {
    throw new Error(`SSH key not found: ${cleanKey}`);
  }
  if (!existsSync(localFile)) {
    throw new Error(`Backup file not found: ${localFile}`);
  }

  const remoteFile = '/tmp/techstore-restore.sql';

  // Step 1: Upload .sql file to the server via SCP
  broadcast('log', { text: `$ Uploading backup to ${host}:${remoteFile}...` });

  await new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-i', cleanKey,
      localFile,
      `${user}@${host}:${remoteFile}`
    ];

    const proc = spawn('scp', args, { shell: false, windowsHide: true });
    let stderr = '';

    proc.stdout.on('data', (data) => {
      broadcast('log', { text: data.toString(), source: 'restore' });
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SCP upload failed (exit ${code}): ${stderr}`));
    });
    proc.on('error', (err) => reject(new Error(`SCP failed: ${err.message}`)));
  });

  // Step 2: Drop existing schema and restore from backup on the server
  broadcast('log', { text: `$ Restoring database on ${host}...` });

  let restoreCmd;
  if (deployMode === 'docker') {
    // Docker: pipe the SQL file into the container's psql
    restoreCmd = [
      `docker exec -i techstore-db psql -U techstore -d techstore -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`,
      `docker exec -i techstore-db psql -U techstore -d techstore < ${remoteFile}`,
      `echo RESTORE_OK`
    ].join(' && ');
  } else {
    // Native: use DATABASE_URL from .env or default credentials
    restoreCmd = [
      'source /home/ubuntu/TechStore/backend/.env 2>/dev/null || true',
      'DB_URL="${DATABASE_URL:-postgresql://techstore:techstore@localhost:5432/techstore}"',
      'psql "$DB_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"',
      `psql "$DB_URL" < ${remoteFile}`,
      'echo RESTORE_OK'
    ].join(' && ');
  }

  await new Promise((resolve, reject) => {
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=15',
      '-i', cleanKey,
      `${user}@${host}`,
      restoreCmd
    ];

    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      broadcast('log', { text: data.toString(), source: 'restore' });
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const text = data.toString().trim();
      if (text) broadcast('log', { text, source: 'restore' });
    });
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('RESTORE_OK')) {
        resolve();
      } else {
        reject(new Error(`DB restore failed (exit ${code}): ${stderr || stdout}`));
      }
    });
    proc.on('error', (err) => reject(new Error(`SSH failed: ${err.message}`)));
  });

  // Step 3: Restore uploaded images if a matching images archive exists (Docker only)
  if (deployMode === 'docker') {
    // — Derive images archive path from the .sql file name
    const imgArchive = localFile.replace(/techstore-backup-/, 'techstore-images-').replace(/\.sql$/, '.tar.gz');

    if (existsSync(imgArchive)) {
      broadcast('log', { text: `$ Restoring uploaded images from ${imgArchive}...` });
      const remoteImgTar = '/tmp/techstore-images-restore.tar.gz';

      // — Upload tar.gz to server
      await new Promise((resolve, reject) => {
        const proc = spawn('scp', [
          '-o', 'StrictHostKeyChecking=no',
          '-i', cleanKey,
          imgArchive,
          `${user}@${host}:${remoteImgTar}`
        ], { shell: false, windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`SCP images upload failed (exit ${code}): ${stderr}`));
        });
        proc.on('error', (err) => reject(new Error(`SCP failed: ${err.message}`)));
      });

      // — Extract into the Docker container's uploads volume and fix ownership
      await new Promise((resolve, reject) => {
        const extractCmd = [
          `docker cp ${remoteImgTar} techstore-backend:/tmp/images-restore.tar.gz`,
          `docker exec techstore-backend mkdir -p /app/backend/uploads`,
          `docker exec -u 0 techstore-backend tar -xzf /tmp/images-restore.tar.gz -C /app/backend/uploads`,
          `docker exec -u 0 techstore-backend chown -R app:app /app/backend/uploads`,
          `docker exec -u 0 techstore-backend rm -f /tmp/images-restore.tar.gz`,
          `rm -f ${remoteImgTar}`,
          `echo IMAGES_RESTORED`
        ].join(' && ');

        const proc = spawn('ssh', [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ConnectTimeout=15',
          '-i', cleanKey,
          `${user}@${host}`,
          extractCmd
        ], { shell: false, windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => {
          stdout += d.toString();
          broadcast('log', { text: d.toString(), source: 'restore' });
        });
        proc.stderr.on('data', (d) => {
          stderr += d.toString();
          const t = d.toString().trim();
          if (t) broadcast('log', { text: t, source: 'restore' });
        });
        proc.on('close', (code) => {
          if (code === 0 && stdout.includes('IMAGES_RESTORED')) resolve();
          else reject(new Error(`Image restore failed (exit ${code}): ${stderr || stdout}`));
        });
        proc.on('error', (err) => reject(new Error(`SSH failed: ${err.message}`)));
      });

      broadcast('log', { text: `✅ Images restored on ${host}` });
    } else {
      broadcast('log', { text: `ℹ️ No matching images archive found — skipping image restore.` });
    }
  }

  // Step 4: Cleanup remote SQL temp file
  spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-i', cleanKey,
    `${user}@${host}`,
    `rm -f ${remoteFile}`
  ], { shell: false, windowsHide: true });

  broadcast('log', { text: `✅ Database restored successfully on ${host}` });
  return { success: true, message: `Database restored on ${host} from ${localFile}` };
}

// =============================================================================
// Quick Actions — Lightweight server management commands via SSH
// =============================================================================

/**
 * Run a quick SSH command on a remote server and stream output.
 * Shared helper for all quick-action functions.
 *
 * @param {string} host - Server IP
 * @param {string} user - SSH username
 * @param {string} keyPath - Path to SSH key
 * @param {string} remoteCmd - Command to run remotely
 * @param {Function} broadcast - WebSocket broadcast function
 * @param {string} label - Human-readable action name for logs
 * @returns {Promise<{success: boolean, output: string}>}
 */
function runQuickSSH(host, user, keyPath, remoteCmd, broadcast, label) {
  const cleanKey = normalizeKeyPath(keyPath);
  if (!existsSync(cleanKey)) {
    throw new Error(`SSH key not found: ${cleanKey}`);
  }

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', cleanKey,
    `${user}@${host}`,
    remoteCmd
  ];

  broadcast('log', { text: `$ ${label} on ${host}...` });

  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      broadcast('log', { text, source: 'quick-action' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      stderr += text;
      if (text) broadcast('log', { text, source: 'quick-action' });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        reject(new Error(`${label} failed (exit ${code}): ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to start ssh: ${err.message}`)));
  });
}

/**
 * Docker Compose Up — Start containers (docker mode only).
 */
export async function composeUp(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'cd /home/ubuntu/TechStore && sudo docker compose up -d && echo "COMPOSE_UP_OK" && sudo docker compose ps',
    broadcast, 'Docker Compose Up'
  );
}

/**
 * Docker Compose Down — Stop containers (docker mode only).
 */
export async function composeDown(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'cd /home/ubuntu/TechStore && sudo docker compose down && echo "COMPOSE_DOWN_OK"',
    broadcast, 'Docker Compose Down'
  );
}

/**
 * Docker Compose Restart — Restart all containers (docker mode only).
 */
export async function composeRestart(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'cd /home/ubuntu/TechStore && sudo docker compose restart && echo "COMPOSE_RESTART_OK" && sudo docker compose ps',
    broadcast, 'Docker Compose Restart'
  );
}

/**
 * Git Pull & Rebuild — Pull latest code and rebuild containers (docker mode).
 */
export async function refreshDocker(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'cd /home/ubuntu/TechStore && git pull && sudo docker compose build --no-cache && sudo docker compose up -d && echo "REFRESH_OK" && sudo docker compose ps',
    broadcast, 'Git Pull & Rebuild (Docker)'
  );
}

/**
 * Git Pull & Restart PM2 — Pull latest code, install deps, rebuild frontend, restart PM2 (native mode).
 */
export async function refreshNative(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'cd /home/ubuntu/TechStore && git pull && npm install && cd backend && npm install && cd ../frontend && npm install && npm run build && cd .. && pm2 restart all && echo "REFRESH_OK" && pm2 list',
    broadcast, 'Git Pull & Restart PM2 (Native)'
  );
}

/**
 * PM2 Restart All — Restart PM2 processes (native mode only).
 */
export async function pm2Restart(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'pm2 restart all && echo "PM2_RESTART_OK" && pm2 list',
    broadcast, 'PM2 Restart All'
  );
}

/**
 * PM2 Stop All — Stop PM2 processes (native mode only).
 */
export async function pm2Stop(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'pm2 stop all && echo "PM2_STOP_OK" && pm2 list',
    broadcast, 'PM2 Stop All'
  );
}

/**
 * Nginx Reload — Reload Nginx config without downtime.
 */
export async function nginxReload(host, user, keyPath, broadcast) {
  return runQuickSSH(host, user, keyPath,
    'sudo nginx -t && sudo systemctl reload nginx && echo "NGINX_RELOAD_OK" && systemctl status nginx --no-pager -l | head -5',
    broadcast, 'Nginx Reload'
  );
}
