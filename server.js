import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import url from "url";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const callsFile = "./calls.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Если файла со счётчиком нет — создаём
if (!fs.existsSync(callsFile)) {
  fs.writeFileSync(callsFile, JSON.stringify({ successful: 0 }));
}

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
  const data = JSON.parse(fs.readFileSync(callsFile));
  res.json(data);
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
  connections[roomId].push(ws);

  console.log(`👥 Client joined room "${roomId}" (${connections[roomId].length} total)`);

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
