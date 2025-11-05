// Получаем параметры комнаты и роль
const params = new URLSearchParams(location.search);
const room = params.get("id");
const isHost = location.hash === "#host";

// Создаём WebSocket-соединение
const ws = new WebSocket(`${location.origin.replace("http", "ws")}/?room=${room}`);

// Настраиваем WebRTC peer
const peer = new SimplePeer({
  initiator: isHost,
  trickle: false,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" } // STUN-сервер для обхода NAT
    ]
  }
});

const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");

let wsReady = false;
let queuedSignals = [];

// Когда WebSocket готов
ws.onopen = () => {
  console.log("✅ WebSocket connected");
  wsReady = true;

  // Отправляем все сигналы, которые накопились до подключения
  queuedSignals.forEach((s) => ws.send(s));
  queuedSignals = [];
};

// Если соединение закрыто
ws.onclose = () => {
  console.log("⚠️ WebSocket closed");
  wsReady = false;
};

// Если пришло сообщение по WebSocket
ws.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    console.log("📩 Signal received from remote peer");
    peer.signal(data);
  } catch (e) {
    console.error("Ошибка обработки сигнала:", e);
  }
};

// Когда peer готов отправлять свой сигнал
peer.on("signal", (data) => {
  const message = JSON.stringify(data);
  if (wsReady) {
    ws.send(message);
    console.log("📨 Sent local signal");
  } else {
    queuedSignals.push(message);
    console.log("🕓 Queued signal until WS is ready");
  }
});

// Получаем доступ к камере и микрофону
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
    console.log("🎥 Local stream added");
  })
  .catch((err) => console.error("Не удалось получить доступ к камере/микрофону:", err));

// Когда установлено P2P-соединение
peer.on("connect", () => {
  console.log("✅ Peer connected!");
});

// Когда пришёл поток от собеседника
peer.on("stream", (stream) => {
  console.log("🎬 Remote stream received!");
  remoteVideo.srcObject = stream;
});

// Ошибки WebRTC
peer.on("error", (err) => {
  console.error("❌ Peer error:", err);
});

peer.on("close", () => {
  console.log("🔌 Peer connection closed");
});

// Для полноэкранного режима и предотвращения засыпания экрана
document.body.addEventListener("click", async () => {
  try {
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      await document.body.requestFullscreen();
    }
    if ("wakeLock" in navigator) {
      await navigator.wakeLock.request("screen");
    }
  } catch (e) {
    console.warn("Не удалось активировать fullscreen или wake lock:", e);
  }
});
