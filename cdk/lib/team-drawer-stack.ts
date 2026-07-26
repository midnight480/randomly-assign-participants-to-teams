import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as path from "path";

const EVENT_CODE = "JAWS-SAGA";
const CHANNEL_NAMESPACE = "team-drawer";
const CHANNEL = `/${CHANNEL_NAMESPACE}/shuffle`;
/** くじ引きで最初にチームを作るときのチーム数 */
const TEAM_COUNT = 4;

export interface TeamDrawerStackProps extends StackProps {
  /** 管理者ログインのメールアドレス（Cognito ユーザー名） */
  readonly adminEmail: string;
  /** 管理者パスワード。恒久パスワードとして設定される */
  readonly adminPassword: string;
}

export class TeamDrawerStack extends Stack {
  constructor(scope: Construct, id: string, props: TeamDrawerStackProps) {
    super(scope, id, props);

    const { adminEmail, adminPassword } = props;

    // ------------------------------------------------------------------
    // 1. DynamoDB — チーム分け結果の保存先
    //    Lambda の /tmp は実行環境ごとに独立していて共有されないため、
    //    SQLite だと参加者画面と管理画面で結果が食い違う。
    //    単発イベント用なので 1 イベント = 1 アイテムで持つ。
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, "StateTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------------
    // 2. Cognito — 管理画面ログイン
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "team-drawer-userpool",
      // 参加者が勝手に管理者アカウントを作れてしまうので self sign-up は無効
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      userPoolClientName: "team-drawer-client",
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

    const adminUser = new cognito.CfnUserPoolUser(this, "AdminUser", {
      userPoolId: userPool.userPoolId,
      username: adminEmail,
      userAttributes: [
        { name: "email", value: adminEmail },
        { name: "email_verified", value: "true" },
      ],
      messageAction: "SUPPRESS",
    });

    // CfnUserPoolUser を作っただけでは FORCE_CHANGE_PASSWORD のままで、
    // USER_PASSWORD_AUTH が NEW_PASSWORD_REQUIRED を返しログインできない。
    // 恒久パスワードをここで設定して cdk deploy だけで完結させる。
    const setPassword = new cr.AwsCustomResource(this, "SetAdminPassword", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminSetUserPassword",
        parameters: {
          UserPoolId: userPool.userPoolId,
          Username: adminEmail,
          Password: adminPassword,
          Permanent: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-password-${adminEmail}`),
      },
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "adminSetUserPassword",
        parameters: {
          UserPoolId: userPool.userPoolId,
          Username: adminEmail,
          Password: adminPassword,
          Permanent: true,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`admin-password-${adminEmail}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["cognito-idp:AdminSetUserPassword"],
          resources: [userPool.userPoolArn],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    setPassword.node.addDependency(adminUser);

    // ------------------------------------------------------------------
    // 3. AppSync Events — 参加者画面のリアルタイム更新
    // ------------------------------------------------------------------
    const eventApi = new appsync.EventApi(this, "EventApi", {
      apiName: "team-drawer-event-api",
      authorizationConfig: {
        authProviders: [{ authorizationType: appsync.AppSyncAuthorizationType.API_KEY }],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.API_KEY],
      },
    });

    // チャンネル名前空間が無いと publish も subscribe も通らない
    eventApi.addChannelNamespace("Shuffle", {
      channelNamespaceName: CHANNEL_NAMESPACE,
    });

    // API_KEY 認証を指定すると L2 が API キーを 1 本自動生成する。
    // 自前で CfnApiKey + Date.now() を使うと synth のたびに差分が出るので使わない。
    const apiKey = eventApi.apiKeys["Default"];

    // ------------------------------------------------------------------
    // 4. Lambda — API + 静的ファイル配信
    // ------------------------------------------------------------------
    const backendLambda = new nodejs.NodejsFunction(this, "BackendFunction", {
      entry: path.join(__dirname, "../../src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        APPSYNC_HTTP_ENDPOINT: `https://${eventApi.httpDns}`,
        APPSYNC_REALTIME_ENDPOINT: `wss://${eventApi.realtimeDns}`,
        APPSYNC_API_KEY: apiKey.attrApiKey,
        APPSYNC_CHANNEL: CHANNEL,
        EVENT_CODE,
        TEAM_COUNT: String(TEAM_COUNT),
      },
      bundling: {
        minify: false,
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // バンドル結果は outputDir 直下に index.js として出るので、
          // public/ も同じ階層に置いて __dirname/public で引けるようにする
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${path.join(inputDir, "public")} ${outputDir}/public`,
          ],
        },
      },
    });

    table.grantReadWriteData(backendLambda);

    backendLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:InitiateAuth"],
        resources: [userPool.userPoolArn],
      })
    );

    // ------------------------------------------------------------------
    // 5. HTTP API ($default ステージ = URL にステージ名が入らない)
    //    REST API だと URL が /prod/... になり、フロントの絶対パス
    //    (/api/..., /styles.css, /app.js) が全て届かなくなるため v2 を使う。
    // ------------------------------------------------------------------
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "team-drawer-api",
      defaultIntegration: new integrations.HttpLambdaIntegration(
        "DefaultIntegration",
        backendLambda
      ),
    });

    // 公開URLなので、暴走や悪意あるアクセスで Lambda / DynamoDB の課金が
    // 際限なく伸びないよう上限を設ける。参加者300名が3秒ポーリングしても
    // 100rps 程度なので、通常利用には十分な余裕がある。
    const defaultStage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 500,
      throttlingBurstLimit: 1000,
    };

    const baseUrl = api.apiEndpoint;

    new CfnOutput(this, "ParticipantUrl", {
      value: `${baseUrl}/e/${EVENT_CODE}`,
      description: "参加者用 公開URL（認証不要）",
    });
    new CfnOutput(this, "AdminUrl", {
      value: `${baseUrl}/e/${EVENT_CODE}/admin`,
      description: "管理者用URL（Cognito ログイン必須）",
    });
    new CfnOutput(this, "AdminEmail", {
      value: adminEmail,
      description: "管理者ログインID",
    });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "AppSyncChannel", { value: CHANNEL });
  }
}
