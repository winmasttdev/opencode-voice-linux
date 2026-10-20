/**
 * ElevenLabs v3 request construction.
 *
 * This module is intentionally pure: it only builds the URL, the headers and
 * the JSON body, so the wire format can be unit tested without an API key.
 *
 * Wire format rules (kept byte-for-byte compatible with the upstream
 * Windows fork, AvernicAI/opencode-voice):
 *
 *  - the model id is exactly `eleven_v3` and travels in the `model_id` field
 *  - `output_format` is a QUERY parameter, never part of the JSON body
 *  - the response is a raw binary audio stream (read with `arrayBuffer()`)
 *  - audio tags must be lowercase inside square brackets
 */

/**
 * Voice ID for ElevenLabs TTS (Adam, free tier).
 */
export const VOICE_ID = "pNInz6obpgDQGcFmaJgB";

/**
 * ElevenLabs v3 model ID - most expressive with audio tag support.
 */
export const MODEL_ID = "eleven_v3";

/**
 * Output format. This is a query parameter, not a body field.
 */
export const OUTPUT_FORMAT = "mp3_44100_128";

/**
 * ElevenLabs API base URL.
 */
export const API_BASE_URL = "https://api.elevenlabs.io";

/**
 * Text-to-speech endpoint path.
 */
export const TTS_PATH = "/v1/text-to-speech";

/**
 * Default tool arguments (identical to upstream).
 */
export const DEFAULT_STABILITY = 0.5;
export const DEFAULT_SIMILARITY_BOOST = 0.75;
export const DEFAULT_SPEED = 1.0;
export const DEFAULT_VOLUME = 1.0;

/**
 * Voice settings sent to ElevenLabs.
 */
export interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

/**
 * JSON body sent to ElevenLabs.
 */
export interface TtsBody {
  text: string;
  model_id: string;
  voice_settings: VoiceSettings;
}

/**
 * Normalized speak parameters.
 */
export interface SpeakParams {
  text: string;
  stability: number;
  similarity_boost: number;
  speed: number;
}

/**
 * A fully built ElevenLabs request (url + fetch init).
 */
export interface TtsRequest {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  };
}

/**
 * Build the text-to-speech URL.
 *
 * The output format is a query parameter - it must never end up in the body.
 */
export function buildTtsUrl(voiceId: string = VOICE_ID): string {
  return `${API_BASE_URL}${TTS_PATH}/${voiceId}?output_format=${OUTPUT_FORMAT}`;
}

/**
 * Build the JSON body. Key order matches upstream exactly so the serialized
 * payload is byte-for-byte identical.
 */
export function buildTtsBody(params: SpeakParams): TtsBody {
  return {
    text: params.text,
    model_id: MODEL_ID,
    voice_settings: {
      stability: params.stability,
      similarity_boost: params.similarity_boost,
      style: 0,
      use_speaker_boost: true,
      speed: params.speed,
    },
  };
}

/**
 * Build the complete request (url + fetch init) for the ElevenLabs API.
 */
export function buildTtsRequest(
  params: SpeakParams,
  apiKey: string,
  voiceId: string = VOICE_ID
): TtsRequest {
  return {
    url: buildTtsUrl(voiceId),
    init: {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildTtsBody(params)),
    },
  };
}

/**
 * Audio tag categories for reference in the tool description.
 *
 * Kept byte-for-byte identical to upstream.
 */
export const AUDIO_TAG_EXAMPLES = `
Audio Tags (v3 expressive features):
  Emotions: [laughs], [sighs], [whispers], [excited], [sad], [angry], [happily], [sarcastic], [curious]
  Delivery: [whispers], [shouts], [dramatically], [calmly], [nervously]
  Reactions: [laughs], [laughs harder], [giggles], [clears throat], [sighs], [gasps], [gulps]
  Accents: [strong French accent], [British accent], [Southern US accent]
  Sound FX: [applause], [gunshot], [explosion]

Example: "[whispers] Something's coming... [sighs] I can feel it."
Example: "[excited] We did it! [laughs] I can't believe it worked!"
`;

/**
 * Extract every `[...]` tag from a text.
 */
export function extractAudioTags(text: string): string[] {
  const matches = text.match(/\[[^\]\n]*\]/g);
  if (!matches) return [];
  return matches
    .map((match) => match.slice(1, -1).trim())
    .filter((tag) => tag.length > 0);
}

/**
 * A single-word tag must be entirely lowercase (`[whispers]`, not
 * `[Whispers]` or `[WHISPERS]`).
 *
 * Multi-word tags are intentionally left alone: upstream documents proper
 * nouns as valid accents ("[strong French accent]", "[British accent]",
 * "[Southern US accent]").
 */
export function isInvalidAudioTag(tag: string): boolean {
  if (/\s/.test(tag)) return false;
  return /[A-Z]/.test(tag);
}

/**
 * Find all audio tags that violate the lowercase rule.
 */
export function findInvalidAudioTags(text: string): string[] {
  return extractAudioTags(text).filter((tag) => isInvalidAudioTag(tag));
}
