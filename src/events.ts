export async function publishShuffleEvent(eventCode: string, payload: any): Promise<void> {
  const httpEndpoint = process.env.APPSYNC_HTTP_ENDPOINT;
  const apiKey = process.env.APPSYNC_API_KEY;

  if (!httpEndpoint) {
    console.log("APPSYNC_HTTP_ENDPOINT not configured, skipping event publish.");
    return;
  }

  try {
    const publishUrl = httpEndpoint.endsWith("/event/publish")
      ? httpEndpoint
      : `${httpEndpoint.replace(/\/$/, "")}/event/publish`;

    const channel = `/event-bus/public/shuffle`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const response = await fetch(publishUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        channel,
        events: [JSON.stringify({ eventCode, ...payload })],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn("AppSync event publish warning:", response.status, errText);
    } else {
      console.log("Successfully published shuffle event via AppSync Events");
    }
  } catch (err) {
    console.warn("Failed to publish AppSync event:", err);
  }
}
