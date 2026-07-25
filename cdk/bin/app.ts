import * as cdk from "aws-cdk-lib";
import { TeamDrawerStack } from "../lib/team-drawer-stack";

const app = new cdk.App();

new TeamDrawerStack(app, "TeamDrawerStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION || "us-east-1",
  },
});
