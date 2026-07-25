/**
 * AppSync Events へシャッフル結果を publish する。
 * 失敗してもチーム分け自体は成立させたいので、例外は投げずに warn で握る
 * （参加者画面は 3 秒ポーリングのフォールバックを併用している）。
 */
export async function publishShuffleEvent(eventCode: string, payload: any): Promise<void> {
  const httpEndpoint = process.env.APPSYNC_HTTP_ENDPOINT;
  const apiKey = process.env.APPSYNC_API_KEY;
  const channel = process.env.APPSYNC_CHANNEL || "/team-drawer/shuffle";

  if (!httpEndpoint || !apiKey) {
    console.log("AppSync Events not configured, skipping publish.");
    return;
  }

  const publishUrl = `${httpEndpoint.replace(/\/+$/, "")}/event`;

  try {
    const response = await fetch(publishUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        channel,
        // events は「JSON文字列の配列」であることに注意（オブジェクトの配列ではない）
        events: [JSON.stringify({ eventCode, ...payload })],
      }),
    });

    if (!response.ok) {
      console.warn("AppSync publish failed:", response.status, await response.text());
      return;
    }

    // 部分失敗は HTTP 200 で返ってくるのでレスポンス本文も確認する
    const result: any = await response.json().catch(() => null);
    if (result?.failed?.length) {
      console.warn("AppSync publish partially failed:", JSON.stringify(result.failed));
    } else {
      console.log("Published shuffle event to", channel);
    }
  } catch (err) {
    console.warn("Failed to publish AppSync event:", err);
  }
}
