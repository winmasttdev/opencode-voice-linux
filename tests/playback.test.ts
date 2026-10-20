import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CVLC,
  FFPLAY,
  MPV,
  PAPLAY,
  PLAYER_IDS,
  PLAYER_SPECS,
  PW_PLAY,
  assertPlaybackSupported,
  buildFfmpegArgs,
  buildPlayerCommand,
  detectPlayers,
  isExecutableAvailable,
  mapVolume,
  noPlayerAvailableMessage,
  playAudio,
  toPlayerVolume,
  type PlayerSpec,
  type SpawnedChild,
} from "../src/playback.ts";

/**
 * Create a directory with fake (but executable) player binaries.
 */
function makeFakeBinDir(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

/**
 * A child process double that records the spawned commands and lets the test
 * decide when the process exits.
 */
class FakeChild implements SpawnedChild {
  readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  unrefCalled = false;

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  unref(): unknown {
    this.unrefCalled = true;
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

/**
 * Wait until a condition is true (or the timeout expires).
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

describe("player detection", () => {
  test("the fallback order is ffplay, mpv, pw-play, paplay, cvlc", () => {
    assert.deepEqual(PLAYER_IDS, ["ffplay", "mpv", "pw-play", "paplay", "cvlc"]);
    assert.deepEqual(
      PLAYER_SPECS.map((spec) => spec.command),
      ["ffplay", "mpv", "pw-play", "paplay", "cvlc"]
    );
  });

  test("installed players are returned in fallback order, not PATH order", () => {
    const dirA = makeFakeBinDir(["cvlc", "ffplay"]);
    const dirB = makeFakeBinDir(["mpv", "paplay"]);
    try {
      const players = detectPlayers({ env: { PATH: `${dirA}:${dirB}` } });
      assert.deepEqual(
        players.map((spec) => spec.id),
        ["ffplay", "mpv", "paplay", "cvlc"]
      );
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("missing players are skipped", () => {
    const dir = makeFakeBinDir(["mpv"]);
    try {
      const players = detectPlayers({ env: { PATH: dir } });
      assert.deepEqual(
        players.map((spec) => spec.id),
        ["mpv"]
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty PATH yields no players", () => {
    assert.deepEqual(detectPlayers({ env: { PATH: "" } }), []);
    assert.deepEqual(detectPlayers({ env: {} }), []);
  });

  test("availability is a plain PATH lookup", () => {
    const dir = makeFakeBinDir(["ffplay"]);
    try {
      assert.equal(isExecutableAvailable("ffplay", { PATH: dir }), true);
      assert.equal(isExecutableAvailable("ffplay", { PATH: "/nonexistent" }), false);
      assert.equal(isExecutableAvailable("nope-not-here", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non executable files are not detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    writeFileSync(join(dir, "ffplay"), "not executable");
    chmodSync(join(dir, "ffplay"), 0o644);
    try {
      assert.equal(isExecutableAvailable("ffplay", { PATH: dir }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("volume mapping", () => {
  test("the 0-2 range maps onto the 0-100 scale", () => {
    assert.equal(mapVolume(0), 0);
    assert.equal(mapVolume(0.5), 25);
    assert.equal(mapVolume(1), 50);
    assert.equal(mapVolume(1.5), 75);
    assert.equal(mapVolume(2), 100);
  });

  test("out of range volumes are clamped", () => {
    assert.equal(mapVolume(-1), 0);
    assert.equal(mapVolume(5), 100);
  });

  test("each player gets its own native scale", () => {
    assert.equal(toPlayerVolume("percent", 50), 50);
    assert.equal(toPlayerVolume("linear", 50), 0.5);
    assert.equal(toPlayerVolume("pulse", 50), 32768);
    assert.equal(toPlayerVolume("pulse", 100), 65536);
  });
});

describe("player commands", () => {
  test("ffplay", () => {
    const { command, args } = buildPlayerCommand(FFPLAY, "/tmp/a.mp3", 50);
    assert.equal(command, "ffplay");
    assert.deepEqual(args, [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "-volume",
      "50",
      "/tmp/a.mp3",
    ]);
  });

  test("mpv", () => {
    const { command, args } = buildPlayerCommand(MPV, "/tmp/a.mp3", 50);
    assert.equal(command, "mpv");
    assert.deepEqual(args, [
      "--no-video",
      "--really-quiet",
      "--volume=50",
      "/tmp/a.mp3",
    ]);
  });

  test("pw-play", () => {
    const { command, args } = buildPlayerCommand(PW_PLAY, "/tmp/a.wav", 50);
    assert.equal(command, "pw-play");
    assert.deepEqual(args, ["--volume", "0.5", "/tmp/a.wav"]);
  });

  test("paplay", () => {
    const { command, args } = buildPlayerCommand(PAPLAY, "/tmp/a.wav", 50);
    assert.equal(command, "paplay");
    assert.deepEqual(args, ["--volume=32768", "/tmp/a.wav"]);
  });

  test("cvlc", () => {
    const { command, args } = buildPlayerCommand(CVLC, "/tmp/a.mp3", 50);
    assert.equal(command, "cvlc");
    assert.deepEqual(args, ["--play-and-exit", "--gain", "0.5", "/tmp/a.mp3"]);
  });

  test("pw-play and paplay need a wav, the others play mp3 directly", () => {
    assert.equal(PW_PLAY.requiresWav, true);
    assert.equal(PAPLAY.requiresWav, true);
    assert.equal(FFPLAY.requiresWav, false);
    assert.equal(MPV.requiresWav, false);
    assert.equal(CVLC.requiresWav, false);
  });

  test("the ffmpeg transcode produces 16-bit pcm wav", () => {
    const args = buildFfmpegArgs("/tmp/in.mp3", "/tmp/out.wav");
    assert.ok(args.includes("pcm_s16le"));
    assert.ok(args.includes("44100"));
    assert.equal(args[args.length - 1], "/tmp/out.wav");
    assert.equal(args[args.indexOf("-i") + 1], "/tmp/in.mp3");
  });
});

describe("the platform guard", () => {
  test("non-linux hosts fail before any API call", () => {
    assert.throws(
      () => assertPlaybackSupported("win32", { PATH: "" }),
      /Linux-only plugin/
    );
    assert.throws(
      () => assertPlaybackSupported("darwin", { PATH: "" }),
      /Linux-only plugin/
    );
  });

  test("the error mentions the detected platform", () => {
    assert.throws(
      () => assertPlaybackSupported("win32", { PATH: "" }),
      /Detected platform: win32/
    );
  });

  test("a linux host without any player fails with a helpful message", () => {
    assert.throws(
      () => assertPlaybackSupported("linux", { PATH: "/nonexistent" }),
      (error: Error) => {
        assert.match(error.message, /no supported audio player/i);
        for (const id of PLAYER_IDS) {
          assert.ok(error.message.includes(id), `missing player ${id}`);
        }
        return true;
      }
    );
  });

  test("the no-player message lists every candidate", () => {
    const message = noPlayerAvailableMessage();
    for (const id of PLAYER_IDS) {
      assert.ok(message.includes(id), `missing player ${id}`);
    }
  });

  test("a linux host with a player passes the guard", () => {
    const dir = makeFakeBinDir(["ffplay"]);
    try {
      const players = assertPlaybackSupported("linux", { PATH: dir });
      assert.deepEqual(
        players.map((spec) => spec.id),
        ["ffplay"]
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("playback", () => {
  test("the temp file is removed when playback finishes", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");
    const child = new FakeChild();

    try {
      playAudio(file, 1.0, {
        candidates: [FFPLAY],
        spawn: () => child,
      });

      assert.ok(existsSync(file), "file must survive until playback ends");
      assert.equal(child.unrefCalled, true, "the child must be unref'ed");

      child.emit("exit", 0);
      assert.equal(existsSync(file), false, "file must be removed after playback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the next candidate is used when the spawn fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");
    const children: FakeChild[] = [];

    try {
      playAudio(file, 1.0, {
        candidates: [FFPLAY, MPV],
        spawn: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
      });

      assert.equal(children.length, 1);
      children[0].emit("error", new Error("ENOENT"));
      assert.equal(children.length, 2, "the second candidate must be spawned");

      children[1].emit("exit", 0);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the next candidate is used when a player exits with an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");
    const children: FakeChild[] = [];

    try {
      playAudio(file, 1.0, {
        candidates: [FFPLAY, MPV],
        spawn: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
      });

      children[0].emit("exit", 1);
      assert.equal(children.length, 2);
      children[1].emit("exit", 0);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the temp file is removed when every candidate failed", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");
    const children: FakeChild[] = [];
    const errors: string[] = [];

    try {
      playAudio(file, 1.0, {
        candidates: [FFPLAY, MPV],
        spawn: () => {
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        onError: (message) => errors.push(message),
      });

      children[0].emit("error", new Error("ENOENT"));
      children[1].emit("error", new Error("ENOENT"));

      assert.equal(existsSync(file), false, "file must be removed on failure");
      assert.equal(errors.length, 1);
      assert.match(errors[0], /ffplay, mpv/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without any player the temp file is removed and an error is thrown", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");

    try {
      assert.throws(
        () => playAudio(file, 1.0, { candidates: [] }),
        /no supported audio player/i
      );
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("players that need a wav get a transcoded file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");

    // Fake ffmpeg: creates the target file (the last argument).
    const fakeFfmpeg = join(dir, "ffmpeg");
    writeFileSync(
      fakeFfmpeg,
      '#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf RIFF > "$last"\n'
    );
    chmodSync(fakeFfmpeg, 0o755);

    const children: FakeChild[] = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    try {
      playAudio(file, 1.0, {
        candidates: [PW_PLAY],
        spawn: (command, args) => {
          spawned.push({ command, args });
          const child = new FakeChild();
          children.push(child);
          return child;
        },
        ffmpegCommand: fakeFfmpeg,
        env: { PATH: dir },
      });

      const spawnedOk = await waitFor(() => children.length === 1);
      assert.ok(spawnedOk, "the player must be spawned after the transcode");
      assert.equal(spawned[0].command, "pw-play");
      assert.ok(spawned[0].args[2].endsWith(".wav"));
      assert.notEqual(spawned[0].args[2], file);

      children[0].emit("exit", 0);
      assert.equal(existsSync(file), false, "the mp3 must be removed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("playback is non blocking: playAudio returns before the player exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    writeFileSync(file, "audio");
    const child = new FakeChild();

    try {
      const started = Date.now();
      playAudio(file, 1.0, { candidates: [FFPLAY], spawn: () => child });
      assert.ok(Date.now() - started < 100, "playAudio must return immediately");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("real playback (no api key needed)", () => {
  const hasFfmpeg = (() => {
    try {
      return existsSync("/usr/bin/ffmpeg") || Boolean(process.env.PATH);
    } catch {
      return false;
    }
  })();

  test("a generated mp3 is played and removed afterwards", async (t) => {
    const ffmpeg = PLAYER_SPECS.length ? "ffmpeg" : "ffmpeg";
    let generated = false;
    try {
      const probe = mkdtempSync(join(tmpdir(), "opencode-voice-probe-"));
      const probeFile = join(probe, "probe.mp3");
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        ffmpeg,
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
          probeFile,
          "-y",
        ],
        { stdio: "ignore" }
      );
      generated = result.status === 0 && existsSync(probeFile);
      rmSync(probe, { recursive: true, force: true });
    } catch {
      generated = false;
    }

    if (!generated) {
      t.skip("ffmpeg is not available - skipping the real playback test");
      return;
    }

    const players = detectPlayers();
    if (players.length === 0) {
      t.skip("no audio player installed - skipping the real playback test");
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "opencode-voice-test-"));
    const file = join(dir, "speech.mp3");
    const { spawnSync } = await import("node:child_process");
    spawnSync(
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
        file,
        "-y",
      ],
      { stdio: "ignore" }
    );

    try {
      const started = Date.now();
      playAudio(file, 1.0);
      const removed = await waitFor(() => !existsSync(file), 20000);
      const elapsed = Date.now() - started;

      assert.ok(removed, "the temp file must be removed after playback");
      assert.ok(
        elapsed >= 400,
        `the player must actually run (elapsed ${elapsed}ms)`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
