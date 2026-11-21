import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { isIP, type LookupFunction } from "node:net";
import { unsafeAddress } from "./address-policy";

/**
 * gaulatti/palazzo#45: media is read only from addresses that passed the
 * outbound-request check. Liquidsoap and ffprobe are never given a supplied
 * address. Each media URL gets an unguessable token on a relay bound to
 * 127.0.0.1; the relay checks the URL again on every request (every address
 * the name resolves to must be public), connects to the checked address
 * only, follows no redirect, and streams an audio answer through under one
 * byte cap and the request's deadline. Range is forwarded so a tool can seek.
 */

/** The caller of a relay token (a bounded metric label). */
export const MEDIA_FETCH_PATHS = [
  "song",
  "intro",
  "instant",
  "next",
  "preflight",
  "filler",
] as const;
export type MediaFetchPath = (typeof MEDIA_FETCH_PATHS)[number];

/** The outcome of one relay request or token issue (a bounded metric label). */
export const MEDIA_FETCH_RESULTS = [
  "ok",
  "invalid_url",
  "scheme",
  "address",
  "dns",
  "redirect",
  "http_status",
  "content_type",
  "too_large",
  "timeout",
  "network",
] as const;
export type MediaFetchResult = (typeof MEDIA_FETCH_RESULTS)[number];
export type MediaRefusalReason = Exclude<MediaFetchResult, "ok">;

/** The largest media answer relayed: Alcantara's upload limit. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
/** The user agent the relay sends to media hosts. */
export const MEDIA_USER_AGENT = "palazzo-media-relay";
/** Tokens held at once; the oldest is dropped beyond this. */
export const MAX_RELAY_TOKENS = 512;
/** Test-only: allow private media addresses (local stacks). */
export const ALLOW_PRIVATE_ENV = "PALAZZO_MEDIA_ALLOW_PRIVATE";
/** The only NODE_ENV values under which the allowance is honoured. */
export const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "development",
  "test",
]);

export class MediaRefusal extends Error {
  constructor(readonly reason: MediaRefusalReason) {
    super(`media refused: ${reason}`);
    this.name = "MediaRefusal";
  }
}

export type ResolveAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type RequestFunction = (
  scheme: "https:" | "http:",
  options: https.RequestOptions,
) => http.ClientRequest;

export interface MediaRelayDeps {
  resolve: ResolveAll;
  request: RequestFunction;
  now: () => number;
}

interface RelayToken {
  url: string;
  path: MediaFetchPath;
  expiresAt: number;
  /** A URL refused when the token was issued; every request is refused. */
  refused: MediaRefusalReason | null;
}

const defaultResolve: ResolveAll = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    ),
  );

const defaultRequest: RequestFunction = (scheme, options) =>
  scheme === "https:" ? https.request(options) : http.request(options);

/**
 * Response media types relayed: audio as Alcantara's program audio accepts,
 * plus the generic binary types storage often serves media under. The tools
 * then validate the media itself; a page or text answer is never relayed.
 */
export function isAudioMediaType(mediaType: string): boolean {
  return (
    /^audio\/[a-z0-9.+-]+$/.test(mediaType) ||
    mediaType === "application/ogg" ||
    mediaType === "application/octet-stream" ||
    mediaType === "binary/octet-stream"
  );
}

/** A lookup that only ever answers the already checked address. */
export function pinnedLookup(pinned: {
  address: string;
  family: 4 | 6;
}): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (
      error: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const all =
      typeof options === "object" &&
      options !== null &&
      (options as { all?: boolean }).all === true;
    if (all) done(null, [{ address: pinned.address, family: pinned.family }]);
    else done(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

function parseMediaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaRefusal("invalid_url");
  }
  if (url.username || url.password) throw new MediaRefusal("invalid_url");
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new MediaRefusal("scheme");
  return url;
}

function mediaType(header: string | undefined): string | null {
  if (!header) return null;
  return header.split(";")[0].trim().toLowerCase() || null;
}

@Injectable()
export class MediaRelay implements OnModuleInit, OnModuleDestroy {
  /** Replaceable in tests; production uses the system resolver and transport. */
  deps: MediaRelayDeps = {
    resolve: defaultResolve,
    request: defaultRequest,
    now: () => Date.now(),
  };
  readonly allowPrivate: boolean;
  /** The byte cap per relayed answer (MAX_MEDIA_BYTES; lowered only in tests). */
  maxBytes = MAX_MEDIA_BYTES;
  private readonly tokens = new Map<string, RelayToken>();
  private readonly counts = new Map<string, number>();
  private server: http.Server | null = null;
  private port = 0;

  constructor(config: ConfigService) {
    this.allowPrivate =
      config.get<string>(ALLOW_PRIVATE_ENV)?.trim() === "true";
    // Fail closed: the allowance is honoured only in an environment that says
    // it is local or test. Unset, production or anything else refuses to start.
    const environment = config.get<string>("NODE_ENV")?.trim() ?? "";
    if (this.allowPrivate && !LOCAL_ENVIRONMENTS.has(environment)) {
      throw new Error(
        `${ALLOW_PRIVATE_ENV} is a local test setting; it is refused unless NODE_ENV is development or test`,
      );
    }
  }

  /** Starts the relay on an ephemeral port of 127.0.0.1 only. */
  async onModuleInit(): Promise<void> {
    const server = http.createServer((request, response) =>
      this.handle(request, response),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The address the relay is bound to (127.0.0.1) and its port. */
  address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null) ?? null;
  }

  /**
   * Checks `url` and returns the relay address that reads it, valid for
   * `ttlMs`. A refused URL still gets a token, which the relay refuses on
   * every request, so the tool fails the read exactly as for an address that
   * cannot be reached; the refusal is counted here.
   */
  async issue(
    url: string,
    path: MediaFetchPath,
    ttlMs: number,
  ): Promise<string> {
    if (!this.server) throw new Error("media relay is not started");
    let refused: MediaRefusalReason | null = null;
    try {
      const parsed = parseMediaUrl(url);
      await this.checkedAddress(parsed.hostname);
    } catch (error) {
      refused = (error as MediaRefusal).reason;
      this.count(path, refused);
    }
    const now = this.deps.now();
    for (const [key, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(key);
    }
    const token = randomBytes(16).toString("hex");
    // The original extension, when it is a plain one, helps a tool that
    // chooses a decoder by name; the relay ignores it.
    const extension = /\.([a-z0-9]{1,5})$/i.exec(
      (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return "";
        }
      })(),
    );
    this.tokens.set(token, {
      url,
      path,
      expiresAt: now + Math.max(0, ttlMs),
      refused,
    });
    while (this.tokens.size > MAX_RELAY_TOKENS) {
      // Look-ahead preflight tokens go first, oldest first, so a burst of
      // preflight batches never evicts a song, intro, instant, announced or
      // filler read. Only a map of playout tokens alone drops its oldest.
      let victim: string | undefined;
      for (const [key, entry] of this.tokens) {
        if (entry.path === "preflight") {
          victim = key;
          break;
        }
      }
      // An over-capacity map is nonempty; its first key is the oldest token.
      const evicted = victim ?? this.tokens.keys().next().value!;
      const kind = this.tokens.get(evicted)!.path;
      this.tokens.delete(evicted);
      this.evictions.set(kind, (this.evictions.get(kind) ?? 0) + 1);
      // #56: a playout read evicted under pressure will answer 404.
      if (kind !== "preflight")
        this.logger.warn(
          `Media relay evicted a ${kind} token at its ${MAX_RELAY_TOKENS}-token limit`,
        );
    }
    return `http://127.0.0.1:${this.port}/m/${token}${extension ? `.${extension[1].toLowerCase()}` : ""}`;
  }

  private readonly logger = new Logger("MediaRelay");
  private readonly evictions = new Map<string, number>();

  renderMetrics(): string {
    const lines = [
      "# HELP palazzo_media_fetch_total Media reads through the outbound check, by caller and bounded result.",
      "# TYPE palazzo_media_fetch_total counter",
    ];
    for (const path of MEDIA_FETCH_PATHS) {
      for (const result of MEDIA_FETCH_RESULTS) {
        lines.push(
          `palazzo_media_fetch_total{path="${path}",result="${result}"} ${this.counts.get(`${path}\u0000${result}`) ?? 0}`,
        );
      }
    }
    lines.push(
      "# HELP palazzo_media_relay_evictions_total Relay tokens evicted at the token limit, by path kind.",
      "# TYPE palazzo_media_relay_evictions_total counter",
    );
    for (const path of MEDIA_FETCH_PATHS) {
      lines.push(
        `palazzo_media_relay_evictions_total{path="${path}"} ${this.evictions.get(path) ?? 0}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  private count(path: MediaFetchPath, result: MediaFetchResult): void {
    const key = `${path}\u0000${result}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /**
   * Resolves `hostname`, refuses it unless every address is public, and
   * returns the address the connection must use.
   */
  private async checkedAddress(
    hostname: string,
  ): Promise<{ address: string; family: 4 | 6 }> {
    const bare = hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(bare);
    if (literal) {
      if (!this.allowPrivate && unsafeAddress(bare))
        throw new MediaRefusal("address");
      return { address: bare, family: literal as 4 | 6 };
    }
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.deps.resolve(bare);
    } catch {
      throw new MediaRefusal("dns");
    }
    if (!addresses.length) throw new MediaRefusal("dns");
    if (
      !this.allowPrivate &&
      addresses.some(({ address }) => unsafeAddress(address))
    )
      throw new MediaRefusal("address");
    const first = addresses[0];
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  }

  private handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    const match = /^\/m\/([0-9a-f]{32})(?:\.[a-z0-9]{1,5})?$/.exec(
      String(request.url),
    );
    const entry = match ? this.tokens.get(match[1]) : undefined;
    const now = this.deps.now();
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      !entry ||
      entry.expiresAt <= now
    ) {
      response.writeHead(404).end();
      return;
    }
    if (entry.refused) {
      this.count(entry.path, entry.refused);
      response.writeHead(502).end();
      return;
    }
    void this.relay(entry, request, response, entry.expiresAt - now);
  }

  private async relay(
    entry: RelayToken,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    remainingMs: number,
  ): Promise<void> {
    let upstream: http.IncomingMessage | null = null;
    let outgoing: http.ClientRequest | null = null;
    let settled = false;
    const finish = (result: MediaFetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.count(entry.path, result);
      if (result !== "ok") {
        upstream?.destroy();
        outgoing?.destroy();
        if (response.headersSent) response.destroy();
        else response.writeHead(result === "timeout" ? 504 : 502).end();
      }
    };
    const timer = setTimeout(() => finish("timeout"), remainingMs);
    response.once("close", () => {
      if (response.writableFinished) return;
      // The tool hung up before the answer finished: stop reading the origin.
      // ffprobe does this once it has read what it needs, so a hang-up after
      // a valid answer started is a successful read; one before any answer is
      // a failed one. Either way the deadline timer stops here.
      upstream?.destroy();
      outgoing?.destroy();
      finish(response.headersSent ? "ok" : "network");
    });
    try {
      const url = parseMediaUrl(entry.url);
      const pinned = await this.checkedAddress(url.hostname);
      if (settled) return;
      // Liquidsoap and ffmpeg always sent a user agent, and some media hosts
      // refuse a request without one; this is the only other header sent.
      const headers: http.OutgoingHttpHeaders = {
        host: url.host,
        "user-agent": MEDIA_USER_AGENT,
      };
      if (typeof request.headers.range === "string")
        headers.range = request.headers.range;
      const bare = url.hostname.replace(/^\[|\]$/g, "");
      outgoing = this.deps.request(url.protocol as "https:" | "http:", {
        protocol: url.protocol,
        hostname: bare,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        // Connect to the checked address only; SNI stays the host name.
        lookup: pinnedLookup(pinned),
        servername: isIP(bare) ? undefined : bare,
        agent: false,
      });
      upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
        outgoing!.once("response", resolve);
        outgoing!.once("error", () => reject(new MediaRefusal("network")));
        outgoing!.end();
      });
      // A deadline that passed meanwhile destroyed the request, so it either
      // rejected above or never answers: an answer here is within the deadline.
      const status = Number(upstream.statusCode);
      if (status >= 300 && status < 400) throw new MediaRefusal("redirect");
      if (status !== 200 && status !== 206)
        throw new MediaRefusal("http_status");
      const type = mediaType(upstream.headers["content-type"]);
      if (!type || !isAudioMediaType(type))
        throw new MediaRefusal("content_type");
      const declared = Number(upstream.headers["content-length"]);
      if (Number.isFinite(declared) && declared > this.maxBytes)
        throw new MediaRefusal("too_large");
      const forwarded: http.OutgoingHttpHeaders = { "content-type": type };
      for (const name of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers[name];
        if (value !== undefined) forwarded[name] = value;
      }
      response.writeHead(status, forwarded);
      let bytes = 0;
      upstream.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) return finish("too_large");
        if (!response.write(chunk)) {
          upstream!.pause();
          response.once("drain", () => upstream!.resume());
        }
      });
      upstream.once("end", () => {
        if (settled) return;
        response.end();
        finish("ok");
      });
      upstream.once("error", () => finish("network"));
    } catch (error) {
      finish(error instanceof MediaRefusal ? error.reason : "network");
    }
  }
}
