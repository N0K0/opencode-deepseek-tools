import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createClient,
  normalizeCount,
  resolveApiKey,
  validateQuery,
  validateUrl,
} from "./client"

const realKey = process.env.DEEPSEEK_API_KEY

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "test-key"
})

afterEach(() => {
  if (realKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = realKey
})

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

type Call = { url: string; init: RequestInit }

describe("resolveApiKey", () => {
  test("prefers a literal option", () => {
    expect(resolveApiKey({ apiKey: "literal" })).toBe("literal")
  })

  test("resolves {env:NAME} templates", () => {
    process.env.DEEPSEEK_TEST_KEY = "from-template"
    expect(resolveApiKey({ apiKey: "{env:DEEPSEEK_TEST_KEY}" })).toBe("from-template")
    delete process.env.DEEPSEEK_TEST_KEY
  })

  test("falls back to the configured env var, then DEEPSEEK_API_KEY", () => {
    expect(resolveApiKey({ apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe("test-key")
    expect(resolveApiKey({ apiKeyEnv: "SOME_OTHER_KEY" })).toBe("test-key")
    delete process.env.DEEPSEEK_API_KEY
    expect(resolveApiKey({})).toBeUndefined()
  })

  test("falls back to an integration key after env sources", () => {
    delete process.env.DEEPSEEK_API_KEY
    expect(resolveApiKey({ integrationKey: "integration-key" })).toBe("integration-key")
    process.env.DEEPSEEK_API_KEY = "env-key"
    expect(resolveApiKey({ integrationKey: "integration-key" })).toBe("env-key")
  })
})

describe("validation", () => {
  test("rejects empty, whitespace and overlong queries", () => {
    expect(() => validateQuery("")).toThrow()
    expect(() => validateQuery("   ")).toThrow()
    expect(() => validateQuery("a".repeat(129))).toThrow()
    expect(validateQuery("  DeepSeek V4  ")).toBe("DeepSeek V4")
  })

  test("counts Unicode code points, not UTF-16 units", () => {
    expect(validateQuery("🚀".repeat(128))).toBe("🚀".repeat(128))
    expect(() => validateQuery("🚀".repeat(129))).toThrow()
  })

  test("validates URLs", () => {
    expect(validateUrl("https://example.com/a")).toBe("https://example.com/a")
    expect(() => validateUrl("ftp://example.com")).toThrow()
    expect(() => validateUrl("https://user:pass@example.com")).toThrow()
    expect(() => validateUrl("not a url")).toThrow()
  })

  test("clamps counts to 1..50", () => {
    expect(normalizeCount(0)).toBe(1)
    expect(normalizeCount(500)).toBe(50)
    expect(normalizeCount(12.9)).toBe(12)
    expect(normalizeCount(undefined, 7)).toBe(7)
  })
})

describe("search", () => {
  test("posts to the search endpoint with auth and the documented body", async () => {
    const calls: Call[] = []
    const client = createClient({
      baseURL: "https://api.deepseek.com/",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return json({
          results: [
            {
              rerank_score: 2.4,
              title: "DeepSeek V4 released",
              url: "https://example.com/deepseek-v4",
              snippet: "V4 is available.",
              summary: "DeepSeek released V4.",
            },
          ],
        })
      },
    })

    const results = await client.search({
      query: "DeepSeek V4 release",
      count: 5,
      needContent: true,
      oriQuestion: "When did DeepSeek V4 ship?",
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe("DeepSeek V4 released")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search")
    expect(calls[0]!.init.method).toBe("POST")
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: "DeepSeek V4 release",
      count: 5,
      ori_question: "When did DeepSeek V4 ship?",
      need_content: true,
    })
  })

  test("returns an empty array when the API returns no matches", async () => {
    const client = createClient({ fetchImpl: async () => json({ results: [] }) })
    expect(await client.search({ query: "nothing" })).toEqual([])
  })

  test("fails clearly without an API key", async () => {
    delete process.env.DEEPSEEK_API_KEY
    const client = createClient({ fetchImpl: async () => json({}) })
    expect(client.hasApiKey()).toBe(false)
    await expect(client.search({ query: "x" })).rejects.toThrow(/DEEPSEEK_API_KEY/)
  })

  test("retries 429 responses and honours Retry-After", async () => {
    let attempts = 0
    const client = createClient({
      maxRetries: 1,
      fetchImpl: async () => {
        attempts++
        if (attempts === 1) return json({ error: { message: "slow down" } }, 429, { "retry-after": "0" })
        return json({ results: [] })
      },
    })
    expect(await client.search({ query: "x" })).toEqual([])
    expect(attempts).toBe(2)
  })

  test("does not retry non-retryable errors", async () => {
    let attempts = 0
    const client = createClient({
      maxRetries: 3,
      fetchImpl: async () => {
        attempts++
        return json({ error: { message: "no balance" } }, 402)
      },
    })
    await expect(client.search({ query: "x" })).rejects.toThrow(/insufficient balance/)
    expect(attempts).toBe(1)
  })

  test("includes the API's error detail", async () => {
    const client = createClient({
      fetchImpl: async () => json({ error: { message: "'count' must be between 1 and 50" } }, 400),
    })
    await expect(client.search({ query: "x" })).rejects.toThrow(/'count' must be between 1 and 50/)
  })
})

describe("fetch", () => {
  test("posts the URL and returns title + markdown content", async () => {
    const calls: Call[] = []
    const client = createClient({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return json({ title: "Example", content: "# Example\n\nBody." })
      },
    })

    const page = await client.fetchPage("https://example.com/article")
    expect(page).toEqual({ title: "Example", content: "# Example\n\nBody." })
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/fetch")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ url: "https://example.com/article" })
  })

  test("rejects invalid URLs before calling the API", async () => {
    let called = false
    const client = createClient({
      fetchImpl: async () => {
        called = true
        return json({})
      },
    })
    await expect(client.fetchPage("file:///etc/passwd")).rejects.toThrow(/http/)
    expect(called).toBe(false)
  })

  test("reports 404 with an actionable message", async () => {
    const client = createClient({ fetchImpl: async () => json({ error: { message: "blocked" } }, 404) })
    await expect(client.fetchPage("https://example.com")).rejects.toThrow(/could not retrieve usable page content/)
  })
})

describe("cancellation", () => {
  test("propagates an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort(new Error("user stopped"))
    const client = createClient({ fetchImpl: async () => json({ results: [] }) })
    await expect(client.search({ query: "x" }, controller.signal)).rejects.toThrow("user stopped")
  })
})
