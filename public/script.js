// ====== Debug Flag ======
const DEBUG = true; // Set to true to enable verbose logging

// ====== Logging Utility ======
const log = (...args) => DEBUG && console.log(...args);
const logWarn = (...args) => DEBUG && console.warn(...args);

// ====== Configuration ======
const CONFIG = {
  // Media constraints
  VIDEO: { width: { ideal: 1280 }, height: { ideal: 720 } },
  AUDIO: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  // Timing
  CAMERA_ENUM_DELAY: 100, // Reduced delay for faster camera detection
  RECONNECT_DELAY_BASE: 1000,
  RECONNECT_DELAY_MAX: 5000,
  PEER_RECREATE_DELAY: 500,
  VIDEO_PLAYING_DELAY: 0, // No delay - show video immediately
  // ICE servers
  ICE_SERVERS: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:relay1.expressturn.com:3478",
      username: "ef-test",
      credential: "ef-test"
    }
  ],
  // SimplePeer options
  TRICKLE: true,
};

// ====== Constants ======
const ROOM_ID_PATTERN = /^[a-z0-9]{1,20}$/i; // Allow alphanumeric, max 20 chars

// ====== room & role ======
const params = new URLSearchParams(location.search);
const room = params.get("id");

if (!room || !ROOM_ID_PATTERN.test(room)) {
  location.replace("/");
  throw new Error("Invalid room id");
}

// ====== DOM ======
const localVideo = document.getElementById("local");
const remoteVideo = document.getElementById("remote");
const waitingScreen = document.getElementById("waiting-screen");
const meetingLinkInput = document.getElementById("meeting-link");
const copyLinkBtn = document.getElementById("copy-link-btn");
const controls = document.getElementById("controls");

// Validate critical DOM elements
if (!localVideo || !remoteVideo) {
  throw new Error("Missing required DOM elements");
}

// ====== Dynamic role assignment ======
let isHost = false; // Will be set dynamically based on who joins first

// ====== State ======
let ws = null;
let peer = null;
let localStream = null;
let queuedSignals = []; // outgoing signals
let queuedIncomingSignals = []; // incoming signals waiting for peer
let reconnectAttempts = 0;
let reconnecting = false;
let isRecreatingPeer = false; // prevent multiple simultaneous recreations
let hasConnected = false; // track if we've ever successfully connected
let fullscreenHandler = null; // for cleanup
let videoPlayingHandler = null; // for cleanup
let reconnectTimeout = null; // for cleanup
let cameraEnumTimeout = null; // for cleanup

const proto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${proto}://${location.host}/?room=${encodeURIComponent(room)}`;

// ====== Utility ======
function safeSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    queuedSignals.push(msg);
    log("🕓 queued (ws not ready)");
    return;
  }
  ws.send(msg);
}

function flushQueue() {
  if (ws && ws.readyState === WebSocket.OPEN && queuedSignals.length) {
    log(`🚚 flushing ${queuedSignals.length} queued signals`);
    queuedSignals.forEach((m) => ws.send(m));
    queuedSignals = [];
  }
}

// ====== WebSocket setup ======
function initWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    log("✅ WS open");
    reconnectAttempts = 0;
    flushQueue();
    // Wait for room-info to determine host/client role before starting peer
    // The room-info will be sent immediately by the server
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle room-info message from server
      if (data.type === "room-info") {
        isHost = data.isFirst;
        log(`📋 Room info: isFirst=${data.isFirst}, totalClients=${data.totalClients}`);
        log(`👤 Role: ${isHost ? "Host" : "Client"}`);
        
        // If client joins and host is already active (totalClients > 1), hide waiting screen immediately
        if (!isHost && data.totalClients > 1 && waitingScreen) {
          log("👥 Host already active, hiding waiting screen...");
          waitingScreen.classList.add("hidden");
          // Ensure controls are visible
          if (controls) {
            controls.style.display = "flex";
          }
        }
        
        // Now that we know our role, start getting media and creating peer connection
        if (!peer && !localStream) {
          log(`⚙️ ${isHost ? "Host" : "Client"} detected, starting peer setup...`);
          initPeer();
        } else if (localStream && !peer) {
          // Stream already exists, create peer connection immediately
          log(`⚡ Creating peer connection with existing stream...`);
          createPeerConnection(localStream);
        }
        return;
      }
      
      // Handle WebRTC signals
      if (!peer) {
        log("🕓 Incoming signal queued (peer not ready yet):", data.type || "candidate");
        queuedIncomingSignals.push(data);
        
        // If we have a stream, create peer IMMEDIATELY to process signals
        if (localStream) {
          log("⚡ Creating peer immediately to process incoming signal...");
          createPeerConnection(localStream);
          // Signal will be processed in createPeerConnection after peer is created
          return;
        }
        
        // If no stream yet, start getting it (should already be starting from WS open)
        if (!localStream) {
          log("⚙️ Starting peer setup to process queued signals...");
          initPeer();
        }
        return;
      }
      
      // Peer exists - process signal immediately
      try {
        log("📥 Processing signal:", data.type || "candidate");
        peer.signal(data);
      } catch (err) {
        console.error("Error signaling peer:", err);
      }
    } catch (err) {
      console.error("WS message parse error:", err);
    }
  });

  ws.addEventListener("close", () => {
    logWarn("⚠️ WS closed, reconnecting...");
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
  
  // Clear any existing reconnect timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  const delay = Math.min(CONFIG.RECONNECT_DELAY_MAX, reconnectAttempts * CONFIG.RECONNECT_DELAY_BASE);
  log(`🔁 Trying WS reconnect in ${delay / 1000}s...`);
  reconnectTimeout = setTimeout(() => {
    reconnecting = false;
    reconnectTimeout = null;
    initWebSocket();
  }, delay);
}

// ====== Cleanup functions ======
function cleanup() {
  // Clear timeouts
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (cameraEnumTimeout) {
    clearTimeout(cameraEnumTimeout);
    cameraEnumTimeout = null;
  }
  
  // Remove event listeners
  if (fullscreenHandler) {
    document.removeEventListener("fullscreenchange", fullscreenHandler);
    fullscreenHandler = null;
  }
  if (videoPlayingHandler) {
    if (remoteVideo) {
      remoteVideo.removeEventListener("playing", videoPlayingHandler);
      remoteVideo.removeEventListener("loadedmetadata", videoPlayingHandler);
    }
    videoPlayingHandler = null;
  }
  
  // Stop media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Destroy peer connection
  if (peer) {
    try {
      peer.destroy();
    } catch (err) {
      console.error("Error destroying peer:", err);
    }
    peer = null;
  }
  
  // Close WebSocket
  if (ws) {
    try {
      ws.close();
    } catch (err) {
      console.error("Error closing WebSocket:", err);
    }
    ws = null;
  }
  
  // Reset state
  queuedSignals = [];
  queuedIncomingSignals = [];
  isRecreatingPeer = false;
  hasConnected = false;
  reconnectAttempts = 0;
  reconnecting = false;
}

// Cleanup on page unload
window.addEventListener("beforeunload", cleanup);
window.addEventListener("pagehide", cleanup);

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
    log("🎥 Requesting media stream...");
    navigator.mediaDevices
      .getUserMedia({
        video: CONFIG.VIDEO,
        audio: CONFIG.AUDIO,
      })
      .then(async (stream) => {
        localStream = stream;
        localVideo.srcObject = stream;
        log("🎥 Local stream ready, creating peer connection...");
        log("🎥 isHost =", isHost);
        
        // Clear any existing timeout
        if (cameraEnumTimeout) {
          clearTimeout(cameraEnumTimeout);
        }
        
        // Create peer connection immediately - don't wait for camera enumeration
        createPeerConnection(stream);
        
        // Enumerate cameras in background (non-blocking) for switch button
        cameraEnumTimeout = setTimeout(async () => {
          cameraEnumTimeout = null;
          try {
            availableCameras = await getAvailableCameras();
            if (availableCameras.length > 1 && btnSwitchCamera) {
              btnSwitchCamera.style.display = "block";
              log(`📹 Found ${availableCameras.length} cameras`);
            }
          } catch (err) {
            console.error("Error enumerating cameras:", err);
          }
        }, CONFIG.CAMERA_ENUM_DELAY);
      })
      .catch((err) => {
        console.error("getUserMedia error:", err);
        // Show user-friendly error message
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          alert("Camera and microphone access is required.");
        } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          alert("No camera or microphone found.");
        }
      });
  } else {
    log("🎥 Reusing existing stream, creating peer connection...");
    createPeerConnection(localStream);
  }
}

function createPeerConnection(stream) {
  // Cleanup existing peer if any
  if (peer) {
    try {
      peer.destroy();
    } catch (_) {}
    peer = null;
  }
  
  // Create peer connection
  log("🔧 Creating peer connection. isHost =", isHost, "initiator =", isHost);
  peer = new SimplePeer({
    initiator: isHost,
    trickle: CONFIG.TRICKLE,
    config: {
      iceServers: CONFIG.ICE_SERVERS
    },
  });

  log("🔧 New peer created. Initiator =", isHost);

  // Set up ALL event handlers FIRST, before adding stream or processing signals
  peer.on("signal", (data) => {
      const msg = JSON.stringify(data);
      log("📤 Sending signal:", data.type, data);
      safeSend(msg);
  });

  peer.on("connect", () => {
    log("✅ Peer connected!");
    hasConnected = true; // Mark that we've successfully connected
  });

  peer.on("stream", (stream) => {
    log("🎬 Remote stream received");
    
    // Ensure controls are visible immediately
    if (controls) {
      controls.style.display = "flex";
      controls.style.visibility = "visible";
    }
    
    remoteVideo.srcObject = stream;
    
    // Ensure video plays with audio
    remoteVideo.muted = false;
    remoteVideo.play().catch(err => {
      console.error("Error playing remote video:", err);
    });
    
    // Cleanup previous handler if exists
    if (videoPlayingHandler) {
      remoteVideo.removeEventListener("playing", videoPlayingHandler);
      remoteVideo.removeEventListener("loadedmetadata", videoPlayingHandler);
    }
    
    // Show video immediately - no delay
    remoteVideo.classList.add("playing");
    
    // Hide waiting screen immediately when stream is received
    if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
      waitingScreen.classList.add("hidden");
    }
    
    // Listen for when video actually starts playing to ensure smooth transition
    videoPlayingHandler = () => {
      // Video is confirmed playing - ensure it's visible
      remoteVideo.classList.add("playing");
      
      // Cleanup handler
      if (videoPlayingHandler) {
        remoteVideo.removeEventListener("playing", videoPlayingHandler);
        remoteVideo.removeEventListener("loadedmetadata", videoPlayingHandler);
        videoPlayingHandler = null;
      }
    };
    
    // Add listeners for confirmation (non-blocking)
    if (remoteVideo.readyState < 3) {
      remoteVideo.addEventListener("playing", videoPlayingHandler, { once: true });
      remoteVideo.addEventListener("loadedmetadata", videoPlayingHandler, { once: true });
    }
  });

  peer.on("error", (err) => {
    console.error("❌ Peer error:", err);
    // Handle connection failures - recreate peer
    if (err.message.includes("Abort") || 
        err.message.includes("destroyed") || 
        err.message.includes("Connection failed")) {
      log("♻️ Recreating peer due to error...");
        if (!isRecreatingPeer && ws && ws.readyState === WebSocket.OPEN) {
        isRecreatingPeer = true;
        setTimeout(() => {
          isRecreatingPeer = false;
          initPeer();
        }, CONFIG.PEER_RECREATE_DELAY);
      }
    }
  });

  peer.on("close", () => {
    logWarn("🔌 Peer closed");
    // Only recreate if we're still connected via WebSocket
    if (!isRecreatingPeer && ws && ws.readyState === WebSocket.OPEN) {
      isRecreatingPeer = true;
      setTimeout(() => {
        isRecreatingPeer = false;
        initPeer();
      }, CONFIG.PEER_RECREATE_DELAY * 2); // Slightly longer delay for close events
    }
  });

  peer.on("iceStateChange", (state) => {
    log("🧊 ICE state:", state);
  });
  
  peer.on("iceConnectionStateChange", (state) => {
    log("🧊 ICE conn:", state);
    
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
        log(`♻️ ICE connection failed, recreating peer...`);
        isRecreatingPeer = true;
        setTimeout(() => {
          isRecreatingPeer = false;
          initPeer();
        }, CONFIG.PEER_RECREATE_DELAY);
      }
    }
    // Note: We intentionally do NOT handle "disconnected" state
    // It's a normal intermediate state and should recover on its own
  });

  // Add stream after all handlers are set up
  peer.addStream(stream);
  log("📹 Stream added to peer connection");

  // Process any queued incoming signals IMMEDIATELY and SYNCHRONOUSLY
  // This is critical - signals must be processed right away for fastest connection
  if (queuedIncomingSignals.length > 0) {
    log(`⚡ Processing ${queuedIncomingSignals.length} queued signals immediately...`);
    // Process signals synchronously, in order - no delays
    const signalsToProcess = [...queuedIncomingSignals];
    queuedIncomingSignals = [];
    signalsToProcess.forEach((signal) => {
      try {
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
let btnSwitchCamera = null; // Will be set after DOM is ready

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
    const cameras = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = cameras.filter(device => device.kind === 'videoinput');
    
    if (videoInputs.length < 2) {
      log("📹 Only one camera available");
      return;
    }
    
    // Update available cameras list
    availableCameras = videoInputs;
    
    // Get current camera ID from the active track
    const currentTrack = localStream.getVideoTracks()[0];
    if (!currentTrack) {
      console.error("No current video track found");
      return;
    }
    
    const currentSettings = currentTrack.getSettings();
    const currentCameraId = currentSettings.deviceId;
    
    // Find current camera index
    const currentIndex = availableCameras.findIndex(cam => cam.deviceId === currentCameraId);
    if (currentIndex === -1) {
      // If current camera not found, start from 0
      currentCameraIndex = 0;
    } else {
      currentCameraIndex = currentIndex;
    }
    
    // Switch to next camera
    const nextIndex = (currentCameraIndex + 1) % availableCameras.length;
    const newCameraId = availableCameras[nextIndex].deviceId;
    
    log(`📹 Switching from camera ${currentCameraIndex + 1} to ${nextIndex + 1}`);
    
    // Get new video track with selected camera
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        deviceId: { exact: newCameraId },
        ...CONFIG.VIDEO
      },
      audio: false, // Keep existing audio track
    });
    
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
      console.error("Failed to get new video track");
      newStream.getTracks().forEach(track => track.stop());
      return;
    }
    
    // IMPORTANT: Replace track in peer connection FIRST, before removing old track
    // This ensures continuity and prevents black screen
    if (peer && peer._pc) {
      const sender = peer._pc.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      } else {
        logWarn("No video sender found in peer connection");
      }
    }
    
    // Now replace track in local stream
    // Stop old track first but don't remove yet
    const oldVideoTrack = localStream.getVideoTracks()[0];
    
    // Add new track before removing old one to prevent black screen
    localStream.addTrack(newVideoTrack);
    
    // Update video element immediately with new track
    localVideo.srcObject = localStream;
    
    // Now remove old track and stop it
    if (oldVideoTrack) {
      localStream.removeTrack(oldVideoTrack);
      oldVideoTrack.stop();
    }
    
    // Stop the temporary stream (we only needed the track)
    newStream.getVideoTracks().forEach(track => {
      if (track !== newVideoTrack) track.stop();
    });
    
    // Update current camera index
    currentCameraIndex = nextIndex;
    
    log(`📹 Switched to camera: ${availableCameras[nextIndex].label || 'Camera ' + (nextIndex + 1)}`);
  } catch (err) {
    console.error("Error switching camera:", err);
    // If switching fails, try to re-enumerate and show button if cameras are available
    setTimeout(async () => {
      try {
        const cameras = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = cameras.filter(device => device.kind === 'videoinput');
        if (videoInputs.length > 1 && btnSwitchCamera) {
          availableCameras = videoInputs;
          btnSwitchCamera.style.display = "block";
        }
      } catch (e) {
        console.error("Error re-enumerating cameras:", e);
      }
    }, 1000);
  }
}

// ====== Controls ======
const btnMute = document.getElementById("btn-mute");
const btnCamera = document.getElementById("btn-camera");
btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnLeave = document.getElementById("btn-leave");


let isMuted = false;
let isCameraOff = false;

if (btnMute) {
  btnMute.addEventListener("click", () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => (track.enabled = !isMuted));
    const micIcon = document.getElementById("mic-icon");
    if (micIcon) {
      micIcon.src = isMuted ? "/images/mic-off.svg" : "/images/mic-on.svg";
    }
    log(isMuted ? "🔇 Mic muted" : "🎤 Mic unmuted");
  });
}

if (btnCamera) {
  btnCamera.addEventListener("click", () => {
    if (!localStream) return;
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach(track => (track.enabled = !isCameraOff));
    const cameraIcon = document.getElementById("camera-icon");
    if (cameraIcon) {
      cameraIcon.src = isCameraOff ? "/images/camera-off.svg" : "/images/camera-on.png";
    }
    log(isCameraOff ? "📷 Camera off" : "🎥 Camera on");
  });
}

if (btnSwitchCamera) {
  btnSwitchCamera.addEventListener("click", async (e) => {
    e.stopPropagation(); // Prevent triggering other click handlers
    await switchCamera();
  });
}

if (btnFullscreen) {
  btnFullscreen.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.body.requestFullscreen();
        
        // Cleanup previous handler if exists
        if (fullscreenHandler) {
          document.removeEventListener("fullscreenchange", fullscreenHandler);
        }
        
        // Update button text when fullscreen changes
        fullscreenHandler = () => {
          // Button text stays the same, but we can add logic here if needed
          if (!document.fullscreenElement && fullscreenHandler) {
            document.removeEventListener("fullscreenchange", fullscreenHandler);
            fullscreenHandler = null;
          }
        };
        document.addEventListener("fullscreenchange", fullscreenHandler);
      }
      // Request wake lock when entering fullscreen
      if ("wakeLock" in navigator && !document.fullscreenElement) {
        try {
        await navigator.wakeLock.request("screen");
      } catch (err) {
        // Wake lock might not be available - silently fail
      }
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  });
}

if (btnLeave) {
  btnLeave.addEventListener("click", () => {
    log("👋 Disconnecting...");
    cleanup();
    
    // Try to close window (works only if opened by script)
    try {
      window.close();
    } catch (err) {
      // Window might not be closable
    }
    
    // Fallback: redirect to home
    setTimeout(() => {
      location.href = "/";
    }, 500);
  });
}
