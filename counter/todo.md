# Object Counter Web App – High‑Level Specification for AI Code Generation

This document is a complete, high‑level specification for building a fast, lightweight, camera‑based object counting web application. It is designed to be given to an AI coding agent (e.g., Codex) to implement the entire app. No concrete code is provided – the agent is free to make architectural and implementation decisions as long as all features and constraints are met.

---

## 1. Purpose

Build a Progressive Web App that:
- Uses the smartphone’s rear camera to show a live video stream.
- Detects common objects in real‑time.
- Allows the user to draw lasso and exclusion regions to control which objects are counted.
- Displays a live count of currently tracked objects.
- On capture, generates a downloadable still image with numbered markers around each counted object and the total count.

---

## 2. Core Features

### 2.1 Camera
- Access the rear camera (`facingMode: 'environment'`) using the browser’s MediaDevices API.
- The video must fill the viewport and be muted/playsinline (no audio).
- Handle camera permission denial gracefully.

### 2.2 Real‑time Object Detection
- Use a client‑side machine‑learning model for general object detection (capable of recognizing everyday items). The model must be loaded once and run in the browser.
- Detection should run on frames from the live video at a regular interval (e.g., every 200ms) to keep UI smooth.

### 2.3 Object Tracking
- Each detection must be matched across frames to generate stable, persistent IDs.
- A simple centroid‑based tracker (e.g., IOU matching) is sufficient.
- Untracked objects should be removed after a short timeout (~1 second).
- Bounding box positions may be smoothed (optional).

### 2.4 Counting Modes & Spatial Filtering

**Default Mode**  
If no lasso regions are drawn, every detected and tracked object is counted, **except** those whose centre falls inside any exclusion polygon.

**Lasso Mode**  
When the user draws one or more lasso polygons:
- Only objects whose centre is inside **any** lasso polygon are eligible for counting.
- Additionally, an object is excluded if its centre falls inside any exclusion polygon (just like default mode).

**Exclude Mode**  
When the user activates the Exclude tool, they can draw exclusion polygons. This mode does not change the counting rule – it simply adds new exclusion polygons. The counting rule remains: objects are counted unless inside an exclusion region. In Lasso mode, they must also be inside a lasso region.

**Important:** multiple lasso and multiple exclusion polygons can coexist and all are considered using OR logic (for lasso: inside any lasso polygon counts; for exclude: inside any exclude polygon discards).

### 2.5 Drawing Tools – Lasso & Exclude

- The user must be able to manually draw closed polygons on a transparent canvas overlay directly over the video stream.
- **Lasso polygon** – drawn to mark a region of interest (objects inside will be counted).
- **Exclusion polygon** – drawn to mark a region to ignore (objects inside will be removed from the count).
- Drawing interaction:
  - Touch/drag to place points.
  - Visual feedback: a semi‑transparent line while drawing.
  - Polygon closed by either touching the first point again or via a dedicated “Close” button.
  - Closed polygons are filled with a light, semi‑transparent colour (e.g., green for lasso, red for exclusion).
- Undo: ability to remove the last drawn polygon.
- Reset: clear all polygons and return to Default mode.

### 2.6 Live Visual Feedback

- For each **counted** object, draw a **thin green outline** around its bounding box. The outline may be a rectangle or a rounded rectangle – keep it simple.
- Optionally, display a small identifier (the tracked object’s stable ID) inside the box.
- Non‑counted objects should **not** be drawn.
- The current drawing path of an active tool (lasso/exclude) must be shown.
- A small counter display (like an FPS counter) must be visible at one corner of the screen showing the current number of counted objects. Update it in real‑time.
- The canvas overlay must be resized to match the video dimensions and redrawn efficiently (using `requestAnimationFrame`).

### 2.7 Capture & Download

- A capture button stops the detection loop momentarily, generates a high‑resolution still image, and then immediately resumes detection.
- The captured image must:
  - Show the current video frame.
  - For each counted object, draw its bounding box (thin green) and a **numbered marker** (1, 2, 3, …) near the top‑right corner of the box.
  - Adapt marker font size and position if multiple boxes are overlapping or very close – the goal is to keep numbers readable without collision. Pad the marker from the box edge; shrink font size if the distance between box centres is below a threshold.
  - Display the total count prominently in a bottom corner (e.g., “Total: 7”) with a semi‑transparent background.
- The final composed image is downloaded automatically as a JPEG (or PNG). No server upload – all done on the client via canvas.

---

## 3. Technical Constraints & Environment

- **Client‑side only** – no backend, no API calls except for loading the ML model from a CDN.
- **Offline & PWA ready** – static assets only, no server‑side rendering needed.
- Must run on modern **smartphone browsers** (iOS Safari, Android Chrome) that support `getUserMedia` and WebGL.
- Must be served over HTTPS (required for camera access).
- Lightweight – initial load should be as small as possible; detection model should be the smallest viable variant.
- The app must be deployable to **Vercel** as a static site (SSG/SPA).

---

## 4. Recommended Stack (Guidance)

The AI agent is free to choose the tech stack, but the following are well‑suited:

- **Framework**: Any SPA framework that can produce a static export – Next.js (with `output: 'export'`), Vite + React, or even vanilla HTML/JS.
- **ML Model**: TensorFlow.js with the **COCO‑SSD lite Mobilenet v2** model (small, fast, good accuracy). The model should be loaded asynchronously once.
- **Canvas**: HTML5 Canvas for all drawing (bounding boxes, tool polygons, capture composition).
- **State Management**: A simple central state (React Context, Vuex, or just a global object).
- **Styling**: Tailwind CSS or minimal custom CSS to keep the file size small.

The agent may choose any alternatives as long as the app remains fully client‑side and deployable as static files.

---

## 5. Architecture Guide (High‑Level)

The application logically consists of:

1. **Camera Module** – gets the media stream, provides the video element.
2. **Detection Engine** – loads the model, runs inference at intervals, returns raw detections.
3. **Object Tracker** – maintains a list of tracked objects with IDs, updates them using new detections.
4. **Spatial Filter** – applies the counting rules (point‑in‑polygon tests based on object centre) to decide which tracked objects are “counted”.
5. **Canvas Renderer** – draws the live overlay (bounding boxes of counted objects), tool polygons, and current drawing shape.
6. **Capture Module** – creates an offscreen canvas, composits video + numbered markers + total count, triggers download.
7. **UI Controls** – a toolbar with buttons for Lasso, Exclude, Capture, Reset. A floating counter display.
8. **State Store** – holds mode, list of lasso & exclusion polygons, current drawing state, list of tracked objects, and the live count.

All modules run in the browser’s main thread (the detection may use WebGL for acceleration, which is fine).

---

## 6. User Interaction Flow

1. App loads → shows a loading spinner while ML model downloads.
2. Model ready → asks for camera permission. On success → live video starts, detection begins, default mode counts all objects.
3. User sees green boxes around detected objects and a live count in the top‑right corner.
4. **Lasso**: Tap Lasso button (it highlights). Touch/draw a closed shape. Once closed, counting updates to only show objects inside that shape.
   - User can draw additional lasso polygons; they all act as OR regions.
5. **Exclude**: Tap Exclude button. Draw a closed shape. Objects whose centres fall inside any exclusion polygon are immediately removed from the count (and their boxes hidden).
   - Multiple exclusion polygons can exist.
6. **Reset**: clears all polygons and returns to default mode.
7. **Capture**: Tap Capture button. A brief freeze (barely noticeable) – a numbered JPEG is downloaded. The app continues live counting immediately after.
8. The counter display always reflects the current number of counted objects according to the active spatial filters.

---

## 7. Counting & Marker Logic – Detailed Rules

**Counting Decision (per tracked object)**  
Let `center` = centre of the bounding box.
- If in **default** mode:  
  `counted = NOT (center inside any exclude polygon)`
- If in **lasso** mode (at least one lasso polygon exists):  
  `counted = (center inside any lasso polygon) AND NOT (center inside any exclude polygon)`

If no lasso polygons exist but `mode` is “lasso” (user just activated the tool but hasn’t drawn anything yet), treat it as default mode until a lasso polygon is closed.

**Capture Marker Rules**  
- For each counted object in the current frame, assign an incremental number starting from 1 (order can be left‑to‑right, top‑to‑bottom, or arbitrary – the AI can decide).
- Each marker consists of:
  - Thin green outline around the object’s bounding box.
  - A number (e.g., “1”) placed near the top‑right corner of the box.  
- **Adaptive sizing**:
  - Default font size: ~14px.
  - If two bounding boxes are closer than a configurable distance (for example, if the distance between their centres is less than 1.5× the average width), reduce the font size for both numbers (e.g., to 10px) and possibly shift the label position inward.
  - If the box is too close to the image edge, shift the label inside the box.
- The overall total count is drawn at the bottom‑right with a semi‑transparent background and larger font (~24px).

---

## 8. Performance & UX Requirements

- **Detection interval**: 150–250ms. Adjust so that inference does not block UI rendering.
- **Canvas drawing**: use `requestAnimationFrame` to redraw only when necessary.
- Ensure TensorFlow.js tensors are properly disposed to avoid memory leaks.
- The app should feel responsive – no jank during detection.
- Initial model load time: show a progress indicator.
- All UI elements must be usable on small screens with touch input (minimum touch target size 48px).
- The counter display must be legible (monospaced font, contrasting background).

---

## 9. Deployment to Vercel

- Build the app as a **fully static** site (no server‑side functions).
- The output folder (e.g., `out/` or `dist/`) must contain an `index.html` that bootstraps the app.
- Vercel will serve it over HTTPS automatically.
- No environment variables are needed (unless the agent requires them for build steps).
- The agent may include a `vercel.json` if needed, but it is not mandatory.

---

## 10. Important Considerations for the AI Agent

- The app must handle cases where the user draws polygons that are outside the video frame – coordinates should be normalised so polygons resize with the video.
- The drawing canvas must be exactly the same size as the video element and positioned precisely over it.
- The model’s detection coordinates are in pixel units relative to the video’s intrinsic resolution – ensure mapping to the canvas is correct.
- Touch events must be supported for drawing; multi‑touch should not interfere with panning/zooming (prevent default on the canvas).
- The capture download filename should be something like `object-count-{timestamp}.jpg`.
- The AI is free to add small polish details (e.g., haptic feedback on capture, transitions) but must keep the app lightweight.

---

**End of specification.** The AI agent now has all the information required to build the complete web application, make design decisions, and produce production‑ready code.