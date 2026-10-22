import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
  const custom = available.find((item) => item.id === "test-openai/test-model");
  assert.ok(custom);
  assert.equal(typeof custom.reasoning, "boolean");
  assert.ok(custom.thinkingLevels.length > 0);

  assert.equal(models.deletePiProvider("test-openai"), true);
  assert.equal(models.piProviders().some((item) => item.id === "test-openai"), false);
});

test("custom models inherit built-in thinking metadata by normalized name", async () => {
  models.savePiProvider({
    id: "test-thinking",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "sk-test",
    models: ["deepseek-v4.1-flash", "glm-5.3-flash", "unmatched-model"],
  });

  const runtime = await models.createModelRuntime();
  const deepseek = runtime.getModel("test-thinking", "deepseek-v4.1-flash");
  const glm = runtime.getModel("test-thinking", "glm-5.3-flash");
  assert.ok(deepseek);
  assert.ok(glm);

  const deepseekEffective = models.applyBuiltinCapabilities(deepseek);
  assert.equal(deepseekEffective.reasoning, true);
  assert.equal(
    (deepseekEffective.compat as Record<string, unknown>).thinkingFormat,
    "deepseek",
  );
  assert.equal(
    (deepseekEffective.compat as Record<string, unknown>).requiresReasoningContentOnAssistantMessages,
    true,
  );

  const glmEffective = models.applyBuiltinCapabilities(glm);
  assert.equal(glmEffective.reasoning, true);
  assert.equal((glmEffective.compat as Record<string, unknown>).thinkingFormat, "zai");
  assert.equal((glmEffective.compat as Record<string, unknown>).supportsReasoningEffort, true);

  const listed = await models.listModels(runtime);
  const deepseekListed = listed.find((item) => item.id === "test-thinking/deepseek-v4.1-flash");
  const glmListed = listed.find((item) => item.id === "test-thinking/glm-5.3-flash");
  const unmatched = listed.find((item) => item.id === "test-thinking/unmatched-model");
  assert.ok(deepseekListed);
  assert.ok(glmListed);
  assert.ok(unmatched);
  assert.deepEqual(deepseekListed.thinkingLevels, ["off", "low", "high", "max"]);
  assert.deepEqual(glmListed.thinkingLevels, ["low", "high", "max"]);
  assert.equal(unmatched.reasoning, false);
  assert.deepEqual(unmatched.thinkingLevels, ["off"]);

  models.deletePiProvider("test-thinking");
});

test("explicit reasoning false opts out of built-in capability inheritance", async () => {
  models.savePiProvider({
    id: "test-no-thinking",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey: "sk-test",
    models: ["glm-5.3-flash"],
  });

  const file = path.join(agentDir, "models.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.providers["test-no-thinking"].models[0].reasoning = false;
  fs.writeFileSync(file, JSON.stringify(data));

  const runtime = await models.createModelRuntime();
  const listed = await models.listModels(runtime);
  const glmListed = listed.find((item) => item.id === "test-no-thinking/glm-5.3-flash");
  assert.ok(glmListed);
  assert.equal(glmListed.reasoning, false);
  assert.deepEqual(glmListed.thinkingLevels, ["off"]);

  models.deletePiProvider("test-no-thinking");
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

test("provider models can be pulled with the saved key", async () => {
  let authorization = "";
  const server = http.createServer((req, res) => {
    authorization = String(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");

  try {
    models.savePiProvider({
      id: "test-pull",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "sk-saved",
      models: ["model-a"],
    });

    const result = await models.fetchPiProviderModels({
      id: "test-pull",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "",
    });

    assert.deepEqual(result.models, ["model-a", "model-b"]);
    assert.equal(authorization, "Bearer sk-saved");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    models.deletePiProvider("test-pull");
  }
});
