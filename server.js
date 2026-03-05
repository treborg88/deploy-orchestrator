// =============================================================================
// Deploy Orchestrator — Express Server.
// =============================================================================
// Serves the wizard UI and handles deployment pipeline execution.
// Streams live terminal output to the browser via WebSocket.
//
// Usage:
//   npm start          → http://localhost:3456
//   npm run dev         → same, with --watch auto-reload
// =============================================================================

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import crypto from 'crypto';

// — Execution engine imports
import { runTerraform } from './lib/terraform.js';
import { runAnsible } from './lib/ansible.js';
import { testSSH, getSystemInfo, wipeServer, backupDatabase, restoreDatabase, composeUp, composeDown, composeRestart, refreshDocker, refreshNative, pm2Restart, pm2Stop, nginxReload, collectServerDiagnostics } from './lib/ssh.js';
import { getTroubleshoot } from './lib/troubleshoot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const PORT = 3456;

// — WebSocket server for live terminal streaming
const wss = new WebSocketServer({ server });

// — Track active WebSocket clients
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

// — Broadcast message to all connected clients
function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// — Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// — Path to the parent project's IaC files
const PROJECT_ROOT = resolve(__dirname, '..');

// — Deployments storage file
const DEPLOYMENTS_FILE = join(__dirname, 'deployments.json');

// — Ensure data directory exists
if (!existsSync(join(__dirname, 'data'))) {
  mkdirSync(join(__dirname, 'data'), { recursive: true });
}

// =============================================================================
// API: Provider form schemas — tells the UI what fields to render
// =============================================================================
app.get('/api/providers', (_req, res) => {
  res.json({
    // — Cloud providers for Terraform tab
    terraform: [
      {
        id: 'oci',
        name: 'Oracle Cloud',
        description: 'ARM64 Always Free tier (1-4 OCPU, 6-24GB RAM)',
        // Path to existing TF files relative to project root
        tfDir: 'terraform/oci',
        fields: [
          { key: 'tenancy_ocid', label: 'Tenancy OCID', required: true, type: 'text', help: 'OCI Console → Profile → Tenancy → OCID' },
          { key: 'user_ocid', label: 'User OCID', required: true, type: 'text', help: 'OCI Console → Profile → User → OCID' },
          { key: 'compartment_ocid', label: 'Compartment OCID', required: true, type: 'text', help: 'OCI Console → Identity → Compartments → OCID (use tenancy OCID for root)' },
          { key: 'fingerprint', label: 'API Key Fingerprint', required: true, type: 'text', help: 'OCI Console → Profile → API Keys → Fingerprint (aa:bb:cc:...)' },
          { key: 'private_key_path', label: 'API Private Key (.pem)', required: true, type: 'filepath', help: 'Path to your OCI API private key file (~/.oci/oci_api_key.pem)' },
          { key: 'region', label: 'Region', required: true, type: 'select', options: ['sa-saopaulo-1', 'us-ashburn-1', 'us-phoenix-1', 'eu-frankfurt-1', 'ap-tokyo-1'], help: 'Choose the region closest to your users' },
          { key: 'instance_name', label: 'Instance Name', required: false, type: 'text', default: 'techstore-prod', help: 'Display name for the VM' },
          { key: 'instance_ocpus', label: 'OCPUs', required: false, type: 'number', default: 1, help: 'Free tier: up to 4 total across all A1 instances' },
          { key: 'instance_memory_gb', label: 'Memory (GB)', required: false, type: 'number', default: 6, help: 'Free tier: up to 24 GB total, 6 GB per OCPU' },
          { key: 'boot_volume_gb', label: 'Boot Volume (GB)', required: false, type: 'number', default: 50, help: 'Free tier: up to 200 GB total' },
          { key: 'ssh_pub_key_path', label: 'SSH Public Key', required: true, type: 'filepath', help: 'Path to your SSH public key file (~/.ssh/id_rsa.pub)' }
        ]
      },
      {
        id: 'gcloud',
        name: 'Google Cloud',
        description: 'e2-micro Free tier (0.25 vCPU, 1GB RAM)',
        tfDir: 'terraform',
        fields: [
          { key: 'project_id', label: 'Project ID', required: true, type: 'text', help: 'GCP Console → Project selector → Project ID' },
          { key: 'region', label: 'Region', required: false, type: 'select', options: ['us-central1', 'us-east1', 'us-west1'], default: 'us-central1', help: 'Free tier regions only' },
          { key: 'zone', label: 'Zone', required: false, type: 'text', default: 'us-central1-a', help: 'Specific zone within the region' },
          { key: 'vm_name', label: 'VM Name', required: false, type: 'text', default: 'techstore-prod', help: 'Display name for the VM instance' },
          { key: 'machine_type', label: 'Machine Type', required: false, type: 'text', default: 'e2-micro', help: 'e2-micro = free tier eligible' },
          { key: 'disk_size_gb', label: 'Disk Size (GB)', required: false, type: 'number', default: 30, help: 'Free tier: up to 30GB standard disk' },
          { key: 'ssh_user', label: 'SSH User', required: false, type: 'text', default: 'ubuntu', help: 'Username for SSH access' },
          { key: 'ssh_pub_key_path', label: 'SSH Public Key', required: true, type: 'filepath', help: 'Path to your SSH public key file' }
        ]
      }
    ],
    // — Deploy modes for Ansible tab
    deployModes: [
      {
        id: 'docker',
        name: 'Full Docker',
        description: 'Everything in containers (PostgreSQL + Express + Nginx). Self-contained, easiest setup.',
        playbook: 'ansible/playbook-docker.yml',
        recommended: true
      },
      {
        id: 'native-supabase',
        name: 'Native + Supabase',
        description: 'App on PM2, Supabase as remote DB. Lightest on server resources. Current production setup.',
        playbook: 'ansible/playbook.yml',
        recommended: false
      }
    ]
  });
});

// =============================================================================
// API: Validate cloud credentials (dry-run terraform plan)
// =============================================================================
app.post('/api/validate/terraform', async (req, res) => {
  const { provider, values } = req.body;
  try {
    const result = await runTerraform('validate', provider, values, PROJECT_ROOT, broadcast);
    res.json({ success: result.success, message: result.message });
  } catch (err) {
    // — Check troubleshoot DB for known error patterns
    const fix = getTroubleshoot(err.message || String(err));
    res.status(400).json({ success: false, message: err.message, troubleshoot: fix });
  }
});

// =============================================================================
// API: Test SSH connection to existing server
// =============================================================================
app.post('/api/validate/ssh', async (req, res) => {
  const { host, user, keyPath } = req.body;
  try {
    const result = await testSSH(host, user, keyPath, broadcast);
    res.json({ success: true, message: result.message, os: result.os });
  } catch (err) {
    const fix = getTroubleshoot(err.message || String(err));
    res.status(400).json({ success: false, message: err.message, troubleshoot: fix });
  }
});

// =============================================================================
// API: Register (save) an existing server without deploying
// =============================================================================
app.post('/api/servers/register', async (req, res) => {
  const { host, user, keyPath, label, cloudProvider } = req.body;
  if (!host || !user || !keyPath) {
    return res.status(400).json({ success: false, message: 'host, user, and keyPath are required' });
  }

  try {
    // — Test SSH connectivity before saving
    const sshResult = await testSSH(host, user, keyPath, broadcast);

    // — Save as a registered deployment (not yet deployed)
    const deployment = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      infraSource: 'existing',
      provider: 'existing',
      serverIP: host,
      sshUser: user,
      sshKeyPath: keyPath,
      deployMode: null,      // — Not deployed yet
      domain: label || host,
      cloudProvider: cloudProvider || '',  // — Cloud provider label (Oracle Cloud, Google Cloud, etc.)
      status: 'registered',  // — registered (saved) vs active (deployed)
      os: sshResult.os || 'Linux'
    };
    saveDeployment(deployment);

    res.json({ success: true, deployment, message: `Server saved: ${host} (${sshResult.os})` });
  } catch (err) {
    const fix = getTroubleshoot(err.message || String(err));
    res.status(400).json({ success: false, message: err.message, troubleshoot: fix });
  }
});

// =============================================================================
// API: Check status of a saved deployment (SSH + HTTP health)
// =============================================================================
app.post('/api/deployments/:id/status', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  const result = { ssh: false, http: false, os: null, httpStatus: null, systemInfo: null };

  // — Test SSH
  try {
    const sshResult = await testSSH(deployment.serverIP, deployment.sshUser, deployment.sshKeyPath, broadcast);
    result.ssh = true;
    result.os = sshResult.os;
  } catch { /* SSH failed */ }

  // — Gather detailed system info via SSH (if SSH succeeded)
  if (result.ssh) {
    try {
      result.systemInfo = await getSystemInfo(
        deployment.serverIP, deployment.sshUser, deployment.sshKeyPath
      );
    } catch { /* system info gathering failed, non-critical */ }
  }

  // — Test HTTP (try regardless — server may have app running)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`http://${deployment.serverIP}/`, { signal: controller.signal });
    clearTimeout(timeout);
    result.http = resp.ok || resp.status === 301 || resp.status === 302;
    result.httpStatus = resp.status;
  } catch { /* HTTP failed */ }

  // — Update last-checked timestamp + system snapshot in storage
  deployment.lastChecked = new Date().toISOString();
  deployment.lastStatus = result.ssh ? (result.http ? 'online' : 'ssh-only') : 'offline';
  if (result.systemInfo) deployment.systemInfo = result.systemInfo;
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));

  res.json({ success: true, ...result, lastStatus: deployment.lastStatus });
});

// =============================================================================
// API: Generate JWT secret
// =============================================================================
app.get('/api/generate/secret', (_req, res) => {
  res.json({ secret: crypto.randomBytes(32).toString('hex') });
});

// =============================================================================
// API: Full deploy pipeline execution
// =============================================================================
app.post('/api/deploy', async (req, res) => {
  const {
    infraSource,     // 'terraform' | 'existing'
    provider,        // 'oci' | 'gcloud' (only if infraSource='terraform')
    providerValues,  // terraform form values
    existingServer,  // { host, user, keyPath } (only if infraSource='existing')
    deployMode,      // 'docker' | 'native-supabase'
    appConfig        // { jwtSecret, domain, pgUser, pgPassword, ... }
  } = req.body;

  // — Respond immediately, pipeline runs async via WebSocket
  res.json({ started: true, message: 'Pipeline started. Watch WebSocket for progress.' });

  let serverIP = '';
  let sshUser = 'ubuntu';
  let sshKeyPath = '';

  try {
    // ── Step 1: Infrastructure (Terraform or existing) ────
    if (infraSource === 'terraform') {
      broadcast('step', { step: 1, status: 'running', label: 'Terraform Apply — Creating VM' });
      const tfResult = await runTerraform('apply', provider, providerValues, PROJECT_ROOT, broadcast);
      serverIP = tfResult.ip;
      sshUser = providerValues.ssh_user || 'ubuntu';
      sshKeyPath = providerValues.ssh_pub_key_path?.replace('.pub', '') || '';
      broadcast('step', { step: 1, status: 'completed', label: 'Terraform Apply', detail: `VM created: ${serverIP}` });
    } else {
      // — Existing server, skip Terraform
      serverIP = existingServer.host;
      sshUser = existingServer.user;
      sshKeyPath = existingServer.keyPath;
      broadcast('step', { step: 1, status: 'skipped', label: 'Terraform (skipped — existing server)' });
    }

    // ── Step 2: Test SSH connectivity ─────────────────────
    broadcast('step', { step: 2, status: 'running', label: 'Testing SSH Connection' });
    await testSSH(serverIP, sshUser, sshKeyPath, broadcast);
    broadcast('step', { step: 2, status: 'completed', label: 'SSH Connection', detail: 'Connected successfully' });

    // ── Step 3: Run Ansible deploy ────────────────────────
    broadcast('step', { step: 3, status: 'running', label: 'Ansible Deploy — Provisioning Server' });
    const ansibleResult = await runAnsible(
      deployMode,
      serverIP,
      sshUser,
      sshKeyPath,
      appConfig,
      PROJECT_ROOT,
      broadcast
    );
    broadcast('step', { step: 3, status: 'completed', label: 'Ansible Deploy', detail: ansibleResult.message });

    // ── Step 4: Health check ──────────────────────────────
    broadcast('step', { step: 4, status: 'running', label: 'Health Check' });
    // — Simple HTTP check via curl on local machine
    const healthResult = await healthCheck(serverIP, broadcast);
    broadcast('step', { step: 4, status: 'completed', label: 'Health Check', detail: healthResult });

    // ── Save deployment ───────────────────────────────────
    const deployment = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      infraSource,
      provider: provider || 'existing',
      serverIP,
      sshUser,
      sshKeyPath,
      deployMode,
      domain: appConfig.domain || serverIP,
      sslMode: appConfig.sslMode || 'flexible',
      cloudProvider: existingServer?.cloudProvider || appConfig.cloudProvider || '',
      status: 'active'
    };
    saveDeployment(deployment);

    broadcast('complete', {
      success: true,
      deployment,
      nextSteps: [
        `Point your domain DNS to ${serverIP}`,
        'Change admin password (admin@techstore.com / admin123)',
        'Configure SSL in Admin → Settings → Domain',
        'Configure email in Admin → Settings → Email',
        'Add products in Admin → Products → Add'
      ]
    });

  } catch (err) {
    const fix = getTroubleshoot(err.message || String(err));
    let diagnostics = null;

    // — Pull real VM state when deployment fails after server details are known
    if (serverIP && sshUser && sshKeyPath) {
      try {
        broadcast('step', { step: 5, status: 'running', label: 'Collecting VM Diagnostics' });
        diagnostics = await collectServerDiagnostics(serverIP, sshUser, sshKeyPath, broadcast);
        broadcast('step', { step: 5, status: 'completed', label: 'VM Diagnostics', detail: 'Collected from remote server' });
      } catch (diagErr) {
        broadcast('log', { text: `Diagnostics collection failed: ${diagErr.message}`, source: 'diagnostics' });
      }
    }

    broadcast('error', {
      message: err.message,
      troubleshoot: fix,
      retryable: true,
      diagnostics
    });
  }
});

// =============================================================================
// API: Manage saved deployments
// =============================================================================
app.get('/api/deployments', (_req, res) => {
  res.json(loadDeployments());
});

app.delete('/api/deployments/:id', (req, res) => {
  const deployments = loadDeployments().filter(d => d.id !== req.params.id);
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
  res.json({ success: true });
});

// =============================================================================
// API: Redeploy (Ansible only, on existing saved deployment)
// =============================================================================
app.post('/api/redeploy/:id', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  res.json({ started: true });

  try {
    broadcast('step', { step: 1, status: 'skipped', label: 'Terraform (reusing existing server)' });
    broadcast('step', { step: 2, status: 'running', label: 'Testing SSH Connection' });
    await testSSH(deployment.serverIP, deployment.sshUser, deployment.sshKeyPath, broadcast);
    broadcast('step', { step: 2, status: 'completed', label: 'SSH Connection', detail: 'OK' });

    broadcast('step', { step: 3, status: 'running', label: 'Ansible Redeploy' });
    await runAnsible(
      deployment.deployMode,
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      req.body.appConfig || {},
      PROJECT_ROOT,
      broadcast
    );
    broadcast('step', { step: 3, status: 'completed', label: 'Ansible Redeploy', detail: 'Code updated' });

    broadcast('step', { step: 4, status: 'running', label: 'Health Check' });
    const hc = await healthCheck(deployment.serverIP, broadcast);
    broadcast('step', { step: 4, status: 'completed', label: 'Health Check', detail: hc });

    broadcast('complete', { success: true, deployment });
  } catch (err) {
    const fix = getTroubleshoot(err.message || String(err));
    let diagnostics = null;
    try {
      broadcast('step', { step: 5, status: 'running', label: 'Collecting VM Diagnostics' });
      diagnostics = await collectServerDiagnostics(
        deployment.serverIP,
        deployment.sshUser,
        deployment.sshKeyPath,
        broadcast
      );
      broadcast('step', { step: 5, status: 'completed', label: 'VM Diagnostics', detail: 'Collected from remote server' });
    } catch (diagErr) {
      broadcast('log', { text: `Diagnostics collection failed: ${diagErr.message}`, source: 'diagnostics' });
    }

    broadcast('error', { message: err.message, troubleshoot: fix, diagnostics });
  }
});

// =============================================================================
// API: Pull live VM diagnostics on demand (for deployment debugging)
// =============================================================================
app.post('/api/deployments/:id/diagnostics', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ success: false, message: 'Deployment not found' });

  try {
    const diagnostics = await collectServerDiagnostics(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      broadcast
    );

    deployment.lastDiagnostics = {
      at: new Date().toISOString(),
      parsed: diagnostics.parsed
    };
    writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));

    res.json({ success: true, diagnostics });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// API: Destroy infrastructure (Terraform destroy)
// =============================================================================
app.post('/api/destroy/:id', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });
  if (deployment.infraSource !== 'terraform') {
    return res.status(400).json({ message: 'Cannot destroy — server was not created by Terraform' });
  }

  res.json({ started: true });
  try {
    broadcast('step', { step: 1, status: 'running', label: 'Terraform Destroy' });
    await runTerraform('destroy', deployment.provider, {}, PROJECT_ROOT, broadcast);
    broadcast('step', { step: 1, status: 'completed', label: 'Infrastructure destroyed' });

    // — Remove from saved deployments
    const updated = deployments.filter(d => d.id !== deployment.id);
    writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(updated, null, 2));

    broadcast('complete', { success: true, message: 'Infrastructure destroyed' });
  } catch (err) {
    broadcast('error', { message: err.message });
  }
});

// =============================================================================
// API: Wipe Server — Stop all services and remove app data (keeps the VM)
// =============================================================================
app.post('/api/wipe/:id', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  res.json({ started: true });
  try {
    broadcast('step', { step: 1, status: 'running', label: 'Wiping Server' });
    broadcast('log', { text: `Wiping ${deployment.serverIP}...` });

    await wipeServer(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      deployment.deployMode,
      broadcast
    );

    broadcast('step', { step: 1, status: 'completed', label: 'Server wiped' });

    // — Update deployment status to 'registered' (VM exists but app removed)
    deployment.status = 'registered';
    deployment.deployMode = null;
    deployment.lastStatus = 'ssh-only';
    deployment.systemInfo = null;
    deployment.lastChecked = new Date().toISOString();
    writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));

    broadcast('complete', { success: true, message: 'Server wiped. VM is clean and ready for a fresh deploy.' });
  } catch (err) {
    broadcast('error', { message: err.message });
  }
});

// =============================================================================
// API: Backup Database — Download a pg_dump from the server
// =============================================================================
app.post('/api/backup/:id', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  // — Ensure backups directory exists
  const backupDir = join(__dirname, 'data', 'backups');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  try {
    broadcast('log', { text: `Starting database backup for ${deployment.serverIP}...` });

    const result = await backupDatabase(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      deployment.deployMode,
      backupDir,
      broadcast
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// — List available backups for a deployment
app.get('/api/backups/:id', (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  const backupDir = join(__dirname, 'data', 'backups');
  if (!existsSync(backupDir)) return res.json([]);

  // — Find backups matching this server IP (.sql + .tar.gz image archives)
  try {
    const allFiles = readdirSync(backupDir).filter(f => f.includes(deployment.serverIP));
    const sqlFiles = allFiles.filter(f => f.endsWith('.sql'));
    const imgFiles = allFiles.filter(f => f.endsWith('.tar.gz'));

    // — Group: each SQL backup may have a matching images archive
    const backups = sqlFiles.map(f => {
      const st = statSync(join(backupDir, f));
      // — Derive matching images file name (backup → images, same timestamp)
      const imgName = f.replace('techstore-backup-', 'techstore-images-').replace('.sql', '.tar.gz');
      const hasImages = imgFiles.includes(imgName);
      const imgSize = hasImages ? statSync(join(backupDir, imgName)).size : 0;
      return { file: f, size: st.size, date: st.mtime, hasImages, imagesFile: hasImages ? imgName : null, imagesSize: imgSize };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(backups);
  } catch {
    res.json([]);
  }
});

// =============================================================================
// API: Restore Database — Upload a .sql backup and restore it on the server
// =============================================================================

// — Restore from an existing local backup file
app.post('/api/restore/:id', async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  const { backupFile } = req.body;
  if (!backupFile) return res.status(400).json({ message: 'backupFile is required' });

  const backupDir = join(__dirname, 'data', 'backups');
  const localFile = join(backupDir, backupFile);

  // — Security: prevent path traversal
  if (!localFile.startsWith(backupDir) || !existsSync(localFile)) {
    return res.status(400).json({ message: 'Invalid or missing backup file' });
  }

  try {
    broadcast('log', { text: `Starting database restore on ${deployment.serverIP}...` });
    const result = await restoreDatabase(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      deployment.deployMode,
      localFile,
      broadcast
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// — Upload a .sql file then restore it on the server
app.post('/api/restore/:id/upload', express.raw({ type: 'application/octet-stream', limit: '200mb' }), async (req, res) => {
  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  // — Get filename from header or generate one
  const origName = req.headers['x-filename'] || `uploaded-${Date.now()}.sql`;
  const safeName = origName.replace(/[^a-zA-Z0-9._-]/g, '_');

  const backupDir = join(__dirname, 'data', 'backups');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const localFile = join(backupDir, safeName);

  // — Write the uploaded SQL content to disk
  writeFileSync(localFile, req.body);
  broadcast('log', { text: `Uploaded ${safeName} (${req.body.length} bytes)` });

  try {
    broadcast('log', { text: `Starting database restore on ${deployment.serverIP}...` });
    const result = await restoreDatabase(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      deployment.deployMode,
      localFile,
      broadcast
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// =============================================================================
// API: Quick Actions — Lightweight server management (no full deploy)
// =============================================================================

// Map of action name → { fn, dockerOnly, nativeOnly, label }
const QUICK_ACTIONS = {
  'compose-up':      { fn: composeUp,       dockerOnly: true,  label: 'Docker Compose Up' },
  'compose-down':    { fn: composeDown,      dockerOnly: true,  label: 'Docker Compose Down' },
  'compose-restart': { fn: composeRestart,   dockerOnly: true,  label: 'Docker Compose Restart' },
  'refresh-docker':  { fn: refreshDocker,    dockerOnly: true,  label: 'Git Pull & Rebuild (Docker)' },
  'refresh-native':  { fn: refreshNative,    nativeOnly: true,  label: 'Git Pull & Restart (Native)' },
  'pm2-restart':     { fn: pm2Restart,       nativeOnly: true,  label: 'PM2 Restart All' },
  'pm2-stop':        { fn: pm2Stop,          nativeOnly: true,  label: 'PM2 Stop All' },
  'nginx-reload':    { fn: nginxReload,                         label: 'Nginx Reload' },
};

app.post('/api/quick-action/:id', async (req, res) => {
  const { action } = req.body;
  const actionDef = QUICK_ACTIONS[action];
  if (!actionDef) return res.status(400).json({ message: `Unknown action: ${action}` });

  const deployments = loadDeployments();
  const deployment = deployments.find(d => d.id === req.params.id);
  if (!deployment) return res.status(404).json({ message: 'Deployment not found' });

  // Validate deploy mode compatibility
  const isDocker = deployment.deployMode === 'docker';
  if (actionDef.dockerOnly && !isDocker) return res.status(400).json({ message: `${actionDef.label} requires Docker mode` });
  if (actionDef.nativeOnly && isDocker) return res.status(400).json({ message: `${actionDef.label} requires Native mode` });

  res.json({ started: true });
  try {
    broadcast('step', { step: 1, status: 'running', label: actionDef.label });
    broadcast('log', { text: `Running: ${actionDef.label}` });

    const result = await actionDef.fn(
      deployment.serverIP,
      deployment.sshUser,
      deployment.sshKeyPath,
      broadcast
    );

    broadcast('step', { step: 1, status: 'completed', label: actionDef.label });
    broadcast('complete', { success: true, message: `${actionDef.label} completed.` });
  } catch (err) {
    broadcast('error', { message: err.message });
  }
});

// =============================================================================

// — Health check: try to reach the server on port 80 via HTTP
async function healthCheck(ip, _broadcast) {
  const maxRetries = 10;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`http://${ip}/`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok || resp.status === 302 || resp.status === 301) {
        return `Server responding (HTTP ${resp.status})`;
      }
    } catch {
      // — Wait and retry
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return 'Server not responding yet — may need a few more minutes';
}

// — Load saved deployments from JSON file
function loadDeployments() {
  if (!existsSync(DEPLOYMENTS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// — Save a deployment to the JSON file (upserts by serverIP to prevent duplicates)
function saveDeployment(deployment) {
  const deployments = loadDeployments();
  const idx = deployments.findIndex(d => d.serverIP === deployment.serverIP);
  if (idx !== -1) {
    // — Merge: preserve fields from existing entry that aren't in the new one
    const existing = deployments[idx];
    deployment.id = existing.id;
    deployment.createdAt = existing.createdAt;
    if (!deployment.cloudProvider) deployment.cloudProvider = existing.cloudProvider || '';
    if (!deployment.sslMode) deployment.sslMode = existing.sslMode || 'flexible';
    if (!deployment.systemInfo) deployment.systemInfo = existing.systemInfo;
    if (!deployment.lastChecked) deployment.lastChecked = existing.lastChecked;
    if (!deployment.lastStatus) deployment.lastStatus = existing.lastStatus;
    deployments[idx] = deployment;
  } else {
    deployments.push(deployment);
  }
  writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
}

// =============================================================================
// Start server
// =============================================================================
server.listen(PORT, () => {
  console.log(`\n  Deploy Orchestrator running at http://localhost:${PORT}\n`);
});
