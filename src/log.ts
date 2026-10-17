// deepseek-tools — logging.
//
// Same rationale as the other local plugins: `console.log` is swallowed by the
// plugin runtime, `console.error` reaches stderr (visible when running
// standalone), and the detached background service is only greppable through a
// file. Mirror both so `[deepseek-tools]` lines are always findable.
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_BYTES = 2_000_000

let cached: string | undefined

function targetFile(): string | undefined {
  if (cached !== undefined) return cached || undefined
  try {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const dir = join(dataHome, "opencode", "log")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    cached = join(dir, "deepseek-tools.log")
  } catch {
    cached = ""
  }
  return cached || undefined
}

function rotate(file: string) {
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // file missing or rename failed — appending either way is fine
  }
}

function format(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function log(...args: unknown[]): void {
  const line = `${new Date().toISOString()} [deepseek-tools] ${args.map(format).join(" ")}`
  console.error(line)
  const file = targetFile()
  if (!file) return
  try {
    rotate(file)
    appendFileSync(file, `${line}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {
    // never let logging break the plugin
  }
}
