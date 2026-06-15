// Build + sign a per-client Windows installer .exe from the Inno Setup script.
//
// Used by `aaas publish --exe`. Compiles streetai/install/streetai-setup.iss with
// ISCC (baking in the client's Name/Business/BundleUrl), then signs the result
// with our code-signing cert via PowerShell's Set-AuthenticodeSignature (no
// Windows SDK / signtool needed). Returns { exePath, sha256, signed }.
//
// Requirements on the publishing machine (this is the operator's box, the repo):
//   - Inno Setup (ISCC.exe) — auto-located or via --iscc / $AAAS_ISCC
//   - a code-signing cert in CurrentUser\My — auto-found by subject, or pinned
//     via --sign-thumbprint / $AAAS_SIGN_THUMBPRINT (skip signing if none)

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default location of the installer assets (only present in the repo, not the npm package). */
export function defaultInstallDir() {
  return path.resolve(__dirname, '..', '..', 'streetai', 'install');
}

function resolveIscc(explicit) {
  const candidates = [
    explicit,
    process.env.AAAS_ISCC,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return 'ISCC.exe'; // last resort: hope it's on PATH
}

/**
 * @param {object} o
 * @param {string} o.slug        workspace slug → installer Name + output filename
 * @param {string} o.business    display name
 * @param {string} o.bundleUrl   direct .tgz download URL baked into the installer
 * @param {string} [o.version]   AppVersion (default 1.0.0)
 * @param {number} [o.port]      dashboard port (default 3400)
 * @param {boolean} [o.service]  register the always-on boot service
 * @param {string} [o.installDir] override the assets dir
 * @param {string} [o.iscc]      override ISCC path
 * @param {string} [o.signThumbprint] pin the signing cert
 * @returns {{ exePath: string, sha256: string, signed: boolean, signNote?: string }}
 */
export function buildSignedExe(o) {
  const installDir = o.installDir || defaultInstallDir();
  const iss = path.join(installDir, 'streetai-setup.iss');
  for (const f of ['streetai-setup.iss', 'install.ps1', 'service-install.ps1', 'service-uninstall.ps1', 'nssm.exe']) {
    if (!fs.existsSync(path.join(installDir, f))) {
      throw new Error(`installer asset missing: ${path.join(installDir, f)} (run --exe from the repo, or pass --install-dir)`);
    }
  }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streetai-exe-'));
  const iscc = resolveIscc(o.iscc);

  const defs = [
    `/DName=${o.slug}`,
    `/DBusiness=${o.business}`,
    `/DBundleUrl=${o.bundleUrl}`,
    `/DAppVersion=${o.version || '1.0.0'}`,
    `/DPort=${o.port || 3400}`,
  ];
  if (o.service) defs.push('/DServiceMode=1');
  defs.push(`/O${outDir}`); // output dir override

  const r = spawnSync(iscc, [...defs, iss], { encoding: 'utf-8' });
  if (r.error) throw new Error(`ISCC failed to run (${iscc}): ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`ISCC compile failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').slice(-800)}`);
  }

  const exePath = path.join(outDir, `StreetAI-Setup-${o.slug}.exe`);
  if (!fs.existsSync(exePath)) throw new Error(`compile reported success but ${exePath} is missing`);

  // Sign with our code-signing cert (PowerShell, no signtool needed).
  let signed = false;
  let signNote;
  const thumb = o.signThumbprint || process.env.AAAS_SIGN_THUMBPRINT || '';
  const findExpr = thumb
    ? `Get-Item Cert:\\CurrentUser\\My\\${thumb}`
    : `Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Where-Object { $_.Subject -match 'StreetAI' } | Select-Object -First 1`;
  const psSign = `$ErrorActionPreference='Stop'; $c = ${findExpr}; if (-not $c) { Write-Error 'no signing cert'; exit 2 }; ` +
    `$s = Set-AuthenticodeSignature -FilePath '${exePath.replace(/'/g, "''")}' -Certificate $c -HashAlgorithm SHA256; ` +
    `if ($s.SignerCertificate) { exit 0 } else { Write-Error $s.Status; exit 3 }`;
  const sr = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psSign], { encoding: 'utf-8' });
  if (sr.status === 0) {
    signed = true;
  } else {
    signNote = thumb
      ? `signing failed (thumbprint ${thumb}): ${(sr.stderr || '').trim().slice(-200)}`
      : `no StreetAI code-signing cert found in CurrentUser\\My — left unsigned. Set $AAAS_SIGN_THUMBPRINT.`;
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex').toUpperCase();
  return { exePath, sha256, signed, signNote };
}
