import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { PalazzoInfrastructureConfig } from "./config";
import { createGitHubDeployRole } from "./github-deploy";

export interface PalazzoInfrastructureStackProps extends StackProps {
  readonly config: PalazzoInfrastructureConfig;
}

export class PalazzoInfrastructureStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: PalazzoInfrastructureStackProps,
  ) {
    super(scope, id, props);
    const { config } = props;
    const hostRole = Role.fromRoleArn(
      this,
      "CumulusHostRole",
      config.serviceHostRoleArn,
      { mutable: true },
    );

    const icecastSecret = new Secret(this, "IcecastSourceSecret", {
      secretName: "broadcast/production/icecast-source-password",
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });
    icecastSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const hostPolicy = new Policy(this, "PalazzoCumulusHostPolicy", {
      policyName: "palazzo-cumulus-host",
      statements: [
        new PolicyStatement({
          actions: [
            "secretsmanager:DescribeSecret",
            "secretsmanager:GetSecretValue",
          ],
          resources: [icecastSecret.secretArn],
        }),
      ],
    });
    hostPolicy.attachToRole(hostRole);

    const zone = HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: "gaulatti.com",
    });
    new ARecord(this, "ServiceRecord", {
      zone,
      recordName: "palazzo",
      target: RecordTarget.fromIpAddresses(config.serviceHostIp),
      ttl: Duration.minutes(5),
    });

    const githubDeployRole = createGitHubDeployRole(this);
    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: githubDeployRole.roleArn,
    });
    new CfnOutput(this, "IcecastSourceSecretArn", {
      value: icecastSecret.secretArn,
    });
  }
}
