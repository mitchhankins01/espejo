import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { config } from "../config.js";

// In-memory stores — fine for single-instance personal app.
// Tokens/codes reset on deploy, forcing re-auth (acceptable).
interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

const authCodes = new Map<string, StoredCode>();
const activeTokens = new Set<string>();

export function isValidOAuthToken(token: string): boolean {
  return activeTokens.has(token);
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return computed === codeChallenge;
}

export function registerOAuthRoutes(app: Express): void {
  const clientId = config.server.oauthClientId;
  const clientSecret = config.server.oauthClientSecret;

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  });

  // Authorization endpoint — GET shows login form
  app.get("/oauth/authorize", (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (client_id !== clientId) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Only S256 is supported" });
      return;
    }

    /* v8 ignore next -- HTML form, not unit-testable */
    res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Espejo — Authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 360px; margin: 80px auto; padding: 0 16px; }
    input[type=password] { width: 100%; padding: 8px; margin: 8px 0 16px; box-sizing: border-box; }
    button { padding: 8px 24px; cursor: pointer; }
  </style>
</head>
<body>
  <h2>Authorize Espejo MCP</h2>
  <p>Enter the server password to allow access to your journal.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${client_id}" />
    <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
    <input type="hidden" name="state" value="${state || ""}" />
    <input type="hidden" name="code_challenge" value="${code_challenge || ""}" />
    <input type="hidden" name="response_type" value="code" />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required autofocus />
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`);
  });

  // Authorization endpoint — POST validates password, redirects with code
  app.post("/oauth/authorize", (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, code_challenge, password } = req.body as Record<string, string>;

    if (client_id !== clientId) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    if (password !== config.server.mcpSecret) {
      res.status(403).type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Unauthorized</title></head>
<body><h2>Invalid password</h2><p><a href="javascript:history.back()">Try again</a></p></body></html>`);
      return;
    }

    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge || "",
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // Token endpoint — exchanges authorization code for access token
  app.post("/oauth/token", (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } =
      req.body as Record<string, string>;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    if (client_id !== clientId || client_secret !== clientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    const stored = authCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      authCodes.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    if (stored.redirectUri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // PKCE verification (required when code_challenge was provided)
    if (stored.codeChallenge) {
      if (!code_verifier || !verifyPkce(code_verifier, stored.codeChallenge)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    authCodes.delete(code);

    const accessToken = crypto.randomBytes(32).toString("hex");
    activeTokens.add(accessToken);

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
    });
  });
}
