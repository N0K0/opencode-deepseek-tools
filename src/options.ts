// deepseek-tools — options.
//
// Field-by-field parsing of `ctx.options`; invalid values fall back to the
// default with a warning so a typo never breaks loading.
import { log } from "./log"

export type Options = {
  /** API key (literal or `{env:NAME}`). When unset, the env var below is used. */
  apiKey?: string
  /** Environment variable that holds the API key. Default `DEEPSEEK_API_KEY`. */
  apiKeyEnv: string
  /** API base URL. Default `https://api.deepseek.com`. */
  baseURL: string
  /** Per-request timeout. Default 30 s. */
  timeoutMs: number
  /** Retries for 408/429/5xx and network errors. Default 2. */
  maxRetries: number
  /** Default `count` for `deepseek_search`. Default 10. */
  searchCount: number
  /** Default `need_content` for `deepseek_search`. Default false. */
  searchNeedContent: boolean
  /** Per-result content cap in tool output. Default 20 000 chars. */
  maxContentChars: number
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
    apply(raw)
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

export function parseOptions(raw: unknown): Options {
  const options: Options = { ...DEFAULTS }
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}

  readString(input, "apiKey", (value) => (options.apiKey = value))
  readString(input, "apiKeyEnv", (value) => (options.apiKeyEnv = value))
  readString(input, "baseURL", (value) => (options.baseURL = value.replace(/\/+$/, "")))
  readNumber(input, "timeoutMs", 1_000, 120_000, (value) => (options.timeoutMs = Math.trunc(value)))
  readNumber(input, "maxRetries", 0, 5, (value) => (options.maxRetries = Math.trunc(value)))
  readNumber(input, "searchCount", 1, 50, (value) => (options.searchCount = Math.trunc(value)))
  readNumber(input, "maxContentChars", 1_000, 200_000, (value) => (options.maxContentChars = Math.trunc(value)))
  readNumber(input, "websearchCount", 1, 50, (value) => (options.websearchCount = Math.trunc(value)))
  readBoolean(input, "searchNeedContent", (value) => (options.searchNeedContent = value))
  readBoolean(input, "websearchDefault", (value) => (options.websearchDefault = value))
  readBoolean(input, "websearchNeedContent", (value) => (options.websearchNeedContent = value))

  return options
}
