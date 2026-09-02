// web/workbench.js — the Workbench, for a browser.
//
// The desktop Workbench is renderer.js: a three.js viewport, a Monaco editor,
// two node-pty terminals and the checkpoint tree, wired to ~60 IPC methods. It
// is not portable. Bundling it here would need a pty behind #terminal, native
// save dialogs, and about thirty-five no-op shims — which is a page full of
// buttons that look alive and do nothing, the one thing this port has refused
// to ship since day one.
//
// So this is the Workbench rebuilt on what a browser and this server really
// have, feature for feature where they can and honestly where they cannot:
//
//   viewport   three.js, the SAME scene/camera/controls setup as renderer.js
//              (copied, not imported — renderer.js has no exportable seams and
//              editing it would put the desktop app at risk for a web feature)
//   mesh       the server finds a sibling .3mf/.stl or renders one with
//              OpenSCAD (/api/checkpoint/mesh); the browser never renders
//   tree       the reconciled registry, read-only — clawscad.json belongs to
//              the desktop app, so there is no rename, delete or branch here
//   source     read-only, with copy. Monaco is 5 MB and hostile on a phone
//   export     3MF / STL / PNG of the selected checkpoint
//   Ask Claude `claude -p` headless with its log streamed, which is Flow A's
//              own mechanism — NOT a stubbed terminal
//
// Phone first, because that is where this gets used away from the desk: one
// column under 820 px, 44 px targets on a coarse pointer, and a size guard that
// refuses to hand a 109 MB STL to a phone without asking (the cheese man ships
// a 2.6 MB 3MF beside it, which is why 3MF is preferred everywhere here).
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// A phone will happily start parsing a mesh it cannot finish. Above this, on a
// touch device, the server's PNG is offered first and the real mesh stays one
// deliberate tap away.
const COARSE_MESH_LIMIT = 40 * 1024 * 1024;

const VIEW_BUTTONS = [
  ['front', 'Front'],
  ['back', 'Back'],
  ['right', 'Right'],
  ['left', 'Left'],
  ['top', 'Top'],
  ['bottom', 'Bottom'],
  ['iso', 'Iso'],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(id, className, label) {
  const b = el('button', className, label);
  b.id = id;
  b.type = 'button';
  return b;
}

const isCoarse = () => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

/**
 * @param {object} ctx        renderer/bus.js's shared context
 * @param {object} api        web/api-shim.js
 * @param {(msg:string,type?:string)=>void} showToast
 * @returns {object|null} the Workbench handle entry.js drives, or null if the
 *                        host element is missing (standing rule 7: a mount
 *                        never assumes its DOM).
 */
export function mountWorkbench(ctx, api, showToast) {
  const host = document.getElementById('main-content');
  if (!host) return null;

  const toast = (m, t) => {
    try {
      showToast(m, t);
    } catch {}
  };

  // ── DOM ─────────────────────────────────────────────────────────────────

  host.textContent = '';
  const root = el('div');
  root.id = 'wb';

  const stage = el('div');
  stage.id = 'wb-stage';

  const viewportEl = el('div');
  viewportEl.id = 'wb-viewport';
  viewportEl.tabIndex = 0;

  const toolbar = el('div', 'wb-toolbar');
  toolbar.id = 'wb-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Viewport');
  const fitBtn = button('wb-fit', 'toolbar-btn', 'Fit');
  const wireBtn = button('wb-wire', 'toolbar-btn', 'Wireframe');
  const edgesBtn = button('wb-edges', 'toolbar-btn', 'Edges');
  const orthoBtn = button('wb-ortho', 'toolbar-btn', 'Ortho');
  for (const b of [wireBtn, edgesBtn, orthoBtn]) b.setAttribute('aria-pressed', 'false');
  edgesBtn.setAttribute('aria-pressed', 'true');
  toolbar.append(fitBtn, wireBtn, edgesBtn, orthoBtn);

  const presets = el('div', 'wb-presets');
  presets.id = 'wb-presets';
  presets.setAttribute('role', 'toolbar');
  presets.setAttribute('aria-label', 'Views');
  for (const [key, label] of VIEW_BUTTONS) {
    const b = button(`wb-view-${key}`, 'preset-btn', label);
    b.dataset.view = key;
    presets.appendChild(b);
  }

  // The overlay is persistent and copyable on purpose: a render failure is the
  // one thing here the user has to be able to read, scroll and paste back to
  // Claude. A toast that vanishes in four seconds is not that.
  const overlay = el('div', 'wb-overlay');
  overlay.id = 'wb-overlay';
  overlay.hidden = true;
  const overlayText = el('div', 'wb-overlay-text');
  overlayText.id = 'wb-overlay-text';
  const overlayTime = el('div', 'wb-overlay-time');
  overlayTime.id = 'wb-overlay-time';
  const faultPre = el('pre', 'wb-fault');
  faultPre.id = 'wb-fault';
  faultPre.hidden = true;
  const dismiss = button('wb-fault-dismiss', 'small-btn', 'Dismiss');
  dismiss.hidden = true;
  overlay.append(overlayText, overlayTime, faultPre, dismiss);

  const preview = el('img', 'wb-preview');
  preview.id = 'wb-preview';
  preview.alt = 'Server-rendered preview';
  preview.hidden = true;

  viewportEl.append(toolbar, presets, overlay, preview);

  const status = el('div', 'wb-status');
  status.id = 'wb-status';
  status.setAttribute('role', 'status');
  const statusText = el('span', 'wb-status-text', 'No model open.');
  statusText.id = 'wb-status-text';
  const activeChip = el('span', 'wb-chip');
  activeChip.id = 'wb-active-chip';
  activeChip.hidden = true;
  status.append(statusText, activeChip);

  stage.append(viewportEl, status);

  // rail
  const rail = el('div');
  rail.id = 'wb-rail';
  const tabs = el('div', 'wb-tabs');
  tabs.id = 'wb-tabs';
  tabs.setAttribute('role', 'tablist');
  const panes = {};
  const tabButtons = {};
  for (const [key, label] of [
    ['checkpoints', 'Models'],
    ['source', 'Source'],
    ['claude', 'Ask Claude'],
    ['export', 'Export'],
  ]) {
    const b = button(`wb-tab-${key}`, 'wb-tab', label);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(key === 'checkpoints'));
    b.addEventListener('click', () => showPane(key));
    tabs.appendChild(b);
    tabButtons[key] = b;
    const pane = el('div', 'wb-pane');
    pane.id = `wb-${key}`;
    pane.hidden = key !== 'checkpoints';
    panes[key] = pane;
  }

  const tree = el('div', 'wb-tree');
  tree.id = 'wb-checkpoint-tree';
  tree.setAttribute('role', 'tree');
  const treeNote = el('p', 'wb-note',
    'Read-only here: renaming, deleting and branching write the checkpoint registry, which belongs to the desktop app.');
  panes.checkpoints.append(tree, treeNote);

  const sourceFile = el('div', 'wb-source-file', 'Nothing open.');
  sourceFile.id = 'wb-source-file';
  const copyBtn = button('wb-source-copy', 'small-btn', 'Copy');
  const sourceText = el('pre', 'wb-source-text');
  sourceText.id = 'wb-source-text';
  panes.source.append(sourceFile, copyBtn, sourceText);

  const prompt = el('textarea');
  prompt.id = 'wb-claude-prompt';
  prompt.rows = 3;
  prompt.placeholder = 'Make the walls 3 mm thick and add a lid…';
  prompt.setAttribute('aria-label', 'Ask Claude to change this model');
  const sendBtn = button('wb-claude-send', 'cz-btn cz-primary', 'Ask Claude');
  const cancelBtn = button('wb-claude-cancel', 'cz-btn', 'Stop');
  cancelBtn.hidden = true;
  const claudeNote = el('p', 'wb-note',
    'There is no terminal in the browser. This runs Claude Code headless on the server and shows its log here.');
  const claudeLog = el('pre', 'wb-log');
  claudeLog.id = 'wb-claude-log';
  panes.claude.append(prompt, sendBtn, cancelBtn, claudeNote, claudeLog);

  const export3mf = button('wb-export-3mf', 'cz-btn cz-primary', 'Download 3MF');
  const exportStl = button('wb-export-stl', 'cz-btn', 'Download STL');
  const exportPng = button('wb-export-png', 'cz-btn', 'Download PNG');
  const exportStatus = el('div', 'wb-export-status', 'Open a model first.');
  exportStatus.id = 'wb-export-status';
  panes.export.append(export3mf, exportStl, exportPng, exportStatus);

  rail.append(tabs, panes.checkpoints, panes.source, panes.claude, panes.export);
  root.append(stage, rail);
  host.appendChild(root);

  function showPane(name) {
    for (const [key, pane] of Object.entries(panes)) {
      pane.hidden = key !== name;
      tabButtons[key].setAttribute('aria-selected', String(key === name));
    }
  }

  // ── three.js — the desktop scene, rebuilt ───────────────────────────────

  let renderer3d = null;
  let scene = null;
  let perspCamera = null;
  let orthoCamera = null;
  let activeCamera = null;
  let perspControls = null;
  let orthoControls = null;
  let activeControls = null;
  let webglFailed = false;

  const modelMaterial = new THREE.MeshStandardMaterial({
    color: 0x4488ff,
    roughness: 0.35,
    metalness: 0.15,
    side: THREE.DoubleSide,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x2244aa, transparent: true, opacity: 0.3 });

  let currentMesh = null;
  let currentEdges = null;
  let modelBounds = null;
  let edgesVisible = true;
  let wireframeMode = false;
  let isOrtho = false;
  let cameraTarget = null;

  function initThree() {
    if (renderer3d || webglFailed) return !webglFailed;
    try {
      renderer3d = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (err) {
      // A browser with no WebGL is a stated reason, not a blank box — and the
      // server's PNG still gives the user their model.
      webglFailed = true;
      console.error('[workbench] WebGL is unavailable', err);
      return false;
    }
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10102a);

    const w = Math.max(viewportEl.clientWidth, 1);
    const h = Math.max(viewportEl.clientHeight, 1);

    perspCamera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100000);
    perspCamera.up.set(0, 0, 1);
    perspCamera.position.set(80, -60, 60);
    orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
    orthoCamera.up.set(0, 0, 1);
    orthoCamera.position.copy(perspCamera.position);
    activeCamera = perspCamera;

    renderer3d.setSize(w, h);
    // Capped, unlike the desktop's raw devicePixelRatio: a 3× phone screen over
    // a large mesh is four times the fragments for no visible gain, and it is
    // the difference between a smooth orbit and a reloaded tab.
    renderer3d.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer3d.toneMapping = THREE.ACESFilmicToneMapping;
    renderer3d.toneMappingExposure = 1.2;
    renderer3d.domElement.style.touchAction = 'none';
    viewportEl.insertBefore(renderer3d.domElement, toolbar);

    const pmrem = new THREE.PMREMGenerator(renderer3d);
    scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
    pmrem.dispose();

    const makeControls = (camera) => {
      const c = new OrbitControls(camera, renderer3d.domElement);
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.zoomSpeed = 1.2;
      // One finger orbits, two pinch-zoom and pan — the mapping the desktop
      // already declares and never gets to use.
      c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      c.target.set(0, 0, 0);
      return c;
    };
    perspControls = makeControls(perspCamera);
    orthoControls = makeControls(orthoCamera);
    orthoControls.enabled = false;
    activeControls = perspControls;

    const grid = new THREE.GridHelper(200, 20, 0x2a2a55, 0x1a1a44);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(40));
    scene.add(new THREE.AmbientLight(0x606080, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(100, -80, 120);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8888cc, 0.6);
    fill.position.set(-80, 40, 60);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x4444aa, 0.4);
    rim.position.set(0, 100, -100);
    scene.add(rim);

    try {
      new ResizeObserver(() => resize()).observe(viewportEl);
    } catch {}
    window.addEventListener('resize', resize);
    requestAnimationFrame(animate);
    return true;
  }

  function resize() {
    if (!renderer3d) return;
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    if (!w || !h) return; // hidden view measures 0×0; the next show re-measures
    renderer3d.setSize(w, h);
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    if (isOrtho) syncOrthoFrustum();
  }

  function syncOrthoFrustum() {
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    if (!w || !h) return;
    const a = w / h;
    const dist = orthoCamera.position.distanceTo(orthoControls.target);
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2));
    orthoCamera.left = -halfH * a;
    orthoCamera.right = halfH * a;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
  }

  function animate() {
    requestAnimationFrame(animate);
    if (!renderer3d) return;
    // A hidden Workbench draws nothing. The rAF keeps running so the loop is
    // live the instant the tab comes back, but a 500k-triangle scene must not
    // burn a phone's battery behind the Make view.
    if (document.body.dataset.view !== 'workbench') return;
    if (cameraTarget) {
      activeCamera.position.lerp(cameraTarget.position, 0.1);
      activeControls.target.lerp(cameraTarget.lookAt, 0.1);
      if (activeCamera.position.distanceTo(cameraTarget.position) < 0.5) cameraTarget = null;
      if (isOrtho) syncOrthoFrustum();
    }
    activeControls.update();
    renderer3d.render(scene, activeCamera);
  }

  function setCameraView(position, lookAt) {
    cameraTarget = { position: position.clone(), lookAt: lookAt.clone() };
  }

  const viewDistance = () => (modelBounds ? modelBounds.maxDim * 1.4 : 80);

  const VIEW_PRESETS = {
    front: () => setCameraView(new THREE.Vector3(0, -viewDistance(), 0), new THREE.Vector3()),
    back: () => setCameraView(new THREE.Vector3(0, viewDistance(), 0), new THREE.Vector3()),
    right: () => setCameraView(new THREE.Vector3(viewDistance(), 0, 0), new THREE.Vector3()),
    left: () => setCameraView(new THREE.Vector3(-viewDistance(), 0, 0), new THREE.Vector3()),
    top: () => setCameraView(new THREE.Vector3(0, -0.01, viewDistance()), new THREE.Vector3()),
    bottom: () => setCameraView(new THREE.Vector3(0, 0.01, -viewDistance()), new THREE.Vector3()),
    iso: () => {
      const d = viewDistance();
      setCameraView(new THREE.Vector3(d, -d * 0.7, d * 0.8), new THREE.Vector3());
    },
  };

  function fitCameraToModel() {
    if (!modelBounds) return;
    const d = modelBounds.maxDim * 1.2;
    setCameraView(new THREE.Vector3(d, -d * 0.7, d * 0.8), new THREE.Vector3());
  }

  function clearModel() {
    if (currentMesh) {
      scene.remove(currentMesh);
      if (currentMesh.isMesh && currentMesh.geometry) currentMesh.geometry.dispose();
      else if (currentMesh.traverse) currentMesh.traverse((c) => c.isMesh && c.geometry && c.geometry.dispose());
    }
    if (currentEdges) {
      scene.remove(currentEdges);
      currentEdges.geometry.dispose();
    }
    currentMesh = null;
    currentEdges = null;
    modelBounds = null;
  }

  /** Recompute normals and neutralise NaNs — OpenSCAD's STL normals are often
   *  wrong, which on a PBR material shows up as a black model. Same repair the
   *  desktop does before it ever shows a mesh. */
  function repairGeometry(geometry) {
    const pos = geometry.getAttribute('position');
    if (!pos || pos.count === 0) return false;
    let fixed = false;
    for (let i = 0; i < pos.count; i++) {
      if (!isFinite(pos.getX(i)) || !isFinite(pos.getY(i)) || !isFinite(pos.getZ(i))) {
        pos.setXYZ(i, 0, 0, 0);
        fixed = true;
      }
    }
    if (fixed) pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    return true;
  }

  function setBounds(box) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    modelBounds = { center, size, maxDim: Math.max(size.x, size.y, size.z) };
    return size;
  }

  function loadSTL(buffer) {
    const geometry = new STLLoader().parse(buffer);
    if (!repairGeometry(geometry)) throw new Error('that mesh has no geometry in it');
    const mesh = new THREE.Mesh(geometry, modelMaterial.clone());
    const box = geometry.boundingBox;
    const size = setBounds(box);
    mesh.position.sub(modelBounds.center);
    scene.add(mesh);
    currentMesh = mesh;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 15), edgeMaterial);
    edges.position.copy(mesh.position);
    edges.visible = edgesVisible;
    scene.add(edges);
    currentEdges = edges;
    mesh.material.wireframe = wireframeMode;
    return size;
  }

  function load3MF(buffer) {
    const group = new ThreeMFLoader().parse(buffer);
    // ThreeMFLoader makes Phong materials, which the environment map does not
    // light — the model arrives flat grey unless they are replaced.
    group.traverse((child) => {
      if (!child.isMesh) return;
      if (child.geometry) repairGeometry(child.geometry);
      const mat = modelMaterial.clone();
      if (child.material && child.material.color) {
        const hex = child.material.color.getHex();
        if (hex !== 0xffffff && hex !== 0x000000 && hex !== 0x808080) mat.color.copy(child.material.color);
      }
      mat.wireframe = wireframeMode;
      child.material = mat;
    });
    const box = new THREE.Box3().setFromObject(group);
    const size = setBounds(box);
    group.position.sub(modelBounds.center);
    scene.add(group);
    currentMesh = group;
    currentEdges = null; // multi-part; an edge overlay per part is noise
    return size;
  }

  function triangleCount() {
    let n = 0;
    if (!currentMesh) return 0;
    const add = (o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute('position');
      if (pos) n += Math.floor(pos.count / 3);
    };
    if (currentMesh.isMesh) add(currentMesh);
    else currentMesh.traverse(add);
    return n;
  }

  // ── overlay ─────────────────────────────────────────────────────────────

  let overlayTimer = null;

  function showOverlay(message, { fault } = {}) {
    overlay.hidden = false;
    overlayText.textContent = message;
    faultPre.hidden = !fault;
    dismiss.hidden = !fault;
    faultPre.textContent = fault || '';
    if (overlayTimer) clearInterval(overlayTimer);
    overlayTime.textContent = '';
    if (!fault) {
      const started = Date.now();
      overlayTimer = setInterval(() => {
        overlayTime.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
      }, 1000);
    }
  }

  function hideOverlay() {
    overlay.hidden = true;
    if (overlayTimer) clearInterval(overlayTimer);
    overlayTimer = null;
  }

  dismiss.addEventListener('click', hideOverlay);

  // ── state ───────────────────────────────────────────────────────────────

  let checkpoints = {};
  let activeId = null;
  let selected = null; // { id, file }
  let makeIsOurs = false;

  function describe(entry) {
    return String(entry.label || entry.file || '').trim();
  }

  function renderTree() {
    tree.textContent = '';
    const entries = Object.entries(checkpoints);
    if (!entries.length) {
      tree.appendChild(el('p', 'wb-note', 'No models in this workspace yet. Make one in the Make view.'));
      return;
    }
    // Newest first: the model somebody just made is the one they want.
    entries.sort((a, b) => String(b[1].created || '').localeCompare(String(a[1].created || '')));
    for (const [id, entry] of entries) {
      if (!entry || !entry.file) continue;
      const node = el('div', 'cp-node wb-cp');
      node.dataset.id = id;
      node.dataset.file = entry.file;
      node.setAttribute('role', 'treeitem');
      node.setAttribute('tabindex', '0');
      const isSelected = (selected && selected.id === id) || (!selected && id === activeId);
      node.setAttribute('aria-selected', String(Boolean(isSelected)));
      node.append(el('span', 'cp-label', describe(entry)), el('span', 'cp-desc', entry.file));
      const open = () => select({ id, file: entry.file });
      node.addEventListener('click', open);
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      tree.appendChild(node);
    }
  }

  async function refreshCheckpoints() {
    const data = await api.getCheckpoints();
    checkpoints = (data && data.checkpoints) || {};
    activeId = (data && data.active) || null;
    renderTree();
    return checkpoints;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  // ── opening a checkpoint ────────────────────────────────────────────────

  async function loadMeshBytes(mesh) {
    const url = api.modelFileUrl(mesh.path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the server would not serve that mesh (${res.status})`);
    const buffer = await res.arrayBuffer();
    clearModel();
    const size = mesh.format === '3mf' ? load3MF(buffer) : loadSTL(buffer);
    fitCameraToModel();
    preview.hidden = true;
    setStatus(
      `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm — ${triangleCount().toLocaleString()} triangles`
    );
  }

  async function showServerPreview(file, note) {
    const out = await api.renderPreview(file, {});
    if (!out || !out.ok) return false;
    const url = await api.readPipelineImage(out.path);
    if (!url) return false;
    preview.src = url;
    preview.hidden = false;
    setStatus(note || 'Showing a server-rendered picture.');
    return true;
  }

  async function select(target) {
    if (!target || !target.file) return false;
    selected = { id: target.id || null, file: target.file };
    renderTree();
    activeChip.hidden = false;
    activeChip.textContent = target.file;
    exportStatus.textContent = `Ready to export ${target.file}.`;

    // active.scad is what "open this one" means to the rest of the workspace —
    // it is the file CLAUDE.md points Claude at, so Ask Claude below acts on
    // the model the user is actually looking at.
    const picked = await api.selectCheckpoint(target.id, target.file);
    if (!picked) return false;

    loadSource(target.file);

    if (!initThree()) {
      await showServerPreview(target.file, 'This browser has no WebGL, so this is a server-rendered picture.');
      return true;
    }

    showOverlay('Preparing the model…');
    let mesh;
    try {
      mesh = await api.checkpointMesh(target.file);
    } catch (err) {
      mesh = { ok: false, error: String((err && err.message) || err), fault: 'environment' };
    }
    if (!mesh || !mesh.ok) {
      const fault = (mesh && mesh.fault) || 'model';
      const headline =
        fault === 'environment'
          ? 'OpenSCAD is not installed on the machine running this server, so there is nothing to build a mesh with.'
          : fault === 'timeout'
            ? 'That model took longer than five minutes to render and was stopped.'
            : 'OpenSCAD could not build that model.';
      showOverlay(headline, { fault: (mesh && mesh.error) || 'no detail' });
      setStatus('No mesh.');
      return false;
    }

    if (mesh.bytes > COARSE_MESH_LIMIT && isCoarse()) {
      hideOverlay();
      const mb = (mesh.bytes / (1024 * 1024)).toFixed(0);
      const shown = await showServerPreview(target.file, `${mb} MB mesh — showing a picture instead.`);
      const anyway = button('wb-load-anyway', 'small-btn', `Load the 3D model anyway (${mb} MB)`);
      anyway.addEventListener('click', async () => {
        anyway.remove();
        showOverlay('Loading the mesh…');
        try {
          await loadMeshBytes(mesh);
          hideOverlay();
        } catch (err) {
          showOverlay('That mesh would not load in this browser.', { fault: String((err && err.message) || err) });
        }
      });
      status.appendChild(anyway);
      if (!shown) setStatus(`${mb} MB mesh — too big to open on a phone by default.`);
      return true;
    }

    try {
      await loadMeshBytes(mesh);
      hideOverlay();
    } catch (err) {
      showOverlay('That mesh would not load.', { fault: String((err && err.message) || err) });
      return false;
    }
    return true;
  }

  async function loadSource(file) {
    sourceFile.textContent = file;
    sourceText.textContent = 'Loading…';
    const out = await api.readModelSource(file);
    sourceText.textContent = (out && out.ok && out.source) || 'That source could not be read.';
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sourceText.textContent || '');
      toast('Source copied.', 'success');
    } catch {
      toast('This browser would not let the page copy to the clipboard.', 'error');
    }
  });

  // ── viewport controls ───────────────────────────────────────────────────

  fitBtn.addEventListener('click', () => fitCameraToModel());
  wireBtn.addEventListener('click', () => {
    wireframeMode = !wireframeMode;
    wireBtn.setAttribute('aria-pressed', String(wireframeMode));
    if (currentMesh) {
      const apply = (o) => o.isMesh && o.material && (o.material.wireframe = wireframeMode);
      if (currentMesh.isMesh) apply(currentMesh);
      else currentMesh.traverse(apply);
    }
  });
  edgesBtn.addEventListener('click', () => {
    edgesVisible = !edgesVisible;
    edgesBtn.setAttribute('aria-pressed', String(edgesVisible));
    if (currentEdges) currentEdges.visible = edgesVisible;
  });
  orthoBtn.addEventListener('click', () => {
    if (!renderer3d) return;
    isOrtho = !isOrtho;
    orthoBtn.setAttribute('aria-pressed', String(isOrtho));
    if (isOrtho) {
      orthoCamera.position.copy(perspCamera.position);
      orthoControls.target.copy(perspControls.target);
      syncOrthoFrustum();
      activeCamera = orthoCamera;
      activeControls = orthoControls;
      perspControls.enabled = false;
      orthoControls.enabled = true;
    } else {
      perspCamera.position.copy(orthoCamera.position);
      perspControls.target.copy(orthoControls.target);
      activeCamera = perspCamera;
      activeControls = perspControls;
      orthoControls.enabled = false;
      perspControls.enabled = true;
    }
  });
  presets.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    const preset = VIEW_PRESETS[b.dataset.view];
    if (preset) preset();
  });

  // ── export ──────────────────────────────────────────────────────────────

  async function exportAs(format) {
    if (!selected) return toast('Open a model first.', 'info');
    exportStatus.textContent = `Exporting ${format.toUpperCase()}…`;
    const out = await api.exportModel(selected.file, {}, format);
    if (!out || !out.ok) {
      exportStatus.textContent = (out && out.error) || 'That export failed.';
      return;
    }
    // An <a download> the browser navigates to: the bytes are already on the
    // server, so nothing is copied through the page.
    const a = document.createElement('a');
    a.href = api.downloadUrl(out.path);
    a.download = out.path.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    exportStatus.textContent = `Downloaded ${a.download}.`;
  }

  export3mf.addEventListener('click', () => exportAs('3mf'));
  exportStl.addEventListener('click', () => exportAs('stl'));
  exportPng.addEventListener('click', () => exportAs('png'));

  // ── Ask Claude ──────────────────────────────────────────────────────────

  function appendLog(text) {
    claudeLog.textContent += text;
    claudeLog.scrollTop = claudeLog.scrollHeight;
  }

  sendBtn.addEventListener('click', async () => {
    const text = prompt.value.trim();
    if (!text) return toast('Say what you want changed first.', 'info');
    claudeLog.textContent = '';
    makeIsOurs = true;
    sendBtn.disabled = true;
    cancelBtn.hidden = false;
    // The desktop's own rule, restated in the brief because a headless run has
    // no session memory of it: never edit an existing checkpoint in place.
    const brief = selected
      ? `The current model is ${selected.file} (also copied to active.scad). ${text}\n\nWrite a NEW .scad file in the workspace — do not edit an existing one.`
      : `${text}\n\nWrite a NEW .scad file in the workspace.`;
    const ok = await api.composerSendToClaude(brief);
    if (!ok) {
      makeIsOurs = false;
      sendBtn.disabled = false;
      cancelBtn.hidden = true;
    }
  });

  cancelBtn.addEventListener('click', async () => {
    await api.cancelMake();
    appendLog('\n[stopped]\n');
  });

  // ── the handle entry.js drives ──────────────────────────────────────────

  const handle = {
    /** Called when the Workbench becomes visible: a viewport that was
     *  display:none measured 0×0 and must be re-measured before it draws. */
    onShow() {
      // Build the scene on the first show, not on the first model: an empty
      // Workbench should be a grid and a set of axes you can already turn, not
      // a black rectangle that only becomes a viewport once you tap something.
      initThree();
      refreshCheckpoints().catch((err) => console.error('[workbench] checkpoints', err));
      requestAnimationFrame(resize);
      setTimeout(resize, 0);
    },
    refresh: () => refreshCheckpoints(),
    select: (file, id) => select({ file, id }),
    /** entry.js asks this before it sends a finished make to Customize: a build
     *  started FROM the Workbench must land back in the Workbench. */
    ownsCurrentMake: () => makeIsOurs,
    onMakeEvent(evt) {
      if (!evt || !makeIsOurs) return false;
      if (evt.event === 'done' || evt.event === 'error' || evt.event === 'timeout') {
        sendBtn.disabled = false;
        cancelBtn.hidden = true;
        makeIsOurs = false;
        if (evt.event === 'done' && evt.file) {
          prompt.value = '';
          refreshCheckpoints()
            .then(() => {
              const found = Object.entries(checkpoints).find(([, c]) => c && c.file === evt.file);
              return select({ file: evt.file, id: found ? found[0] : null });
            })
            .catch((err) => console.error('[workbench] could not open the new model', err));
          return true; // handled here — do not jump to Customize
        }
      }
      return false;
    },
    onMakeLog: (text) => {
      if (makeIsOurs) appendLog(String(text));
    },
    meshStats: () => ({
      triangles: triangleCount(),
      bounds: modelBounds ? { x: modelBounds.size.x, y: modelBounds.size.y, z: modelBounds.size.z } : null,
      file: selected ? selected.file : null,
    }),
    view: () => (activeCamera ? activeCamera.position.toArray().map((n) => Math.round(n)) : null),
  };

  api.onRenderEvent((evt) => {
    if (!evt || !selected) return;
    if (evt.event === 'start') showOverlay('OpenSCAD is building this model…');
  });

  // A workspace can change under a tab that is just sitting there (the desktop
  // app, or a pipeline run). There is no watcher in this port, so the list is
  // re-read while the Workbench is on screen — a readdir, once every 20s.
  setInterval(() => {
    if (document.body.dataset.view === 'workbench') refreshCheckpoints().catch(() => {});
  }, 20000);

  refreshCheckpoints().catch((err) => console.error('[workbench] checkpoints', err));

  try {
    window.clawscadWorkbench = handle;
  } catch {}

  return handle;
}
