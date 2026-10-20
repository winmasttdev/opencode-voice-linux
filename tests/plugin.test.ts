import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  API_KEY_PATH,
  SPEAK_DESCRIPTION,
  SPEAK_INPUT_SCHEMA,
  loadApiKey,
  speakExecute,
} from "../src/plugin.ts";
import { PLAYER_IDS } from "../src/playback.ts";

describe("the speak tool schema", () => {
  test("it is a plain json schema object", () => {
    assert.equal(SPEAK_INPUT_SCHEMA.type, "object");
    assert.equal(SPEAK_INPUT_SCHEMA.additionalProperties, false);
    assert.deepEqual(SPEAK_INPUT_SCHEMA.required, ["text"]);
  });

  test("text is the only required argument", () => {
    const properties = SPEAK_INPUT_SCHEMA.properties;
    assert.equal(properties.text.type, "string");
    for (const name of ["stability", "similarity_boost", "speed", "volume"]) {
      assert.equal(
        properties[name as keyof typeof properties].type,
        "number",
        `${name} must be a number`
      );
    }
  });

  test("the numeric ranges match upstream", () => {
    const properties = SPEAK_INPUT_SCHEMA.properties;
    assert.equal(properties.stability.minimum, 0);
    assert.equal(properties.stability.maximum, 1);
    assert.equal(properties.similarity_boost.minimum, 0);
    assert.equal(properties.similarity_boost.maximum, 1);
    assert.equal(properties.speed.minimum, 0.5);
    assert.equal(properties.speed.maximum, 2.0);
    assert.equal(properties.volume.minimum, 0);
    assert.equal(properties.volume.maximum, 2);
  });

  test("the descriptions mention the upstream defaults", () => {
    const properties = SPEAK_INPUT_SCHEMA.properties;
    assert.match(properties.stability.description, /Default: 0\.5/);
    assert.match(properties.similarity_boost.description, /Default: 0\.75/);
    assert.match(properties.speed.description, /Default: 1\.0/);
    assert.match(properties.volume.description, /Default: 1\.0/);
  });
});

describe("the speak tool description", () => {
  test("it keeps the upstream text and the audio tag table", () => {
    assert.ok(SPEAK_DESCRIPTION.includes("Convert text to speech using ElevenLabs v3"));
    assert.ok(SPEAK_DESCRIPTION.includes("Audio Tags (v3 expressive features):"));
    assert.ok(SPEAK_DESCRIPTION.includes("[strong French accent]"));
    assert.ok(SPEAK_DESCRIPTION.includes("USAGE GUIDANCE:"));
  });

  test("it describes the Linux playback chain", () => {
    assert.ok(SPEAK_DESCRIPTION.includes("Linux-only:"));
    for (const id of PLAYER_IDS) {
      assert.ok(
        SPEAK_DESCRIPTION.includes(id),
        `the description must mention ${id}`
      );
    }
    assert.ok(!SPEAK_DESCRIPTION.includes("Windows"));
  });
});

describe("the api key", () => {
  test("it is read from the opencode secrets directory", () => {
    assert.ok(
      API_KEY_PATH.endsWith(
        "/.config/opencode/secrets/elevenlabs-key".replace("/", "/")
      ),
      `unexpected key path: ${API_KEY_PATH}`
    );
    assert.ok(API_KEY_PATH.includes("elevenlabs-key"));
  });

  test("a missing key file produces a clear error", () => {
    // Either a key exists (then it is returned trimmed) or the error names
    // the file that has to be created.
    try {
      const key = loadApiKey();
      assert.equal(typeof key, "string");
      assert.equal(key, key.trim());
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to read ElevenLabs API key/);
      assert.ok(error.message.includes(API_KEY_PATH));
    }
  });
});

describe("the platform guard runs before the api call", () => {
  test("without a player the tool fails before loading a key or calling the api", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-opencode-voice-test";
    try {
      await assert.rejects(
        () => speakExecute({ text: "hello" }),
        /no supported audio player/i
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
