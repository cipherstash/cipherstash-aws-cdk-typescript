import * as cdk from 'aws-cdk-lib';
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as core from 'aws-cdk-lib/core';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';

interface CipherstashCtsStackProps extends cdk.StackProps {
  kmsKeyManagerArns: string[],
  tokenIssuer: string,
  zoneName: string,
}

export class CipherstashCtsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CipherstashCtsStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new iam.AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new iam.ArnPrincipal(arn))
    ];

    const domainName = `cts.${props.zoneName}`;

    // IAM Role for Lambda
    const lambdaExecRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaExecRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    lambdaExecRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));

    // S3 Bucket for Lambda zips
    const lambdaZipsBucket = new s3.Bucket(this, 'LambdaZipsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Deploy local files to S3 bucket
    const serverZip = new s3Deployment.BucketDeployment(this, 'DeployServerLambdaZips', {
      sources: [s3Deployment.Source.asset('zips/cts.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'cts-zips/cts-server',
      extract: false,
    });

    const migrationsZip = new s3Deployment.BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [s3Deployment.Source.asset('zips/cts-migrations.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'cts-zips/cts-migrations',
      extract: false,
    });

    // KMS Key for JWT Signing
    const jwtSigningKey = new kms.Key(this, 'JwtSigningKey', {
      description: 'RSA key to sign JWTs issued by CTS',
      enableKeyRotation: false,
      keySpec: kms.KeySpec.RSA_4096,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: "cts-jwt-signing-key",
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "Key Managers",
            effect: iam.Effect.ALLOW,
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
          new iam.PolicyStatement({
            sid: "Allow CTS to work with the key",
            effect: iam.Effect.ALLOW,
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
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    rdsSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.POSTGRES, "Allow inbound Postgres traffic from Lambda.");

    const postgresUsername = "postgres";

    // TODO: CMK
    const postgresSecret = new secretsmanager.Secret(this, 'PostgresCredentials', {
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

    const postgresCredentials = rds.Credentials.fromSecret(
      postgresSecret,
      postgresUsername,
    );

    // TODO: CMK

    // RDS Instance
    const dbInstance = new rds.DatabaseInstance(this, 'Database', {
      allocatedStorage: 20,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
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

    const ctsServerFunction = new lambda.Function(this, 'CtsServerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket,  `cts-zips/cts-server/${cdk.Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const ctsMigrationsFunction = new lambda.Function(this, 'CtsMigrationsFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket,  `cts-zips/cts-migrations/${cdk.Fn.select(0, migrationsZip.objectKeys)}`),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // CloudWatch Log Groups
    new logs.LogGroup(this, 'ServerFunctionLogGroup', {
      logGroupName: `/aws/lambda/${ctsServerFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    new logs.LogGroup(this, 'MigrationsFunctionLogGroup', {
      logGroupName: `/aws/lambda/${ctsMigrationsFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.zoneName,
     });

     const certificate = new certificatemanager.Certificate(this, 'Certificate', {
       domainName,
       validation: certificatemanager.CertificateValidation.fromDns(zone),
     });

     const dn = new apigatewayv2.DomainName(this, 'DomainName', {
       domainName,
       certificate,
     });

    // API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'CtsHttpApi', {
      defaultDomainMapping: {
        domainName: dn,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('CtsLambdaIntegration', ctsServerFunction),
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: 'cts',
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          dn.regionalDomainName,
          dn.regionalHostedZoneId
        )
      ),
    });

    // Output for CTS API URL
    new core.CfnOutput(this, 'CtsApiUrl', {
      description: 'The URL of the CTS API',
      value: `https://${domainName}`
    });

    new core.CfnOutput(this, 'CtsMigrationFunctionName', {
      description: 'The name of the Lambda function for running DB migrations',
      value: ctsMigrationsFunction.functionName,
    });
  }
}

interface CipherstashZeroKmsStackProps extends cdk.StackProps {
  kmsKeyManagerArns: string[],
  zoneName: string,
}

export class CipherstashZeroKmsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CipherstashZeroKmsStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new iam.AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new iam.ArnPrincipal(arn))
    ];

    const domainName = `zerokms.${props.zoneName}`;

    // IAM Role for Lambda
    const lambdaExecRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    lambdaExecRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    lambdaExecRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));

    // S3 Bucket for Lambda zips
    const lambdaZipsBucket = new s3.Bucket(this, 'LambdaZipsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // Deploy local files to S3 bucket
    const serverZip = new s3Deployment.BucketDeployment(this, 'DeployServerLambdaZips', {
      sources: [s3Deployment.Source.asset('zips/zkms.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zkms-zips/zkms-server',
      extract: false,
    });

    const migrationsZip = new s3Deployment.BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [s3Deployment.Source.asset('zips/zkms-migrations.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zkms-zips/zkms-migrations',
      extract: false,
    });

    const rootKey = new kms.Key(this, 'RootKey', {
      description: 'ZKMS root key',
      alias: "zkms-root-key",
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: "Key Managers",
            effect: iam.Effect.ALLOW,
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
          new iam.PolicyStatement({
            sid: "Allow ZeroKMS to work with the key",
            effect: iam.Effect.ALLOW,
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
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    const rdsSecurityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });

    rdsSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.POSTGRES, "Allow inbound Postgres traffic from Lambda.");

    const postgresUsername = "postgres";

    // TODO: CMK
    const postgresSecret = new secretsmanager.Secret(this, 'PostgresCredentials', {
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

    const postgresCredentials = rds.Credentials.fromSecret(
      postgresSecret,
      postgresUsername,
    );

    // TODO: CMK

    // RDS Instance
    const dbInstance = new rds.DatabaseInstance(this, 'Database', {
      allocatedStorage: 20,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_3,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
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

    const zkmsServerFunction = new lambda.Function(this, 'ZkmsServerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket,  `zkms-zips/zkms-server/${cdk.Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const zkmsMigrationsFunction = new lambda.Function(this, 'ZkmsMigrationsFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket,  `zkms-zips/zkms-migrations/${cdk.Fn.select(0, migrationsZip.objectKeys)}`),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // CloudWatch Log Groups
    new logs.LogGroup(this, 'ServerFunctionLogGroup', {
      logGroupName: `/aws/lambda/${zkmsServerFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    new logs.LogGroup(this, 'MigrationsFunctionLogGroup', {
      logGroupName: `/aws/lambda/${zkmsMigrationsFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
     domainName: props.zoneName,
    });

    const certificate = new certificatemanager.Certificate(this, 'Certificate', {
      domainName,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });

    const dn = new apigatewayv2.DomainName(this, 'DomainName', {
      domainName,
      certificate,
    });

    // API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'ZkmsHttpApi', {
      defaultDomainMapping: {
        domainName: dn,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ZkmsLambdaIntegration', zkmsServerFunction),
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: 'zerokms',
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          dn.regionalDomainName,
          dn.regionalHostedZoneId
        )
      ),
    });

    new core.CfnOutput(this, 'ZkmsApiUrl', {
      description: 'The URL of the ZKMS API',
      value: `https://${domainName}`
    });

    new core.CfnOutput(this, 'ZkmsMigrationFunctionName', {
      description: 'The name of the Lambda function for running DB migrations',
      value: zkmsMigrationsFunction.functionName,
    });
  }
}
