import { describe, expect, test } from "bun:test"
import { formatFetchResult, formatSearchResults, truncateText } from "./format"
import { parseOptions } from "./options"
import { parseFetchInput, parseSearchInput } from "./tools"

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
    expect(formatFetchResult({ title: "Example", content: "Body" }, "https://example.com")).toBe(
      "# Example\n\nSource: https://example.com\n\nBody",
    )
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

  test("rejects a missing query and a bad fetch URL", () => {
    expect(() => parseSearchInput({})).toThrow()
    expect(() => parseFetchInput({ url: "ftp://x" })).toThrow()
    expect(parseFetchInput({ url: "https://x.test" })).toBe("https://x.test")
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
})
