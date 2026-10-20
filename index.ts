import type { Plugin, PluginContext } from "@opencode/plugin"

import {
  SPEAK_DESCRIPTION,
  SPEAK_INPUT_SCHEMA,
  speakExecute,
  type SpeakInput,
} from "./src/plugin.ts"

export default {
  id: "opencode-voice",

  async setup(ctx: PluginContext) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "voice",
        description:
          "Text-to-speech via ElevenLabs v3 with expressive audio tags, played on the local Linux audio device.",
      })

      editor.add({
        name: "speak",
        description: SPEAK_DESCRIPTION,
        input: SPEAK_INPUT_SCHEMA,
        options: { namespace: "voice", codemode: true },
        execute: async (input) => ({
          content: await speakExecute(input as SpeakInput),
        }),
      })
    })
  },
} satisfies Plugin
