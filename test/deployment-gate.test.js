const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

test('preserves the on-premises gate and adds the fail-closed Cumulus path', () => {
  assert.match(workflow, /if: vars\.ON_PREMISES == 'true'/);
  assert.match(workflow, /if: vars\.ON_PREMISES != 'true'/);
  assert.match(workflow, /role\/palazzo-github-deploy/);
  assert.match(workflow, /Name=tag:Name,Values=macondo-services/);
  assert.match(workflow, /Expected exactly one running Macondo service host/);
  assert.match(workflow, /MacondoStackBroadcastRuntimeSecretArn/);
  assert.match(workflow, /MacondoStackIcecastSourceSecretArn/);
  assert.match(workflow, /MacondoStackHostedZoneId/);
  assert.match(workflow, /palazzo\.gaulatti\.com/);
  assert.match(workflow, /route53 change-resource-record-sets/);
  assert.match(workflow, /deploy\/cumulus\.sh/);
  assert.match(workflow, /deploy\/cumulus\.nginx\.conf/);
});
