const DB_NAME = "yt-summaro-vault";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const VAULT_STORE = "vault";
const KEY_ID = "wrap";
const VAULT_ID = "session";
const ENVELOPE_VERSION = 1;
const AAD = new TextEncoder().encode("yt-summaro:vault:v1");

export class VaultError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

let dbPromise;
let keyPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("Could not open the session vault."));
    request.onblocked = () => reject(new Error("The session vault is blocked by another tab."));
  }).catch((error) => {
    dbPromise = undefined;
    throw error;
  });
  return dbPromise;
}

function run(store, mode, operation) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let request;
    try {
      request = operation(transaction.objectStore(store));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error || request?.error || new Error("The session vault transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("The session vault transaction was aborted."));
  }));
}

function read(store, key) {
  return run(store, "readonly", (objectStore) => objectStore.get(key));
}

function write(store, key, value) {
  return run(store, "readwrite", (objectStore) => objectStore.put(value, key));
}

async function readKey() {
  const key = await read(KEY_STORE, KEY_ID);
  if (key) return key;
  return null;
}

async function wrapKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const existing = await readKey();
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await write(KEY_STORE, KEY_ID, key);
    return key;
  })().finally(() => {
    keyPromise = undefined;
  });
  return keyPromise;
}

export async function encryptSessionPayload(session, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plaintext);
  return { v: ENVELOPE_VERSION, iv, ciphertext };
}

export async function decryptSessionPayload(envelope, key) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION || !(envelope.iv instanceof Uint8Array) ||
      envelope.iv.length !== 12 || !(envelope.ciphertext instanceof ArrayBuffer) ||
      envelope.ciphertext.byteLength < 16) {
    throw new VaultError("The saved session has an unsupported format.", "VAULT_CORRUPT");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: envelope.iv, additionalData: AAD },
    key,
    envelope.ciphertext
  );
  const value = JSON.parse(new TextDecoder().decode(plaintext));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError("The saved session is not readable.", "VAULT_CORRUPT");
  }
  return value;
}

export async function readVaultSession() {
  const envelope = await read(VAULT_STORE, VAULT_ID);
  if (!envelope) return null;
  const key = await readKey();
  if (!key) {
    await deleteVaultSession().catch(() => {});
    return null;
  }
  try {
    return await decryptSessionPayload(envelope, key);
  } catch (error) {
    await deleteVaultSession().catch(() => {});
    throw error instanceof VaultError
      ? error
      : new VaultError("The saved ChatGPT session could not be read.", "VAULT_CORRUPT");
  }
}

export async function writeVaultSession(session) {
  const key = await wrapKey();
  const envelope = await encryptSessionPayload(session, key);
  await write(VAULT_STORE, VAULT_ID, envelope);
}

export async function deleteVaultSession() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction([VAULT_STORE, KEY_STORE], "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Could not clear the saved ChatGPT session."));
    transaction.objectStore(VAULT_STORE).delete(VAULT_ID);
    transaction.objectStore(KEY_STORE).delete(KEY_ID);
  });
}
