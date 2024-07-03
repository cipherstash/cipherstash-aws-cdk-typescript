import * as cdk from 'aws-cdk-lib';
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import { App, Fn, Stack, type StackProps } from 'aws-cdk-lib';
import { AccountRootPrincipal, Role, ServicePrincipal, ManagedPolicy, PolicyStatement, PolicyDocument, Effect, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Vpc, SubnetType, SecurityGroup, InstanceType, InstanceClass, InstanceSize, Port } from 'aws-cdk-lib/aws-ec2';
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a false positive
import { Function, Runtime, Code, Architecture } from 'aws-cdk-lib/aws-lambda';
import { DomainName, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { CfnOutput } from 'aws-cdk-lib/core';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';

interface CipherstashCtsAwsCdkStackProps extends StackProps {
  kmsKeyManagerArns: string[],
  tokenIssuer: string,
  zoneName: string,
}

export class CipherstashCtsAwsCdkStack extends Stack {
  constructor(scope: App, id: string, props: CipherstashCtsAwsCdkStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new ArnPrincipal(arn))
    ];

    const domainName = `cts.${props.zoneName}`;

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
      sources: [Source.asset('zips/cts.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'cts-zips/cts-server',
      extract: false,
    });

    const migrationsZip = new BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [Source.asset('zips/cts-migrations.zip')],
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

    const postgresUsername = "postgres";

    // TODO: CMK
    const postgresSecret = new Secret(this, 'PostgresCredentials', {
      secretName: 'CtsPgCredentials',
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
      'CTS__AUTH0__TOKEN_AUDIENCES': `https://${domainName}/`,
      'CTS__AUTH0__TOKEN_ISSUER': props.tokenIssuer,
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

    const zone = HostedZone.fromLookup(this, 'Zone', {
      domainName: props.zoneName,
     });

     const certificate = new Certificate(this, 'Certificate', {
       domainName,
       validation: CertificateValidation.fromDns(zone),
     });

     const dn = new DomainName(this, 'DomainName', {
       domainName,
       certificate,
     });

    // API Gateway
    const httpApi = new HttpApi(this, 'CtsHttpApi', {
      defaultDomainMapping: {
        domainName: dn,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration('CtsLambdaIntegration', ctsServerFunction),
    });

    new ARecord(this, 'AliasRecord', {
      zone,
      recordName: 'cts',
      target: RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          dn.regionalDomainName,
          dn.regionalHostedZoneId
        )
      ),
    });

    // Output for CTS API URL
    new CfnOutput(this, 'CtsApiUrl', {
      description: 'The URL of the CTS API',
      value: `https://${domainName}`
    });

    new CfnOutput(this, 'CtsMigrationFunctionName', {
      description: 'The name of the Lambda function for running DB migrations',
      value: ctsMigrationsFunction.functionName,
    });
  }
}

interface CipherstashZkmsAwsCdkStackProps extends StackProps {
  kmsKeyManagerArns: string[],
  zoneName: string,
}

export class CipherstashZkmsAwsCdkStack extends Stack {
  constructor(scope: App, id: string, props: CipherstashZkmsAwsCdkStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new ArnPrincipal(arn))
    ];

    const domainName = `zerokms.${props.zoneName}`;

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
      sources: [Source.asset('zips/zkms.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zkms-zips/zkms-server',
      extract: false,
    });

    const migrationsZip = new BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [Source.asset('zips/zkms-migrations.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zkms-zips/zkms-migrations',
      extract: false,
    });

    const rootKey = new Key(this, 'RootKey', {
      description: 'ZKMS root key',
      alias: "zkms-root-key",
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
              "kms:RotateKeyOnDemand",
            ],
            resources: ["*"],
          }),
          new PolicyStatement({
            sid: "Allow ZeroKMS to work with the key",
            effect: Effect.ALLOW,
            principals: [lambdaExecRole],
            actions: [
              "kms:GenerateDataKey",
              "kms:Decrypt",
              "kms:Encrypt",
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

    const postgresUsername = "postgres";

    // TODO: CMK
    const postgresSecret = new Secret(this, 'PostgresCredentials', {
      secretName: 'ZkmsPgCredentials',
      description: "ZKMS Postgres Credentials",
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
      databaseName: 'zkms',
    });

    // Lambda functions
    const lambdaEnvironment = {
      "ZKMS__IDP__AUDIENCE": `https://${domainName}/`,
      "ZKMS__IDP__ISSUERS": `https://cts.${props.zoneName}/`,
      "ZKMS__KEY_PROVIDER__ROOT_KEY_ID": rootKey.keyId,
      "ZKMS__TRACING_ENABLED": "false",
      "ZKMS__POSTGRES__CREDS_SECRET_ARN": postgresSecret.secretArn,
      "ZKMS__POSTGRES__HOST": dbInstance.dbInstanceEndpointAddress,
      "ZKMS__POSTGRES__NAME": "zkms",
      "ZKMS__POSTGRES__PORT": dbInstance.dbInstanceEndpointPort,
      "ZKMS__POSTGRES__SSL_MODE": "verify-full",
    };

    const zkmsServerFunction = new Function(this, 'ZkmsServerFunction', {
      runtime: Runtime.PROVIDED_AL2023,
      architecture: Architecture.ARM_64,
      handler: 'bootstrap',
      code: Code.fromBucket(lambdaZipsBucket,  `zkms-zips/zkms-server/${Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    });

    const zkmsMigrationsFunction = new Function(this, 'ZkmsMigrationsFunction', {
      runtime: Runtime.PROVIDED_AL2023,
      architecture: Architecture.ARM_64,
      handler: 'bootstrap',
      code: Code.fromBucket(lambdaZipsBucket,  `zkms-zips/zkms-migrations/${Fn.select(0, migrationsZip.objectKeys)}`),
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
      logGroupName: `/aws/lambda/${zkmsServerFunction.functionName}`,
      retention: RetentionDays.ONE_DAY,
    });

    new LogGroup(this, 'MigrationsFunctionLogGroup', {
      logGroupName: `/aws/lambda/${zkmsMigrationsFunction.functionName}`,
      retention: RetentionDays.ONE_DAY,
    });

    const zone = HostedZone.fromLookup(this, 'Zone', {
     domainName: props.zoneName,
    });

    const certificate = new Certificate(this, 'Certificate', {
      domainName,
      validation: CertificateValidation.fromDns(zone),
    });

    const dn = new DomainName(this, 'DomainName', {
      domainName,
      certificate,
    });

    // API Gateway
    const httpApi = new HttpApi(this, 'ZkmsHttpApi', {
      defaultDomainMapping: {
        domainName: dn,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ZkmsLambdaIntegration', zkmsServerFunction),
    });

    new ARecord(this, 'AliasRecord', {
      zone,
      recordName: 'zerokms',
      target: RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          dn.regionalDomainName,
          dn.regionalHostedZoneId
        )
      ),
    });

    new CfnOutput(this, 'ZkmsApiUrl', {
      description: 'The URL of the ZKMS API',
      value: `https://${domainName}`
    });

    new CfnOutput(this, 'ZkmsMigrationFunctionName', {
      description: 'The name of the Lambda function for running DB migrations',
      value: zkmsMigrationsFunction.functionName,
    });
  }
}

export function getEnvVar(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Required environment variable ${name} not set.`);
  }

  return value;
}
