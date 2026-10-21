import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "easel-pi-models-"));
process.env.EASEL_PI_AGENT_DIR = agentDir;
delete process.env.EASEL_DIRECT_API_BASE_URL;
delete process.env.EASEL_DIRECT_API_MODEL;
delete process.env.EASEL_DIRECT_API_KEY;

const models = await import("./models.js");

test.after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("custom providers are written to models.json and become available", async () => {
  const saved = models.savePiProvider({
    id: "test-openai",
    name: "Test OpenAI",
    baseUrl: "https://example.test/v1/",
    api: "openai-completions",
    apiKey: "sk-test",
    models: ["test-model"],
  });

  assert.equal(saved.id, "test-openai");
  assert.equal(saved.baseUrl, "https://example.test/v1");
  assert.equal(saved.keyMasked, "••••test");

  const file = path.join(agentDir, "models.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.providers["test-openai"].api, "openai-completions");
  assert.equal(data.$schema, "https://pi.dev/schemas/models.schema.json");

  models.savePiProvider({
    id: "test-openai",
    name: "Updated",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "",
    models: ["test-model"],
  });
  const updated = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(updated.providers["test-openai"].name, "Updated");
  assert.equal(updated.providers["test-openai"].apiKey, "sk-test");

  const runtime = await models.createModelRuntime();
  const available = await models.listModels(runtime);
  assert.ok(available.some((item) => item.id === "test-openai/test-model"));

  assert.equal(models.deletePiProvider("test-openai"), true);
  assert.equal(models.piProviders().some((item) => item.id === "test-openai"), false);
});

test("easel-direct stays reserved for the .env mapping", () => {
  assert.throws(
    () => models.savePiProvider({
      id: "easel-direct",
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      models: ["test-model"],
    }),
    /easel-direct/,
  );
});
