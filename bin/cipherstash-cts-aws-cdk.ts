#!/usr/bin/env node
import 'source-map-support/register';
import {App} from 'aws-cdk-lib';
import { CipherstashCtsAwsCdkStack, CipherstashZkmsAwsCdkStack, getEnvVar } from '../lib/cipherstash-cts-aws-cdk-stack';
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

(async () => {
  const client = new STSClient();
  const command = new GetCallerIdentityCommand({});
  const identityResponse = await client.send(command);

  if (!identityResponse.Arn) {
    throw new Error("Invalid identity response: missing caller ARN.")
  }

  const kmsKeyManagerArns = [identityResponse.Arn];

  const app = new App();

  const ctsStack = new CipherstashCtsAwsCdkStack(app, 'CipherstashCtsAwsCdkStack', {
    env: {
      account: getEnvVar("CTS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    tokenIssuer: getEnvVar("CTS_TOKEN_ISSUER"),
    zoneName: getEnvVar("CTS_ROUTE53_ZONE_NAME"),
  });

  new CipherstashZkmsAwsCdkStack(app, 'CipherstashZkmsAwsCdkStack', {
    env: {
      account: getEnvVar("ZEROKMS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    zoneName: getEnvVar("ZEROKMS_ROUTE53_ZONE_NAME"),
  });

  app.synth();
})();
