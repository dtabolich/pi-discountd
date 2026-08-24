import test from "node:test";
import assert from "node:assert/strict";
import discountdExtension from "../extensions/discountd.ts";

test("discountd pick registers and switches to openrouter provider even when model exists in native provider", async () => {
  let registeredHandler: any = null;
  let providerRegistered: { name: string; config: any } | null = null;
  let activeModel: any = {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
  };
  const notifications: Array<{ msg: string; type: string }> = [];

  const mockPi: any = {
    on: () => {},
    registerCommand: (_name: string, opts: any) => {
      registeredHandler = opts.handler;
    },
    registerProvider: (name: string, config: any) => {
      providerRegistered = { name, config };
    },
    setModel: async (model: any) => {
      activeModel = model;
      return true;
    },
    sendMessage: () => {},
  };

  discountdExtension(mockPi);
  assert.ok(registeredHandler, "discountd command should be registered");

  // Mock registry: user has direct DeepSeek configured as their available / active provider
  const availableModels = [
    {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextWindow: 1000000,
      maxTokens: 8192,
      api: "openai-completions",
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      input: ["text"],
      reasoning: true,
    },
  ];

  const allModels = [...availableModels];

  const mockCtx: any = {
    model: activeModel,
    modelRegistry: {
      getAvailable: async () => availableModels,
      getAll: () => allModels,
      getProviderAuth: async (provider: string) => {
        if (provider === "openrouter")
          return { auth: { apiKey: "sk-or-test" } };
        return undefined;
      },
      find: (provider: string, id: string) => {
        if (provider === "openrouter") {
          const registered = providerRegistered?.config.models.find(
            (m: any) => m.id === id,
          );
          if (registered) {
            return {
              provider: "openrouter",
              ...registered,
            };
          }
        }
        return allModels.find(
          (m: any) => m.provider === provider && m.id === id,
        );
      },
    },
    ui: {
      notify: (msg: string, type: string) => {
        notifications.push({ msg, type });
      },
      select: async () => undefined,
    },
  };

  // Run `/discountd pick deepseek/deepseek-v4-flash`
  await registeredHandler("pick deepseek/deepseek-v4-flash", mockCtx);

  // Assertions:
  assert.ok(
    providerRegistered,
    "OpenRouter provider should be registered on-the-fly",
  );
  assert.equal(providerRegistered.name, "openrouter");
  assert.ok(
    providerRegistered.config.models.some(
      (m: any) => m.id === "deepseek/deepseek-v4-flash",
    ),
    "Model deepseek/deepseek-v4-flash should be registered in openrouter provider",
  );

  // Crucially: active model must be openrouter/deepseek/deepseek-v4-flash, NOT native deepseek
  assert.equal(
    activeModel.provider,
    "openrouter",
    "Active model provider MUST be openrouter",
  );
  assert.equal(activeModel.id, "deepseek/deepseek-v4-flash");
  assert.ok(
    notifications.some((n) =>
      n.msg.includes("Switched to OpenRouter: deepseek/deepseek-v4-flash"),
    ),
    "Should notify about switching to OpenRouter",
  );
});

test("discountd pick preserves existing openrouter models when adding a new deal model", async () => {
  let providerRegistered: { name: string; config: any } | null = null;
  const mockPi: any = {
    on: () => {},
    registerCommand: (_name: string, opts: any) => {
      registeredHandler = opts.handler;
    },
    registerProvider: (name: string, config: any) => {
      providerRegistered = { name, config };
    },
    setModel: async () => true,
    sendMessage: () => {},
  };

  let registeredHandler: any;
  discountdExtension(mockPi);

  const existingOpenRouterModel = {
    provider: "openrouter",
    id: "openai/gpt-5",
    name: "OpenAI: GPT-5",
    contextWindow: 400000,
    maxTokens: 128000,
    api: "openai-completions",
    cost: { input: 0.625, output: 5, cacheRead: 0.0625, cacheWrite: 0 },
    input: ["text", "image"],
    reasoning: true,
  };

  const mockCtx: any = {
    model: existingOpenRouterModel,
    modelRegistry: {
      getAvailable: async () => [existingOpenRouterModel],
      getAll: () => [existingOpenRouterModel],
      getProviderAuth: async () => ({ auth: { apiKey: "sk-or-test" } }),
      find: (provider: string, id: string) => {
        if (provider === "openrouter") {
          return providerRegistered?.config.models.find(
            (m: any) => m.id === id,
          );
        }
        return undefined;
      },
    },
    ui: {
      notify: () => {},
      select: async () => undefined,
    },
  };

  await registeredHandler("pick solar-pro4", mockCtx);

  assert.ok(providerRegistered);
  const registered: { name: string; config: any } = providerRegistered;
  const modelIds = registered.config.models.map((m: any) => m.id);
  assert.ok(
    modelIds.includes("openai/gpt-5"),
    "Existing openrouter model should be preserved",
  );
  assert.ok(
    modelIds.includes("upstage/solar-pro4"),
    "New deal model should be included",
  );
});

test("discountd pick notifies error when OpenRouter is unconfigured and activation fails", async () => {
  let providerRegistered: { name: string; config: any } | null = null;
  const notifications: Array<{ msg: string; type: string }> = [];

  const mockPi: any = {
    on: () => {},
    registerCommand: (_name: string, opts: any) => {
      registeredHandler = opts.handler;
    },
    registerProvider: (name: string, config: any) => {
      providerRegistered = { name, config };
    },
    setModel: async () => false, // pi.setModel returns false when no auth available
    sendMessage: () => {},
  };

  let registeredHandler: any;
  discountdExtension(mockPi);

  const mockCtx: any = {
    model: undefined,
    modelRegistry: {
      getAvailable: async () => [],
      getAll: () => [],
      getProviderAuth: async () => undefined,
      find: (provider: string, id: string) => {
        if (provider === "openrouter") {
          return providerRegistered?.config.models.find(
            (m: any) => m.id === id,
          );
        }
        return undefined;
      },
    },
    ui: {
      notify: (msg: string, type: string) => {
        notifications.push({ msg, type });
      },
      select: async () => undefined,
    },
  };

  await registeredHandler("pick deepseek/deepseek-v4-flash", mockCtx);

  assert.ok(
    notifications.some(
      (n) =>
        n.type === "error" && n.msg.includes("OpenRouter isn't configured"),
    ),
    "Should notify error that OpenRouter is not configured",
  );
});

test("discountd interactive pick shows CURRENT and READY markers correctly", async () => {
  let registeredHandler: any;
  let selectedOption: string | null = null;
  let promptItems: string[] = [];
  let setModelCalledWith: any = null;

  const mockPi: any = {
    on: () => {},
    registerCommand: (_name: string, opts: any) => {
      registeredHandler = opts.handler;
    },
    registerProvider: (_name: string, _config: any) => {},
    setModel: async (model: any) => {
      setModelCalledWith = model;
      return true;
    },
    sendMessage: () => {},
  };

  discountdExtension(mockPi);

  const currentActiveModel = {
    provider: "openrouter",
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
  };

  const mockCtx: any = {
    model: currentActiveModel,
    modelRegistry: {
      getAvailable: async () => [currentActiveModel],
      getAll: () => [currentActiveModel],
      getProviderAuth: async () => ({ auth: { apiKey: "sk-or-test" } }),
      find: (_provider: string, id: string) => ({ provider: "openrouter", id }),
    },
    ui: {
      notify: () => {},
      select: async (_prompt: string, items: string[]) => {
        promptItems = items;
        // Select an item that isn't current
        const other = items.find((item) => item.includes("upstage/solar-pro4"));
        selectedOption = other || items[0];
        return selectedOption;
      },
    },
  };

  await registeredHandler("pick", mockCtx);

  assert.ok(promptItems.length > 0, "Should have prompt items");
  // Find current model's row in picker
  const currentRow = promptItems.find((item) =>
    item.includes("deepseek/deepseek-v4-flash"),
  );
  assert.ok(
    currentRow?.includes("CURRENT"),
    "Current session model should be marked CURRENT",
  );

  const otherRow = promptItems.find((item) =>
    item.includes("upstage/solar-pro4"),
  );
  assert.ok(
    otherRow?.includes("READY"),
    "Other models should be marked READY when auth is configured",
  );

  assert.ok(setModelCalledWith, "Model should be activated");
});
