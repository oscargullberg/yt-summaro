import { callbackRule, parseCallback, PlanError, startAuthorization } from "./plan-auth.js";

const callbackUrl = chrome.runtime.getURL("plan-callback.html");

function waitForCallback(tabId, tx, registeredId) {
  let resolve, reject;
  const result = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  const onMessage = (message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id !== tabId || sender.frameId !== 0 ||
        sender.url?.split("#")[0] !== callbackUrl || message?.type !== "plan-callback") return;
    chrome.runtime.onMessage.removeListener(onMessage);
    reply({ accepted: true });
    try { resolve(parseCallback(message.query, tx.state, registeredId)); } catch (error) { reject(error); }
  };
  const onRemoved = (closed) => { if (closed === tabId) reject(new PlanError("The sign-in tab was closed.")); };
  const timer = setTimeout(() => reject(new PlanError("ChatGPT sign-in timed out.")), 180_000);
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.tabs.onRemoved.addListener(onRemoved);
  return { result, dispose() {
    clearTimeout(timer);
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.tabs.onRemoved.removeListener(onRemoved);
  } };
}

export async function signInToPlan(send) {
  const { planHostId = `urn:uuid:${crypto.randomUUID()}`, planClientId } = await chrome.storage.local.get(["planHostId", "planClientId"]);
  await chrome.storage.local.set({ planHostId });
  const port = 49152 + crypto.getRandomValues(new Uint16Array(1))[0] % 16384;
  const { tx, url } = await startAuthorization(planHostId, port, planClientId);
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (!Number.isInteger(tab.id) || tab.id < 1) throw new PlanError("Could not open a ChatGPT sign-in tab.");
  let wait;
  let callback;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab.id], addRules: [callbackRule(tab.id, tx, callbackUrl)] });
    wait = waitForCallback(tab.id, tx, planClientId);
    [callback] = await Promise.all([wait.result, chrome.tabs.update(tab.id, { url })]);
  } finally {
    wait?.dispose();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tab.id] }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
  const connection = await send("plan:connect", { tx, callback });
  // OAuth registration IDs identify clients but grant no account access by themselves.
  await chrome.storage.local.set({ planClientId: callback.clientId });
  return connection;
}
