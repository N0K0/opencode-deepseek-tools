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

type WebsearchOptions = Pick<Options, "websearchNeedContent" | "maxContentChars" | "maxSummaryChars">

export function toWebsearchResult(result: SearchResult, options: WebsearchOptions) {
  if (typeof result.url !== "string" || result.url.trim() === "") return undefined

  const summary = typeof result.summary === "string" ? result.summary.trim() : ""
  const snippet = typeof result.snippet === "string" ? result.snippet.trim() : ""
  const page = typeof result.content === "string" ? result.content.trim() : ""

  // When the caller asked for page content, prefer it; otherwise the summary is
  // the model-readable payload and is cheaper to carry.
  const content = options.websearchNeedContent
    ? page
      ? truncateText(page, options.maxContentChars)
      : summary
        ? truncateText(summary, options.maxSummaryChars)
        : snippet
          ? truncateText(snippet, options.maxSummaryChars)
          : undefined
    : summary
      ? truncateText(summary, options.maxSummaryChars)
      : snippet
        ? truncateText(snippet, options.maxSummaryChars)
        : page
          ? truncateText(page, options.maxContentChars)
          : undefined

  const published = typeof result.date === "string" ? Date.parse(result.date) : Number.NaN
  return {
    url: result.url,
    title: typeof result.title === "string" ? result.title.trim() || undefined : undefined,
    content,
    time: Number.isFinite(published) ? { published } : {},
  }
}

export async function registerWebsearch(
  ctx: Plugin.Context,
  client: DeepSeekClient,
  options: Options,
  hasKey: boolean,
  log?: (...args: unknown[]) => void,
): Promise<{ dispose: () => Promise<void> }> {
  // A keyless provider would be selectable by "random" and fail with a 401.
  if (!hasKey) return { dispose: async () => {} }

  let announced = false
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
        log?.(`websearch — ${results.length} DeepSeek result(s)`)
        return results
          .map((result) => toWebsearchResult(result, options))
          .filter((result): result is NonNullable<typeof result> => result !== undefined)
      },
    })

    if (options.websearchDefault) {
      editor.default.set("deepseek")
      if (!announced) {
        log?.('selected "deepseek" as the default websearch provider')
        announced = true
      }
    }
  })

  return { dispose: () => registration.dispose() }
}
