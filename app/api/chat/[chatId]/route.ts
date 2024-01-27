import { StreamingTextResponse, LangChainStream } from "ai";
import { auth, currentUser } from "@clerk/nextjs";
import { CallbackManager } from "langchain/callbacks";
import { Replicate } from "langchain/llms/replicate";
import { NextResponse } from "next/server";

import { MemoryManager } from "@/lib/memory";
import { rateLimit } from "@/lib/rate-limit";
import { prismadb } from "@/lib/prismadb";

import { OpenAI } from "langchain/llms/openai";
import { PromptTemplate } from "langchain/prompts";
import { LLMChain } from "langchain/chains";

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  try {
    const { prompt } = await request.json();
    const user = await currentUser();
    if (!user || !user.firstName || !user.id) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const identifier = request.url + "-" + user.id;
    const { success } = await rateLimit(identifier);

    if (!success) {
      return new NextResponse("Rate limit exceeded", { status: 429 });
    }
    const companion = await prismadb.companion.update({
      where: {
        id: params.chatId,
      },
      data: {
        messages: {
          create: {
            content: prompt,
            role: "user",
            userId: user.id,
          },
        },
      },
    });

    if (!companion) {
      return new NextResponse("Companion not found", { status: 404 });
    }

    const name = companion.id;
    const companion_file_name = name + ".txt";

    const companionKey = {
      companionName: name,
      userId: user.id,
      // modelName: "llama-13b",
      modelName: "gpt-3.5-turbo-16k",
    };

    const memoryManager = await MemoryManager.getInstance();

    const records = await memoryManager.readLatestHistory(companionKey);

    if (!records || records.length == 0) {
      await memoryManager.seedChatHistory(companion.seed, "\n\n", companionKey);
    }
    await memoryManager.writeToHistory("User: " + prompt + "\n", companionKey);

    const recentChatHistory = await memoryManager.readLatestHistory(
      companionKey
    );

    const similarDocs = await memoryManager.vectorSearch(
      recentChatHistory,
      companion_file_name
    );
    let relevantHistory = "";

    if (!!similarDocs && similarDocs.length !== 0) {
      relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
    }
    console.log(relevantHistory);

    const { handlers } = LangChainStream();

    // Call Replicate for inference
    // const model = new Replicate({
    //   model:
    //     "a16z-infra/llama-2-13b-chat:df7690f1994d94e96ad9d568eac121aecf50684a0b0963b25a41cc40061269e5",
    //   input: {
    //     max_length: 2048,
    //   },
    //   apiKey: process.env.REPLICATE_API_TOKEN,
    //   callbackManager: CallbackManager.fromHandlers(handlers),
    // });

    const model = new OpenAI({
      modelName: "gpt-3.5-turbo-16k",
      openAIApiKey: process.env.OPEN_AI_API_KEY,
      callbackManager: CallbackManager.fromHandlers(handlers),
    });

    // Turn verbose on for debugging
    model.verbose = true;

    const chainPrompt = PromptTemplate.fromTemplate(
      `
            ONLY generate response without prefix of who is speaking. DO NOT use ${companion.name}: prefix. 
            
            You are ${companion.name} and are currently talking to ${currentUser.name}.
            
            ${companion.instruction}
            
            Below are relevant details about ${companion.name}'s past and the conversation you are in.
            ${relevantHistory}
            
            Below is a relevant conversation history
            ${recentChatHistory}\n${companion.name}
            `
    );

    const chain = new LLMChain({
      llm: model,
      prompt: chainPrompt,
    });

    const response = await chain
      .call({
        relevantHistory,
        recentChatHistory: recentChatHistory,
      })
      .catch(console.error);

    const real_response = response!.text;

    if (real_response !== undefined && real_response.length > 1) {
      memoryManager.writeToHistory("" + real_response.trim(), companionKey);

      // upsert it into the pinecone db
      const current_history = `${real_response.trim()}`;
      await memoryManager.UpsertChatHistory(
        recentChatHistory + "\n" + current_history,
        companion_file_name
      );

      await prismadb.companion.update({
        where: {
          id: params.chatId,
        },
        data: {
          messages: {
            create: {
              content: real_response,
              role: "system",
              userId: user.id,
            },
          },
        },
      });
    }

    var Readable = require("stream").Readable;
    let s = new Readable();
    s.push(real_response);
    s.push(null);

    return new StreamingTextResponse(s);

    // const resp = String(
    //   await model
    //     .call(
    //       `
    //     ONLY generate plain sentences without prefix of who is speaking. DO NOT use ${companion.name}: prefix.

    //     ${companion.instruction}

    //     Below are relevant details about ${companion.name}'s past and the conversation you are in.
    //     ${relevantHistory}

    //     ${recentChatHistory}\n${companion.name}:`
    //     )
    //     .catch(console.error)
    // );

    // const cleaned = resp.replaceAll(",", "");
    // const chunks = cleaned.split("\n");

    // const response = chunks[0];

    // await memoryManager.writeToHistory("" + response.trim(), companionKey);
    // var Readable = require("stream").Readable;

    // let s = new Readable();
    // s.push(response);
    // s.push(null);
    // if (response !== undefined && response.length > 1) {
    //   memoryManager.writeToHistory("" + response.trim(), companionKey);

    //   // upsert it into the pinecone db
    //   const current_history = `${response.trim()}`;
    //   await memoryManager.UpsertChatHistory(
    //     recentChatHistory + "\n" + current_history,
    //     companion_file_name
    //   );
    //   await prismadb.companion.update({
    //     where: {
    //       id: params.chatId,
    //     },
    //     data: {
    //       messages: {
    //         create: {
    //           content: response.trim(),
    //           role: "system",
    //           userId: user.id,
    //         },
    //       },
    //     },
    //   });
    // }

    // return new StreamingTextResponse(s);
  } catch (error) {
    console.log("[CHAT_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
