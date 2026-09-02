# Palazzo AWS infrastructure

This CDK app owns Palazzo-specific AWS integration. Macondo owns only the
shared Cumulus host and network. This stack owns:

- `palazzo-github-deploy`, restricted to `gaulatti/palazzo` `main` and SSM
  commands to the EC2 instance tagged `Name=macondo-services`;
- retained Secrets Manager credentials for the broadcast-control contract and
  Icecast source;
- the policy attached to the Cumulus host role that permits reading only those
  credentials and writing `/services/palazzo` logs; and
- `palazzo.gaulatti.com` pointing to the Cumulus Elastic IP.

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
