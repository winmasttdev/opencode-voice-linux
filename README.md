# opencode-voice-linux

A **Linux** [OpenCode](https://opencode.ai) plugin that adds text-to-speech
capabilities using [ElevenLabs](https://elevenlabs.io) v3 with expressive audio
tags.

This is a **deliberate, documented fork** of the Windows-only
[AvernicAI/opencode-voice](https://github.com/AvernicAI/opencode-voice) (which
itself descends from the macOS-only
[R44VC0RP/opencode-voice](https://github.com/R44VC0RP/opencode-voice)). The
ElevenLabs part is unchanged; only the audio playback layer, the packaging and
the docs are Linux specific.

## Features

- **ElevenLabs v3** - uses the most expressive TTS model with audio tag support
- **Audio tags** - control emotions, delivery, reactions, accents and sound
  effects inline
- **Non-blocking** - the audio plays in the background, the tool returns
  immediately
- **Native Linux playback** - `ffplay`, `mpv`, `pw-play`, `paplay` or `cvlc`,
  whichever is installed - no extra dependencies required
- **Zero runtime dependencies** - pure TypeScript, loaded by the OpenCode
  runtime

## What exactly diverges from upstream

| | Upstream (`AvernicAI/opencode-voice`) | This fork |
|---|---|---|
| Platform | Windows only | Linux only |
| Playback engine | hidden PowerShell process using the WPF `MediaPlayer`, falling back to the legacy `WMPlayer.OCX` COM object | native Linux players: `ffplay` -> `mpv` -> `pw-play` -> `paplay` -> `cvlc` |
| Player selection | fixed (PowerShell picks its engine) | first installed player on `PATH` wins, the next one is tried when a spawn fails |
| Volume mapping | 0-2 -> 0.0-1.0 (WPF) / 0-100 (WMP COM) | 0-2 -> 0-100 (ffplay, mpv), 0.0-1.0 (pw-play, cvlc `--gain`), 0-65536 (paplay) |
| mp3 for raw players | n/a | `pw-play`/`paplay` get a 16-bit PCM wav transcoded by ffmpeg |
| Plugin API | V1 (`tool()` helper with Zod schemas from `@opencode-ai/plugin`) | V2 (`ctx.tool.transform()` with a plain JSON schema) |
| Setup script | `setup.ps1` (PowerShell) | `setup.sh` (bash + awk) |

**Unchanged** (byte-for-byte compatible): the ElevenLabs request (URL, query
parameter, headers, JSON body and key order), the model id `eleven_v3`, the
default voice `pNInz6obpgDQGcFmaJgB`, the tool arguments and their defaults,
the audio tag table, the API key location and the non-blocking behaviour.

The only wording change in the tool description is the platform paragraph,
which now describes the Linux player chain instead of the PowerShell engine.

## Requirements

- Linux (the plugin refuses to run on any other platform)
- One of: `ffplay` (ffmpeg), `mpv`, `pw-play` (pipewire-utils), `paplay`
  (pulseaudio-utils), `cvlc` (vlc)
- `ffmpeg` as well if you want to use `pw-play`/`paplay` (mp3 -> wav
  transcode)
- An ElevenLabs API key with v3 access
- [Bun](https://bun.sh) or Node.js (the OpenCode runtime provides the plugin
  API; `npm`/`bun` are only needed for the dev workflow)

## Quick Install

```bash
git clone https://github.com/winmasttdev/opencode-voice-linux.git ~/dev/opencode-voice-linux
cd ~/dev/opencode-voice-linux
./setup.sh
```

The setup script will:

- clone/update the repository (or register an existing checkout)
- install the (dev) dependencies - the plugin itself has no runtime
  dependencies
- prompt for your ElevenLabs API key (input is hidden) and store it in
  `~/.config/opencode/secrets/elevenlabs-key`
- register the plugin in your OpenCode config (`~/.config/opencode/opencode.jsonc`,
  or the legacy `opencode.json` if that is all you have)

The config is JSONC. The script never round-trips it through a JSON parser:
the plugin entry is inserted with surgical text edits, so **comments and
formatting are preserved**.

Already have the checkout somewhere else? Point the script at it:

```bash
OPENCODE_VOICE_DIR=~/somewhere/else ./setup.sh
```

Other options:

```bash
./setup.sh --register-only        # only register the plugin path
./setup.sh --config <path>        # edit a specific config file
./setup.sh --help                 # all options
```

Then restart OpenCode!

## Manual Installation

1. Clone or download this plugin:

   ```bash
   git clone https://github.com/winmasttdev/opencode-voice-linux.git ~/dev/opencode-voice-linux
   cd ~/dev/opencode-voice-linux
   npm install   # optional: only needed for `npm test` / `npm run typecheck`
   ```

2. Add your ElevenLabs API key:

   ```bash
   mkdir -p ~/.config/opencode/secrets
   printf '%s' 'YOUR_API_KEY' > ~/.config/opencode/secrets/elevenlabs-key
   chmod 600 ~/.config/opencode/secrets/elevenlabs-key
   ```

3. Register the plugin in your OpenCode config
   (`~/.config/opencode/opencode.jsonc` - the legacy `opencode.json` works
   too). Add the `plugins` array (V2 name; the old `plugin` field still works
   as a fallback):

   ```jsonc
   {
     "plugins": [
       "file:///home/YOUR_USERNAME/dev/opencode-voice-linux"
     ]
   }
   ```

4. Restart OpenCode

## Usage

The plugin provides a `speak` tool that converts text to speech with
expressive audio tags:

```
speak("[excited] Hello! [laughs] This is amazing!")
speak("[whispers] Something's coming... [sighs] I can feel it.")
speak("[dramatically] The code is complete.")
```

### Audio Tags

ElevenLabs v3 supports inline audio tags for precise control. **Tags must be
lowercase** (`[whispers]`, not `[Whispers]`) - the plugin warns you when it
sees a single-word tag with uppercase characters:

| Category | Examples |
|----------|----------|
| **Emotions** | `[laughs]`, `[sighs]`, `[excited]`, `[sad]`, `[angry]`, `[happily]`, `[sarcastic]`, `[curious]` |
| **Delivery** | `[whispers]`, `[shouts]`, `[dramatically]`, `[calmly]`, `[nervously]` |
| **Reactions** | `[laughs harder]`, `[giggles]`, `[clears throat]`, `[gasps]`, `[gulps]` |
| **Accents** | `[strong French accent]`, `[British accent]`, `[Southern US accent]` |
| **Sound FX** | `[applause]`, `[gunshot]`, `[explosion]` |

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | required | Text with optional audio tags |
| `stability` | 0-1 | 0.5 | Lower = more expressive |
| `similarity_boost` | 0-1 | 0.75 | Voice similarity |
| `speed` | 0.5-2.0 | 1.0 | Speech speed |
| `volume` | 0-2 | 1.0 | Playback volume |

### Best Practices

- Use in **short bursts** to notify the user of important state changes
- Good for: task completion, errors requiring attention, questions needing user
  input
- Keep messages **concise** (1-2 sentences) - don't read entire responses aloud

Examples:
- `[excited] Done! The build succeeded.`
- `[curious] I have a question - should I proceed with the refactor?`
- `[sighs] I found 3 errors we need to fix.`
- `[whispers] Heads up - I'm about to make a breaking change.`

## Configuration

### API Key

The plugin reads the ElevenLabs API key from:

```
~/.config/opencode/secrets/elevenlabs-key
```

The file contains the raw key (it is trimmed when read). It is deliberately
**not** read from an environment variable - this is the location OpenCode uses
for its own secrets. The directory is created automatically if it does not
exist.

### Voice ID

The default voice ID is `pNInz6obpgDQGcFmaJgB` (Adam - free tier). To use a
different voice, edit `src/voice.ts`:

```typescript
export const VOICE_ID = "your-voice-id-here";
```

## How Playback Works

The plugin builds an ordered list of candidate players and uses the first one
that is actually installed:

| Order | Player | Command | Notes |
|-------|--------|---------|-------|
| 1 | `ffplay` | `ffplay -nodisp -autoexit -loglevel quiet -volume <0-100> <file>` | ships with ffmpeg, plays mp3 directly |
| 2 | `mpv` | `mpv --no-video --really-quiet --volume=<0-100> <file>` | plays mp3 directly |
| 3 | `pw-play` | `pw-play --volume <0.0-1.0> <file.wav>` | raw PCM only - the mp3 is transcoded to 16-bit PCM wav with ffmpeg first |
| 4 | `paplay` | `paplay --volume=<0-65536> <file.wav>` | raw PCM only - same transcode |
| 5 | `cvlc` | `cvlc --play-and-exit --gain <0.0-1.0> <file>` | plays mp3 directly |

Details:

- Availability is checked with a plain `PATH` lookup (no `which` shell-out).
- The plugin volume range (0-2) is mapped onto each player's native scale.
- The player is spawned **without** `detached: true` (bun's detached spawn is
  broken on Windows) plus `unref()` and `stdio: "ignore"` - the tool returns
  immediately and OpenCode is never blocked.
- The temporary mp3 (and the temporary wav, if one was created) is deleted when
  the player exits, and also when every candidate failed.
- If a player cannot be spawned (or exits with an error) the next candidate is
  tried automatically.
- Before the API call is made, the plugin verifies that the platform is Linux
  **and** that at least one player is installed - so a misconfigured host fails
  fast instead of burning API credits.

## Troubleshooting

**"opencode-voice-linux is a Linux-only plugin"**
The plugin only runs on Linux. Use the upstream Windows fork on Windows.

**"no supported audio player found on this system"**
Install one of the players, e.g. on Arch:

```bash
sudo pacman -S ffmpeg        # ffplay
sudo pacman -S mpv           # mpv
sudo pacman -S pipewire-utils  # pw-play
sudo pacman -S pulseaudio-utils # paplay
sudo pacman -S vlc           # cvlc
```

**"Failed to read ElevenLabs API key"**
Create `~/.config/opencode/secrets/elevenlabs-key` and put your key in it
(`./setup.sh` does this for you).

**"ElevenLabs API error (401)"**
The key is wrong or has no v3 access yet.

**No sound**
- Check the system volume and the default output device
  (`pactl list short sinks` / `wpctl status`)
- `pw-play`/`paplay` need a running PipeWire/PulseAudio server
- `mpv`/`cvlc` sometimes need `--ao=pipewire`/`--audio=pulse`

**The `speak` tool does not show up**
Restart OpenCode after registering the plugin and check
`~/.config/opencode/opencode.jsonc` for the `plugins` entry.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test tests/
```

The test suite covers the player detection order, the volume mapping, the
ElevenLabs URL/body construction, the audio tag casing rules, the temp file
cleanup and the "no player available" error path. The playback path is
verified end to end with a locally generated mp3 - no API key required.

## License

MIT - see [LICENSE](./LICENSE).

Upstream credits: [AvernicAI/opencode-voice](https://github.com/AvernicAI/opencode-voice)
(Windows) and [R44VC0RP/opencode-voice](https://github.com/R44VC0RP/opencode-voice)
(macOS).
