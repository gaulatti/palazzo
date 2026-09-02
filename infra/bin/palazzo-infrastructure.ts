#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { PalazzoInfrastructureStack } from '../lib/palazzo-infrastructure-stack';

const app = new App();
new PalazzoInfrastructureStack(app, 'PalazzoInfrastructureStack', {
  config: loadConfig(),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
