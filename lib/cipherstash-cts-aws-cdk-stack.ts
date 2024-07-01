import * as cdk from 'aws-cdk-lib';
import { App, Fn, Stack, type StackProps } from 'aws-cdk-lib';
import { AccountRootPrincipal, Role, ServicePrincipal, ManagedPolicy, PolicyStatement, PolicyDocument, Effect, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Vpc, SubnetType, SecurityGroup, InstanceType, InstanceClass, InstanceSize, Port } from 'aws-cdk-lib/aws-ec2';
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a false positive
import { Function, Runtime, Code, Architecture } from 'aws-cdk-lib/aws-lambda';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { CfnOutput } from 'aws-cdk-lib/core';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';

interface CipherstashCtsAwsCdkStackProps extends StackProps {
  kmsKeyManagerArns?: string[],
}

export class CipherstashCtsAwsCdkStack extends Stack {
  constructor(scope: App, id: string, props?: CipherstashCtsAwsCdkStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = props?.kmsKeyManagerArns ?
      [new AccountRootPrincipal(), ...props.kmsKeyManagerArns.map(arn => new ArnPrincipal(arn))] :
      [new AccountRootPrincipal()]

    // For demo purposes, this should be the API Gateway execute endpoint URL (without a trailing Slash).
    // In production, this would be the same custom domain name used by API GW.
    //
    // TODO: use custom domain to remove circular dependency between Lambda and API GW?
    const auth0TokenAudience = getEnvVar("AUTH0_TOKEN_AUDIENCE");

    const auth0TokenIssuer = getEnvVar("AUTH0_TOKEN_ISSUER");

    // IAM Role for Lambda
    const lambdaExecRole = new Role(this, 'LambdaExecutionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaExecRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    lambdaExecRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));

    // S3 Bucket for Lambda zips
    const lambdaZipsBucket = new Bucket(this, 'LambdaZipsBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
    });

    // Deploy local files to S3 bucket
    const serverZip = new BucketDeployment(this, 'DeployServerLambdaZips', {
      sources: [Source.asset('cts-server/bootstrap.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'cts-zips/cts-server',
      extract: false,
    });

    const migrationsZip = new BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [Source.asset('cts-migrations/bootstrap.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'cts-zips/cts-migrations',
      extract: false,
    });

    // KMS Key for JWT Signing
    const jwtSigningKey = new Key(this, 'JwtSigningKey', {
      description: 'RSA key to sign JWTs issued by CTS',
      enableKeyRotation: false,
      keySpec: KeySpec.RSA_4096,
      keyUsage: KeyUsage.SIGN_VERIFY,
      alias: "cts-jwt-signing-key",
      policy: new PolicyDocument({
        statements: [
          new PolicyStatement({
            sid: "Key Managers",
            effect: Effect.ALLOW,
            principals: kmsKeyManagers,
            actions: [
              "kms:Create*",
              "kms:Describe*",
              "kms:Enable*",
              "kms:List*",
              "kms:Put*",
              "kms:Update*",
              "kms:Revoke*",
              "kms:Disable*",
              "kms:Get*",
              "kms:Delete*",
              "kms:TagResource",
              "kms:UntagResource",
              "kms:ScheduleKeyDeletion",
              "kms:CancelKeyDeletion",
            ],
            resources: ["*"],
          }),
          new PolicyStatement({
            sid: "Allow CTS to work with the key",
            effect: Effect.ALLOW,
            principals: [lambdaExecRole],
            actions: [
              "kms:GetPublicKey",
              "kms:Sign"
            ],
            resources: ["*"],
          })
        ]
      })
    });

    // VPC and Subnets
    const vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const lambdaSecurityGroup = new SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    const rdsSecurityGroup = new SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    rdsSecurityGroup.addIngressRule(lambdaSecurityGroup, Port.POSTGRES, "Allow inbound Postgres traffic from Lambda.");

    const postgresUsername = "postgres"

    // TODO: CMK
    const postgresSecret = new Secret(this, 'MysqlCredentials', {
      secretName: 'CtsPostgresCredentials',
      description: "CTS Postgres Credentials",
      generateSecretString: {
        excludeCharacters: "\"@/\\ '",
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({username: postgresUsername}),
      },
    });

    postgresSecret.grantRead(lambdaExecRole);

    const postgresCredentials = Credentials.fromSecret(
      postgresSecret,
      postgresUsername,
    );

    // TODO: CMK

    // RDS Instance
    const dbInstance = new DatabaseInstance(this, 'Database', {
      allocatedStorage: 20,
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_16_3,
      }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      credentials: postgresCredentials,
      securityGroups: [rdsSecurityGroup],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false, // Set to true to prevent accidental deletion
      databaseName: 'cts',
    });

    // Lambda functions
    const lambdaEnvironment = {
      'CTS__AUTH0__TOKEN_AUDIENCES': auth0TokenAudience,
      'CTS__AUTH0__TOKEN_ISSUER': auth0TokenIssuer,
      'CTS__DATABASE__CREDS_SECRET_ARN': postgresSecret.secretArn,
      'CTS__DATABASE__HOST': dbInstance.dbInstanceEndpointAddress,
      'CTS__DATABASE__NAME': 'cts',
      'CTS__DATABASE__PORT': dbInstance.dbInstanceEndpointPort,
      'CTS__DATABASE__SSL_MODE': 'verify-full',
      'CTS__JWT_SIGNING_KEY_ID': jwtSigningKey.keyId,
      'CTS__TRACING_ENABLED': 'false',
      'CTS__META_ENDPOINTS_ENABLED': 'true',
      'CTS__LOGGING_ENDPOINTS': '',
    };

    const ctsServerFunction = new Function(this, 'CtsServerFunction', {
      runtime: Runtime.PROVIDED_AL2023,
      architecture: Architecture.ARM_64,
      handler: 'bootstrap',
      code: Code.fromBucket(lambdaZipsBucket,  `cts-zips/cts-server/${Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    });

    const ctsMigrationsFunction = new Function(this, 'CtsMigrationsFunction', {
      runtime: Runtime.PROVIDED_AL2023,
      architecture: Architecture.ARM_64,
      handler: 'bootstrap',
      code: Code.fromBucket(lambdaZipsBucket,  `cts-zips/cts-migrations/${Fn.select(0, migrationsZip.objectKeys)}`),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    });

    // CloudWatch Log Groups
    new LogGroup(this, 'ServerFunctionLogGroup', {
      logGroupName: `/aws/lambda/${ctsServerFunction.functionName}`,
      retention: RetentionDays.ONE_DAY,
    });

    new LogGroup(this, 'MigrationsFunctionLogGroup', {
      logGroupName: `/aws/lambda/${ctsMigrationsFunction.functionName}`,
      retention: RetentionDays.ONE_DAY,
    });

    // API Gateway
    const httpApi = new HttpApi(this, 'CtsHttpApi');

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration('CtsLambdaIntegration', ctsServerFunction),
    });

    // Output for CTS API URL
    new CfnOutput(this, 'CtsApiUrl', {
      description: 'The URL of the CTS API',
      value: httpApi.url ?? "N/A",
    });

    new CfnOutput(this, 'CtsMigrationFunctionName', {
      description: 'The name of the Lambda function for running DB migrations',
      value: ctsMigrationsFunction.functionName,
    });
  }
}

function getEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Required environment variable ${name} not set.`);
  }

  return value;
}

(async () => {
  const client = new STSClient();
  const command = new GetCallerIdentityCommand({});
  const identityResponse = await client.send(command);

  const kmsKeyManagerArns = identityResponse.Arn ? [identityResponse.Arn] : []

  const app = new App();

  new CipherstashCtsAwsCdkStack(app, 'CipherstashCtsAwsCdkStack', {
    kmsKeyManagerArns,
  });

  app.synth();
})();
