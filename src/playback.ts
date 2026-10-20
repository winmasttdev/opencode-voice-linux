/**
 * Linux audio playback.
 *
 * Upstream (AvernicAI/opencode-voice) plays audio through a hidden
 * PowerShell process using the WPF `MediaPlayer` and is therefore
 * Windows-only. This module is the Linux replacement:
 *
 *  - a fixed, ordered list of candidate players is probed on PATH
 *  - the first installed player wins
 *  - the plugin volume range (0-2) is mapped onto each player's native scale
 *  - playback is non-blocking (plain spawn + `unref()` + `stdio: "ignore"`)
 *  - the temporary audio file is removed when playback finishes
 *
 * Everything in here is side-effect free except `playAudio()` and
 * `transcodeToWav()`, which are kept separate from the pure helpers so the
 * decision logic stays unit testable.
 */

import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * How a player expresses volume.
 *
 *  - `percent`: 0-100 (ffplay, mpv)
 *  - `linear`:  0.0-1.0 multiplier, 1.0 = 100% (pw-play, cvlc --gain)
 *  - `pulse`:   0-65536, 65536 = 100% (paplay)
 */
export type VolumeScale = "percent" | "linear" | "pulse";

/**
 * A candidate audio player.
 */
export interface PlayerSpec {
  /** stable identifier (also used in error messages) */
  readonly id: string;
  /** executable looked up on PATH */
  readonly command: string;
  /** the player cannot decode mp3 - a 16-bit PCM wav is produced first */
  readonly requiresWav: boolean;
  /** native volume scale of the player */
  readonly volumeScale: VolumeScale;
  /** build the argument vector for a file and a 0-100 volume */
  buildArgs(filePath: string, volumePercent: number): string[];
}

/**
 * Listener signature used by the spawned process.
 */
export type SpawnEventListener = (...args: any[]) => void;

/**
 * Minimal shape of the spawned process used by the playback sequence.
 * `node:child_process`'s `ChildProcess` satisfies it structurally.
 */
export interface SpawnedChild {
  on(event: string, listener: SpawnEventListener): unknown;
  unref(): unknown;
}

/**
 * Spawn function used by the playback sequence (injectable for tests).
 */
export type SpawnLike = (command: string, args: string[]) => SpawnedChild;

/**
 * Default spawn: no `detached` flag (bun's detached spawn is broken on
 * Windows and is unnecessary on Linux), ignored stdio and an unref'ed child
 * so the parent never waits for the audio to finish.
 */
export const defaultSpawn: SpawnLike = (command, args) =>
  spawn(command, args, {
    detached: false,
    stdio: "ignore",
  }) as unknown as SpawnedChild;

/**
 * Round to two decimals (used for the linear volume scales).
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convert the canonical 0-100 percentage into a player's native scale.
 */
export function toPlayerVolume(scale: VolumeScale, percent: number): number {
  switch (scale) {
    case "percent":
      return percent;
    case "linear":
      // 0.0 - 1.0 (1.0 = 100%)
      return round2(percent / 100);
    case "pulse":
      // 0 - 65536 (65536 = 100%)
      return Math.round((percent / 100) * 65536);
  }
}

/**
 * ffplay - ships with ffmpeg, plays mp3 natively.
 */
export const FFPLAY: PlayerSpec = {
  id: "ffplay",
  command: "ffplay",
  requiresWav: false,
  volumeScale: "percent",
  buildArgs(filePath, volumePercent) {
    return [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "-volume",
      String(volumePercent),
      filePath,
    ];
  },
};

/**
 * mpv - plays mp3 natively.
 */
export const MPV: PlayerSpec = {
  id: "mpv",
  command: "mpv",
  requiresWav: false,
  volumeScale: "percent",
  buildArgs(filePath, volumePercent) {
    return [
      "--no-video",
      "--really-quiet",
      `--volume=${volumePercent}`,
      filePath,
    ];
  },
};

/**
 * pw-play (pipewire) - raw PCM only, so the file is transcoded to wav.
 */
export const PW_PLAY: PlayerSpec = {
  id: "pw-play",
  command: "pw-play",
  requiresWav: true,
  volumeScale: "linear",
  buildArgs(filePath, volumePercent) {
    return ["--volume", String(toPlayerVolume("linear", volumePercent)), filePath];
  },
};

/**
 * paplay (pulseaudio) - raw PCM only, so the file is transcoded to wav.
 */
export const PAPLAY: PlayerSpec = {
  id: "paplay",
  command: "paplay",
  requiresWav: true,
  volumeScale: "pulse",
  buildArgs(filePath, volumePercent) {
    return [
      `--volume=${toPlayerVolume("pulse", volumePercent)}`,
      filePath,
    ];
  },
};

/**
 * cvlc (vlc) - plays mp3 natively.
 */
export const CVLC: PlayerSpec = {
  id: "cvlc",
  command: "cvlc",
  requiresWav: false,
  volumeScale: "linear",
  buildArgs(filePath, volumePercent) {
    return [
      "--play-and-exit",
      "--gain",
      String(toPlayerVolume("linear", volumePercent)),
      filePath,
    ];
  },
};

/**
 * Ordered list of candidate players. The first installed one wins.
 */
export const PLAYER_SPECS: readonly PlayerSpec[] = [FFPLAY, MPV, PW_PLAY, PAPLAY, CVLC];

/**
 * Player identifiers, in fallback order (used in error messages).
 */
export const PLAYER_IDS: readonly string[] = PLAYER_SPECS.map((spec) => spec.id);

/**
 * Map the plugin volume range (0-2) onto the canonical 0-100 scale.
 */
export function mapVolume(volume: number): number {
  const clamped = Math.min(2, Math.max(0, volume));
  return Math.round(clamped * 50);
}

/**
 * Check whether a path is an executable file.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether an executable is available on PATH.
 *
 * This is a plain PATH lookup (no `which`/`where` shell-out) so it works the
 * same way under bun, node and any other runtime.
 */
export function isExecutableAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (command.includes("/")) return isExecutableFile(command);

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathValue) return false;

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    if (isExecutableFile(join(dir, command))) return true;
  }
  return false;
}

/**
 * Detect which candidate players are installed, in fallback order.
 */
export function detectPlayers(
  options: { env?: NodeJS.ProcessEnv } = {}
): PlayerSpec[] {
  const env = options.env ?? process.env;
  return PLAYER_SPECS.filter((spec) => isExecutableAvailable(spec.command, env));
}

/**
 * Build the full command for a player.
 */
export function buildPlayerCommand(
  spec: PlayerSpec,
  filePath: string,
  volumePercent: number
): { command: string; args: string[] } {
  return {
    command: spec.command,
    args: spec.buildArgs(filePath, volumePercent),
  };
}

/**
 * Error message used when no player could be found.
 */
export function noPlayerAvailableMessage(): string {
  return (
    "opencode-voice-linux: no supported audio player found on this system. " +
    `Install at least one of: ${PLAYER_IDS.join(", ")} ` +
    "(for example `sudo pacman -S ffmpeg` for ffplay, `sudo pacman -S mpv` for mpv, " +
    "`sudo pacman -S pipewire-utils` for pw-play, `sudo pacman -S pulseaudio-utils` for paplay " +
    "or `sudo pacman -S vlc` for cvlc)."
  );
}

/**
 * Platform + player guard.
 *
 * Called at the very beginning of the tool execution, BEFORE any API call is
 * spent, so a misconfigured host fails fast instead of burning credits.
 */
export function assertPlaybackSupported(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env
): PlayerSpec[] {
  if (platform !== "linux") {
    throw new Error(
      "opencode-voice-linux is a Linux-only plugin: audio playback requires one of the " +
        `supported Linux players (${PLAYER_IDS.join(", ")}). ` +
        `Detected platform: ${platform}`
    );
  }

  const players = detectPlayers({ env });
  if (players.length === 0) {
    throw new Error(noPlayerAvailableMessage());
  }
  return players;
}

/**
 * Remove a file (or a directory tree) - never throws.
 */
function removePath(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort cleanup - the player may already have removed the file.
  }
}

/**
 * Build the ffmpeg argument vector used to transcode to 16-bit PCM wav.
 */
export function buildFfmpegArgs(sourcePath: string, targetPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    sourcePath,
    "-acodec",
    "pcm_s16le",
    "-ar",
    "44100",
    "-ac",
    "2",
    targetPath,
  ];
}

/**
 * Result of a successful transcode.
 */
export interface WavResult {
  /** path of the generated wav file */
  path: string;
  /** temp directory that has to be removed afterwards */
  dir: string;
}

/**
 * Transcode an audio file to 16-bit PCM wav (non-blocking).
 *
 * Used for the raw-PCM players (pw-play, paplay) that cannot decode mp3.
 * The callback receives `null` when ffmpeg is missing or the transcode fails.
 */
export function transcodeToWav(
  sourcePath: string,
  callback: (result: WavResult | null) => void,
  options: { env?: NodeJS.ProcessEnv; ffmpegCommand?: string } = {}
): void {
  const env = options.env ?? process.env;
  const ffmpeg = options.ffmpegCommand ?? "ffmpeg";

  if (!isExecutableAvailable(ffmpeg, env)) {
    callback(null);
    return;
  }

  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "opencode-voice-"));
  } catch {
    callback(null);
    return;
  }

  const target = join(dir, "speech.wav");

  let child: SpawnedChild;
  try {
    child = spawn(ffmpeg, buildFfmpegArgs(sourcePath, target), {
      detached: false,
      stdio: "ignore",
    }) as unknown as SpawnedChild;
  } catch {
    removePath(dir);
    callback(null);
    return;
  }

  let settled = false;
  const finish = (result: WavResult | null): void => {
    if (settled) return;
    settled = true;
    if (!result) removePath(dir);
    callback(result);
  };

  child.on("error", () => finish(null));
  child.on("exit", (code) => {
    if (code === 0 && existsSync(target)) {
      finish({ path: target, dir });
      return;
    }
    finish(null);
  });
  child.unref();
}

/**
 * Options for {@link playAudio}.
 */
export interface PlaybackOptions {
  /** override the detected candidates (tests) */
  candidates?: PlayerSpec[];
  /** override the spawn function (tests) */
  spawn?: SpawnLike;
  /** environment used for PATH lookups */
  env?: NodeJS.ProcessEnv;
  /** ffmpeg executable used for the wav transcode */
  ffmpegCommand?: string;
  /** called when every candidate failed */
  onError?: (message: string) => void;
}

/**
 * Play an audio file in the background (non-blocking).
 *
 * The first candidate that is installed is used; if the spawn fails (or the
 * player exits with an error) the next candidate is tried. The temporary
 * audio file - and any wav created on the way - is deleted as soon as
 * playback finishes, or when every candidate failed.
 */
export function playAudio(
  filePath: string,
  volume: number,
  options: PlaybackOptions = {}
): void {
  const env = options.env ?? process.env;
  const candidates = options.candidates ?? detectPlayers({ env });

  if (candidates.length === 0) {
    removePath(filePath);
    throw new Error(noPlayerAvailableMessage());
  }

  const spawnFn = options.spawn ?? defaultSpawn;
  const percent = mapVolume(volume);
  const extraTemps: string[] = [];
  let done = false;

  const cleanup = (): void => {
    removePath(filePath);
    for (const temp of extraTemps) removePath(temp);
  };

  const fail = (reason: string): void => {
    if (done) return;
    done = true;
    cleanup();
    options.onError?.(reason);
  };

  const spawnPlayer = (
    spec: PlayerSpec,
    target: string,
    index: number
  ): void => {
    const { command, args } = buildPlayerCommand(spec, target, percent);

    let child: SpawnedChild;
    try {
      child = spawnFn(command, args);
    } catch {
      attempt(index + 1);
      return;
    }

    let handled = false;
    const once = (fn: () => void): void => {
      if (handled) return;
      handled = true;
      fn();
    };

    // The executable disappeared between detection and spawn -> next candidate.
    child.on("error", () =>
      once(() => {
        if (!done) attempt(index + 1);
      })
    );

    child.on("exit", (code) =>
      once(() => {
        if (done) return;
        if (code === 0) {
          // Playback finished - drop the temporary file(s).
          done = true;
          cleanup();
          return;
        }
        // The player failed -> try the next candidate.
        attempt(index + 1);
      })
    );

    // Non-blocking: the parent must never wait for the audio to finish.
    child.unref();
  };

  const attempt = (index: number): void => {
    if (done) return;
    if (index >= candidates.length) {
      fail(
        `opencode-voice-linux: every audio player failed (${candidates
          .map((spec) => spec.id)
          .join(", ")}) - the temporary audio file was removed.`
      );
      return;
    }

    const spec = candidates[index];

    if (!spec.requiresWav) {
      spawnPlayer(spec, filePath, index);
      return;
    }

    transcodeToWav(
      filePath,
      (result) => {
        if (done) return;
        if (!result) {
          attempt(index + 1);
          return;
        }
        extraTemps.push(result.dir);
        spawnPlayer(spec, result.path, index);
      },
      { env, ffmpegCommand: options.ffmpegCommand }
    );
  };

  attempt(0);
}
