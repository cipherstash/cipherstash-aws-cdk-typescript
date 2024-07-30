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

export type TokenProvider = "auth0" | "okta";

interface CipherStashCtsStackProps extends cdk.StackProps {
  kmsKeyManagerArns: string[],
  tokenIssuer: string,
  zoneName: string,
  domainName: string,
  tokenProvider: TokenProvider
}

export class CipherStashCtsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CipherStashCtsStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new iam.AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new iam.ArnPrincipal(arn))
    ];

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

    const postgresSecret = new secretsmanager.Secret(this, 'PostgresCredentials', {
      secretName: 'CtsPostgresCredentials',
      description: "CTS Postgres Credentials",
      generateSecretString: {
        excludeCharacters: "\"@/\\ '",
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: postgresUsername }),
      },
    });

    postgresSecret.grantRead(lambdaExecRole);

    const postgresCredentials = rds.Credentials.fromSecret(
      postgresSecret,
      postgresUsername,
    );

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

    const idpName = props.tokenProvider.toUpperCase();

    // Lambda functions
    const lambdaEnvironment = {
      [`CTS__${idpName}__TOKEN_AUDIENCES`]: `https://${props.domainName}/`,
      [`CTS__${idpName}__TOKEN_ISSUER`]: props.tokenIssuer,
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

    const ctsServerFunction = new lambda.Function(this, 'ServerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket, `cts-zips/cts-server/${cdk.Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const ctsMigrationsFunction = new lambda.Function(this, 'MigrationsFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket, `cts-zips/cts-migrations/${cdk.Fn.select(0, migrationsZip.objectKeys)}`),
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
      domainName: props.domainName,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });

    const domainName = new apigatewayv2.DomainName(this, 'DomainName', {
      domainName: props.domainName,
      certificate,
    });

    // API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      defaultDomainMapping: {
        domainName,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('LambdaIntegration', ctsServerFunction),
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: `${props.domainName}.`,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          domainName.regionalDomainName,
          domainName.regionalHostedZoneId
        )
      ),
    });

    new core.CfnOutput(this, 'ApiUrl', {
      description: 'The URL of the CTS API',
      value: `https://${props.domainName}/`
    });

    new core.CfnOutput(this, 'MigrationFunctionName', {
      description: 'The name of the Lambda function for running CTS DB migrations',
      value: ctsMigrationsFunction.functionName,
    });
  }
}

interface CipherStashZeroKmsStackProps extends cdk.StackProps {
  kmsKeyManagerArns: string[],
  tokenIssuer: string,
  zoneName: string,
  domainName: string,
  multiRegionKey: boolean,
}

export class CipherStashZeroKmsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CipherStashZeroKmsStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new iam.AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new iam.ArnPrincipal(arn))
    ];

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
      sources: [s3Deployment.Source.asset('zips/zerokms.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zerokms-zips/zerokms-server',
      extract: false,
    });

    const migrationsZip = new s3Deployment.BucketDeployment(this, 'DeployMigrationsLambdaZips', {
      sources: [s3Deployment.Source.asset('zips/zerokms-migrations.zip')],
      destinationBucket: lambdaZipsBucket,
      destinationKeyPrefix: 'zerokms-zips/zerokms-migrations',
      extract: false,
    });

    const rootKeyPolicy = getRootKeyPolicy(kmsKeyManagers, lambdaExecRole);

    const rootKey = new kms.CfnKey(this, 'RootKey', {
      description: "ZeroKMS root key",
      multiRegion: !!props.multiRegionKey,
      keyPolicy: rootKeyPolicy,
    });

    const rootKeyAlias = new kms.CfnAlias(this, 'RootKeyAlias', {
      aliasName: 'zerokms-root-key',
      targetKeyId: rootKey.ref,
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

    const postgresSecret = new secretsmanager.Secret(this, 'PostgresCredentials', {
      secretName: 'ZeroKmsPostgresCredentials',
      description: "ZeroKMS Postgres Credentials",
      generateSecretString: {
        excludeCharacters: "\"@/\\ '",
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: postgresUsername }),
      },
    });

    postgresSecret.grantRead(lambdaExecRole);

    const postgresCredentials = rds.Credentials.fromSecret(
      postgresSecret,
      postgresUsername,
    );

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
      databaseName: 'zerokms',
    });

    // Lambda functions
    const lambdaEnvironment = {
      "ZEROKMS__IDP__AUDIENCE": `https://${props.domainName}/`,
      "ZEROKMS__IDP__ISSUERS": props.tokenIssuer,
      "ZEROKMS__KEY_PROVIDER__ROOT_KEY_ID": rootKey.ref,
      "ZEROKMS__TRACING_ENABLED": "false",
      "ZEROKMS__POSTGRES__CREDS_SECRET_ARN": postgresSecret.secretArn,
      "ZEROKMS__POSTGRES__HOST": dbInstance.dbInstanceEndpointAddress,
      "ZEROKMS__POSTGRES__NAME": "zerokms",
      "ZEROKMS__POSTGRES__PORT": dbInstance.dbInstanceEndpointPort,
      "ZEROKMS__POSTGRES__SSL_MODE": "verify-full",
    };

    const zeroKmsServerFunction = new lambda.Function(this, 'ServerFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket, `zerokms-zips/zerokms-server/${cdk.Fn.select(0, serverZip.objectKeys)}`),
      memorySize: 3008,
      timeout: cdk.Duration.seconds(5),
      environment: lambdaEnvironment,
      role: lambdaExecRole,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const zeroKmsMigrationsFunction = new lambda.Function(this, 'MigrationsFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: lambda.Code.fromBucket(lambdaZipsBucket, `zerokms-zips/zerokms-migrations/${cdk.Fn.select(0, migrationsZip.objectKeys)}`),
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
      logGroupName: `/aws/lambda/${zeroKmsServerFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    new logs.LogGroup(this, 'MigrationsFunctionLogGroup', {
      logGroupName: `/aws/lambda/${zeroKmsMigrationsFunction.functionName}`,
      retention: logs.RetentionDays.ONE_DAY,
    });

    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.zoneName,
    });

    const certificate = new certificatemanager.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: certificatemanager.CertificateValidation.fromDns(zone),
    });

    const domainName = new apigatewayv2.DomainName(this, 'DomainName', {
      domainName: props.domainName,
      certificate,
    });

    // API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      defaultDomainMapping: {
        domainName,
      },
      disableExecuteApiEndpoint: true,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('LambdaIntegration', zeroKmsServerFunction),
    });

    new route53.ARecord(this, 'AliasRecord', {
      zone,
      recordName: `${props.domainName}.`,
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(
          domainName.regionalDomainName,
          domainName.regionalHostedZoneId
        )
      ),
    });

    new core.CfnOutput(this, 'ApiUrl', {
      description: 'The URL of the ZeroKMS API',
      value: `https://${props.domainName}/`
    });

    new core.CfnOutput(this, 'MigrationFunctionName', {
      description: 'The name of the Lambda function for running ZeroKMS DB migrations',
      value: zeroKmsMigrationsFunction.functionName,
    });

    if (props.multiRegionKey) {
      new core.CfnOutput(this, 'RootKeyArn', {
        description: 'The arn of the *AWS-KMS* root key',
        value: rootKey.attrArn,
      });
    }

  }
}

interface CipherStashZeroKmsReplicaStackProps extends cdk.StackProps {
  kmsKeyManagerArns: string[],
  primaryKeyArn: string,
}

export class CipherStashZeroKmsReplicaStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: CipherStashZeroKmsReplicaStackProps) {
    super(scope, id, props);

    const kmsKeyManagers = [
      new iam.AccountRootPrincipal(),
      ...props.kmsKeyManagerArns.map(arn => new iam.ArnPrincipal(arn))
    ];

    // IAM Role for Lambda
    const lambdaExecRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const rootKeyPolicy = getRootKeyPolicy(kmsKeyManagers, lambdaExecRole);

    const replicaKey = new kms.CfnReplicaKey(this, 'ReplicaKey', {
      description: "ZeroKMS root key replica",
      primaryKeyArn: props.primaryKeyArn,
      keyPolicy: rootKeyPolicy,
    });

  }

}


function getRootKeyPolicy(kmsKeyManagers: cdk.aws_iam.ArnPrincipal[], lambdaExecRole: cdk.aws_iam.Role) {

  const rootKeyPolicy = new iam.PolicyDocument({
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
  });

}