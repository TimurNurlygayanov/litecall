// ====== Debug Flag ======
const DEBUG = true; // Set to true to enable verbose logging

// ====== Log History for Debugging ======
const logHistory = [];
const MAX_LOG_HISTORY = 1000; // Keep last 1000 log entries

// ====== Logging Utility ======
const log = (...args) => {
  if (DEBUG) {
    console.log(...args);
  }
  // Store log entry with timestamp
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  logHistory.push(`[${timestamp}] ${message}`);
  // Keep only last MAX_LOG_HISTORY entries
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
};

const logWarn = (...args) => {
  if (DEBUG) {
    console.warn(...args);
  }
  // Store log entry with timestamp
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  logHistory.push(`[${timestamp}] WARN: ${message}`);
  // Keep only last MAX_LOG_HISTORY entries
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
};

// Capture console.error and console.log to log history
const originalConsoleError = console.error;
const originalConsoleLog = console.log;
console.error = (...args) => {
  originalConsoleError(...args);
  // Store in log history without calling console methods to avoid recursion
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  logHistory.push(`[${timestamp}] ERROR: ${message}`);
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
};
console.log = (...args) => {
  originalConsoleLog(...args);
  // Store in log history without calling console methods to avoid recursion
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
  logHistory.push(`[${timestamp}] ${message}`);
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift();
  }
};

// Immediate test to verify script is loading
console.log("🔵 Script.js loaded");

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

console.log("🔵 Room ID:", room);

if (!room || !ROOM_ID_PATTERN.test(room)) {
  console.error("❌ Invalid room ID:", room);
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
let isRequestingMedia = false; // prevent multiple simultaneous getUserMedia calls

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

// Helper function to check if peer is valid (not destroyed)
function isPeerValid(p) {
  if (!p) return false;
  // SimplePeer destroyed peers have a destroyed property
  if (p.destroyed === true) return false;
  // Try-catch check for destroyed state
  try {
    // If we can access the peer without errors, it's likely valid
    // But we can't easily check without trying to use it
    // So we'll rely on the destroyed property and our own tracking
    return true;
  } catch (_) {
    return false;
  }
}

// Helper function to clear stale remote stream and reset UI
function clearStaleRemoteStream() {
  const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
  if (hasRemoteStream) {
    log("🔄 Clearing stale remote stream from previous connection...");
    remoteVideo.srcObject = null;
    remoteVideo.classList.remove("playing");
    queuedIncomingSignals = []; // Clear queued signals - they're from previous connection
    // Show waiting screen again for host
    if (waitingScreen && isHost) {
      waitingScreen.classList.remove("hidden");
      waitingScreen.classList.add("host-streaming");
    }
    return true; // Return true if stream was cleared
  }
  return false; // Return false if no stream to clear
}

// Helper function to recreate peer connection
function recreatePeerConnection() {
  if (localStream) {
    createPeerConnection(localStream);
  } else {
    initPeer();
  }
}

// ====== WebSocket setup ======
function initWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    log("✅ WS open");
    reconnectAttempts = 0;
    flushQueue();
    // Start getting media stream immediately (for host, this shows their video right away)
    // We'll determine host/client role from room-info, but no need to wait for it to start streaming
    if (!localStream && !isRequestingMedia) {
      isRequestingMedia = true;
      log("🎥 Starting media stream immediately...");
      // Get media stream first, then we'll create peer when we know our role
      navigator.mediaDevices
        .getUserMedia({
          video: CONFIG.VIDEO,
          audio: CONFIG.AUDIO,
        })
        .then(async (stream) => {
          isRequestingMedia = false;
          localStream = stream;
          localVideo.srcObject = stream;
          log("🎥 Local stream ready");
          
          // On mobile, ensure local video has proper attributes for autoplay
          if (localVideo) {
            localVideo.setAttribute("playsinline", "true");
            localVideo.setAttribute("webkit-playsinline", "true");
            localVideo.style.display = "block";
            
            // Ensure local video plays on mobile
            const localPlayPromise = localVideo.play();
            if (localPlayPromise !== undefined) {
              localPlayPromise.catch((err) => {
                logWarn("⚠️ Local video play failed (will retry):", err);
                // Retry after a short delay
                setTimeout(() => {
                  localVideo.play().catch((retryErr) => {
                    logWarn("⚠️ Local video retry play failed:", retryErr);
                  });
                }, 500);
              });
            }
          }
          
          // If we're the host (will be confirmed by room-info), make waiting screen semi-transparent
          // so the video shows through while keeping the link widget visible
          // For clients joining existing room: waiting screen is already hidden, so just show local video
          if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
            waitingScreen.classList.add("host-streaming");
            log("✨ Making waiting screen semi-transparent so video shows through");
          }
          
          // For clients: if waiting screen is hidden (joining existing room), show controls now
          if (!isHost && waitingScreen && waitingScreen.classList.contains("hidden")) {
            log("👤 Client: camera accepted, showing controls...");
            if (controls) {
              controls.style.display = "flex";
              controls.style.visibility = "visible";
            }
          }
          
          // Keep waiting screen visible for host - don't hide it yet
          // Host: we'll keep it visible until client joins (so they can share the link)
          // Client: it should already be hidden if joining existing room
          
          // IMPORTANT: Create peer connection when stream is ready
          // For client: if we have queued signals (offer received before stream was ready), process them
          // For client: even without queued signals, create peer to be ready for incoming offer
          // For host: create peer to generate offer
          const peerIsValid = isPeerValid(peer);
          if (!peerIsValid) {
            if (queuedIncomingSignals.length > 0) {
              log(`⚡ Stream ready with ${queuedIncomingSignals.length} queued signals - creating peer immediately...`);
            } else if (isHost) {
              log("⚡ Host stream ready - creating peer connection...");
            } else {
              log("⚡ Client stream ready - creating peer connection (will process offer when received)...");
            }
            if (peer && peer.destroyed) {
              peer = null; // Clean up destroyed peer reference
            }
            createPeerConnection(stream);
          } else {
            log("✅ Peer already exists and is valid, stream ready");
          }
          
          // Clear any existing timeout
          if (cameraEnumTimeout) {
            clearTimeout(cameraEnumTimeout);
          }
          
          // Enumerate cameras in background (non-blocking) for switch button
          cameraEnumTimeout = setTimeout(async () => {
            cameraEnumTimeout = null;
            try {
              const cameras = await getAvailableCameras();
              availableCameras = cameras; // Update global variable
              if (cameras.length > 1 && btnSwitchCamera) {
                btnSwitchCamera.style.display = "block";
                log(`📹 Found ${cameras.length} cameras`);
              }
            } catch (err) {
              console.error("Error enumerating cameras:", err);
            }
          }, CONFIG.CAMERA_ENUM_DELAY);
        })
        .catch((err) => {
          isRequestingMedia = false;
          console.error("getUserMedia error:", err);
          // Show user-friendly error message
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            alert("Camera and microphone access is required.");
          } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
            alert("No camera or microphone found.");
          }
        });
    } else if (localStream) {
      log("🎥 Stream already exists, skipping duplicate request");
    } else if (isRequestingMedia) {
      log("🎥 Media request already in progress, skipping duplicate request");
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle room-info message from server
      if (data.type === "room-info") {
        const wasHost = isHost;
        const newClientJoined = data.newClientJoined || false;
        
        // IMPORTANT: Only update role if this is NOT a new-client-joined notification
        // During reconnection notifications, preserve the existing role to prevent host->client flip
        if (!newClientJoined) {
          // Initial connection - accept role from server
          isHost = data.isFirst;
        } else {
          // Reconnection notification - preserve existing role (server should send correct role, but be defensive)
          // Only update if server says we should be host and we currently aren't (in case host was reassigned)
          if (data.isFirst && !wasHost) {
            log(`🔄 Server indicates role change to Host - accepting`);
            isHost = true;
          } else if (!data.isFirst && wasHost) {
            // Server says we're not host, but we think we are - preserve our role (defensive)
            log(`🔒 Preserving Host role - server says isFirst=${data.isFirst} but we are host`);
            isHost = true;
          } else {
            // Role matches or no change needed
            log(`🔒 Preserving existing role (${wasHost ? "Host" : "Client"}) during new client notification`);
          }
        }
        
        log(`📋 Room info: isFirst=${data.isFirst}, totalClients=${data.totalClients}, newClientJoined=${newClientJoined}`);
        log(`👤 Role: ${isHost ? "Host" : "Client"} (was ${wasHost ? "Host" : "Client"})`);
        
        // For host: show controls and local video, but KEEP waiting screen visible
        // until a client actually joins (so host can share the link)
        if (isHost && waitingScreen) {
          log("👤 Host detected, showing controls but keeping link widget visible...");
          // Don't hide waiting screen yet - keep it visible so host can share the link
          // Make it semi-transparent so local video shows through
          if (localStream) {
            waitingScreen.classList.add("host-streaming");
            log("✨ Making waiting screen semi-transparent so video shows through");
          }
          // It will be hidden when remote stream is received or when client joins
          // Ensure controls are visible
          if (controls) {
            controls.style.display = "flex";
            controls.style.visibility = "visible";
          }
          // Ensure local video is visible
          if (localVideo) {
            localVideo.style.display = "block";
          }
        }
        
        // If client joins and host is already active (totalClients > 1), hide waiting screen immediately
        // Show empty page (no "share link" widget) - client will see their video once camera is accepted
        if (!isHost && data.totalClients > 1 && waitingScreen) {
          log("👥 Host already active, hiding waiting screen immediately (client joining existing room)...");
          waitingScreen.classList.add("hidden");
          // Don't show controls yet - wait for camera permission
          // Local video will be shown once getUserMedia succeeds
        }
        
        // For host: if totalClients > 1, a client has joined - hide waiting screen
        if (isHost && data.totalClients > 1 && waitingScreen) {
          log("👥 Client has joined (totalClients > 1) - hiding waiting screen with link widget");
          waitingScreen.classList.add("hidden");
        }
        
        // IMPORTANT: If host detects a new client joined and we don't have a valid peer, recreate it
        // This handles reconnection scenarios where host's peer was closed/destroyed
        if (isHost && newClientJoined && localStream) {
          const peerIsValid = isPeerValid(peer);
          if (!peerIsValid) {
            log("🔄 Host detected new client joined but peer is invalid/destroyed - recreating peer connection...");
            const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
            if (hasRemoteStream) {
              log("🔄 Clearing stale remote stream before recreating peer...");
              clearStaleRemoteStream();
            }
            // Clear queued signals from previous connection
            queuedIncomingSignals = [];
            // Set peer to null to ensure clean recreation
            peer = null;
            createPeerConnection(localStream);
            return; // Don't continue with normal peer creation below
          } else {
            log("✅ Host peer is valid, client will reconnect to existing peer");
          }
        }
        
        // Now that we know our role, create peer connection if we have a stream
        // (Stream might already be ready from WS open handler)
        // IMPORTANT: Don't call initPeer() here if localStream doesn't exist - it's already being requested in WS open handler
        const peerIsValid = isPeerValid(peer);
        if (localStream && !peerIsValid) {
          log(`⚡ ${isHost ? "Host" : "Client"} detected, creating peer connection with stream...`);
          if (peer && peer.destroyed) {
            peer = null; // Clean up destroyed peer reference
          }
          createPeerConnection(localStream);
        } else if (peerIsValid) {
          log(`ℹ️ Valid peer already exists (${isHost ? "Host" : "Client"}), skipping creation`);
        }
        // Note: We don't call initPeer() here because getUserMedia is already being requested in WS open handler
        // This prevents duplicate permission requests
        return;
      }
      
      // Handle WebRTC signals
      // Note: This handles late connections - if client connects 10+ minutes after host,
      // the host's peer might have closed, but we can recreate it when signals arrive
      const peerIsValid = isPeerValid(peer);
      if (!peerIsValid) {
        log(`🕓 No valid peer exists. Signal type: ${data.type || 'candidate'}, isHost: ${isHost}, hasLocalStream: ${!!localStream}`);
        
        // Clear peer reference if it's destroyed
        if (peer && peer.destroyed) {
          log("🧹 Cleaning up destroyed peer reference");
          peer = null;
        }
        
        // Clear any stale remote stream from previous connection
        const hadStaleStream = clearStaleRemoteStream();
        if (hadStaleStream) {
          log("🔄 Cleared stale remote stream from previous connection");
        }
        
        // For host (initiator) receiving answer when peer doesn't exist: this is likely a stale answer
        // from a previous connection. Ignore it and create peer to generate new offer.
        // For client (non-initiator): accept offers - we need them to connect
        if (data.type === "answer" && isHost) {
          log("⚠️ Host received answer but no valid peer exists - ignoring stale answer, will generate new offer");
          recreatePeerConnection();
          return;
        }
        
        // For client: if we receive an offer but don't have a peer yet, queue it
        // But we'll also check if it's stale when we create the peer
        log(`🕓 Incoming signal queued (peer not ready yet): ${data.type || "candidate"}`);
        queuedIncomingSignals.push(data);
        log(`📋 Total queued signals: ${queuedIncomingSignals.length}`);
        
        // If we have a stream, create peer IMMEDIATELY to process signals
        // This is critical for late connections - host can recreate peer when signals arrive
        if (localStream) {
          log("⚡ Creating peer immediately to process incoming signal (late connection support)...");
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
      // This is the normal connection flow - host should process answers normally
      // Only ignore answers if we have BOTH a remote stream AND the peer is connected
      // This prevents processing stale answers after connection is established
      if (data.type === "answer") {
        const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
        // Only ignore if we have remote stream AND peer is connected
        // This means we have an active connection, so any additional answer is stale
        if (hasRemoteStream && hasConnected) {
          log("⚠️ Ignoring stale answer - active connection already established");
          return;
        }
        // Note: We don't clear stream here if !hasConnected because:
        // - During normal connection, hasConnected might not be set yet when answer arrives
        // - The stream will be set when peer.on("stream") fires, which sets hasConnected
        // - Clearing here would break normal connection flow
      }
      
      // Check if peer is still valid before processing signal
      if (!isPeerValid(peer)) {
        log(`⚠️ Peer is invalid/destroyed, cannot process signal: ${data.type || "candidate"}`);
        // Clean up destroyed peer reference
        if (peer && peer.destroyed) {
          peer = null;
        }
        // Queue signal for processing after peer recreation
        log(`📋 Queueing signal for processing after peer recreation: ${data.type || "candidate"}`);
        if (!queuedIncomingSignals.includes(data)) {
          queuedIncomingSignals.push(data);
        }
        // Recreate peer if we have a stream
        if (localStream) {
          recreatePeerConnection();
        } else if (!localStream) {
          initPeer();
        }
        return;
      }
      
      try {
        log(`📥 Processing signal: ${data.type || "candidate"} (peer exists: ${!!peer}, hasConnected: ${hasConnected})`);
        peer.signal(data);
        log(`✅ Successfully processed signal: ${data.type || "candidate"}`);
      } catch (err) {
        console.error(`❌ Error processing signal ${data.type || "candidate"}:`, err);
        // If peer was destroyed, we need to handle reconnection
        if (err.message && err.message.includes("destroyed")) {
          console.error("❌ Peer was destroyed, handling reconnection...");
          log(`🔄 Peer destroyed. Signal type: ${data.type}, isHost: ${isHost}`);
          
          // Mark peer as destroyed
          if (peer) {
            peer.destroyed = true;
          }
          
          // Clear stale remote stream if it exists
          const hadStaleStream = clearStaleRemoteStream();
          log(`🔄 Stale stream cleared: ${hadStaleStream}`);
          
          // For host receiving answer: ignore it, will generate new offer
          // For client or other signals: queue them if no stale stream was cleared
          if (data.type === "answer" && isHost) {
            log("⚠️ Ignoring stale answer from previous connection (host will generate new offer)");
            peer = null; // Clean up
            recreatePeerConnection();
          } else if (!hadStaleStream) {
            // Only queue if we didn't have a stale stream (fresh connection attempt)
            log(`📋 Queueing signal for processing after peer recreation: ${data.type || "candidate"}`);
            if (!queuedIncomingSignals.includes(data)) {
              queuedIncomingSignals.push(data);
            }
            peer = null; // Clean up
            recreatePeerConnection();
          } else {
            // Had stale stream - recreate without queueing (stale signals already cleared)
            log("🔄 Recreating peer without queueing (stale signals already cleared)");
            peer = null; // Clean up
            recreatePeerConnection();
          }
        } else {
          console.error("Error signaling peer:", err);
        }
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
  // Don't start if already recreating
  if (isRecreatingPeer) {
    log("⚠️ Already recreating peer, skipping...");
    return;
  }
  
  if (peer) {
    try {
      const oldPeer = peer;
      peer = null; // Set to null first to prevent close handler from recreating
      oldPeer.destroy();
    } catch (_) {}
  }
  
  // Reset flags when starting new peer
  hasConnected = false; // Reset connection status for new peer

  // Get or reuse stream FIRST, then create peer connection
  // IMPORTANT: Don't request media if we're already requesting it or already have it
  if (!localStream && !isRequestingMedia) {
    isRequestingMedia = true;
    log("🎥 Requesting media stream...");
    navigator.mediaDevices
      .getUserMedia({
        video: CONFIG.VIDEO,
        audio: CONFIG.AUDIO,
      })
      .then(async (stream) => {
        isRequestingMedia = false;
        localStream = stream;
        localVideo.srcObject = stream;
        log("🎥 Local stream ready, creating peer connection...");
        log("🎥 isHost =", isHost);
        
        // Show local video widget immediately
        if (localVideo) {
          localVideo.style.display = "block";
        }
        
        // For host: show controls but KEEP waiting screen visible (so they can share link)
        // Don't hide waiting screen here - it will be hidden when client joins
        if (isHost && controls) {
          controls.style.display = "flex";
          controls.style.visibility = "visible";
        }
        
        // Clear any existing timeout
        if (cameraEnumTimeout) {
          clearTimeout(cameraEnumTimeout);
        }
        
        // Only create peer if one doesn't already exist (prevent race conditions)
        // If peer already exists, it means getUserMedia resolved after peer was created
        // from a queued signal or another initPeer() call
        if (!peer) {
          // Create peer connection immediately - don't wait for camera enumeration
          createPeerConnection(stream);
        } else {
          log("⚠️ Peer already exists, skipping peer creation (race condition avoided)");
        }
        
        // Enumerate cameras in background (non-blocking) for switch button
        cameraEnumTimeout = setTimeout(async () => {
          cameraEnumTimeout = null;
          try {
            const cameras = await getAvailableCameras();
            availableCameras = cameras; // Update global variable
            if (cameras.length > 1 && btnSwitchCamera) {
              btnSwitchCamera.style.display = "block";
              log(`📹 Found ${cameras.length} cameras`);
            }
          } catch (err) {
            console.error("Error enumerating cameras:", err);
          }
        }, CONFIG.CAMERA_ENUM_DELAY);
      })
      .catch((err) => {
        isRequestingMedia = false;
        console.error("getUserMedia error:", err);
        // Show user-friendly error message
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          alert("Camera and microphone access is required.");
        } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
          alert("No camera or microphone found.");
        }
      });
  } else if (localStream) {
    log("🎥 Reusing existing stream, creating peer connection...");
    createPeerConnection(localStream);
  } else if (isRequestingMedia) {
    log("🎥 Media request already in progress, will create peer when stream is ready");
    // Don't do anything - the WS open handler will create the peer when stream is ready
  }
}

function createPeerConnection(stream) {
  // Cleanup existing peer if any
  if (peer) {
    try {
      const oldPeer = peer;
      peer = null; // Set to null first to prevent close handler from recreating
      oldPeer.destroy();
      // Mark as destroyed for cleanup
      oldPeer.destroyed = true;
    } catch (_) {}
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
      // Log signal type only, not full content (makes logs easier to copy)
      if (data.type === "offer" || data.type === "answer") {
        log(`📤 Sending signal: ${data.type} (SDP length: ${data.sdp?.length || 0} chars)`);
        // Log ICE candidates in SDP for debugging
        if (data.sdp) {
          const candidateCount = (data.sdp.match(/a=candidate:/g) || []).length;
          log(`📤 SDP contains ${candidateCount} ICE candidates`);
        }
      } else if (data.type === "candidate") {
        const candidateStr = data.candidate?.candidate || '';
        const candidateType = candidateStr.includes('typ host') ? 'host' : 
                             candidateStr.includes('typ srflx') ? 'srflx' :
                             candidateStr.includes('typ relay') ? 'relay' : 'unknown';
        log(`📤 Sending signal: candidate (${candidateType}, ${candidateStr.substring(0, 50)}...)`);
      } else {
        log(`📤 Sending signal: ${data.type || 'unknown'}`);
      }
      safeSend(msg);
  });

  peer.on("connect", () => {
    log("✅ Peer connected!");
    hasConnected = true; // Mark that we've successfully connected
  });

  peer.on("stream", (stream) => {
    log("🎬 Remote stream received");
    
    // Log stream details for debugging
    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    log(`📊 Stream tracks: ${videoTracks.length} video, ${audioTracks.length} audio`);
    if (videoTracks.length > 0) {
      log(`📹 Video track: ${videoTracks[0].label || 'unnamed'}, enabled: ${videoTracks[0].enabled}, readyState: ${videoTracks[0].readyState}`);
    }
    if (audioTracks.length > 0) {
      log(`🔊 Audio track: ${audioTracks[0].label || 'unnamed'}, enabled: ${audioTracks[0].enabled}, readyState: ${audioTracks[0].readyState}`);
    }
    
    // Ensure controls are visible immediately
    if (controls) {
      controls.style.display = "flex";
      controls.style.visibility = "visible";
    }
    
    // On mobile, ensure video element has proper attributes BEFORE setting stream
    remoteVideo.setAttribute("playsinline", "true");
    remoteVideo.setAttribute("webkit-playsinline", "true");
    remoteVideo.setAttribute("autoplay", "true");
    
    // Set stream
    remoteVideo.srcObject = stream;
    log("📹 Remote stream set to video element");
    
    // Monitor stream for track changes
    stream.onaddtrack = (event) => {
      log(`➕ Track added to remote stream: ${event.track.kind} (${event.track.label || 'unnamed'})`);
    };
    stream.onremovetrack = (event) => {
      logWarn(`➖ Track removed from remote stream: ${event.track.kind} (${event.track.label || 'unnamed'})`);
    };
    
    // On mobile, videos need to be muted initially to autoplay (browser autoplay policy)
    // Start muted to ensure autoplay works
    remoteVideo.muted = true;
    log("🔇 Remote video muted for autoplay");
    
    // Show video element immediately
    remoteVideo.classList.add("playing");
    remoteVideo.style.display = "block";
    log("👁️ Remote video element made visible");
    
    // Hide waiting screen when remote stream is received (client has joined)
    if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
      log("👥 Client joined - hiding waiting screen with link widget");
      waitingScreen.classList.add("hidden");
    }
    
    // Cleanup previous handler if exists
    if (videoPlayingHandler) {
      remoteVideo.removeEventListener("playing", videoPlayingHandler);
      remoteVideo.removeEventListener("loadedmetadata", videoPlayingHandler);
      remoteVideo.removeEventListener("canplay", videoPlayingHandler);
      remoteVideo.removeEventListener("loadeddata", videoPlayingHandler);
    }
    
    // Wait for video to have some data before trying to play (important for mobile)
    const tryPlay = () => {
      log(`🎬 Attempting to play remote video (readyState: ${remoteVideo.readyState}, paused: ${remoteVideo.paused}, muted: ${remoteVideo.muted})`);
      const playPromise = remoteVideo.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            log("✅ Remote video started playing (muted)");
            // Try to unmute after a short delay - this might work on some browsers
            setTimeout(() => {
              if (remoteVideo.muted) {
                remoteVideo.muted = false;
                remoteVideo.play().catch((err) => {
                  // Silent fail - video is playing muted, user may need to interact
                  logWarn("⚠️ Remote video remains muted due to autoplay policy:", err);
                });
              }
            }, 500);
          })
          .catch(err => {
            logWarn("⚠️ Error playing remote video:", err);
            logWarn("⚠️ Error details - name:", err?.name, "message:", err?.message, "code:", err?.code);
            // On mobile, video might need user interaction - try again after a short delay
            // Also ensure video is properly loaded
            setTimeout(() => {
              log(`🔄 Retrying play (readyState: ${remoteVideo.readyState}, paused: ${remoteVideo.paused})`);
              // Try playing even if readyState is low - sometimes it works
              remoteVideo.play().then(() => {
                log("✅ Remote video started playing on retry");
              }).catch((retryErr) => {
                logWarn("⚠️ Retry play failed:", retryErr?.name, retryErr?.message);
                // Try one more time after longer delay
                setTimeout(() => {
                  log("🔄 Final retry attempt...");
                  remoteVideo.play().then(() => {
                    log("✅ Remote video started playing on final retry");
                  }).catch((finalErr) => {
                    logWarn("⚠️ Final retry failed:", finalErr?.name, finalErr?.message);
                    log("📱 Mobile: Video may require user interaction to play");
                    log("📱 Try tapping the screen or a button to enable video playback");
                  });
                }, 2000);
              });
            }, 1000);
          });
      } else {
        // Fallback: try to play after a short delay
        log("⚠️ play() returned undefined, using fallback");
        setTimeout(() => {
          remoteVideo.play().then(() => {
            log("✅ Remote video started playing (fallback)");
          }).catch((err) => {
            logWarn("⚠️ Fallback play failed:", err?.name, err?.message);
          });
        }, 100);
      }
    };
    
    // Try to play immediately if video has data, otherwise wait for loadeddata
    if (remoteVideo.readyState >= 2) {
      log("📹 Video already has data, playing immediately");
      tryPlay();
    } else {
      log("📹 Waiting for video data before playing...");
      const dataHandler = () => {
        log("📹 Video data loaded, attempting to play");
        remoteVideo.removeEventListener("loadeddata", dataHandler);
        tryPlay();
      };
      remoteVideo.addEventListener("loadeddata", dataHandler, { once: true });
      
      // Also try after a timeout as fallback - be more aggressive on mobile
      setTimeout(() => {
        if (remoteVideo.readyState >= 1) { // HAVE_METADATA or higher
          log("📹 Timeout: Video has metadata, attempting to play");
          tryPlay();
        } else {
          logWarn(`⚠️ Video still not ready after timeout (readyState: ${remoteVideo.readyState})`);
          // Try anyway - sometimes video can play even if readyState is low
          tryPlay();
        }
      }, 500);
      
      // Additional fallback - try playing after longer delay (mobile sometimes needs more time)
      setTimeout(() => {
        if (!remoteVideo.paused) {
          log("✅ Video is already playing");
        } else {
          log("🔄 Additional fallback: attempting to play video");
          tryPlay();
        }
      }, 2000);
      
      // Final fallback - try playing after even longer delay (for slow connections)
      // Also check if ICE connection is established and force play if needed
      setTimeout(() => {
        if (!remoteVideo.paused) {
          log("✅ Video is already playing");
        } else {
          // Check ICE connection state - if it's connected/completed, force play
          if (peer && peer._pc) {
            const iceState = peer._pc.iceConnectionState;
            log(`🔄 Final fallback: ICE state is ${iceState}, attempting to play video`);
            if (iceState === "connected" || iceState === "completed" || iceState === "checking") {
              log("🎬 ICE connection active - forcing video play");
              tryPlay();
            } else {
              // Even if ICE isn't connected, try playing - sometimes it works
              log("🎬 Attempting to play video despite ICE state: " + iceState);
              tryPlay();
            }
          } else {
            log("🔄 Final fallback: attempting to play video (no peer connection info)");
            tryPlay();
          }
        }
      }, 5000);
    }
    
    // Listen for when video actually starts playing to ensure smooth transition
    videoPlayingHandler = () => {
      log("✅ Remote video confirmed playing");
      // Ensure it's visible
      remoteVideo.classList.add("playing");
      
      // Try to unmute once video is confirmed playing
      // This might work better than unmuting immediately
      setTimeout(() => {
        if (remoteVideo.muted && remoteVideo.readyState >= 3) {
          remoteVideo.muted = false;
          remoteVideo.play().catch(() => {
            // Silent fail - autoplay policy might prevent unmuting
          });
        }
      }, 100);
      
      // Cleanup handler
      if (videoPlayingHandler) {
        remoteVideo.removeEventListener("playing", videoPlayingHandler);
        remoteVideo.removeEventListener("loadedmetadata", videoPlayingHandler);
        remoteVideo.removeEventListener("canplay", videoPlayingHandler);
        remoteVideo.removeEventListener("loadeddata", videoPlayingHandler);
        remoteVideo.removeEventListener("timeupdate", videoPlayingHandler);
        videoPlayingHandler = null;
      }
    };
    
    // Add listeners for confirmation (non-blocking)
    // Use multiple events to catch when video is ready
    remoteVideo.addEventListener("playing", videoPlayingHandler, { once: true });
    remoteVideo.addEventListener("loadedmetadata", videoPlayingHandler, { once: true });
    remoteVideo.addEventListener("canplay", videoPlayingHandler, { once: true });
    remoteVideo.addEventListener("loadeddata", videoPlayingHandler, { once: true });
    
    // Also listen for timeupdate - this means video is actually playing
    remoteVideo.addEventListener("timeupdate", () => {
      if (!remoteVideo.paused && remoteVideo.currentTime > 0) {
        log("✅ Remote video timeupdate - video is playing (currentTime: " + remoteVideo.currentTime.toFixed(2) + "s)");
        if (videoPlayingHandler) {
          videoPlayingHandler();
        }
      }
    }, { once: true });
    
    // Monitor video element state changes for debugging
    remoteVideo.addEventListener("loadstart", () => log("📹 Remote video: loadstart"));
    remoteVideo.addEventListener("loadedmetadata", () => log("📹 Remote video: loadedmetadata (readyState: " + remoteVideo.readyState + ")"));
    remoteVideo.addEventListener("loadeddata", () => log("📹 Remote video: loadeddata (readyState: " + remoteVideo.readyState + ")"));
    remoteVideo.addEventListener("canplay", () => log("📹 Remote video: canplay (readyState: " + remoteVideo.readyState + ")"));
    remoteVideo.addEventListener("canplaythrough", () => log("📹 Remote video: canplaythrough (readyState: " + remoteVideo.readyState + ")"));
    remoteVideo.addEventListener("playing", () => log("📹 Remote video: playing event"));
    remoteVideo.addEventListener("pause", () => logWarn("⚠️ Remote video: paused"));
    remoteVideo.addEventListener("error", (e) => {
      logWarn("❌ Remote video error:", e);
      logWarn("❌ Video error code:", remoteVideo.error?.code, "message:", remoteVideo.error?.message);
    });
  });

  peer.on("error", (err) => {
    console.error("❌ Peer error:", err);
    // Only recreate on critical errors, not transient connection failures
    // "Connection failed" can happen during normal negotiation - let it recover
    if (err.message.includes("Abort") || err.message.includes("destroyed")) {
      log("♻️ Recreating peer due to critical error...");
      if (!isRecreatingPeer && ws && ws.readyState === WebSocket.OPEN) {
        isRecreatingPeer = true;
        setTimeout(() => {
          isRecreatingPeer = false;
          initPeer();
        }, CONFIG.PEER_RECREATE_DELAY);
      }
    } else if (err.message.includes("Connection failed")) {
      // Connection failed - this can happen during normal negotiation
      // Check ICE connection state - if it's "connecting" or "checking", it might recover
      // Only recreate if we're definitely failed and haven't connected
      log("⚠️ Connection failed, checking ICE state...");
      
      // Don't recreate immediately - ICE might recover
      // SimplePeer will handle the connection state internally
      // We'll only recreate if the peer actually closes and hasn't connected
      // (handled in peer.on("close"))
    }
  });

  peer.on("close", () => {
    logWarn("🔌 Peer closed");
    // Mark peer as destroyed so we know it's invalid
    if (peer) {
      peer.destroyed = true;
    }
    
    // Don't recreate if peer was set to null (intentionally destroyed)
    // Don't recreate if we're already recreating
    // Don't recreate if we've successfully connected before
    // Don't recreate if we've received a remote stream (connection is working)
    const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
    if (!peer || isRecreatingPeer || hasConnected || hasRemoteStream) {
      if (hasRemoteStream) {
        log("✅ Remote stream exists, connection is working - not recreating");
      }
      return;
    }
    
    // Only recreate if WebSocket is still open and we haven't connected
    // Note: For late connections (client joins 10+ minutes later), we DON'T recreate here.
    // Instead, we wait for the client's answer signal to arrive, which will trigger
    // peer creation via the signal handler (which checks !peer and creates one).
    // This prevents unnecessary recreation loops while waiting for a client.
    if (ws && ws.readyState === WebSocket.OPEN) {
      const currentPeer = peer;
      const queuedSignalsCount = queuedIncomingSignals.length;
      logWarn(`🔌 Peer closed. Queued signals: ${queuedSignalsCount}`);
      
      // If we're the host and waiting for a client, don't recreate immediately
      // Wait for the client's answer signal to trigger peer creation
      if (isHost && !hasConnected) {
        log("⏳ Host waiting for client - will recreate peer when answer arrives");
        return;
      }
      
      isRecreatingPeer = true;
      setTimeout(() => {
        // Only recreate if:
        // 1. The peer still exists (wasn't destroyed/replaced)
        // 2. We haven't connected yet
        // 3. We don't have a remote stream
        if (peer && peer === currentPeer && !hasConnected) {
          const stillHasRemoteStream = remoteVideo && remoteVideo.srcObject;
          if (!stillHasRemoteStream) {
            logWarn("🔌 Peer closed without connecting, recreating...");
            isRecreatingPeer = false;
            initPeer();
          } else {
            log("✅ Remote stream appeared, connection is working - not recreating");
            isRecreatingPeer = false;
          }
        } else {
          // Peer was destroyed/replaced or we connected - don't recreate
          isRecreatingPeer = false;
        }
      }, CONFIG.PEER_RECREATE_DELAY * 3); // Longer delay to avoid recreation loops
    }
  });

  peer.on("iceStateChange", (state) => {
    log("🧊 ICE state:", state);
    // Log ICE gathering state for debugging
    if (peer && peer._pc) {
      const iceGatheringState = peer._pc.iceGatheringState;
      const iceConnectionState = peer._pc.iceConnectionState;
      const connectionState = peer._pc.connectionState;
      log(`🧊 ICE gathering: ${iceGatheringState}, connection: ${iceConnectionState}, peer: ${connectionState}`);
    }
  });
  
  peer.on("iceConnectionStateChange", (state) => {
    log("🧊 ICE conn:", state);
    
    // Log additional connection details for debugging
    if (peer && peer._pc) {
      const iceGatheringState = peer._pc.iceGatheringState;
      const connectionState = peer._pc.connectionState;
      const localDescription = peer._pc.localDescription;
      const remoteDescription = peer._pc.remoteDescription;
      log(`🧊 ICE details - gathering: ${iceGatheringState}, peer connection: ${connectionState}`);
      log(`🧊 SDP - local: ${localDescription ? localDescription.type : 'none'}, remote: ${remoteDescription ? remoteDescription.type : 'none'}`);
      
      // Log ICE candidates count
      if (peer._pc.localDescription) {
        const localCandidates = peer._pc.localDescription.sdp.match(/a=candidate:/g) || [];
        log(`🧊 Local ICE candidates: ${localCandidates.length}`);
      }
      if (peer._pc.remoteDescription) {
        const remoteCandidates = peer._pc.remoteDescription.sdp.match(/a=candidate:/g) || [];
        log(`🧊 Remote ICE candidates: ${remoteCandidates.length}`);
      }
    }
    
    // Handle successful connection
    if (state === "connected" || state === "completed") {
      hasConnected = true;
      log("✅ ICE connection established!");
      
      // Try to play remote video once ICE is connected (if it exists but isn't playing)
      if (remoteVideo && remoteVideo.srcObject && remoteVideo.paused) {
        log("🎬 ICE connected - attempting to play remote video");
        remoteVideo.play().catch((err) => {
          logWarn("⚠️ Failed to play video after ICE connection:", err);
        });
      }
      return;
    }
    
    // Handle "connecting" state - this is good, connection is being established
    if (state === "connecting") {
      log("🔄 ICE connecting...");
      return;
    }
    
    // "disconnected" is a normal intermediate state - allow it to recover
    // However, if we have a remote stream, the connection might still be working
    // Don't treat "disconnected" as a failure if we have an active stream
    if (state === "disconnected") {
      const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
      if (hasRemoteStream) {
        log("⚠️ ICE disconnected but remote stream exists - connection may still work");
        // Try to play video even if ICE is disconnected - sometimes it works
        if (remoteVideo.paused) {
          log("🎬 Attempting to play video despite ICE disconnected state");
          remoteVideo.play().catch((err) => {
            logWarn("⚠️ Failed to play video (ICE disconnected):", err?.name, err?.message);
          });
        }
      } else {
        log("⚠️ ICE disconnected (may recover)...");
      }
      return;
    }
    
    // Only recreate on "failed" state - never on "disconnected"
    // "failed" means the connection definitely won't work
    // BUT: if we have a remote stream, don't recreate - the stream proves connection works
    if (state === "failed" && !isRecreatingPeer && !hasConnected) {
      const hasRemoteStream = remoteVideo && remoteVideo.srcObject;
      if (hasRemoteStream) {
        log("⚠️ ICE failed but remote stream exists - connection is working, not recreating");
        hasConnected = true; // Mark as connected since we have a stream
        return;
      }
      
      if (ws && ws.readyState === WebSocket.OPEN && peer) {
        log(`♻️ ICE connection failed, will recreate peer after delay...`);
        isRecreatingPeer = true;
        setTimeout(() => {
          // Check again if we have a stream before recreating
          const stillHasRemoteStream = remoteVideo && remoteVideo.srcObject;
          if (!hasConnected && peer && !stillHasRemoteStream) {
            log(`♻️ ICE connection failed, recreating peer...`);
            isRecreatingPeer = false;
            initPeer();
          } else {
            if (stillHasRemoteStream) {
              log("✅ Remote stream appeared, connection is working - not recreating");
              hasConnected = true;
            }
            isRecreatingPeer = false;
          }
        }, CONFIG.PEER_RECREATE_DELAY * 2); // Longer delay for ICE failures
      }
    }
  });

  // Add stream after all handlers are set up
  // For initiator (host), this will trigger offer generation
  // For non-initiator (client), this prepares peer to receive offer
  peer.addStream(stream);
  log("📹 Stream added to peer connection");
  
  // If we're the initiator (host), SimplePeer will automatically generate an offer
  // If we're not the initiator (client), we wait for the offer from the host
  if (isHost) {
    log("📤 Host: Waiting for offer to be generated...");
  } else {
    log("📥 Client: Waiting for offer from host...");
  }

  // Process any queued incoming signals IMMEDIATELY and SYNCHRONOUSLY
  // This is critical - signals must be processed right away for fastest connection
  // Note: We only filter stale answers when peer doesn't exist (handled above)
  // Once peer exists, we process all signals normally (including answers for host during normal flow)
  if (queuedIncomingSignals.length > 0) {
    log(`⚡ Processing ${queuedIncomingSignals.length} queued signals immediately...`);
    log(`📋 Queued signals: ${queuedIncomingSignals.map(s => s.type || 'candidate').join(', ')}`);
    // Process signals synchronously, in order - no delays
    const signalsToProcess = [...queuedIncomingSignals];
    queuedIncomingSignals = [];
    let processedCount = 0;
    signalsToProcess.forEach((signal) => {
      try {
        log(`📥 Processing queued signal ${processedCount + 1}/${signalsToProcess.length}: ${signal.type || 'candidate'}`);
        peer.signal(signal);
        processedCount++;
        log(`✅ Successfully processed queued signal: ${signal.type || 'candidate'}`);
      } catch (err) {
        console.error(`❌ Error processing queued signal ${signal.type || 'candidate'}:`, err);
      }
    });
    log(`✅ Finished processing ${processedCount}/${signalsToProcess.length} queued signals`);
  } else {
    log(`📋 No queued signals to process`);
  }
}

// ====== Waiting Screen Setup ======
// Set up meeting link immediately when page loads (room ID is known from URL)
if (meetingLinkInput) {
  const meetingUrl = `${window.location.origin}/room?id=${room}`;
  meetingLinkInput.value = meetingUrl;
  log("🔗 Meeting link ready:", meetingUrl);
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
    // Enumerate devices - this should NOT request permission if we already have a stream
    // Only call this if we already have localStream to avoid permission prompts
    if (!localStream) {
      log("⚠️ Cannot enumerate cameras - no active stream (permission might be needed)");
      return [];
    }
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(device => device.kind === 'videoinput');
    
    // If we have device labels, we have permission
    if (cameras.length > 0 && cameras[0].label) {
      return cameras;
    }
    
    // If no labels but we have a stream, we still have permission - return cameras anyway
    // On some mobile browsers, labels might not be available even with permission
    return cameras;
  } catch (err) {
    console.error("Error enumerating cameras:", err);
    return [];
  }
}

// Function to switch to a specific camera by deviceId
async function switchToCamera(deviceId) {
  if (!localStream || !deviceId) return;
  
  // Check if this is already the current camera
  const currentTrack = localStream.getVideoTracks()[0];
  const currentSettings = currentTrack?.getSettings();
  if (currentSettings?.deviceId === deviceId) {
    log("ℹ️ Camera is already selected, no need to switch");
    return;
  }
  
  try {
    log(`📹 Switching to camera: ${deviceId}`);
    
    // IMPORTANT: Stop the old video track FIRST before requesting a new one
    // This prevents "camera in use" errors and ensures we can switch cameras smoothly
    const oldVideoTrack = localStream.getVideoTracks()[0];
    let oldTrackStopped = false;
    if (oldVideoTrack) {
      log("🛑 Stopping old video track before switching...");
      oldVideoTrack.stop();
      oldTrackStopped = true;
      // Small delay to ensure track is fully released before requesting new one
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Get new video track with selected camera
    // IMPORTANT: We already have camera permission from the initial getUserMedia call
    // Only request video (no audio) to ensure we're reusing permission, not requesting new one
    // Use simple deviceId constraint - should work on most devices without multiple attempts
    log("📹 Requesting new camera stream...");
    
    // Add timeout to prevent hanging
    const getUserMediaPromise = navigator.mediaDevices.getUserMedia({
      video: { 
        deviceId: deviceId, // Simple deviceId - works on most devices
        width: CONFIG.VIDEO.width,
        height: CONFIG.VIDEO.height
      }
      // No audio property - reusing existing permission
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("getUserMedia timeout after 10 seconds")), 10000);
    });
    
    const newStream = await Promise.race([getUserMediaPromise, timeoutPromise]);
    log("✅ New camera stream obtained");
    
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
      console.error("Failed to get new video track");
      newStream.getTracks().forEach(track => track.stop());
      return;
    }
    
    // Get existing audio track from current stream
    const audioTrack = localStream.getAudioTracks()[0];
    
    // Create a new MediaStream with the new video track and existing audio track
    const updatedStream = new MediaStream();
    updatedStream.addTrack(newVideoTrack);
    if (audioTrack) {
      updatedStream.addTrack(audioTrack);
    }
    
    // IMPORTANT: Replace track in peer connection FIRST, before updating local stream
    // This ensures continuity and prevents black screen
    if (peer && peer._pc) {
      const sender = peer._pc.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
        log("✅ Video track replaced in peer connection");
      } else {
        logWarn("No video sender found in peer connection");
      }
    }
    
    // Replace the entire stream in the video element
    // This is more reliable than trying to modify the existing stream
    localStream = updatedStream;
    localVideo.srcObject = updatedStream;
    
    // Ensure video plays with new stream
    const playPromise = localVideo.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        logWarn("⚠️ Error playing local video after camera switch:", err);
      });
    }
    
    // Stop the temporary stream tracks (we only needed the video track)
    newStream.getTracks().forEach(track => {
      if (track !== newVideoTrack) {
        track.stop();
      }
    });
    
    log("✅ Local stream updated with new camera");
    
    // Update current camera index
    const cameraIndex = availableCameras.findIndex(cam => cam.deviceId === deviceId);
    if (cameraIndex !== -1) {
      currentCameraIndex = cameraIndex;
    }
    
    log(`📹 Switched to camera: ${availableCameras.find(cam => cam.deviceId === deviceId)?.label || 'Camera'}`);
  } catch (err) {
    // Log detailed error information
    const errorDetails = {
      name: err?.name || 'Unknown',
      message: err?.message || String(err),
      code: err?.code || 'N/A',
      constraint: err?.constraint || 'N/A',
      deviceId: deviceId
    };
    logWarn("❌ Error switching camera:", errorDetails);
    console.error("Error switching camera - details:", errorDetails);
    console.error("Error switching camera - full error:", err);
    
    // Provide user-friendly error message
    let errorMessage = "Failed to switch camera.";
    if (err?.name === "NotReadableError" || err?.name === "TrackStartError") {
      errorMessage = "Camera is in use by another application. Please close other apps using the camera and try again.";
    } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
      errorMessage = "Camera not found. The selected camera may have been disconnected.";
    } else if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
      errorMessage = "Camera permission denied. Please allow camera access and try again.";
    } else if (err?.name === "OverconstrainedError") {
      errorMessage = "Camera constraints not supported. Trying a different approach...";
      // Try with minimal constraints as fallback (only if OverconstrainedError)
      try {
        log("🔄 Trying fallback: minimal constraints...");
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: deviceId }
          // No audio property - reusing existing permission
        });
        const fallbackTrack = fallbackStream.getVideoTracks()[0];
        if (fallbackTrack) {
          // Use the fallback track
          const audioTrack = localStream.getAudioTracks()[0];
          const updatedStream = new MediaStream();
          updatedStream.addTrack(fallbackTrack);
          if (audioTrack) {
            updatedStream.addTrack(audioTrack);
          }
          
          if (peer && peer._pc) {
            const sender = peer._pc.getSenders().find(s => 
              s.track && s.track.kind === 'video'
            );
            if (sender) {
              await sender.replaceTrack(fallbackTrack);
            }
          }
          
          const oldVideoTrack = localStream.getVideoTracks()[0];
          if (oldVideoTrack) {
            oldVideoTrack.stop();
          }
          
          localStream = updatedStream;
          localVideo.srcObject = updatedStream;
          fallbackStream.getTracks().forEach(track => {
            if (track !== fallbackTrack) {
              track.stop();
            }
          });
          log("✅ Camera switched using fallback method");
          return; // Success with fallback
        }
      } catch (fallbackErr) {
        logWarn("❌ Fallback method also failed:", fallbackErr?.message || fallbackErr);
      }
    }
    
    alert(errorMessage);
  }
}

// Function to show camera selection dialog
async function showCameraSelection() {
  if (!localStream) {
    alert("No active video stream.");
    return;
  }
  
  try {
    // Re-enumerate cameras to ensure we have the latest list with labels
    const cameras = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = cameras.filter(device => device.kind === 'videoinput');
    
    if (videoInputs.length < 2) {
      alert("Only one camera is available.");
      return;
    }
    
    // Update available cameras list
    availableCameras = videoInputs;
    
    // Get current camera ID
    const currentTrack = localStream.getVideoTracks()[0];
    const currentSettings = currentTrack?.getSettings();
    const currentCameraId = currentSettings?.deviceId;
    
    // Create a simple selection dialog
    const dialog = document.createElement('div');
    dialog.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
      background: white;
      padding: 2rem;
      border-radius: 12px;
      max-width: 90%;
      max-height: 80%;
      overflow-y: auto;
    `;
    
    const title = document.createElement('h3');
    title.textContent = 'Select Camera';
    title.style.cssText = 'margin: 0 0 1rem 0; color: #333;';
    content.appendChild(title);
    
    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
    
    videoInputs.forEach((cam, index) => {
      const button = document.createElement('button');
      const label = cam.label || `Camera ${index + 1}`;
      const isCurrent = cam.deviceId === currentCameraId;
      button.textContent = label + (isCurrent ? ' (Current)' : '');
      button.style.cssText = `
        padding: 1rem;
        border: 2px solid ${isCurrent ? '#667eea' : '#ddd'};
        background: ${isCurrent ? '#f0f0ff' : 'white'};
        border-radius: 8px;
        cursor: pointer;
        font-size: 1rem;
        text-align: left;
      `;
      button.onclick = async () => {
        document.body.removeChild(dialog);
        await switchToCamera(cam.deviceId);
      };
      list.appendChild(button);
    });
    
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = `
      margin-top: 1rem;
      padding: 0.75rem 1.5rem;
      border: 2px solid #ddd;
      background: white;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1rem;
      width: 100%;
    `;
    cancel.onclick = () => {
      document.body.removeChild(dialog);
    };
    
    content.appendChild(list);
    content.appendChild(cancel);
    dialog.appendChild(content);
    document.body.appendChild(dialog);
    
    // Close on backdrop click
    dialog.onclick = (e) => {
      if (e.target === dialog) {
        document.body.removeChild(dialog);
      }
    };
  } catch (err) {
    console.error("Error showing camera selection:", err);
    alert("Failed to load cameras. Please try again.");
  }
}

// ====== Controls ======
const btnMute = document.getElementById("btn-mute");
const btnCamera = document.getElementById("btn-camera");
btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnLeave = document.getElementById("btn-leave");
const btnCopyLogs = document.getElementById("btn-copy-logs");

// Hide fullscreen button on mobile (when switch camera button is visible)
// Fullscreen doesn't work well on mobile browsers
if (btnFullscreen) {
  // Check if we're on mobile by screen size or user agent
  const isMobile = window.innerWidth <= 768 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  if (isMobile) {
    btnFullscreen.style.display = "none";
    log("📱 Mobile device detected - hiding fullscreen button");
  }
  
  // Also hide fullscreen when switch camera button is visible (mobile with multiple cameras)
  const checkButtonVisibility = () => {
    if (btnSwitchCamera && btnSwitchCamera.style.display !== "none" && btnSwitchCamera.style.display !== "") {
      if (btnFullscreen) {
        btnFullscreen.style.display = "none";
        log("📱 Switch camera visible - hiding fullscreen button");
      }
    } else if (btnFullscreen && !isMobile) {
      // Show fullscreen on desktop if switch camera is not visible
      btnFullscreen.style.display = "block";
    }
  };
  
  // Check initially and whenever cameras are enumerated
  setTimeout(checkButtonVisibility, 500); // Check after cameras are enumerated
  
  // Observe switch camera button visibility changes
  if (btnSwitchCamera) {
    const observer = new MutationObserver(checkButtonVisibility);
    observer.observe(btnSwitchCamera, { attributes: true, attributeFilter: ['style'] });
  }
}

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
    await showCameraSelection();
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

if (btnCopyLogs) {
  btnCopyLogs.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const logsText = logHistory.join('\n');
      if (logsText) {
        await navigator.clipboard.writeText(logsText);
        log("📋 Logs copied to clipboard");
        btnCopyLogs.textContent = "Copied!";
        btnCopyLogs.classList.add("copied");
        setTimeout(() => {
          btnCopyLogs.textContent = "📋";
          btnCopyLogs.classList.remove("copied");
        }, 2000);
      } else {
        log("⚠️ No logs to copy");
        btnCopyLogs.textContent = "No logs";
        setTimeout(() => {
          btnCopyLogs.textContent = "📋";
        }, 2000);
      }
    } catch (err) {
      console.error("Error copying logs:", err);
      // Fallback: show in alert
      const logsText = logHistory.join('\n');
      if (logsText) {
        prompt("Copy these logs:", logsText);
      }
    }
  });
}

// ====== Start ======
console.log("🔵 Starting WebSocket connection...");
initWebSocket();
