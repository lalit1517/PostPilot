import 'dotenv/config';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

async function testGemini() {
  try {
    const llm = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash", // Use a confirmed model name
      apiKey: process.env.GOOGLE_API_KEY as string,
    });
    console.log("Invoking Gemini...");
    const res = await llm.invoke("Say hello");
    console.log("Response:", res.content);
  } catch (err: any) {
    console.error("Gemini Test Failed:", err.message);
  }
}

testGemini();
