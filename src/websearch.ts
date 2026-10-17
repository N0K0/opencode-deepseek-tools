// deepseek-tools — register DeepSeek as a websearch provider.
//
// This makes the built-in `websearch` tool use DeepSeek's in-house engine
// instead of the bundled providers (Exa, Tavily, …), which need their own keys.
// The provider returns the search API's `summary` (written for a model to read)
// as result content; full pages stay one `deepseek_fetch` call away.
import type { Plugin } from "@opencode/plugin"
import type { DeepSeekClient, SearchResult } from "./client"
import { truncateText } from "./format"
import type { Options } from "./options"

function toWebsearchResult(result: SearchResult, maxContentChars: number) {
  const published = result.date ? Date.parse(result.date) : Number.NaN
  const content =
    result.summary?.trim() ||
    result.snippet?.trim() ||
    (result.content ? truncateText(result.content, maxContentChars) : undefined)

  return {
    url: result.url,
    title: result.title?.trim() || undefined,
    content,
    time: Number.isFinite(published) ? { published } : {},
  }
}

export async function registerWebsearch(
  ctx: Plugin.Context,
  client: DeepSeekClient,
  options: Options,
  log?: (...args: unknown[]) => void,
): Promise<{ dispose: () => Promise<void> }> {
  const registration = await ctx.websearch.transform((editor) => {
    editor.add({
      id: "deepseek",
      name: "DeepSeek Search",
      async execute({ query }, { signal }) {
        const results = await client.search(
          {
            query,
            count: options.websearchCount,
            needContent: options.websearchNeedContent,
          },
          signal,
        )
        log?.(`websearch "${query}" — ${results.length} DeepSeek result(s)`)
        return results.map((result) => toWebsearchResult(result, options.maxContentChars))
      },
    })

    // Only make DeepSeek the default when it can actually authenticate;
    // otherwise the built-in websearch tool would break with a 401.
    if (options.websearchDefault && client.hasApiKey()) {
      editor.default.set("deepseek")
      log?.(`selected "deepseek" as the default websearch provider`)
    } else if (options.websearchDefault) {
      log?.(`websearchDefault is true but no API key is available — leaving the provider unselected`)
    }
  })

  return { dispose: () => registration.dispose() }
}
