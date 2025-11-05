// ====== room & role ======
const params = new URLSearchParams(location.search);
const room = params.get("id");

if (!room) {
  location.replace("/");
  throw new Error("No room id");
}

// ====== DOM ======
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");
const waitingScreen = document.getElementById("waiting-screen");
const meetingLinkInput = document.getElementById("meeting-link");
const copyLinkBtn = document.getElementById("copy-link-btn");

// ====== Dynamic role assignment ======
let isHost = false; // Will be set dynamically based on who joins first

// ====== State ======
let ws;
let peer;
let localStream;
let queuedSignals = []; // outgoing signals
let queuedIncomingSignals = []; // incoming signals waiting for peer
let reconnectAttempts = 0;
let reconnecting = false;
let isRecreatingPeer = false; // prevent multiple simultaneous recreations
let hasConnected = false; // track if we've ever successfully connected

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
    // Wait for room-info message to determine if we're host before creating peer
    // The room-info will be sent immediately by the server
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle room-info message from server
      if (data.type === "room-info") {
        isHost = data.isFirst;
        console.log(`📋 Room info: isFirst=${data.isFirst}, totalClients=${data.totalClients}`);
        console.log(`👤 Role: ${isHost ? "Host" : "Client"}`);
        
        // If client joins and host is already active (totalClients > 1), hide waiting screen immediately
        if (!isHost && data.totalClients > 1 && waitingScreen) {
          console.log("👥 Host already active, hiding waiting screen...");
          waitingScreen.classList.add("hidden");
          // Ensure controls are visible
          const controls = document.getElementById("controls");
          if (controls) {
            controls.style.display = "flex";
          }
        }
        
        // Start creating peer connection
        // Host creates peer immediately, client creates peer when they receive room-info
        if (!peer && !localStream) {
          console.log(`⚙️ ${isHost ? "Host" : "Client"} detected, starting peer setup...`);
          initPeer();
        }
        return;
      }
      
      // Handle WebRTC signals
      if (!peer) {
        console.log("🕓 Incoming signal queued (peer not ready yet):", data.type || "candidate");
        queuedIncomingSignals.push(data);
        // Start peer creation if not already in progress
        // Important: check if we're currently getting media (localStream being set)
        // If localStream exists but peer doesn't, we still need to create peer
        if (!localStream) {
          console.log("⚙️ Creating peer to process queued signals...");
          initPeer();
        } else {
          // Stream exists but peer doesn't - create peer immediately
          console.log("⚙️ Stream exists but peer missing, creating peer...");
          createPeerConnection(localStream);
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
    peer = null;
  }
  isRecreatingPeer = false; // Reset flag when starting new peer
  hasConnected = false; // Reset connection status for new peer

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
      .then(async (stream) => {
        localStream = stream;
        localVideo.srcObject = stream;
        console.log("🎥 Local stream ready, creating peer connection...");
        
        // Enumerate available cameras after getting permission (required for labels)
        // Wait a bit for permissions to propagate
        setTimeout(async () => {
          availableCameras = await getAvailableCameras();
          if (availableCameras.length > 1 && btnSwitchCamera) {
            btnSwitchCamera.style.display = "block";
            console.log(`📹 Found ${availableCameras.length} cameras`);
          }
        }, 500);
        
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
    trickle: true,
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
    hasConnected = true; // Mark that we've successfully connected
  });

  peer.on("stream", (stream) => {
    console.log("🎬 Remote stream received");
    
    // Ensure controls are visible immediately
    const controls = document.getElementById("controls");
    if (controls) {
      controls.style.display = "flex";
      controls.style.visibility = "visible";
    }
    
    // Set the stream to video element
    remoteVideo.srcObject = stream;
    
    // Ensure video plays with audio
    remoteVideo.muted = false;
    remoteVideo.play().catch(err => {
      console.error("Error playing remote video:", err);
    });
    
    // Wait for video to actually start playing before hiding waiting screen
    // This prevents the black flash between waiting screen and video
    const handleVideoPlaying = () => {
      // Mark video as playing to change background
      remoteVideo.classList.add("playing");
      
      // Hide waiting screen once video is actually playing
      if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
        setTimeout(() => {
          waitingScreen.classList.add("hidden");
        }, 200);
      }
      remoteVideo.removeEventListener("playing", handleVideoPlaying);
      remoteVideo.removeEventListener("loadedmetadata", handleVideoPlaying);
    };
    
    // Listen for when video actually starts playing
    if (remoteVideo.readyState >= 3) {
      // Video is already playing or about to play
      handleVideoPlaying();
    } else {
      remoteVideo.addEventListener("playing", handleVideoPlaying);
      remoteVideo.addEventListener("loadedmetadata", handleVideoPlaying);
    }
  });

  peer.on("error", (err) => {
    console.error("❌ Peer error:", err);
    // Handle connection failures - recreate peer
    if (err.message.includes("Abort") || 
        err.message.includes("destroyed") || 
        err.message.includes("Connection failed")) {
      console.log("♻️ Recreating peer due to error...");
      if (!isRecreatingPeer && ws && ws.readyState === WebSocket.OPEN) {
        isRecreatingPeer = true;
        setTimeout(() => {
          isRecreatingPeer = false;
          initPeer();
        }, 500);
      }
    }
  });

  peer.on("close", () => {
    console.warn("🔌 Peer closed");
    // Only recreate if we're still connected via WebSocket
    if (!isRecreatingPeer && ws && ws.readyState === WebSocket.OPEN) {
      isRecreatingPeer = true;
      setTimeout(() => {
        isRecreatingPeer = false;
        initPeer();
      }, 1000);
    }
  });

  peer.on("iceStateChange", (state) => {
    console.log("🧊 ICE state:", state);
  });
  
  peer.on("iceConnectionStateChange", (state) => {
    console.log("🧊 ICE conn:", state);
    
    // Handle successful connection
    if (state === "connected" || state === "completed") {
      hasConnected = true;
      return;
    }
    
    // Only recreate on "failed" state - never on "disconnected"
    // "disconnected" is a normal intermediate state during connection establishment
    // and should be allowed to recover naturally
    if (state === "failed" && !isRecreatingPeer && !hasConnected) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`♻️ ICE connection failed, recreating peer...`);
        isRecreatingPeer = true;
        setTimeout(() => {
          isRecreatingPeer = false;
          initPeer();
        }, 500);
      }
    }
    // Note: We intentionally do NOT handle "disconnected" state
    // It's a normal intermediate state and should recover on its own
  });

  // Add stream after all handlers are set up
  peer.addStream(stream);
  console.log("📹 Stream added to peer connection");

  // Process any queued incoming signals IMMEDIATELY and SYNCHRONOUSLY
  // This is critical - signals must be processed right away, not async
  if (queuedIncomingSignals.length > 0) {
    console.log(`🚚 Processing ${queuedIncomingSignals.length} queued incoming signals immediately...`);
    // Process signals synchronously, in order
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
  }
}

// ====== Waiting Screen Setup ======
if (meetingLinkInput) {
  const meetingUrl = `${window.location.origin}/room?id=${room}`;
  meetingLinkInput.value = meetingUrl;
}

if (copyLinkBtn && meetingLinkInput) {
  copyLinkBtn.addEventListener("click", async (e) => {
    e.stopPropagation(); // Prevent triggering fullscreen
    try {
      await navigator.clipboard.writeText(meetingLinkInput.value);
      copyLinkBtn.textContent = "Copied!";
      copyLinkBtn.classList.add("copied");
      setTimeout(() => {
        copyLinkBtn.textContent = "Copy";
        copyLinkBtn.classList.remove("copied");
      }, 2000);
    } catch (err) {
      // Fallback for older browsers
      meetingLinkInput.select();
      document.execCommand("copy");
      copyLinkBtn.textContent = "Copied!";
      copyLinkBtn.classList.add("copied");
      setTimeout(() => {
        copyLinkBtn.textContent = "Copy";
        copyLinkBtn.classList.remove("copied");
      }, 2000);
    }
  });
  
  // Also prevent fullscreen on input click
  meetingLinkInput.addEventListener("click", (e) => {
    e.stopPropagation();
  });
}

// ====== Camera Management ======
let availableCameras = [];
let currentCameraIndex = 0;

async function getAvailableCameras() {
  try {
    // Enumerate devices - this requires camera permission to get labels
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(device => device.kind === 'videoinput');
    
    // If we have device labels, we have permission
    if (cameras.length > 0 && cameras[0].label) {
      return cameras;
    }
    
    // If no labels, we might not have permission yet
    // Return empty array and permission will be requested when switching
    return cameras;
  } catch (err) {
    console.error("Error enumerating cameras:", err);
    return [];
  }
}

async function switchCamera() {
  if (!localStream) return;
  
  try {
    // Re-enumerate cameras to ensure we have the latest list with labels
    // This should work without asking for permission again since we already have camera access
    const cameras = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = cameras.filter(device => device.kind === 'videoinput');
    
    if (videoInputs.length < 2) {
      console.log("📹 Only one camera available");
      return;
    }
    
    // Update available cameras list
    availableCameras = videoInputs;
    
    // Get current camera ID
    const currentTrack = localStream.getVideoTracks()[0];
    const currentSettings = currentTrack.getSettings();
    const currentCameraId = currentSettings.deviceId;
    
    // Find current camera index
    const currentIndex = availableCameras.findIndex(cam => cam.deviceId === currentCameraId);
    
    // Switch to next camera
    const nextIndex = (currentIndex + 1) % availableCameras.length;
    const newCameraId = availableCameras[nextIndex].deviceId;
    
    console.log(`📹 Switching from camera ${currentIndex + 1} to ${nextIndex + 1}`);
    
    // Get new stream with selected camera
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        deviceId: { exact: newCameraId },
        width: { ideal: 1280 }, 
        height: { ideal: 720 } 
      },
      audio: false, // Keep existing audio track
    });
    
    // Replace video track in the existing stream
    const newVideoTrack = newStream.getVideoTracks()[0];
    const oldVideoTrack = localStream.getVideoTracks()[0];
    
    // Use replaceTrack to update the peer connection
    if (peer && peer._pc) {
      const sender = peer._pc.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
    }
    
    // Replace track in local stream
    localStream.removeTrack(oldVideoTrack);
    localStream.addTrack(newVideoTrack);
    oldVideoTrack.stop();
    
    // Stop the temporary stream (we only needed the track)
    newStream.getVideoTracks().forEach(track => {
      if (track !== newVideoTrack) track.stop();
    });
    
    // Update current camera index
    currentCameraIndex = nextIndex;
    
    console.log(`📹 Switched to camera: ${availableCameras[nextIndex].label || 'Camera ' + (nextIndex + 1)}`);
  } catch (err) {
    console.error("Error switching camera:", err);
    // If switching fails, try to re-enumerate and show button if cameras are available
    setTimeout(async () => {
      const cameras = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = cameras.filter(device => device.kind === 'videoinput');
      if (videoInputs.length > 1 && btnSwitchCamera) {
        availableCameras = videoInputs;
        btnSwitchCamera.style.display = "block";
      }
    }, 1000);
  }
}

// ====== Start ======
initWebSocket();


// ====== Controls ======
const btnMute = document.getElementById("btn-mute");
const btnCamera = document.getElementById("btn-camera");
const btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnLeave = document.getElementById("btn-leave");

let isMuted = false;
let isCameraOff = false;

btnMute.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => (track.enabled = !isMuted));
  const micIcon = document.getElementById("mic-icon");
  if (micIcon) {
    micIcon.src = isMuted ? "/images/mic-off.svg" : "/images/mic-on.svg";
  }
  console.log(isMuted ? "🔇 Mic muted" : "🎤 Mic unmuted");
});

btnCamera.addEventListener("click", () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(track => (track.enabled = !isCameraOff));
  const cameraIcon = document.getElementById("camera-icon");
  if (cameraIcon) {
    cameraIcon.src = isCameraOff ? "/images/camera-off.svg" : "/images/camera-on.png";
  }
  console.log(isCameraOff ? "📷 Camera off" : "🎥 Camera on");
});

btnSwitchCamera.addEventListener("click", async (e) => {
  e.stopPropagation(); // Prevent triggering other click handlers
  await switchCamera();
});

btnFullscreen.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      btnFullscreen.textContent = "⛶";
    } else {
      await document.body.requestFullscreen();
      btnFullscreen.textContent = "⛶";
      // Update button text when fullscreen changes
      document.addEventListener("fullscreenchange", () => {
        if (document.fullscreenElement) {
          btnFullscreen.textContent = "⛶";
        } else {
          btnFullscreen.textContent = "⛶";
        }
      });
    }
    // Request wake lock when entering fullscreen
    if ("wakeLock" in navigator && !document.fullscreenElement) {
      try {
        await navigator.wakeLock.request("screen");
      } catch (err) {
        // Wake lock might not be available
      }
    }
  } catch (err) {
    console.error("Fullscreen error:", err);
  }
});

btnLeave.addEventListener("click", () => {
  console.log("👋 Disconnecting...");
  if (peer) peer.destroy();
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  window.close(); // закрывает вкладку, если разрешено
  setTimeout(() => (location.href = "/"), 500); // fallback
});
