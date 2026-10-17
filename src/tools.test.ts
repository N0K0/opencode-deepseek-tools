import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { formatFetchResult, formatSearchResults, truncateText } from "./format"
import { parseOptions } from "./options"
import { parseFetchInput, parseSearchInput } from "./tools"
import { toWebsearchResult } from "./websearch"

// Keep test warnings out of the real plugin log.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "deepseek-tools-test-"))

describe("formatSearchResults", () => {
  test("renders titles, links, metadata, summary and content", () => {
    const text = formatSearchResults("DeepSeek V4", [
      {
        rerank_score: 2.4,
        title: "DeepSeek V4 released",
        url: "https://example.com/deepseek-v4",
        snippet: "V4 is available.",
        summary: "DeepSeek released V4 with tool calling.",
        content: "# V4\n\nFull text.",
        site_name: "Example News",
        date: "2026-06-01T00:00:00+00:00",
        authority: 3,
      },
    ])

    expect(text).toContain("1. DeepSeek V4 released")
    expect(text).toContain("URL: https://example.com/deepseek-v4")
    expect(text).toContain("Site: Example News")
    expect(text).toContain("Published: 2026-06-01T00:00:00+00:00")
    expect(text).toContain("Score: 2.40")
    expect(text).toContain("Authority: 3 (high)")
    expect(text).toContain("Summary: DeepSeek released V4 with tool calling.")
    expect(text).toContain("Full text.")
    expect(text).toContain("deepseek_fetch")
  })

  test("explains an empty result set", () => {
    expect(formatSearchResults("nothing", [])).toContain("No results.")
  })

  test("does not duplicate an identical snippet", () => {
    const text = formatSearchResults("q", [
      { title: "T", url: "https://e.com", snippet: "same", summary: "same" },
    ])
    expect(text.match(/same/g)).toHaveLength(1)
  })

  test("caps content and notes missing content when requested", () => {
    const text = formatSearchResults(
      "q",
      [
        { title: "A", url: "https://a.com", content: "x".repeat(50) },
        { title: "B", url: "https://b.com", content: "" },
      ],
      { maxContentChars: 10, contentRequested: true },
    )
    expect(text).toContain("[truncated 40 characters]")
    expect(text).toContain("Content: (not available)")
  })
})

describe("formatFetchResult", () => {
  test("renders a page", () => {
    const text = formatFetchResult({ title: "Example", content: "Body" }, "https://example.com")
    expect(text).toContain("# Example")
    expect(text).toContain("Source: https://example.com")
    expect(text).toContain("untrusted web content")
    expect(text).toContain("Body")
  })

  test("handles missing title and content", () => {
    const text = formatFetchResult({ title: "", content: "" }, "https://example.com")
    expect(text).toContain("# Untitled page")
    expect(text).toContain("no extractable content")
  })
})

describe("truncateText", () => {
  test("leaves short text alone and marks long text", () => {
    expect(truncateText("abc", 10)).toBe("abc")
    expect(truncateText("abcdef", 3)).toBe("abc\n… [truncated 3 characters]")
  })

  test("never splits a surrogate pair", () => {
    expect(truncateText("🚀🚀", 1)).toBe("🚀\n… [truncated 1 character]")
    expect(truncateText("a😀b", 2)).toBe("a😀\n… [truncated 1 character]")
  })
})

describe("input parsing", () => {
  test("applies configured defaults", () => {
    const input = parseSearchInput({ query: " q " }, { count: 7, needContent: true })
    expect(input).toEqual({ query: "q", count: 7, oriQuestion: undefined, localization: undefined, needContent: true })
  })

  test("accepts snake_case fields from the model", () => {
    const input = parseSearchInput({
      query: "q",
      count: 3,
      need_content: false,
      ori_question: " why? ",
      localization: "1.2.3.4",
    })
    expect(input.count).toBe(3)
    expect(input.needContent).toBe(false)
    expect(input.oriQuestion).toBe("why?")
    expect(input.localization).toBe("1.2.3.4")
  })

  test("treats null optional fields as not provided", () => {
    const input = parseSearchInput({ query: "q", ori_question: null, localization: null, need_content: null })
    expect(input.oriQuestion).toBeUndefined()
    expect(input.localization).toBeUndefined()
    expect(input.needContent).toBe(false)
  })

  test("rejects a missing query and a bad fetch URL", () => {
    expect(() => parseSearchInput({})).toThrow()
    expect(() => parseFetchInput({ url: "ftp://x" })).toThrow()
    expect(parseFetchInput({ url: "https://x.test" })).toBe("https://x.test/")
    expect(() => parseSearchInput({ query: "q", localization: "not-an-ip" })).toThrow()
  })
})

describe("parseOptions", () => {
  test("uses defaults", () => {
    expect(parseOptions(undefined)).toMatchObject({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseURL: "https://api.deepseek.com",
      searchCount: 10,
      websearchDefault: true,
    })
  })

  test("accepts valid overrides and ignores invalid ones", () => {
    const options = parseOptions({
      baseURL: "https://proxy.test/",
      searchCount: 25,
      timeoutMs: 9_000,
      websearchDefault: false,
      bogus: true,
    })
    expect(options.baseURL).toBe("https://proxy.test")
    expect(options.searchCount).toBe(25)
    expect(options.timeoutMs).toBe(9_000)
    expect(options.websearchDefault).toBe(false)

    expect(parseOptions({ searchCount: 999 }).searchCount).toBe(10)
    expect(parseOptions({ timeoutMs: "soon" }).timeoutMs).toBe(30_000)
  })

  test("rejects an invalid or insecure baseURL", () => {
    expect(parseOptions({ baseURL: "not a url" }).baseURL).toBe("https://api.deepseek.com")
    expect(parseOptions({ baseURL: "http://example.com" }).baseURL).toBe("https://api.deepseek.com")
    expect(parseOptions({ baseURL: "http://127.0.0.1:8080" }).baseURL).toBe("http://127.0.0.1:8080")
  })

  test("never logs or accepts a malformed apiKey template", () => {
    expect(parseOptions({ apiKey: "{env:}" }).apiKey).toBeUndefined()
    expect(parseOptions({ apiKey: "{env:NAME}" }).apiKey).toBe("{env:NAME}")
  })

  test("includes the output-size defaults", () => {
    expect(parseOptions(undefined)).toMatchObject({
      maxSummaryChars: 4_000,
      maxFetchChars: 50_000,
      maxOutputChars: 120_000,
    })
  })
})

describe("format caps", () => {
  test("caps summaries and the total output", () => {
    const text = formatSearchResults(
      "q",
      [{ title: "T", url: "https://e.com", summary: "s".repeat(5_000) }],
      { maxSummaryChars: 100, maxOutputChars: 1_000 },
    )
    expect(text).toContain("truncated")
    expect(text.length).toBeLessThan(1_200)
  })

  test("caps fetched pages", () => {
    const text = formatFetchResult({ title: "T", content: "x".repeat(100) }, "https://e.com", { maxChars: 10 })
    expect(text).toContain("truncated 90 characters")
  })
})

describe("websearch mapping", () => {
  test("prefers page content when requested", () => {
    const mapped = toWebsearchResult(
      { title: "T", url: "https://e.com", summary: "summary", content: "c".repeat(50) },
      { websearchNeedContent: true, maxContentChars: 10, maxSummaryChars: 2_000 },
    )
    expect(mapped?.content).toContain("truncated")
    expect(mapped?.content?.startsWith("c")).toBe(true)
  })

  test("prefers the summary when content was not requested", () => {
    const mapped = toWebsearchResult(
      { title: "T", url: "https://e.com", summary: "summary", content: "page" },
      { websearchNeedContent: false, maxContentChars: 10, maxSummaryChars: 2_000 },
    )
    expect(mapped?.content).toBe("summary")
  })

  test("drops entries without a URL and handles bad dates", () => {
    const mapped = toWebsearchResult(
      { title: "T", url: "", summary: "s", date: "not-a-date" },
      { websearchNeedContent: false, maxContentChars: 10, maxSummaryChars: 2_000 },
    )
    expect(mapped).toBeUndefined()

    const dated = toWebsearchResult(
      { title: "T", url: "https://e.com", date: "not-a-date" },
      { websearchNeedContent: false, maxContentChars: 10, maxSummaryChars: 2_000 },
    )
    expect(dated?.time).toEqual({})
  })
})
