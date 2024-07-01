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

  new CipherstashCtsAwsCdkStack(app, 'CipherstashCtsAwsCdkStack', {
    kmsKeyManagerArns,
    // For demo purposes, this should be the API Gateway execute endpoint URL (without a trailing Slash).
    // In production, this would be the same custom domain name used by API GW.
    //
    // TODO: use custom domain to remove circular dependency between Lambda and API GW?
    // TODO: move env vars to top level?
    tokenAudience: getEnvVar("CTS_TOKEN_AUDIENCE"),
    tokenIssuer: getEnvVar("CTS_TOKEN_ISSUER"),
  });

  new CipherstashZkmsAwsCdkStack(app, 'CipherstashZkmsAwsCdkStack', {
    kmsKeyManagerArns,
    tokenAudience: getEnvVar("ZKMS_TOKEN_AUDIENCE"),
    tokenIssuer: getEnvVar("ZKMS_TOKEN_ISSUER"),
  });

  app.synth();
})();
