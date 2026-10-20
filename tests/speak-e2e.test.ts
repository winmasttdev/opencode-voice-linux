import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * End-to-end test of the speak tool with a stubbed ElevenLabs response.
 *
 * No API key and no network access are needed: the home directory is
 * redirected to a temporary one (so the real secrets file is never touched)
 * and `fetch` is replaced by a stub that returns a locally generated mp3.
 */
const FAKE_HOME = mkdtempSync(join(tmpdir(), "opencode-voice-home-"));
const FAKE_TMP = mkdtempSync(join(tmpdir(), "opencode-voice-tmp-"));

process.env.HOME = FAKE_HOME;
process.env.TMPDIR = FAKE_TMP;

mkdirSync(join(FAKE_HOME, ".config", "opencode", "secrets"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".config", "opencode", "secrets", "elevenlabs-key"),
  "  test-key-from-file  \n"
);

const { speakExecute, API_KEY_PATH } = await import("../src/plugin.ts");

/**
 * Build a short mp3 with ffmpeg (falls back to a dummy buffer).
 */
function makeMp3(target: string): Buffer {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-q:a",
      "9",
      target,
      "-y",
    ],
    { stdio: "ignore" }
  );
  if (result.status === 0 && existsSync(target)) {
    return readFileSync(target);
  }
  return Buffer.from("ID3-fake-mp3-payload");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 20000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

describe("the speak tool end to end (stubbed api)", () => {
  test("the api key is read from the secrets file, trimmed", () => {
    assert.ok(API_KEY_PATH.startsWith(FAKE_HOME));
    assert.ok(API_KEY_PATH.endsWith("elevenlabs-key"));
  });

  test("the audio is fetched, played and the temp file is removed", async () => {
    const source = join(FAKE_TMP, "source.mp3");
    const mp3 = makeMp3(source);

    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: any;

    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(mp3, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof globalThis.fetch;

    try {
      const content = await speakExecute({
        text: "[excited] Build succeeded!",
        volume: 1.0,
      });

      // The request matches the upstream wire format.
      assert.equal(
        capturedUrl,
        "https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=mp3_44100_128"
      );
      assert.equal(capturedInit.method, "POST");
      assert.equal(capturedInit.headers["xi-api-key"], "test-key-from-file");
      assert.equal(capturedInit.headers["Content-Type"], "application/json");

      const body = JSON.parse(capturedInit.body);
      assert.equal(body.text, "[excited] Build succeeded!");
      assert.equal(body.model_id, "eleven_v3");
      assert.deepEqual(body.voice_settings, {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1.0,
      });
      assert.ok(!capturedInit.body.includes("output_format"));

      // The tool answers immediately (playback is non blocking).
      assert.match(content, /<speak_started>/);
      assert.match(content, /Playing speech \(non-blocking\)/);
      assert.match(content, /Voice: pNInz6obpgDQGcFmaJgB/);
      assert.match(content, /Model: eleven_v3/);
      assert.match(content, /<\/speak_started>/);

      // The temp mp3 is removed once the player is done.
      const tempFiles = () =>
        readdirSync(FAKE_TMP).filter((name) => name.startsWith("opencode-voice-"));
      const removed = await waitFor(() => tempFiles().length === 0);
      assert.ok(
        removed,
        `the temporary audio file was not removed: ${tempFiles().join(", ")}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the tool reports api errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("quota exceeded", { status: 401 })) as typeof globalThis.fetch;

    try {
      await assert.rejects(
        () => speakExecute({ text: "hello" }),
        /ElevenLabs API error \(401\): quota exceeded/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a non lowercase audio tag produces a warning", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(Buffer.from("fake"), { status: 200 })) as typeof globalThis.fetch;

    try {
      const content = await speakExecute({ text: "[Whispers] hi" });
      assert.match(content, /Warning: audio tags must be lowercase/);
      assert.match(content, /\[Whispers\]/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
