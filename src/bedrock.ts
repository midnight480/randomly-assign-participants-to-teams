import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const DEFAULT_COMMENTS: string[] = [
  "がばい最高なチームワークでがんばりましょう！",
  "チーム一丸となってワークショップを楽しみましょう！",
  "アイデアをたくさん出して最高の成果を出しましょう！",
  "わいわい楽しく最高のソリューションを作りましょう！",
  "仲間と力を合わせて佐賀を盛り上げましょう！",
  "笑顔と挑戦心で素晴らしい結果を！",
];

export async function generateTeamComments(
  teams: { name: string; members: string[] }[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  // Setup default fallback comments
  teams.forEach((t, i) => {
    result[t.name] = DEFAULT_COMMENTS[i % DEFAULT_COMMENTS.length];
  });

  if (teams.length === 0) {
    return result;
  }

  try {
    const prompt = `あなたはJAWS-UG佐賀ワークショップの熱いモデレーターです。
以下のチーム一覧に対して、各チームに向けた元気づける一言コメント（30文字以内）を日本語で生成してください。

チーム一覧:
${teams.map((t) => `- ${t.name} (${t.members.join(", ") || "メンバー未割り当て"})`).join("\n")}

JSON形式で返答してください。キーはチーム名、値は一言コメントの文字列です。
例: {"がばい": "チーム一丸となって最高を目指そう！"}`;

    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 500,
      temperature: 0.7,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    };

    // Try Claude 3 Haiku or Nova Micro
    const modelId = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";

    const command = new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    const contentText = responseBody?.content?.[0]?.text;
    if (contentText) {
      const jsonMatch = contentText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const t of teams) {
          if (parsed[t.name] && typeof parsed[t.name] === "string") {
            result[t.name] = parsed[t.name].trim();
          }
        }
      }
    }
  } catch (err) {
    console.warn("Bedrock comment generation failed, using fallback comments:", err);
    // Bedrock error will not fail the team shuffle logic
  }

  return result;
}
