import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { PalazzoInfrastructureStack } from "../lib/palazzo-infrastructure-stack";

const template = (): Template => {
  const app = new App();
  return Template.fromStack(
    new PalazzoInfrastructureStack(app, "PalazzoInfrastructureStack", {
      config: {
        hostedZoneId: "Z00000000000000000000",
        serviceHostIp: "203.0.113.10",
        serviceHostRoleArn:
          "arn:aws:iam::123456789012:role/macondo-service-host",
      },
      env: { account: "123456789012", region: "us-east-1" },
    }),
  );
};

test("owns Palazzo credentials, logging, and DNS", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "broadcast/production/config",
    GenerateSecretString: Match.objectLike({
      GenerateStringKey: "palazzoControlToken",
    }),
  });
  rendered.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "broadcast/production/icecast-source-password",
  });
  rendered.hasResourceProperties("AWS::Logs::LogGroup", {
    LogGroupName: "/services/palazzo",
    RetentionInDays: 30,
  });
  rendered.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "palazzo.gaulatti.com.",
    ResourceRecords: ["203.0.113.10"],
    TTL: "300",
    Type: "A",
  });
});

test("grants the Cumulus host runtime access and owns the deployment role", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::IAM::Policy", {
    PolicyName: "palazzo-cumulus-host",
  });
  const policies = JSON.stringify(rendered.findResources("AWS::IAM::Policy"));
  expect(policies).toContain("secretsmanager:GetSecretValue");
  expect(policies).toContain("logs:PutLogEvents");
  expect(policies).toContain("ssm:SendCommand");
  expect(policies).toContain("ssm:resourceTag/Name");
  expect(policies).toContain("macondo-services");
  rendered.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "palazzo-github-deploy",
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:sub":
                "repo:gaulatti/palazzo:ref:refs/heads/main",
            },
          },
        }),
      ]),
    },
  });
});
