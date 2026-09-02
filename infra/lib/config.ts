export interface PalazzoInfrastructureConfig {
  readonly hostedZoneId: string;
  readonly serviceHostIp: string;
  readonly serviceHostRoleArn: string;
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): PalazzoInfrastructureConfig => ({
  hostedZoneId: required(environment, 'HOSTED_ZONE_ID'),
  serviceHostIp: required(environment, 'SERVICE_HOST_IP'),
  serviceHostRoleArn: required(environment, 'SERVICE_HOST_ROLE_ARN'),
});
