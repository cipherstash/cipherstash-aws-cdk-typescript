#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CipherStashCtsStack, CipherStashZeroKmsStack } from '../lib/cipherstash-cdk';
import * as sts from "@aws-sdk/client-sts";

function getEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Required environment variable ${name} not set.`);
  }

  return value;
}


(async () => {
  const client = new sts.STSClient();

  // Use the AWS_PROFILE environment variable to specify the profile to use.
  // This is noted in the README, but it's worth mentioning here as well.
  const command = new sts.GetCallerIdentityCommand({
    profile: getEnvVar("AWS_PROFILE"),
  });

  const identityResponse = await client.send(command);

  if (!identityResponse.Arn) {
    throw new Error("Invalid identity response: missing caller ARN.")
  }

  const ctsZoneName = getEnvVar("CTS_ROUTE53_ZONE_NAME");
  const zeroKmsZoneName = getEnvVar("ZEROKMS_ROUTE53_ZONE_NAME");

  // If using a single Route53 zone, assume that we want to prepend the subdomain.
  // Otherwise, assume that we want to use the same name as the zone.
  // In prod, you'll want to use separate zones (in separate accounts), but using
  // a single zone and account can be useful in pre-prod environments.
  const [ctsDomainName, zeroKmsDomainName] = ctsZoneName === zeroKmsZoneName ?
    [`cts.${ctsZoneName}`, `zerokms.${zeroKmsZoneName}`] :
    [ctsZoneName, zeroKmsZoneName]

  const kmsKeyManagerArns = [identityResponse.Arn];

  const app = new cdk.App();

  new CipherStashCtsStack(app, 'CipherStashCtsStack', {
    env: {
      account: getEnvVar("CTS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    tokenIssuer: getEnvVar("CTS_TOKEN_ISSUER"),
    zoneName: ctsZoneName,
    domainName: ctsDomainName,
  });

  new CipherStashZeroKmsStack(app, 'CipherStashZeroKmsStack', {
    env: {
      account: getEnvVar("ZEROKMS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    tokenIssuer: `https://${ctsDomainName}/`,
    zoneName: zeroKmsZoneName,
    domainName: zeroKmsDomainName,
  });

  app.synth();
})();
