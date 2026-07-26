import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  ResourceNotFoundException,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.TABLE_NAME || "team-drawer-test";

const client = new DynamoDBClient(endpoint ? { endpoint } : {});

export async function createTestTable(): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
}

export async function dropTestTable(): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }
}

/** テストごとに空の状態から始めるため作り直す */
export async function resetTestTable(): Promise<void> {
  await dropTestTable();
  await createTestTable();
}
