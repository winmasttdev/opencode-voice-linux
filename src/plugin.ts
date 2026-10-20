/**
 * The speak tool: ElevenLabs v3 text-to-speech + Linux playback.
 *
 * The ElevenLabs part is byte-for-byte compatible with the upstream Windows
 * fork (AvernicAI/opencode-voice). Only the playback layer differs: the
 * PowerShell/WPF engine is replaced by the native Linux player chain in
 * `src/playback.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIO_TAG_EXAMPLES,
  DEFAULT_SIMILARITY_BOOST,
  DEFAULT_SPEED,
  DEFAULT_STABILITY,
  DEFAULT_VOLUME,
  MODEL_ID,
  VOICE_ID,
  buildTtsRequest,
  findInvalidAudioTags,
} from "./voice.ts";
import { PLAYER_IDS, assertPlaybackSupported, playAudio } from "./playback.ts";

/**
 * Path to the ElevenLabs API key secret file.
 * (~/.config/opencode is the config location OpenCode uses on Linux too.)
 */
export const API_KEY_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "secrets",
  "elevenlabs-key"
);

/**
 * Directory holding the OpenCode secrets.
 */
export const SECRETS_DIR = join(homedir(), ".config", "opencode", "secrets");

/**
 * Load the API key from the secrets file.
 *
 * The file contains the raw key (trimmed). It is deliberately NOT read from
 * an environment variable: user plugins use the OpenCode secrets directory.
 */
export function loadApiKey(): string {
  try {
    return readFileSync(API_KEY_PATH, "utf-8").trim();
  } catch {
    // The secrets directory does not exist on a fresh OpenCode install.
    try {
      mkdirSync(SECRETS_DIR, { recursive: true });
    } catch {
      // Ignore - the error below is the useful one.
    }
    throw new Error(
      `Failed to read ElevenLabs API key from ${API_KEY_PATH}. ` +
        `Please create this file with your API key.`
    );
  }
}

/**
 * Arguments accepted by the speak tool.
 */
export interface SpeakInput {
  text: string;
  stability?: number;
  similarity_boost?: number;
  speed?: number;
  volume?: number;
}

/**
 * JSON schema for the speak tool arguments.
 */
export const SPEAK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "The text to convert to speech. Can include audio tags like [laughs], [whispers], [excited], etc.",
    },
    stability: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Voice stability (0-1). Lower = more expressive/emotional range, higher = more consistent. Default: 0.5",
    },
    similarity_boost: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "How closely to match the original voice (0-1). Default: 0.75",
    },
    speed: {
      type: "number",
      minimum: 0.5,
      maximum: 2.0,
      description: "Speech speed multiplier (0.5-2.0). Default: 1.0",
    },
    volume: {
      type: "number",
      minimum: 0,
      maximum: 2,
      description: "Playback volume (0-2). Default: 1.0",
    },
  },
  required: ["text"],
  additionalProperties: false,
};

/**
 * The speak tool description.
 *
 * Identical to upstream except for the platform paragraph, which has to
 * describe the Linux playback chain instead of the PowerShell/WPF engine.
 */
export const SPEAK_DESCRIPTION = `Convert text to speech using ElevenLabs v3 and play it on the device speakers (non-blocking).

Uses the expressive v3 model which supports inline audio tags for emotional control, 
delivery direction, non-verbal reactions, accents, and sound effects.

Linux-only: audio plays through the first available Linux player (${PLAYER_IDS.join(
  ", "
)}) in a background process.

${AUDIO_TAG_EXAMPLES}

The audio plays in the background and control returns immediately.

USAGE GUIDANCE:
- Use in SHORT BURSTS to notify the user of important state changes
- Good for: task completion, errors requiring attention, questions needing user input
- Keep messages concise (1-2 sentences) - don't read entire responses aloud
- Examples of when to use:
  * "[excited] Done! The build succeeded."
  * "[curious] I have a question - should I proceed with the refactor?"
  * "[sighs] I found 3 errors we need to fix."
  * "[whispers] Heads up - I'm about to make a breaking change."`;

/**
 * Execute the speak tool.
 *
 * Returns the text shown to the model. Playback itself is non-blocking.
 */
export async function speakExecute(input: SpeakInput): Promise<string> {
  const {
    text,
    stability = DEFAULT_STABILITY,
    similarity_boost = DEFAULT_SIMILARITY_BOOST,
    speed = DEFAULT_SPEED,
    volume = DEFAULT_VOLUME,
  } = input;

  // Fail fast on unsupported hosts / hosts without a player BEFORE spending
  // an API call.
  assertPlaybackSupported();

  // Load API key from the secrets file
  const apiKey = loadApiKey();

  // Call ElevenLabs v3 API
  const request = buildTtsRequest(
    { text, stability, similarity_boost, speed },
    apiKey
  );
  const response = await fetch(request.url, request.init);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ElevenLabs API error (${response.status}): ${errorText}`
    );
  }

  // Save audio to temp file (the response is a raw binary audio stream)
  const audioBuffer = await response.arrayBuffer();
  const tempFile = join(tmpdir(), `opencode-voice-${Date.now()}.mp3`);
  writeFileSync(tempFile, Buffer.from(audioBuffer));

  // Play audio in background (non-blocking). The temp file is removed as
  // soon as playback finishes.
  playAudio(tempFile, volume);

  // Return immediately with confirmation
  const preview =
    text.length > 80 ? text.substring(0, 80) + "..." : text;

  const invalidTags = findInvalidAudioTags(text);
  const warning =
    invalidTags.length > 0
      ? `\nWarning: audio tags must be lowercase (${invalidTags
          .map((tag) => `[${tag}]`)
          .join(", ")}).`
      : "";

  return `<speak_started>
Playing speech (non-blocking): "${preview}"
Voice: ${VOICE_ID}
Model: ${MODEL_ID} (v3 expressive)${warning}
</speak_started>`;
}

/**
 * True when the ElevenLabs API key file exists.
 */
export function hasApiKey(): boolean {
  return existsSync(API_KEY_PATH);
}
