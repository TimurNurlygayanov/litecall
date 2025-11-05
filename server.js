import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import url from "url";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use persistent data directory (defaults to /data for persistent storage)
// Can be overridden via DATA_DIR environment variable
const dataDir = process.env.DATA_DIR || "/data";
const callsFile = path.join(dataDir, "calls.json");

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`📁 Created data directory: ${dataDir}`);
} else {
  console.log(`📁 Using persistent data directory: ${dataDir}`);
}

// Initialize counter file if it doesn't exist
function loadCounter() {
  try {
    if (fs.existsSync(callsFile)) {
      const data = JSON.parse(fs.readFileSync(callsFile, "utf8"));
      return data.successful || 0;
    }
  } catch (err) {
    console.error("❌ Error reading counter file:", err);
  }
  return 0;
}

function saveCounter(count) {
  try {
    fs.writeFileSync(callsFile, JSON.stringify({ successful: count }), "utf8");
    console.log(`💾 Counter saved: ${count}`);
  } catch (err) {
    console.error("❌ Error saving counter:", err);
  }
}

// Migrate old counter file if it exists
const oldCallsFile = path.join(__dirname, "calls.json");
if (fs.existsSync(oldCallsFile) && !fs.existsSync(callsFile)) {
  try {
    const oldData = JSON.parse(fs.readFileSync(oldCallsFile, "utf8"));
    const oldCount = oldData.successful || 0;
    if (oldCount > 0) {
      saveCounter(oldCount);
      console.log(`🔄 Migrated counter from old file: ${oldCount}`);
      // Optionally remove old file after migration
      // fs.unlinkSync(oldCallsFile);
    }
  } catch (err) {
    console.error("❌ Error migrating old counter:", err);
  }
}

// Load initial counter
let callCount = loadCounter();
console.log(`📊 Initial call count loaded: ${callCount}`);

const connections = {}; // roomId -> [clients]
const lastSignals = {}; // roomId -> last offer/answer


// Отдаём статические файлы из public/
app.use(express.static("public"));

// ✅ Фикс: поддержка прямого перехода на /room?id=...
app.get("/room", (req, res) => {
  const id = req.query.id;
  if (!id) {
    // если id отсутствует — просто редирект на главную
    return res.redirect("/");
  }
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

// API для статистики звонков
app.get("/stats", (req, res) => {
  try {
    const count = loadCounter();
    res.json({ successful: count });
  } catch (err) {
    console.error("❌ Error reading stats:", err);
    res.json({ successful: callCount });
  }
});

// Запускаем HTTP-сервер
const server = app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);

// Создаём WebSocket-сервер на базе HTTP
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const roomId = parsedUrl.query.room;

  if (!roomId) {
    ws.close();
    return;
  }

  if (!connections[roomId]) connections[roomId] = [];
  const isFirst = connections[roomId].length === 0;
  connections[roomId].push(ws);

  console.log(`👥 Client joined room "${roomId}" (${connections[roomId].length} total)`);

  // Increment counter when second person joins (call is established)
  if (connections[roomId].length === 2) {
    callCount++;
    saveCounter(callCount);
    console.log(`📈 Call count incremented: ${callCount}`);
  }

  // Send room info to the new client
  ws.send(JSON.stringify({
    type: "room-info",
    roomId: roomId,
    isFirst: isFirst,
    totalClients: connections[roomId].length
  }));

  // If this room already has stored signal — send it to the newcomer
  if (lastSignals[roomId]) {
    console.log(`📤 Sending stored signal to new peer in room ${roomId}`);
    ws.send(JSON.stringify(lastSignals[roomId]));
  }

  ws.on("message", (msg) => {
      // Always convert to string explicitly
      const messageText = Buffer.isBuffer(msg) ? msg.toString() : msg.toString();

      let parsed;
      try {
        parsed = JSON.parse(messageText);
      } catch (err) {
        console.error("❌ Invalid JSON in message:", err, messageText);
        return;
      }

      // store last offer/answer
      if (parsed.type === "offer" || parsed.type === "answer") {
        lastSignals[roomId] = parsed;
      }

      // Relay to other peers
      for (const client of connections[roomId]) {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(parsed)); // ✅ always send as string
        }
      }
    });

  ws.on("close", () => {
    connections[roomId] = connections[roomId].filter((c) => c !== ws);
    if (connections[roomId].length === 0) {
      delete connections[roomId];
      delete lastSignals[roomId];
    }
    console.log(`❌ Client left room "${roomId}"`);
  });
});
