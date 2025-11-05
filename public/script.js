// ====== Debug Flag ======
const DEBUG = true; // Set to true to enable verbose logging

// ====== Logging Utility ======
const log = (...args) => DEBUG && console.log(...args);
const logWarn = (...args) => DEBUG && console.warn(...args);

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
    if (!localStream) {
      log("🎥 Starting media stream immediately...");
      // Get media stream first, then we'll create peer when we know our role
      navigator.mediaDevices
        .getUserMedia({
          video: CONFIG.VIDEO,
          audio: CONFIG.AUDIO,
        })
        .then(async (stream) => {
          localStream = stream;
          localVideo.srcObject = stream;
          log("🎥 Local stream ready");
          
          // Show local video widget immediately
          if (localVideo) {
            localVideo.style.display = "block";
          }
          
          // If we're the host (will be confirmed by room-info), make waiting screen semi-transparent
          // so the video shows through while keeping the link widget visible
          if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
            waitingScreen.classList.add("host-streaming");
            log("✨ Making waiting screen semi-transparent so video shows through");
          }
          
          // Keep waiting screen visible - don't hide it yet
          // For host: we'll keep it visible until client joins (so they can share the link)
          // For client: it will be hidden when they connect or when room-info confirms host is active
          
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
          console.error("getUserMedia error:", err);
          // Show user-friendly error message
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            alert("Camera and microphone access is required.");
          } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
            alert("No camera or microphone found.");
          }
        });
    }
  });

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Handle room-info message from server
      if (data.type === "room-info") {
        isHost = data.isFirst;
        log(`📋 Room info: isFirst=${data.isFirst}, totalClients=${data.totalClients}`);
        log(`👤 Role: ${isHost ? "Host" : "Client"}`);
        
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
        if (!isHost && data.totalClients > 1 && waitingScreen) {
          log("👥 Host already active, hiding waiting screen...");
          waitingScreen.classList.add("hidden");
          // Ensure controls are visible
          if (controls) {
            controls.style.display = "flex";
            controls.style.visibility = "visible";
          }
        }
        
        // For host: if totalClients > 1, a client has joined - hide waiting screen
        if (isHost && data.totalClients > 1 && waitingScreen) {
          log("👥 Client has joined (totalClients > 1) - hiding waiting screen with link widget");
          waitingScreen.classList.add("hidden");
        }
        
        // Now that we know our role, create peer connection if we have a stream
        // (Stream might already be ready from WS open handler)
        if (localStream && !peer) {
          log(`⚡ ${isHost ? "Host" : "Client"} detected, creating peer connection with stream...`);
          createPeerConnection(localStream);
        } else if (!localStream && !peer) {
          // Stream not ready yet, start getting it
          log(`⚙️ ${isHost ? "Host" : "Client"} detected, starting peer setup...`);
          initPeer();
        }
        return;
      }
      
      // Handle WebRTC signals
      // Note: This handles late connections - if client connects 10+ minutes after host,
      // the host's peer might have closed, but we can recreate it when signals arrive
      if (!peer) {
        // Clear any stale remote stream from previous connection
        clearStaleRemoteStream();
        
        // For host (initiator) receiving answer when peer doesn't exist: this is likely a stale answer
        // from a previous connection. Ignore it and create peer to generate new offer.
        // For client (non-initiator): accept offers - we need them to connect
        if (data.type === "answer" && isHost) {
          log("⚠️ Ignoring stale answer from previous connection (host will generate new offer)");
          recreatePeerConnection();
          return;
        }
        
        log("🕓 Incoming signal queued (peer not ready yet):", data.type || "candidate");
        queuedIncomingSignals.push(data);
        
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
      
      try {
        log("📥 Processing signal:", data.type || "candidate");
        peer.signal(data);
      } catch (err) {
        // If peer was destroyed, we need to handle reconnection
        if (err.message && err.message.includes("destroyed")) {
          console.error("❌ Peer was destroyed, handling reconnection...");
          
          // Clear stale remote stream if it exists
          const hadStaleStream = clearStaleRemoteStream();
          
          // For host receiving answer: ignore it, will generate new offer
          // For client or other signals: queue them if no stale stream was cleared
          if (data.type === "answer" && isHost) {
            log("⚠️ Ignoring stale answer from previous connection (host will generate new offer)");
            recreatePeerConnection();
          } else if (!hadStaleStream) {
            // Only queue if we didn't have a stale stream (fresh connection attempt)
            if (!queuedIncomingSignals.includes(data)) {
              queuedIncomingSignals.push(data);
            }
            recreatePeerConnection();
          } else {
            // Had stale stream - recreate without queueing (stale signals already cleared)
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
      const oldPeer = peer;
      peer = null; // Set to null first to prevent close handler from recreating
      oldPeer.destroy();
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
    
    // Hide waiting screen when remote stream is received (client has joined)
    if (waitingScreen && !waitingScreen.classList.contains("hidden")) {
      log("👥 Client joined - hiding waiting screen with link widget");
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
  });
  
  peer.on("iceConnectionStateChange", (state) => {
    log("🧊 ICE conn:", state);
    
    // Handle successful connection
    if (state === "connected" || state === "completed") {
      hasConnected = true;
      log("✅ ICE connection established!");
      return;
    }
    
    // Handle "connecting" state - this is good, connection is being established
    if (state === "connecting") {
      log("🔄 ICE connecting...");
      return;
    }
    
    // "disconnected" is a normal intermediate state - allow it to recover
    if (state === "disconnected") {
      log("⚠️ ICE disconnected (may recover)...");
      return;
    }
    
    // Only recreate on "failed" state - never on "disconnected"
    // "failed" means the connection definitely won't work
    if (state === "failed" && !isRecreatingPeer && !hasConnected) {
      if (ws && ws.readyState === WebSocket.OPEN && peer) {
        log(`♻️ ICE connection failed, will recreate peer after delay...`);
        isRecreatingPeer = true;
        setTimeout(() => {
          if (!hasConnected && peer) {
            log(`♻️ ICE connection failed, recreating peer...`);
            isRecreatingPeer = false;
            initPeer();
          } else {
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
    // Process signals synchronously, in order - no delays
    const signalsToProcess = [...queuedIncomingSignals];
    queuedIncomingSignals = [];
    signalsToProcess.forEach((signal) => {
      try {
        log(`📥 Processing queued signal: ${signal.type || 'candidate'}`);
        peer.signal(signal);
      } catch (err) {
        console.error("Error processing queued signal:", err);
      }
    });
    log(`✅ Finished processing ${signalsToProcess.length} queued signals`);
  } else {
    log(`📋 No queued signals to process (${queuedIncomingSignals.length} queued)`);
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

// ====== Start ======
console.log("🔵 Starting WebSocket connection...");
initWebSocket();
