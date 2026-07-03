import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import { findWorkspace } from '../../utils/workspace.js';
import { getValidWorkspaces } from '../../utils/registry.js';
import { exportWorkspace, slugify } from '../../export/index.js';
import { buildSignedExe } from '../exe-build.js';

/**
 * aaas publish [agent-name] --business "<name>"
 *
 * Exports a workspace and uploads it to StreetAI, returning a customer-facing
 * setup link. The operator sends that one link to the client, who opens it,
 * downloads StreetAI-Setup.bat, and runs it.
 *
 * Auth: needs the server admin key. Provide via --key or $STREETAI_PUBLISH_KEY.
 * Server defaults to https://streetai.org (override with --server or
 * $STREETAI_PUBLISH_URL).
 */
export async function publishCommand(agentName, options = {}) {
  if (agentName && typeof agentName === 'object' && !options) {
    options = agentName; agentName = undefined;
  }

  const ws = resolveWorkspace(agentName);
  const server = (options.server || process.env.STREETAI_PUBLISH_URL || 'https://streetai.org').replace(/\/$/, '');
  const key = options.key || process.env.STREETAI_PUBLISH_KEY;
  const hosted = !!options.hosted;
  // Hosting needs the agent's keys to run + a customer account to attach to.
  const noSecrets = hosted ? false : (options.secrets === false);

  if (hosted && !(options.email || '').trim()) {
    console.error(chalk.red('\n  Error: --hosted requires --email (the customer account to attach the agent to).\n'));
    process.exit(1);
  }
  if (hosted && options.secrets === false) {
    console.log(chalk.yellow('  (ignoring --no-secrets: a hosted agent needs its credentials to run)'));
  }

  if (!key) {
    console.error(chalk.red('\n  Error: no admin key.\n'));
    console.log(chalk.gray('  Set it once:'));
    console.log(chalk.gray('    PowerShell:  $env:STREETAI_PUBLISH_KEY = "<your-admin-key>"'));
    console.log(chalk.gray('  or pass --key <your-admin-key>\n'));
    process.exit(1);
  }

  // Convert the agent photo to an .ico now (at publish), so the installer can
  // use it for the desktop shortcut without converting on the client machine.
  try {
    const png = path.join(ws, '.aaas', 'avatar.png');
    if (fs.existsSync(png)) {
      fs.writeFileSync(path.join(ws, '.aaas', 'avatar.ico'), pngToIco(fs.readFileSync(png)));
    }
  } catch (err) {
    console.log(chalk.gray(`  (icon skipped: ${err.message})`));
  }

  // 1. Export to a temp bundle.
  console.log('');
  console.log(chalk.bold('Publishing workspace') + chalk.gray(` (${path.basename(ws)})`));
  const tmp = path.join(os.tmpdir(), `streetai-publish-${Date.now()}.tar.gz`);
  let result;
  try {
    result = await exportWorkspace(ws, { noSecrets, outputPath: tmp });
  } catch (err) {
    console.error(chalk.red(`\n  Export failed: ${err.message}\n`));
    process.exit(1);
  }

  const slug = slugify(result.manifest.workspace_name || path.basename(ws));
  const business = options.business || result.manifest.workspace_name || slug;
  const version = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const accountEmail = (options.email || '').trim();
  // Headers that attach the upload to a customer account when --email is given.
  const linkHeaders = accountEmail
    ? { 'X-Account-Email': encodeURIComponent(accountEmail), 'X-Version': version }
    : { 'X-Version': version };
  if (hosted) linkHeaders['X-Hosted'] = '1';

  // 2. Upload to the server.
  console.log(chalk.gray(`  Uploading to ${server} ...`));
  let data;
  try {
    const bytes = fs.readFileSync(result.outputPath);
    const resp = await fetch(`${server}/admin/bundle`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/gzip',
        'X-Business': encodeURIComponent(business),
        'X-Slug': slug,
        ...linkHeaders,
      },
      body: bytes,
    });
    data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `Server returned ${resp.status}`);
    }
  } catch (err) {
    console.error(chalk.red(`\n  Upload failed: ${err.message}\n`));
    process.exit(1);
  } finally {
    try { fs.unlinkSync(result.outputPath); } catch { /* ignore */ }
  }

  // 2b. When account-linked, upload the agent's avatar (if set) so it shows in
  //     the customer's dashboard. Best-effort — never fails the publish.
  if (accountEmail) {
    try {
      const avatar = findAvatar(ws);
      if (avatar) {
        const resp = await fetch(`${server}/admin/assistant-avatar`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': `image/${avatar.ext === 'jpg' ? 'jpeg' : avatar.ext}`,
            'X-Slug': slug,
            'X-Ext': avatar.ext,
            'X-Account-Email': encodeURIComponent(accountEmail),
          },
          body: fs.readFileSync(avatar.path),
        });
        if (resp.ok) console.log(chalk.gray(`  Avatar:   uploaded (${avatar.ext})`));
      }
    } catch { /* avatar is optional — ignore upload failures */ }
  }

  // 3a. Hosted mode: report provisioning + the in-account dashboard, and stop
  //     (no installer link to send — the customer opens it from their dashboard).
  if (hosted) {
    const h = data.hosting || {};
    if (h.hosted) {
      console.log(chalk.green('\n  Published & hosted.\n'));
      console.log(chalk.gray(`  Running on StreetAI (port ${h.port}) · status: ${h.active ? chalk.green('active') : chalk.yellow('starting…')}`));
      console.log(chalk.bold(`\n  ${accountEmail} opens it in their dashboard:`));
      console.log('    ' + chalk.cyan('https://streetai.org/account → Assistants → click the agent'));
      console.log('');
      console.log(chalk.gray('  Re-publish anytime to update it in place (keeps sessions + credentials).'));
    } else {
      console.log(chalk.yellow('\n  Published, but hosting did not complete.'));
      console.log(chalk.red(`  ${h.error || 'Unknown hosting error.'}`));
      console.log(chalk.gray('  The bundle uploaded and the assistant is linked; fix the server and re-publish --hosted.'));
    }
    console.log('');
    return;
  }

  // 3. Show the link to send the client.
  console.log(chalk.green('\n  Published.\n'));
  console.log(chalk.bold('  Send this link to the client:'));
  console.log('    ' + chalk.cyan(data.setupUrl));
  console.log('');
  console.log(chalk.gray('  New client → installs. Existing client → updates in place'));
  console.log(chalk.gray('  (keeps their sessions, data, and credentials). Same link either way.'));
  console.log('');
  console.log(chalk.gray(`  Business: ${business}`));
  if (accountEmail) {
    console.log(chalk.gray(`  Account:  ${accountEmail} (shows in their dashboard → Assistants)`));
  }
  console.log(chalk.gray(`  Expires:  ${data.expiresAt ? new Date(data.expiresAt).toLocaleString() : 'never (account-linked)'}`));
  if (!noSecrets) {
    console.log(chalk.yellow('\n  Note: this bundle includes credentials. Only send the link to this client.'));
  }

  // 4. Optionally build + sign a per-client installer .exe (online; bakes in the
  //    direct bundle download URL). The .bat link above always remains as the
  //    fallback, so this never breaks the existing flow.
  if (options.exe) {
    console.log(chalk.gray('\n  Building the installer .exe (Inno Setup + signing) ...'));
    let exe;
    try {
      exe = buildSignedExe({
        slug,
        business,
        bundleUrl: options.bundleUrl || data.downloadUrl,
        version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
        service: !!options.service,
        installDir: options.installDir,
        iscc: options.iscc,
        signThumbprint: options.signThumbprint,
      });
    } catch (err) {
      console.error(chalk.red(`  .exe build failed: ${err.message}`));
      console.log(chalk.gray('  The setup link above still works (.bat fallback).\n'));
      return;
    }

    // Try to host it for a download link; fall back to leaving the file locally.
    let exeUrl = null;
    try {
      const resp = await fetch(`${server}/admin/exe`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/octet-stream',
          'X-Slug': slug,
          'X-Business': encodeURIComponent(business),
          ...linkHeaders,
        },
        body: fs.readFileSync(exe.exePath),
      });
      if (resp.ok) { const j = await resp.json().catch(() => ({})); exeUrl = j.exeUrl || j.downloadUrl || null; }
    } catch { /* server may not host .exe yet — fall back below */ }

    if (exeUrl) {
      console.log(chalk.green('\n  Installer .exe published.'));
      console.log(chalk.bold('  Send this .exe link to the client:'));
      console.log('    ' + chalk.cyan(exeUrl));
    } else {
      const dest = path.join(process.cwd(), path.basename(exe.exePath));
      try { fs.copyFileSync(exe.exePath, dest); } catch { /* keep temp path */ }
      console.log(chalk.green('\n  Installer .exe built.'));
      console.log('    ' + chalk.cyan(fs.existsSync(dest) ? dest : exe.exePath));
      console.log(chalk.gray('  (Server .exe hosting unavailable — send this file to the client.)'));
    }
    if (!exe.signed && exe.signNote) console.log(chalk.yellow('  ' + exe.signNote));
    console.log(chalk.gray(`  Signed:  ${exe.signed ? 'yes' : 'NO'}`));
    console.log(chalk.gray(`  SHA-256: ${exe.sha256}`));
    console.log(chalk.gray(`  Mode:    ${options.service ? 'always-on boot service (admin + password at install)' : 'per-user (no admin)'}`));
    try { fs.rmSync(path.dirname(exe.exePath), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('');
}

/** Find the agent's avatar image in the workspace, if any. */
function findAvatar(ws) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    const p = path.join(ws, '.aaas', `avatar.${ext}`);
    if (fs.existsSync(p)) return { path: p, ext };
  }
  return null;
}

/**
 * Wrap a PNG into a minimal .ico (Vista+ supports PNG-compressed icons), so no
 * image library is needed. Reads width/height from the PNG IHDR header.
 */
function pngToIco(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);   // reserved
  dir.writeUInt16LE(1, 2);   // type: icon
  dir.writeUInt16LE(1, 4);   // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0);   // width  (0 means 256+)
  entry.writeUInt8(h >= 256 ? 0 : h, 1);   // height (0 means 256+)
  entry.writeUInt8(0, 2);    // palette colors
  entry.writeUInt8(0, 3);    // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image data size
  entry.writeUInt32LE(22, 12);         // offset (6 + 16)
  return Buffer.concat([dir, entry, png]);
}

/** Resolve a workspace by name (registry) or fall back to the CWD's workspace. */
function resolveWorkspace(agentName) {
  const workspaces = getValidWorkspaces();
  if (agentName) {
    const match = workspaces.find(w =>
      path.basename(w.path) === agentName ||
      w.name?.toLowerCase() === agentName.toLowerCase());
    if (match) return match.path;
    console.error(chalk.red(`\n  Error: Agent "${agentName}" not found in registry.\n`));
    if (workspaces.length > 0) {
      console.log(chalk.gray('  Registered agents:'));
      for (const w of workspaces) console.log(chalk.gray(`    - ${w.name} (${path.basename(w.path)})`));
    }
    console.log('');
    process.exit(1);
  }
  const ws = findWorkspace();
  if (ws) return ws;
  console.error(chalk.red('\n  Error: No workspace found here. Pass an agent name or cd into a workspace.\n'));
  process.exit(1);
}
