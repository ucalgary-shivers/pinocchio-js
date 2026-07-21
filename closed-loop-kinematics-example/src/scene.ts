import * as THREE from "three";

const GRID_SIZE = 20;
const GRID_DIVISIONS = 20;

export function createScene(container: HTMLElement): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  animate: () => void;
  resize: () => void;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  const aspect = container.clientWidth / container.clientHeight;
  const viewSize = 6;
  const camera = new THREE.OrthographicCamera(
    -viewSize * aspect,
    viewSize * aspect,
    viewSize,
    -viewSize,
    0.1,
    100,
  );
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x444466, 0x333355);
  gridHelper.rotation.x = Math.PI / 2;
  scene.add(gridHelper);

  const axesHelper = new THREE.AxesHelper(3);
  scene.add(axesHelper);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const a = w / h;
    camera.left = -viewSize * a;
    camera.right = viewSize * a;
    camera.top = viewSize;
    camera.bottom = -viewSize;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function animate() {
    renderer.render(scene, camera);
  }

  return { scene, camera, renderer, animate, resize };
}
