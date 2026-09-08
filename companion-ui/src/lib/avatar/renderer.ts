import {
  AnimationMixer, Box3, DirectionalLight, HemisphereLight, MathUtils,
  PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { EmotionalBase } from '../sprites/taxonomy.js';
import { loadLocalAvatar } from './load-avatar.js';
import { LocalAvatarError } from './local-model.js';
import { disposeAvatarScenes } from './resources.js';

export interface AvatarPlaybackState {
  active: boolean;
  animated: boolean;
  mouthOpen: boolean;
  emotionalBase: EmotionalBase | null;
}

export interface AvatarPlayerHandle {
  format: string;
  update: (state: AvatarPlaybackState) => void;
  reset: () => void;
  dispose: () => void;
}

const EXPRESSION_FOR_BASE: Readonly<Record<EmotionalBase, string | null>> = {
  neutral: null, content: 'relaxed', happy: 'happy', excited: 'happy',
  laughing: 'happy', love: 'happy', curious: 'surprised', surprised: 'surprised',
  sad: 'sad', tired: 'relaxed', anxious: 'sad', grumpy: 'angry',
  smug: 'happy', embarrassed: 'relaxed', thinking: null, asleep: 'relaxed',
};
const EXPRESSION_NAMES = ['happy', 'relaxed', 'surprised', 'sad', 'angry'] as const;

export async function createAvatarPlayer(
  canvas: HTMLCanvasElement,
  file: File,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<AvatarPlayerHandle> {
  signal.throwIfAborted();
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    throw new LocalAvatarError('3D rendering is unavailable on this device. You can still use sprites or chat.');
  }
  let model: Awaited<ReturnType<typeof loadLocalAvatar>>;
  try {
    model = await loadLocalAvatar(file, signal);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const { gltf, vrm } = model;
  const scene = new Scene();
  scene.add(gltf.scene);
  scene.add(new HemisphereLight(0xffffff, 0x66718f, Math.PI));
  const light = new DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 2, 3);
  scene.add(light);
  const camera = new PerspectiveCamera(30, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = true;
  controls.enableDamping = false;
  controls.listenToKeyEvents(canvas);
  const mixer = new AnimationMixer(gltf.scene);
  try {
    const clip = gltf.animations[0];
    if (clip) mixer.clipAction(clip).play();
    if (vrm) {
      vrm.humanoid.autoUpdateHumanBones = !clip;
      if (!clip) {
        const left = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
        const right = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
        if (left) left.rotation.z = -1.15;
        if (right) right.rotation.z = 1.15;
      }
      vrm.update(0);
    }
    gltf.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(gltf.scene).getBoundingSphere(new Sphere());
    if (!Number.isFinite(bounds.radius) || bounds.radius <= 0
      || !bounds.center.toArray().every(Number.isFinite)) {
      throw new LocalAvatarError('The model does not contain visible geometry with valid dimensions.');
    }
    let state: AvatarPlaybackState = { active: false, animated: false, mouthOpen: false, emotionalBase: null };
    let disposed = false;
    let frame: number | null = null;
    let lastTime: number | null = null;
    let elapsed = 0;
    let width = 0;
    let height = 0;

    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      lastTime = null;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', contextLost);
      controls.removeEventListener('change', draw);
      controls.dispose();
      mixer.stopAllAction();
      mixer.uncacheRoot(gltf.scene);
      disposeAvatarScenes(gltf.scenes);
      renderer.dispose();
      renderer.forceContextLoss();
    }
    function fail(error: unknown) {
      dispose();
      onError(error);
    }
    function draw() { renderFrame(0); }
    function renderFrame(delta: number) {
      if (disposed || !state.active || width <= 0 || height <= 0) return;
      try {
        if (vrm) {
          const expressions = vrm.expressionManager;
          const expression = EXPRESSION_FOR_BASE[state.emotionalBase ?? 'neutral'];
          for (const name of EXPRESSION_NAMES) expressions?.setValue(name, name === expression ? 0.65 : 0);
          expressions?.setValue('aa', state.mouthOpen ? 0.8 : 0);
          const blink = state.animated ? Math.max(0, 1 - Math.abs((elapsed % 4.6) - 4.3) / 0.12) : 0;
          expressions?.setValue('blink', state.emotionalBase === 'asleep' ? 1 : blink);
          if (!clip) {
            const chest = vrm.humanoid.getNormalizedBoneNode('chest');
            if (chest) chest.rotation.x = state.animated ? Math.sin(elapsed * 1.4) * 0.015 : 0;
          }
        }
        mixer.update(delta);
        // Update once, after pose/expression inputs and before rendering spring bones.
        vrm?.update(delta);
        renderer.render(scene, camera);
      } catch (error) { fail(error); }
    }
    function tick(time: number) {
      frame = null;
      if (disposed || !state.active || !state.animated || width <= 0 || height <= 0) return;
      const delta = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      elapsed += delta;
      renderFrame(delta);
      if (!disposed) frame = requestAnimationFrame(tick);
    }
    function refresh() {
      stop();
      controls.enabled = state.active;
      draw();
      if (!disposed && state.active && state.animated && width > 0 && height > 0) frame = requestAnimationFrame(tick);
    }
    function reset() {
      if (disposed) return;
      const vertical = MathUtils.degToRad(camera.fov) / 2;
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = bounds.radius / Math.sin(Math.min(vertical, horizontal)) * 1.1;
      controls.target.copy(bounds.center);
      camera.position.copy(bounds.center).add(new Vector3(0, 0, distance));
      camera.near = bounds.radius / 100;
      camera.far = distance + bounds.radius * 100;
      camera.updateProjectionMatrix();
      controls.minDistance = bounds.radius / 4;
      controls.maxDistance = bounds.radius * 20;
      controls.update();
      draw();
    }
    function resize() {
      if (disposed) return;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (width > 0 && height > 0) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        reset();
      }
      refresh();
    }
    function contextLost(event: Event) {
      event.preventDefault();
      fail(new LocalAvatarError('The 3D view was interrupted. Reload the model to continue.'));
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    canvas.addEventListener('webglcontextlost', contextLost);
    controls.addEventListener('change', draw);
    resize();
    return {
      format: vrm ? `VRM ${vrm.meta.metaVersion === '0' ? '0' : '1'}` : 'GLB',
      update(next) {
        if (disposed) return;
        const playbackChanged = state.active !== next.active || state.animated !== next.animated;
        state = next;
        if (playbackChanged) refresh();
        else draw();
      },
      reset,
      dispose,
    };
  } catch (error) {
    controls.dispose();
    mixer.stopAllAction();
    mixer.uncacheRoot(gltf.scene);
    disposeAvatarScenes(gltf.scenes);
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}
