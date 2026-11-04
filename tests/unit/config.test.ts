import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../../src/config/index.ts";

test("仅接受精确扩展来源和本机回环监听地址", () => {
  const config = readConfig({
    LOCAL_FOLDER_HOST: "127.0.0.1",
    LOCAL_FOLDER_PORT: "8765",
    CEBIAN_EXTENSION_ORIGINS: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,moz-extension://123e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal(config.allowedOrigins.size, 2);
  assert.throws(() => readConfig({ LOCAL_FOLDER_HOST: "0.0.0.0" }), /回环地址/);
  assert.throws(() => readConfig({ CEBIAN_EXTENSION_ORIGINS: "https://example.com" }), /只接受精确/);
  assert.throws(() => readConfig({ CEBIAN_EXTENSION_ORIGINS: "chrome-extension://extension-id/extra" }), /只接受精确/);
});
