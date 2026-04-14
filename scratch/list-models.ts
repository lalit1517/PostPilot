import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";

async function listModels() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY as string);
    // LangChain uses the base SDK under the hood. 
    // We can try to list them via a direct fetch or the SDK if available.
    // For now, let's just try the most likely stable name.
    console.log("Testing gemini-2.0-flash-exp...");
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const res = await model.generateContent("Hello");
    console.log("Success with gemini-2.0-flash-exp!");
  } catch (err: any) {
    console.error("Test Failed:", err.message);
  }
}

listModels();
