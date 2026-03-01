// =============================================================================
// Troubleshoot Database
// =============================================================================
// Maps known error patterns to suggested fixes.
// Used by the wizard to display actionable help when a step fails.
// =============================================================================

// — Error pattern → suggested fix entries
const TROUBLESHOOT_DB = [
  // ── SSH Errors ───────────────────────────────────────────
  {
    patterns: ['port 22: Connection refused', 'ssh: connect to host', 'ssh_exchange_identification'],
    title: 'SSH Connection Refused',
    fixes: [
      'The server is not accepting SSH connections on port 22.',
      'Check that the server is running and SSH service is enabled.',
      'For OCI: verify port 22 is open in Security List (ingress rules).',
      'For GCP: verify the firewall rule allows TCP port 22.',
      'Wait 2-3 minutes — new VMs may take time to fully boot.'
    ]
  },
  {
    patterns: ['Connection timed out', 'connect timed out', 'Operation timed out'],
    title: 'SSH Connection Timeout',
    fixes: [
      'The server is unreachable — check that the IP address is correct.',
      'Verify the VM is in "Running" state in your cloud console.',
      'Check security group / firewall allows inbound TCP port 22.',
      'For OCI: Internet Gateway must be attached to the VCN.',
      'For GCP: check that the VM has an external IP assigned.'
    ]
  },
  {
    patterns: ['Permission denied', 'publickey', 'Authentication failed'],
    title: 'SSH Authentication Failed',
    fixes: [
      'The SSH key was rejected by the server.',
      'Verify the private key matches the public key configured on the server.',
      'Check file permissions: private key must be chmod 600.',
      'On Windows: right-click key file → Properties → Security → set read-only for your user.',
      'For OCI: the SSH key must be the one specified during instance creation.',
      'For GCP: the username in ssh-keys metadata must match the SSH user.'
    ]
  },
  {
    patterns: ['Host key verification failed'],
    title: 'Host Key Verification Failed',
    fixes: [
      'The server\'s host key has changed (common after VM recreation).',
      'Run: ssh-keygen -R <server-ip> to remove the old key.',
      'The orchestrator uses StrictHostKeyChecking=no, so this should be auto-handled.'
    ]
  },

  // ── Terraform Errors ─────────────────────────────────────
  {
    patterns: ['Could not resolve host: github.com', 'Could not resolve host'],
    title: 'DNS Resolution Failed',
    fixes: [
      'The VM cannot resolve DNS names — outbound internet may be blocked.',
      'For OCI: check that the Internet Gateway is enabled and route table has 0.0.0.0/0 rule.',
      'Try adding DNS: echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf',
      'Check security list egress rules allow all outbound traffic.'
    ]
  },
  {
    patterns: ['401', 'NotAuthenticated', 'AuthenticationError', 'InvalidCredentials'],
    title: 'Cloud Authentication Failed',
    fixes: [
      'Your cloud provider credentials are invalid or expired.',
      'For OCI: verify tenancy_ocid, user_ocid, fingerprint, and private key path.',
      'For GCP: ensure you have run "gcloud auth application-default login".',
      'Check that the API key has not been revoked in the cloud console.'
    ]
  },
  {
    patterns: ['Out of host capacity', 'Out of capacity', 'InternalError'],
    title: 'Cloud Capacity Issue (OCI-specific)',
    fixes: [
      'OCI ARM instances (A1.Flex) are often out of capacity in popular regions.',
      'Try a different availability domain or region.',
      'Common workaround: retry every few minutes — capacity fluctuates.',
      'Regions with better availability: us-ashburn-1, us-phoenix-1, eu-frankfurt-1.',
      'Consider using a smaller shape (1 OCPU + 6GB) if requesting more.'
    ]
  },
  {
    patterns: ['LimitExceeded', 'QuotaExceeded', 'ServiceLimitExceeded', 'vcpu quota', 'over quota'],
    title: 'Cloud Quota/Limit Exceeded',
    fixes: [
      'You have exceeded your cloud account limits.',
      'For OCI free tier: max 4 OCPUs and 24GB RAM total across all A1 instances.',
      'For GCP free tier: max 1 e2-micro per project in free tier regions.',
      'Delete existing unused instances before creating new ones.',
      'Check your account limits in the cloud console.'
    ]
  },
  {
    patterns: ['terraform: command not found', 'terraform: not found', 'terraform is not recognized'],
    title: 'Terraform Not Installed',
    fixes: [
      'Terraform CLI is not installed on this machine.',
      'Install from: https://developer.hashicorp.com/terraform/install',
      'On macOS: brew install terraform',
      'On Ubuntu: sudo apt install terraform',
      'On Windows: choco install terraform -or- download from HashiCorp website.'
    ]
  },

  // ── Specific Deployment Errors (checked first) ─────────
  // Order matters: specific patterns before generic ones
  {
    patterns: ['SSL mode is', 'no certificate found at', 'ssl certs missing'],
    title: 'SSL Certificate Not Found',
    fixes: [
      'SSL mode is set to full_strict but no certificate files exist on the server.',
      'Option A: Provide cert file paths in the wizard (SSL Cert File / SSL Key File fields).',
      'Option B: Set SSL mode to "flexible" if you don\'t need HTTPS yet.',
      'Option C: Manually copy certs to the server before deploying:',
      '  scp cert.pem ubuntu@<IP>:/etc/ssl/cloudflare/eonsclover.com.pem',
      '  scp cert.key ubuntu@<IP>:/etc/ssl/cloudflare/eonsclover.com.key'
    ]
  },
  {
    patterns: ['Proxy container not responding', 'Wait for proxy to respond', 'proxy_health'],
    title: 'Proxy Container Not Responding',
    fixes: [
      'The Nginx proxy container failed to start — likely a config error.',
      'If using SSL (full_strict): ensure certs are deployed at /etc/ssl/cloudflare/ on the server.',
      'Try setting SSL mode to "flexible" to rule out SSL issues.',
      'SSH into server and check: cd ~/TechStore && docker compose logs proxy',
      'Restart the proxy: docker compose restart proxy'
    ]
  },
  {
    patterns: ['nginx -t', 'nginx: configuration file', 'ssl_certificate'],
    title: 'Nginx Configuration Error',
    fixes: [
      'Nginx configuration test failed.',
      'If using SSL (full_strict): ensure SSL certificate files are deployed before Nginx config.',
      'For non-SSL setup: set ssl_mode to "flexible" to skip certificate configuration.',
      'SSH into server and check: sudo nginx -t for detailed error.',
      'Check that the certificate paths in nginx.conf exist: /etc/ssl/cloudflare/'
    ]
  },
  {
    patterns: ['npm ERR!', 'npm error', 'ERESOLVE'],
    title: 'NPM Install Failed',
    fixes: [
      'Node.js dependency installation failed on the server.',
      'The server may be running out of memory during npm install.',
      'Ensure swap is enabled (the playbook should handle this automatically).',
      'Try rerunning — npm install sometimes fails on first attempt with slow connections.',
      'Check disk space: servers with <5GB free may fail during install.'
    ]
  },
  {
    patterns: ['docker: command not found', 'docker compose: not found', 'Cannot connect to the Docker daemon'],
    title: 'Docker Not Available on Server',
    fixes: [
      'Docker is not installed or not running on the target server.',
      'The playbook should install Docker automatically — try rerunning.',
      'If rerun fails, SSH into the server and run: curl -fsSL https://get.docker.com | sh',
      'After install: sudo systemctl enable docker && sudo systemctl start docker',
      'Add user to docker group: sudo usermod -aG docker ubuntu && newgrp docker'
    ]
  },

  // ── Generic Ansible Errors (checked after specific ones) ─
  {
    patterns: ['ansible-playbook: command not found', 'ansible-playbook: not found', 'ansible-playbook is not recognized'],
    title: 'Ansible Not Installed',
    fixes: [
      'Ansible is not installed on this machine.',
      'Install: pip install ansible',
      'On macOS: brew install ansible',
      'On Ubuntu: sudo apt install ansible',
      'On Windows: use WSL (Windows Subsystem for Linux) — Ansible does not run natively on Windows.',
      'Verify installation: ansible --version'
    ]
  },
  {
    patterns: ['UNREACHABLE!', 'Failed to connect to the host'],
    title: 'Ansible Cannot Reach Server',
    fixes: [
      'Ansible could not establish an SSH connection to the target server.',
      'Verify the server IP is correct and the VM is running.',
      'Check that the SSH key path in inventory is correct.',
      'Try connecting manually: ssh -i <key> <user>@<ip>',
      'For newly created VMs, wait 1-2 minutes for cloud-init to finish.'
    ]
  },
  {
    patterns: ['MODULE FAILURE', 'module failed'],
    title: 'Ansible Module Failed',
    fixes: [
      'An Ansible task failed during execution on the remote server.',
      'Check the task output above for the specific error message.',
      'Common cause: missing dependencies or permission issues.',
      'Try rerunning — some tasks fail on first run due to apt locks.',
      'Check disk space on the server: df -h'
    ]
  }
];

/**
 * Search the troubleshoot database for matching error patterns.
 * Returns the first match with title and suggested fixes.
 *
 * @param {string} errorMessage - The error text to analyze
 * @returns {Object|null} - { title, fixes } or null if no match
 */
export function getTroubleshoot(errorMessage) {
  if (!errorMessage) return null;

  const lower = errorMessage.toLowerCase();

  for (const entry of TROUBLESHOOT_DB) {
    for (const pattern of entry.patterns) {
      if (lower.includes(pattern.toLowerCase())) {
        return {
          title: entry.title,
          fixes: entry.fixes
        };
      }
    }
  }

  // — No known pattern matched
  return null;
}
