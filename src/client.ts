// deepseek-tools — client for the DeepSeek Search & Fetch APIs.
//
// Endpoints (https://api-docs.deepseek.com/guides/search):
//   POST {baseURL}/v1/tools/search
//   POST {baseURL}/v1/tools/fetch
//
// Both are billed per successful request (not per result), limited to 5 QPS per
// account, and return OpenAI-style errors. We retry 408/429/5xx with backoff and
// never retry other 4xx errors without changing the request.
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
  /** Last-resort key, e.g. resolved from OpenCode's integration store. */
  integrationKey?: string
  baseURL?: string
  timeoutMs?: number
  maxRetries?: number
  fetchImpl?: FetchLike
  log?: (...args: unknown[]) => void
}

export interface DeepSeekClient {
  hasApiKey(): boolean
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult[]>
  fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult>
}

const DEFAULT_BASE_URL = "https://api.deepseek.com"
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const ENV_TEMPLATE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

/** Thrown for local validation failures and for `AbortSignal` cancellation. */
function invalid(message: string): DeepSeekError {
  return new DeepSeekError(message, { code: "invalid_request" })
}

export function resolveApiKey(
  config: Pick<ClientConfig, "apiKey" | "apiKeyEnv" | "integrationKey">,
): string | undefined {
  const raw = config.apiKey?.trim()
  if (raw) {
    const template = ENV_TEMPLATE.exec(raw)
    if (!template) return raw
    const fromTemplate = process.env[template[1]!]?.trim()
    if (fromTemplate) return fromTemplate
  }

  const envName = config.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv) return fromEnv

  if (envName !== DEFAULT_API_KEY_ENV) {
    const fallback = process.env[DEFAULT_API_KEY_ENV]?.trim()
    if (fallback) return fallback
  }

  const fromIntegration = config.integrationKey?.trim()
  if (fromIntegration) return fromIntegration
  return undefined
}

function unicodeLength(value: string): number {
  return [...value].length
}

export function validateQuery(query: unknown): string {
  if (typeof query !== "string") throw invalid("query must be a string")
  if (query.trim() === "") throw invalid("query must not be empty or whitespace")
  if (unicodeLength(query) > 128) throw invalid("query must be at most 128 characters")
  return query.trim()
}

export function normalizeCount(count: unknown, fallback = 10): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return fallback
  return Math.min(50, Math.max(1, Math.trunc(count)))
}

export function validateUrl(url: unknown): string {
  if (typeof url !== "string") throw invalid("url must be a string")
  if (url.length === 0) throw invalid("url must not be empty")
  if (url.length > 8192) throw invalid("url must be at most 8192 characters")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalid("url must be an absolute HTTP or HTTPS URL with a host")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid("url must use http or https")
  }
  if (parsed.username || parsed.password) {
    throw invalid("url must not contain a username or password")
  }
  return url
}

function describeStatus(status: number, detail: string | undefined): string {
  const base =
    status === 400
      ? "DeepSeek rejected the request (HTTP 400)"
      : status === 401
        ? "DeepSeek rejected the API key (HTTP 401) — check DEEPSEEK_API_KEY"
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
  return detail ? `${base}: ${detail}` : base
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
    const at = Date.parse(header)
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 30_000)
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
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted", "AbortError")
}

async function readErrorBody(response: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; code?: unknown } }
    return {
      message: typeof body.error?.message === "string" ? body.error.message : undefined,
      code: typeof body.error?.code === "string" ? body.error.code : undefined,
    }
  } catch {
    return {}
  }
}

export function createClient(config: ClientConfig = {}): DeepSeekClient {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  const fetchImpl = config.fetchImpl ?? fetch
  const log = config.log ?? (() => {})

  const hasApiKey = (): boolean => resolveApiKey(config) !== undefined

  async function post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const apiKey = resolveApiKey(config)
    if (!apiKey) {
      throw new DeepSeekError(
        "DeepSeek API key is not configured. Set the DEEPSEEK_API_KEY environment variable " +
          "(or the plugin option `apiKey`) and restart OpenCode.",
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
        if (signal?.aborted) throw abortError(signal)
        const failure = timeout.signal.aborted
          ? new DeepSeekError(`DeepSeek request timed out after ${timeoutMs} ms`, { code: "timeout", cause: error })
          : new DeepSeekError(`Could not reach DeepSeek: ${errorMessage(error)}`, { code: "network_error", cause: error })
        if (attempt >= maxRetries) throw failure
        log(`request to ${path} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${failure.message}`)
        await sleep(networkDelayMs(attempt), signal)
        continue
      } finally {
        clearTimeout(timer)
      }

      if (response.ok) return (await response.json()) as T

      const detail = await readErrorBody(response)
      const failure = new DeepSeekError(describeStatus(response.status, detail.message), {
        status: response.status,
        code: detail.code ?? "http_error",
      })
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) throw failure

      log(`request to ${path} returned ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}) — retrying`)
      await sleep(retryDelayMs(response, attempt), signal)
    }
  }

  return {
    hasApiKey,
    async search(request, signal) {
      const query = validateQuery(request.query)
      const count = normalizeCount(request.count, 10)
      const body: Record<string, unknown> = { query, count }

      const oriQuestion = request.oriQuestion?.trim()
      if (oriQuestion) {
        if (unicodeLength(oriQuestion) > 128) throw invalid("ori_question must be at most 128 characters")
        body.ori_question = oriQuestion
      }
      const localization = request.localization?.trim()
      if (localization) body.localization = localization
      if (request.needContent !== undefined) body.need_content = request.needContent

      const response = await post<{ results?: SearchResult[] }>("/v1/tools/search", body, signal)
      return Array.isArray(response.results) ? response.results : []
    },
    async fetchPage(url, signal) {
      const validUrl = validateUrl(url)
      return await post<FetchResult>("/v1/tools/fetch", { url: validUrl }, signal)
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
  integrationKey?: string,
): DeepSeekClient {
  return createClient({
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    integrationKey,
    baseURL: options.baseURL,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    log,
  })
}
