import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, "..", "setup.sh");
const PLUGIN_DIR = join(HERE, "..");
const PLUGIN_URL = `file://${PLUGIN_DIR}`;

/**
 * Run setup.sh in register-only mode against a config file.
 */
function register(configPath: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    "bash",
    [
      SETUP,
      "--register-only",
      "--dir",
      PLUGIN_DIR,
      "--config",
      configPath,
    ],
    { encoding: "utf-8" }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Strip JSONC comments (the config keeps them, JSON.parse does not).
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const d = text[i + 1] ?? "";

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && d === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && d === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && d === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function withConfig(
  content: string | null,
  fn: (configPath: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), "opencode-voice-cfg-"));
  const configPath = join(dir, "opencode.jsonc");
  if (content !== null) writeFileSync(configPath, content);
  try {
    fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the setup script registers the plugin without destroying the config", () => {
  test("an existing plugins array keeps its comments and formatting", () => {
    const original = `{
  // OpenCode config
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3:8b", /* inline comment */
  "plugins": [
    "opencode-mem@2.32.0"
  ]
}
`;
    withConfig(original, (configPath) => {
      const result = register(configPath);
      assert.equal(result.status, 0, result.stderr);

      const updated = readFileSync(configPath, "utf-8");
      assert.ok(updated.includes("// OpenCode config"), "comments must survive");
      assert.ok(updated.includes("/* inline comment */"));
      assert.ok(updated.includes('"opencode-mem@2.32.0"'));
      assert.ok(updated.includes(`"${PLUGIN_URL}"`));

      // The original entry must not be duplicated and the file must stay
      // valid JSONC (comments aside).
      const parsed = JSON.parse(stripJsonComments(updated));
      assert.deepEqual(parsed.plugins, [
        "opencode-mem@2.32.0",
        PLUGIN_URL,
      ]);
    });
  });

  test("a missing plugins property is created", () => {
    const original = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "x"
}
`;
    withConfig(original, (configPath) => {
      const result = register(configPath);
      assert.equal(result.status, 0, result.stderr);

      const updated = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(updated);
      assert.deepEqual(parsed.plugins, [PLUGIN_URL]);
      assert.equal(parsed.model, "x");
    });
  });

  test("the legacy plugin array is used as a fallback", () => {
    const original = `{
  "plugin": [
    "some-other-plugin"
  ]
}
`;
    withConfig(original, (configPath) => {
      register(configPath);
      const updated = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(updated);
      assert.deepEqual(parsed.plugin, ["some-other-plugin", PLUGIN_URL]);
      assert.equal(parsed.plugins, undefined);
    });
  });

  test("running it twice does not add a duplicate entry", () => {
    const original = `{
  "plugins": [
    "opencode-mem@2.32.0"
  ]
}
`;
    withConfig(original, (configPath) => {
      register(configPath);
      const first = readFileSync(configPath, "utf-8");
      const result = register(configPath);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("already registered"));

      const second = readFileSync(configPath, "utf-8");
      assert.equal(first, second, "the config must not change on a second run");

      const parsed = JSON.parse(second);
      assert.equal(parsed.plugins.length, 2);
    });
  });

  test("an entry for a different opencode-voice path is not duplicated", () => {
    const original = `{
  "plugins": [
    "file:///somewhere/else/opencode-voice"
  ]
}
`;
    withConfig(original, (configPath) => {
      const result = register(configPath);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("already registered"));

      const updated = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(updated);
      assert.deepEqual(parsed.plugins, ["file:///somewhere/else/opencode-voice"]);
    });
  });

  test("a missing config file is created", () => {
    withConfig(null, (configPath) => {
      const result = register(configPath);
      assert.equal(result.status, 0, result.stderr);

      const updated = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(updated);
      assert.deepEqual(parsed.plugins, [PLUGIN_URL]);
      assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    });
  });

  test("a single line array keeps its shape", () => {
    const original = `{ "plugins": ["one"] }`;
    withConfig(original, (configPath) => {
      register(configPath);
      const updated = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(updated);
      assert.deepEqual(parsed.plugins, ["one", PLUGIN_URL]);
    });
  });
});
