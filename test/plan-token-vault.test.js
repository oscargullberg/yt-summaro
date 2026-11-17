import { expect, test } from "bun:test";
import { decryptSessionPayload, encryptSessionPayload, VaultError } from "../extension/plan-token-vault.js";

const session = {
  version: 1,
  sessionId: "session-1",
  refreshToken: "refresh-token",
  clientId: "oaiapp_test",
  scope: "openid chatgpt.tokens.use.direct",
  models: ["test-model"],
  updatedAt: 1
};

const newKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

test("encrypts a session with a fresh IV and a non-extractable AES-GCM key", async () => {
  const key = await newKey();
  const first = await encryptSessionPayload(session, key);
  const second = await encryptSessionPayload(session, key);

  expect(first.v).toBe(1);
  expect(first.iv).toHaveLength(12);
  expect(first.ciphertext).toBeInstanceOf(ArrayBuffer);
  expect(Buffer.from(first.iv).equals(Buffer.from(second.iv))).toBe(false);
  expect(await decryptSessionPayload(first, key)).toEqual(session);
  expect(key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
});

test("rejects tampered ciphertext, a different key, and unsupported envelopes", async () => {
  const key = await newKey();
  const envelope = await encryptSessionPayload(session, key);
  const otherKey = await newKey();
  await expect(decryptSessionPayload(envelope, otherKey)).rejects.toThrow();

  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(1) };
  await expect(decryptSessionPayload(tampered, key)).rejects.toThrow();

  for (const invalid of [
    { ...envelope, v: 2 },
    { ...envelope, iv: new Uint8Array(11) },
    { ...envelope, ciphertext: new Uint8Array(envelope.ciphertext) },
    null
  ]) {
    try {
      await decryptSessionPayload(invalid, key);
      throw new Error("Expected the envelope to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect(error.code).toBe("VAULT_CORRUPT");
    }
  }
});
