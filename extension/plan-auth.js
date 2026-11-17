export class PlanError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const PLAN = "chatgpt.tokens.use.direct";
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired",
  "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));

export async function startAuthorization(hostId, port, registeredClientId) {
  const tx = { state: random(), nonce: random(), verifier: random(), redirect: `http://127.0.0.1:${port}/auth/callback` };
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(tx.verifier))));
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: registeredClientId || "dynamic_agent_client", ext_agent_host_id: hostId,
    ...(registeredClientId ? {} : { agent_name_hint: "YT Summaro" }),
    response_type: "code", redirect_uri: tx.redirect, resource: RESOURCE,
    scope: `openid profile email offline_access resource.invoke ${PLAN}`,
    state: tx.state, nonce: tx.nonce, code_challenge_method: "S256", code_challenge: challenge
  });
  return { tx, url: url.href };
}

export function callbackRule(tabId, tx, target) {
  const prefix = tx.redirect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The exact state is part of the match. Parameter order may differ on success and denial.
  const query = `((?:[^#]*&)?state=${tx.state}(?:&[^#]*)?)`;
  return {
    id: tabId, priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution: `${target}#\\1` } },
    condition: { regexFilter: `^${prefix}\\?${query}$`, isUrlFilterCaseSensitive: true, resourceTypes: ["main_frame"], tabIds: [tabId] }
  };
}

export function parseCallback(query, state, registeredClientId) {
  if (typeof query !== "string" || query.length > 16_384) throw new PlanError("Unexpected callback data.");
  const params = new URLSearchParams(query);
  const read = (name) => {
    const values = params.getAll(name);
    if (values.length > 1) throw new PlanError("The callback repeated an OAuth parameter.");
    return values[0];
  };
  if (read("state") !== state) throw new PlanError("The callback did not match this sign-in attempt.");
  if (read("error")) throw new PlanError("OpenAI declined or cancelled sign-in.");
  const code = read("code");
  const returnedId = read("client_id");
  if (registeredClientId && returnedId && registeredClientId !== returnedId) throw new PlanError("OpenAI returned a different app registration.");
  const clientId = returnedId || registeredClientId;
  if (!code || !clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId)) throw new PlanError("The callback did not include a code and registered client ID.");
  return { code, clientId };
}

async function request(url, init = {}) {
  try {
    return await fetch(url, {
      ...init, credentials: "omit", redirect: "error", cache: "no-store",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(25_000)
    });
  } catch (error) {
    init.signal?.throwIfAborted();
    const message = error.name === "TimeoutError" ? "The OpenAI request timed out." : "Could not reach OpenAI. Check your connection and retry.";
    throw new PlanError(message, "PLAN_NETWORK");
  }
}

function form(values) {
  return { method: "POST", body: new URLSearchParams(values) };
}

function apiError(status, body) {
  const code = typeof body?.error === "string" ? body.error : body?.error?.code;
  return /^[a-z0-9_]{1,90}$/i.test(code ?? "") ? `${status}, ${code}` : `${status}`;
}

export async function exchangeCode(tx, callback) {
  const res = await request(`${ISSUER}/api/accounts/oauth/token`, form({
    grant_type: "authorization_code", client_id: callback.clientId, code: callback.code,
    code_verifier: tx.verifier, redirect_uri: tx.redirect, resource: RESOURCE
  }));
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new PlanError(`Token exchange failed (${apiError(res.status, body)}).`);
  if (!body || typeof body !== "object") throw new PlanError("OpenAI returned an invalid token response.");
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    throw new PlanError("OpenAI did not grant a session that can be renewed. Try connecting again.", "PLAN_DISCONNECTED");
  }
  return body;
}

export function validateAccessToken(tokens, fallbackScope) {
  const lifetime = Number(tokens?.expires_in);
  const scope = tokens?.scope ?? fallbackScope;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token ||
      typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
      typeof scope !== "string" || !scope.split(/\s+/).includes(PLAN) ||
      !Number.isFinite(lifetime) || lifetime <= 0) {
    throw new PlanError("OpenAI did not return a valid ChatGPT plan access token.", "PLAN_DISCONNECTED");
  }
  return { scope, expiresAt: Date.now() + lifetime * 1000 };
}

export async function refreshPlanSession(tokens, clientId) {
  const res = await request(`${ISSUER}/api/accounts/oauth/token`, form({
    grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token, resource: RESOURCE
  }));
  const updated = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof updated?.error === "string" ? updated.error : updated?.error?.code;
    if (TERMINAL_REFRESH_ERRORS.has(code)) {
      throw new PlanError("The ChatGPT session expired or was revoked. Reconnect in Settings.", "PLAN_DISCONNECTED");
    }
    throw new PlanError(`Could not renew the ChatGPT session (${apiError(res.status, updated)}).`);
  }
  const { scope, expiresAt } = validateAccessToken(updated, tokens.scope);
  const rotated = typeof updated.refresh_token === "string" && updated.refresh_token
    ? updated.refresh_token
    : tokens.refresh_token;
  if (typeof rotated !== "string" || !rotated) {
    throw new PlanError("OpenAI did not return a renewable session. Reconnect in Settings.", "PLAN_DISCONNECTED");
  }
  return { tokens: { ...tokens, ...updated, refresh_token: rotated, scope }, expiresAt };
}

function jwtObject(part) {
  try {
    const value = JSON.parse(decoder.decode(decode(part)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new PlanError("OpenAI returned an invalid ID token.");
  }
}

export async function validateConnection(tokens, { nonce }, clientId) {
  const idToken = tokens?.id_token;
  if (typeof idToken !== "string" || idToken.length > 16_384) {
    throw new PlanError("OpenAI returned an invalid ID token.");
  }
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new PlanError("OpenAI returned an invalid ID token.");
  }
  const [head, payload, signature] = parts;
  const header = jwtObject(head);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new PlanError("OpenAI returned an unsupported ID token signing algorithm.");
  const res = await request(`${ISSUER}/.well-known/jwks.json`);
  if (!res.ok) throw new PlanError("Could not fetch OpenAI’s public signing keys.");
  const jwks = await res.json().catch(() => null);
  const jwk = (Array.isArray(jwks?.keys) ? jwks.keys : [])
    .find((key) => key?.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig"));
  if (!jwk) throw new PlanError("No matching OpenAI signing key was found.");
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  let verified = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
    verified = await crypto.subtle.verify(algorithm, key, decode(signature), encoder.encode(`${head}.${payload}`));
  } catch {
    throw new PlanError("The OpenAI ID token signature could not be verified.");
  }
  if (!verified) throw new PlanError("The OpenAI ID token signature could not be verified.");
  const claims = jwtObject(payload);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (claims.iss !== ISSUER || !audiences.includes(clientId) ||
      ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) ||
      claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub) {
    throw new PlanError("The OpenAI ID token did not match this sign-in attempt.");
  }
  return validateAccessToken(tokens);
}

export async function revokeSession(tokens, clientId) {
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  try {
    const metadata = await request(`${ISSUER}/.well-known/openid-configuration`);
    if (!metadata.ok) return false;
    const info = await metadata.json();
    const endpoint = new URL(info.revocation_endpoint);
    if (info.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password) return false;
    const res = await request(endpoint.href, form({ token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: clientId }));
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function listPlanModels(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const list = await request(`${RESOURCE}/models`, { headers });
  if (!list.ok) throw new PlanError(`Model listing failed (${apiError(list.status, await list.json().catch(() => null))}).`);
  const data = await list.json().catch(() => null);
  const models = Array.isArray(data?.models) ? data.models : [];
  return [...new Set(models
    .filter((model) => model?.visibility === "list" && typeof model.slug === "string" && model.slug)
    .map((model) => model.slug))];
}

export async function requestPlanSummary(accessToken, model, { instructions, input }, signal) {
  const res = await request(`${RESOURCE}/responses`, {
    method: "POST", headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    }, signal,
    body: JSON.stringify({ model, instructions, store: false, stream: true, input: [{ role: "user", content: input }] })
  });
  if (!res.ok) {
    const error = res.status === 401
      ? new PlanError("ChatGPT no longer accepts this session. Reconnect in Settings.", "PLAN_DISCONNECTED")
      : new PlanError(`Summary request failed (${apiError(res.status, await res.json().catch(() => null))}).`);
    await res.body?.cancel().catch(() => {});
    throw error;
  }
  if (!res.body) throw new PlanError("OpenAI did not return a response stream.");
  return readResponse(res.body);
}

export async function readResponse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      if (buffer.length + text.length > 512_000) throw new PlanError("OpenAI returned more data than the extension can process.");
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new PlanError("OpenAI returned a malformed response stream.");
        }
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
        if (event.type === "response.completed" && text.trim()) return text.trim();
        if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
          throw new PlanError(`The summary did not complete (${apiError("stream", event.response ?? { error: event })}).`);
        }
      }
    }
    throw new PlanError("The stream ended without a completed summary.");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
