const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');

test('preserves the on-premises gate and adds the fail-closed Cumulus path', () => {
  assert.equal(
    workflow.match(/uses: actions\/checkout@v4/g)?.length,
    2,
    'the independent deploy job must check out its deployment definitions',
  );
  assert.match(workflow, /if: vars\.ON_PREMISES == 'true'/);
  assert.match(workflow, /if: vars\.ON_PREMISES != 'true'/);
  assert.match(workflow, /role\/palazzo-github-deploy/);
  assert.match(workflow, /Name=tag:Name,Values=macondo-services/);
  assert.match(workflow, /Expected exactly one running Macondo service host/);
  assert.match(workflow, /broadcast\/production\/config/);
  assert.match(workflow, /broadcast\/production\/icecast-source-password/);
  assert.doesNotMatch(workflow, /MacondoStack/);
  assert.doesNotMatch(workflow, /route53 change-resource-record-sets/);
  assert.match(workflow, /deploy\/cumulus\.sh/);
  assert.match(workflow, /deploy\/cumulus\.nginx\.conf/);
  assert.match(workflow, /deployment_status=0/);
  assert.match(workflow, /exit \$deployment_status/);
});
