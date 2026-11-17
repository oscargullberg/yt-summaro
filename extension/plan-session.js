import { PlanError, refreshPlanSession, revokeSession } from "./plan-auth.js";
import { deleteVaultSession, readVaultSession, writeVaultSession } from "./plan-token-vault.js";

const ACCESS_CACHE_KEY = "planAccessToken";
const SESSION_CACHE_KEY = "planTransientSession";
const REFRESH_LOCK = "yt-summaro-plan-refresh";
const EARLY_REFRESH_MS = 60_000;

let loaded = false;
let loadPromise = null;
let session = null;
let persisted = false;
let persistEnabled = true;
let access = null;
let refreshPromise = null;
let refreshPromiseGeneration = -1;
let generation = 0;

function normalizeSession(value) {
  if (!value || value.version !== 1) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (typeof value.refreshToken !== "string" || !value.refreshToken) return null;
  if (typeof value.clientId !== "string" || !value.clientId) return null;
  if (typeof value.scope !== "string" || !value.scope) return null;
  const models = Array.isArray(value.models)
    ? [...new Set(value.models.filter((model) => typeof model === "string" && model))]
    : [];
  if (!models.length) return null;
  return {
    version: 1,
    sessionId: value.sessionId,
    refreshToken: value.refreshToken,
    clientId: value.clientId,
    scope: value.scope,
    models: models.slice(0, 100),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
  };
}

function snapshot(current) {
  return {
    accessToken: current.accessToken,
    expiresAt: current.expiresAt,
    models: session?.models || []
  };
}

function usable(candidate) {
  return candidate && typeof candidate.accessToken === "string" && candidate.accessToken &&
    Number.isFinite(candidate.expiresAt) && candidate.expiresAt > Date.now() + EARLY_REFRESH_MS;
}

function persistenceAllowed() {
  return !globalThis.chrome?.extension?.inIncognitoContext;
}

async function loadSession() {
  if (loaded) return session;
  if (!loadPromise) {
    const at = generation;
    loadPromise = (async () => {
      if (!persistenceAllowed()) {
        loaded = true;
        return null;
      }
      const cached = await chrome.storage.session.get(SESSION_CACHE_KEY).catch(() => ({}));
      const transient = normalizeSession(cached[SESSION_CACHE_KEY]);
      if (generation !== at) return null;
      if (transient) {
        session = transient;
        persisted = false;
        persistEnabled = false;
        loaded = true;
        return session;
      }
      let stored = null;
      try {
        stored = await readVaultSession();
      } catch {
        stored = null;
      }
      if (generation !== at) return null;
      const normalized = normalizeSession(stored);
      if (stored && !normalized) await deleteVaultSession().catch(() => {});
      session = normalized;
      persisted = Boolean(normalized);
      loaded = true;
      return session;
    })().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function readAccessCache() {
  try {
    const stored = (await chrome.storage.session.get(ACCESS_CACHE_KEY))[ACCESS_CACHE_KEY];
    if (!stored || typeof stored.accessToken !== "string" || !Number.isFinite(stored.expiresAt)) return null;
    return stored;
  } catch {
    return null;
  }
}

async function cacheAccess(candidate) {
  access = candidate;
  if (!persistenceAllowed()) return;
  try {
    if (persisted) {
      await chrome.storage.session.set({ [ACCESS_CACHE_KEY]: candidate, [SESSION_CACHE_KEY]: null });
    } else {
      await chrome.storage.session.set({ [ACCESS_CACHE_KEY]: candidate, [SESSION_CACHE_KEY]: session });
    }
  } catch {
    // A memory-only cache still works for this worker lifetime.
  }
}

async function removeAccessCache() {
  try {
    await chrome.storage.session.remove(ACCESS_CACHE_KEY);
  } catch {
    // The cache may be unavailable during shutdown.
  }
}

async function persistSession(value) {
  try {
    await writeVaultSession(value);
  } catch {
    await writeVaultSession(value);
  }
}

async function hydrateAccess() {
  if (access && access.sessionId === session?.sessionId && usable(access)) return access;
  access = null;
  if (!session || !persistenceAllowed()) return null;
  const stored = await readAccessCache();
  if (stored && stored.sessionId === session.sessionId && usable(stored)) {
    access = stored;
    return stored;
  }
  return null;
}

async function invalidateSession() {
  generation++;
  loaded = true;
  session = null;
  persisted = false;
  access = null;
  if (!persistenceAllowed()) return true;
  const cleared = await Promise.allSettled([
    deleteVaultSession(),
    chrome.storage.session.remove([ACCESS_CACHE_KEY, SESSION_CACHE_KEY])
  ]);
  return cleared.every(({ status }) => status === "fulfilled");
}

export async function getSessionStatus() {
  const current = await loadSession();
  return {
    connected: Boolean(current),
    hasSession: Boolean(current),
    persisted: Boolean(current) && persisted,
    models: current?.models || []
  };
}

export async function connectSession({ tokens, clientId, models, expiresAt, persist = true }) {
  const current = await loadSession();
  if (current) throw new PlanError("Disconnect the current ChatGPT session before connecting again.");
  const refreshToken = tokens?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new PlanError("OpenAI did not grant a session that can be renewed. Try connecting again.", "PLAN_DISCONNECTED");
  }
  if (typeof clientId !== "string" || !clientId) throw new PlanError("OpenAI did not return an app registration.");
  if (typeof tokens.access_token !== "string" || !tokens.access_token || !Number.isFinite(expiresAt)) {
    throw new PlanError("OpenAI did not return a usable access token.", "PLAN_DISCONNECTED");
  }
  const list = Array.isArray(models) ? [...new Set(models.filter((model) => typeof model === "string" && model))] : [];
  if (!list.length) throw new PlanError("This account did not list any models for ChatGPT plan access.");

  const store = async () => {
    if (session) throw new PlanError("Disconnect the current ChatGPT session before connecting again.");
    generation++;
    // Honor a "stay signed in" change made while the sign-in was in progress.
    persistEnabled = persist !== false && persistEnabled && persistenceAllowed();
    session = {
      version: 1,
      sessionId: crypto.randomUUID(),
      refreshToken,
      clientId,
      scope: tokens.scope,
      models: list.slice(0, 100),
      updatedAt: Date.now()
    };
    loaded = true;
    persisted = false;

    if (persistEnabled) {
      try {
        await persistSession(session);
        persisted = true;
      } catch {
        await deleteVaultSession().catch(() => {});
      }
    }
    await cacheAccess({
      accessToken: tokens.access_token,
      expiresAt,
      sessionId: session.sessionId
    });
    return getSessionStatus();
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(REFRESH_LOCK, store) : store();
}

export async function setPersistence(enabled) {
  const requested = Boolean(enabled) && persistenceAllowed();
  const update = async () => {
    const current = await loadSession();
    const previous = persistEnabled;
    persistEnabled = requested;
    if (!current) return getSessionStatus();
    if (persistEnabled) {
      try {
        await persistSession(current);
        persisted = true;
      } catch {
        persistEnabled = previous;
        throw new PlanError("Could not save the ChatGPT session on this device.");
      }
    } else {
      if (persisted) {
        try {
          await deleteVaultSession();
        } catch {
          persistEnabled = previous;
          throw new PlanError("Could not remove the saved ChatGPT session. Try again in Settings.");
        }
      }
      persisted = false;
    }
    if (!access && persistenceAllowed()) access = await readAccessCache();
    await cacheAccess(access?.sessionId === current.sessionId ? access : null);
    return getSessionStatus();
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(REFRESH_LOCK, update) : update();
}

async function refreshAccess(at, force) {
  const current = await loadSession();
  if (!current) throw new PlanError("Connect your ChatGPT plan in YT Summaro Settings first.", "PLAN_DISCONNECTED");
  if (generation !== at) throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");
  if (!force) {
    const cached = await hydrateAccess();
    if (cached && generation === at) return snapshot(cached);
  } else {
    access = null;
    if (persistenceAllowed()) await removeAccessCache();
  }
  if (generation !== at) throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");

  const renewed = await refreshPlanSession(
    { refresh_token: current.refreshToken, scope: current.scope },
    current.clientId
  );
  if (generation !== at) throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");
  const rotated = renewed.tokens.refresh_token;
  const next = {
    ...current,
    refreshToken: typeof rotated === "string" && rotated ? rotated : current.refreshToken,
    scope: renewed.tokens.scope || current.scope,
    updatedAt: Date.now()
  };

  if (persistEnabled) {
    try {
      await persistSession(next);
      if (generation !== at) {
        await deleteVaultSession().catch(() => {});
        throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");
      }
      persisted = true;
    } catch (error) {
      if (error?.code === "PLAN_DISCONNECTED") throw error;
      persisted = false;
      await deleteVaultSession().catch(() => {});
    }
  } else if (persisted) {
    persisted = false;
    await deleteVaultSession().catch(() => {});
  }

  if (generation !== at) throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");
  session = next;
  const candidate = {
    accessToken: renewed.tokens.access_token,
    expiresAt: renewed.expiresAt,
    sessionId: next.sessionId
  };
  await cacheAccess(candidate);
  return snapshot(candidate);
}

export async function getAccessToken({ force = false } = {}) {
  if (refreshPromise && refreshPromiseGeneration === generation) return refreshPromise;
  const at = generation;
  const current = await loadSession();
  if (!current) throw new PlanError("Connect your ChatGPT plan in YT Summaro Settings first.", "PLAN_DISCONNECTED");
  if (!force) {
    const cached = await hydrateAccess();
    if (cached && generation === at) return snapshot(cached);
  }
  if (generation !== at) throw new PlanError("The sign-in changed while the session was renewing.", "PLAN_DISCONNECTED");
  if (refreshPromise && refreshPromiseGeneration === generation) return refreshPromise;

  const task = (async () => {
    const locks = globalThis.navigator?.locks;
    const runRefresh = () => refreshAccess(at, force);
    try {
      return locks?.request
        ? await locks.request(REFRESH_LOCK, runRefresh)
        : await runRefresh();
    } catch (error) {
      if (error?.code === "PLAN_DISCONNECTED" && generation === at) await invalidateSession();
      throw error;
    }
  })();
  refreshPromise = task;
  refreshPromiseGeneration = at;
  return task.finally(() => {
    if (refreshPromise === task) {
      refreshPromise = null;
      refreshPromiseGeneration = -1;
    }
  });
}

export async function disconnectSession() {
  const clear = async () => {
    const current = await loadSession();
    const localCleared = await invalidateSession();
    const result = localCleared ? {} : { localCleared: false };
    if (!current) return { ...result, revoked: null };
    let revoked = false;
    try {
      revoked = await revokeSession({ refresh_token: current.refreshToken }, current.clientId);
    } catch {
      revoked = false;
    }
    return { ...result, revoked };
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(REFRESH_LOCK, clear) : clear();
}

export { invalidateSession };
