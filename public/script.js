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
let queuedSignals = []; // outgoing signals
let queuedIncomingSignals = []; // incoming signals waiting for peer
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
        console.log("🕓 Incoming signal queued (peer not ready yet):", data.type || "candidate");
        queuedIncomingSignals.push(data);
        // Start peer creation if not already in progress
        if (!localStream) {
          console.log("⚙️ Creating peer to process queued signals...");
          initPeer();
        }
        return;
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

  // Get or reuse stream FIRST, then create peer connection
  if (!localStream) {
    console.log("🎥 Requesting media stream...");
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
        console.log("🎥 Local stream ready, creating peer connection...");
        createPeerConnection(stream);
      })
      .catch((err) => {
        console.error("getUserMedia error:", err);
      });
  } else {
    console.log("🎥 Reusing existing stream, creating peer connection...");
    createPeerConnection(localStream);
  }
}

function createPeerConnection(stream) {
  // Create peer connection
  peer = new SimplePeer({
    initiator: isHost,
    trickle: false,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        {
          urls: "turn:relay1.expressturn.com:3478",
          username: "ef-test",
          credential: "ef-test"
        }
      ]
    },
  });

  console.log("🔧 New peer created. Initiator =", isHost);

  // Set up ALL event handlers FIRST, before adding stream or processing signals
  peer.on("signal", (data) => {
      const msg = JSON.stringify(data);
      console.log("📤 Sending signal:", data.type);
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

  peer.on("iceStateChange", (state) => console.log("🧊 ICE state:", state));
  peer.on("iceConnectionStateChange", (state) => console.log("🧊 ICE conn:", state));

  // Add stream after all handlers are set up
  peer.addStream(stream);
  console.log("📹 Stream added to peer connection");

  // Process any queued incoming signals after peer is fully initialized
  // Use Promise.resolve().then() to ensure it happens after current execution context
  if (queuedIncomingSignals.length > 0) {
    console.log(`🚚 Processing ${queuedIncomingSignals.length} queued incoming signals...`);
    Promise.resolve().then(() => {
      // Process signals in order
      const signalsToProcess = [...queuedIncomingSignals];
      queuedIncomingSignals = [];
      signalsToProcess.forEach((signal) => {
        try {
          console.log("📥 Processing queued signal:", signal.type || "candidate");
          peer.signal(signal);
        } catch (err) {
          console.error("Error processing queued signal:", err);
        }
      });
    });
  }
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


// ====== Controls ======
const btnMute = document.getElementById("btn-mute");
const btnCamera = document.getElementById("btn-camera");
const btnLeave = document.getElementById("btn-leave");

let isMuted = false;
let isCameraOff = false;

btnMute.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => (track.enabled = !isMuted));
  btnMute.textContent = isMuted ? "🔇" : "🎤";
  console.log(isMuted ? "🔇 Mic muted" : "🎤 Mic unmuted");
});

btnCamera.addEventListener("click", () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(track => (track.enabled = !isCameraOff));
  btnCamera.textContent = isCameraOff ? "📷" : "🎥";
  console.log(isCameraOff ? "📷 Camera off" : "🎥 Camera on");
});

btnLeave.addEventListener("click", () => {
  console.log("👋 Disconnecting...");
  if (peer) peer.destroy();
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  window.close(); // закрывает вкладку, если разрешено
  setTimeout(() => (location.href = "/"), 500); // fallback
});
