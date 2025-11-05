import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const callsFile = "./calls.json";

if (!fs.existsSync(callsFile)) fs.writeFileSync(callsFile, JSON.stringify({ successful: 0 }));

let connections = {}; // roomId -> [clients]

app.use(express.static("public"));

// Отдаём количество успешных звонков
app.get("/stats", (req, res) => {
  const data = JSON.parse(fs.readFileSync(callsFile));
  res.json(data);
});

const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// WebSocket signaling server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const roomId = new URL(req.url, "http://localhost").searchParams.get("room");
  if (!connections[roomId]) connections[roomId] = [];
  connections[roomId].push(ws);

  console.log(`Client joined room ${roomId} (${connections[roomId].length})`);

  if (connections[roomId].length === 2) {
    const data = JSON.parse(fs.readFileSync(callsFile));
    data.successful += 1;
    fs.writeFileSync(callsFile, JSON.stringify(data));
  }

  ws.on("message", (msg) => {
    for (const client of connections[roomId]) {
      if (client !== ws && client.readyState === 1) client.send(msg);
    }
  });

  ws.on("close", () => {
    connections[roomId] = connections[roomId].filter(c => c !== ws);
  });
});

