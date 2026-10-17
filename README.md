# opencode-deepseek-tools

DeepSeek's Search and Fetch APIs, wired into OpenCode.

The plugin gives you two tools, `deepseek_search` and `deepseek_fetch`, and registers DeepSeek as a websearch provider. Once it is loaded, OpenCode's normal `websearch` tool uses DeepSeek's index instead of asking for an Exa, Tavily, or Firecrawl key.

It reads the DeepSeek key you already connected in OpenCode. Nothing gets copied into your config.

## What it adds

`deepseek_search` sends a query to DeepSeek's in-house search engine and returns ranked results: title, URL, site, publication date, relevance score, authority tier, a short snippet, and a longer summary written for a model to read. You can ask for page content too, but it is usually better to leave that off and fetch the pages you care about.

`deepseek_fetch` takes one URL and returns the page as Markdown. DeepSeek rejects pages blocked by site policy, pages without extractable content, and anything that is not HTTP or HTTPS.

The websearch provider is selected as the default when a key is available. If you would rather keep another provider as the default, set `websearchDefault` to `false` and DeepSeek will still be in the provider list when you want it.

## Install

Add the plugin to `~/.config/opencode/opencode.json`, pointing at the checkout:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/deepseek-tools",
      "options": {
        "websearchDefault": true
      }
    }
  ]
}
```

Then reload the location or restart OpenCode. If DeepSeek is connected in OpenCode, that is the only setup step.

If you would rather use an environment variable, set `DEEPSEEK_API_KEY` before OpenCode starts. The plugin checks these sources, in order:

1. `apiKey` in the plugin options, either a literal key or `{env:NAME}`.
2. The variable named by `apiKeyEnv` (default `DEEPSEEK_API_KEY`).
3. The active credential for OpenCode's `deepseek` integration.

The key is resolved when the plugin loads, so a reload picks up a rotated key.

The log lives at `~/.local/share/opencode/log/deepseek-tools.log`. A healthy load looks like this:

```text
options: baseURL=https://api.deepseek.com · key=OpenCode credential "deepseek" · ...
registered tools: deepseek_search, deepseek_fetch
registered websearch provider "deepseek"
selected "deepseek" as the default websearch provider
```

## Using the tools

The tools are registered in a `deepseek` namespace with Code Mode enabled, so you call them through `execute`:

```js
const results = await tools.deepseek.search({
  query: "bun 1.4 release site:bun.sh",
  count: 5,
})

const page = await tools.deepseek.fetch({ url: results[0].url })
```

Queries are passed through unchanged, so DeepSeek's operators work: `site:`, `-site:`, `-term`, `-"exact phrase"`, `"exact phrase"`, `lang:zh,en`, `after:2025-01-01`, and `before:2026-06-01`.

The regular `websearch` tool accepts the same operators. It does not expose `count` or `need_content`; those are set with plugin options.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `apiKey` | none | Literal key or `{env:NAME}`. |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Environment variable to read the key from. |
| `baseURL` | `https://api.deepseek.com` | API base URL, useful behind a proxy. |
| `timeoutMs` | `30000` | Timeout for one request. |
| `maxRetries` | `2` | Retries for 408, 429, 5xx, and network failures. |
| `searchCount` | `10` | Default result count for `deepseek_search`. |
| `searchNeedContent` | `false` | Default for `need_content`. |
| `maxContentChars` | `20000` | Per-result cap when content is included. |
| `websearchDefault` | `true` | Make DeepSeek the default websearch provider. |
| `websearchCount` | `10` | Result count for the built-in websearch tool. |
| `websearchNeedContent` | `false` | Ask for page content in websearch results. |

## How it behaves

Requests go to `POST /v1/tools/search` and `POST /v1/tools/fetch` with a bearer token. A 408, 429, or 5xx response is retried with exponential backoff, and `Retry-After` is honoured when the API sends it. Other 4xx errors are returned as-is, since retrying them would just produce the same answer.

Errors carry enough context to act on: 401 means the key is wrong, 402 means the account is out of balance, 403 means DeepSeek's security policy rejected the fetch, 404 means the page had no usable content, and 429 means you hit the rate limit.

Aborting a session aborts the in-flight request. `deepseek_search` uses the `websearch` permission action and `deepseek_fetch` uses `webfetch`, so existing rules apply.

DeepSeek bills per successful request: $0.75 per 1,000 searches and $0.75 per 1,000 fetches. Failed requests, empty searches, and timeouts are free. Both APIs allow 5 requests per second per account, independently of each other.

## Development

```sh
bun install
bun test
bun run typecheck
```

The tests use a fake `fetch`, so they do not need an API key or network access.

## License

MIT
