// =============================================================================
// Ansible Execution Engine
// =============================================================================
// Runs the existing Ansible playbooks from the parent project.
// Generates a temporary inventory file with the target server details.
// =============================================================================

import { spawn, execSync } from 'child_process';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

// — Detect Windows (Ansible must run through WSL)
const isWindows = process.platform === 'win32';

/**
 * Convert a Windows path to a WSL-compatible path.
 * e.g. C:\Users\Robert\... → /mnt/c/Users/Robert/...
 */
function toWSLPath(winPath) {
  if (!isWindows || !winPath) return winPath;
  // — Expand ~ to Windows home first (WSL ~ points to /home/user, not /mnt/c/Users/...)
  if (winPath.startsWith('~')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    winPath = winPath.replace(/^~/, home);
  }
  // — Already a POSIX absolute path, return as-is
  if (winPath.startsWith('/')) return winPath;
  // — Convert drive letter + backslashes
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

/**
 * Run an Ansible playbook for deployment.
 *
 * @param {'docker'|'native-supabase'} mode - Deploy mode
 * @param {string} serverIP - Target server IP address
 * @param {string} sshUser - SSH username
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {Object} appConfig - Application config (JWT, DB, email, etc.)
 * @param {string} projectRoot - Absolute path to the parent project root
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, message: string}>}
 */
/**
 * Copy an SSH key into WSL's native filesystem with chmod 600.
 * Files on /mnt/c/ appear as 0777 to WSL — SSH rejects them.
 * Returns the WSL-native temp path (e.g. /tmp/ansible_key_xxx).
 */
function copyKeyToWSL(winKeyPath) {
  const wslSrc = toWSLPath(winKeyPath);
  const keyName = basename(winKeyPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const wslDest = `/tmp/ansible_${keyName}_${Date.now()}`;
  // — Copy + set permissions in a single WSL call
  execSync(`wsl -- sh -c "cp '${wslSrc}' '${wslDest}' && chmod 600 '${wslDest}'"`, { stdio: 'pipe' });
  return wslDest;
}

/** Clean up the temporary WSL key copy */
function cleanupWSLKey(wslPath) {
  try { execSync(`wsl -- rm -f '${wslPath}'`, { stdio: 'pipe' }); } catch { /* ignore */ }
}

export async function runAnsible(mode, serverIP, sshUser, sshKeyPath, appConfig, projectRoot, broadcast) {
  // — Map deploy mode to existing playbook
  const playbookMap = {
    'docker': 'ansible/playbook-docker.yml',
    'native-supabase': 'ansible/playbook.yml'
  };

  const playbookPath = join(projectRoot, playbookMap[mode]);
  if (!existsSync(playbookPath)) {
    throw new Error(`Playbook not found: ${playbookPath}`);
  }

  // — Generate temporary inventory for this deployment
  const tempDir = join(projectRoot, 'deploy-orchestrator', 'data');
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

  // — On Windows, copy SSH key into WSL native FS (chmod 600)
  // Files on /mnt/c/ appear as 0777 — SSH rejects them.
  let wslKeyPath = null;
  let effectiveKeyPath = sshKeyPath;
  if (isWindows) {
    try {
      wslKeyPath = copyKeyToWSL(sshKeyPath);
      effectiveKeyPath = wslKeyPath; // — Use WSL-native path directly
      broadcast('log', { text: `SSH key copied to WSL with secure permissions` });
    } catch (err) {
      broadcast('log', { text: `Warning: could not copy key to WSL (${err.message}), using /mnt/ path` });
    }
  }

  const inventoryPath = join(tempDir, 'inventory.tmp.yml');
  const inventoryContent = generateInventory(mode, serverIP, sshUser, effectiveKeyPath, appConfig);
  writeFileSync(inventoryPath, inventoryContent);
  broadcast('log', { text: `Generated temporary inventory for ${serverIP}` });

  try {
    // — Build ansible-playbook command args
    // On Windows, paths must be converted to WSL /mnt/... format
    const invArg = isWindows ? toWSLPath(inventoryPath) : inventoryPath;
    const pbArg  = isWindows ? toWSLPath(playbookPath) : playbookPath;

    const args = [
      '-i', invArg,
      pbArg,
      '--limit', 'deploy-target',
      '-v'  // verbose for better output
    ];

    // — Pass app config as extra vars if provided
    const extraVars = buildExtraVars(mode, appConfig);
    if (extraVars) {
      args.push('--extra-vars', extraVars);
    }

    broadcast('log', { text: `$ ansible-playbook ${args.join(' ')}` });

    // — Execute ansible-playbook (via WSL on Windows)
    await execAnsible(args, projectRoot, broadcast);

    return { success: true, message: 'Deployment completed successfully' };

  } finally {
    // — Clean up temporary files
    if (existsSync(inventoryPath)) unlinkSync(inventoryPath);
    if (wslKeyPath) cleanupWSLKey(wslKeyPath);
  }
}

/**
 * Execute ansible-playbook, streaming output via broadcast.
 * On Windows, runs through WSL since Ansible doesn't support Windows natively.
 */
function execAnsible(args, cwd, broadcast) {
  return new Promise((resolve, reject) => {
    // — On Windows: spawn wsl with ansible-playbook as argument
    const command = isWindows ? 'wsl' : 'ansible-playbook';
    const spawnArgs = isWindows ? ['--', 'ansible-playbook', ...args] : args;
    const spawnCwd = isWindows ? undefined : cwd; // WSL resolves paths itself

    const proc = spawn(command, spawnArgs, {
      cwd: spawnCwd,
      shell: false,
      env: {
        ...process.env,
        ANSIBLE_FORCE_COLOR: '0',         // no ANSI colors in WebSocket output
        ANSIBLE_HOST_KEY_CHECKING: 'False' // skip host key prompt for new servers
      }
    });

    let stdout = '';
    let stderr = '';
    let lastTask = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;

      // — Parse TASK names for step-level progress
      const taskMatch = text.match(/TASK \[(.+?)\]/);
      if (taskMatch && taskMatch[1] !== lastTask) {
        lastTask = taskMatch[1];
        broadcast('ansible-task', { task: lastTask, status: 'running' });
      }

      // — Detect ok/changed/failed per task
      if (text.includes('ok:') || text.includes('changed:')) {
        broadcast('ansible-task', { task: lastTask, status: 'ok' });
      }

      broadcast('log', { text, source: 'ansible' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      broadcast('log', { text, source: 'ansible' });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Ansible playbook failed (exit code ${code}): ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ansible-playbook: ${err.message}. Is Ansible installed?`));
    });
  });
}

/**
 * Generate an Ansible inventory YAML for a single target server.
 * Maps to the groups expected by the existing playbooks.
 */
function generateInventory(mode, serverIP, sshUser, sshKeyPath, appConfig) {
  // — Docker playbook expects hosts under "docker" group
  // — Native playbook expects hosts under "all"
  const group = mode === 'docker' ? 'docker' : 'production';

  const hostVars = [
    `          ansible_host: ${serverIP}`,
    `          ansible_user: ${sshUser}`,
    `          ansible_ssh_private_key_file: ${isWindows ? toWSLPath(sshKeyPath) : sshKeyPath}`,
    `          app_branch: main`
  ];

  // — Add domain if provided
  if (appConfig.domain) {
    hostVars.push(`          domain: ${appConfig.domain}`);
  }

  // — Add SSL mode
  hostVars.push(`          ssl_mode: ${appConfig.sslMode || 'flexible'}`);

  // — Add Docker-specific vars
  if (mode === 'docker' && appConfig.pgPassword) {
    hostVars.push(`          docker_pg_password: ${appConfig.pgPassword}`);
  }

  return `# Auto-generated by Deploy Orchestrator — temporary file
all:
  vars:
    ansible_python_interpreter: /usr/bin/python3
  children:
    ${group}:
      hosts:
        deploy-target:
${hostVars.join('\n')}
`;
}

/**
 * Build extra-vars JSON string from app config.
 */
function buildExtraVars(mode, appConfig) {
  const vars = {};

  // — Common vars
  if (appConfig.jwtSecret) vars.jwt_secret = appConfig.jwtSecret;
  if (appConfig.domain) vars.domain = appConfig.domain;
  if (appConfig.emailUser) vars.email_user = appConfig.emailUser;
  if (appConfig.emailPass) vars.email_pass = appConfig.emailPass;
  if (appConfig.stripeKey) vars.stripe_secret_key = appConfig.stripeKey;
  if (appConfig.corsOrigin) vars.cors_origin = appConfig.corsOrigin;

  // — Docker-specific vars
  if (mode === 'docker') {
    if (appConfig.pgUser) vars.docker_pg_user = appConfig.pgUser;
    if (appConfig.pgPassword) vars.docker_pg_password = appConfig.pgPassword;
    if (appConfig.pgDb) vars.docker_pg_db = appConfig.pgDb;
  }

  // — Supabase-specific vars
  if (mode === 'native-supabase') {
    if (appConfig.supabaseUrl) vars.supabase_url = appConfig.supabaseUrl;
    if (appConfig.supabaseKey) vars.supabase_key = appConfig.supabaseKey;
  }

  // — SSL cert files (convert Windows paths to WSL for Ansible copy module)
  if (appConfig.sslCertFile) vars.cf_origin_cert_file = toWSLPath(appConfig.sslCertFile);
  if (appConfig.sslKeyFile) vars.cf_origin_key_file = toWSLPath(appConfig.sslKeyFile);

  if (Object.keys(vars).length === 0) return null;
  return JSON.stringify(vars);
}
