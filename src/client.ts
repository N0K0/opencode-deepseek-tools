// deepseek-tools — client for the DeepSeek Search & Fetch APIs.
//
// Endpoints (https://api-docs.deepseek.com/guides/search):
//   POST {baseURL}/v1/tools/search
//   POST {baseURL}/v1/tools/fetch
//
// Both are billed per successful request (not per result), limited to 5 QPS per
// account, and return OpenAI-style errors. We retry 408/429/5xx with backoff and
// never retry other 4xx errors without changing the request.
import { isIP } from "node:net"
import type { Options } from "./options"

export interface SearchRequest {
  query: string
  count?: number
  oriQuestion?: string
  localization?: string
  needContent?: boolean
}

export interface SearchResult {
  rerank_score?: number
  title: string
  url: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  site_icon?: string | null
  date?: string | null
  authority?: number
}

export interface FetchResult {
  title: string
  content: string
}

export interface DeepSeekErrorInit {
  status?: number
  code?: string
  cause?: unknown
}

export class DeepSeekError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(message: string, init: DeepSeekErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = "DeepSeekError"
    this.status = init.status
    this.code = init.code
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ClientConfig {
  /** Literal key, or `{env:NAME}`. */
  apiKey?: string
  apiKeyEnv?: string
  /** Lazily resolve a key from OpenCode's integration store, per request. */
  getApiKey?: () => Promise<string | undefined>
  baseURL?: string
  timeoutMs?: number
  maxRetries?: number
  fetchImpl?: FetchLike
  log?: (...args: unknown[]) => void
}

export interface DeepSeekClient {
  hasApiKey(): Promise<boolean>
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult[]>
  fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult>
}

const DEFAULT_BASE_URL = "https://api.deepseek.com"
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 30_000
const ENV_TEMPLATE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

function invalid(message: string): DeepSeekError {
  return new DeepSeekError(message, { code: "invalid_request" })
}

function invalidResponse(message: string): DeepSeekError {
  return new DeepSeekError(message, { code: "invalid_response" })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unicodeLength(value: string): number {
  let length = 0
  for (const _ of value) length++
  return length
}

/** Normalize and validate a base URL. The bearer token only goes over HTTPS. */
export function normalizeBaseURL(value: string): string {
  const trimmed = value.trim()
  if (trimmed === "") throw invalid("baseURL must not be empty")

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw invalid("baseURL must be an absolute URL")
  }

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw invalid("baseURL must use https (http is allowed only for loopback hosts)")
  }
  if (parsed.username || parsed.password) throw invalid("baseURL must not contain a username or password")
  if (!parsed.host) throw invalid("baseURL must have a host")
  return parsed.href.replace(/\/+$/, "")
}

/**
 * Resolve the static key sources. The OpenCode credential is resolved lazily by
 * the client, so a rotated key is picked up without reloading the plugin.
 */
export function resolveApiKey(config: Pick<ClientConfig, "apiKey" | "apiKeyEnv">): string | undefined {
  const raw = config.apiKey?.trim()
  if (raw) {
    if (raw.startsWith("{env:")) {
      const template = ENV_TEMPLATE.exec(raw)
      if (template) {
        const value = process.env[template[1]!]?.trim()
        if (value) return value
      }
      // Malformed or unset template: fall through instead of sending it as a key.
    } else {
      return raw
    }
  }

  const envName = config.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv) return fromEnv

  if (envName !== DEFAULT_API_KEY_ENV) {
    const fallback = process.env[DEFAULT_API_KEY_ENV]?.trim()
    if (fallback) return fallback
  }
  return undefined
}

export function validateQuery(query: unknown): string {
  if (typeof query !== "string") throw invalid("query must be a string")
  const trimmed = query.trim()
  if (trimmed === "") throw invalid("query must not be empty or whitespace")
  if (unicodeLength(trimmed) > 128) throw invalid("query must be at most 128 characters")
  return trimmed
}

export function normalizeCount(count: unknown, fallback = 10): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return fallback
  return Math.min(50, Math.max(1, Math.trunc(count)))
}

export function validateUrl(url: unknown): string {
  if (typeof url !== "string") throw invalid("url must be a string")
  const trimmed = url.trim()
  if (trimmed.length === 0) throw invalid("url must not be empty")
  if (unicodeLength(trimmed) > 8192) throw invalid("url must be at most 8192 characters")
  if (CONTROL_CHARS.test(trimmed)) throw invalid("url must not contain control characters")

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw invalid("url must be an absolute HTTP or HTTPS URL with a host")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("url must use http or https")
  }
  if (!parsed.host) throw invalid("url must have a host")
  if (parsed.username || parsed.password) {
    throw invalid("url must not contain a username or password")
  }
  if (unicodeLength(parsed.href) > 8192) throw invalid("url must be at most 8192 characters after normalization")
  return parsed.href
}

export function validateLocalization(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw invalid("localization must be a string")
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (isIP(trimmed) === 0) throw invalid("localization must be an IPv4 or IPv6 address")
  return trimmed
}

/** Normalize a search response, dropping entries without a usable URL. */
export function parseSearchResponse(raw: unknown): SearchResult[] {
  if (!isRecord(raw)) {
    throw invalidResponse("DeepSeek returned an invalid search response (expected an object)")
  }
  if (!Array.isArray(raw.results)) {
    throw invalidResponse("DeepSeek returned an invalid search response (missing results array)")
  }

  const results: SearchResult[] = []
  for (const entry of raw.results) {
    if (!isRecord(entry)) continue
    if (typeof entry.url !== "string" || entry.url.trim() === "") continue

    const result: SearchResult = {
      title: typeof entry.title === "string" ? entry.title : "",
      url: entry.url,
    }
    if (typeof entry.rerank_score === "number" && Number.isFinite(entry.rerank_score)) {
      result.rerank_score = entry.rerank_score
    }
    if (typeof entry.snippet === "string") result.snippet = entry.snippet
    if (typeof entry.summary === "string") result.summary = entry.summary
    if (typeof entry.content === "string") result.content = entry.content
    if (typeof entry.site_name === "string") result.site_name = entry.site_name
    if (typeof entry.site_icon === "string") result.site_icon = entry.site_icon
    if (typeof entry.date === "string") result.date = entry.date
    if (typeof entry.authority === "number" && Number.isFinite(entry.authority)) {
      result.authority = Math.trunc(entry.authority)
    }
    results.push(result)
  }

  if (raw.results.length > 0 && results.length === 0) {
    throw invalidResponse("DeepSeek returned search results but none had a usable URL")
  }
  return results
}

/** Normalize a fetch response. A 200 without a content string is malformed. */
export function parseFetchResponse(raw: unknown): FetchResult {
  if (!isRecord(raw)) {
    throw invalidResponse("DeepSeek returned an invalid fetch response (expected an object)")
  }
  if (typeof raw.content !== "string") {
    throw invalidResponse("DeepSeek returned an invalid fetch response (missing content)")
  }
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    content: raw.content,
  }
}

function describeStatus(status: number, detail: string | undefined): string {
  const base =
    status === 400
      ? "DeepSeek rejected the request (HTTP 400)"
      : status === 401
        ? "DeepSeek rejected the API key (HTTP 401) — check the configured DeepSeek credential"
        : status === 402
          ? "DeepSeek account has insufficient balance (HTTP 402) — top up the account"
          : status === 403
            ? "DeepSeek's security policy rejected the request (HTTP 403)"
            : status === 404
              ? "DeepSeek could not retrieve usable page content (HTTP 404)"
              : status === 408
                ? "DeepSeek timed out reading the request (HTTP 408)"
                : status === 413
                  ? "DeepSeek request body was too large (HTTP 413)"
                  : status === 429
                    ? "DeepSeek rate limit exceeded (HTTP 429, 5 requests/second per account)"
                    : status >= 500
                      ? `DeepSeek server error (HTTP ${status})`
                      : `DeepSeek request failed (HTTP ${status})`
  const clean = redactDetail(detail)
  return clean ? `${base}: ${clean}` : base
}

/** Keep provider error text short and prevent a reflected bearer token. */
function redactDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined
  const clean = detail
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(CONTROL_CHARS, " ")
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header) {
    if (/^[+-]?\d+(?:\.\d+)?$/.test(header.trim())) {
      const seconds = Number(header)
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    } else {
      const at = Date.parse(header)
      if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS)
    }
  }
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250)
}

function networkDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 250)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function abortError(signal?: AbortSignal): unknown {
  const reason = signal?.reason
  if (reason !== undefined) return reason instanceof Error ? reason : new Error(String(reason))
  return new DOMException("The operation was aborted", "AbortError")
}

/** Race a body read against the request signal, so a stalled body cannot hang. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {})
    return Promise.reject(abortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function readErrorBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ message?: string; code?: string }> {
  try {
    const body = await withAbort(response.json(), signal)
    if (!isRecord(body) || !isRecord(body.error)) return {}
    return {
      message: typeof body.error.message === "string" ? body.error.message : undefined,
      code: typeof body.error.code === "string" ? body.error.code : undefined,
    }
  } catch (error) {
    if (signal.aborted) throw error
    return {}
  }
}

export function createClient(config: ClientConfig = {}): DeepSeekClient {
  const baseURL = normalizeBaseURL(config.baseURL ?? DEFAULT_BASE_URL)
  const timeoutMs =
    typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs >= 1
      ? Math.trunc(config.timeoutMs)
      : DEFAULT_TIMEOUT_MS
  const maxRetries =
    typeof config.maxRetries === "number" && Number.isInteger(config.maxRetries) && config.maxRetries >= 0
      ? Math.min(config.maxRetries, 10)
      : DEFAULT_MAX_RETRIES
  const fetchImpl = config.fetchImpl ?? fetch
  const log = config.log ?? (() => {})

  async function keyForRequest(): Promise<string | undefined> {
    const staticKey = resolveApiKey(config)
    if (staticKey) return staticKey
    if (config.getApiKey) {
      try {
        return (await config.getApiKey())?.trim() || undefined
      } catch (error) {
        log(`could not resolve the OpenCode credential: ${errorMessage(error)}`)
        return undefined
      }
    }
    return undefined
  }

  async function post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const apiKey = await keyForRequest()
    if (!apiKey) {
      throw new DeepSeekError(
        "DeepSeek API key is not configured. Connect DeepSeek in OpenCode (/connect → DeepSeek), " +
          "set the DEEPSEEK_API_KEY environment variable, or set the plugin option `apiKey`.",
        { code: "missing_api_key" },
      )
    }

    const url = `${baseURL}${path}`
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortError(signal)

      const timeout = new AbortController()
      const timer = setTimeout(() => {
        timeout.abort(new DeepSeekError(`DeepSeek request timed out after ${timeoutMs} ms`, { code: "timeout" }))
      }, timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: combined,
        })
      } catch (error) {
        clearTimeout(timer)
        if (signal?.aborted) throw abortError(signal)
        const failure = timeout.signal.aborted
          ? new DeepSeekError(`DeepSeek request timed out after ${timeoutMs} ms`, { code: "timeout", cause: error })
          : new DeepSeekError(`Could not reach DeepSeek: ${errorMessage(error)}`, {
              code: "network_error",
              cause: error,
            })
        if (attempt >= maxRetries) throw failure
        log(`request to ${path} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${failure.message}`)
        await sleep(networkDelayMs(attempt), signal)
        continue
      }

      try {
        if (response.ok) {
          try {
            return await withAbort(response.json() as Promise<T>, combined)
          } catch (error) {
            if (signal?.aborted) throw abortError(signal)
            if (timeout.signal.aborted) {
              const failure = new DeepSeekError(`DeepSeek request timed out after ${timeoutMs} ms`, {
                code: "timeout",
                cause: error,
              })
              if (attempt >= maxRetries) throw failure
              log(
                `request to ${path} timed out while reading the response ` +
                  `(attempt ${attempt + 1}/${maxRetries + 1}) — retrying`,
              )
              clearTimeout(timer)
              await sleep(networkDelayMs(attempt), signal)
              continue
            }
            if (error instanceof DeepSeekError) throw error
            throw new DeepSeekError(`DeepSeek returned an invalid JSON response (HTTP ${response.status})`, {
              status: response.status,
              code: "invalid_response",
              cause: error,
            })
          }
        }

        let detail: { message?: string; code?: string } = {}
        try {
          detail = await readErrorBody(response, combined)
        } catch (error) {
          if (signal?.aborted) throw abortError(signal)
          if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
            if (timeout.signal.aborted) {
              throw new DeepSeekError(`DeepSeek request timed out after ${timeoutMs} ms`, {
                code: "timeout",
                cause: error,
              })
            }
            throw error
          }
          log(
            `request to ${path} returned ${response.status} but the error body stalled ` +
              `(attempt ${attempt + 1}/${maxRetries + 1}) — retrying`,
          )
          clearTimeout(timer)
          await sleep(retryDelayMs(response, attempt), signal)
          continue
        }

        const failure = new DeepSeekError(describeStatus(response.status, detail.message), {
          status: response.status,
          code: detail.code ?? "http_error",
        })
        if (!isRetryableStatus(response.status) || attempt >= maxRetries) throw failure

        log(`request to ${path} returned ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}) — retrying`)
        clearTimeout(timer)
        await sleep(retryDelayMs(response, attempt), signal)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  return {
    async hasApiKey() {
      return (await keyForRequest()) !== undefined
    },
    async search(request, signal) {
      const query = validateQuery(request.query)
      const count = normalizeCount(request.count, 10)
      const body: Record<string, unknown> = { query, count }

      const oriQuestion = request.oriQuestion?.trim()
      if (oriQuestion) {
        if (unicodeLength(oriQuestion) > 128) throw invalid("ori_question must be at most 128 characters")
        body.ori_question = oriQuestion
      }
      const localization = validateLocalization(request.localization)
      if (localization) body.localization = localization
      if (request.needContent !== undefined) body.need_content = request.needContent

      const response = await post<unknown>("/v1/tools/search", body, signal)
      return parseSearchResponse(response)
    },
    async fetchPage(url, signal) {
      const validUrl = validateUrl(url)
      const response = await post<unknown>("/v1/tools/fetch", { url: validUrl }, signal)
      return parseFetchResponse(response)
    },
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request was cancelled"
    return error.message
  }
  return String(error)
}

export function clientFromOptions(
  options: Options,
  log?: (...args: unknown[]) => void,
  getApiKey?: () => Promise<string | undefined>,
): DeepSeekClient {
  return createClient({
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    getApiKey,
    baseURL: options.baseURL,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    log,
  })
}
