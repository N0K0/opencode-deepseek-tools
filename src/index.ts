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
// Authentication: `DEEPSEEK_API_KEY` (or the `apiKeyEnv` option), or a literal
// `apiKey` / `{env:NAME}` plugin option. No key is ever written to the config.
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
async function storedDeepSeekKey(ctx: Plugin.Context, logLine: (...args: unknown[]) => void): Promise<string | undefined> {
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
    const tag = `#${++instanceSeq}`
    const instanceLog = (...args: unknown[]) => log(`(${tag})`, ...args)

    const storedKey = await storedDeepSeekKey(ctx, instanceLog)
    const client: DeepSeekClient = clientFromOptions(options, instanceLog, storedKey)
    const hasKey = client.hasApiKey()
    const envKey = resolveApiKey({ apiKeyEnv: options.apiKeyEnv })
    const keySource = options.apiKey
      ? "plugin option"
      : envKey
        ? `env ${options.apiKeyEnv}`
        : storedKey
          ? 'OpenCode credential "deepseek"'
          : undefined

    instanceLog(`setup — OpenCode ${ctx.app.version} · location=${ctx.location.directory}`)
    instanceLog(
      `options: baseURL=${options.baseURL} · key=${keySource ?? "MISSING"} · ` +
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

    try {
      websearch = await registerWebsearch(ctx, client, options, instanceLog)
      instanceLog('registered websearch provider "deepseek"')
    } catch (error) {
      instanceLog(`websearch registration failed: ${errorMessage(error)}`)
    }

    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      instanceLog("cleanup")
      if (tools) await tools.dispose().catch((error) => instanceLog(`tool dispose failed: ${errorMessage(error)}`))
      if (websearch) await websearch.dispose().catch((error) => instanceLog(`websearch dispose failed: ${errorMessage(error)}`))
      instanceLog("unloaded")
    }
  },
})
