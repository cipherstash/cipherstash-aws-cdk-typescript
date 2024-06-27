import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CipherstashCtsAwsCdkStack } from '../lib/cipherstash-cts-aws-cdk-stack';

// Test for the creation of the S3 bucket
test('S3 Bucket Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new CipherstashCtsAwsCdkStack(app, 'CipherstashCtsAwsCdkStack');
  // THEN
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'AES256'
          }
        }
      ]
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true
    }
  });
});

// Test for the creation of the Lambda functions
test('Lambda Function Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new CipherstashCtsAwsCdkStack(app, 'MyTestStack');
  // THEN
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'bootstrap',
    Runtime: 'provided.al2',
    MemorySize: 3008,
    Timeout: 5,
    Environment: {
      Variables: {
        CTS__AUTH0__TOKEN_AUDIENCES: 'your-auth0-token-audience1,your-auth0-token-audience2',
        CTS__AUTH0__TOKEN_ISSUER: 'your-auth0-token-issuer',
        CTS__DATABASE__CREDS_SECRET_ARN: {
          Ref: 'DatabaseSecretArn' // adjust based on your secret ARN
        },
        CTS__DATABASE__HOST: {
          'Fn::GetAtt': [
            'DatabaseInstance',
            'Endpoint.Address'
          ]
        },
        CTS__DATABASE__NAME: 'cts',
        CTS__DATABASE__PORT: {
          'Fn::GetAtt': [
            'DatabaseInstance',
            'Endpoint.Port'
          ]
        },
        CTS__DATABASE__SSL_MODE: 'verify-full',
        CTS__JWT_SIGNING_KEY_ID: {
          Ref: 'JwtSigningKeyId' // adjust based on your key ID
        },
        CTS__TRACING_ENABLED: 'false',
        CTS__META_ENDPOINTS_ENABLED: 'true',
        CTS__LOGGING_ENDPOINTS: ''
      }
    }
  });
});

// Test for the creation of the API Gateway
test('API Gateway Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new CipherstashCtsAwsCdkStack(app, 'MyTestStack');
  // THEN
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'cts',
    ProtocolType: 'HTTP'
  });

  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'ANY /{proxy+}'
  });

  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: {
      'Fn::GetAtt': [
        'CtsServerFunction',
        'Arn'
      ]
    }
  });
});

// Test for the creation of the RDS instance
test('RDS Instance Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new CipherstashCtsAwsCdkStack(app, 'MyTestStack');
  // THEN
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceClass: 'db.t3.micro',
    Engine: 'postgres',
    EngineVersion: '16.3',
    MasterUsername: 'postgres',
    AllocatedStorage: '20',
    DeletionProtection: true
  });
});

// Test for the creation of the CloudWatch Log Group
test('CloudWatch Log Group Created', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new CipherstashCtsAwsCdkStack(app, 'MyTestStack');
  // THEN
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::Logs::LogGroup', {
    RetentionInDays: 30
  });
});
