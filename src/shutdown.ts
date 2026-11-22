/**
 * Stops the process cleanly on SIGTERM or SIGINT.
 *
 * The container's entrypoint `exec`s node, so node is PID 1. A PID 1 with no
 * handler for a signal ignores it, which made `docker stop` wait out its full
 * ten second grace period and then SIGKILL the container. Registering a
 * handler lets the process close the application (which stops Liquidsoap and
 * flushes telemetry) and exit at once. The close is bounded: if it does not
 * finish within `graceMs` the process exits anyway, so a hung shutdown can
 * never outlast the grace period Docker allows.
 *
 * @module shutdown
 */

/** What the handler needs from the Nest application. */
export interface ClosableApplication {
  close(): Promise<void>;
}

/** The process surface the handler uses; injectable for tests. */
export interface ShutdownProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ShutdownOptions {
  /** Longest the close may take before the process exits regardless. */
  readonly graceMs?: number;
  readonly signals?: readonly NodeJS.Signals[];
  readonly process?: ShutdownProcess;
  readonly exit?: (code: number) => void;
  readonly log?: (message: string) => void;
}

/** Docker allows ten seconds; leave room for the kill that follows. */
export const SHUTDOWN_GRACE_MS = 6_000;

/**
 * Registers the handlers and returns the function they run, so a caller or a
 * test can trigger the same shutdown directly. It runs at most once.
 */
export function installShutdownHandlers(
  app: ClosableApplication,
  options: ShutdownOptions = {},
): (signal: NodeJS.Signals) => Promise<void> {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const target = options.process ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));
  let started = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (started) return;
    started = true;
    log(`Palazzo received ${signal}; shutting down`);
    const timer = setTimeout(() => {
      log(`Palazzo shutdown did not finish within ${graceMs} ms; exiting`);
      exit(1);
    }, graceMs);
    try {
      await app.close();
      clearTimeout(timer);
      exit(0);
    } catch (error) {
      clearTimeout(timer);
      log(
        `Palazzo shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      exit(1);
    }
  };

  for (const signal of options.signals ?? (["SIGTERM", "SIGINT"] as const)) {
    target.once(signal, () => void shutdown(signal));
  }
  return shutdown;
}
