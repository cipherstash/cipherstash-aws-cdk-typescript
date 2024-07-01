#!/usr/bin/env node
import 'source-map-support/register';
import {App} from 'aws-cdk-lib';
import { CipherstashCtsAwsCdkStack, CipherstashZkmsAwsCdkStack } from '../lib/cipherstash-cts-aws-cdk-stack';
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

(async () => {
  const client = new STSClient();
  const command = new GetCallerIdentityCommand({});
  const identityResponse = await client.send(command);

  if (!identityResponse.Arn) {
    throw new Error("Invalid identity response: missing caller ARN.")
  }

  const app = new App();

  new CipherstashCtsAwsCdkStack(app, 'CipherstashCtsAwsCdkStack', {
    kmsKeyManagerArns: [identityResponse.Arn],
  });

  new CipherstashZkmsAwsCdkStack(app, 'CipherstashZkmsAwsCdkStack', {});

  app.synth();
})();
