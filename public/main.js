import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Observer } from './Observer.js';
import { CameraDragControls } from './CameraDragControls.js';

// shader loader
async function loadShader(path) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`failed to load shader: ${path}`);
    }
    return await response.text();
}

(async () => {

let lastframe = Date.now()
let delta = 0
let time = 0

// camera visualization variables
let cameraVisualization = null;

// recording variables
let recordingFrames = [];
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];


// set variables types for shader
const uniforms = {
  time: { type: "f", value: 0.0 },
  resolution: { type: "v2", value: new THREE.Vector2() },
  accretion_disk: { type: "b", value: false },
  use_disk_texture: { type: "b", value: true },
  show_stars: { type: "b", value: true },
  show_milkyway: { type: "b", value: true },
  lorentz_transform: { type: "b", value: false },
  doppler_shift: { type: "b", value: false },
  beaming: { type: "b", value: false },
  lensing: { type: "b", value: true },
  cam_pos: { type: "v3", value: new THREE.Vector3() },
  cam_vel: { type: "v3", value: new THREE.Vector3() },
  cam_dir: { type: "v3", value: new THREE.Vector3() },
  cam_up: { type: "v3", value: new THREE.Vector3() },
  fov: { type: "f", value: 0.0 },
  bg_texture: { type: "t", value: null },
  star_texture: { type: "t", value: null },
  disk_texture: { type: "t", value: null }
}

// create renderer
function createRenderer() {
  const renderer = new THREE.WebGLRenderer()
  renderer.setClearColor(0x000000, 1.0)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.autoClear = false
  return renderer;
}

// create scene with post-processing
function createScene(renderer) {
  const scene = new THREE.Scene()
  // this camera is THREE.js camera fixated at position z=1
  // since drawing happens only with shader on a 2D plane, actual camera control is done by Observer
  const camera = new THREE.Camera()
  camera.position.z = 1

  // render pass composing
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera)
  // strength, kernelSize, sigma, res
  // resolution, strength, radius, threshold
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(128, 128), 0.8, 2.0, 0.0)
  const shaderPass = new ShaderPass(CopyShader);
  shaderPass.renderToScreen = true;
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(shaderPass);

  return {
    scene, composer, bloomPass
  }
}

// load textures
function loadTextures() {
  const textures = new Map();
  const textureLoader = new THREE.TextureLoader()

  loadTexture('bg1', './assets/milkyway.jpg', THREE.NearestFilter)
  loadTexture('star', './assets/star_noise.png', THREE.LinearFilter)
  loadTexture('disk', './assets/accretion_disk.png', THREE.LinearFilter)

  window.onbeforeunload = () => {
    for (const texture of textures.values()) {
      texture.dispose();
    }
  }

  return textures;

  function loadTexture(name, image, interpolation, wrap = THREE.ClampToEdgeWrapping) {
    textures.set(name, null);
    textureLoader.load(image, (texture) => {
      texture.magFilter = interpolation
      texture.minFilter = interpolation
      texture.wrapT = wrap
      texture.wrapS = wrap
      textures.set(name, texture);
    })
  }
}

// create shader projection plane
async function createShaderProjectionPlane(uniforms) {
  const vertexShader = document.getElementById('vertexShader')?.textContent
  if (!vertexShader) {
    throw new Error('Error reading vertex shader!');
  }

  const fragmentShader = await loadShader('./shaders/blackHoleFragment.glsl');
  const defines = getShaderDefineConstant('medium');
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader,
    fragmentShader: defines + fragmentShader,
  })
  material.needsUpdate = true;

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)

  async function changePerformanceQuality(quality) {
    const defines = getShaderDefineConstant(quality);
    material.fragmentShader = defines + fragmentShader;
    material.needsUpdate = true;
  }

  function getShaderDefineConstant(quality) {
    let STEP, NSTEPS;
    switch (quality) {
      case 'low':
        STEP = 0.1;
        NSTEPS = 300;
        break;
      case 'medium':
        STEP = 0.05;
        NSTEPS = 600;
        break;
      case 'high':
        STEP = 0.02;
        NSTEPS = 1000;
        break;
      default:
        STEP = 0.05;
        NSTEPS = 600;
    }
    return `
  #define STEP ${STEP} 
  #define NSTEPS ${NSTEPS} 
`
  }

  return {
    mesh,
    changePerformanceQuality
  };
}

// create camera
function createCamera(renderer) {
  const observer = new Observer(60.0, window.innerWidth / window.innerHeight, 1, 80000)
  const cameraControl = new CameraDragControls(observer, renderer.domElement)
  return {
    observer, cameraControl
  }
}

// create scene, 3d context, etc.. instances
const renderer = createRenderer()
const { composer, bloomPass, scene } = createScene(renderer);
document.getElementById('canvas-container').appendChild(renderer.domElement)

// init graphics
const textures = loadTextures();
const { mesh, changePerformanceQuality } = await createShaderProjectionPlane(uniforms);
// add shader plane to scene
scene.add(mesh);

// store changePerformanceQuality for later use
window.changePerformanceQuality = changePerformanceQuality;

// setup camera
const { observer, cameraControl } = createCamera(renderer);
// add camera object to scene
scene.add(observer)

// create camera visualization
cameraVisualization = createCameraVisualization();
cameraVisualization.visible = false;
scene.add(cameraVisualization);


// config
let performanceConfig = {
  resolution: 1.0,
  quality: 'medium'
}

let bloomConfig = {
  strength: 1.0,
  radius: 0.5,
  threshold: 0.8 // higher threshold so only very bright accretion disk blooms
}

let cameraConfig = {
  distance: 10,
    height: 0.0,
    orbit: true,
    fov: 90.0
}

let effectConfig = {
  lorentz_transform: false,
  accretion_disk: true,
  use_disk_texture: true,
  doppler_shift: false,
  beaming: true,
  lensing: true, // always enabled
  show_grid: true,
  show_stars: true,
  show_milkyway: true
}

// update initial config
observer.distance = cameraConfig.distance
observer.moving = cameraConfig.orbit
observer.fov = cameraConfig.fov

// performance stats
let frameCount = 0;
let fpsLastTime = performance.now();
let frameTimeHistory = [];
const frameTimeHistorySize = 60;
let lastTime = performance.now();

function updatePerformanceStats(currentTime) {
  frameCount++;
  const frameTime = currentTime - lastTime;
  lastTime = currentTime;
  frameTimeHistory.push(frameTime);
  if (frameTimeHistory.length > frameTimeHistorySize) {
    frameTimeHistory.shift();
  }
  
  // update fps every second
  if (currentTime - fpsLastTime >= 1000) {
    const fps = frameCount;
    frameCount = 0;
    fpsLastTime = currentTime;
    
    const fpsElement = document.getElementById('fps-value');
    if (fpsElement) {
      fpsElement.textContent = fps;
    }
  }
  
  // update frame time (average of last 60 frames)
  const avgFrameTime = frameTimeHistory.reduce((a, b) => a + b, 0) / frameTimeHistory.length;
  const frameTimeElement = document.getElementById('frame-time-value');
  if (frameTimeElement) {
    frameTimeElement.textContent = avgFrameTime.toFixed(1);
  }
}

// start loop
update();

// UPDATING
function update() {
  const currentTime = performance.now();
  updatePerformanceStats(currentTime);
  
  delta = (Date.now() - lastframe) / 1000
  time += delta

  // window size
  renderer.setPixelRatio(window.devicePixelRatio * performanceConfig.resolution)
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth * performanceConfig.resolution, window.innerHeight * performanceConfig.resolution)

  // update renderer
  observer.update(delta)
  cameraControl.update(delta)

  // update camera visualization
  if (cameraVisualization && cameraVisualization.visible) {
    const visPos = observer.position.clone();
    visPos.y += cameraConfig.height;
    cameraVisualization.position.copy(visPos);
    
    // update viewing direction - align with observer direction
    const dir = observer.direction.clone();
    cameraVisualization.lookAt(visPos.clone().add(dir));
  }

  // update shader variables
  updateUniforms()

  // render
  render();

  // loop
  requestAnimationFrame(update)
  lastframe = Date.now()
}

function render() {
  composer.render()
}

function updateUniforms() {
  uniforms.time.value = time
  uniforms.resolution.value.x = window.innerWidth * performanceConfig.resolution
  uniforms.resolution.value.y = window.innerHeight * performanceConfig.resolution

  // apply height offset to camera position
  const cameraPos = observer.position.clone();
  cameraPos.y += cameraConfig.height;
  
  uniforms.cam_pos.value = cameraPos
  uniforms.cam_dir.value = observer.direction
  uniforms.cam_up.value = observer.up
  uniforms.fov.value = observer.fov

  uniforms.cam_vel.value = observer.velocity

  uniforms.bg_texture.value = textures.get('bg1')
  uniforms.star_texture.value = textures.get('star')
  uniforms.disk_texture.value = textures.get('disk')

  bloomPass.strength = bloomConfig.strength
  bloomPass.radius = bloomConfig.radius
  bloomPass.threshold = bloomConfig.threshold

  observer.distance = cameraConfig.distance
  observer.moving = cameraConfig.orbit
  observer.fov = cameraConfig.fov
  uniforms.lorentz_transform.value = effectConfig.lorentz_transform
  uniforms.accretion_disk.value = effectConfig.accretion_disk
  uniforms.use_disk_texture.value = effectConfig.use_disk_texture
  uniforms.doppler_shift.value = effectConfig.doppler_shift
  uniforms.beaming.value = effectConfig.beaming
  uniforms.lensing.value = effectConfig.lensing
  uniforms.show_stars.value = effectConfig.show_stars
  uniforms.show_milkyway.value = effectConfig.show_milkyway
}

// resize handler
window.addEventListener('resize', () => {
  observer.aspect = window.innerWidth / window.innerHeight;
  observer.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraControl.handleResize();
});

// camera visualization functions
function createCameraVisualization() {
  const group = new THREE.Group();
  
  // camera position dot (red)
  const dotGeometry = new THREE.SphereGeometry(0.15, 16, 16);
  const dotMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const dot = new THREE.Mesh(dotGeometry, dotMaterial);
  group.add(dot);
  
  // viewing cone (red wireframe)
  const coneGeometry = new THREE.ConeGeometry(0.4, 1.5, 8, 1, true);
  const coneMaterial = new THREE.MeshBasicMaterial({ 
    color: 0xff0000, 
    wireframe: true,
    transparent: true,
    opacity: 0.4
  });
  const cone = new THREE.Mesh(coneGeometry, coneMaterial);
  cone.rotation.x = Math.PI;
  cone.position.z = -0.75;
  group.add(cone);
  
  // viewing direction arrow
  const arrowHelper = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 0, 0),
    1.2,
    0xff0000,
    0.25,
    0.12
  );
  group.add(arrowHelper);
  
  return group;
}


// screenshot function
function saveScreenshot() {
  render();
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const URLObj = window.URL || window.webkitURL;
    const a = document.createElement("a");
    a.href = URLObj.createObjectURL(blob);
    a.download = `blackhole-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}

// video recording (using MediaRecorder API - variables declared above)
async function startRecording() {
  const stream = renderer.domElement.captureStream(30); // 30 fps
  recordedChunks = [];
  
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp9'
  });
  
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };
  
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackhole-video-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  
  mediaRecorder.start();
  isRecording = true;
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
  }
}


// ui controls
const cameraDistanceSlider = document.getElementById('camera-distance');
const cameraHeightSlider = document.getElementById('camera-height');
const cameraFovSlider = document.getElementById('camera-fov');
const cameraOrbitCheckbox = document.getElementById('camera-orbit');
const dopplerShiftCheckbox = document.getElementById('doppler-shift');
const beamingCheckbox = document.getElementById('beaming');
const lorentzTransformCheckbox = document.getElementById('lorentz-transform');
const accretionDiskCheckbox = document.getElementById('accretion-disk');
const showStarsCheckbox = document.getElementById('show-stars');
const showMilkywayCheckbox = document.getElementById('show-milkyway');
const showGridCheckbox = document.getElementById('show-grid');

if (cameraDistanceSlider) {
    cameraDistanceSlider.addEventListener('input', (e) => {
        cameraConfig.distance = parseFloat(e.target.value);
    const valueEl = document.getElementById('camera-distance-value');
    if (valueEl) valueEl.textContent = cameraConfig.distance.toFixed(1);
    });
}

if (cameraHeightSlider) {
    cameraHeightSlider.addEventListener('input', (e) => {
        cameraConfig.height = parseFloat(e.target.value);
    const valueEl = document.getElementById('camera-height-value');
    if (valueEl) valueEl.textContent = cameraConfig.height.toFixed(1);
    });
}

if (cameraFovSlider) {
    cameraFovSlider.addEventListener('input', (e) => {
        cameraConfig.fov = parseFloat(e.target.value);
    const valueEl = document.getElementById('camera-fov-value');
    if (valueEl) valueEl.textContent = Math.round(cameraConfig.fov);
    });
}

if (cameraOrbitCheckbox) {
    cameraOrbitCheckbox.addEventListener('change', (e) => {
        cameraConfig.orbit = e.target.checked;
    });
}

if (dopplerShiftCheckbox) {
    dopplerShiftCheckbox.addEventListener('change', (e) => {
    effectConfig.doppler_shift = e.target.checked;
    });
}

if (beamingCheckbox) {
    beamingCheckbox.addEventListener('change', (e) => {
    effectConfig.beaming = e.target.checked;
    });
}

if (lorentzTransformCheckbox) {
    lorentzTransformCheckbox.addEventListener('change', (e) => {
    effectConfig.lorentz_transform = e.target.checked;
    });
}

if (accretionDiskCheckbox) {
    accretionDiskCheckbox.addEventListener('change', (e) => {
    effectConfig.accretion_disk = e.target.checked;
  });
}

if (showStarsCheckbox) {
  showStarsCheckbox.addEventListener('change', (e) => {
    effectConfig.show_stars = e.target.checked;
  });
}

if (showMilkywayCheckbox) {
  showMilkywayCheckbox.addEventListener('change', (e) => {
    effectConfig.show_milkyway = e.target.checked;
  });
}

if (showGridCheckbox) {
  showGridCheckbox.addEventListener('change', (e) => {
    effectConfig.show_grid = e.target.checked;
  });
}


// performance controls
const performanceQualitySelect = document.getElementById('performance-quality');
const performanceResolutionSelect = document.getElementById('performance-resolution');

// bloom controls
const bloomStrengthSlider = document.getElementById('bloom-strength');
const bloomRadiusSlider = document.getElementById('bloom-radius');
const bloomThresholdSlider = document.getElementById('bloom-threshold');

if (performanceQualitySelect) {
  performanceQualitySelect.addEventListener('change', (e) => {
    performanceConfig.quality = e.target.value;
    if (window.changePerformanceQuality) {
      window.changePerformanceQuality(performanceConfig.quality);
        }
    });
}

if (performanceResolutionSelect) {
  performanceResolutionSelect.addEventListener('change', (e) => {
    performanceConfig.resolution = parseFloat(e.target.value);
  });
}

if (bloomStrengthSlider) {
  bloomStrengthSlider.addEventListener('input', (e) => {
    bloomConfig.strength = parseFloat(e.target.value);
    const valueEl = document.getElementById('bloom-strength-value');
    if (valueEl) valueEl.textContent = bloomConfig.strength.toFixed(1);
  });
}

if (bloomRadiusSlider) {
  bloomRadiusSlider.addEventListener('input', (e) => {
    bloomConfig.radius = parseFloat(e.target.value);
    const valueEl = document.getElementById('bloom-radius-value');
    if (valueEl) valueEl.textContent = bloomConfig.radius.toFixed(2);
  });
}

if (bloomThresholdSlider) {
  bloomThresholdSlider.addEventListener('input', (e) => {
    bloomConfig.threshold = parseFloat(e.target.value);
    const valueEl = document.getElementById('bloom-threshold-value');
    if (valueEl) valueEl.textContent = bloomConfig.threshold.toFixed(2);
  });
}

// recording controls
const screenshotBtn = document.getElementById('screenshot-btn');
const recordBtn = document.getElementById('record-btn');

if (screenshotBtn) {
  screenshotBtn.addEventListener('click', () => {
    saveScreenshot();
  });
}

if (recordBtn) {
  recordBtn.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
      recordBtn.textContent = 'Stop Recording';
      recordBtn.style.background = '#a00';
    } else {
      stopRecording();
      recordBtn.textContent = 'Record Video';
      recordBtn.style.background = '#444';
    }
  });
}


// overlay toggle
let overlayVisible = true;
const controlsElement = document.getElementById('controls');
const toggleButton = document.getElementById('toggle-overlay');

function toggleOverlay() {
  overlayVisible = !overlayVisible;
  if (overlayVisible) {
    controlsElement.classList.remove('hidden');
    toggleButton.textContent = '☰';
  } else {
    controlsElement.classList.add('hidden');
    toggleButton.textContent = '☰';
  }
}

if (toggleButton) {
  toggleButton.addEventListener('click', toggleOverlay);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    toggleOverlay();
  }
  // screenshot with 's' key
  if (event.key === 's' || event.key === 'S') {
    event.preventDefault();
    saveScreenshot();
  }
});

})();
