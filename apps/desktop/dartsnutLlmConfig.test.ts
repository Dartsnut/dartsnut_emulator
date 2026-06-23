const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  DARTSNUT_MODEL_CONFIG_URL,
  decryptCryptoJsAesPayload,
  fetchDartsnutLlmConfig,
  parseDartsnutModelConfig,
  primeRuntimeDartsnutLlmConfig,
  resetRuntimeDartsnutLlmConfigForTests
} = require("./dist-electron/dartsnutLlmConfig.js");

function evpBytesToKey(passphrase, salt, keyLength, ivLength) {
  const chunks = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < keyLength + ivLength) {
    previous = crypto
      .createHash("md5")
      .update(Buffer.concat([previous, passphrase, salt]))
      .digest();
    chunks.push(previous);
  }
  const derived = Buffer.concat(chunks);
  return {
    key: derived.subarray(0, keyLength),
    iv: derived.subarray(keyLength, keyLength + ivLength)
  };
}

function encryptCryptoJsAesPayload(plainText, passphrase, salt = Buffer.from("12345678")) {
  const { key, iv } = evpBytesToKey(Buffer.from(passphrase, "utf8"), salt, 32, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, ciphertext]).toString("base64");
}

test("decryptCryptoJsAesPayload decrypts CryptoJS salted AES strings", () => {
  const encrypted = encryptCryptoJsAesPayload(
    JSON.stringify({ url: "https://mimo.example.com", tokenKey: "token-1", model: "mimo-model" }),
    "secret"
  );

  assert.deepEqual(JSON.parse(decryptCryptoJsAesPayload(encrypted, "secret")), {
    url: "https://mimo.example.com",
    tokenKey: "token-1",
    model: "mimo-model"
  });
});

test("parseDartsnutModelConfig reads value.url, value.key, and value.name", () => {
  assert.deepEqual(
    parseDartsnutModelConfig(
      JSON.stringify({
        value: {
          url: "https://mimo.example.com",
          key: "token-1",
          name: "mimo-model"
        }
      })
    ),
    {
      baseUrl: "https://mimo.example.com/v1",
      apiKey: "token-1",
      model: "mimo-model"
    }
  );
});

test("parseDartsnutModelConfig accepts value as a JSON string", () => {
  assert.deepEqual(
    parseDartsnutModelConfig(
      JSON.stringify({
        value: JSON.stringify({
          url: "https://mimo.example.com",
          key: "token-1",
          name: "mimo-model"
        })
      })
    ),
    {
      baseUrl: "https://mimo.example.com/v1",
      apiKey: "token-1",
      model: "mimo-model"
    }
  );
});

test("parseDartsnutModelConfig keeps top-level aliases as fallback", () => {
  assert.deepEqual(
    parseDartsnutModelConfig(
      JSON.stringify({
        url: "https://mimo.example.com",
        token_key: "token-1",
        model: "mimo-model"
      })
    ),
    {
      baseUrl: "https://mimo.example.com/v1",
      apiKey: "token-1",
      model: "mimo-model"
    }
  );
});

test("parseDartsnutModelConfig rejects invalid decrypted JSON", () => {
  assert.throws(() => parseDartsnutModelConfig("{"), /not valid JSON/);
});

test("parseDartsnutModelConfig rejects missing token and model", () => {
  assert.throws(() => parseDartsnutModelConfig(JSON.stringify({ tokenKey: "t", model: "m" })), /URL/);
  assert.throws(() => parseDartsnutModelConfig(JSON.stringify({ url: "https://mimo.example.com", model: "m" })), /token key/);
  assert.throws(() => parseDartsnutModelConfig(JSON.stringify({ url: "https://mimo.example.com", tokenKey: "t" })), /model/);
});

test("fetchDartsnutLlmConfig posts to model endpoint and decrypts data", async () => {
  const encrypted = encryptCryptoJsAesPayload(
    JSON.stringify({ value: { url: "https://mimo.example.com/v1", key: "token-1", name: "mimo-model" } }),
    "secret"
  );
  const calls = [];
  const config = await fetchDartsnutLlmConfig({
    env: { DARTSNUT_MODEL_DECRYPTION_KEY: "secret" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: encrypted })
      };
    }
  });

  assert.deepEqual(config, {
    baseUrl: "https://mimo.example.com/v1",
    apiKey: "token-1",
    model: "mimo-model"
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DARTSNUT_MODEL_CONFIG_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}");
});

test("primeRuntimeDartsnutLlmConfig caches successful fetches", async () => {
  resetRuntimeDartsnutLlmConfigForTests();
  const encrypted = encryptCryptoJsAesPayload(
    JSON.stringify({ value: { url: "https://mimo.example.com", key: "token-1", name: "mimo-model" } }),
    "secret"
  );
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: encrypted })
    };
  };

  const first = await primeRuntimeDartsnutLlmConfig({
    env: { DARTSNUT_MODEL_DECRYPTION_KEY: "secret" },
    fetchImpl
  });
  const second = await primeRuntimeDartsnutLlmConfig({
    env: { DARTSNUT_MODEL_DECRYPTION_KEY: "secret" },
    fetchImpl
  });

  assert.deepEqual(second, first);
  assert.equal(callCount, 1);
  resetRuntimeDartsnutLlmConfigForTests();
});
