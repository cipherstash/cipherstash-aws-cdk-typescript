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

  new cipherstashCdk.CipherstashCtsStack(app, 'CipherstashCtsStack', {
    env: {
      account: getEnvVar("CTS_ACCOUNT_ID"),
      region: getEnvVar("AWS_REGION"),
    },
    kmsKeyManagerArns,
    tokenIssuer: getEnvVar("CTS_TOKEN_ISSUER"),
    zoneName: ctsZoneName,
    domainName: ctsDomainName,
  });

  new cipherstashCdk.CipherstashZeroKmsStack(app, 'CipherstashZeroKmsStack', {
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
