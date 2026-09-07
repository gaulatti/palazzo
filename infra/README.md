# Palazzo AWS infrastructure

This CDK app owns Palazzo-specific AWS integration. Macondo owns only the
shared Cumulus host and network. This stack owns:

- `palazzo-github-deploy`, restricted to `gaulatti/palazzo` `main` and SSM
  commands to the EC2 instance tagged `Name=macondo-services`;
- retained Secrets Manager credentials for the broadcast-control contract and
  Icecast source;
- the policy attached to the Cumulus host role that permits reading only those
  credentials; and
- `palazzo.gaulatti.com` pointing to the Cumulus Elastic IP.

Palazzo application logs stay on the service host through Docker's `local`
logging driver. Candidate and production containers retain at most three 10 MB
files apiece and remain available through `docker logs`; this stack creates no
CloudWatch Logs group and grants no `logs:*` permissions.

Copy `.env.example` to `.env`, populate it with the non-secret Cumulus
identifiers, export those values, then validate:

```bash
set -a
. ./.env
set +a
npm ci
npm test
npm run build
npx cdk diff PalazzoInfrastructureStack
```

The existing Route 53 record must be adopted into this stack during its first
deployment rather than duplicated. Deploying the stack creates new generated
production credentials and therefore requires explicit operational approval.

## Retiring the legacy CloudWatch producer

The former Cumulus deployment configured Docker's `awslogs` driver on the
production container. The host role wrote timestamped `palazzo-*` streams to
the stack-owned `/services/palazzo` group through the
`palazzo-cumulus-host` policy. Retire it in this order so the running service
never loses its diagnostic path:

1. Let the application deployment replace both candidate and production
   containers, then confirm the live container reports Docker log driver
   `local` with `max-size=10m` and `max-file=3`.
2. Exercise automation start, scheduled playout/status, stop, and restart while
   checking the bounded host logs with `docker logs --tail 200 palazzo`.
3. Confirm `/services/palazzo` has no newer ingestion timestamp and that
   `AWS/Logs` `IncomingBytes` stays at zero for a complete observation window.
4. Deploy this stack to remove the host's CloudWatch write grant and the log
   group from stack ownership.

The deployed log group currently has a retain deletion policy, so removing it
from this template deliberately leaves the historical group in place. Delete
that retained group only as a separately approved cleanup after the rollback
window; its continued existence does not create new ingestion.

Rollback is the reverse staged operation: deploy the previous infrastructure
template first to restore the retained log group and host-role grant, then
revert the application deployment to its former `awslogs` configuration. Do
not restore the old application deployment after the grant has been removed.
