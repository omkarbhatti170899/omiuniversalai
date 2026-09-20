// Disposable E2E test of omiChat:send through the real auth flow.
// Anonymous sign-in -> create conversation -> call omiChat:send -> inspect reply.
// Never prints any secret.
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";

const url = process.env.CONVEX_URL || "https://resolute-ptarmigan-187.convex.cloud";

async function main() {
  const client = new ConvexHttpClient(url);

  // 1) Anonymous sign-in (existing provider in src/convex/auth.ts)
  const signInResult = await client.action(api.auth.signIn, {
    provider: "anonymous",
    params: {},
  });
  const accessToken = signInResult?.tokens?.token;
  if (!accessToken) {
    console.log("SIGNIN: no token returned");
    return;
  }
  console.log("SIGNIN: ok (anonymous)");
  client.setAuth(accessToken);

  // 2) Create a conversation
  const conversationId = await client.mutation(api.omiConversations.create, {
    title: "Live key test",
  });
  console.log("CONVERSATION:", conversationId);

  // 3) The live test message
  const res = await client.action(api.omiChat.send, {
    conversationId,
    message: "Who invented you",
  });
  console.log("ACTION RESULT:", JSON.stringify(res));

  // 4) Read back the saved messages
  const messages = await client.query(api.omiMessages.listByConversation, {
    conversationId,
  });
  for (const m of messages) {
    const body = m.role === "omi" ? `${m.content}` : m.content;
    console.log(`[${m.role}]`, body.slice(0, 200));
    if (m.reasoning) console.log("   reasoning:", m.reasoning.slice(0, 200));
  }

  // 5) Clean up the test conversation
  await client.mutation(api.omiConversations.remove, { id: conversationId });
  console.log("CLEANUP: test conversation removed");
}

main().catch((e) => {
  console.log("TEST FAILED:", String(e?.message ?? e).slice(0, 400));
});
