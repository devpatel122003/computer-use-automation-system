import fs from "node:fs";
import path from "node:path";
import { redact } from "../guardrails/redaction.js";

export type RunType = "discovery" | "replay";
export type EventPhase =
  | "start"
  | "observe"
  | "decide"
  | "act"
  | "checkpoint"
  | "outcome"
  | "escalation"
  | "error"
  | "end";

export interface LogEvent {
  ts: string;
  step: number;
  phase: EventPhase;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface EvidenceLoggerOptions {
  runId: string;
  runType: RunType;
  baseDir?: string;
  /** Field names to always mask outright (e.g. an artifact's sensitive input params). */
  sensitiveKeys?: string[];
}

export class EvidenceLogger {
  readonly runId: string;
  readonly runType: RunType;
  readonly runDir: string;
  readonly screenshotsDir: string;
  private readonly logPath: string;
  private readonly sensitiveKeys: Set<string>;
  private readonly sensitiveValues: Set<string> = new Set();

  constructor(options: EvidenceLoggerOptions) {
    this.runId = options.runId;
    this.runType = options.runType;
    const baseDir = options.baseDir ?? path.join(process.cwd(), "evidence", "runs");
    this.runDir = path.join(baseDir, options.runId);
    this.screenshotsDir = path.join(this.runDir, "screenshots");
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    this.logPath = path.join(this.runDir, "log.jsonl");
    this.sensitiveKeys = new Set(options.sensitiveKeys ?? []);
    fs.writeFileSync(this.logPath, "");
  }

  addSensitiveKeys(keys: string[]): void {
    keys.forEach((key) => this.sensitiveKeys.add(key));
  }

  /** Registers a concrete secret value (e.g. a password just typed) for scrubbing wherever
   *  it appears in future log/writeJson calls, regardless of which field it's nested under. */
  addSensitiveValue(value: string): void {
    if (value) this.sensitiveValues.add(value);
  }

  log(event: Omit<LogEvent, "ts">): void {
    const full: LogEvent = { ts: new Date().toISOString(), ...event };
    const redacted = redact(full, { sensitiveKeys: this.sensitiveKeys, sensitiveValues: this.sensitiveValues }) as LogEvent;
    fs.appendFileSync(this.logPath, `${JSON.stringify(redacted)}\n`);
  }

  writeJson(filename: string, data: unknown): string {
    const filePath = path.join(this.runDir, filename);
    const redacted = redact(data, { sensitiveKeys: this.sensitiveKeys, sensitiveValues: this.sensitiveValues });
    fs.writeFileSync(filePath, JSON.stringify(redacted, null, 2));
    return filePath;
  }
}

export function newRunId(runType: RunType): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${runType}-${stamp}`;
}
