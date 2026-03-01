// =============================================================================
// Terraform Execution Engine
// =============================================================================
// Runs terraform init/plan/apply/destroy using the existing .tf files
// in the parent project. Generates terraform.tfvars from wizard form values.
// =============================================================================

import { spawn } from 'child_process';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Run a Terraform command (validate, apply, destroy) using existing .tf modules.
 *
 * @param {'validate'|'apply'|'destroy'} action - Terraform action to run
 * @param {'oci'|'gcloud'} provider - Cloud provider (maps to tf directory)
 * @param {Object} values - Form values from the wizard UI
 * @param {string} projectRoot - Absolute path to the parent project root
 * @param {Function} broadcast - WebSocket broadcast function
 * @returns {Promise<{success: boolean, message: string, ip?: string}>}
 */
export async function runTerraform(action, provider, values, projectRoot, broadcast) {
  // — Resolve the correct terraform directory from existing project
  const tfDirMap = {
    oci: join(projectRoot, 'terraform', 'oci'),
    gcloud: join(projectRoot, 'terraform')
  };
  const tfDir = tfDirMap[provider];

  if (!tfDir || !existsSync(tfDir)) {
    throw new Error(`Terraform directory not found for provider "${provider}" at ${tfDir}`);
  }

  // — Generate terraform.tfvars from wizard form values (only for apply)
  const tfvarsPath = join(tfDir, 'orchestrator.auto.tfvars');
  if (action !== 'destroy' && Object.keys(values).length > 0) {
    const tfvarsContent = generateTfvars(values);
    writeFileSync(tfvarsPath, tfvarsContent);
    broadcast('log', { text: `Generated tfvars at ${tfvarsPath}` });
  }

  try {
    // — Step 1: terraform init
    broadcast('log', { text: '$ terraform init' });
    await execTerraform(['init', '-input=false', '-no-color'], tfDir, broadcast);

    if (action === 'validate') {
      // — Validate only: run terraform plan (dry-run)
      broadcast('log', { text: '$ terraform plan (dry-run validation)' });
      await execTerraform(['plan', '-input=false', '-no-color'], tfDir, broadcast);
      return { success: true, message: 'Credentials validated — terraform plan succeeded' };
    }

    if (action === 'apply') {
      // — Apply: create infrastructure
      broadcast('log', { text: '$ terraform apply -auto-approve' });
      await execTerraform(['apply', '-auto-approve', '-input=false', '-no-color'], tfDir, broadcast);

      // — Extract output IP
      const ip = await getTerraformOutput(provider, tfDir, broadcast);
      return { success: true, message: `Infrastructure created. IP: ${ip}`, ip };
    }

    if (action === 'destroy') {
      // — Destroy: tear down infrastructure
      broadcast('log', { text: '$ terraform destroy -auto-approve' });
      await execTerraform(['destroy', '-auto-approve', '-input=false', '-no-color'], tfDir, broadcast);
      return { success: true, message: 'Infrastructure destroyed' };
    }

  } finally {
    // — Clean up generated tfvars (don't leave credentials on disk)
    if (existsSync(tfvarsPath)) {
      unlinkSync(tfvarsPath);
    }
  }
}

/**
 * Execute a terraform command, streaming output via broadcast.
 */
function execTerraform(args, cwd, broadcast) {
  return new Promise((resolve, reject) => {
    const proc = spawn('terraform', args, {
      cwd,
      shell: true,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      broadcast('log', { text, source: 'terraform' });
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      broadcast('log', { text, source: 'terraform' });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Terraform exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start terraform: ${err.message}`));
    });
  });
}

/**
 * Extract the server IP from terraform output.
 * Uses the existing output definitions in the project's .tf files.
 */
async function getTerraformOutput(provider, tfDir, broadcast) {
  // — Output keys differ per provider (from existing outputs.tf files)
  const outputKeyMap = {
    oci: 'vm_public_ip',
    gcloud: 'vm_ip'
  };
  const outputKey = outputKeyMap[provider];

  return new Promise((resolve, reject) => {
    const proc = spawn('terraform', ['output', '-raw', outputKey], {
      cwd: tfDir,
      shell: true
    });

    let stdout = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => {
      broadcast('log', { text: data.toString(), source: 'terraform' });
    });

    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Could not extract IP from terraform output (key: ${outputKey})`));
      }
    });
  });
}

/**
 * Convert a JS object into terraform.tfvars format.
 * Handles strings, numbers, and booleans.
 */
function generateTfvars(values) {
  const lines = [
    '# Auto-generated by Deploy Orchestrator — do not commit',
    `# Generated at ${new Date().toISOString()}`,
    ''
  ];

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'number') {
      lines.push(`${key} = ${value}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key} = ${value}`);
    } else {
      // — String: escape quotes and wrap in double quotes
      lines.push(`${key} = "${String(value).replace(/"/g, '\\"')}"`);
    }
  }

  return lines.join('\n') + '\n';
}
