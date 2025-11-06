import express from "express";
import { WebSocketServer } from "ws";
import fs from "fs";
import url from "url";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

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

// Load initial counter
let callCount = loadCounter();
console.log(`📊 Initial call count loaded: ${callCount}`);

// Generate version hash for static assets (for cache busting)
function getAssetVersion(filePath) {
  try {
    const fullPath = path.join(__dirname, "public", filePath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash("md5").update(content).digest("hex").substring(0, 8);
      return hash;
    }
  } catch (err) {
    console.error(`❌ Error generating version for ${filePath}:`, err);
  }
  return Date.now().toString(36); // Fallback to timestamp
}

// Generate versions for main assets
const scriptVersion = getAssetVersion("script.js");
console.log(`📦 Asset version (script.js): ${scriptVersion}`);

// Generate version for images directory (use a single version for all images)
// This will change if any image changes, forcing cache refresh
function getImagesVersion() {
  try {
    const imagesDir = path.join(__dirname, "public", "images");
    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir);
      const hash = crypto.createHash("md5");
      files.sort().forEach(file => {
        const filePath = path.join(imagesDir, file);
        if (fs.statSync(filePath).isFile()) {
          hash.update(fs.readFileSync(filePath));
        }
      });
      return hash.digest("hex").substring(0, 8);
    }
  } catch (err) {
    console.error(`❌ Error generating images version:`, err);
  }
  return Date.now().toString(36); // Fallback to timestamp
}

const imagesVersion = getImagesVersion();
console.log(`📦 Asset version (images): ${imagesVersion}`);

const connections = {}; // roomId -> [clients]
const lastSignals = {}; // roomId -> last offer/answer
const recentCandidates = {}; // roomId -> [recent ICE candidates from host] (for late-joining clients)
const hosts = {}; // roomId -> first client WebSocket (the host)


// Отдаём статические файлы из public/ с кэшированием
// Set cache headers for static assets (JS, images, etc.)
app.use(express.static("public", {
  maxAge: "1y", // Cache for 1 year
  etag: true, // Enable ETags for cache validation
  lastModified: true, // Send Last-Modified header
  setHeaders: (res, path) => {
    // Set aggressive caching for JS and image files
    if (path.match(/\.(js|png|svg|jpg|jpeg|gif|webp|ico)$/)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // 1 year, immutable
    }
    // HTML files should not be cached (always get fresh version)
    if (path.match(/\.html$/)) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

// ✅ Фикс: поддержка прямого перехода на /room?id=...
app.get("/room", (req, res) => {
  const id = req.query.id;
  if (!id) {
    // если id отсутствует — просто редирект на главную
    return res.redirect("/");
  }
  // Read room.html and inject version into script.js and image references
  const roomHtmlPath = path.join(__dirname, "public", "room.html");
  let roomHtml = fs.readFileSync(roomHtmlPath, "utf8");
  // Replace script.js with versioned version
  roomHtml = roomHtml.replace(
    /src="script\.js"/g,
    `src="script.js?v=${scriptVersion}"`
  );
  // Replace image references with versioned versions
  roomHtml = roomHtml.replace(
    /src="\/images\/([^"]+)"/g,
    `src="/images/$1?v=${imagesVersion}"`
  );
  res.setHeader("Content-Type", "text/html");
  res.send(roomHtml);
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

// Validate room ID pattern (alphanumeric, 1-20 chars)
const ROOM_ID_PATTERN = /^[a-z0-9]{1,20}$/i;

wss.on("connection", (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const roomId = parsedUrl.query.room;

  // Validate room ID
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) {
    console.warn(`❌ Invalid room ID: ${roomId}`);
    ws.close(1008, "Invalid room ID");
    return;
  }

  if (!connections[roomId]) connections[roomId] = [];
  const isFirst = connections[roomId].length === 0;
  
  // Track the first client (host) for this room
  if (isFirst) {
    hosts[roomId] = ws;
    console.log(`👑 Host assigned for room "${roomId}"`);
  }
  
  connections[roomId].push(ws);

  console.log(`👥 Client joined room "${roomId}" (${connections[roomId].length} total)`);

  // Increment counter when second person joins (call is established)
  if (connections[roomId].length === 2) {
    callCount++;
    saveCounter(callCount);
    console.log(`📈 Call count incremented: ${callCount}`);
  }

  // Send room info to ALL clients in the room (notify them of the new connection)
  const roomClients = connections[roomId];
  const roomInfo = {
    type: "room-info",
    roomId: roomId,
    isFirst: isFirst,
    totalClients: roomClients.length
  };
  
  // Send to the new client
  ws.send(JSON.stringify(roomInfo));
  
  // Also notify existing clients that a new client joined (for reconnection handling)
  if (roomClients.length > 1) {
    console.log(`📢 Notifying ${roomClients.length - 1} existing clients about new connection`);
    const hostWs = hosts[roomId]; // Get the host WebSocket for this room
    roomClients.forEach(client => {
      if (client !== ws && client.readyState === 1) {
        try {
          // Check if this client is the host - preserve their role
          const isClientHost = (hostWs === client);
          client.send(JSON.stringify({
            type: "room-info",
            roomId: roomId,
            isFirst: isClientHost, // Preserve host role - host stays host, others stay clients
            totalClients: roomClients.length,
            newClientJoined: true // Flag to indicate a new client just joined
          }));
          console.log(`📤 Notified ${isClientHost ? 'host' : 'client'} about new connection`);
        } catch (err) {
          console.error("❌ Error notifying existing client:", err);
        }
      }
    });
  }

  // If this room already has stored signal — send it to the newcomer
  if (lastSignals[roomId]) {
    console.log(`📤 Sending stored signal (${lastSignals[roomId].type}) to new peer in room ${roomId}`);
    ws.send(JSON.stringify(lastSignals[roomId]));
    
    // Also send any stored ICE candidates from the host (for late-joining clients)
    // This fixes the race condition where host sends candidates before client joins
    if (recentCandidates[roomId] && recentCandidates[roomId].length > 0) {
      console.log(`📤 Sending ${recentCandidates[roomId].length} stored candidates to new client in room ${roomId}`);
      // Send candidates with a small delay to ensure offer is processed first
      setTimeout(() => {
        recentCandidates[roomId].forEach((candidate, index) => {
          try {
            ws.send(JSON.stringify(candidate));
            console.log(`📤 Sent stored candidate ${index + 1}/${recentCandidates[roomId].length} to new client`);
          } catch (err) {
            console.error(`❌ Error sending stored candidate:`, err);
          }
        });
      }, 100); // Small delay to ensure offer is processed first
    }
  }

  ws.on("message", (msg) => {
    try {
      // Always convert to string explicitly
      const messageText = Buffer.isBuffer(msg) ? msg.toString() : msg.toString();
      
      // Limit message size (prevent abuse)
      if (messageText.length > 10000) {
        console.warn(`❌ Message too large from room ${roomId}: ${messageText.length} bytes`);
        ws.close(1009, "Message too large");
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(messageText);
      } catch (err) {
        console.error("❌ Invalid JSON in message:", err);
        return;
      }

      // Validate message structure
      if (!parsed || typeof parsed !== "object") {
        console.warn("❌ Invalid message structure");
        return;
      }

      // Only store offers (not answers) - answers are only for relaying
      // When a client reconnects, they need the offer from the host, not their previous answer
      if (parsed.type === "offer") {
        lastSignals[roomId] = parsed;
        // Clear old candidates when a new offer is generated
        recentCandidates[roomId] = [];
        console.log(`💾 Stored offer for room ${roomId}`);
      }
      
      // Store recent ICE candidates from the host (for late-joining clients)
      // Only store candidates from the host (first client), not from clients
      if (parsed.type === "candidate" && hosts[roomId] === ws) {
        if (!recentCandidates[roomId]) {
          recentCandidates[roomId] = [];
        }
        // Keep only the last 20 candidates to avoid memory issues
        recentCandidates[roomId].push(parsed);
        if (recentCandidates[roomId].length > 20) {
          recentCandidates[roomId].shift(); // Remove oldest
        }
        console.log(`💾 Stored candidate from host for room ${roomId} (${recentCandidates[roomId].length} total)`);
      }
      
      // Answers are relayed but not stored - they're only valid for the current connection

      // Relay to other peers
      const roomClients = connections[roomId];
      if (!roomClients) {
        console.warn(`❌ Room ${roomId} no longer exists`);
        return;
      }

      for (const client of roomClients) {
        if (client !== ws && client.readyState === 1) {
          try {
            client.send(JSON.stringify(parsed)); // ✅ always send as string
          } catch (err) {
            console.error("❌ Error sending message to client:", err);
          }
        }
      }
    } catch (err) {
      console.error("❌ Error processing message:", err);
    }
  });

  ws.on("close", () => {
    const wasHost = hosts[roomId] === ws;
    connections[roomId] = connections[roomId].filter((c) => c !== ws);
    
    // IMPORTANT: Clear stored signals when a client disconnects to prevent stale offers/answers
    // When they reconnect, the host will generate a fresh offer
    if (wasHost) {
      // If host disconnected, clear stored signals (host will generate new offer when reconnecting client joins)
      delete lastSignals[roomId];
      delete recentCandidates[roomId];
      console.log(`🧹 Cleared stored signals and candidates for room "${roomId}" (host disconnected)`);
    } else {
      // If client disconnected, also clear stored signals so reconnecting client gets fresh offer from host
      delete lastSignals[roomId];
      delete recentCandidates[roomId];
      console.log(`🧹 Cleared stored signals and candidates for room "${roomId}" (client disconnected - will get fresh offer on reconnect)`);
    }
    
    if (connections[roomId].length === 0) {
      delete connections[roomId];
      delete hosts[roomId]; // Clean up host tracking when room is empty
    } else {
      // If the host disconnected, we need to reassign a new host (the first remaining client)
      if (wasHost) {
        const remainingClients = connections[roomId];
        if (remainingClients.length > 0) {
          hosts[roomId] = remainingClients[0]; // First remaining client becomes host
          console.log(`👑 Host reassigned for room "${roomId}" (original host disconnected)`);
        } else {
          delete hosts[roomId];
        }
      }
    }
    console.log(`❌ Client left room "${roomId}"`);
  });
});
