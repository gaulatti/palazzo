import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
import {allowed, evaluate} from './workflow-expressions.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = parse(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'));
const config = JSON.parse(readFileSync(join(root, '.github/clouseau-wiki.json'), 'utf8'));
const {validateConfig} = require(join(root, '.clouseau-ci/src/wiki.cjs'));
const {snapshot, prepareWiki, publishWiki} = require(join(root, '.clouseau-ci/src/wiki-git.cjs'));
const {jobs} = workflow;

function context({event = 'push', main = true, draft = false, deployment = 'success', planning = 'success'} = {}) {
  return {github: {event_name: event, ref: main ? 'refs/heads/main' : 'refs/heads/docs-test', sha: 'a'.repeat(40), run_id: 7, run_attempt: 2},
    inputs: {validate_wiki_only: draft}, needs: {deploy: {result: deployment}, 'wiki-plan': {result: planning}}};
}

test('wiki generation follows successful deployment; failed, cancelled and skipped releases never call a model or publisher', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(jobs['wiki-plan'].needs, 'deploy');
  assert.deepEqual(jobs['wiki-publish'].needs, ['deploy', 'wiki-plan']);
  for (const deployment of ['success', 'failure', 'cancelled', 'skipped']) {
    const c = context({deployment});
    assert.equal(allowed(jobs['wiki-plan'].if, c, {success: false}), deployment === 'success');
    for (const planning of ['success', 'failure', 'cancelled', 'skipped']) {
      c.needs['wiki-plan'].result = planning;
      assert.equal(allowed(jobs['wiki-publish'].if, c, {success: false}), deployment === 'success' && planning === 'success');
    }
  }
});

test('manual wiki validation is read-only even on main and never starts deployment or publication', () => {
  assert.equal(workflow.on.workflow_dispatch.inputs.validate_wiki_only.default, false);
  for (const main of [true, false]) {
    const c = context({event: 'workflow_dispatch', main, draft: true, deployment: 'skipped'});
    assert.equal(allowed(jobs.build.if, c), false);
    assert.equal(allowed(jobs.deploy.if, c), false);
    assert.equal(allowed(jobs['wiki-plan'].if, c, {success: false}), true);
    assert.equal(allowed(jobs['wiki-publish'].if, c, {success: false}), false);
    assert.equal(allowed(jobs['wiki-access'].if, c), true);
    const action = jobs['wiki-plan'].steps.find(step => step.with?.operation === 'plan-wiki');
    assert.equal(evaluate(action.with['wiki-draft'], c).coerceString(), 'true');
  }
  const branch = context({event: 'workflow_dispatch', main: false});
  for (const name of ['build', 'deploy', 'wiki-plan', 'wiki-publish', 'wiki-access']) assert.equal(allowed(jobs[name].if, branch, {success: false}), false, name);
  assert.match(jobs['wiki-access'].steps.at(-1).run, /^git push --dry-run /);
});

test('the provider has no write credential and the deterministic publisher has no provider or deployment secret', () => {
  assert.deepEqual(workflow.permissions, {contents: 'read'});
  assert.deepEqual(jobs['wiki-plan'].permissions, {contents: 'read', actions: 'read'});
  assert.deepEqual(jobs['wiki-publish'].permissions, {contents: 'write', actions: 'read'});
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(jobs)) {
    if (!name.startsWith('wiki-')) continue;
    assert.ok(!JSON.stringify(job).includes('DEPLOYMENT_TOKEN'));
    assert.ok(!JSON.stringify(job).includes('id-token'));
    if (name !== 'wiki-plan') assert.ok(!JSON.stringify(job).includes('DEEPSEEK_API_KEY'));
  }
  for (const name of ['wiki-plan', 'wiki-publish']) {
    const [source, wiki] = jobs[name].steps;
    assert.equal(source.with.ref, '${{ github.sha }}');
    assert.equal(source.with['persist-credentials'], false);
    assert.equal(wiki.with.repository, '${{ github.repository }}.wiki');
    assert.equal(wiki.with.ref, config.wiki_branch);
    assert.equal(wiki.with['persist-credentials'], name === 'wiki-publish');
    const action = jobs[name].steps.find(step => step.with?.operation);
    assert.match(action.uses, /^gaulatti\/clouseau@[a-f0-9]{40}$/);
  }
  const deploymentCheckout = jobs.deploy.steps.find(step => step.name === 'Checkout deployment definitions');
  assert.equal(deploymentCheckout.uses, 'actions/checkout@v4');
});

test('publication consumes only this run and attempt, with the configured deployment boundary and complete public source scope', () => {
  validateConfig(config);
  assert.equal(config.deployment_workflow, 'deploy.yml');
  assert.equal(config.deployment_job, 'deploy');
  assert.ok(jobs[config.deployment_job]);
  for (const path of ['src/', 'docs/', 'deploy/', '.github/workflows/', 'Dockerfile', 'docker-entrypoint.sh', 'compose.yml', 'package.json']) assert.ok(config.source_paths.includes(path));
  assert.ok(!config.source_paths.includes('.env'));
  const upload = jobs['wiki-plan'].steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = jobs['wiki-publish'].steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(upload.with.name, download.with.name);
  assert.match(upload.with.name, /github.run_id.*github.run_attempt.*github.sha/);
  assert.equal(download.with.path, 'wiki-plan');
  assert.equal(jobs['wiki-publish'].steps.at(-1).with['wiki-plan-path'], 'wiki-plan/wiki-plan.json');
});

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'palazzo-wiki-contract-'));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const sourceDirectory = join(temp, 'source');
  const wikiDirectory = join(temp, 'wiki');
  const remote = join(temp, 'wiki.git');
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  mkdirSync(sourceDirectory);
  for (const prefix of config.source_paths) {
    const destination = join(sourceDirectory, prefix);
    mkdirSync(dirname(destination), {recursive: true});
    cpSync(join(root, prefix), destination, {recursive: true});
  }
  const init = dir => {
    git(dir, ['init', '-q', '-b', 'master']);
    git(dir, ['config', 'user.name', 'Palazzo wiki fixture']);
    git(dir, ['config', 'user.email', 'fixture@example.test']);
  };
  init(sourceDirectory);
  git(sourceDirectory, ['add', '.']); git(sourceDirectory, ['commit', '-qm', 'fixture: snapshot actual public documentation sources']);
  mkdirSync(remote); git(remote, ['init', '--bare', '-q']);
  mkdirSync(wikiDirectory); init(wikiDirectory);
  writeFileSync(join(wikiDirectory, 'Home.md'), '# Palazzo\n[Deployment](Deployment)\n');
  writeFileSync(join(wikiDirectory, 'Deployment.md'), '# Deployment\nExisting operator notes.\n');
  git(wikiDirectory, ['add', '.']); git(wikiDirectory, ['commit', '-qm', 'fixture: initial wiki']);
  git(wikiDirectory, ['remote', 'add', 'origin', remote]); git(wikiDirectory, ['push', '-qu', 'origin', 'HEAD:master']);
  const context = {repo: {owner: 'gaulatti', repo: 'palazzo'}, sha: git(sourceDirectory, ['rev-parse', 'HEAD']), runId: 42};
  const f = {git, remote, sourceDirectory, wikiDirectory, context, config, deployment: 'success', requests: 0};
  const method = Object.assign(async () => ({data: [{name: 'deploy', status: 'completed', conclusion: f.deployment}]}), {kind: 'jobs'});
  f.github = {rest: {actions: {getWorkflowRun: async () => ({data: {head_sha: f.context.sha, head_branch: 'main', path: '.github/workflows/deploy.yml'}}), listJobsForWorkflowRun: method}},
    paginate: async (endpoint, args) => {assert.equal(args.run_id, f.context.runId); return (await endpoint()).data;}};
  const source = snapshot({...f, repository: 'gaulatti/palazzo', revision: context.sha, runId: context.runId}).source;
  const sourceId = `.github/workflows/deploy.yml:L${source['.github/workflows/deploy.yml'].split('\n').findIndex(line => line.includes('operation: plan-wiki')) + 1}`;
  f.complete = async ({messages}) => {
    f.requests += 1;
    const input = JSON.parse(messages[1].content);
    if (input.proposed_update) return {content: JSON.stringify({pages: {[input.proposed_update[0].path]: {source_id: sourceId, findings: '', supported: true}}})};
    if (input.requested_page) return {content: JSON.stringify({path: input.requested_page, content: input.requested_page === 'Home.md' ? '# Palazzo\n[Deployment](Deployment)\nDocumentation follows the deployed source.\n' : '# Deployment\nDocumentation follows a successful deployment.\n'})};
    return {content: JSON.stringify({pages: [{path: 'Home.md', reason: 'Keep navigation coordinated.'}, {path: 'Deployment.md', reason: 'Explain the deployed documentation workflow.'}]})};
  };
  return f;
}

test('the real pinned engine blocks model requests before unsuccessful deployment and publishes coordinated pages in one Git commit', async t => {
  const f = fixture(t);
  for (const state of ['failure', 'cancelled', 'skipped']) {
    f.deployment = state;
    await assert.rejects(prepareWiki(f), /successful deployment/);
    assert.equal(f.requests, 0);
  }
  f.deployment = 'success';
  const before = f.git(f.remote, ['rev-parse', 'master']);
  const bundle = await prepareWiki(f);
  assert.equal(f.requests, 5, 'one plan, two page generations and two factual reviews through the provider boundary');
  assert.equal(bundle.source_sha, f.context.sha);
  assert.equal(bundle.deployment_run_id, 42);
  assert.equal(bundle.updates.length, 2);
  f.deployment = 'failure';
  await assert.rejects(publishWiki({...f, bundle}), /successful deployment/);
  assert.equal(f.git(f.remote, ['rev-parse', 'master']), before);
  f.deployment = 'success';
  const published = await publishWiki({...f, bundle});
  assert.equal(published.changedPages, 2);
  assert.equal(f.git(f.remote, ['rev-list', '--count', `${before}..master`]), '1');
  assert.equal(f.git(f.remote, ['show', 'master:Deployment.md']), '# Deployment\nDocumentation follows a successful deployment.');
  const receipt = JSON.parse(f.git(f.remote, ['show', 'master:.clouseau-deployment.json']));
  assert.equal(receipt.source_sha, f.context.sha); assert.equal(receipt.deployment_run_id, 42);
  f.git(f.wikiDirectory, ['checkout', '--detach', published.commit]);
  f.context.runId = 43;
  const repeated = await prepareWiki(f);
  assert.equal(repeated.updates.length, 0); assert.equal(f.requests, 5, 'an already documented revision makes no further model request');
  assert.equal((await publishWiki({...f, bundle: repeated})).alreadyDocumented, true);
  writeFileSync(join(f.wikiDirectory, 'Home.md'), '# Palazzo\nA concurrent human edit.\n');
  f.git(f.wikiDirectory, ['add', 'Home.md']); f.git(f.wikiDirectory, ['commit', '-qm', 'fixture: concurrent human edit']);
  f.git(f.wikiDirectory, ['push', 'origin', 'HEAD:master']);
  const human = f.git(f.remote, ['rev-parse', 'master']);
  await assert.rejects(publishWiki({...f, bundle: repeated}), /Wiki changed/);
  assert.equal(f.git(f.remote, ['rev-parse', 'master']), human, 'publication cannot overwrite a concurrent human edit');
});
