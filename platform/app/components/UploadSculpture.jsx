import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import './upload-sculpture.css';

const PALETTE = { magenta: 0xA31551, wine: 0x4A0221, coral: 0xFC9385, sky: 0x61CFFF };
const clampProgress = value => value == null || !Number.isFinite(Number(value)) ? null : THREE.MathUtils.clamp(Number(value), 0, 100);

// Angular index order lets the real upload progress reveal the ring without
// allocating new geometry or rebuilding the renderer on every progress event.
function progressGeometry(radius, tube, radialSegments = 8, tubularSegments = 160) {
  const geometry = new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments);
  const indices = [];
  for (let i = 1; i <= tubularSegments; i++) {
    for (let j = 1; j <= radialSegments; j++) {
      const a = (tubularSegments + 1) * j + i - 1;
      const b = (tubularSegments + 1) * (j - 1) + i - 1;
      const c = (tubularSegments + 1) * (j - 1) + i;
      const d = (tubularSegments + 1) * j + i;
      indices.push(a, b, d, b, c, d);
    }
  }
  geometry.setIndex(indices);
  geometry.setDrawRange(0, 0);
  return { geometry, segments: tubularSegments, indicesPerSegment: radialSegments * 6 };
}

function roundedBar(parent, material, width, height, depth, radius, x, y, z, rotation = 0) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 3, radius), material);
  mesh.position.set(x, y, z);
  mesh.rotation.z = rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/**
 * Procedural, local Three.js upload sculpture. No images, models or network
 * resources. `progress` is the upload's actual byte percentage, or null.
 */
export default function UploadSculpture({ reduced = false, active = false, progress = null, compact = false }) {
  const hostRef = useRef(null);
  const canvasHostRef = useRef(null);
  const runtimeRef = useRef(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [webgl, setWebgl] = useState(false);
  const [osReduced, setOsReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const effectiveReduced = reduced || osReduced;
  const normalizedProgress = clampProgress(progress);
  const propsRef = useRef({ reduced: effectiveReduced, active, progress: normalizedProgress, compact });

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setOsReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // This watcher also pauses the CSS fallback when WebGL could not start.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let visible = true;
    const update = () => { host.dataset.paused = String(document.hidden || !visible); };
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting !== false; update(); }, { threshold: 0 });
    observer.observe(host);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    propsRef.current = { reduced: effectiveReduced, active, progress: normalizedProgress, compact };
    if (effectiveReduced) {
      pointerRef.current = { x: 0, y: 0 };
      hostRef.current?.style.setProperty('--sculpture-pointer-x', '0deg');
      hostRef.current?.style.setProperty('--sculpture-pointer-y', '0deg');
    }
    runtimeRef.current?.invalidate();
  }, [effectiveReduced, active, normalizedProgress, compact]);

  useEffect(() => {
    const host = hostRef.current;
    const canvasHost = canvasHostRef.current;
    if (!host || !canvasHost) return undefined;

    let renderer;
    let environmentTarget;
    let pmrem;
    let room;
    let disposed = false;
    let mounted = true;
    let frameId = 0;
    let previousFrame = 0;
    let elapsed = 0;
    let inViewport = true;
    let hasSize = false;
    let currentActive = 0;
    let currentProgress = 0;
    let currentPointerX = 0;
    let currentPointerY = 0;
    let resizeObserver;
    let intersectionObserver;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 40);
    camera.position.set(0, 0.25, 5.9);
    camera.lookAt(0, -0.03, 0);

    const stop = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = 0;
      previousFrame = 0;
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stop();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      renderer?.domElement.removeEventListener('webglcontextlost', onContextLost);
      const geometries = new Set();
      const materials = new Set();
      scene.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
        object.shadow?.map?.dispose();
        object.shadow?.mapPass?.dispose();
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
      environmentTarget?.dispose();
      room?.dispose();
      pmrem?.dispose();
      if (renderer) {
        renderer.renderLists.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      }
      if (runtimeRef.current?.dispose === dispose) runtimeRef.current = null;
    };

    function onVisibility() {
      if (document.hidden) stop();
      else runtimeRef.current?.invalidate();
    }

    function onContextLost(event) {
      event.preventDefault();
      dispose();
      if (mounted) setWebgl(false);
    }

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
      canvasHost.appendChild(renderer.domElement);

      // This environment is generated from local geometry, not an HDR image.
      room = new RoomEnvironment();
      pmrem = new THREE.PMREMGenerator(renderer);
      environmentTarget = pmrem.fromScene(room, 0.04, 0.1, 100, { size: 128 });
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 1.5;
      room.dispose();
      room = null;
      pmrem.dispose();
      pmrem = null;

      const ambient = new THREE.HemisphereLight(0xffffff, 0x5d203c, 2.05);
      scene.add(ambient);
      const key = new THREE.DirectionalLight(0xffffff, 3.8);
      key.position.set(-3.3, 4.8, 4);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      Object.assign(key.shadow.camera, { left: -3.1, right: 3.1, top: 3.1, bottom: -3.1, near: 0.5, far: 14 });
      key.shadow.normalBias = 0.035;
      key.shadow.bias = -0.00015;
      key.shadow.radius = 4;
      scene.add(key);
      const fill = new THREE.DirectionalLight(PALETTE.sky, 1.55);
      fill.position.set(3, 1.1, 2.5);
      scene.add(fill);
      const rim = new THREE.DirectionalLight(PALETTE.coral, 2.2);
      rim.position.set(0.4, 2, -3);
      scene.add(rim);

      const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ color: PALETTE.wine, opacity: 0.16 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.65;
      floor.receiveShadow = true;
      scene.add(floor);

      const sculpture = new THREE.Group();
      sculpture.rotation.set(-0.12, -0.34, -0.1);
      scene.add(sculpture);

      const magentaMaterial = new THREE.MeshPhysicalMaterial({ color: PALETTE.wine, metalness: 0.58, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.1, transmission: 0.1, thickness: 0.5, ior: 1.48, envMapIntensity: 1.35 });
      const coralMaterial = new THREE.MeshPhysicalMaterial({ color: 0xd2d8e0, metalness: 0.72, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.3 });
      const glassMaterial = new THREE.MeshPhysicalMaterial({ color: 0xc9f0ff, metalness: 0.03, roughness: 0.1, transmission: 0.86, thickness: 0.65, ior: 1.48, clearcoat: 1, clearcoatRoughness: 0.04, attenuationColor: new THREE.Color(PALETTE.sky), attenuationDistance: 2.4, envMapIntensity: 1.6 });
      const wineMaterial = new THREE.MeshPhysicalMaterial({ color: PALETTE.wine, metalness: 0.22, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 });
      const skyMaterial = new THREE.MeshPhysicalMaterial({ color: PALETTE.sky, metalness: 0.4, roughness: 0.17, clearcoat: 1, envMapIntensity: 1.1 });
      const paleMaterial = new THREE.MeshStandardMaterial({ color: 0xffeee9, metalness: 0.25, roughness: 0.25 });

      const rotor = new THREE.Group();
      rotor.rotation.z = 0.28;
      sculpture.add(rotor);
      const arc = Math.PI * 2 / 3 - 0.48;
      [magentaMaterial, coralMaterial, glassMaterial].forEach((material, index) => {
        const segment = new THREE.Mesh(new THREE.TorusGeometry(1.13, 0.085, 16, 76, arc), material);
        segment.rotation.z = index * Math.PI * 2 / 3;
        segment.castShadow = true;
        segment.receiveShadow = true;
        rotor.add(segment);
        // Rounded end caps keep the segmented ring sculptural, not pipe-cut.
        const capGeometry = new THREE.SphereGeometry(0.085, 16, 12);
        [0, arc].forEach(angle => {
          const cap = new THREE.Mesh(capGeometry, material);
          const worldAngle = index * Math.PI * 2 / 3 + angle;
          cap.position.set(Math.cos(worldAngle) * 1.13, Math.sin(worldAngle) * 1.13, 0);
          cap.castShadow = true;
          cap.receiveShadow = true;
          rotor.add(cap);
        });
      });

      const tile = new THREE.Group();
      tile.position.z = 0.16;
      tile.rotation.z = 0.075;
      sculpture.add(tile);
      roundedBar(tile, glassMaterial, 1.12, 1.49, 0.22, 0.14, 0, 0, 0.02);
      roundedBar(tile, wineMaterial, 0.94, 1.3, 0.15, 0.11, 0, 0, 0.14);
      roundedBar(tile, magentaMaterial, 0.81, 0.9, 0.055, 0.085, 0, -0.07, 0.235);
      [-0.31, -0.17, -0.03].forEach(x => roundedBar(tile, paleMaterial, 0.075, 0.035, 0.025, 0.014, x, 0.48, 0.232));
      const playShape = new THREE.Shape();
      playShape.moveTo(-0.045, -0.055);
      playShape.lineTo(-0.045, 0.055);
      playShape.lineTo(0.055, 0);
      playShape.closePath();
      const play = new THREE.Mesh(new THREE.ExtrudeGeometry(playShape, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.007, bevelSegments: 2, steps: 1 }), skyMaterial);
      play.position.set(0.29, 0.48, 0.23);
      tile.add(play);

      const uploadArrow = new THREE.Group();
      uploadArrow.position.set(0, 0.015, 0.31);
      tile.add(uploadArrow);
      roundedBar(uploadArrow, coralMaterial, 0.095, 0.45, 0.09, 0.035, 0, 0.035, 0);
      roundedBar(uploadArrow, coralMaterial, 0.095, 0.29, 0.09, 0.033, -0.085, 0.17, 0, -Math.PI / 4);
      roundedBar(uploadArrow, coralMaterial, 0.095, 0.29, 0.09, 0.033, 0.085, 0.17, 0, Math.PI / 4);
      roundedBar(uploadArrow, paleMaterial, 0.49, 0.075, 0.065, 0.025, 0, -0.29, 0);
      roundedBar(uploadArrow, paleMaterial, 0.075, 0.17, 0.065, 0.025, -0.208, -0.24, 0);
      roundedBar(uploadArrow, paleMaterial, 0.075, 0.17, 0.065, 0.025, 0.208, -0.24, 0);

      const orbit = new THREE.Group();
      orbit.rotation.set(0.4, 0.25, 0.3);
      sculpture.add(orbit);
      const orbitMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.sky, metalness: 0.65, roughness: 0.3, transparent: true, opacity: 0.38 });
      const orbitTrack = new THREE.Mesh(new THREE.TorusGeometry(1.53, 0.012, 8, 128), orbitMaterial);
      orbitTrack.rotation.x = 0.26;
      orbit.add(orbitTrack);
      const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 14), skyMaterial);
      pearl.position.set(1.53, 0, 0);
      pearl.castShadow = true;
      orbit.add(pearl);
      const diamond = new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.14, 0.14, 3, 0.025), coralMaterial);
      diamond.position.set(-1.31, -0.75, -0.16);
      diamond.rotation.set(0.45, 0.35, Math.PI / 4);
      orbit.add(diamond);

      const progressMeshData = progressGeometry(1.51, 0.025);
      const progressMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.sky, metalness: 0.35, roughness: 0.22, emissive: PALETTE.sky, emissiveIntensity: 0.22 });
      const progressRing = new THREE.Mesh(progressMeshData.geometry, progressMaterial);
      progressRing.position.z = 0.1;
      progressRing.rotation.z = Math.PI / 2;
      progressRing.scale.x = -1;
      sculpture.add(progressRing);

      function draw(now) {
        frameId = 0;
        if (disposed || document.hidden || !inViewport || !hasSize) return;
        const props = propsRef.current;
        const delta = Math.min(previousFrame ? (now - previousFrame) / 1000 : 1 / 60, 0.05);
        previousFrame = now;
        if (!props.reduced) elapsed += delta;
        const blend = props.reduced ? 1 : 1 - Math.exp(-delta * 6);
        const targetActive = props.active || props.progress != null ? 1 : 0;
        currentActive += (targetActive - currentActive) * blend;
        currentProgress += ((props.progress ?? 0) - currentProgress) * blend;
        currentPointerX += ((props.reduced ? 0 : pointerRef.current.x) - currentPointerX) * blend;
        currentPointerY += ((props.reduced ? 0 : pointerRef.current.y) - currentPointerY) * blend;
        const t = props.reduced ? 0 : elapsed;
        sculpture.rotation.set(-0.12 + currentPointerY * 0.17, -0.34 + currentPointerX * 0.34, -0.1 + Math.sin(t * 0.33) * 0.025);
        sculpture.position.y = Math.sin(t * 0.75) * 0.055 + currentActive * 0.045;
        sculpture.scale.setScalar(1 + currentActive * 0.055);
        rotor.rotation.z = 0.28 + t * 0.105 + currentActive * 0.12;
        tile.rotation.y = Math.sin(t * 0.5) * 0.04;
        uploadArrow.position.y = 0.015 + currentActive * (0.025 + Math.sin(t * 2) * 0.015);
        orbit.rotation.z = 0.3 - t * 0.07;
        orbit.rotation.y = 0.25 + Math.sin(t * 0.4) * 0.09;
        diamond.rotation.y = 0.35 + t * 0.23;
        progressRing.visible = props.progress != null;
        progressMeshData.geometry.setDrawRange(0, Math.round(currentProgress / 100 * progressMeshData.segments) * progressMeshData.indicesPerSegment);
        orbitMaterial.opacity = 0.34 + currentActive * 0.2;
        try {
          renderer.render(scene, camera);
        } catch {
          dispose();
          if (mounted) setWebgl(false);
          return;
        }
        if (!props.reduced) frameId = window.requestAnimationFrame(draw);
      }

      function invalidate() {
        if (disposed) return;
        if (propsRef.current.reduced) stop();
        if (!frameId && !document.hidden && inViewport && hasSize) frameId = window.requestAnimationFrame(draw);
      }

      function resize() {
        if (disposed) return;
        const { width, height } = host.getBoundingClientRect();
        hasSize = width > 0 && height > 0;
        if (!hasSize) { stop(); return; }
        const dpr = Math.min(window.devicePixelRatio || 1, width < 360 ? 1.5 : 1.75);
        renderer.setPixelRatio(dpr);
        renderer.setSize(Math.round(width), Math.round(height), false);
        camera.aspect = width / height;
        camera.position.z = 5.9 * Math.max(1, 1 / camera.aspect);
        camera.updateProjectionMatrix();
        invalidate();
      }

      runtimeRef.current = { invalidate, dispose };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      intersectionObserver = new IntersectionObserver(entries => {
        inViewport = entries[0]?.isIntersecting !== false;
        host.dataset.paused = String(!inViewport || document.hidden);
        if (!inViewport) stop();
        else invalidate();
      }, { threshold: 0 });
      intersectionObserver.observe(host);
      document.addEventListener('visibilitychange', onVisibility);
      resize();
      // The canvas stays transparent while the local environment initializes.
      if (hasSize) renderer.render(scene, camera);
      setWebgl(true);
    } catch {
      dispose();
      if (mounted) setWebgl(false);
    }

    return () => { mounted = false; dispose(); };
  }, []);

  const onPointerMove = event => {
    if (effectiveReduced) return;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
    const y = THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
    pointerRef.current = { x, y };
    hostRef.current.style.setProperty('--sculpture-pointer-x', `${x * 15}deg`);
    hostRef.current.style.setProperty('--sculpture-pointer-y', `${-y * 10}deg`);
    runtimeRef.current?.invalidate();
  };
  const onPointerLeave = () => {
    pointerRef.current = { x: 0, y: 0 };
    hostRef.current?.style.setProperty('--sculpture-pointer-x', '0deg');
    hostRef.current?.style.setProperty('--sculpture-pointer-y', '0deg');
    runtimeRef.current?.invalidate();
  };

  return <div ref={hostRef} className={`upload-sculpture ${compact ? 'upload-sculpture--compact' : ''} ${webgl ? 'upload-sculpture--webgl' : 'upload-sculpture--fallback'}`} data-active={active || normalizedProgress != null} data-progress={normalizedProgress != null} data-reduced={effectiveReduced} style={{ '--sculpture-progress': normalizedProgress ?? 0 }} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} aria-hidden="true">
    <div className="upload-sculpture__ambient" />
    <div className="upload-sculpture__canvas" ref={canvasHostRef} />
    <div className="upload-sculpture__fallback">
      <div className="upload-sculpture__fallback-shadow" />
      <div className="upload-sculpture__fallback-model">
        <div className="upload-sculpture__fallback-orbit" />
        <div className="upload-sculpture__fallback-progress" />
        <div className="upload-sculpture__fallback-ring" />
        <div className="upload-sculpture__fallback-tile"><span className="upload-sculpture__fallback-perforations"/><span className="upload-sculpture__fallback-arrow"/><span className="upload-sculpture__fallback-tray"/></div>
        <div className="upload-sculpture__fallback-pearl" />
      </div>
    </div>
  </div>;
}
