import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ASSETS = 100;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

interface AssetRequest {
  id: string;
  sha256: string;
  downloadUrl: string;
}

export interface FillerPreparationRequest {
  commandId: string;
  mode?: 'ordered' | 'shuffle';
  shuffleSeed?: string;
  assets: AssetRequest[];
}

interface PreparedAsset {
  id: string;
  sourceSha256: string;
  artifact: string;
  artifactSha256: string;
  durationSeconds: number;
}

interface FillerManifest {
  schemaVersion: 1;
  version: string;
  status: 'ready';
  ready: true;
  mode: 'ordered' | 'shuffle';
  requestHash: string;
  profile: {
    codec: 'mp3';
    sampleRate: 44100;
    channels: 2;
    bitrateKbps: number;
  };
  assets: PreparedAsset[];
  playbackOrder: string[];
  preparedAt: string;
}

export interface FillerPublicState {
  version: string;
  status: 'unprepared' | 'preparing' | 'ready' | 'failed';
  ready: boolean;
  mode?: 'ordered' | 'shuffle';
  profile?: FillerManifest['profile'];
  assets?: Array<Omit<PreparedAsset, 'artifact'>>;
  preparedAt?: string;
  failureReason?: string;
}

@Injectable()
export class FillerStoreService {
  readonly activePlaylistPath: string;
  private readonly programRoot: string;
  private readonly bitrateKbps: number;
  private activeVersion: string | null = null;
  private preparationState: FillerPublicState | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private outcomes = { success: 0, failure: 0, conflict: 0 };
  private preparedVersionCount = 0;

  constructor(config: ConfigService) {
    const programId = config.get<string>('PROGRAM_ID')?.trim() ?? '';
    if (!programId) throw new Error('PROGRAM_ID is required');
    const root =
      config.get<string>('RADIO_FILLER_STORE_DIR')?.trim() ||
      '/var/lib/palazzo/fillers';
    this.programRoot = join(
      root,
      createHash('sha256').update(programId).digest('hex'),
    );
    this.activePlaylistPath =
      config.get<string>('RADIO_FILLER_PLAYLIST_PATH')?.trim() ||
      '/run/palazzo/active-filler.m3u';
    const bitrate = Number(config.get<string>('BITRATE') ?? 128);
    if (!Number.isInteger(bitrate) || bitrate < 32 || bitrate > 320) {
      throw new Error('BITRATE must be an integer between 32 and 320');
    }
    this.bitrateKbps = bitrate;
  }

  async initialize(): Promise<void> {
    await mkdir(this.programRoot, { recursive: true });
    await mkdir(join(this.activePlaylistPath, '..'), { recursive: true });
    const selected = await this.readActiveSelection();
    if (selected && (await this.readValidManifest(selected))) {
      await this.writeActivePlaylist(selected);
      this.activeVersion = selected;
    } else {
      await this.atomicWrite(this.activePlaylistPath, '');
      this.activeVersion = null;
      if (selected) await rm(this.activeSelectionPath(), { force: true });
    }
    this.preparedVersionCount = await this.countPreparedVersions();
  }

  prepare(version: string, request: FillerPreparationRequest, key?: string) {
    return this.enqueue(() => this.prepareSerialized(version, request, key));
  }

  async getPublicState(version: string): Promise<FillerPublicState> {
    this.validateIdentifier(version, 'invalid-version');
    if (
      this.preparationState?.version === version &&
      this.preparationState.status !== 'ready'
    ) {
      return this.preparationState;
    }
    const manifest = await this.readValidManifest(version);
    return manifest
      ? this.publicManifest(manifest)
      : { version, status: 'unprepared', ready: false };
  }

  async activate(version: string): Promise<void> {
    const manifest = await this.readValidManifest(version);
    if (!manifest)
      throw new ConflictException('requested filler version is not prepared');
    if (this.activeVersion && this.activeVersion !== version) {
      throw new ConflictException('active session filler version is immutable');
    }
    await this.writeActivePlaylist(version);
    await this.atomicWrite(this.activeSelectionPath(), `${version}\n`);
    this.activeVersion = version;
  }

  async deactivate(): Promise<void> {
    await this.atomicWrite(this.activePlaylistPath, '');
    await rm(this.activeSelectionPath(), { force: true });
    this.activeVersion = null;
  }

  getActiveVersion(): string | null {
    return this.activeVersion;
  }

  getRuntimeState() {
    return {
      activeVersion: this.activeVersion,
      activeReady: this.activeVersion !== null,
      preparationStatus: this.preparationState?.status ?? 'idle',
      preparedVersions: this.preparedVersionCount,
    };
  }

  async cleanup(retain = 3): Promise<void> {
    const entries = await readdir(this.programRoot, { withFileTypes: true });
    const versions: Array<{ name: string; modified: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!(await this.readValidManifest(entry.name))) continue;
      versions.push({
        name: entry.name,
        modified: (await stat(this.versionDirectory(entry.name))).mtimeMs,
      });
    }
    versions.sort((left, right) => right.modified - left.modified);
    const keep = new Set(versions.slice(0, retain).map((item) => item.name));
    if (this.activeVersion) keep.add(this.activeVersion);
    await Promise.all(
      versions
        .filter((item) => !keep.has(item.name))
        .map((item) =>
          rm(this.versionDirectory(item.name), { recursive: true }),
        ),
    );
    this.preparedVersionCount = await this.countPreparedVersions();
  }

  renderMetrics(): string {
    return [
      '# HELP palazzo_filler_active Whether a validated filler version is bound to the current session.',
      '# TYPE palazzo_filler_active gauge',
      `palazzo_filler_active ${this.activeVersion ? 1 : 0}`,
      '# HELP palazzo_filler_preparation_in_progress Whether one filler version is being prepared.',
      '# TYPE palazzo_filler_preparation_in_progress gauge',
      `palazzo_filler_preparation_in_progress ${this.preparationState?.status === 'preparing' ? 1 : 0}`,
      '# HELP palazzo_filler_prepared_versions Number of locally validated prepared versions.',
      '# TYPE palazzo_filler_prepared_versions gauge',
      `palazzo_filler_prepared_versions ${this.preparedVersionCount}`,
      '# HELP palazzo_filler_preparations_total Filler preparation attempts by bounded outcome.',
      '# TYPE palazzo_filler_preparations_total counter',
      `palazzo_filler_preparations_total{outcome="success"} ${this.outcomes.success}`,
      `palazzo_filler_preparations_total{outcome="failure"} ${this.outcomes.failure}`,
      `palazzo_filler_preparations_total{outcome="conflict"} ${this.outcomes.conflict}`,
      '',
    ].join('\n');
  }

  private async prepareSerialized(
    version: string,
    request: FillerPreparationRequest,
    key?: string,
  ): Promise<FillerPublicState> {
    this.validateIdentifier(version, 'invalid-version');
    const normalized = this.validateRequest(request, key);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(normalized.semantic))
      .digest('hex');
    const existing = await this.readValidManifest(version);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.outcomes.conflict += 1;
        throw new ConflictException(
          'filler version already has different immutable content',
        );
      }
      return this.publicManifest(existing);
    }

    this.preparationState = { version, status: 'preparing', ready: false };
    const staging = join(this.programRoot, `.${version}.${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const prepared: PreparedAsset[] = [];
      for (let index = 0; index < normalized.assets.length; index += 1) {
        const asset = normalized.assets[index];
        const sourcePath = join(staging, `source-${index}`);
        const artifact = `track-${String(index).padStart(3, '0')}.mp3`;
        const artifactPath = join(staging, artifact);
        await this.download(asset.downloadUrl, sourcePath);
        if ((await this.sha256File(sourcePath)) !== asset.sha256)
          throw new Error('checksum-mismatch');
        await this.transcode(sourcePath, artifactPath);
        const durationSeconds = await this.validateAudio(artifactPath);
        prepared.push({
          id: asset.id,
          sourceSha256: asset.sha256,
          artifact,
          artifactSha256: await this.sha256File(artifactPath),
          durationSeconds,
        });
        await rm(sourcePath, { force: true });
      }
      const playbackOrder = this.orderAssets(
        prepared,
        normalized.mode,
        normalized.shuffleSeed,
      ).map((asset) => asset.artifact);
      const manifest: FillerManifest = {
        schemaVersion: 1,
        version,
        status: 'ready',
        ready: true,
        mode: normalized.mode,
        requestHash,
        profile: {
          codec: 'mp3',
          sampleRate: 44100,
          channels: 2,
          bitrateKbps: this.bitrateKbps,
        },
        assets: prepared,
        playbackOrder,
        preparedAt: new Date().toISOString(),
      };
      await writeFile(
        join(staging, 'manifest.json'),
        `${JSON.stringify(manifest)}\n`,
        { flag: 'wx' },
      );
      await writeFile(
        join(staging, 'playlist.m3u'),
        `${playbackOrder.map((name) => join(staging, name)).join('\n')}\n`,
      );
      const target = this.versionDirectory(version);
      const quarantine = `${target}.invalid.${randomUUID()}`;
      let quarantined = false;
      try {
        await rename(target, quarantine);
        quarantined = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if (quarantined) await rename(quarantine, target);
        throw error;
      }
      if (quarantined) await rm(quarantine, { recursive: true, force: true });
      await this.rewriteStoredPlaylist(manifest);
      this.outcomes.success += 1;
      this.preparationState = this.publicManifest(manifest);
      await this.cleanup();
      return this.preparationState;
    } catch (error) {
      this.outcomes.failure += 1;
      const reason = this.boundedReason(error);
      this.preparationState = {
        version,
        status: 'failed',
        ready: false,
        failureReason: reason,
      };
      throw new BadRequestException({
        error: 'filler preparation failed',
        reason,
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private validateRequest(request: FillerPreparationRequest, key?: string) {
    if (!request || typeof request !== 'object' || request.commandId !== key)
      throw new BadRequestException('commandId must equal Idempotency-Key');
    this.validateIdentifier(request.commandId, 'invalid-command');
    const mode = request.mode ?? 'ordered';
    if (mode !== 'ordered' && mode !== 'shuffle')
      throw new BadRequestException('mode must be ordered or shuffle');
    const shuffleSeed = request.shuffleSeed?.trim() ?? '';
    if (mode === 'shuffle' && (!shuffleSeed || shuffleSeed.length > 200))
      throw new BadRequestException(
        'bounded shuffleSeed is required for shuffle mode',
      );
    if (
      !Array.isArray(request.assets) ||
      request.assets.length < 1 ||
      request.assets.length > MAX_ASSETS
    )
      throw new BadRequestException('assets must contain 1 to 100 items');
    const assets = request.assets.map((asset) => {
      this.validateIdentifier(asset?.id, 'invalid-asset');
      const checksum = asset?.sha256?.toLowerCase();
      if (!SHA256.test(checksum ?? ''))
        throw new BadRequestException('invalid asset checksum');
      let url: URL;
      try {
        url = new URL(asset.downloadUrl);
      } catch {
        throw new BadRequestException('invalid asset download URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new BadRequestException(
          'asset download URL must use http or https',
        );
      return { id: asset.id, sha256: checksum, downloadUrl: asset.downloadUrl };
    });
    const ids = new Set(assets.map((asset) => asset.id));
    if (ids.size !== assets.length)
      throw new BadRequestException('asset IDs must be unique');
    return {
      mode,
      shuffleSeed,
      assets,
      semantic: {
        commandId: request.commandId,
        mode,
        shuffleSeed,
        assets: assets.map(({ id, sha256 }) => ({ id, sha256 })),
      },
    };
  }

  private async download(url: string, destination: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('download-failed');
    }
    if (!response.ok || !response.body) throw new Error('download-failed');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_ASSET_BYTES) throw new Error('download-too-large');
    const file = await open(destination, 'wx');
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_ASSET_BYTES) throw new Error('download-too-large');
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
  }

  private async transcode(source: string, output: string): Promise<void> {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-i',
          source,
          '-map',
          '0:a:0',
          '-vn',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-codec:a',
          'libmp3lame',
          '-b:a',
          `${this.bitrateKbps}k`,
          output,
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      throw new Error('decode-failed');
    }
  }

  private async validateAudio(path: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_name,sample_rate,channels:format=duration',
          '-of',
          'json',
          path,
        ],
        { timeout: 30_000 },
      );
      const probe = JSON.parse(stdout);
      const stream = probe.streams?.[0];
      const duration = Number(probe.format?.duration);
      if (
        stream?.codec_name !== 'mp3' ||
        Number(stream.sample_rate) !== 44100 ||
        Number(stream.channels) !== 2 ||
        !Number.isFinite(duration) ||
        duration <= 0
      )
        throw new Error();
      return Number(duration.toFixed(3));
    } catch {
      throw new Error('validation-failed');
    }
  }

  private orderAssets(
    assets: PreparedAsset[],
    mode: 'ordered' | 'shuffle',
    seed: string,
  ): PreparedAsset[] {
    if (mode === 'ordered') return [...assets];
    return assets
      .map((asset, index) => ({
        asset,
        rank: createHash('sha256')
          .update(`${seed}\0${asset.id}\0${index}`)
          .digest('hex'),
      }))
      .sort((a, b) => a.rank.localeCompare(b.rank))
      .map(({ asset }) => asset);
  }

  private async readValidManifest(
    version: string,
  ): Promise<FillerManifest | null> {
    this.validateIdentifier(version, 'invalid-version');
    let manifest: FillerManifest;
    try {
      manifest = JSON.parse(
        await readFile(
          join(this.versionDirectory(version), 'manifest.json'),
          'utf8',
        ),
      ) as FillerManifest;
    } catch {
      return null;
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.version !== version ||
      manifest.status !== 'ready' ||
      !Array.isArray(manifest.assets) ||
      !Array.isArray(manifest.playbackOrder)
    )
      return null;
    for (const asset of manifest.assets) {
      const path = join(
        this.versionDirectory(version),
        basename(asset.artifact),
      );
      if (
        (await this.sha256File(path).catch(() => '')) !== asset.artifactSha256
      )
        return null;
    }
    const allowed = new Set(manifest.assets.map((asset) => asset.artifact));
    if (
      manifest.playbackOrder.length !== manifest.assets.length ||
      manifest.playbackOrder.some((item) => !allowed.has(item))
    )
      return null;
    return manifest;
  }

  private publicManifest(manifest: FillerManifest): FillerPublicState {
    return {
      version: manifest.version,
      status: 'ready',
      ready: true,
      mode: manifest.mode,
      profile: manifest.profile,
      assets: manifest.assets.map(
        ({ id, sourceSha256, artifactSha256, durationSeconds }) => ({
          id,
          sourceSha256,
          artifactSha256,
          durationSeconds,
        }),
      ),
      preparedAt: manifest.preparedAt,
    };
  }

  private async writeActivePlaylist(version: string): Promise<void> {
    const manifest = await this.readValidManifest(version);
    if (!manifest)
      throw new ConflictException('requested filler version is not prepared');
    const body = `${manifest.playbackOrder.map((name) => join(this.versionDirectory(version), basename(name))).join('\n')}\n`;
    await this.atomicWrite(this.activePlaylistPath, body);
  }

  private async rewriteStoredPlaylist(manifest: FillerManifest): Promise<void> {
    const path = join(this.versionDirectory(manifest.version), 'playlist.m3u');
    await this.atomicWrite(
      path,
      `${manifest.playbackOrder.map((name) => join(this.versionDirectory(manifest.version), basename(name))).join('\n')}\n`,
    );
  }

  private async readActiveSelection(): Promise<string | null> {
    try {
      return (
        (await readFile(this.activeSelectionPath(), 'utf8')).trim() || null
      );
    } catch {
      return null;
    }
  }

  private activeSelectionPath(): string {
    return join(this.programRoot, '.active-version');
  }

  private async countPreparedVersions(): Promise<number> {
    const entries = await readdir(this.programRoot, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        (await this.readValidManifest(entry.name))
      )
        count += 1;
    }
    return count;
  }
  private versionDirectory(version: string): string {
    return join(this.programRoot, version);
  }
  private validateIdentifier(value: string, reason: string): void {
    if (!IDENTIFIER.test(value ?? '')) throw new BadRequestException(reason);
  }
  private boundedReason(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return [
      'checksum-mismatch',
      'download-failed',
      'download-too-large',
      'decode-failed',
      'validation-failed',
    ].includes(message)
      ? message
      : 'preparation-failed';
  }
  private async sha256File(path: string): Promise<string> {
    const handle = await open(path, 'r');
    const digest = createHash('sha256');
    try {
      for await (const chunk of handle.readableWebStream() as unknown as AsyncIterable<Uint8Array>)
        digest.update(chunk);
    } finally {
      await handle.close();
    }
    return digest.digest('hex');
  }
  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
