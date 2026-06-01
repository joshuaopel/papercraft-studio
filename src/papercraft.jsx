import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { writePsd } from 'ag-psd';
import JSZip from 'jszip';
import {
  Upload, Download, Sparkles, Box, Shirt, Sword, Trash2, Eye,
  Wand2, AlertCircle, Plus, X, Key, Hand, Crown, Shield, Loader2, Image as ImageIcon,
  Check, RefreshCw, Layers, FileArchive
} from 'lucide-react';

// ============================================================================
// PART TYPES
// ============================================================================
// Each part has a "kind" that determines its topology:
//   cube       — 6 faces, full cross unfold with tabs
//   flap       — 2 faces (Front/Back) with a connector tab on top, hangs flat
//   armor      — 4 faces (F/B/L/R), open top + bottom, fits OVER another cube
//   accessory  — single 2-sided cutout (sword, shield, hat) with a connector tab

const PART_KINDS = {
  cube: { faces: ['F', 'B', 'L', 'R', 'T', 'D'], label: 'Cube' },
  flap: { faces: ['F', 'B'], label: 'Flap' },
  armor: { faces: ['F', 'B', 'L', 'R'], label: 'Armor Shell' },
  accessory: { faces: ['F', 'B'], label: 'Accessory' },
};

const FACE_LABELS = {
  F: 'Front', B: 'Back', L: 'Left', R: 'Right', T: 'Top', D: 'Bottom',
};

// Preset templates — what gets added when you click "Add Part"
const AI_IMAGE_MODEL = 'gpt-image-1.5';
const ATLAS_SIZE = 1024;

// AI generation is parked until we have a model that can render each face properly.
// Toggle to true to surface the OpenAI panel again. The pipeline code below stays intact.
const AI_ENABLED = false;

const PART_PRESETS = {
  body:      { kind: 'cube', label: 'Character',  size: [45, 80, 45], icon: Box },
  armL:      { kind: 'flap', label: 'Left Arm',   size: [12, 40, 0],  icon: Hand },
  armR:      { kind: 'flap', label: 'Right Arm',  size: [12, 40, 0],  icon: Hand },
  armor:     { kind: 'armor',label: 'Armor/Tunic',size: [52, 45, 52], icon: Shirt },
  sword:     { kind: 'accessory', label: 'Sword', size: [10, 35, 0],  icon: Sword },
  shield:    { kind: 'accessory', label: 'Shield',size: [25, 30, 0],  icon: Shield },
  hat:       { kind: 'accessory', label: 'Hat/Crown', size: [30, 18, 0], icon: Crown },
};

// ============================================================================
// HELPERS
// ============================================================================

const mm = (v, dpi = 300) => (v / 25.4) * dpi;
let _idCounter = 0;
const nextId = () => `p${++_idCounter}`;

function defaultFaceColor(key) {
  const map = {
    F: '#e8d5a7', B: '#d4bf8f',
    L: '#dcc89a', R: '#dcc89a',
    T: '#c9b07a', D: '#b89e6a',
  };
  return map[key] || '#e8d5a7';
}

function newPart(presetKey, label) {
  const preset = PART_PRESETS[presetKey];
  const kind = PART_KINDS[preset.kind];
  const faces = {};
  kind.faces.forEach((k) => {
    faces[k] = { image: null, imageEl: null, color: defaultFaceColor(k) };
  });
  return {
    uid: nextId(),
    presetKey,
    kind: preset.kind,
    label: label || preset.label,
    size: [...preset.size],
    faces,
  };
}

// ============================================================================
// LAYOUT MATH — measures each part's true bounding box including tabs
// ============================================================================

function partMetrics(part, scale) {
  const [w, h, d] = part.size;
  const W = w * scale, H = h * scale, D = d * scale;

  if (part.kind === 'cube') {
    // tab size — use min dimension
    const TAB = Math.min(W, H, D) * 0.22;
    // cross width: L(D) + F(W) + R(D) + B(W) + outer tabs on L and B sides
    const crossW = D + W + D + W;
    const crossH = D + H + D; // T + F + D vertically
    // include tabs on outside (left of L, right of B, top of T, bottom of D)
    return {
      width: crossW + TAB * 2,
      height: crossH + TAB * 2,
      tab: TAB,
    };
  }

  if (part.kind === 'armor') {
    // 4 faces in a row: F | R | B | L  with side tab + top tab + bottom tab on all
    const TAB = Math.min(W, H, D) * 0.18;
    // armor is open top/bottom but we add small mounting tabs internally on top edge
    const armorW = W + D + W + D; // F + R + B + L
    return {
      width: armorW + TAB * 2,
      height: H + TAB * 2,
      tab: TAB,
    };
  }

  if (part.kind === 'flap' || part.kind === 'accessory') {
    // 2 faces side by side joined at top, with a glue tab on top of one
    const TAB = Math.min(W, H) * 0.25;
    return {
      width: W * 2 + TAB,
      height: H + TAB,
      tab: TAB,
    };
  }

  return { width: 100, height: 100, tab: 10 };
}

function layoutParts(parts, scale, padding = 50) {
  const layouts = [];
  let cursorY = padding;
  let maxW = 0;

  parts.forEach((part) => {
    const m = partMetrics(part, scale);
    layouts.push({
      part,
      x: padding,
      y: cursorY,
      ...m,
    });
    cursorY += m.height + padding;
    maxW = Math.max(maxW, m.width);
  });

  return {
    layouts,
    totalWidth: maxW + padding * 2,
    totalHeight: cursorY,
  };
}

// ============================================================================
// DRAWING — one function per part kind
// ============================================================================

function drawTab(ctx, edge, x, y, fw, fh, TAB) {
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255, 252, 240, 0.95)';
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);

  const inset = TAB * 0.4;
  if (edge === 'top') {
    ctx.moveTo(x, y);
    ctx.lineTo(x + inset, y - TAB);
    ctx.lineTo(x + fw - inset, y - TAB);
    ctx.lineTo(x + fw, y);
  } else if (edge === 'bottom') {
    ctx.moveTo(x, y + fh);
    ctx.lineTo(x + inset, y + fh + TAB);
    ctx.lineTo(x + fw - inset, y + fh + TAB);
    ctx.lineTo(x + fw, y + fh);
  } else if (edge === 'left') {
    ctx.moveTo(x, y);
    ctx.lineTo(x - TAB, y + inset);
    ctx.lineTo(x - TAB, y + fh - inset);
    ctx.lineTo(x, y + fh);
  } else if (edge === 'right') {
    ctx.moveTo(x + fw, y);
    ctx.lineTo(x + fw + TAB, y + inset);
    ctx.lineTo(x + fw + TAB, y + fh - inset);
    ctx.lineTo(x + fw, y + fh);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawFace(ctx, face, x, y, w, h, label, showLabels) {
  if (face.imageEl) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // Cover behavior — scale image to fill while preserving aspect
    const img = face.imageEl;
    const iAspect = img.width / img.height;
    const fAspect = w / h;
    let dw, dh, dx, dy;
    if (iAspect > fAspect) {
      dh = h;
      dw = h * iAspect;
      dx = x - (dw - w) / 2;
      dy = y;
    } else {
      dw = w;
      dh = w / iAspect;
      dx = x;
      dy = y - (dh - h) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.fillStyle = face.color;
    ctx.fillRect(x, y, w, h);
  }
  if (showLabels && label) {
    ctx.fillStyle = 'rgba(60,40,20,0.45)';
    ctx.font = `${Math.max(9, Math.min(w, h) * 0.13)}px Georgia`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2);
  }
}

function drawCube(ctx, part, originX, originY, scale, opts) {
  const [w, h, d] = part.size;
  const W = w * scale, H = h * scale, D = d * scale;
  const TAB = Math.min(W, H, D) * 0.22;

  // origin is top-left of bbox; the T face sits at (originX + TAB + D, originY + TAB)
  const fx = originX + TAB + D;
  const fy = originY + TAB + D;

  const faces = [
    [fx, fy - D, W, D, 'T'],
    [fx - D, fy, D, H, 'L'],
    [fx, fy, W, H, 'F'],
    [fx + W, fy, D, H, 'R'],
    [fx + W + D, fy, W, H, 'B'],
    [fx, fy + H, W, D, 'D'],
  ];

  // Tabs FIRST (so faces draw over their bases)
  drawTab(ctx, 'left',   fx, fy - D, W, D, TAB);
  drawTab(ctx, 'right',  fx, fy - D, W, D, TAB);
  drawTab(ctx, 'top',    fx, fy - D, W, D, TAB);
  drawTab(ctx, 'left',   fx, fy + H, W, D, TAB);
  drawTab(ctx, 'right',  fx, fy + H, W, D, TAB);
  drawTab(ctx, 'bottom', fx, fy + H, W, D, TAB);
  drawTab(ctx, 'left',   fx - D, fy, D, H, TAB);
  drawTab(ctx, 'right',  fx + W + D, fy, W, H, TAB);
  drawTab(ctx, 'top',    fx + W + D, fy, W, H, TAB);
  drawTab(ctx, 'bottom', fx + W + D, fy, W, H, TAB);

  // Faces
  faces.forEach(([x, y, fw, fh, key]) => {
    drawFace(ctx, part.faces[key], x, y, fw, fh, FACE_LABELS[key], opts.showLabels);
  });

  // Fold lines
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 3]);
  faces.forEach(([x, y, fw, fh]) => ctx.strokeRect(x, y, fw, fh));
  ctx.setLineDash([]);

  // Label
  ctx.fillStyle = '#6b4f2a';
  ctx.font = 'italic 13px Georgia';
  ctx.textAlign = 'left';
  ctx.fillText(`${part.label} (cube)`, originX + 4, originY + 14);
}

function drawArmor(ctx, part, originX, originY, scale, opts) {
  // Armor is a 4-face band: F | R | B | L, open top and bottom
  // No T/D faces. Side tab on rightmost (L) closes the loop back to F.
  // Optional small mounting tabs on top edges (interior) for stability.
  const [w, h, d] = part.size;
  const W = w * scale, H = h * scale, D = d * scale;
  const TAB = Math.min(W, H, D) * 0.18;

  // Band starts at originX + TAB (room for closing tab on the right side)
  const bx = originX + TAB;
  const by = originY + TAB;

  // Order: F, R, B, L
  const faces = [
    [bx,         by, W, H, 'F'],
    [bx + W,     by, D, H, 'R'],
    [bx + W + D, by, W, H, 'B'],
    [bx + W + D + W, by, D, H, 'L'],
  ];

  // Closing tab on the right side of L (glues back to F)
  drawTab(ctx, 'right', bx + W + D + W, by, D, H, TAB);

  // Small alignment tabs on top edges of F and B (helps it sit on shoulders)
  drawTab(ctx, 'top', bx, by, W, H, TAB * 0.7);
  drawTab(ctx, 'top', bx + W + D, by, W, H, TAB * 0.7);

  faces.forEach(([x, y, fw, fh, key]) => {
    drawFace(ctx, part.faces[key], x, y, fw, fh, FACE_LABELS[key], opts.showLabels);
  });

  // Fold lines
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 3]);
  faces.forEach(([x, y, fw, fh]) => ctx.strokeRect(x, y, fw, fh));
  ctx.setLineDash([]);

  // Label
  ctx.fillStyle = '#6b4f2a';
  ctx.font = 'italic 13px Georgia';
  ctx.textAlign = 'left';
  ctx.fillText(`${part.label} (armor — open top & bottom)`, originX + 4, originY + 14);
}

function drawFlap(ctx, part, originX, originY, scale, opts, kindLabel = 'flap') {
  // Two faces side by side: F | B joined at the right edge of F (fold line)
  // A connector tab sits on TOP of F — that's what glues to the body shoulder.
  // When folded: B folds behind F along their shared edge.
  const [w, h] = part.size;
  const W = w * scale, H = h * scale;
  const TAB = Math.min(W, H) * 0.25;

  const fx = originX + TAB; // some left margin in case
  const fy = originY + TAB;

  // Top connector tab on F (glues onto the body)
  drawTab(ctx, 'top', fx, fy, W, H, TAB);

  // F face on left, B face on right, joined at shared vertical edge
  const faces = [
    [fx,     fy, W, H, 'F'],
    [fx + W, fy, W, H, 'B'],
  ];

  faces.forEach(([x, y, fw, fh, key]) => {
    drawFace(ctx, part.faces[key], x, y, fw, fh, FACE_LABELS[key], opts.showLabels);
  });

  // Fold lines
  ctx.strokeStyle = '#8b6f47';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 3]);
  faces.forEach(([x, y, fw, fh]) => ctx.strokeRect(x, y, fw, fh));
  ctx.setLineDash([]);

  // Label
  ctx.fillStyle = '#6b4f2a';
  ctx.font = 'italic 13px Georgia';
  ctx.textAlign = 'left';
  ctx.fillText(`${part.label} (${kindLabel} — top tab glues to body)`, originX + 4, originY + 14);
}

function drawPart(ctx, part, x, y, scale, opts) {
  if (part.kind === 'cube') return drawCube(ctx, part, x, y, scale, opts);
  if (part.kind === 'armor') return drawArmor(ctx, part, x, y, scale, opts);
  if (part.kind === 'flap') return drawFlap(ctx, part, x, y, scale, opts, 'arm flap');
  if (part.kind === 'accessory') return drawFlap(ctx, part, x, y, scale, opts, 'accessory');
}

// ============================================================================
// PER-PANEL LAYER BUILDER — used by PSD and PNG-zip exports
// ============================================================================
// Returns each face as its own bbox-sized layer, plus combined Tabs and
// Fold-lines layers covering the part's bbox. Drawn into a sheet-sized PNG,
// the layers stack to the same result as drawPart().

function buildPartLayers(part, originX, originY, scale) {
  const m = partMetrics(part, scale);
  const baseBox = { x: originX, y: originY, w: m.width, h: m.height };
  const layers = [];

  const pushFaceLayers = (faceRects) => {
    faceRects.forEach((r) => {
      layers.push({
        name: FACE_LABELS[r.key] || r.key,
        x: r.x, y: r.y, w: r.w, h: r.h,
        draw: (ctx) => drawFace(ctx, part.faces[r.key], 0, 0, r.w, r.h, null, false),
      });
    });
  };

  const pushFoldLayer = (faceRects) => {
    layers.push({
      name: 'Fold lines',
      ...baseBox,
      draw: (ctx) => {
        ctx.strokeStyle = '#8b6f47';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 3]);
        faceRects.forEach((r) => ctx.strokeRect(r.x - originX, r.y - originY, r.w, r.h));
        ctx.setLineDash([]);
      },
    });
  };

  if (part.kind === 'cube') {
    const [w, h, d] = part.size;
    const W = w * scale, H = h * scale, D = d * scale;
    const TAB = Math.min(W, H, D) * 0.22;
    const fx = originX + TAB + D;
    const fy = originY + TAB + D;
    const faceRects = [
      { key: 'T', x: fx,         y: fy - D, w: W, h: D },
      { key: 'L', x: fx - D,     y: fy,     w: D, h: H },
      { key: 'F', x: fx,         y: fy,     w: W, h: H },
      { key: 'R', x: fx + W,     y: fy,     w: D, h: H },
      { key: 'B', x: fx + W + D, y: fy,     w: W, h: H },
      { key: 'D', x: fx,         y: fy + H, w: W, h: D },
    ];
    const tabs = [
      ['left',   fx,         fy - D, W, D, TAB],
      ['right',  fx,         fy - D, W, D, TAB],
      ['top',    fx,         fy - D, W, D, TAB],
      ['left',   fx,         fy + H, W, D, TAB],
      ['right',  fx,         fy + H, W, D, TAB],
      ['bottom', fx,         fy + H, W, D, TAB],
      ['left',   fx - D,     fy,     D, H, TAB],
      ['right',  fx + W + D, fy,     W, H, TAB],
      ['top',    fx + W + D, fy,     W, H, TAB],
      ['bottom', fx + W + D, fy,     W, H, TAB],
    ];
    pushFaceLayers(faceRects);
    layers.push({
      name: 'Tabs',
      ...baseBox,
      draw: (ctx) => {
        tabs.forEach(([edge, x, y, fw, fh, t]) =>
          drawTab(ctx, edge, x - originX, y - originY, fw, fh, t));
      },
    });
    pushFoldLayer(faceRects);
  } else if (part.kind === 'armor') {
    const [w, h, d] = part.size;
    const W = w * scale, H = h * scale, D = d * scale;
    const TAB = Math.min(W, H, D) * 0.18;
    const bx = originX + TAB;
    const by = originY + TAB;
    const faceRects = [
      { key: 'F', x: bx,             y: by, w: W, h: H },
      { key: 'R', x: bx + W,         y: by, w: D, h: H },
      { key: 'B', x: bx + W + D,     y: by, w: W, h: H },
      { key: 'L', x: bx + W + D + W, y: by, w: D, h: H },
    ];
    pushFaceLayers(faceRects);
    layers.push({
      name: 'Tabs',
      ...baseBox,
      draw: (ctx) => {
        drawTab(ctx, 'right', bx + W + D + W - originX, by - originY, D, H, TAB);
        drawTab(ctx, 'top',   bx - originX,             by - originY, W, H, TAB * 0.7);
        drawTab(ctx, 'top',   bx + W + D - originX,     by - originY, W, H, TAB * 0.7);
      },
    });
    pushFoldLayer(faceRects);
  } else {
    // flap / accessory
    const [w, h] = part.size;
    const W = w * scale, H = h * scale;
    const TAB = Math.min(W, H) * 0.25;
    const fx = originX + TAB;
    const fy = originY + TAB;
    const faceRects = [
      { key: 'F', x: fx,     y: fy, w: W, h: H },
      { key: 'B', x: fx + W, y: fy, w: W, h: H },
    ];
    pushFaceLayers(faceRects);
    layers.push({
      name: 'Tabs',
      ...baseBox,
      draw: (ctx) => {
        drawTab(ctx, 'top', fx - originX, fy - originY, W, H, TAB);
      },
    });
    pushFoldLayer(faceRects);
  }

  return { groupName: part.label, layers };
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'layer';
}

function makeFaceTexture(face, fallbackColor = '#e8d5a7', aspectW = 1, aspectH = 1) {
  const canvas = document.createElement('canvas');
  const longSide = 512;
  const aspect = Math.max(0.05, aspectW / Math.max(0.05, aspectH));
  if (aspect >= 1) {
    canvas.width = longSide;
    canvas.height = Math.max(32, Math.round(longSide / aspect));
  } else {
    canvas.width = Math.max(32, Math.round(longSide * aspect));
    canvas.height = longSide;
  }
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = face?.color || fallbackColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (face?.imageEl) {
    const img = face.imageEl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeFaceMaterial(face, fallbackColor, aspectW = 1, aspectH = 1) {
  return new THREE.MeshStandardMaterial({
    map: makeFaceTexture(face, fallbackColor, aspectW, aspectH),
    roughness: 0.86,
    metalness: 0,
  });
}

function makeCubeMesh(part) {
  const [w, h, d] = part.size;
  const geometry = new THREE.BoxGeometry(w, h, d);
  const materials = [
    makeFaceMaterial(part.faces.L, defaultFaceColor('L'), d, h), // +X: net panel left of F wraps to viewer-right side
    makeFaceMaterial(part.faces.R, defaultFaceColor('R'), d, h), // -X: net panel right of F stitches toward B
    makeFaceMaterial(part.faces.T, defaultFaceColor('T'), w, d), // +Y
    makeFaceMaterial(part.faces.D, defaultFaceColor('D'), w, d), // -Y
    makeFaceMaterial(part.faces.F, defaultFaceColor('F'), w, h), // +Z
    makeFaceMaterial(part.faces.B, defaultFaceColor('B'), w, h), // -Z
  ];
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x2a1f12, transparent: true, opacity: 0.38 })
  );
  mesh.add(edges);
  return mesh;
}

function makePlaneMesh(part, faceKey = 'F') {
  const [w, h] = part.size;
  const geometry = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geometry, makeFaceMaterial(part.faces[faceKey], defaultFaceColor(faceKey), w, h));
  mesh.castShadow = true;
  return mesh;
}

function addPapercraftPreview(scene, parts) {
  const group = new THREE.Group();
  const body = parts.find((p) => p.presetKey === 'body') || parts.find((p) => p.label.toLowerCase().includes('body'));
  const bodyH = body?.size?.[1] || 55;
  const bodyW = body?.size?.[0] || 45;
  const bodyD = body?.size?.[2] || 45;

  parts.forEach((part) => {
    let mesh;
    const isBody = part === body || part.presetKey === 'body';

    if (part.kind === 'cube') {
      mesh = makeCubeMesh(part);
      if (isBody) {
        mesh.position.y = part.size[1] / 2;
      } else {
        mesh.position.y = bodyH + part.size[1] / 2 + 4;
        mesh.position.x = (bodyW + part.size[0]) * 0.6;
      }
    } else if (part.kind === 'armor') {
      const [w, h, d] = part.size;
      const shell = new THREE.Group();
      const front = makePlaneMesh(part, 'F');
      front.position.set(0, 0, d / 2 + 0.6);
      const back = makePlaneMesh(part, 'B');
      back.rotation.y = Math.PI;
      back.position.set(0, 0, -d / 2 - 0.6);
      const left = makePlaneMesh(part, 'L');
      left.rotation.y = -Math.PI / 2;
      left.position.set(-w / 2 - 0.6, 0, 0);
      const right = makePlaneMesh(part, 'R');
      right.rotation.y = Math.PI / 2;
      right.position.set(w / 2 + 0.6, 0, 0);
      shell.add(front, back, left, right);
      shell.position.y = bodyH / 2;
      mesh = shell;
    } else {
      mesh = makePlaneMesh(part, 'F');
      const offset = part.presetKey === 'armL' ? -1 : part.presetKey === 'armR' ? 1 : 1;
      mesh.position.set(offset * (bodyW / 2 + part.size[0] / 2 + 1), bodyH * 0.54, bodyD / 2 + 1);
      mesh.rotation.y = offset < 0 ? Math.PI / 16 : -Math.PI / 16;
      if (part.presetKey === 'shield') mesh.position.x = -bodyW * 0.72;
      if (part.presetKey === 'sword') mesh.position.x = bodyW * 0.8;
      if (part.presetKey === 'hat') {
        mesh.position.set(0, bodyH + part.size[1] / 2, bodyD / 2 + 1);
      }
    }

    if (mesh) group.add(mesh);
  });

  group.position.y = -bodyH / 2;
  scene.add(group);
  return group;
}

function buildAtlasLayout(part, size = ATLAS_SIZE) {
  const [w, h, d] = part.size;
  const pad = size * 0.045;
  let faces = [];
  let totalW = 1;
  let totalH = 1;

  if (part.kind === 'cube') {
    totalW = d + w + d + w;
    totalH = d + h + d;
    const xF = d;
    const yF = d;
    faces = [
      { key: 'T', x: xF, y: 0, w, h: d },
      { key: 'L', x: 0, y: yF, w: d, h },
      { key: 'F', x: xF, y: yF, w, h },
      { key: 'R', x: xF + w, y: yF, w: d, h },
      { key: 'B', x: xF + w + d, y: yF, w, h },
      { key: 'D', x: xF, y: yF + h, w, h: d },
    ];
  } else if (part.kind === 'armor') {
    totalW = w + d + w + d;
    totalH = h;
    faces = [
      { key: 'F', x: 0, y: 0, w, h },
      { key: 'R', x: w, y: 0, w: d, h },
      { key: 'B', x: w + d, y: 0, w, h },
      { key: 'L', x: w + d + w, y: 0, w: d, h },
    ];
  } else {
    totalW = w * 2;
    totalH = h;
    faces = [
      { key: 'F', x: 0, y: 0, w, h },
      { key: 'B', x: w, y: 0, w, h },
    ];
  }

  const scale = Math.min((size - pad * 2) / totalW, (size - pad * 2) / totalH);
  const ox = (size - totalW * scale) / 2;
  const oy = (size - totalH * scale) / 2;

  return {
    size,
    wrapOrder: part.kind === 'cube'
      ? 'L | F | R | B horizontal wrap band. F is the front panel, B is the back panel, T is only the top cap above F, D is only the bottom cap below F.'
      : part.kind === 'armor'
        ? 'F | R | B | L horizontal wrap band'
        : 'F | B two-sided flat panel',
    faces: faces.map((f) => ({
      key: f.key,
      label: FACE_LABELS[f.key] || f.key,
      x: Math.round(ox + f.x * scale),
      y: Math.round(oy + f.y * scale),
      w: Math.round(f.w * scale),
      h: Math.round(f.h * scale),
    })),
  };
}

function atlasSeamRules(part) {
  if (part.kind === 'cube') {
    return [
      'The horizontal stitch order on this template is exactly L | F | R | B.',
      'Important orientation: the L rectangle is the side panel immediately to the left of F in the printable net, so it must show the character side that visually faces toward the FRONT panel. The R rectangle is immediately to the right of F and continues toward the BACK panel.',
      'L.right edge stitches to F.left edge. Draw L so its face/head/body points inward toward F, not outward away from F.',
      'F.right edge stitches to R.left edge. Draw R so its front edge points inward toward F and its rear edge points toward B.',
      'R.right edge stitches to B.left edge. This seam must continue cleanly into the back view.',
      'B.right edge wraps around and stitches to L.left edge.',
      'T.bottom stitches to F.top; T.left/right/back edges continue the top surface toward L/R/B.',
      'D.top stitches to F.bottom; D.left/right/back edges continue the bottom surface toward L/R/B.',
    ].join('\n');
  }
  if (part.kind === 'armor') {
    return [
      'The armor wrap order on this template is exactly F | R | B | L.',
      'F.right stitches to R.left; R.right stitches to B.left; B.right stitches to L.left.',
      'L.right closes the loop back to F.left.',
      'Belts, hems, capes, straps, and armor plates must continue at the same height across every vertical seam.',
    ].join('\n');
  }
  return [
    'F is the visible outside face.',
    'B is the reverse/back side of the same flat cutout.',
    'Keep silhouette, color palette, and major edge landmarks aligned between F and B.',
  ].join('\n');
}

function atlasPartRules(part, parts) {
  const label = part.label.toLowerCase();
  const hasSeparateArms = parts.some((p) => p.presetKey === 'armL' || p.presetKey === 'armR');

  if (part.presetKey === 'head' || label.includes('head')) {
    return [
      'HEAD RULES:',
      'Head/F must contain the full character face: eyes, mouth/muzzle, nose/nostrils, brows, cheeks, and any front facial markings.',
      'Center the full face inside the F rectangle only. Do not let the front face drift into L or R.',
      'Head/L and Head/R show side-of-head continuation only: ears, side hair, side cheek, side horn base, or side markings. Do not draw front-facing eyes on side faces.',
      'Head/B must be fully painted as the back of the head: back hair, rear helmet/hood, rear skull/head shape, and rear markings. No face on the back.',
      'Head/T shows crown/top of head, hair part, helmet top, hat top, or scalp pattern from directly above.',
      'Head/D should be underside/chin/neck continuation only, often dark shadow or under-chin color.',
    ].join('\n');
  }

  if (part.presetKey === 'body' || label.includes('body')) {
    return [
      'CHARACTER CUBE RULES:',
      'This single cube/cuboid is the whole character, including head, face, body, legs, and feet. There is no separate head box.',
      'Body/F must use the entire height of the F rectangle for the full front character: top of head touches near the top of F, face/head at the top, chest/torso/clothing in the middle, legs/feet at the bottom.',
      'The whole front character must fit inside F with a 4% safe margin on left and right. Do not clip eyes, head, arms, legs, feet, or clothing at the F edges.',
      'Feet must appear at the very bottom of Body/F, inside the F rectangle. Do not put the front feet only on D.',
      'The face belongs on the upper portion of Body/F only. Include eyes, mouth/muzzle, nose/nostrils, cheeks, brows, and front facial markings there.',
      'Do not draw eyes, mouth, nostrils, cheeks, or any front facial features on Body/T. Body/T is a top-down scalp/crown/helmet/hair texture only.',
      'Keep the full front face at least 8% below the top edge of Body/F so it does not spill upward into the T panel.',
      'Center the full front character centerline exactly on the horizontal center of F. The eyes and belt buckle should be balanced left/right inside F. Do not shift the face or torso into R; do not center the character across the whole L-F-R band.',
      `Body/L and Body/R are full-height side character strips that stitch to F and B. At the top they show side head/ear/side hair/side helmet; in the middle they show side torso; at the bottom they show side legs/feet. ${hasSeparateArms ? 'Do not draw full arms, hands, shoulder pads, or weapons on body side faces; those belong on separate arm/accessory parts.' : 'Only include an arm if this design has no separate arm part.'}`,
      'Body/L and Body/R should include the side of the body visible behind the arm: side/back torso color, rear belt continuation, side cloak or armor edge, and side of legs/feet at the bottom.',
      'Body/L is the printable side panel left of F. It must face inward toward F: its nose/muzzle/chest direction points to the right edge, and its back direction points to the left edge.',
      'Body/R is the printable side panel right of F. It must face inward toward F on its left edge and stitch to B on its right edge: its nose/muzzle/chest direction points to the left edge, and its back direction points to the right edge.',
      'Body/L must continue the left edge of Body/F at the exact same heights: eye/face band, mouth/muzzle band, shoulder line, torso color, belt, hem, leg/foot boundary.',
      'Body/R must continue the right edge of Body/F at the exact same heights and must also continue into Body/B at its right edge.',
      'Body/B must use the entire height as the full back character: back of head/hair/helmet at top, back torso/cloak/armor and rear belt in the middle, back of legs/feet or cloak bottom at bottom. The back of feet must be visible at the very bottom of B.',
      'Body/T is only the top of the head/hair/helmet/hat viewed from above. Body/D is only the bottom of feet, underside, or plain black shadow. Do not put torso, legs, or a second front body on T or D.',
      'Do not draw papercraft tabs, trapezoids, fold lines, cut lines, dashed lines, crop marks, box outlines, or template borders inside any generated artwork panel.',
    ].join('\n');
  }

  if (part.presetKey === 'armL' || label.includes('left arm')) {
    return [
      'LEFT ARM RULES:',
      'This is the character left arm as a flat hanging flap. F is the outside of the left arm, B is the inner/back side.',
      'Include sleeve/armor/hand details that align visually with the left side of the body.',
    ].join('\n');
  }

  if (part.presetKey === 'armR' || label.includes('right arm')) {
    return [
      'RIGHT ARM RULES:',
      'This is the character right arm as a flat hanging flap. F is the outside of the right arm, B is the inner/back side.',
      'Include sleeve/armor/hand details that align visually with the right side of the body.',
    ].join('\n');
  }

  return 'PART RULES: Paint only the surface described for each face; no repeated full-body portraits on individual faces.';
}

function buildCharacterBandLayout(part, size = ATLAS_SIZE) {
  const [w, h, d] = part.size;
  const pad = size * 0.055;
  const totalW = d + w + d + w;
  const scale = Math.min((size - pad * 2) / totalW, (size - pad * 2) / h);
  const bandW = totalW * scale;
  const bandH = h * scale;
  const ox = (size - bandW) / 2;
  const oy = (size - bandH) / 2;
  const faces = [
    { key: 'L', label: 'side panel left of front', x: 0, w: d },
    { key: 'F', label: 'front projection', x: d, w },
    { key: 'R', label: 'side panel right of front, stitches to back', x: d + w, w: d },
    { key: 'B', label: 'back projection', x: d + w + d, w },
  ];

  return {
    size,
    faces: faces.map((f) => ({
      key: f.key,
      label: f.label,
      x: Math.round(ox + f.x * scale),
      y: Math.round(oy),
      w: Math.round(f.w * scale),
      h: Math.round(bandH),
    })),
  };
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function PapercraftStudio() {
  const [parts, setParts] = useState(() => [newPart('body')]);
  const [selectedUid, setSelectedUid] = useState(() => parts[0]?.uid);
  const [selectedFace, setSelectedFace] = useState('F');
  const [showLabels, setShowLabels] = useState(true);

  // OpenAI — prefill from VITE_OPENAI_API_KEY in .env.local if present; user can override in the UI.
  const [openaiKey, setOpenaiKey] = useState(() => import.meta.env.VITE_OPENAI_API_KEY || '');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [aiStatus, setAiStatus] = useState(''); // human-readable progress
  const [aiGeneratedImages, setAiGeneratedImages] = useState({}); // { "partUid:faceKey": "data:image/png;base64,..." }
  const [aiImageBusy, setAiImageBusy] = useState({}); // per-face busy flag
  const [conceptImage, setConceptImage] = useState(null);

  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const fileInputRef = useRef(null);
  const conceptInputRef = useRef(null);

  const selectedPart = parts.find((p) => p.uid === selectedUid) || parts[0];

  useEffect(() => {
    setParts((prev) => prev.filter((p) => p.presetKey !== 'head'));
  }, []);

  // Keep selectedFace valid for the current part kind
  useEffect(() => {
    if (!selectedPart) return;
    const validFaces = PART_KINDS[selectedPart.kind].faces;
    if (!validFaces.includes(selectedFace)) {
      setSelectedFace(validFaces[0]);
    }
  }, [selectedPart, selectedFace]);

  // --- Part management ---
  const addPart = (presetKey) => {
    setParts((prev) => {
      // Auto-label duplicates: "Sword", "Sword 2", etc.
      const baseLabel = PART_PRESETS[presetKey].label;
      const existing = prev.filter((p) => p.label.startsWith(baseLabel)).length;
      const label = existing === 0 ? baseLabel : `${baseLabel} ${existing + 1}`;
      const np = newPart(presetKey, label);
      setSelectedUid(np.uid);
      return [...prev, np];
    });
  };

  const removePart = (uid) => {
    setParts((prev) => {
      const next = prev.filter((p) => p.uid !== uid);
      if (uid === selectedUid && next.length) setSelectedUid(next[0].uid);
      return next;
    });
  };

  const updateSize = (uid, dim, value) => {
    setParts((prev) =>
      prev.map((p) => {
        if (p.uid !== uid) return p;
        const size = [...p.size];
        size[dim] = Math.max(5, Math.min(200, value));
        return { ...p, size };
      })
    );
  };

  // --- Face image upload ---
  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !selectedPart) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        setParts((prev) =>
          prev.map((p) => {
            if (p.uid !== selectedPart.uid) return p;
            return {
              ...p,
              faces: {
                ...p.faces,
                [selectedFace]: {
                  ...p.faces[selectedFace],
                  image: ev.target.result,
                  imageEl: img,
                },
              },
            };
          })
        );
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const clearFace = () => {
    if (!selectedPart) return;
    setParts((prev) =>
      prev.map((p) => {
        if (p.uid !== selectedPart.uid) return p;
        return {
          ...p,
          faces: {
            ...p.faces,
            [selectedFace]: { ...p.faces[selectedFace], image: null, imageEl: null },
          },
        };
      })
    );
  };

  const setFaceColor = (color) => {
    if (!selectedPart) return;
    setParts((prev) =>
      prev.map((p) => {
        if (p.uid !== selectedPart.uid) return p;
        return {
          ...p,
          faces: {
            ...p.faces,
            [selectedFace]: { ...p.faces[selectedFace], color },
          },
        };
      })
    );
  };

  // --- Render canvas ---
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const scale = 2.5;
    const { layouts, totalWidth, totalHeight } = layoutParts(parts, scale);

    canvas.width = Math.max(600, totalWidth);
    canvas.height = Math.max(400, totalHeight);

    // Paper background
    ctx.fillStyle = '#fbf6ea';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grain
    ctx.fillStyle = 'rgba(120, 90, 50, 0.04)';
    for (let i = 0; i < (canvas.width * canvas.height) / 800; i++) {
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1, 1);
    }

    layouts.forEach(({ part, x, y }) => {
      drawPart(ctx, part, x, y, scale, { showLabels });
    });

    // Highlight selected part bbox
    if (selectedPart) {
      const sel = layouts.find((l) => l.part.uid === selectedPart.uid);
      if (sel) {
        ctx.strokeStyle = 'rgba(168, 66, 26, 0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(sel.x - 4, sel.y - 4, sel.width + 8, sel.height + 8);
        ctx.setLineDash([]);
      }
    }
  }, [parts, showLabels, selectedPart]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return undefined;

    const width = Math.max(320, host.clientWidth || 640);
    const height = Math.max(280, host.clientHeight || 360);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xfbf6ea);

    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 2000);
    camera.position.set(120, 95, 150);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    host.replaceChildren(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 24, 0);
    controls.minDistance = 55;
    controls.maxDistance = 420;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd4bf8f, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(80, 140, 120);
    key.castShadow = true;
    scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(260, 220),
      new THREE.ShadowMaterial({ color: 0x8b6f47, opacity: 0.13 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -28;
    floor.receiveShadow = true;
    scene.add(floor);

    const previewGroup = addPapercraftPreview(scene, parts);
    const box = new THREE.Box3().setFromObject(previewGroup);
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    controls.target.copy(center);
    camera.position.set(center.x + sphere.radius * 1.5, center.y + sphere.radius * 0.95, center.z + sphere.radius * 1.8);
    camera.lookAt(center);

    let frameId;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      previewGroup.rotation.y += 0.0025;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      const nextW = Math.max(320, host.clientWidth || width);
      const nextH = Math.max(280, host.clientHeight || height);
      camera.aspect = nextW / nextH;
      camera.updateProjectionMatrix();
      renderer.setSize(nextW, nextH);
    };
    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resize);
      controls.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [parts]);

  // --- Export PNG @ 300 DPI ---
  const exportPNG = () => {
    const scale = mm(1, 300);
    const { layouts, totalWidth, totalHeight } = layoutParts(parts, scale, 100);

    const out = document.createElement('canvas');
    out.width = totalWidth;
    out.height = totalHeight;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);

    layouts.forEach(({ part, x, y }) => {
      drawPart(ctx, part, x, y, scale, { showLabels: false });
    });

    out.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `papercraft-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  // Render a single layer to an offscreen canvas sized to its bbox.
  const renderLayerCanvas = (layer) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(layer.w));
    c.height = Math.max(1, Math.ceil(layer.h));
    layer.draw(c.getContext('2d'));
    return c;
  };

  // --- Export layered PSD @ 300 DPI ---
  // One group per part. Inside each group: a layer per face (F/B/L/R/T/D),
  // plus a combined Tabs layer and a Fold lines layer.
  const exportPSD = () => {
    const scale = mm(1, 300);
    const { layouts, totalWidth, totalHeight } = layoutParts(parts, scale, 100);
    const W = Math.ceil(totalWidth);
    const H = Math.ceil(totalHeight);

    const bg = document.createElement('canvas');
    bg.width = W; bg.height = H;
    const bgCtx = bg.getContext('2d');
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(0, 0, W, H);

    const children = [{ name: 'Paper', canvas: bg, top: 0, left: 0 }];

    layouts.forEach(({ part, x, y }) => {
      const { groupName, layers } = buildPartLayers(part, x, y, scale);
      const groupChildren = layers.map((l) => {
        const canvas = renderLayerCanvas(l);
        return {
          name: l.name,
          canvas,
          top: Math.floor(l.y),
          left: Math.floor(l.x),
        };
      });
      children.push({ name: groupName, opened: true, children: groupChildren });
    });

    const psd = { width: W, height: H, children };
    const buffer = writePsd(psd);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `papercraft-${Date.now()}.psd`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Export layered PNG set as ZIP @ 300 DPI ---
  // Per-part subfolder of transparent PNGs (one per face + tabs + fold lines)
  // plus a manifest.json with sheet dimensions and per-layer (x, y, w, h).
  const exportLayerZip = async () => {
    const scale = mm(1, 300);
    const { layouts, totalWidth, totalHeight } = layoutParts(parts, scale, 100);
    const W = Math.ceil(totalWidth);
    const H = Math.ceil(totalHeight);

    const zip = new JSZip();
    const manifest = {
      sheet: { width: W, height: H, dpi: 300, units: 'pixels' },
      parts: [],
    };

    for (const { part, x, y } of layouts) {
      const { groupName, layers } = buildPartLayers(part, x, y, scale);
      const folderName = safeName(groupName);
      const folder = zip.folder(folderName);
      const partEntry = { name: groupName, folder: folderName, layers: [] };
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        const canvas = renderLayerCanvas(l);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        const fileName = `${String(i + 1).padStart(2, '0')}-${safeName(l.name)}.png`;
        folder.file(fileName, blob);
        partEntry.layers.push({
          file: `${folderName}/${fileName}`,
          name: l.name,
          x: Math.floor(l.x),
          y: Math.floor(l.y),
          w: canvas.width,
          h: canvas.height,
        });
      }
      manifest.parts.push(partEntry);
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `papercraft-layers-${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Concept image upload ---
  const handleConceptUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setConceptImage({
        dataUrl: ev.target.result,
        mediaType: file.type,
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // --- OpenAI generation: two-step chain ---
  //   Step 1: GPT-4o vision analyzes the concept image and writes per-face descriptions
  //           AND a "global style prompt" that captures palette/medium/era to keep face
  //           outputs visually coherent across the unfold.
  //   Step 2: For each part, generate one constrained GPT Image texture atlas
  //           AND the original concept image as a reference, via /v1/images/edits.
  //           This gives true reference-conditioned generation — the model sees the
  //           concept art, not just descriptions of it. If no concept image was uploaded,
  //           we fall back to /v1/images/generations (text-only).
  const callOpenAI = async (path, body) => {
    const url = `https://api.openai.com/v1/${path}`;
    const isForm = body instanceof FormData;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // For FormData, let the browser set Content-Type so the multipart boundary is correct.
          ...(isForm ? {} : { 'Content-Type': 'application/json' }),
          'Authorization': `Bearer ${openaiKey.trim()}`,
        },
        body: isForm ? body : JSON.stringify(body),
      });
    } catch (netErr) {
      // Distinguish network/CORS/sandbox issues from API errors
      throw new Error(
        `Network call failed reaching api.openai.com. This usually means: ` +
        `(1) the artifact sandbox is blocking the request — try running the code locally or ` +
        `deploying it; (2) your network/firewall is blocking the call; or (3) the API key is malformed. ` +
        `Raw: ${netErr.message}`
      );
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let errMsg = errText.slice(0, 400);
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed.error?.message || errMsg;
      } catch {}
      throw new Error(`OpenAI ${response.status}: ${errMsg}`);
    }
    return response.json();
  };

  const generateWithAI = async () => {
    if (!openaiKey.trim()) {
      setAiError('Enter your OpenAI API key first.');
      return;
    }
    if (!conceptImage && !aiPrompt.trim()) {
      setAiError('Upload a concept image or describe your character.');
      return;
    }
    setAiBusy(true);
    setAiError(null);
    setAiResult(null);
    setAiGeneratedImages({});
    setAiStatus('Analyzing concept with GPT-4o vision...');

    const partsList = parts.map((p) => {
      const faceList = PART_KINDS[p.kind].faces.join(', ');
      return `- ${p.label} (uid:${p.uid}, kind:${p.kind}, faces: ${faceList})`;
    }).join('\n');

    const visionPrompt = `You are an art director for a hand-drawn fantasy papercraft miniature in the style of inked-and-watercolored dungeon zines (like Mörk Borg or hand-crafted goblin paper minis on Etsy).

I'm building this miniature with the following parts:

${partsList}

${conceptImage
  ? "Study the attached concept image. Treat it as the canonical visual reference — match palette, character, mood, and style."
  : `Character description: ${aiPrompt}`}

Topology notes:
- cube parts have 6 faces: F=front, B=back, L=left side, R=right side, T=top (looking down), D=bottom (looking up)
- flap parts have 2 faces: F=outside of limb, B=inside of limb
- armor parts wrap around a cube: F=chest, B=back, L=left side, R=right side (no top/bottom)
- accessory parts are flat cutouts: F=visible front side, B=back side
- Treat every face as an orthographic, flat texture panel, like a Minecraft skin or cube UV map. No camera perspective, no 3/4 view, no depth rendering.
- The main Body/Character cube is the whole character, including head and body. There is no separate head cube.
- Put eyes, mouth, and primary facial features only on the upper part of Body/F. Body/L and Body/R show side head/ears at the top plus side body below. Body/B shows back of head at the top plus back body below.
- Body/F, Body/L, Body/R, and Body/B all use their full panel height for the full character from head to feet. Front is centered in F only; back is centered in B only.
- Printable side orientation: in the net order L | F | R | B, L faces inward toward F, and R faces inward toward F on its left edge while its right edge stitches to B. Do not draw side panels facing outward away from F.
- Body/T is only the top of the head/hair/helmet/hat. Body/D is only bottoms of feet, underside, or black shadow.
- Separate arm flap parts contain arms/hands/sleeves/shoulder pads. Body side panels should only show the body side and attachment seam.
- Details crossing a fold must continue logically across adjacent edges: L-F-R-B around the side band, T meeting the top edge of F/L/R/B, and D meeting the bottom edge.

Your job: write a detailed visual description for each face of each part, AND write one "global style prompt" that captures the rendering style, color palette, line work, and overall aesthetic that should apply to every face.

The face descriptions will be fed individually into an image generator that cannot see the concept image. So they must be self-contained: each face description must restate the character identity, the side of the body being shown, and what's on it.

Return ONLY a JSON object, no markdown, no preamble:
{
  "summary": "one-line character description",
  "stylePrompt": "complete style guidance — medium, palette, line weight, mood, era — that will be appended to every face prompt",
  "parts": [
    {
      "uid": "p1",
      "label": "Body",
      "faces": {
        "F": "Front face of the Body. Show: [detailed description that includes character identity + what's visible on this side]",
        "B": "...",
        "L": "...",
        "R": "...",
        "T": "...",
        "D": "..."
      }
    }
  ]
}

Use the same uid values I provided. Include every face listed for each part.`;

    const userContent = [];
    if (conceptImage) {
      userContent.push({
        type: 'image_url',
        image_url: { url: conceptImage.dataUrl },
      });
    }
    userContent.push({ type: 'text', text: visionPrompt });

    let parsed;
    try {
      const data = await callOpenAI('chat/completions', {
        model: 'gpt-4o',
        max_tokens: 3000,
        messages: [
          {
            role: 'system',
            content: 'You are a fantasy art director for papercraft miniatures. Always respond with valid JSON only — no markdown fences, no preamble.',
          },
          { role: 'user', content: userContent },
        ],
      });
      const text = data.choices?.[0]?.message?.content || '';
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
      setAiResult(parsed);
    } catch (err) {
      console.error(err);
      setAiError(err.message || 'Vision step failed.');
      setAiBusy(false);
      setAiStatus('');
      return;
    }

    setAiStatus(`Vision analysis complete. Generating constrained texture atlases with ${AI_IMAGE_MODEL}...`);
    // Generate one constrained atlas per part, then slice it into the existing face slots.
    // This keeps front/side/back/top details in the correct UV positions.
    await generateAllFaceImages(parsed);

    setAiBusy(false);
    setAiStatus('');
  };

  const buildFacePrompt = (resultObj, partLabel, partKind, faceKey, faceDesc) => {
    const aspectHint = faceKey === 'T' || faceKey === 'D'
      ? 'Top-down view, as if looking straight down (or up) at the surface.'
      : 'Side-on view, as if looking directly at this side of the character.';
    return `${resultObj.stylePrompt || 'Hand-drawn ink and watercolor fantasy illustration.'}

Subject: ${faceDesc}

Composition: Flat panel illustration for a papercraft miniature. ${aspectHint} The illustration must fill the entire square frame edge-to-edge with no white border, no margin, no negative space at the edges. Centered subject. No text, no labels, no captions. The background should be part of the character's surface (e.g., skin, fabric, armor) — not an environment.`;
  };

  // Convert the uploaded concept image (data URL) to a Blob suitable for multipart upload.
  // Returns null if no concept image was uploaded.
  const getConceptBlob = async () => {
    if (!conceptImage?.dataUrl) return null;
    const resp = await fetch(conceptImage.dataUrl);
    return await resp.blob();
  };

  const buildAtlasPrompt = (resultObj, part, rPart, layout) => {
    const faceLines = layout.faces.map((face) => {
      const desc = rPart.faces?.[face.key] || `${FACE_LABELS[face.key]} surface of ${part.label}`;
      return `${face.key} (${face.label}) at x=${face.x}, y=${face.y}, w=${face.w}, h=${face.h}: ${desc}`;
    }).join('\n');

    return `${resultObj.stylePrompt || 'Hand-drawn ink and watercolor fantasy illustration.'}

Create one orthographic papercraft texture atlas for the part "${part.label}" (${part.kind}).

Use the attached atlas template only as an invisible placement guide for where the face rectangles are. Paint artwork only inside the rectangle areas. Keep all faces in the same positions, proportions, and orientation as the template. Outside the rectangles must stay plain white or transparent. Do not reproduce the guide outlines, labels, tabs, trapezoids, fold lines, dashed lines, cut marks, or crop marks in the final artwork.

Template layout: ${layout.wrapOrder}

Stitching rules:
${atlasSeamRules(part)}

${atlasPartRules(part, parts)}

Critical placement rules:
- This is a flat UV texture sheet, not a perspective character drawing.
- No 3/4 view, no shadows implying depth, no environmental background, no labels, no captions, no text.
- No visible template artifacts: no tabs, trapezoids, guide boxes, fold lines, cut lines, dashed lines, crop marks, registration marks, or panel labels.
- Do not draw a full character on each face. Each rectangle is only the surface visible from that side.
- Face F is front-facing. Face B is back-facing. Face L is the character's left side. Face R is the character's right side. Face T is the top surface. Face D is the bottom surface.
- For the main Body/Character cube, facial features belong only on the upper part of F. L/R may show ears or side hair at the top. B shows back of head/hair at the top. T shows crown/top hair/hat only.
- Body/T must contain zero eyes, zero mouth, zero nostrils, and zero face-front features. It is only a top-down head cap.
- Continue colors, stripes, belts, hairlines, capes, armor seams, and skin markings cleanly across adjacent fold edges.
- Side orientation for the printable net: L must face toward F on its right edge. R must face toward F on its left edge and toward B on its right edge.
- On Body, never place full arms or hands on L/R side panels when separate arm parts exist. Side panels are side-torso continuation strips.
- On Body, F/L/R/B all use their full rectangle height for the whole character from head to feet. Body/T and Body/D are caps only, not overflow space for torso or legs.
- The front body centerline must be centered within F. The back body centerline must be centered within B. Do not shift front art rightward into R or back art leftward into R.
- Body/F must contain top of head through feet, with feet visible at the bottom of F. Body/B must contain back of head through back of feet, with back feet visible at the bottom of B.
- L/R must contain side head, side torso/arm area, side/back body behind the arm, side legs, and side feet so the side panels stitch cleanly into F and B.
- Match seam landmark heights exactly: collar line, shoulder edge, belt line, hem line, skin/fabric boundary, cape edge, and armor plates must line up across adjacent rectangles.

Face content map:
${faceLines}`;
  };

  const makeAtlasTemplateBlob = async (part, layout) => {
    const canvas = document.createElement('canvas');
    canvas.width = layout.size;
    canvas.height = layout.size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    layout.faces.forEach((face) => {
      ctx.fillStyle = 'rgba(232, 213, 167, 0.06)';
      ctx.fillRect(face.x, face.y, face.w, face.h);
      ctx.strokeStyle = 'rgba(30, 30, 30, 0.28)';
      ctx.lineWidth = 2;
      ctx.strokeRect(face.x + 1, face.y + 1, Math.max(1, face.w - 2), Math.max(1, face.h - 2));
    });

    ctx.fillStyle = 'rgba(17, 17, 17, 0.42)';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    layout.faces.forEach((face) => {
      const aboveY = face.y - 22;
      const belowY = face.y + face.h + 22;
      const labelY = aboveY > 18 ? aboveY : Math.min(layout.size - 18, belowY);
      ctx.fillText(`${face.key} ${face.label}`, face.x + face.w / 2, labelY);
    });

    ctx.font = '16px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${part.label} ${part.kind} UV atlas: draw inside boxes only; no labels in art`, 24, 22);

    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  };

  const makeCharacterBandTemplateBlob = async (layout) => {
    const canvas = document.createElement('canvas');
    canvas.width = layout.size;
    canvas.height = layout.size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    layout.faces.forEach((face) => {
      ctx.fillStyle = 'rgba(232, 213, 167, 0.05)';
      ctx.fillRect(face.x, face.y, face.w, face.h);
      ctx.strokeStyle = 'rgba(30, 30, 30, 0.2)';
      ctx.lineWidth = 2;
      ctx.strokeRect(face.x + 1, face.y + 1, Math.max(1, face.w - 2), Math.max(1, face.h - 2));
    });

    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  };

  const buildCharacterBandPrompt = (resultObj, part, rPart, layout) => {
    const faceLines = layout.faces.map((face) => {
      const desc = rPart.faces?.[face.key] || `${face.label} of the whole character`;
      return `${face.key} ${face.label} at x=${face.x}, y=${face.y}, w=${face.w}, h=${face.h}: ${desc}`;
    }).join('\n');

    return `${resultObj.stylePrompt || 'Clean hand-drawn cartoon papercraft character art.'}

Create a clean orthographic turnaround texture strip for one blocky papercraft character. This is NOT a papercraft cutout sheet. It is a flat projection atlas that will later be sliced and placed onto a cube net by software.

Use the attached faint template only for rectangle placement. Do not draw or reproduce any template lines, boxes, labels, tabs, trapezoids, fold lines, cut lines, dashed lines, crop marks, or registration marks.

The strip order is exactly L | F | R | B:
- L is the side panel immediately left of the front panel. It faces inward toward F on its right edge.
- F is the full front projection.
- R is the side panel immediately right of F. Its left edge stitches to F and its right edge stitches to B.
- B is the full back projection.

Each panel must be a pure orthographic projection from that axis, like a character turnaround for a cube toy. Remove perspective and depth. Fill each panel with color/details from that axis, not a cropped copy of the front.

Hard composition rules:
- F contains the entire front character from top of head to bottom of feet. The face/head is at the top, torso/clothing in the middle, legs/feet at the bottom. Feet must touch near the bottom of F.
- Center the full front character on the centerline of F. Do not shift the face/head/right eye into R.
- L and R contain full-height side projections: side head/ear/hair at top, side torso and side/back body behind the arm in the middle, side legs and side feet at the bottom.
- B contains the entire back character from back of head/hair at top to back of legs/feet at bottom.
- Keep collar, shoulder, belt, hem, leg, and foot heights exactly aligned across L-F-R-B.
- No shadows, no backgrounds, no white gaps, no panel outlines, no labels.

Panel content:
${faceLines}`;
  };

  const loadImageFromDataUrl = (dataUrl) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });

  const sliceAtlasToFaces = async (partUid, atlasDataUrl, layout) => {
    const img = await loadImageFromDataUrl(atlasDataUrl);
    const slices = {};

    layout.faces.forEach((face) => {
      const bleed = 3;
      const sx = Math.round(((face.x + bleed) / layout.size) * img.width);
      const sy = Math.round(((face.y + bleed) / layout.size) * img.height);
      const sw = Math.round(((face.w - bleed * 2) / layout.size) * img.width);
      const sh = Math.round(((face.h - bleed * 2) / layout.size) * img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, sw);
      canvas.height = Math.max(1, sh);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      slices[`${partUid}:${face.key}`] = canvas.toDataURL('image/png');
    });

    setAiGeneratedImages((prev) => ({ ...prev, ...slices }));
    return slices;
  };

  const generateCapFace = async (part, faceKey, resultObj, referenceBlob) => {
    const cacheKey = `${part.uid}:${faceKey}`;
    const prompt = `${resultObj.stylePrompt || 'Clean hand-drawn cartoon papercraft character art.'}

Create a single flat orthographic texture panel for face ${faceKey} of the whole character cube.
${faceKey === 'T'
  ? 'This is ONLY the top of the head/hair/helmet/hat viewed directly from above. No eyes, no mouth, no nostrils, no face-front features, no torso, no legs.'
  : 'This is ONLY the bottom of the feet or underside viewed directly from below. Show soles/foot bottoms or a simple dark underside/black shadow. No front body, no face, no torso.'}
Fill the entire image edge to edge with the surface texture. No tabs, fold lines, cut lines, labels, borders, background scene, or white margins.`;

    try {
      let data;
      if (referenceBlob) {
        const form = new FormData();
        form.append('model', AI_IMAGE_MODEL);
        form.append('prompt', prompt.slice(0, 4000));
        form.append('n', '1');
        form.append('size', '1024x1024');
        form.append('quality', 'medium');
        form.append('image[]', referenceBlob, 'concept.png');
        data = await callOpenAI('images/edits', form);
      } else {
        data = await callOpenAI('images/generations', {
          model: AI_IMAGE_MODEL,
          prompt: prompt.slice(0, 4000),
          n: 1,
          size: '1024x1024',
          quality: 'medium',
        });
      }
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error(`No b64_json for ${faceKey}`);
      setAiGeneratedImages((prev) => ({ ...prev, [cacheKey]: `data:image/png;base64,${b64}` }));
    } catch (err) {
      console.error(`Cap generation failed for ${cacheKey}:`, err);
      setAiError(`Cap generation failed for ${cacheKey}: ${err.message}`);
    }
  };

  const generateCharacterProjectionAtlas = async (part, rPart, resultObj, referenceBlob) => {
    const layout = buildCharacterBandLayout(part);
    const prompt = buildCharacterBandPrompt(resultObj, part, rPart, layout);
    const busyKeys = ['L', 'F', 'R', 'B', 'T', 'D']
      .reduce((acc, faceKey) => ({ ...acc, [`${part.uid}:${faceKey}`]: true }), {});
    setAiImageBusy((prev) => ({ ...prev, ...busyKeys }));

    try {
      const templateBlob = await makeCharacterBandTemplateBlob(layout);
      const form = new FormData();
      form.append('model', AI_IMAGE_MODEL);
      form.append('prompt', prompt.slice(0, 4000));
      form.append('n', '1');
      form.append('size', `${ATLAS_SIZE}x${ATLAS_SIZE}`);
      form.append('quality', 'medium');
      form.append('image[]', templateBlob, 'turnaround-template.png');
      if (referenceBlob) form.append('image[]', referenceBlob, 'concept.png');

      const data = await callOpenAI('images/edits', form);
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error('No b64_json in turnaround response');
      await sliceAtlasToFaces(part.uid, `data:image/png;base64,${b64}`, layout);
      await generateCapFace(part, 'T', resultObj, referenceBlob);
      await generateCapFace(part, 'D', resultObj, referenceBlob);
    } catch (err) {
      console.error(`Turnaround generation failed for ${part.label}:`, err);
      setAiError(`Turnaround generation failed for ${part.label}: ${err.message}`);
    } finally {
      setAiImageBusy((prev) => {
        const next = { ...prev };
        ['L', 'F', 'R', 'B', 'T', 'D'].forEach((faceKey) => delete next[`${part.uid}:${faceKey}`]);
        return next;
      });
    }
  };

  const generatePartAtlas = async (part, rPart, resultObj, referenceBlob) => {
    if (part.presetKey === 'body' && part.kind === 'cube') {
      return generateCharacterProjectionAtlas(part, rPart, resultObj, referenceBlob);
    }

    const layout = buildAtlasLayout(part);
    const prompt = buildAtlasPrompt(resultObj, part, rPart, layout);
    const busyKeys = layout.faces.reduce((acc, face) => ({ ...acc, [`${part.uid}:${face.key}`]: true }), {});
    setAiImageBusy((prev) => ({ ...prev, ...busyKeys }));

    try {
      const templateBlob = await makeAtlasTemplateBlob(part, layout);
      const form = new FormData();
      form.append('model', AI_IMAGE_MODEL);
      form.append('prompt', prompt.slice(0, 4000));
      form.append('n', '1');
      form.append('size', `${ATLAS_SIZE}x${ATLAS_SIZE}`);
      form.append('quality', 'medium');
      form.append('image[]', templateBlob, 'atlas-template.png');
      if (referenceBlob) form.append('image[]', referenceBlob, 'concept.png');

      const data = await callOpenAI('images/edits', form);
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error('No b64_json in response');
      return await sliceAtlasToFaces(part.uid, `data:image/png;base64,${b64}`, layout);
    } catch (err) {
      console.error(`Atlas generation failed for ${part.label}:`, err);
      setAiError(`Atlas generation failed for ${part.label}: ${err.message}`);
      return null;
    } finally {
      setAiImageBusy((prev) => {
        const next = { ...prev };
        layout.faces.forEach((face) => delete next[`${part.uid}:${face.key}`]);
        return next;
      });
    }
  };

  const generateOneFaceImage = async (partUid, faceKey, prompt, referenceBlob) => {
    const cacheKey = `${partUid}:${faceKey}`;
    setAiImageBusy((prev) => ({ ...prev, [cacheKey]: true }));
    try {
      let data;
      if (referenceBlob) {
        // Image-to-image: feed the concept art as a reference via /v1/images/edits.
        const form = new FormData();
        form.append('model', AI_IMAGE_MODEL);
        form.append('prompt', prompt.slice(0, 4000));
        form.append('n', '1');
        form.append('size', `${ATLAS_SIZE}x${ATLAS_SIZE}`);
        form.append('quality', 'medium');
        form.append('image', referenceBlob, 'concept.png');
        data = await callOpenAI('images/edits', form);
      } else {
        // Text-only fallback when no concept image was uploaded.
        data = await callOpenAI('images/generations', {
          model: AI_IMAGE_MODEL,
          prompt: prompt.slice(0, 4000),
          n: 1,
          size: `${ATLAS_SIZE}x${ATLAS_SIZE}`,
          quality: 'medium',
        });
      }
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error('No b64_json in response');
      const dataUrl = `data:image/png;base64,${b64}`;
      setAiGeneratedImages((prev) => ({ ...prev, [cacheKey]: dataUrl }));
      return dataUrl;
    } catch (err) {
      console.error(`Image gen failed for ${cacheKey}:`, err);
      setAiError(`Image generation failed for ${cacheKey}: ${err.message}`);
      return null;
    } finally {
      setAiImageBusy((prev) => {
        const next = { ...prev };
        delete next[cacheKey];
        return next;
      });
    }
  };

  const generateAllFaceImages = async (resultObj) => {
    const queue = [];
    resultObj.parts?.forEach((rPart) => {
      const part = parts.find((p) => p.uid === rPart.uid) || parts.find((p) => p.label === rPart.label);
      if (!part) return;
      queue.push({ part, rPart });
    });

    // Build the reference blob once and reuse across all faces.
    const referenceBlob = await getConceptBlob();

    // Sequential to respect rate limits
    let idx = 0;
    for (const item of queue) {
      idx++;
      setAiStatus(`Generating atlas ${idx} of ${queue.length}: ${item.part.label}...`);
      await generatePartAtlas(item.part, item.rPart, resultObj, referenceBlob);
    }
  };

  // Regenerate a single face image
  const regenerateFaceImage = async (partUid, faceKey) => {
    if (!aiResult) return;
    const rPart = aiResult.parts?.find((p) => p.uid === partUid) ||
                  aiResult.parts?.find((p) => p.label === parts.find(pp => pp.uid === partUid)?.label);
    const part = parts.find((p) => p.uid === partUid);
    if (!rPart || !part) return;
    const referenceBlob = await getConceptBlob();
    await generatePartAtlas(part, rPart, aiResult, referenceBlob);
  };

  // Apply a generated image directly to a face.
  // GPT Image returns base64 inline, so the cached value is already a data URL.
  const applyGeneratedImage = async (partUid, faceKey) => {
    const cacheKey = `${partUid}:${faceKey}`;
    const dataUrl = aiGeneratedImages[cacheKey];
    if (!dataUrl) return;
    try {
      const img = new Image();
      img.onload = () => {
        setParts((prev) =>
          prev.map((p) => {
            if (p.uid !== partUid) return p;
            return {
              ...p,
              faces: {
                ...p.faces,
                [faceKey]: {
                  ...p.faces[faceKey],
                  image: dataUrl,
                  imageEl: img,
                },
              },
            };
          })
        );
      };
      img.src = dataUrl;
    } catch (err) {
      console.error(err);
      setAiError(`Couldn't apply image: ${err.message}`);
    }
  };

  // Apply ALL generated images to their respective faces
  const applyAllGeneratedImages = async () => {
    for (const cacheKey of Object.keys(aiGeneratedImages)) {
      const [partUid, faceKey] = cacheKey.split(':');
      await applyGeneratedImage(partUid, faceKey);
    }
  };

  const currentFace = selectedPart?.faces[selectedFace];
  const validFaces = selectedPart ? PART_KINDS[selectedPart.kind].faces : [];

  return (
    <div style={styles.app}>
      <style>{globalCSS}</style>

      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logo}>
            <span style={styles.logoMark}>✂</span>
            <div>
              <h1 style={styles.title}>FOLD &amp; FORGE</h1>
              <p style={styles.subtitle}>Papercraft Miniature Workbench</p>
            </div>
          </div>
          <div style={styles.headerActions}>
            <button style={styles.iconBtn} onClick={() => setShowLabels(!showLabels)}>
              <Eye size={16} /> {showLabels ? 'Hide' : 'Show'} Labels
            </button>
            <button style={styles.iconBtn} onClick={exportLayerZip} title="Each panel as its own transparent PNG, bundled with a manifest.json">
              <FileArchive size={16} /> PNG Layers (.zip)
            </button>
            <button style={styles.iconBtn} onClick={exportPSD} title="Layered PSD — one group per part, one layer per face">
              <Layers size={16} /> Export PSD
            </button>
            <button style={styles.primaryBtn} onClick={exportPNG}>
              <Download size={16} /> Export PNG (300 DPI)
            </button>
          </div>
        </div>
      </header>

      <div style={styles.body}>
        {/* LEFT PANEL */}
        <aside style={styles.leftPanel}>

          {/* PARTS LIST */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Parts in Sheet</h2>
            <div style={styles.partList}>
              {parts.map((p) => {
                const Icon = PART_PRESETS[p.presetKey]?.icon || Box;
                return (
                  <div key={p.uid} style={{
                    ...styles.partChip,
                    ...(selectedUid === p.uid ? styles.partChipActive : {}),
                  }}>
                    <button
                      onClick={() => setSelectedUid(p.uid)}
                      style={styles.partChipMain}
                    >
                      <Icon size={14} />
                      <div style={styles.partChipText}>
                        <span style={styles.partChipLabel}>{p.label}</span>
                        <span style={styles.dim}>
                          {p.kind === 'flap' || p.kind === 'accessory'
                            ? `${p.size[0]}×${p.size[1]}mm`
                            : `${p.size[0]}×${p.size[1]}×${p.size[2]}mm`}
                        </span>
                      </div>
                    </button>
                    <button
                      onClick={() => removePart(p.uid)}
                      style={styles.removeBtn}
                      title="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ADD PARTS */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>+ Add Part</h2>
            <div style={styles.addGrid}>
              {Object.entries(PART_PRESETS).map(([key, preset]) => {
                const Icon = preset.icon;
                return (
                  <button
                    key={key}
                    onClick={() => addPart(key)}
                    style={styles.addBtn}
                    title={`Add ${preset.label}`}
                  >
                    <Icon size={16} />
                    <span>{preset.label}</span>
                  </button>
                );
              })}
            </div>
            <p style={styles.hint}>
              Armor is an open-top/bottom shell that slides over a cube. Make it ~5–10mm larger per dimension than the body underneath.
            </p>
          </section>

          {/* DIMENSIONS */}
          {selectedPart && (
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>Size — {selectedPart.label}</h2>
              {(selectedPart.kind === 'flap' || selectedPart.kind === 'accessory'
                ? ['Width', 'Height']
                : ['Width', 'Height', 'Depth']
              ).map((dimName, di) => (
                <div key={dimName} style={styles.dimRow}>
                  <label style={styles.dimLabel}>{dimName}</label>
                  <input
                    type="range"
                    min={5}
                    max={120}
                    value={selectedPart.size[di]}
                    onChange={(e) => updateSize(selectedPart.uid, di, parseInt(e.target.value))}
                    style={styles.slider}
                  />
                  <input
                    type="number"
                    min={5}
                    max={200}
                    value={selectedPart.size[di]}
                    onChange={(e) => updateSize(selectedPart.uid, di, parseInt(e.target.value) || 0)}
                    style={styles.numInput}
                  />
                  <span style={styles.unit}>mm</span>
                </div>
              ))}
            </section>
          )}

          {/* FACE DESIGNER */}
          {selectedPart && (
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>Faces — {selectedPart.label}</h2>
              <div style={{
                ...styles.faceGrid,
                gridTemplateColumns: `repeat(${Math.min(validFaces.length, 3)}, 1fr)`,
              }}>
                {validFaces.map((key) => {
                  const f = selectedPart.faces[key];
                  const active = selectedFace === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedFace(key)}
                      style={{
                        ...styles.faceBtn,
                        ...(active ? styles.faceBtnActive : {}),
                        backgroundColor: f?.image ? '#fff' : f?.color,
                        backgroundImage: f?.image ? `url(${f.image})` : 'none',
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }}
                    >
                      <span style={styles.faceBtnLabel}>{FACE_LABELS[key]}</span>
                    </button>
                  );
                })}
              </div>

              <div style={styles.faceControls}>
                <button style={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} /> Upload image — {FACE_LABELS[selectedFace]}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  style={{ display: 'none' }}
                />
                {currentFace?.image && (
                  <button style={styles.clearBtn} onClick={clearFace}>
                    <Trash2 size={14} /> Clear image
                  </button>
                )}
                <div style={styles.colorRow}>
                  <label style={styles.colorLabel}>fill color:</label>
                  <input
                    type="color"
                    value={currentFace?.color || '#e8d5a7'}
                    onChange={(e) => setFaceColor(e.target.value)}
                    style={styles.colorPicker}
                  />
                </div>
              </div>
            </section>
          )}

          {/* AI */}
          {AI_ENABLED && (
          <section style={{ ...styles.section, ...styles.aiSection }}>
            <h2 style={styles.sectionTitle}>
              <Sparkles size={16} style={{ verticalAlign: 'text-bottom' }} /> AI Concept-to-Faces (OpenAI)
            </h2>

            <div style={styles.keyRow}>
              <Key size={14} />
              <input
                type="password"
                placeholder="OpenAI API key (sk-...)"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                style={styles.keyInput}
              />
            </div>
            <p style={styles.keyHint}>
              Key is held only in this session and sent directly to api.openai.com. Not stored or logged.
            </p>

            <button style={styles.uploadBtn} onClick={() => conceptInputRef.current?.click()}>
              <Upload size={14} /> {conceptImage ? 'Replace concept image' : 'Upload concept image'}
            </button>
            <input
              ref={conceptInputRef}
              type="file"
              accept="image/*"
              onChange={handleConceptUpload}
              style={{ display: 'none' }}
            />
            {conceptImage && (
              <img src={conceptImage.dataUrl} alt="concept" style={styles.conceptPreview} />
            )}

            <textarea
              placeholder="...or describe: 'a swamp hag goblin with mossy cloak, glowing eyes, holding a bone wand'"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              style={styles.textarea}
              rows={3}
            />

            <button
              style={{ ...styles.primaryBtn, width: '100%', justifyContent: 'center' }}
              onClick={generateWithAI}
              disabled={aiBusy}
            >
              {aiBusy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
              {aiBusy ? 'Generating...' : 'Generate Faces from Concept'}
            </button>

            {aiBusy && aiStatus && (
              <div style={styles.statusBox}>
                <Loader2 size={12} className="spin" /> {aiStatus}
              </div>
            )}

            {aiError && (
              <div style={styles.errorBox}>
                <AlertCircle size={14} /> {aiError}
              </div>
            )}

            {aiResult && (
              <div style={styles.aiResultBox}>
                <p style={styles.aiSummary}><em>{aiResult.summary}</em></p>

                {/* Apply-all button */}
                {Object.keys(aiGeneratedImages).length > 0 && (
                  <button
                    style={{ ...styles.primaryBtn, width: '100%', justifyContent: 'center', marginBottom: 12 }}
                    onClick={applyAllGeneratedImages}
                  >
                    <Check size={14} /> Apply all {Object.keys(aiGeneratedImages).length} images to faces
                  </button>
                )}

                {aiResult.stylePrompt && (
                  <div style={styles.stylePromptBox}>
                    <strong>Style:</strong> {aiResult.stylePrompt}
                  </div>
                )}

                {aiResult.parts?.map((rPart, pi) => {
                  const actualPart = parts.find((p) => p.uid === rPart.uid) ||
                                     parts.find((p) => p.label === rPart.label);
                  return (
                    <div key={pi} style={styles.aiPartBlock}>
                      <strong style={styles.aiPartLabel}>{rPart.label}</strong>
                      {Object.entries(rPart.faces || {}).map(([fk, desc]) => {
                        const cacheKey = actualPart ? `${actualPart.uid}:${fk}` : null;
                        const imgUrl = cacheKey ? aiGeneratedImages[cacheKey] : null;
                        const busy = cacheKey ? aiImageBusy[cacheKey] : false;
                        return (
                          <div key={fk} style={styles.aiFaceCard}>
                            <div style={styles.aiFaceCardHeader}>
                              <span style={styles.aiFaceKey}>{FACE_LABELS[fk] || fk}</span>
                              {actualPart && (
                                <div style={styles.aiFaceActions}>
                                  {imgUrl && (
                                    <button
                                      onClick={() => applyGeneratedImage(actualPart.uid, fk)}
                                      style={styles.aiSmallBtn}
                                      title="Apply this image to the face"
                                    >
                                      <Check size={11} /> Apply
                                    </button>
                                  )}
                                  <button
                                    onClick={() => regenerateFaceImage(actualPart.uid, fk)}
                                    style={styles.aiSmallBtn}
                                    disabled={busy}
                                    title="Regenerate this image"
                                  >
                                    {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                                    {imgUrl ? ' Redo' : ' Generate'}
                                  </button>
                                </div>
                              )}
                            </div>
                            <p style={styles.aiFaceDesc}>{desc}</p>
                            {imgUrl && (
                              <img src={imgUrl} alt={`${rPart.label} ${fk}`} style={styles.aiFaceImg} />
                            )}
                            {busy && (
                              <div style={styles.aiFaceImgPlaceholder}>
                                <Loader2 size={20} className="spin" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}
        </aside>

        {/* CANVAS */}
        <main style={styles.canvasArea}>
          <div style={styles.previewPanel}>
            <div style={styles.canvasMeta}>
              <span>3D Preview</span>
              <span style={styles.canvasMetaDim}>Drag to orbit â€¢ Scroll to zoom â€¢ Uses current face art</span>
            </div>
            <div ref={previewRef} style={styles.previewViewport} />
          </div>

          <div style={styles.canvasFrame}>
            <div style={styles.canvasMeta}>
              <span>Unfold Sheet</span>
              <span style={styles.canvasMetaDim}>
                Dashed = fold • Trapezoids = glue tabs • Red dashed box = selected
              </span>
            </div>
            <div style={styles.canvasScroll}>
              <canvas ref={canvasRef} style={styles.canvas} />
            </div>
          </div>

          <div style={styles.tips}>
            <div style={styles.tipCard}>
              <strong>Cube</strong>
              <span>Standard 6-face cross. Tabs on outer edges. Cut the silhouette, fold all dashed lines.</span>
            </div>
            <div style={styles.tipCard}>
              <strong>Arm flap</strong>
              <span>Two-sided strip. Top tab glues to body's shoulder area. Fold along center seam so F and B back-to-back.</span>
            </div>
            <div style={styles.tipCard}>
              <strong>Armor shell</strong>
              <span>4-face band, open top &amp; bottom. Wrap around body and glue closing tab. Slides on like a tunic.</span>
            </div>
            <div style={styles.tipCard}>
              <strong>Accessory</strong>
              <span>Flat 2-sided cutout. Top tab glues to whichever face you want it on — shield to body L, sword to body R.</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Caveat:wght@400;700&family=Crimson+Pro:wght@400;600&display=swap');

  * { box-sizing: border-box; }
  body { margin: 0; }

  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    background: #d4bf8f;
    border-radius: 2px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    height: 16px;
    width: 16px;
    border-radius: 50%;
    background: #6b4f2a;
    margin-top: -6px;
    cursor: pointer;
    border: 2px solid #fbf6ea;
  }
  input[type="range"]::-moz-range-thumb {
    height: 16px;
    width: 16px;
    border-radius: 50%;
    background: #6b4f2a;
    cursor: pointer;
    border: 2px solid #fbf6ea;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .spin {
    animation: spin 1s linear infinite;
  }
`;

const colors = {
  paper: '#fbf6ea',
  paperDark: '#f0e6d0',
  ink: '#2a1f12',
  inkSoft: '#5a4530',
  accent: '#a8421a',
  accentDark: '#7a2f12',
  border: '#c9b07a',
  tab: '#8b6f47',
};

const styles = {
  app: {
    minHeight: '100vh',
    background: `
      radial-gradient(ellipse at top, rgba(168, 66, 26, 0.06), transparent 60%),
      radial-gradient(ellipse at bottom, rgba(107, 79, 42, 0.08), transparent 60%),
      #f5ecd6
    `,
    fontFamily: "'Crimson Pro', Georgia, serif",
    color: colors.ink,
  },
  header: {
    borderBottom: `2px solid ${colors.border}`,
    background: 'rgba(251, 246, 234, 0.85)',
    backdropFilter: 'blur(8px)',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  headerInner: {
    maxWidth: 1500,
    margin: '0 auto',
    padding: '16px 24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 14 },
  logoMark: {
    fontSize: 32,
    color: colors.accent,
    transform: 'rotate(-12deg)',
    display: 'inline-block',
  },
  title: {
    fontFamily: "'Cinzel', serif",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: '0.15em',
    margin: 0,
  },
  subtitle: {
    fontFamily: "'Caveat', cursive",
    fontSize: 16,
    margin: 0,
    color: colors.inkSoft,
    marginTop: -2,
  },
  headerActions: { display: 'flex', gap: 10, alignItems: 'center' },
  iconBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: `1.5px solid ${colors.border}`,
    color: colors.inkSoft,
    padding: '8px 14px',
    fontFamily: "'Crimson Pro', serif",
    fontSize: 14,
    borderRadius: 4,
    cursor: 'pointer',
  },
  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: colors.accent,
    border: `1.5px solid ${colors.accentDark}`,
    color: '#fff8e8',
    padding: '10px 18px',
    fontFamily: "'Cinzel', serif",
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.05em',
    borderRadius: 4,
    cursor: 'pointer',
    boxShadow: '0 2px 0 rgba(0,0,0,0.15)',
  },
  body: {
    maxWidth: 1500,
    margin: '0 auto',
    padding: '24px',
    display: 'grid',
    gridTemplateColumns: '400px 1fr',
    gap: 24,
    alignItems: 'start',
  },
  leftPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    position: 'sticky',
    top: 90,
    maxHeight: 'calc(100vh - 110px)',
    overflowY: 'auto',
    paddingRight: 6,
  },
  section: {
    background: 'rgba(255, 252, 240, 0.7)',
    border: `1.5px solid ${colors.border}`,
    padding: '14px 16px',
    borderRadius: 6,
    boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 2px 4px rgba(80, 60, 30, 0.08)',
  },
  aiSection: {
    background: 'linear-gradient(135deg, rgba(255, 248, 220, 0.9), rgba(245, 228, 188, 0.7))',
    borderColor: '#b89455',
  },
  sectionTitle: {
    fontFamily: "'Cinzel', serif",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: colors.accent,
    margin: '0 0 10px 0',
  },
  hint: {
    fontSize: 12,
    color: colors.inkSoft,
    fontStyle: 'italic',
    margin: '10px 0 0 0',
    lineHeight: 1.4,
  },
  partList: { display: 'flex', flexDirection: 'column', gap: 6 },
  partChip: {
    display: 'flex',
    alignItems: 'stretch',
    border: `1.5px solid ${colors.border}`,
    borderRadius: 4,
    overflow: 'hidden',
    background: 'transparent',
  },
  partChipActive: {
    background: '#fff5d8',
    borderColor: colors.accent,
    boxShadow: `inset 0 0 0 1px ${colors.accent}`,
  },
  partChipMain: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'transparent',
    border: 'none',
    padding: '8px 10px',
    cursor: 'pointer',
    flex: 1,
    textAlign: 'left',
    fontFamily: 'inherit',
    color: 'inherit',
  },
  partChipText: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  partChipLabel: { fontSize: 13, fontWeight: 600 },
  dim: { fontSize: 10, color: colors.inkSoft, fontFamily: 'monospace' },
  removeBtn: {
    background: 'transparent',
    border: 'none',
    borderLeft: `1px solid ${colors.border}`,
    padding: '0 8px',
    cursor: 'pointer',
    color: colors.inkSoft,
  },
  addGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 6,
  },
  addBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#fff5d8',
    border: `1px dashed ${colors.tab}`,
    padding: '7px 10px',
    fontFamily: 'inherit',
    fontSize: 12,
    color: colors.inkSoft,
    borderRadius: 4,
    cursor: 'pointer',
  },
  dimRow: {
    display: 'grid',
    gridTemplateColumns: '60px 1fr 55px auto',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  dimLabel: {
    fontFamily: "'Caveat', cursive",
    fontSize: 16,
    color: colors.inkSoft,
  },
  slider: { width: '100%' },
  numInput: {
    width: 50,
    padding: '4px 6px',
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    fontFamily: 'monospace',
    fontSize: 12,
    background: '#fff',
  },
  unit: { fontSize: 11, color: colors.inkSoft },
  faceGrid: {
    display: 'grid',
    gap: 6,
    marginBottom: 12,
  },
  faceBtn: {
    aspectRatio: '1',
    border: `1.5px dashed ${colors.tab}`,
    borderRadius: 3,
    cursor: 'pointer',
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: 4,
  },
  faceBtnActive: {
    border: `2px solid ${colors.accent}`,
    boxShadow: `0 0 0 2px ${colors.paper}, 0 0 0 4px ${colors.accent}`,
  },
  faceBtnLabel: {
    fontFamily: "'Cinzel', serif",
    fontSize: 9,
    fontWeight: 600,
    color: '#fff',
    background: 'rgba(0,0,0,0.55)',
    padding: '2px 5px',
    borderRadius: 2,
    letterSpacing: '0.05em',
  },
  faceControls: { display: 'flex', flexDirection: 'column', gap: 8 },
  uploadBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#fff5d8',
    border: `1.5px solid ${colors.border}`,
    padding: '8px 12px',
    fontFamily: 'inherit',
    fontSize: 13,
    color: colors.inkSoft,
    borderRadius: 4,
    cursor: 'pointer',
    justifyContent: 'center',
  },
  clearBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'transparent',
    border: `1.5px solid #b85a3a`,
    padding: '6px 12px',
    fontFamily: 'inherit',
    fontSize: 12,
    color: '#a8421a',
    borderRadius: 4,
    cursor: 'pointer',
    justifyContent: 'center',
  },
  colorRow: { display: 'flex', alignItems: 'center', gap: 8 },
  colorLabel: {
    fontFamily: "'Caveat', cursive",
    fontSize: 15,
    color: colors.inkSoft,
  },
  colorPicker: {
    width: 40,
    height: 28,
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    cursor: 'pointer',
    padding: 2,
    background: '#fff',
  },
  keyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#fff',
    border: `1.5px solid ${colors.border}`,
    borderRadius: 4,
    padding: '6px 8px',
  },
  keyInput: {
    flex: 1,
    border: 'none',
    outline: 'none',
    fontFamily: 'monospace',
    fontSize: 12,
    background: 'transparent',
    color: colors.ink,
  },
  keyHint: {
    fontSize: 11,
    color: colors.inkSoft,
    fontStyle: 'italic',
    margin: '6px 0 12px 0',
  },
  conceptPreview: {
    width: '100%',
    maxHeight: 140,
    objectFit: 'contain',
    borderRadius: 4,
    margin: '8px 0',
    border: `1px solid ${colors.border}`,
    background: '#fff',
  },
  textarea: {
    width: '100%',
    padding: 10,
    border: `1.5px solid ${colors.border}`,
    borderRadius: 4,
    fontFamily: "'Crimson Pro', serif",
    fontSize: 13,
    background: '#fff',
    resize: 'vertical',
    margin: '10px 0',
  },
  errorBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#fce8e0',
    border: '1px solid #b85a3a',
    color: '#7a2f12',
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 12,
    marginTop: 10,
    lineHeight: 1.4,
  },
  aiResultBox: {
    marginTop: 14,
    padding: 12,
    background: 'rgba(255, 252, 240, 0.95)',
    border: `1px dashed ${colors.tab}`,
    borderRadius: 4,
    maxHeight: 500,
    overflowY: 'auto',
  },
  aiSummary: {
    fontFamily: "'Caveat', cursive",
    fontSize: 18,
    color: colors.accent,
    margin: '0 0 10px 0',
    borderBottom: `1px dashed ${colors.border}`,
    paddingBottom: 8,
  },
  stylePromptBox: {
    fontSize: 11,
    color: colors.inkSoft,
    background: 'rgba(232, 213, 167, 0.3)',
    padding: '8px 10px',
    borderRadius: 4,
    marginBottom: 12,
    lineHeight: 1.4,
    fontStyle: 'italic',
  },
  aiPartBlock: { marginBottom: 14 },
  aiPartLabel: {
    fontFamily: "'Cinzel', serif",
    fontSize: 11,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: colors.inkSoft,
    display: 'block',
    marginBottom: 6,
  },
  aiFaceCard: {
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: 8,
    marginBottom: 6,
    background: '#fff',
  },
  aiFaceCardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  aiFaceActions: { display: 'flex', gap: 4 },
  aiSmallBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    background: '#fff5d8',
    border: `1px solid ${colors.border}`,
    padding: '3px 6px',
    fontFamily: 'inherit',
    fontSize: 10,
    color: colors.inkSoft,
    borderRadius: 3,
    cursor: 'pointer',
  },
  aiFaceLine: {
    fontSize: 12,
    lineHeight: 1.45,
    color: colors.ink,
    paddingLeft: 8,
    marginBottom: 3,
  },
  aiFaceKey: {
    fontWeight: 600,
    color: colors.accent,
    fontFamily: "'Cinzel', serif",
    fontSize: 11,
    letterSpacing: '0.05em',
  },
  aiFaceDesc: {
    fontSize: 11,
    lineHeight: 1.4,
    color: colors.inkSoft,
    margin: '4px 0',
  },
  aiFaceImg: {
    width: '100%',
    aspectRatio: '1',
    objectFit: 'cover',
    borderRadius: 3,
    border: `1px solid ${colors.border}`,
    background: '#fff',
    marginTop: 4,
  },
  aiFaceImgPlaceholder: {
    width: '100%',
    aspectRatio: '1',
    borderRadius: 3,
    border: `1px dashed ${colors.border}`,
    background: 'rgba(232, 213, 167, 0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: colors.inkSoft,
    marginTop: 4,
  },
  statusBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(232, 213, 167, 0.4)',
    border: `1px solid ${colors.border}`,
    color: colors.inkSoft,
    padding: '6px 10px',
    borderRadius: 4,
    fontSize: 11,
    marginTop: 8,
    fontStyle: 'italic',
  },
  canvasArea: { display: 'flex', flexDirection: 'column', gap: 16 },
  previewPanel: {
    background: 'rgba(255, 252, 240, 0.72)',
    border: `2px solid ${colors.border}`,
    borderRadius: 6,
    overflow: 'hidden',
    boxShadow: '0 4px 12px rgba(80, 60, 30, 0.12)',
  },
  previewViewport: {
    width: '100%',
    height: 360,
    minHeight: 300,
    background: '#fbf6ea',
    cursor: 'grab',
  },
  canvasFrame: {
    background: 'rgba(255, 252, 240, 0.7)',
    border: `2px solid ${colors.border}`,
    borderRadius: 6,
    overflow: 'hidden',
    boxShadow: '0 4px 12px rgba(80, 60, 30, 0.12)',
  },
  canvasMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 16px',
    background: 'rgba(232, 213, 167, 0.4)',
    borderBottom: `1px solid ${colors.border}`,
    fontFamily: "'Cinzel', serif",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: colors.inkSoft,
  },
  canvasMetaDim: {
    fontFamily: "'Caveat', cursive",
    fontSize: 13,
    fontWeight: 400,
    textTransform: 'none',
    letterSpacing: 0,
  },
  canvasScroll: {
    overflow: 'auto',
    maxHeight: '78vh',
    padding: 12,
  },
  canvas: {
    display: 'block',
    background: '#fbf6ea',
    boxShadow: '0 1px 3px rgba(80, 60, 30, 0.1)',
  },
  tips: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 12,
  },
  tipCard: {
    background: 'rgba(255, 252, 240, 0.6)',
    border: `1px dashed ${colors.tab}`,
    borderRadius: 4,
    padding: '10px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    fontSize: 13,
    lineHeight: 1.4,
  },
};
