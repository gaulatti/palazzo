'use strict';

// Resolve the deployment from GitHub, never from a contributor artifact.
// The shared engine independently checks its successful deployment job again.
async function resolveDeployment({github, context, config, runId}) {
  if (context.ref !== 'refs/heads/main' ||
      !['workflow_run', 'workflow_dispatch'].includes(context.eventName) ||
      (context.eventName === 'workflow_dispatch' && context.actor !== context.repo.owner) ||
      !/^[1-9][0-9]*$/.test(String(runId)) || !Number.isSafeInteger(Number(runId))) {
    throw new Error('Wiki updates require protected main and a valid deployment run; manual catch-up requires the owner');
  }
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const {data: run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: Number(runId)});
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.path !== `.github/workflows/${config.deployment_workflow}` || run.head_branch !== 'main' ||
      !['push', 'workflow_dispatch'].includes(run.event) || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Wiki updates require a successful same-repository main deployment');
  }
  const {data: latest} = await github.rest.actions.listWorkflowRuns({...context.repo,
    workflow_id: config.deployment_workflow, branch: 'main', status: 'success', per_page: 1});
  if (latest.workflow_runs[0]?.id !== Number(runId)) {
    throw new Error('A newer successful deployment exists; document that deployment instead');
  }
  return {...context, repo: context.repo, sha: run.head_sha, runId: Number(runId)};
}

module.exports = {resolveDeployment};
