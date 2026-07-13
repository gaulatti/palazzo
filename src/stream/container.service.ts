import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import Docker = require('dockerode');

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  telnetHost: string;
  telnetPort: number;
  icecastHost: string;
  icecastPort: number;
  status: 'running' | 'stopped' | 'error';
}

@Injectable()
export class ContainerService implements OnModuleDestroy {
  private readonly logger = new Logger(ContainerService.name);
  private readonly docker: Docker;
  private readonly image: string;
  private readonly workdir: string;
  private readonly telnetPortStart: number;
  private readonly telnetPortEnd: number;
  private readonly composeProject: string;
  private readonly musicDir: string;
  private nextTelnetPort: number;

  constructor(private readonly configService: ConfigService) {
    const socketPath =
      this.configService.get<string>('DOCKER_SOCKET_PATH') ??
      '/var/run/docker.sock';

    this.docker = new Docker({ socketPath });

    this.image =
      this.configService.get<string>('STREAM_IMAGE') ?? 'palazzo-stream';

    this.workdir =
      this.configService.get<string>('STREAMS_WORKDIR') ??
      '/tmp/palazzo-streams';

    this.telnetPortStart = Number(
      this.configService.get<number>('TELNET_PORT_START') ?? 14000,
    );

    this.telnetPortEnd = Number(
      this.configService.get<number>('TELNET_PORT_END') ?? 14999,
    );

    this.nextTelnetPort = this.telnetPortStart;

    this.composeProject =
      this.configService.get<string>('COMPOSE_PROJECT_NAME') ?? 'palazzo';

    this.musicDir =
      this.configService.get<string>('MUSIC_DIR_HOST') ?? '/tmp/palazzo-music';

    mkdirSync(this.workdir, { recursive: true });
    mkdirSync(this.musicDir, { recursive: true });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      rmSync(this.workdir, { recursive: true, force: true });
    } catch {
      // no-op
    }
  }

  allocateTelnetPort(): number {
    const port = this.nextTelnetPort;
    this.nextTelnetPort =
      this.nextTelnetPort >= this.telnetPortEnd
        ? this.telnetPortStart
        : this.nextTelnetPort + 1;
    return port;
  }

  async createContainer(
    streamId: string,
    liqScript: string,
    telnetPort?: number,
  ): Promise<ContainerInfo> {
    const streamDir = join(this.workdir, streamId);
    mkdirSync(streamDir, { recursive: true });

    const scriptPath = join(streamDir, 'stream.liq');
    writeFileSync(scriptPath, liqScript, 'utf8');

    const containerName = `palazzo-${streamId}`;

    await this.removeContainerByName(containerName);

    const resolvedTelnetPort = telnetPort ?? this.allocateTelnetPort();

    const container = await this.docker.createContainer({
      name: containerName,
      Image: this.image,
      ExposedPorts: {
        [`${resolvedTelnetPort}/tcp`]: {},
      },
      HostConfig: {
        Binds: [
          `${scriptPath}:/stream/stream.liq`,
          `${this.musicDir}:/music`,
        ],
        NetworkMode: `${this.composeProject}_default`,
        PortBindings: {
          [`${resolvedTelnetPort}/tcp`]: [{ HostPort: String(resolvedTelnetPort) }],
        },
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
      Env: [
        `STREAM_ID=${streamId}`,
      ],
    });

    await container.start();

    this.logger.log(
      `Container ${containerName} started (telnet=${resolvedTelnetPort}, network=${this.composeProject}_default)`,
    );

    return {
      containerId: container.id,
      containerName,
      telnetHost: `palazzo-${streamId}`,
      telnetPort: resolvedTelnetPort,
      icecastHost: 'icecast',
      icecastPort: 8000,
      status: 'running',
    };
  }

  async stopContainer(streamId: string): Promise<void> {
    const containerName = `palazzo-${streamId}`;
    try {
      const container = await this.findContainerByName(containerName);
      if (!container) return;

      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
      this.logger.log(`Container ${containerName} stopped and removed`);
    } catch (err) {
      this.logger.warn(`Failed to stop container ${containerName}: ${err}`);
    }

    try {
      rmSync(join(this.workdir, streamId), { recursive: true, force: true });
    } catch {
      // no-op
    }
  }

  async getContainerStatus(
    streamId: string,
  ): Promise<'running' | 'stopped' | 'not_found'> {
    const containerName = `palazzo-${streamId}`;
    try {
      const container = await this.findContainerByName(containerName);
      if (!container) return 'not_found';

      const inspected = await container.inspect();
      return inspected.State?.Running === true ? 'running' : 'stopped';
    } catch {
      return 'not_found';
    }
  }

  async getContainerInfo(streamId: string): Promise<ContainerInfo | null> {
    const containerName = `palazzo-${streamId}`;
    try {
      const container = await this.findContainerByName(containerName);
      if (!container) return null;

      const inspected = await container.inspect();
      const telnetPort = this.getFirstHostPort(inspected);

      return {
        containerId: container.id,
        containerName,
        telnetHost: `palazzo-${streamId}`,
        telnetPort,
        icecastHost: 'icecast',
        icecastPort: 8000,
        status: inspected.State?.Running === true ? 'running' : 'stopped',
      };
    } catch {
      return null;
    }
  }

  private async findContainerByName(
    name: string,
  ): Promise<Docker.Container | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [name] }),
    });

    if (containers.length === 0) return null;
    return this.docker.getContainer(containers[0].Id);
  }

  private async removeContainerByName(name: string): Promise<void> {
    const container = await this.findContainerByName(name);
    if (!container) return;

    await container.stop().catch(() => {});
    await container.remove().catch(() => {});
  }

  private getFirstHostPort(
    inspected: Docker.ContainerInspectInfo,
  ): number {
    const ports = inspected.NetworkSettings?.Ports;
    if (!ports) return this.telnetPortStart;

    for (const [portKey, bindings] of Object.entries(ports)) {
      if (!Array.isArray(bindings) || bindings.length === 0) continue;
      const internalPort = Number(portKey.split('/')[0]);
      if (internalPort === 8000) continue;
      const hostPort = Number(bindings[0].HostPort);
      if (Number.isFinite(hostPort)) return hostPort;
    }

    return this.telnetPortStart;
  }
}
