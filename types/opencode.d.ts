/**
 * Ambient declaration of the OpenCode V2 plugin API.
 *
 * `@opencode/plugin` is provided by the OpenCode runtime when a plugin is
 * loaded - it is NOT an npm package and must never be added as a dependency.
 * Only types are imported (`import type { Plugin } from "@opencode/plugin"`),
 * so this declaration is enough for `tsc --noEmit`.
 */
declare module "@opencode/plugin" {
  /**
   * The editor handed to `ctx.tool.transform()`.
   */
  export interface ToolEditor {
    /**
     * Register a namespace (tool group).
     */
    namespace(input: { name: string; description: string }): void
    /**
     * Register a tool. `input` is a plain JSON schema.
     */
    add(tool: {
      name: string
      description: string
      input: Record<string, unknown>
      options?: Record<string, unknown>
      execute: (
        input: any,
        context: any
      ) => Promise<{ content: string }> | { content: string }
    }): void
  }

  /**
   * The context passed to `setup()`.
   */
  export interface PluginContext {
    readonly options: Record<string, unknown>
    readonly app: { version: string; channel: string }
    readonly location: {
      directory: string
      project: { id: string; directory: string }
    }
    readonly tool: {
      list(): Promise<readonly unknown[]>
      transform(cb: (editor: ToolEditor) => void): Promise<unknown>
      reload(): Promise<void>
    }
    readonly permission: {
      assert(input: {
        sessionID?: string
        agent?: string
        source?: { type: string; messageID?: string; id?: string }
        action: string
        resources: string[]
        save?: string[]
      }): Promise<void>
    }
  }

  /**
   * A V2 plugin.
   */
  export interface Plugin {
    readonly id: string
    readonly setup: (context: PluginContext) => Promise<void> | void
  }

  export const Plugin: {
    define(plugin: Plugin): Plugin
  }
}
