import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_TAG_EXAMPLES,
  DEFAULT_SIMILARITY_BOOST,
  DEFAULT_SPEED,
  DEFAULT_STABILITY,
  DEFAULT_VOLUME,
  MODEL_ID,
  OUTPUT_FORMAT,
  VOICE_ID,
  buildTtsBody,
  buildTtsRequest,
  buildTtsUrl,
  extractAudioTags,
  findInvalidAudioTags,
  isInvalidAudioTag,
} from "../src/voice.ts";

describe("elevenlabs request construction", () => {
  test("the model id is exactly eleven_v3", () => {
    assert.equal(MODEL_ID, "eleven_v3");
  });

  test("the default voice is Adam (free tier)", () => {
    assert.equal(VOICE_ID, "pNInz6obpgDQGcFmaJgB");
  });

  test("the output format is mp3_44100_128", () => {
    assert.equal(OUTPUT_FORMAT, "mp3_44100_128");
  });

  test("the url carries the output format as a QUERY parameter", () => {
    assert.equal(
      buildTtsUrl(),
      "https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB?output_format=mp3_44100_128"
    );
  });

  test("the url contains the voice id in the path", () => {
    const url = buildTtsUrl("custom-voice");
    assert.equal(
      url,
      "https://api.elevenlabs.io/v1/text-to-speech/custom-voice?output_format=mp3_44100_128"
    );
  });

  test("the output format never ends up in the request body", () => {
    const body = buildTtsBody({
      text: "hello",
      stability: DEFAULT_STABILITY,
      similarity_boost: DEFAULT_SIMILARITY_BOOST,
      speed: DEFAULT_SPEED,
    });
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("output_format"));
    assert.ok(!("output_format" in body));
  });

  test("the body is byte-for-byte identical to the upstream payload", () => {
    const body = buildTtsBody({
      text: "hello",
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1.0,
    });

    // Upstream (AvernicAI/opencode-voice) serializes exactly this object.
    const upstream = JSON.stringify({
      text: "hello",
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
        speed: 1.0,
      },
    });

    assert.equal(JSON.stringify(body), upstream);
  });

  test("the body key order matches upstream", () => {
    const body = buildTtsBody({
      text: "hi",
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1.0,
    });
    assert.deepEqual(Object.keys(body), ["text", "model_id", "voice_settings"]);
    assert.deepEqual(Object.keys(body.voice_settings), [
      "stability",
      "similarity_boost",
      "style",
      "use_speaker_boost",
      "speed",
    ]);
    assert.equal(body.model_id, "eleven_v3");
    assert.equal(body.voice_settings.style, 0);
    assert.equal(body.voice_settings.use_speaker_boost, true);
  });

  test("the request carries the api key header and a json body", () => {
    const request = buildTtsRequest(
      {
        text: "hello",
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 1.0,
      },
      "secret-key"
    );

    assert.equal(request.url, buildTtsUrl());
    assert.equal(request.init.method, "POST");
    assert.equal(request.init.headers["xi-api-key"], "secret-key");
    assert.equal(request.init.headers["Content-Type"], "application/json");
    assert.equal(
      request.init.body,
      JSON.stringify({
        text: "hello",
        model_id: "eleven_v3",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0,
          use_speaker_boost: true,
          speed: 1.0,
        },
      })
    );
  });

  test("the tool defaults match upstream", () => {
    assert.equal(DEFAULT_STABILITY, 0.5);
    assert.equal(DEFAULT_SIMILARITY_BOOST, 0.75);
    assert.equal(DEFAULT_SPEED, 1.0);
    assert.equal(DEFAULT_VOLUME, 1.0);
  });
});

describe("audio tag handling", () => {
  test("tags are extracted from square brackets", () => {
    assert.deepEqual(
      extractAudioTags("[whispers] Something's coming... [sighs] I can feel it."),
      ["whispers", "sighs"]
    );
  });

  test("a tag without whitespace must be lowercase", () => {
    assert.equal(isInvalidAudioTag("whispers"), false);
    assert.equal(isInvalidAudioTag("Whispers"), true);
    assert.equal(isInvalidAudioTag("WHISPERS"), true);
    assert.equal(isInvalidAudioTag("Laughs"), true);
  });

  test("multi word tags are left alone (documented proper nouns)", () => {
    assert.equal(isInvalidAudioTag("laughs harder"), false);
    assert.equal(isInvalidAudioTag("strong French accent"), false);
    assert.equal(isInvalidAudioTag("British accent"), false);
    assert.equal(isInvalidAudioTag("Southern US accent"), false);
  });

  test("invalid tags are reported", () => {
    assert.deepEqual(findInvalidAudioTags("[Whispers] hi"), ["Whispers"]);
    assert.deepEqual(findInvalidAudioTags("[WHISPERS] [Sighs]"), [
      "WHISPERS",
      "Sighs",
    ]);
    assert.deepEqual(findInvalidAudioTags("[whispers] [sighs]"), []);
    assert.deepEqual(findInvalidAudioTags("no tags here"), []);
  });

  test("the audio tag example table is preserved from upstream", () => {
    assert.ok(AUDIO_TAG_EXAMPLES.includes("[strong French accent]"));
    assert.ok(AUDIO_TAG_EXAMPLES.includes("[clears throat]"));
    assert.ok(
      AUDIO_TAG_EXAMPLES.includes(
        'Example: "[whispers] Something\'s coming... [sighs] I can feel it."'
      )
    );
  });
});
