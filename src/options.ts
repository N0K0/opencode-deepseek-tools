// deepseek-tools — options.
//
// Field-by-field parsing of `ctx.options`; invalid values fall back to the
// default with a warning so a typo never breaks loading.
import { errorMessage, normalizeBaseURL } from "./client"
import { log } from "./log"

export type Options = {
  /** API key (literal or `{env:NAME}`). When unset, the env var below is used. */
  apiKey?: string
  /** Environment variable that holds the API key. Default `DEEPSEEK_API_KEY`. */
  apiKeyEnv: string
  /** API base URL. Default `https://api.deepseek.com`. */
  baseURL: string
  /** Per-request timeout, including response-body reads. Default 30 s. */
  timeoutMs: number
  /** Retries for 408/429/5xx and network errors. Default 2. */
  maxRetries: number
  /** Default `count` for `deepseek_search`. Default 10. */
  searchCount: number
  /** Default `need_content` for `deepseek_search`. Default false. */
  searchNeedContent: boolean
  /** Per-result content cap in search output. Default 20 000 chars. */
  maxContentChars: number
  /** Cap for each result's summary. Default 4 000 chars. */
  maxSummaryChars: number
  /** Cap for one fetched page. Default 50 000 chars. */
  maxFetchChars: number
  /** Total cap for a search tool result. Default 120 000 chars. */
  maxOutputChars: number
  /** Make DeepSeek the default websearch provider when a key is available. Default true. */
  websearchDefault: boolean
  /** `count` used by the built-in websearch provider. Default 10. */
  websearchCount: number
  /** Request full page content from the search API for websearch. Default false. */
  websearchNeedContent: boolean
}

export const DEFAULTS: Options = {
  apiKeyEnv: "DEEPSEEK_API_KEY",
  baseURL: "https://api.deepseek.com",
  timeoutMs: 30_000,
  maxRetries: 2,
  searchCount: 10,
  searchNeedContent: false,
  maxContentChars: 20_000,
  maxSummaryChars: 4_000,
  maxFetchChars: 50_000,
  maxOutputChars: 120_000,
  websearchDefault: true,
  websearchCount: 10,
  websearchNeedContent: false,
}

function readNumber(
  input: Record<string, unknown>,
  key: keyof Options,
  min: number,
  max: number,
  apply: (value: number) => void,
): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max) {
    apply(Math.trunc(raw))
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

function readBoolean(input: Record<string, unknown>, key: keyof Options, apply: (value: boolean) => void): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "boolean") {
    apply(raw)
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

function readString(input: Record<string, unknown>, key: keyof Options, apply: (value: string) => void): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "string" && raw.trim() !== "") {
    apply(raw.trim())
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

/** Never log the value of `apiKey`; it may be a real secret. */
function readApiKey(input: Record<string, unknown>, apply: (value: string) => void): void {
  const raw = input.apiKey
  if (raw === undefined) return
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = raw.trim()
    if (value.startsWith("{env:") && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) {
      log('options: "apiKey" looks like a malformed {env:NAME} template — ignoring it')
      return
    }
    apply(value)
    return
  }
  log('options: invalid "apiKey" — ignoring it')
}

/** Reject non-HTTPS base URLs (except loopback) so the bearer token stays encrypted. */
function readBaseURL(input: Record<string, unknown>, apply: (value: string) => void): void {
  const raw = input.baseURL
  if (raw === undefined) return
  if (typeof raw !== "string" || raw.trim() === "") {
    log(`options: invalid "baseURL" — using default ${DEFAULTS.baseURL}`)
    return
  }
  try {
    apply(normalizeBaseURL(raw))
  } catch (error) {
    log(`options: invalid "baseURL" (${errorMessage(error)}) — using default ${DEFAULTS.baseURL}`)
  }
}

export function parseOptions(raw: unknown): Options {
  const options: Options = { ...DEFAULTS }
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}

  readApiKey(input, (value) => (options.apiKey = value))
  readString(input, "apiKeyEnv", (value) => (options.apiKeyEnv = value))
  readBaseURL(input, (value) => (options.baseURL = value))
  readNumber(input, "timeoutMs", 1_000, 120_000, (value) => (options.timeoutMs = value))
  readNumber(input, "maxRetries", 0, 5, (value) => (options.maxRetries = value))
  readNumber(input, "searchCount", 1, 50, (value) => (options.searchCount = value))
  readNumber(input, "maxContentChars", 1_000, 200_000, (value) => (options.maxContentChars = value))
  readNumber(input, "maxSummaryChars", 100, 50_000, (value) => (options.maxSummaryChars = value))
  readNumber(input, "maxFetchChars", 1_000, 1_000_000, (value) => (options.maxFetchChars = value))
  readNumber(input, "maxOutputChars", 1_000, 1_000_000, (value) => (options.maxOutputChars = value))
  readNumber(input, "websearchCount", 1, 50, (value) => (options.websearchCount = value))
  readBoolean(input, "searchNeedContent", (value) => (options.searchNeedContent = value))
  readBoolean(input, "websearchDefault", (value) => (options.websearchDefault = value))
  readBoolean(input, "websearchNeedContent", (value) => (options.websearchNeedContent = value))

  return options
}
