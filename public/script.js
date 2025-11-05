const params = new URLSearchParams(location.search);
const room = params.get("id");
const isHost = location.hash === "#host";

const ws = new WebSocket(`${location.origin.replace("http", "ws")}/?room=${room}`);
const peer = new SimplePeer({ initiator: isHost, trickle: false });

const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");

navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
}).then(stream => {
  localVideo.srcObject = stream;
  peer.addStream(stream);
});

peer.on("signal", data => ws.send(JSON.stringify(data)));
ws.onmessage = e => peer.signal(JSON.parse(e.data));
peer.on("stream", stream => remoteVideo.srcObject = stream);

// Полноэкран + защита от сна
document.body.addEventListener("click", async () => {
  if (document.fullscreenEnabled) await document.body.requestFullscreen();
  if ("wakeLock" in navigator) await navigator.wakeLock.request("screen");
});

