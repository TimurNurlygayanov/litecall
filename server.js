import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import url from "url";

const app = express();
const PORT = process.env.PORT || 3000;
const callsFile = "./calls.json";

if (!fs.existsSync(callsFile)) {
  fs.writeFileSync(callsFile, JSON.stringify({ successful: 0 }));
}

let connections = {}; // roomId -> [clients]

app.use(express.static("public"));

// API для получения статистики
app.get("/stats", (req, res) => {
  const data = JSON.parse(fs.readFileSync(callsFile));
  res.json(data);
});

const server = app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);

// WebSocket signaling server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // безопасно разбираем query-параметры независимо от домена
  const parsedUrl = url.parse(req.url, true);
  const roomId = parsedUrl.query.room;

  if (!roomId) {
    console.warn("⚠️ Connection without room ID, closing...");
    ws.close();
    return;
  }

  if (!connections[roomId]) connections[roomId] = [];
  connections[roomId].push(ws);

  console.log(`👥 Client joined room "${roomId}" (${connections[roomId].length} total)`);

  // Считаем успешный звонок, когда в комнате 2 клиента
  if (connections[roomId].length === 2) {
    const data = JSON.parse(fs.readFileSync(callsFile));
    data.successful += 1;
    fs.writeFileSync(callsFile, JSON.stringify(data));
    console.log(`📈 Successful calls: ${data.successful}`);
  }

  // Пересылаем сигналы между участниками
  ws.on("message", (msg) => {
    for (const client of connections[roomId]) {
      if (client !== ws && client.readyState === 1) {
        client.send(msg);
      }
    }
  });

  ws.on("close", () => {
    connections[roomId] = connections[roomId].filter((c) => c !== ws);
    if (connections[roomId].length === 0) {
      delete connections[roomId];
    }
    console.log(`❌ Client left room "${roomId}"`);
  });
});
