import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { requireWorkspace } from '../../utils/workspace.js';
import { isServerUp, apiCall, dashboardPort } from '../server-client.js';

/**
 * Stop connectors through the dashboard runtime — the same place the dashboard
 * "Stop" button stops them. Stopping does NOT change the auto-start flag
 * (operational, not "disable"): an enabled connector returns on the next boot.
 *
 *   aaas stop                 → stop all running connectors
 *   aaas stop truuze whatsapp → stop just those
 */
export async function stopCommand(platforms, opts) {
  // Back-compat: stop() or stop(opts)
  if (platforms && !Array.isArray(platforms) && typeof platforms === 'object') {
    opts = platforms;
    platforms = [];
  }
  platforms = platforms || [];

  const ws = requireWorkspace();
  const name = path.basename(ws);

  // Legacy daemon fallback: stop an old detached agent if one is still around.
  const pidFile = path.join(ws, '.aaas', 'agent.pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    console.log(chalk.green(`\n  Stopped legacy background agent (PID ${pid}).`));
  }

  const port = dashboardPort();
  if (!(await isServerUp(port))) {
    console.log(chalk.gray('\n  Agent runtime not running. Nothing to stop.\n'));
    return;
  }

  // Targets: the listed platforms, or every currently-connected one.
  let targets = platforms;
  if (targets.length === 0) {
    try {
      const st = await apiCall(name, '/deploy/status', { method: 'GET' });
      targets = (st?.platforms || [])
        .filter((p) => p.status === 'connected')
        .map((p) => p.platform);
    } catch { targets = []; }
  }

  if (targets.length === 0) {
    console.log(chalk.gray('\n  No running connectors.\n'));
    return;
  }

  for (const p of targets) {
    try {
      await apiCall(name, `/deploy/${p}/stop`, { body: {} });
      console.log(chalk.green(`  ${p}: stopped`));
    } catch (e) {
      console.error(chalk.red(`  ${p}: ${e.message}`));
    }
  }
  console.log('');
}
