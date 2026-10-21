import {
  Stack,
  StackProps,
  CfnOutput,
  RemovalPolicy,
  ArnFormat,
  AssetHashType,
  DockerImage,
  Fn,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cr from "aws-cdk-lib/custom-resources";
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const CHANNEL_NAMESPACE = "team-drawer";
const CHANNEL = `/${CHANNEL_NAMESPACE}/shuffle`;
/** くじ引きで最初にチームを作るときのチーム数 */
const TEAM_COUNT = 4;
/** Web Function の名前。リージョン・アカウント内で一意 */
const WEB_FUNCTION_NAME = "team-drawer";

export interface TeamDrawerStackProps extends StackProps {
  /** 管理者ログインのメールアドレス（Cognito ユーザー名） */
  readonly adminEmail: string;
  /** 管理者パスワード。恒久パスワードとして設定される */
  readonly adminPassword: string;
  /** イベントコード。URL(/e/{code})とデータの保存キーになる */
  readonly eventCode: string;
  /** 画面に表示するイベント名 */
  readonly eventTitle: string;
}

export class TeamDrawerStack extends Stack {
  constructor(scope: Construct, id: string, props: TeamDrawerStackProps) {
    super(scope, id, props);

    const { adminEmail, adminPassword, eventCode, eventTitle } = props;

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
    // 4. Lambda Web Functions — API + 静的ファイル配信
    //    コードは「バージョニング有効」の S3 バケットに zip で置く決まり。
    //    CDK ブートストラップのバケットは他スタックと共用で、バケットポリシーを
    //    足すと上書きになってしまうため、専用バケットを作る。
    // ------------------------------------------------------------------
    const codeBucket = new s3.Bucket(this, "WebFunctionCodeBucket", {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Lambda 本体はサービスプリンシパルでコードを読みに来る。
    // リビジョンを作るときに読めるか確認され、読めないと作成に失敗する。
    codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
        actions: ["s3:GetObject", "s3:GetObjectVersion"],
        resources: [codeBucket.arnForObjects("*")],
        conditions: {
          ArnLike: {
            "aws:SourceArn": this.formatArn({
              service: "lambda",
              resource: "web-function",
              resourceName: `${WEB_FUNCTION_NAME}/revision/*`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }),
          },
        },
      })
    );

    // esbuild で index.js 1本にまとめ、public/ を同じ階層に置く。
    // Web Functions のランタイムはパッケージ直下の index.js を読み込む。
    // AWS SDK もまとめて同梱し、ランタイム側の SDK の有無に左右されないようにする。
    const projectRoot = path.join(__dirname, "../..");
    const codeAsset = s3deploy.Source.asset(projectRoot, {
      assetHashType: AssetHashType.OUTPUT,
      bundling: {
        // local で必ず成功させるので Docker イメージは使われない
        image: DockerImage.fromRegistry("public.ecr.aws/docker/library/node:24"),
        local: {
          tryBundle(outputDir: string) {
            esbuild.buildSync({
              entryPoints: [path.join(projectRoot, "src/main.ts")],
              outfile: path.join(outputDir, "index.js"),
              bundle: true,
              platform: "node",
              target: "node24",
              format: "cjs",
              sourcemap: true,
              logLevel: "warning",
            });
            fs.cpSync(path.join(projectRoot, "public"), path.join(outputDir, "public"), {
              recursive: true,
            });
            return true;
          },
        },
      },
    });

    // extract: false で zip のまま置く。キーはアセットのハッシュなので、
    // コードが変わるとキーが変わり、リビジョンが作り直される。
    // 稼働中のリビジョンが参照する旧 zip を消すとリビジョンが壊れるため prune はしない。
    const codeDeployment = new s3deploy.BucketDeployment(this, "WebFunctionCode", {
      sources: [codeAsset],
      destinationBucket: codeBucket,
      destinationKeyPrefix: "code/",
      extract: false,
      prune: false,
    });
    const codeKey = `code/${Fn.select(0, codeDeployment.objectKeys)}`;

    const executionRole = new iam.Role(this, "WebFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    table.grantReadWriteData(executionRole);
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:InitiateAuth"],
        resources: [userPool.userPoolArn],
      })
    );

    const webFunction = new lambda.CfnWebFunction(this, "WebFunction", {
      functionName: WEB_FUNCTION_NAME,
    });

    const revision = new lambda.CfnWebFunctionRevision(this, "WebFunctionRevision", {
      functionName: webFunction.ref,
      buildConfig: {
        codeConfig: { s3Object: { bucket: codeBucket.bucketName, key: codeKey } },
        runtimeConfig: { runtime: "nodejs24.x" },
      },
      serviceConfig: {
        executionRoleArn: executionRole.roleArn,
        timeoutSeconds: 30,
        environmentVariables: {
          TABLE_NAME: table.tableName,
          USER_POOL_ID: userPool.userPoolId,
          USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
          APPSYNC_HTTP_ENDPOINT: `https://${eventApi.httpDns}`,
          APPSYNC_REALTIME_ENDPOINT: `wss://${eventApi.realtimeDns}`,
          APPSYNC_API_KEY: apiKey.attrApiKey,
          APPSYNC_CHANNEL: CHANNEL,
          EVENT_CODE: eventCode,
          EVENT_TITLE: eventTitle,
          TEAM_COUNT: String(TEAM_COUNT),
          NODE_OPTIONS: "--enable-source-maps",
        },
      },
    });
    // コードの配置とバケットポリシーが揃ってからでないと、リビジョン作成時の
    // 読み取り確認に失敗する
    revision.node.addDependency(codeDeployment);
    revision.node.addDependency(codeBucket.policy!);
    revision.node.addDependency(executionRole);

    // ------------------------------------------------------------------
    // 5. エンドポイント — 公開URL
    //    ブラウザから直接叩くので ApplicationManaged（Lambda 側で認証しない）。
    //    管理者 API の認証は従来どおりアプリ内で Cognito のトークンを検証する。
    //    CloudFormation では自動デプロイモードを指定できないため、
    //    重みでリビジョンを明示する。リビジョンが作り直されると振り先も切り替わる。
    // ------------------------------------------------------------------
    const endpoint = new lambda.CfnWebFunctionEndpoint(this, "WebFunctionEndpoint", {
      functionName: webFunction.ref,
      endpointName: "public",
      endpointType: "HomeRegion",
      authType: "ApplicationManaged",
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      // 公開URLなので、暴走や悪意あるアクセスで課金が際限なく伸びないよう上限を設ける。
      // 参加者300名が3秒ポーリングしても 100rps 程度なので、通常利用には十分な余裕がある。
      throttleConfig: { rateLimit: 500 },
      // 1環境が複数リクエストを同時に捌くので、単発イベントなら数台で足りる
      scalingConfig: { maxEnvironments: 5 },
    });

    const baseUrl = `https://${endpoint.attrDomainName}`;

    new CfnOutput(this, "ParticipantUrl", {
      value: `${baseUrl}/e/${eventCode}`,
      description: "参加者用 公開URL（認証不要）",
    });
    new CfnOutput(this, "AdminUrl", {
      value: `${baseUrl}/e/${eventCode}/admin`,
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
