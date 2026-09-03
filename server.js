const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const port = process.env.PORT || 3000;
const publicDir = __dirname;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function safeFilePath(requestUrl) {
  const parsedUrl = new URL(requestUrl, "http://localhost");
  const requestedPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const filePath = path.normalize(path.join(publicDir, decodeURIComponent(requestedPath)));

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  return filePath;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Groq-API-Key, X-OpenAI-API-Key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function callGroq({ apiKey, model, messages }) {
  const requestBody = JSON.stringify({
    model: model || "openai/gpt-oss-20b",
    messages,
    temperature: 0.25,
    max_completion_tokens: 420,
  });

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise((resolve, reject) => {
    const groqRequest = https.request(options, (groqResponse) => {
      let body = "";

      groqResponse.on("data", (chunk) => {
        body += chunk;
      });

      groqResponse.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          reject(new Error("Groq returned a non-JSON response."));
          return;
        }

        if (groqResponse.statusCode < 200 || groqResponse.statusCode >= 300) {
          const message = parsed.error?.message || `Groq request failed with status ${groqResponse.statusCode}.`;
          reject(new Error(message));
          return;
        }

        resolve(parsed.choices?.[0]?.message?.content || "");
      });
    });

    groqRequest.setTimeout(30000, () => {
      groqRequest.destroy(new Error("Groq request timed out."));
    });
    groqRequest.on("error", reject);
    groqRequest.write(requestBody);
    groqRequest.end();
  });
}

function callGroqSpeech({ apiKey, voice, input }) {
  const requestBody = JSON.stringify({
    model: "canopylabs/orpheus-v1-english",
    voice: voice || "hannah",
    input: input.slice(0, 200),
    response_format: "wav",
  });

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/audio/speech",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise((resolve, reject) => {
    const speechRequest = https.request(options, (groqResponse) => {
      const chunks = [];

      groqResponse.on("data", (chunk) => {
        chunks.push(chunk);
      });

      groqResponse.on("end", () => {
        const buffer = Buffer.concat(chunks);

        if (groqResponse.statusCode < 200 || groqResponse.statusCode >= 300) {
          let message = `Groq speech request failed with status ${groqResponse.statusCode}.`;
          try {
            message = JSON.parse(buffer.toString("utf8")).error?.message || message;
          } catch {
            // Keep the generic status message for non-JSON audio errors.
          }
          reject(new Error(message));
          return;
        }

        resolve(buffer);
      });
    });

    speechRequest.setTimeout(30000, () => {
      speechRequest.destroy(new Error("Groq speech request timed out."));
    });
    speechRequest.on("error", reject);
    speechRequest.write(requestBody);
    speechRequest.end();
  });
}

function callOpenAIResponse({ apiKey, model, input }) {
  const requestBody = JSON.stringify({
    model: model || "gpt-5.6-luna",
    input,
    text: { verbosity: "low" },
    max_output_tokens: 420,
  });

  const options = {
    hostname: "api.openai.com",
    path: "/v1/responses",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise((resolve, reject) => {
    const openaiRequest = https.request(options, (openaiResponse) => {
      let body = "";

      openaiResponse.on("data", (chunk) => {
        body += chunk;
      });

      openaiResponse.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          reject(new Error("OpenAI returned a non-JSON response."));
          return;
        }

        if (openaiResponse.statusCode < 200 || openaiResponse.statusCode >= 300) {
          const message = parsed.error?.message || `OpenAI request failed with status ${openaiResponse.statusCode}.`;
          reject(new Error(message));
          return;
        }

        const outputText =
          parsed.output_text ||
          parsed.output
            ?.flatMap((item) => item.content || [])
            .map((content) => content.text)
            .filter(Boolean)
            .join("\n")
            .trim();

        resolve(outputText || "");
      });
    });

    openaiRequest.setTimeout(30000, () => {
      openaiRequest.destroy(new Error("OpenAI request timed out."));
    });
    openaiRequest.on("error", reject);
    openaiRequest.write(requestBody);
    openaiRequest.end();
  });
}

function callOpenAISpeech({ apiKey, voice, input }) {
  const requestBody = JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: voice || "nova",
    input: input.slice(0, 1200),
    response_format: "mp3",
  });

  const options = {
    hostname: "api.openai.com",
    path: "/v1/audio/speech",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(requestBody),
    },
  };

  return new Promise((resolve, reject) => {
    const speechRequest = https.request(options, (openaiResponse) => {
      const chunks = [];

      openaiResponse.on("data", (chunk) => {
        chunks.push(chunk);
      });

      openaiResponse.on("end", () => {
        const buffer = Buffer.concat(chunks);

        if (openaiResponse.statusCode < 200 || openaiResponse.statusCode >= 300) {
          let message = `OpenAI speech request failed with status ${openaiResponse.statusCode}.`;
          try {
            message = JSON.parse(buffer.toString("utf8")).error?.message || message;
          } catch {
            // Keep the generic message for non-JSON audio errors.
          }
          reject(new Error(message));
          return;
        }

        resolve(buffer);
      });
    });

    speechRequest.setTimeout(30000, () => {
      speechRequest.destroy(new Error("OpenAI speech request timed out."));
    });
    speechRequest.on("error", reject);
    speechRequest.write(requestBody);
    speechRequest.end();
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Groq-API-Key, X-OpenAI-API-Key",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    });
    response.end();
    return;
  }

  if (request.method === "POST" && request.url === "/api/groq-agent") {
    readJsonBody(request)
      .then(async (payload) => {
        const provider = payload.provider === "openai" ? "openai" : "groq";
        const apiKey =
          provider === "openai"
            ? process.env.OPENAI_API_KEY || request.headers["x-openai-api-key"]
            : process.env.GROQ_API_KEY || request.headers["x-groq-api-key"];

        if (!apiKey) {
          sendJson(response, 400, {
            error:
              provider === "openai"
                ? "Missing OpenAI API key. Set OPENAI_API_KEY before starting the server, or enter a key in the page."
                : "Missing Groq API key. Set GROQ_API_KEY before starting the server, or enter a key in the page.",
          });
          return;
        }

        const userText = String(payload.userText || "").slice(0, 4000);
        const dataSummary = String(payload.dataSummary || "No data source loaded.").slice(0, 6000);
        const recentConversation = Array.isArray(payload.recentConversation)
          ? payload.recentConversation
              .slice(-8)
              .map((entry) => `${entry.role === "user" ? "User" : "Agent"}: ${String(entry.text || "").slice(0, 500)}`)
              .join("\n")
          : "";

        const systemPrompt =
          "You are a warm, practical talking agent. Sound like a helpful coworker preparing someone for a meeting, not a report generator. Use only the provided data context for data summaries, trends, metrics, donor counts, and talking points. If the context includes dailyDonorCounts and the user asks about donors per day, answer from that aggregate instead of asking them to reload data. If the user asks about a company, person, or topic not present in the data context, say it is not in the loaded data and suggest asking about the available fields. Do not invent facts. Keep replies under 110 words unless asked otherwise. Write in plain spoken language without markdown, bullets, or labels.";
        const userPrompt = `Data context:\n${dataSummary}\n\nRecent conversation:\n${recentConversation || "No prior conversation."}\n\nUser request:\n${userText}`;

        if (provider === "openai") {
          const reply = await callOpenAIResponse({
            apiKey,
            model: payload.model,
            input: [
              {
                role: "developer",
                content: systemPrompt,
              },
              {
                role: "user",
                content: userPrompt,
              },
            ],
          });

          sendJson(response, 200, { reply });
          return;
        }

        const messages = [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: userPrompt,
          },
        ];

        const reply = await callGroq({
          apiKey,
          model: payload.model,
          messages,
        });

        sendJson(response, 200, { reply });
      })
      .catch((error) => {
        sendJson(response, 500, { error: error.message || "The Groq request failed." });
      });
    return;
  }

  if (request.method === "POST" && request.url === "/api/groq-speech") {
    readJsonBody(request)
      .then(async (payload) => {
        const provider = payload.provider === "openai" ? "openai" : "groq";
        const apiKey =
          provider === "openai"
            ? process.env.OPENAI_API_KEY || request.headers["x-openai-api-key"]
            : process.env.GROQ_API_KEY || request.headers["x-groq-api-key"];

        if (!apiKey) {
          sendJson(response, 400, {
            error: provider === "openai" ? "Missing OpenAI API key for speech." : "Missing Groq API key for speech.",
          });
          return;
        }

        const input = String(payload.input || "").trim();
        if (!input) {
          sendJson(response, 400, { error: "Missing speech input." });
          return;
        }

        const audioBuffer =
          provider === "openai"
            ? await callOpenAISpeech({
                apiKey,
                voice: payload.voice,
                input,
              })
            : await callGroqSpeech({
                apiKey,
                voice: payload.voice,
                input,
              });

        sendJson(response, 200, {
          audio: audioBuffer.toString("base64"),
          mimeType: provider === "openai" ? "audio/mpeg" : "audio/wav",
        });
      })
      .catch((error) => {
        sendJson(response, 500, { error: error.message || "The Groq speech request failed." });
      });
    return;
  }

  const filePath = safeFilePath(request.url);

  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (indexError, indexContent) => {
        if (indexError) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }

        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(indexContent);
      });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "public, max-age=300",
    });
    response.end(content);
  });
});

server.listen(port, () => {
  console.log("CSV Merge to Excel app running on port " + port);
});
