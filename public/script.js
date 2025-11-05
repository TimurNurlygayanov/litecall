// ====== room & role ======
const params = new URLSearchParams(location.search);
const room = params.get("id");
const isHost = location.hash === "#host";

if (!room) {
  location.replace("/");
  throw new Error("No room id");
}

// ====== DOM ======
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");

// ====== State ======
let ws;
let peer;
let localStream;
let queuedSignals = [];
let reconnectAttempts = 0;
let reconnecting = false;

const proto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${proto}://${location.host}/?room=${encodeURIComponent(room)}`;

// ====== Utility ======
function safeSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queuedSignals.push(msg);
    console.log("🕓 queued (ws not ready)");
    return;
  }
  ws.send(msg);
}

function flushQueue() {
  if (ws && ws.readyState === WebSocket.OPEN && queuedSignals.length) {
    console.log(`🚚 flushing ${queuedSignals.length} queued signals`);
    queuedSignals.forEach((m) => ws.send(m));
    queuedSignals = [];
  }
}

// ====== WebSocket setup ======
function initWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    console.log("✅ WS open");
    reconnectAttempts = 0;
    flushQueue();
    if (!peer) initPeer(); // создаём Peer при первом подключении
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (!peer) {
        console.log("⚙️ Recreating peer after reload...");
        initPeer();
      }
      peer.signal(data);
    } catch (err) {
      console.error("WS message parse error:", err);
    }
  });

  ws.addEventListener("close", () => {
    console.warn("⚠️ WS closed, reconnecting...");
    scheduleReconnect();
  });

  ws.addEventListener("error", (e) => {
    console.error("⚠️ WS error:", e);
    scheduleReconnect();
  });
}

// ====== WebSocket reconnect ======
function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  reconnectAttempts++;
  const delay = Math.min(5000, reconnectAttempts * 1000);
  console.log(`🔁 Trying WS reconnect in ${delay / 1000}s...`);
  setTimeout(() => {
    reconnecting = false;
    initWebSocket();
  }, delay);
}

// ====== Peer setup ======
function initPeer() {
  if (peer) {
    try {
      peer.destroy();
    } catch (_) {}
  }

  peer = new SimplePeer({
    initiator: isHost,
    trickle: false,
    config: {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
  });

  if (!localStream) {
    navigator.mediaDevices
      .getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        localStream = stream;
        localVideo.srcObject = stream;
        peer.addStream(stream);
        console.log("🎥 local stream ready");
      })
      .catch((err) => console.error("getUserMedia error:", err));
  } else {
    peer.addStream(localStream);
  }

  peer.on("signal", (data) => {
    const msg = JSON.stringify(data);
    safeSend(msg);
  });

  peer.on("connect", () => {
    console.log("✅ Peer connected!");
  });

  peer.on("stream", (stream) => {
    console.log("🎬 Remote stream received");
    remoteVideo.srcObject = stream;
  });

  peer.on("error", (err) => {
    console.error("❌ Peer error:", err);
    // при разрушении создаём новый Peer, если WS живой
    if (err.message.includes("Abort") || err.message.includes("destroyed")) {
      console.log("♻️ Recreating peer...");
      setTimeout(() => initPeer(), 1500);
    }
  });

  peer.on("close", () => {
    console.warn("🔌 Peer closed");
    // при закрытии тоже пересоздаём
    setTimeout(() => initPeer(), 1500);
  });
}

// ====== Start ======
initWebSocket();

// ====== Fullscreen & Wake Lock ======
document.body.addEventListener("click", async () => {
  try {
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      await document.body.requestFullscreen();
    }
    if ("wakeLock" in navigator) {
      await navigator.wakeLock.request("screen");
    }
  } catch (e) {}
});
