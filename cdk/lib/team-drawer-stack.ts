import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";

export class TeamDrawerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 1. Cognito User Pool & Client
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "team-drawer-userpool",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      userPoolClientName: "team-drawer-client",
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    // Default Admin User
    new cognito.CfnUserPoolUser(this, "DefaultAdminUser", {
      userPoolId: userPool.userPoolId,
      username: "admin@jaws-ug-saga.local",
      userAttributes: [
        { name: "email", value: "admin@jaws-ug-saga.local" },
        { name: "email_verified", value: "true" },
      ],
      messageAction: "SUPPRESS",
    });

    // 2. AppSync Event API
    const eventApi = new appsync.EventApi(this, "EventApi", {
      apiName: "team-drawer-event-api",
      authorizationConfig: {
        authProviders: [
          {
            authorizationType: appsync.AppSyncAuthorizationType.API_KEY,
          },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
      },
    });

    const apiKey = new appsync.CfnApiKey(this, "ApiKey", {
      apiId: eventApi.apiId,
      expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, // 30 days
    });

    // 3. Lambda Backend Function
    const backendLambda = new nodejs.NodejsFunction(this, "BackendFunction", {
      entry: path.join(__dirname, "../../src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        APPSYNC_HTTP_ENDPOINT: `https://${eventApi.httpDns}`,
        APPSYNC_API_KEY: apiKey.attrApiKey,
        DATABASE_URL: "file:/tmp/team_drawer.db",
      },
      bundling: {
        minify: false,
        sourceMap: true,
        nodeModules: ["@prisma/client", "prisma"],
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [
              `cp -r ${path.join(inputDir, "prisma")} ${outputDir}/`,
              `cp -r ${path.join(inputDir, "public")} ${outputDir}/`,
            ];
          },
          beforeInstall(): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [
              `mkdir -p ${outputDir}/node_modules`,
              `cp -r ${path.join(inputDir, "node_modules/.prisma")} ${outputDir}/node_modules/`,
              `cp -r ${path.join(inputDir, "node_modules/@prisma")} ${outputDir}/node_modules/`,
            ];
          },
        },
      },
    });

    // Grant IAM Bedrock permission
    backendLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      })
    );

    // 4. API Gateway Rest API
    const api = new apigw.LambdaRestApi(this, "RestApi", {
      handler: backendLambda,
      proxy: true,
    });

    // Outputs
    const baseUrl = api.url.replace(/\/$/, "");
    new CfnOutput(this, "ParticipantUrl", {
      value: `${baseUrl}/e/JAWS-SAGA`,
      description: "Public Viewer URL for Participants",
    });

    new CfnOutput(this, "AdminUrl", {
      value: `${baseUrl}/e/JAWS-SAGA/admin`,
      description: "Admin Screen URL (Cognito Login Required)",
    });

    new CfnOutput(this, "AdminUserEmail", {
      value: "admin@jaws-ug-saga.local",
      description: "Initial Admin Username/Email",
    });

    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });

    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
  }
}
