#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as cipherstashCdk from '../lib/cipherstash-cdk';
import * as sts from "@aws-sdk/client-sts";

export function getEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Required environment variable ${name} not set.`);
  }

  return value;
}


(async () => {
  const client = new sts.STSClient();
  const command = new sts.GetCallerIdentityCommand({});
  const identityResponse = await client.send(command);

  if (!identityResponse.Arn) {
    throw new Error("Invalid identity response: missing caller ARN.")
  }

  const kmsKeyManagerArns = [identityResponse.Arn];

  const app = new cdk.App();

  new cipherstashCdk.CipherstashCtsStack(app, 'CipherstashCtsAwsCdkStack', {
    env: {
      account: getEnvVar("CTS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    tokenIssuer: getEnvVar("CTS_TOKEN_ISSUER"),
    zoneName: getEnvVar("CTS_ROUTE53_ZONE_NAME"),
  });

  new cipherstashCdk.CipherstashZeroKmsStack(app, 'CipherstashZkmsAwsCdkStack', {
    env: {
      account: getEnvVar("ZEROKMS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    zoneName: getEnvVar("ZEROKMS_ROUTE53_ZONE_NAME"),
  });

  app.synth();
})();
