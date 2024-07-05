# CipherStash AWS CDK - TypeScript

This project is an example TypeScript implementation of customer-hosted CipherStash Token Service (CTS) and ZeroKMS using the AWS Cloud Development Kit (CDK).

> [!IMPORTANT]
> This README only provides high-level documentation.
> You can find detailed documentation on customer-hosted CipherStash at https://cipherstash.com/docs/how-to/customer-hosting.

## Prerequisites

- [Node.js](https://nodejs.org/en/download/) or [Bun](https://bun.sh/)
- An Auth0 application and API
- Two AWS accounts to deploy into (one for CTS and one for ZeroKMS) with existing Route52 zones for AWS API Gateway and ACM
- A Cloudsmith token provided to you by your CipherStash technical contact

## Getting Started

1. Clone the repository

```bash
git clone
```

2. Prepare your env
```
# Your Cloudsmith token supplied by CipherStash
export CLOUDSMITH_TOKEN=

export LAMBDA_VERSION="latest"

# AWS account ID for CTS
export CTS_ACCOUNT_ID=

# Your Auth0 URL (with a trailing slash)
export CTS_TOKEN_ISSUER=

# Name of an existing Route53 hosted zone to use for ACM and API GW
export CTS_ROUTE53_ZONE_NAME=

# AWS account ID for ZeroKMS
export ZEROKMS_ACCOUNT_ID=

# Name of an existing Route53 hosted zone to use for ACM and API GW
export ZEROKMS_ROUTE53_ZONE_NAME=
```

3. Download Lambda zips

This project uses zip files to package AWS Lambda functions. The zip files are available for download using the Cloudsmith token provided to you by your CipherStash technical contact.

```
wget -O zips/cts-migrations.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/cts-migrations/versions/${LAMBDA_VERSION}/cts-migrations.zip"

wget -O zips/cts.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/cts/versions/${LAMBDA_VERSION}/cts.zip"

wget -O zips/zerokms-migrations.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/zerokms-migrations/versions/${LAMBDA_VERSION}/zerokms-migrations.zip"

wget -O zips/zerokms.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/zerokms/versions/${LAMBDA_VERSION}/zerokms.zip"
```

4. Install the dependencies

Node.js

```bash
npm install
```

Bun

```bash
bun install
```

5. Deploy the stack

Node.js

```bash
npm run cdk deploy CipherStashCtsStack
npm run cdk deploy CipherStashZeroKmsStack
```

Bun

```bash
bun cdk deploy CipherStashCtsStack
bun cdk deploy CipherStashZeroKmsStack
```

## Useful commands

- `bun run build` compile typescript to js
- `bun run watch` watch for changes and compile
- `bun cdk deploy` deploy this stack to your default AWS account/region
- `bun cdk diff` compare deployed stack with current state
- `bun cdk synth` emits the synthesized CloudFormation template
