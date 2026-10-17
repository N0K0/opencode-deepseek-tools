// deepseek-tools — OpenCode V2 server plugin.
//
// Exposes DeepSeek's Search & Fetch APIs (https://api-docs.deepseek.com/guides/search)
// as OpenCode tools:
//
//   deepseek_search   — ranked live-web results with titles, URLs, summaries
//   deepseek_fetch    — one page as Markdown
//
// It also registers DeepSeek as a websearch provider, and makes it the default
// when an API key is available so the built-in `websearch` tool works without
// configuring Exa/Tavily/etc.
//
// Authentication: a literal `apiKey` / `{env:NAME}` option, `DEEPSEEK_API_KEY`
// (or `apiKeyEnv`), or the active credential for OpenCode's `deepseek`
// integration. The integration key is read per request, so a rotated key does
// not require a restart. No key is ever written to the config.
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import { clientFromOptions, errorMessage, resolveApiKey, type DeepSeekClient } from "./client"
import { log } from "./log"
import { parseOptions } from "./options"
import { registerTools } from "./tools"
import { registerWebsearch } from "./websearch"

let instanceSeq = 0

/**
 * Reuse the key already stored by OpenCode for the DeepSeek integration
 * (`/connect` → DeepSeek) so the secret does not need to be duplicated in
 * `opencode.json` or the environment.
 */
async function storedDeepSeekKey(
  ctx: Plugin.Context,
  logLine: (...args: unknown[]) => void,
): Promise<string | undefined> {
  try {
    const connection = await ctx.integration.connection.active("deepseek")
    if (!connection) return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type !== "key") return undefined
    const key = credential.key.trim()
    return key || undefined
  } catch (error) {
    logLine(`could not read the "deepseek" credential: ${errorMessage(error)}`)
    return undefined
  }
}

export default Plugin.define({
  id: "deepseek-tools",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const tag = `${basename(ctx.location.directory)}#${++instanceSeq}@${Math.random().toString(36).slice(2, 6)}`
    const instanceLog = (...args: unknown[]) => log(`(${tag})`, ...args)

    const staticKey = resolveApiKey({ apiKey: options.apiKey, apiKeyEnv: options.apiKeyEnv })
    const getApiKey = async (): Promise<string | undefined> =>
      staticKey ?? (await storedDeepSeekKey(ctx, instanceLog))
    const client: DeepSeekClient = clientFromOptions(options, instanceLog, getApiKey)
    const hasKey = await client.hasApiKey()
    const keySource = staticKey
      ? options.apiKey
        ? "plugin option"
        : `env ${options.apiKeyEnv}`
      : hasKey
        ? 'OpenCode credential "deepseek"'
        : undefined

    let baseOrigin = options.baseURL
    try {
      baseOrigin = new URL(options.baseURL).origin
    } catch {
      // parseOptions already validated this, but logging must never throw
    }

    instanceLog(`setup — OpenCode ${ctx.app.version} · location=${ctx.location.directory}`)
    instanceLog(
      `options: baseURL=${baseOrigin} · key=${keySource ?? "MISSING"} · ` +
        `searchCount=${options.searchCount} · websearchDefault=${options.websearchDefault}`,
    )
    if (!hasKey) {
      instanceLog(
        `No DeepSeek API key found: deepseek_search/deepseek_fetch will return a setup error until one is. ` +
          `Connect DeepSeek in OpenCode (/connect → DeepSeek), or set DEEPSEEK_API_KEY and restart the service.`,
      )
    }

    let tools: { dispose: () => Promise<void> } | undefined
    let websearch: { dispose: () => Promise<void> } | undefined

    try {
      tools = await registerTools(ctx, { client, options, log: instanceLog })
      instanceLog("registered tools: deepseek_search, deepseek_fetch")
      const registered = (await ctx.tool.list()).filter((tool) => tool.id.startsWith("deepseek_"))
      if (registered.length !== 2) {
        instanceLog(`warning: expected 2 deepseek tools, found ${registered.length}`)
      }
      instanceLog(
        `tool registry: ${registered
          .map(
            (tool) =>
              `${tool.id} (namespace=${tool.options?.namespace ?? "-"}, codemode=${String(tool.options?.codemode)}, ` +
              `permission=${tool.options?.permission ?? "-"})`,
          )
          .join("; ")}`,
      )
    } catch (error) {
      instanceLog(`tool registration failed: ${errorMessage(error)}`)
    }

    if (!hasKey) {
      instanceLog(
        "websearch provider not registered because no API key is available; " +
          "connect DeepSeek or set DEEPSEEK_API_KEY and reload",
      )
    } else {
      try {
        websearch = await registerWebsearch(ctx, client, options, true, instanceLog)
        const providers = await ctx.websearch.providers()
        instanceLog(
          providers.data.some((provider) => provider.id === "deepseek")
            ? 'registered websearch provider "deepseek"'
            : 'websearch provider registration did not take effect',
        )
      } catch (error) {
        instanceLog(`websearch registration failed: ${errorMessage(error)}`)
      }
    }

    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      instanceLog("cleanup")
      if (tools) await tools.dispose().catch((error) => instanceLog(`tool dispose failed: ${errorMessage(error)}`))
      if (websearch) {
        await websearch.dispose().catch((error) => instanceLog(`websearch dispose failed: ${errorMessage(error)}`))
      }
      instanceLog("unloaded")
    }
  },
})
