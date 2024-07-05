# CipherStash Token Service AWS CDK - TypeScript

This project is a TypeScript implementation of the CipherStash Token Service using the AWS Cloud Development Kit (CDK).

## Prerequisites

- [Node.js](https://nodejs.org/en/download/) or [Bun](https://bun.sh/)
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html)
- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html)

### Zip files

The project uses zip files to package the Lambda functions. The zip files are available for download from the CloudSmith endpoint provided to you by your CipherStash technical contact.

```
# Your Cloudsmith token supplied by CipherStash
export CLOUDSMITH_TOKEN=

export LAMBDA_VERSION="latest"

wget -O zips/cts-migrations.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/cts-migrations/versions/${LAMBDA_VERSION}/cts-migrations.zip"

wget -O zips/cts.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/cts/versions/${LAMBDA_VERSION}/cts.zip"

wget -O zips/zerokms-migrations.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/zerokms-migrations/versions/${LAMBDA_VERSION}/zerokms-migrations.zip"

wget -O zips/zerokms.zip \
  "https://dl.cloudsmith.io/${CLOUDSMITH_TOKEN}/cipherstash/lambdas/raw/names/zerokms/versions/${LAMBDA_VERSION}/zerokms.zip"
```

## Getting Started

1. Clone the repository

```bash
git clone
```

2. Install the dependencies

Node.js

```bash
npm install
```

Bun

```bash
bun install
```

3. Build the project

Node.js

```bash
npm run build
```

Bun

```bash
bun run build
```

4. Deploy the stack

Node.js

```bash
npm run cdk deploy
```

Bun

```bash
bun cdk deploy
```

5. Test the stack

Node.js

```bash
npm run test
```

## Useful commands

- `bun run build` compile typescript to js
- `bun run watch` watch for changes and compile
- `bun run test` perform the jest unit tests
- `bun cdk deploy` deploy this stack to your default AWS account/region
- `bun cdk diff` compare deployed stack with current state
- `bun cdk synth` emits the synthesized CloudFormation template
