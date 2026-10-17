// deepseek-tools — the `deepseek_search` and `deepseek_fetch` tools.
import type { Plugin } from "@opencode/plugin"
import {
  errorMessage,
  normalizeCount,
  validateQuery,
  validateUrl,
  type DeepSeekClient,
} from "./client"
import { formatFetchResult, formatSearchResults } from "./format"
import type { Options } from "./options"

const SEARCH_DESCRIPTION =
  "Search the live web with DeepSeek's in-house search engine. Returns ranked results with title, URL, " +
  "snippet, a model-readable summary, and optionally page content. Use it for current events, documentation, " +
  "and facts beyond training data; follow up with `deepseek_fetch` to read a page in full. " +
  "The query supports search operators: `site:example.com`, `-site:example.com`, `-term`, `-\"exact phrase\"`, " +
  "`\"exact phrase\"`, `lang:zh,en`, `after:2025-01-01`, `before:2026-06-01`. " +
  "Each request is billed to the DeepSeek account ($0.75 per 1,000 successful searches) and limited to 5 QPS."

const FETCH_DESCRIPTION =
  "Fetch one web page through DeepSeek and return its main content as Markdown. Use it after `deepseek_search` " +
  "when a result's summary is not enough. Accepts only HTTP(S) URLs without credentials. Pages blocked by site " +
  "policy, unavailable, or without extractable content fail (HTTP 404). " +
  "Each request is billed to the DeepSeek account ($0.75 per 1,000 successful fetches) and limited to 5 QPS."

export interface SearchInput {
  query: string
  count: number
  oriQuestion?: string
  localization?: string
  needContent: boolean
}

export function parseSearchInput(
  raw: unknown,
  defaults: { count: number; needContent: boolean } = { count: 10, needContent: false },
): SearchInput {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const query = validateQuery(input.query)
  const count = normalizeCount(input.count, defaults.count)

  const oriQuestion = input.ori_question
  if (oriQuestion !== undefined && typeof oriQuestion !== "string") {
    throw new Error("ori_question must be a string")
  }
  const localization = input.localization
  if (localization !== undefined && typeof localization !== "string") {
    throw new Error("localization must be a string")
  }
  const needContent = input.need_content
  if (needContent !== undefined && typeof needContent !== "boolean") {
    throw new Error("need_content must be a boolean")
  }

  return {
    query,
    count,
    oriQuestion: oriQuestion?.trim() || undefined,
    localization: localization?.trim() || undefined,
    needContent: typeof needContent === "boolean" ? needContent : defaults.needContent,
  }
}

export function parseFetchInput(raw: unknown): string {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return validateUrl(input.url)
}

function failure(error: unknown): { content: { type: "text"; text: string }[]; metadata: { error: string } } {
  const message = errorMessage(error)
  return { content: [{ type: "text", text: message }], metadata: { error: message } }
}

export interface ToolDeps {
  client: DeepSeekClient
  options: Options
  log?: (...args: unknown[]) => void
}

export async function registerTools(
  ctx: Plugin.Context,
  deps: ToolDeps,
): Promise<{ dispose: () => Promise<void> }> {
  const { client, options } = deps

  const registration = await ctx.tool.transform((editor) => {
    editor.namespace({
      name: "deepseek",
      description: "DeepSeek Search & Fetch — live web search and page reading.",
    })

    editor.add({
      name: "search",
      description: SEARCH_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query, 1-128 characters. Supports site:, -site:, -term, -\"phrase\", \"phrase\", " +
              "lang:, after: and before: operators.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: `Number of results to return (1-50). Defaults to ${options.searchCount}.`,
          },
          need_content: {
            type: "boolean",
            description:
              "Include each page's content in the result (larger output; per-result cap applies). " +
              "Prefer leaving this false and calling deepseek_fetch for pages you need.",
          },
          ori_question: {
            type: "string",
            description: "The user's original question, 1-128 characters, to improve query understanding.",
          },
          localization: {
            type: "string",
            description: "Optional IP address used to localize search results.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      options: { namespace: "deepseek", codemode: true, permission: "websearch" },
      async execute(raw, context) {
        try {
          const input = parseSearchInput(raw, {
            count: options.searchCount,
            needContent: options.searchNeedContent,
          })
          const results = await client.search(
            {
              query: input.query,
              count: input.count,
              oriQuestion: input.oriQuestion,
              localization: input.localization,
              needContent: input.needContent,
            },
            context.signal,
          )
          deps.log?.(`deepseek_search ${JSON.stringify(input.query)} — ${results.length} result(s)`)
          return {
            content: [
              {
                type: "text" as const,
                text: formatSearchResults(input.query, results, {
                  maxContentChars: options.maxContentChars,
                  contentRequested: input.needContent,
                }),
              },
            ],
            metadata: { query: input.query, results: results.length },
          }
        } catch (error) {
          deps.log?.(`deepseek_search failed: ${errorMessage(error)}`)
          return failure(error)
        }
      },
    })

    editor.add({
      name: "fetch",
      description: FETCH_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP or HTTPS URL to fetch, at most 8192 characters." },
        },
        required: ["url"],
        additionalProperties: false,
      },
      options: { namespace: "deepseek", codemode: true, permission: "webfetch" },
      async execute(raw, context) {
        try {
          const url = parseFetchInput(raw)
          const page = await client.fetchPage(url, context.signal)
          deps.log?.(`deepseek_fetch ${url} — ${page.content.length} chars`)
          return {
            content: [{ type: "text" as const, text: formatFetchResult(page, url) }],
            metadata: { url, title: page.title, characters: page.content.length },
          }
        } catch (error) {
          deps.log?.(`deepseek_fetch failed: ${errorMessage(error)}`)
          return failure(error)
        }
      },
    })
  })

  return { dispose: () => registration.dispose() }
}
