import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PlanError } from "../extension/plan-auth.js";

const ACCESS_KEY = "planAccessToken";
const SESSION_KEY = "planTransientSession";
const source = readFileSync(new URL("../extension/plan-session.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "")
  .replace(/^export /gm, "");

function harness(options = {}) {
  const state = {
    persisted: options.persisted ? structuredClone(options.persisted) : null,
    events: [],
    refreshCalls: 0,
    revokeCalls: 0,
    failWrites: options.failWrites || 0,
    failDelete: false,
    cache: new Map(Object.entries(options.cache || {}))
  };
  const refreshPlanSession = options.refresh || (async (tokens) => {
    state.refreshCalls++;
    state.events.push("refresh");
    return {
      tokens: { ...tokens, access_token: "access-2", refresh_token: "refresh-2" },
      expiresAt: Date.now() + 3_600_000
    };
  });
  const context = {
    crypto,
    Date,
    PlanError,
    navigator: { locks: { request: (_name, task) => task() } },
    refreshPlanSession,
    revokeSession: async () => {
      state.revokeCalls++;
      state.events.push("revoke");
      return true;
    },
    readVaultSession: async () => state.persisted ? structuredClone(state.persisted) : null,
    writeVaultSession: async (value) => {
      if (state.failWrites > 0) {
        state.failWrites--;
        state.events.push("write-fail");
        throw new Error("vault write failed");
      }
      state.events.push("write");
      state.persisted = structuredClone(value);
    },
    deleteVaultSession: async () => {
      if (state.failDelete) throw new Error("vault delete failed");
      state.events.push("delete");
      state.persisted = null;
    },
    chrome: {
      extension: { inIncognitoContext: Boolean(options.incognito) },
      storage: {
        session: {
          get: async (key) => state.cache.has(key) ? { [key]: structuredClone(state.cache.get(key)) } : {},
          set: async (values) => {
            for (const [key, value] of Object.entries(values)) state.cache.set(key, structuredClone(value));
          },
          remove: async (keys) => { for (const key of [keys].flat()) state.cache.delete(key); }
        }
      }
    }
  };
  const api = runInNewContext(
    `(() => { ${source}\nreturn { getSessionStatus, connectSession, setPersistence, getAccessToken, disconnectSession, invalidateSession }; })()`,
    context,
    { filename: "plan-session.js" }
  );
  state.api = api;
  state.chrome = context.chrome;
  return state;
}

const connect = (app, overrides = {}) => app.api.connectSession({
  tokens: {
    access_token: "access-1",
    refresh_token: "refresh-1",
    scope: "openid chatgpt.tokens.use.direct"
  },
  clientId: "oaiapp_test",
  models: ["test-model"],
  expiresAt: Date.now() + 3_600_000,
  ...overrides
});

test("stores the refresh token and reuses the cached access token", async () => {
  const app = harness();
  expect(await connect(app)).toEqual({
    connected: true, hasSession: true, persisted: true, models: ["test-model"]
  });
  expect(app.persisted).toMatchObject({
    version: 1, refreshToken: "refresh-1", clientId: "oaiapp_test", models: ["test-model"]
  });
  expect(app.cache.get(ACCESS_KEY)).toMatchObject({ accessToken: "access-1" });

  const token = await app.api.getAccessToken();
  expect(token).toMatchObject({ accessToken: "access-1", models: ["test-model"] });
  expect(app.refreshCalls).toBe(0);
});

test("persists a rotated refresh token before returning the new access token", async () => {
  const app = harness();
  await connect(app);
  app.events.length = 0;

  const token = await app.api.getAccessToken({ force: true });
  expect(token.accessToken).toBe("access-2");
  expect(app.events).toEqual(["refresh", "write"]);
  expect(app.persisted.refreshToken).toBe("refresh-2");
  expect(app.cache.get(ACCESS_KEY)).toMatchObject({ accessToken: "access-2" });
});

test("concurrent refreshes share one request", async () => {
  const app = harness({
    refresh: async (tokens) => {
      app.refreshCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        tokens: { ...tokens, access_token: "access-2", refresh_token: "refresh-2" },
        expiresAt: Date.now() + 3_600_000
      };
    }
  });
  await connect(app);
  const [first, second] = await Promise.all([
    app.api.getAccessToken({ force: true }),
    app.api.getAccessToken({ force: true })
  ]);
  expect(app.refreshCalls).toBe(1);
  expect(first.accessToken).toBe("access-2");
  expect(second.accessToken).toBe("access-2");
});

test("a forced refresh does not join a plain cached-access read", async () => {
  const first = harness();
  await connect(first);
  const app = harness({
    persisted: first.persisted,
    cache: Object.fromEntries(first.cache)
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalGet = app.chrome.storage.session.get;
  let blocked;
  const blockedOnce = new Promise((resolve) => { blocked = resolve; });
  app.chrome.storage.session.get = async (key) => {
    blocked();
    await gate;
    return originalGet(key);
  };

  const cached = app.api.getAccessToken();
  await blockedOnce;
  const forced = app.api.getAccessToken({ force: true });
  release();
  expect((await forced).accessToken).toBe("access-2");
  await cached;
  expect(app.refreshCalls).toBe(1);
});

test("a revoked grant wipes the vault and disconnects", async () => {
  const app = harness({
    refresh: async () => {
      throw new PlanError("The ChatGPT session expired or was revoked. Reconnect in Settings.", "PLAN_DISCONNECTED");
    }
  });
  await connect(app);
  await expect(app.api.getAccessToken({ force: true })).rejects.toMatchObject({ code: "PLAN_DISCONNECTED" });
  expect(app.persisted).toBeNull();
  expect(app.cache.has(ACCESS_KEY)).toBe(false);
  expect(await app.api.getSessionStatus()).toMatchObject({ connected: false, persisted: false });
});

test("a failed refresh write is retried once, then the vault is wiped", async () => {
  const app = harness();
  await connect(app);
  app.events.length = 0;
  app.failWrites = 1;
  expect((await app.api.getAccessToken({ force: true })).accessToken).toBe("access-2");
  expect(app.events).toEqual(["refresh", "write-fail", "write"]);
  expect(app.persisted.refreshToken).toBe("refresh-2");

  app.failWrites = 2;
  expect((await app.api.getAccessToken({ force: true })).accessToken).toBe("access-2");
  expect(app.persisted).toBeNull();
  expect(await app.api.getSessionStatus()).toMatchObject({ connected: true, persisted: false });
});

test("session-only mode keeps tokens in memory and can persist later", async () => {
  const app = harness();
  expect(await connect(app, { persist: false })).toMatchObject({ connected: true, persisted: false });
  expect(app.persisted).toBeNull();
  expect(app.events).toEqual([]);
  expect(app.cache.get(SESSION_KEY)).toMatchObject({ refreshToken: "refresh-1" });
  expect((await app.api.getAccessToken()).accessToken).toBe("access-1");

  expect(await app.api.setPersistence(true)).toMatchObject({ connected: true, persisted: true });
  expect(app.persisted.refreshToken).toBe("refresh-1");
  expect(app.cache.get(ACCESS_KEY)).toMatchObject({ accessToken: "access-1" });
  expect(app.cache.get(SESSION_KEY)).toBeNull();

  expect(await app.api.setPersistence(false)).toMatchObject({ connected: true, persisted: false });
  expect(app.persisted).toBeNull();
  expect(app.cache.get(SESSION_KEY)).toMatchObject({ refreshToken: "refresh-1" });
});

test("session-only sign-in survives worker restarts and refreshes without a disk write", async () => {
  const first = harness();
  await connect(first, { persist: false });
  const restarted = harness({ cache: Object.fromEntries(first.cache) });
  expect(await restarted.api.getSessionStatus()).toMatchObject({ connected: true, persisted: false });
  expect((await restarted.api.getAccessToken()).accessToken).toBe("access-1");
  expect((await restarted.api.getAccessToken({ force: true })).accessToken).toBe("access-2");
  expect(restarted.cache.get(SESSION_KEY)).toMatchObject({ refreshToken: "refresh-2" });
  expect(restarted.persisted).toBeNull();
  await restarted.api.disconnectSession();
  expect(restarted.cache.has(SESSION_KEY)).toBe(false);
  expect(await harness().api.getSessionStatus()).toMatchObject({ connected: false });
});

test("failed vault deletion is reported when disabling persistence or disconnecting", async () => {
  const app = harness();
  await connect(app);
  app.failDelete = true;
  await expect(app.api.setPersistence(false)).rejects.toThrow("Could not remove the saved ChatGPT session");
  expect(await app.api.getSessionStatus()).toMatchObject({ connected: true, persisted: true });
  expect(await app.api.disconnectSession()).toEqual({ localCleared: false, revoked: true });
  expect(app.cache.has(ACCESS_KEY)).toBe(false);
});

test("a restarted worker restores the vault and the session access cache", async () => {
  const first = harness();
  await connect(first);
  const second = harness({
    persisted: first.persisted,
    cache: Object.fromEntries(first.cache)
  });
  expect(await second.api.getSessionStatus()).toMatchObject({
    connected: true, hasSession: true, persisted: true, models: ["test-model"]
  });
  expect((await second.api.getAccessToken()).accessToken).toBe("access-1");
  expect(second.refreshCalls).toBe(0);
});

test("incognito sessions are never written to the vault", async () => {
  const app = harness({ incognito: true });
  expect(await connect(app)).toMatchObject({ connected: true, persisted: false });
  expect(app.persisted).toBeNull();
  expect(app.events).toEqual([]);
  expect(await app.api.setPersistence(true)).toMatchObject({ connected: true, persisted: false });
  expect(app.persisted).toBeNull();
  expect((await app.api.getAccessToken()).accessToken).toBe("access-1");
});

test("disconnect revokes the grant and clears local state", async () => {
  const app = harness();
  await connect(app);
  app.events.length = 0;
  expect(await app.api.disconnectSession()).toEqual({ revoked: true });
  expect(app.revokeCalls).toBe(1);
  expect(app.persisted).toBeNull();
  expect(app.cache.has(ACCESS_KEY)).toBe(false);
  expect(await app.api.getSessionStatus()).toMatchObject({ connected: false, hasSession: false, persisted: false });
});
