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

let connections = {}; // roomId -> [clients]

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
  // === Определяем комнату ===
  const parsedUrl = url.parse(req.url, true);
  const roomId = parsedUrl.query.room;

  if (!roomId) {
    console.warn("⚠️ Client connected without room ID, closing...");
    ws.close();
    return;
  }

  if (!connections[roomId]) connections[roomId] = [];
  connections[roomId].push(ws);
  console.log(`👥 Client joined room "${roomId}" (${connections[roomId].length} total)`);

  // === Увеличиваем счётчик успешных звонков ===
  if (connections[roomId].length === 2) {
    try {
      const data = JSON.parse(fs.readFileSync(callsFile, "utf8"));
      data.successful += 1;
      fs.writeFileSync(callsFile, JSON.stringify(data));
      console.log(`📈 Successful calls: ${data.successful}`);
    } catch (e) {
      console.error("❌ Failed to update call counter:", e);
    }
  }

  // === Пересылка сигналов ===
  ws.on("message", (msg) => {
    const text = typeof msg === "string" ? msg : msg.toString();

    // Проверяем что это JSON
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn("⚠️ Non-JSON WS message, skipping:", text.slice(0, 60));
      return;
    }

    // Проверяем тип сигнала
    if (!parsed.type && !parsed.candidate) {
      console.warn("⚠️ Unknown message structure:", parsed);
      return;
    }

    console.log(`📡 signal relayed in room "${roomId}" → ${parsed.type || "candidate"}`);

    // Отправляем всем, кроме отправителя
    for (const client of connections[roomId]) {
      if (client !== ws && client.readyState === 1) {
        client.send(JSON.stringify(parsed));
      }
    }
  });

  // === Очистка при отключении ===
  ws.on("close", () => {
    connections[roomId] = connections[roomId].filter((c) => c !== ws);
    if (connections[roomId].length === 0) delete connections[roomId];
    console.log(`❌ Client left room "${roomId}"`);
  });
});
