import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';
import chalk from 'chalk';
import { setProviderCredential } from '../../auth/credentials.js';

const OAUTH_PORT = 19836;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/oauth/callback`;

const OAUTH_PROVIDERS = {
  anthropic: {
    authUrl: 'https://console.anthropic.com/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/oauth/token',
    defaultClientId: 'aaas-agent-runtime',
    scopes: 'user:inference',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultClientId: 'aaas-agent-runtime.apps.googleusercontent.com',
    scopes: 'https://www.googleapis.com/auth/generative-language',
  },
  azure: {
    authUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    defaultClientId: 'aaas-agent-runtime',
    scopes: 'https://cognitiveservices.azure.com/.default offline_access',
  },
};

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>AaaS — Authenticated</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border:1px solid #333;border-radius:12px;max-width:400px}
h1{color:#4ade80;font-size:1.5rem}p{color:#999;margin-top:0.5rem}</style></head>
<body><div class="card"><h1>Authenticated</h1><p>You can close this tab and return to the terminal.</p></div></body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html><head><title>AaaS — Error</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border:1px solid #333;border-radius:12px;max-width:400px}
h1{color:#f87171;font-size:1.5rem}p{color:#999;margin-top:0.5rem}</style></head>
<body><div class="card"><h1>Authentication Failed</h1><p>${msg}</p></div></body></html>`;

export async function oauthCommand(provider, opts = {}) {
  if (!provider) {
    console.log(chalk.blue('\n  Available OAuth providers:\n'));
    for (const name of Object.keys(OAUTH_PROVIDERS)) {
      console.log(`    ${name}`);
    }
    console.log(chalk.gray('\n  Usage: aaas oauth <provider> [--client-id <id>] [--tenant-id <id>]\n'));
    return;
  }

  const config = OAUTH_PROVIDERS[provider];
  if (!config) {
    console.error(chalk.red(`\n  OAuth not available for "${provider}".`));
    console.log(chalk.gray(`  Available: ${Object.keys(OAUTH_PROVIDERS).join(', ')}\n`));
    return;
  }

  const clientId = opts.clientId || config.defaultClientId;
  const tenantId = opts.tenantId || 'common';
  const state = crypto.randomBytes(16).toString('hex');

  let authUrl = config.authUrl;
  let tokenUrl = config.tokenUrl;
  if (provider === 'azure') {
    authUrl = authUrl.replace('{tenant}', tenantId);
    tokenUrl = tokenUrl.replace('{tenant}', tenantId);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state,
  });
  if (config.scopes) params.append('scope', config.scopes);
  if (provider === 'google') params.append('access_type', 'offline');

  const fullAuthUrl = `${authUrl}?${params.toString()}`;

  // Start local callback server
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      server.close();
      resolve({ error: 'Timed out waiting for OAuth callback (5 minutes).' });
    }, 5 * 60 * 1000);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const desc = url.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(desc));
        clearTimeout(timeout);
        server.close();
        resolve({ error: desc });
        return;
      }

      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('No authorization code received.'));
        clearTimeout(timeout);
        server.close();
        resolve({ error: 'No authorization code received.' });
        return;
      }

      if (returnedState && returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('State mismatch — possible CSRF.'));
        clearTimeout(timeout);
        server.close();
        resolve({ error: 'OAuth state mismatch.' });
        return;
      }

      // Exchange code for tokens
      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
        });

        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML('Token exchange failed.'));
          clearTimeout(timeout);
          server.close();
          resolve({ error: `Token exchange failed: ${errText}` });
          return;
        }

        const tokens = await tokenRes.json();

        setProviderCredential(provider, {
          type: 'oauth',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
          expiresAt: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : null,
          apiKey: tokens.access_token,
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        clearTimeout(timeout);
        server.close();
        resolve({ ok: true });
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(err.message));
        clearTimeout(timeout);
        server.close();
        resolve({ error: err.message });
      }
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        resolve({ error: `Port ${OAUTH_PORT} is already in use. Is the dashboard running?` });
      } else {
        resolve({ error: err.message });
      }
    });

    server.listen(OAUTH_PORT, () => {
      console.log(chalk.blue(`\n  OAuth flow for ${chalk.bold(provider)}`));
      console.log(chalk.gray(`  Client ID: ${clientId}`));
      console.log(chalk.gray(`  Callback:  ${REDIRECT_URI}\n`));
      console.log(chalk.gray('  Opening browser...'));
      openBrowser(fullAuthUrl);
      console.log(chalk.gray(`  If the browser didn't open, visit:\n  ${fullAuthUrl}\n`));
      console.log(chalk.gray('  Waiting for callback (5 min timeout)...\n'));
    });
  });

  if (result.ok) {
    console.log(chalk.green(`  Credential saved for ${provider}.\n`));
  } else {
    console.error(chalk.red(`  OAuth failed: ${result.error}\n`));
    process.exit(1);
  }
}
