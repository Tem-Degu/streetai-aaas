import express from 'express';
import open from 'open';
import { createServer } from 'http';

/**
 * Run an OAuth2 authorization code flow via a local callback server.
 * Opens the browser, catches the redirect, exchanges the code for tokens.
 */
export async function oauthFlow({ authUrl, tokenUrl, clientId, clientSecret, scopes, callbackPath = '/callback' }) {
  return new Promise((resolve, reject) => {
    const app = express();
    let server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out (120s). Try again.'));
    }, 120_000);

    app.get(callbackPath, async (req, res) => {
      const code = req.query.code;
      const error = req.query.error;

      if (error) {
        res.send('<h2>Authorization failed</h2><p>You can close this tab.</p>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.send('<h2>Missing authorization code</h2><p>Try again.</p>');
        clearTimeout(timeout);
        server.close();
        reject(new Error('No authorization code received'));
        return;
      }

      try {
        // Exchange code for tokens
        const port = server.address().port;
        const redirectUri = `http://localhost:${port}${callbackPath}`;

        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
        });
        if (clientSecret) body.append('client_secret', clientSecret);

        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          throw new Error(`Token exchange failed: ${tokenRes.status} ${errText}`);
        }

        const tokens = await tokenRes.json();

        res.send('<h2>Authorized!</h2><p>You can close this tab and return to the terminal.</p>');
        clearTimeout(timeout);
        server.close();

        resolve({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
          expiresAt: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : null,
          raw: tokens,
        });
      } catch (err) {
        res.send(`<h2>Error</h2><p>${err.message}</p>`);
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    // Start on a random available port
    server = createServer(app);
    server.listen(0, async () => {
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}${callbackPath}`;

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
      });
      if (scopes) params.append('scope', scopes);

      const fullAuthUrl = `${authUrl}?${params.toString()}`;

      try {
        await open(fullAuthUrl);
      } catch {
        // Browser didn't open — user needs to open manually
        console.log(`\n  Open this URL in your browser:\n  ${fullAuthUrl}\n`);
      }
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start OAuth server: ${err.message}`));
    });
  });
}

/**
 * Refresh an OAuth2 access token using a refresh token.
 */
export async function refreshOAuthToken({ tokenUrl, clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.append('client_secret', clientSecret);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const tokens = await res.json();

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
  };
}
