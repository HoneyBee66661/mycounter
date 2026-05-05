const DETECTION_INTERVAL_MS = 210;
const TRACK_TTL_MS = 1100;
const IOU_THRESHOLD = 0.24;
const SCORE_THRESHOLD = 0.52;
const SCORE_THRESHOLD_CAPTURE = 0.35;
const IOU_THRESHOLD_CAPTURE = 0.35;
const CAPTURE_PASSES = 4;
const CAPTURE_ENSEMBLE_MIN_RATIO = 0.5;
const FIRST_POINT_CLOSE_DISTANCE = 22;
const DRAW_POINT_MIN_DISTANCE = 7;
const POLYGON_SIMPLIFY_DISTANCE = 5;
const SMOOTHING_ALPHA = 0.66;
const DEFAULT_MODE = "default";

const els = {
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#overlay"),
  liveCount: document.querySelector("#liveCount"),
  modelStatus: document.querySelector("#modelStatus"),
  messagePanel: document.querySelector("#messagePanel"),
  messageTitle: document.querySelector("#messageTitle"),
  messageText: document.querySelector("#messageText"),
  retryButton: document.querySelector("#retryButton"),
  lassoButton: document.querySelector("#lassoButton"),
  excludeButton: document.querySelector("#excludeButton"),
  galleryButton: document.querySelector("#galleryButton"),
  shutterButton: document.querySelector("#shutterButton"),
  flipButton: document.querySelector("#flipButton"),
  resetButton: document.querySelector("#resetButton"),
  galleryModal: document.querySelector("#galleryModal"),
  closeGallery: document.querySelector("#closeGallery"),
  galleryGrid: document.querySelector("#galleryGrid"),
};

const ctx = els.canvas.getContext("2d");

if (!ctx) {
  throw new Error("Canvas 2D context is unavailable in this browser.");
}

const state = {
  model: null,
  stream: null,
  running: false,
  detecting: false,
  capturePaused: false,
  lastDetectionAt: 0,
  nextTrackId: 1,
  tracks: [],
  countedTracks: [],
  mode: DEFAULT_MODE,
  lassoPolygons: [],
  excludePolygons: [],
  drawing: null,
  videoRect: { x: 0, y: 0, width: 1, height: 1, scaleX: 1, scaleY: 1 },
  facingMode: "environment",
  db: null,
};

function setStatus(text) {
  els.modelStatus.textContent = text;
}

function showMessage(title, text) {
  els.messageTitle.textContent = title;
  els.messageText.textContent = text;
  els.messagePanel.hidden = false;
}

function hideMessage() {
  els.messagePanel.hidden = true;
}

function refreshCountedTracks() {
  state.countedTracks = state.tracks.filter(isCountedTrack);
  els.liveCount.textContent = String(state.countedTracks.length);
}

async function boot() {
  hideMessage();
  setStatus("Loading model...");

  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage("Camera unavailable", "This browser does not expose camera access.");
    setStatus("Camera not supported");
    return;
  }

  await initDB();

  try {
    if (!window.tf || !window.cocoSsd) {
      throw new Error("The detection libraries did not load. Check your connection and reload.");
    }

    await window.tf.ready();
    state.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
    setStatus("Starting camera...");
    await startCamera();
    state.running = true;
    setStatus("Detecting objects");
    requestAnimationFrame(renderLoop);
    detectionLoop();
  } catch (error) {
    console.error(error);
    setStatus("Setup failed");
    showMessage("Setup failed", error.message || "Could not start the object counter.");
  }
}

async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ObjectCounterDB", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      state.db = request.result;
      resolve();
    };
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("captures")) {
        db.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
      }
    };
  });
}

async function saveCapture(dataUrl) {
  if (!state.db) return;
  const transaction = state.db.transaction(["captures"], "readwrite");
  const store = transaction.objectStore("captures");
  store.add({ dataUrl, timestamp: Date.now() });
}

async function getCaptures() {
  if (!state.db) return [];
  return new Promise((resolve) => {
    const transaction = state.db.transaction(["captures"], "readonly");
    const store = transaction.objectStore("captures");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result.reverse());
    request.onerror = () => resolve([]);
  });
}

async function deleteCapture(id) {
  if (!state.db) return;
  const transaction = state.db.transaction(["captures"], "readwrite");
  const store = transaction.objectStore("captures");
  store.delete(id);
}

async function startCamera() {
  stopCamera();
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    throw new Error(
      error?.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access and retry."
        : "Could not access the camera on this device.",
    );
  }

  els.video.srcObject = state.stream;
  await els.video.play();
  resizeCanvas();
}

async function flipCamera() {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  try {
    await startCamera();
  } catch (error) {
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    console.error("Failed to flip camera:", error);
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  els.video.srcObject = null;
  state.stream = null;
}

async function detectionLoop() {
  if (!state.running) return;

  if (
    state.model &&
    !state.detecting &&
    !state.capturePaused &&
    els.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    const now = performance.now();
    if (now - state.lastDetectionAt >= DETECTION_INTERVAL_MS) {
      state.detecting = true;
      state.lastDetectionAt = now;
      try {
        const predictions = await state.model.detect(els.video);
        updateTracks(predictions, performance.now());
      } catch (error) {
        console.error(error);
        setStatus("Detection paused");
      } finally {
        state.detecting = false;
      }
    }
  }

  setTimeout(detectionLoop, DETECTION_INTERVAL_MS);
}

// Note: coco-ssd's detect() method handles tensor disposal internally via tf.tidy()

async function detectInFrame(canvas) {
  if (!state.model) return [];
  const allDetections = [];

  for (let i = 0; i < CAPTURE_PASSES; i++) {
    try {
      const predictions = await state.model.detect(canvas);
      predictions
        .filter((p) => p.score >= SCORE_THRESHOLD_CAPTURE)
        .forEach((p) => allDetections.push({ bbox: p.bbox, score: p.score }));
    } catch (error) {
      console.error("Capture detection pass failed:", error);
    }
  }

  if (allDetections.length === 0) return [];

  const clusters = clusterDetections(allDetections);
  const minPasses = Math.ceil(CAPTURE_PASSES * CAPTURE_ENSEMBLE_MIN_RATIO);

  return clusters
    .filter((c) => c.count >= minPasses)
    .map((c) => ({
      bbox: [
        c.bboxes.reduce((s, b) => s + b[0], 0) / c.bboxes.length,
        c.bboxes.reduce((s, b) => s + b[1], 0) / c.bboxes.length,
        c.bboxes.reduce((s, b) => s + b[2], 0) / c.bboxes.length,
        c.bboxes.reduce((s, b) => s + b[3], 0) / c.bboxes.length,
      ],
      score: c.scores.reduce((a, b) => a + b, 0) / c.scores.length,
    }))
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

function clusterDetections(detections) {
  const clusters = [];

  for (const det of detections) {
    let bestCluster = null;
    let bestIou = 0;

    for (const cluster of clusters) {
      for (const cbox of cluster.bboxes) {
        const overlap = iou(det.bbox, cbox);
        if (overlap > bestIou) {
          bestIou = overlap;
          bestCluster = cluster;
        }
      }
    }

    if (bestCluster && bestIou >= IOU_THRESHOLD_CAPTURE) {
      bestCluster.bboxes.push(det.bbox);
      bestCluster.scores.push(det.score);
      bestCluster.count++;
    } else {
      clusters.push({ bboxes: [det.bbox], scores: [det.score], count: 1 });
    }
  }

  return clusters;
}

function updateTracks(predictions, now) {
  const detections = predictions
    .filter((item) => item.score >= SCORE_THRESHOLD)
    .map((item) => ({
      bbox: item.bbox,
      label: item.class,
      score: item.score,
      matched: false,
    }));

  for (const track of state.tracks) {
    let bestDetection = null;
    let bestIou = 0;

    for (const detection of detections) {
      if (detection.matched) continue;
      const overlap = iou(track.bbox, detection.bbox);
      if (overlap > bestIou) {
        bestIou = overlap;
        bestDetection = detection;
      }
    }

    if (bestDetection && bestIou >= IOU_THRESHOLD) {
      track.bbox = smoothBbox(track.bbox, bestDetection.bbox);
      track.label = bestDetection.label;
      track.score = bestDetection.score;
      track.updatedAt = now;
      bestDetection.matched = true;
    }
  }

  for (const detection of detections) {
    if (!detection.matched) {
      state.tracks.push({
        id: state.nextTrackId++,
        bbox: detection.bbox,
        label: detection.label,
        score: detection.score,
        updatedAt: now,
      });
    }
  }

  state.tracks = state.tracks.filter((track) => now - track.updatedAt <= TRACK_TTL_MS);
  refreshCountedTracks();
}

function smoothBbox(previous, next) {
  return previous.map((value, index) => value * SMOOTHING_ALPHA + next[index] * (1 - SMOOTHING_ALPHA));
}

function iou(a, b) {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

function isCountedTrack(track) {
  const center = bboxCenter(track.bbox);
  const inExclude = state.excludePolygons.some((polygon) => pointInPolygon(center, polygon));
  if (inExclude) return false;
  if (state.lassoPolygons.length === 0) return true;
  return state.lassoPolygons.some((polygon) => pointInPolygon(center, polygon));
}

function bboxCenter(bbox) {
  return { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] / 2 };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function renderLoop() {
  resizeCanvas();
  drawOverlay();
  if (state.running) requestAnimationFrame(renderLoop);
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width;
    els.canvas.height = height;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.videoRect = getVideoDrawRect(rect.width, rect.height);
}

function getVideoDrawRect(canvasWidth, canvasHeight) {
  const videoWidth = els.video.videoWidth || canvasWidth;
  const videoHeight = els.video.videoHeight || canvasHeight;
  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    x: (canvasWidth - width) / 2,
    y: (canvasHeight - height) / 2,
    width,
    height,
    scaleX: width / videoWidth,
    scaleY: height / videoHeight,
  };
}

function drawOverlay() {
  const cssWidth = els.canvas.clientWidth;
  const cssHeight = els.canvas.clientHeight;
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  drawPolygons(state.lassoPolygons, "#47f08b", "rgba(71, 240, 139, 0.16)");
  drawPolygons(state.excludePolygons, "#ff6464", "rgba(255, 100, 100, 0.18)");

  if (state.drawing?.points.length) {
    const color = state.drawing.type === "exclude" ? "#ff6464" : "#47f08b";
    drawPath(state.drawing.points, color, true);
  }

  state.countedTracks.forEach((track) => drawTrack(track));
}

function drawPolygons(polygons, stroke, fill) {
  polygons.forEach((polygon) => {
    const points = polygon.map(videoToCanvasPoint);
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
}

function drawPath(points, color, showCloseTarget = false) {
  const mapped = points.map(videoToCanvasPoint);
  ctx.beginPath();
  ctx.moveTo(mapped[0].x, mapped[0].y);
  mapped.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 7]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (showCloseTarget && mapped.length > 2) {
    ctx.beginPath();
    ctx.arc(mapped[0].x, mapped[0].y, FIRST_POINT_CLOSE_DISTANCE / 2, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawTrack(track) {
  const box = videoBboxToCanvas(track.bbox);
  ctx.strokeStyle = "#47f08b";
  ctx.lineWidth = 2;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const idText = `#${track.id}`;
  ctx.font = "12px ui-monospace, Consolas, monospace";
  const labelWidth = ctx.measureText(idText).width + 10;
  ctx.fillStyle = "rgba(14, 18, 22, 0.82)";
  ctx.fillRect(box.x, box.y, labelWidth, 20);
  ctx.fillStyle = "#47f08b";
  ctx.fillText(idText, box.x + 5, box.y + 14);
}

function canvasToVideoPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  const clientX = event.clientX ?? event.touches?.[0]?.clientX;
  const clientY = event.clientY ?? event.touches?.[0]?.clientY;
  const x = (clientX - rect.left - state.videoRect.x) / state.videoRect.scaleX;
  const y = (clientY - rect.top - state.videoRect.y) / state.videoRect.scaleY;
  return {
    x: clamp(x, 0, els.video.videoWidth || rect.width),
    y: clamp(y, 0, els.video.videoHeight || rect.height),
  };
}

function videoToCanvasPoint(point) {
  return {
    x: state.videoRect.x + point.x * state.videoRect.scaleX,
    y: state.videoRect.y + point.y * state.videoRect.scaleY,
  };
}

function videoBboxToCanvas(bbox) {
  const point = videoToCanvasPoint({ x: bbox[0], y: bbox[1] });
  return {
    x: point.x,
    y: point.y,
    width: bbox[2] * state.videoRect.scaleX,
    height: bbox[3] * state.videoRect.scaleY,
  };
}

function setMode(mode) {
  state.mode = state.mode === mode ? DEFAULT_MODE : mode;
  state.drawing = null;
  updateButtons();
}

function updateButtons() {
  els.lassoButton.setAttribute("aria-pressed", String(state.mode === "lasso"));
  els.excludeButton.setAttribute("aria-pressed", String(state.mode === "exclude"));
}

function beginDrawing(point) {
  if (state.mode !== "lasso" && state.mode !== "exclude") return;
  state.drawing = { type: state.mode, points: [point], lastPoint: point };
  updateButtons();
}

function addDrawingPoint(point) {
  if (!state.drawing) return;
  const last = state.drawing.lastPoint;
  if (distance(last, point) < DRAW_POINT_MIN_DISTANCE) return;
  state.drawing.points.push(point);
  state.drawing.lastPoint = point;

  if (state.drawing.points.length > 3) {
    const firstCanvas = videoToCanvasPoint(state.drawing.points[0]);
    const currentCanvas = videoToCanvasPoint(point);
    if (distance(firstCanvas, currentCanvas) <= FIRST_POINT_CLOSE_DISTANCE) {
      closeDrawing();
    }
  }
  updateButtons();
}

function closeDrawing() {
  if (!state.drawing || state.drawing.points.length < 3) return;
  const polygon = simplifyPolygon(state.drawing.points);
  if (polygon.length >= 3) {
    if (state.drawing.type === "exclude") {
      state.excludePolygons.push(polygon);
    } else {
      state.lassoPolygons.push(polygon);
    }
    navigator.vibrate?.(18);
  }
  state.drawing = null;
  refreshCountedTracks();
  updateButtons();
}

function simplifyPolygon(points) {
  const simplified = [];
  points.forEach((point) => {
    const last = simplified[simplified.length - 1];
    if (!last || distance(last, point) >= POLYGON_SIMPLIFY_DISTANCE) simplified.push(point);
  });
  return simplified;
}

function undoLastPolygon() {
  if (state.drawing) {
    state.drawing = null;
    updateButtons();
    return;
  }
  if (state.mode === "exclude" && state.excludePolygons.length) {
    state.excludePolygons.pop();
  } else if (state.lassoPolygons.length) {
    state.lassoPolygons.pop();
  } else if (state.excludePolygons.length) {
    state.excludePolygons.pop();
  }
  refreshCountedTracks();
  updateButtons();
}

function resetRegions() {
  state.mode = DEFAULT_MODE;
  state.drawing = null;
  state.lassoPolygons = [];
  state.excludePolygons = [];
  refreshCountedTracks();
  updateButtons();
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pointerDown(event) {
  if (state.mode !== "lasso" && state.mode !== "exclude") return;
  event.preventDefault();
  els.canvas.setPointerCapture?.(event.pointerId);
  beginDrawing(canvasToVideoPoint(event));
}

function pointerMove(event) {
  if (!state.drawing) return;
  event.preventDefault();
  addDrawingPoint(canvasToVideoPoint(event));
}

function pointerUp(event) {
  if (!state.drawing) return;
  event.preventDefault();
  addDrawingPoint(canvasToVideoPoint(event));
}

async function captureImage() {
  const videoReady = els.video.videoWidth > 0 && els.video.videoHeight > 0 && els.video.readyState >= 2;
  if (!videoReady) return;
  state.capturePaused = true;
  setStatus("Analyzing...");

  const canvas = document.createElement("canvas");
  canvas.width = els.video.videoWidth;
  canvas.height = els.video.videoHeight;
  const captureCtx = canvas.getContext("2d");
  captureCtx.drawImage(els.video, 0, 0, canvas.width, canvas.height);

  const detections = await detectInFrame(canvas);

  if (detections.length > 0) {
    drawCaptureMarkers(captureCtx, detections, canvas.width, canvas.height);
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  await saveCapture(dataUrl);
  downloadCanvas(canvas);
  navigator.vibrate?.([20, 30, 20]);
  setStatus("Detecting objects");
  state.capturePaused = false;
}

async function openGallery() {
  const captures = await getCaptures();
  els.galleryGrid.innerHTML = "";
  
  if (captures.length === 0) {
    els.galleryGrid.innerHTML = '<div class="gallery-empty">No captures yet</div>';
  } else {
    captures.forEach((capture) => {
      const item = document.createElement("div");
      item.className = "gallery-item";
      item.innerHTML = `
        <img src="${capture.dataUrl}" alt="Capture">
        <button class="delete-btn" data-id="${capture.id}">X</button>
      `;
      item.querySelector("img").addEventListener("click", () => window.open(capture.dataUrl, "_blank"));
      item.querySelector(".delete-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteCapture(capture.id);
        item.remove();
      });
      els.galleryGrid.appendChild(item);
    });
  }
  
  els.galleryModal.hidden = false;
}

function closeGalleryModal() {
  els.galleryModal.hidden = true;
}

function drawCaptureMarkers(captureCtx, tracks, width, height) {
  captureCtx.lineWidth = Math.max(2, width / 640);
  captureCtx.strokeStyle = "#18d66a";

  const centers = tracks.map((track) => bboxCenter(track.bbox));
  tracks.forEach((track, index) => {
    const [x, y, w, h] = track.bbox;
    captureCtx.strokeRect(x, y, w, h);

    const closeNeighbor = centers.some(
      (center, otherIndex) =>
        otherIndex !== index && distance(center, centers[index]) < 1.5 * ((w + tracks[otherIndex].bbox[2]) / 2),
    );
    const fontSize = closeNeighbor ? Math.max(11, width * 0.015) : Math.max(14, width * 0.02);
    const marker = String(index + 1);
    captureCtx.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    const pad = Math.max(5, fontSize * 0.38);
    const textWidth = captureCtx.measureText(marker).width;
    const markerWidth = textWidth + pad * 2;
    const markerHeight = fontSize + pad * 1.5;
    const markerX = clamp(x + w - markerWidth - pad, pad, width - markerWidth - pad);
    const markerY = clamp(y + pad, pad, height - markerHeight - pad);

    captureCtx.fillStyle = "rgba(16, 20, 24, 0.84)";
    captureCtx.fillRect(markerX, markerY, markerWidth, markerHeight);
    captureCtx.strokeStyle = "#18d66a";
    captureCtx.strokeRect(markerX, markerY, markerWidth, markerHeight);
    captureCtx.fillStyle = "#f6fff9";
    captureCtx.fillText(marker, markerX + pad, markerY + fontSize + pad * 0.25);
  });

  const total = `Total: ${tracks.length}`;
  const fontSize = Math.max(24, width * 0.035);
  captureCtx.font = `800 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const pad = Math.max(12, fontSize * 0.45);
  const totalWidth = captureCtx.measureText(total).width + pad * 2;
  const totalHeight = fontSize + pad * 1.3;
  const x = width - totalWidth - pad;
  const y = height - totalHeight - pad;
  captureCtx.fillStyle = "rgba(16, 20, 24, 0.82)";
  captureCtx.fillRect(x, y, totalWidth, totalHeight);
  captureCtx.fillStyle = "#47f08b";
  captureCtx.fillText(total, x + pad, y + fontSize + pad * 0.18);
}

function downloadCanvas(canvas) {
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.download = `object-count-${timestamp}.jpg`;
  link.href = canvas.toDataURL("image/jpeg", 0.92);
  link.click();
}

function handlePointerCancel() {
  state.drawing = null;
  updateButtons();
}

function bindEvents() {
  els.lassoButton.addEventListener("click", () => setMode("lasso"));
  els.excludeButton.addEventListener("click", () => setMode("exclude"));
  els.shutterButton.addEventListener("click", captureImage);
  els.flipButton.addEventListener("click", flipCamera);
  els.galleryButton.addEventListener("click", openGallery);
  els.closeGallery.addEventListener("click", closeGalleryModal);
  els.resetButton.addEventListener("click", resetRegions);
  els.retryButton.addEventListener("click", boot);
  els.canvas.addEventListener("pointerdown", pointerDown);
  els.canvas.addEventListener("pointermove", pointerMove);
  els.canvas.addEventListener("pointerup", pointerUp);
  els.canvas.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.drawing) {
        state.drawing = null;
        updateButtons();
      } else if (!els.galleryModal.hidden) {
        closeGalleryModal();
      }
    }
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}

bindEvents();
boot();
