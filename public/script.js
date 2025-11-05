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

// ====== WS state ======
let ws;
let peer;
let queuedSignals = [];
let reconnectAttempts = 0;
let wsConnectedOnce = false;

const proto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${proto}://${location.host}/?room=${encodeURIComponent(room)}`;

// безопасная отправка
function safeSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queuedSignals.push(msg);
    console.log("🕓 queued signal (ws not ready)");
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

// ====== WebSocket init ======
function initWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    console.log("✅ WebSocket OPEN");
    reconnectAttempts = 0;
    wsConnectedOnce = true;
    if (!peer) initPeer();
    flushQueue();
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (peer) peer.signal(data);
    } catch (e) {
      console.error("WS message parse error:", e);
    }
  });

  ws.addEventListener("error", (e) => {
    console.error("⚠️ WS error:", e.message);
  });

  ws.addEventListener("close", (e) => {
    console.warn(`❌ WS closed (code ${e.code})`);
    attemptReconnect();
  });
}

// ====== Reconnect logic ======
function attemptReconnect() {
  reconnectAttempts++;
  const delay = Math.min(5000, 1000 * reconnectAttempts);
  console.log(`🔁 Reconnecting in ${delay / 1000}s...`);
  setTimeout(() => {
    console.log("🔄 Reconnecting now...");
    initWebSocket();
  }, delay);
}

// ====== Peer ======
function initPeer() {
  peer = new SimplePeer({
    initiator: isHost,
    trickle: false,
    config: {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
  });

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
      localVideo.srcObject = stream;
      peer.addStream(stream);
      console.log("🎥 local stream added");
    })
    .catch((err) => console.error("getUserMedia error:", err));

  peer.on("signal", (data) => {
    const msg = JSON.stringify(data);
    safeSend(msg);
  });

  peer.on("connect", () => {
    console.log("✅ Peer CONNECTED");
  });

  peer.on("stream", (stream) => {
    console.log("🎬 remote stream received");
    remoteVideo.srcObject = stream;
  });

  peer.on("error", (err) => {
    console.error("❌ Peer error:", err);
  });

  peer.on("close", () => {
    console.warn("🔌 Peer closed");
  });
}

// ====== Start ======
initWebSocket();

// ====== UX: fullscreen & wake lock ======
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
