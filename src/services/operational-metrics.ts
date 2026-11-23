import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const latencyBounds = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 60_000] as const;
const maxCounter = Number.MAX_SAFE_INTEGER;

function gatewayVersion() {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string"
      ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export class OperationalMetrics {
  private readonly version = gatewayVersion();
  private readonly startedCpu = process.cpuUsage();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private readonly latency = latencyBounds.map((le) => ({ le, count: 0 }));
  private requests = 0;
  private active = 0;
  private completed = 0;
  private failed = 0;
  private rateLimited = 0;
  private overloadRejected = 0;
  private transactionFailures = 0;
  private ready = false;
  private cleanupWorker: "stopped" | "running" | "stopping" = "stopped";

  constructor() {
    this.eventLoop.enable();
  }

  private increment(value: number) {
    return value >= maxCounter ? maxCounter : value + 1;
  }

  requestStarted() {
    this.requests = this.increment(this.requests);
    this.active = this.increment(this.active);
    return performance.now();
  }

  requestFinished(startedAt: number, status: number, route: string) {
    this.active = Math.max(0, this.active - 1);
    this.completed = this.increment(this.completed);
    if (status >= 500) this.failed = this.increment(this.failed);
    if (status === 429) this.rateLimited = this.increment(this.rateLimited);
    if (status >= 400 && route.startsWith("/transaction")) {
      this.transactionFailures = this.increment(this.transactionFailures);
    }
    const elapsed = Math.max(0, performance.now() - startedAt);
    for (const bucket of this.latency) if (elapsed <= bucket.le) bucket.count = this.increment(bucket.count);
  }

  setReady(ready: boolean) { this.ready = ready; }
  setCleanupWorker(status: "stopped" | "running" | "stopping") { this.cleanupWorker = status; }
  recordOverloadRejection() { this.overloadRejected = this.increment(this.overloadRejected); }
  isReady() { return this.ready; }

  snapshot() {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.startedCpu);
    const nsToMs = (value: number) => Number.isFinite(value) ? value / 1_000_000 : 0;
    return {
      version: this.version,
      uptimeSeconds: Math.floor(process.uptime()),
      requests: {
        total: this.requests,
        active: this.active,
        completed: this.completed,
        failed: this.failed,
        rateLimited: this.rateLimited,
        overloadRejected: this.overloadRejected,
        latencyMs: { buckets: this.latency.map((bucket) => ({ ...bucket })) },
      },
      process: {
        cpuMicroseconds: { user: cpu.user, system: cpu.system },
        memoryBytes: memory,
        eventLoopDelayMs: {
          mean: nsToMs(this.eventLoop.mean),
          max: nsToMs(this.eventLoop.max),
          p50: nsToMs(this.eventLoop.percentile(50)),
          p95: nsToMs(this.eventLoop.percentile(95)),
          p99: nsToMs(this.eventLoop.percentile(99)),
        },
      },
      readiness: this.ready ? "ready" : "not_ready",
      transactionFailures: this.transactionFailures,
      cleanupWorker: this.cleanupWorker,
    };
  }

  close() {
    this.ready = false;
    this.eventLoop.disable();
  }
}
