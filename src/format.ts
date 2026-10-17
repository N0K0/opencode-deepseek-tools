// deepseek-tools — rendering search/fetch results for model consumption.
import type { FetchResult, SearchResult } from "./client"

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}\n… [truncated ${text.length - max} characters]`
}

export interface FormatSearchOptions {
  /** Cap for each result's `content`, when present. Default 20 000. */
  maxContentChars?: number
  /** Whether `need_content` was requested, so we can explain missing content. */
  contentRequested?: boolean
}

export function formatSearchResults(
  query: string,
  results: readonly SearchResult[],
  options: FormatSearchOptions = {},
): string {
  const maxContentChars = options.maxContentChars ?? 20_000
  const header = `DeepSeek search — ${results.length} result${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}`

  if (results.length === 0) {
    return (
      `${header}\n\nNo results. Try a broader query, or remove restrictive operators ` +
      `(site:, -site:, "..." or language/date filters).`
    )
  }

  const sections = results.map((result, index) => {
    const lines: string[] = [`${index + 1}. ${result.title?.trim() || "(untitled)"}`]
    lines.push(`   URL: ${result.url}`)

    const meta: string[] = []
    if (result.site_name) meta.push(`Site: ${result.site_name}`)
    if (result.date) meta.push(`Published: ${result.date}`)
    if (typeof result.rerank_score === "number") meta.push(`Score: ${result.rerank_score.toFixed(2)}`)
    if (typeof result.authority === "number" && result.authority >= 0) {
      meta.push(`Authority: ${result.authority}${result.authority >= 3 ? " (high)" : ""}`)
    }
    if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`)

    const summary = result.summary?.trim()
    const snippet = result.snippet?.trim()
    if (summary) lines.push(`   Summary: ${summary}`)
    if (snippet && snippet !== summary) lines.push(`   Snippet: ${snippet}`)

    const content = result.content?.trim()
    if (content) {
      lines.push(`   Content:\n\n${truncateText(content, maxContentChars)}`)
    } else if (options.contentRequested) {
      lines.push("   Content: (not available)")
    }

    return lines.join("\n")
  })

  const footer = options.contentRequested
    ? ""
    : "\n\nUse `deepseek_fetch` with a result URL to read the full page."

  return `${header}\n\n${sections.join("\n\n")}${footer}`
}

export function formatFetchResult(result: FetchResult, url: string): string {
  const title = result.title?.trim() || "Untitled page"
  const content = result.content?.trim()
  return `# ${title}\n\nSource: ${url}\n\n${content || "(DeepSeek returned no extractable content for this page.)"}`
}
