/* Display-only geometry from real float32 predictions. No interpolation or GT depth. */
const annotationCache = new Map();

function inverse(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({length: n}, (_, j) => +(i === j))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) throw new Error('Invalid camera matrix');
    for (let j = 0; j < n * 2; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) if (row !== col) {
      const scale = a[row][col];
      for (let j = 0; j < n * 2; j++) a[row][j] -= scale * a[col][j];
    }
  }
  return a.map(row => row.slice(n));
}

// Match NumPy's round-to-even rule at exact half-pixel projections.
function roundEven(value) {
  const floor = Math.floor(value), fraction = value - floor;
  return fraction === .5 ? floor + (floor % 2 !== 0 ? 1 : 0) : Math.round(value);
}

async function pixels(url, width, height) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('Point-cloud annotation unavailable');
  const bitmap = await createImageBitmap(await response.blob(), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
  try {
    // Published RGB/masks already match the depth raster: never silently resize.
    if (width && (bitmap.width !== width || bitmap.height !== height)) throw new Error('Annotation dimensions mismatch');
    width = bitmap.width; height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', {willReadFrequently: true});
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } finally { bitmap.close(); }
}

function annotations(rgbUrl, skyUrl, width, height) {
  const key = JSON.stringify([rgbUrl, skyUrl]);
  if (!annotationCache.has(key)) {
    const promise = Promise.all([pixels(rgbUrl, width, height), pixels(skyUrl, width, height)]);
    annotationCache.set(key, promise);
    promise.catch(() => annotationCache.delete(key));
    if (annotationCache.size > 16) annotationCache.delete(annotationCache.keys().next().value);
  }
  return annotationCache.get(key);
}

function buildCloud(depth, meta, rgba, sky) {
  const {width, height} = meta, count = width * height;
  if (!Number.isInteger(count) || count <= 0 || count > 300000 || depth.length !== count) throw new Error('Invalid depth dimensions');
  const k = meta.intrinsics, invK = inverse(k), query = meta.pose,
        invQuery = inverse(query), invGT = inverse(meta.gt_pose);
  const xyz = new Float64Array(count * 3), cameraZ = new Float64Array(count),
        raster = new Float64Array(count), queryPixels = new Int32Array(count),
        valid = new Uint8Array(count), bins = new Int32Array(count),
        sourceZ = new Float64Array(count), nearest = new Float64Array(count);
  raster.fill(NaN); nearest.fill(Infinity);
  const stats = {input: count, raster_stride: 1, invalid_or_range: 0, unsupported: 0,
    behind_source_or_invalid: 0, outside_rgb: 0, sky_mask_available: true,
    sky: 0, occluded: 0, black_padding: 0, output: 0};
  for (let i = 0; i < count; i++) {
    const u = i % width, v = Math.floor(i / width), z = depth[i];
    const rx = invK[0][0]*u + invK[0][1]*v + invK[0][2],
          ry = invK[1][0]*u + invK[1][1]*v + invK[1][2],
          rz = invK[2][0]*u + invK[2][1]*v + invK[2][2], scale = z / rz;
    const x = rx*scale, y = ry*scale, cz = rz*scale;
    const wx = query[0][0]*x + query[0][1]*y + query[0][2]*cz + query[0][3],
          wy = query[1][0]*x + query[1][1]*y + query[1][2]*cz + query[1][3],
          wz = query[2][0]*x + query[2][1]*y + query[2][2]*cz + query[2][3];
    xyz[3*i] = wx; xyz[3*i+1] = wy; xyz[3*i+2] = wz;
    const qx = invQuery[0][0]*wx + invQuery[0][1]*wy + invQuery[0][2]*wz + invQuery[0][3],
          qy = invQuery[1][0]*wx + invQuery[1][1]*wy + invQuery[1][2]*wz + invQuery[1][3],
          qz = invQuery[2][0]*wx + invQuery[2][1]*wy + invQuery[2][2]*wz + invQuery[2][3];
    const denominator = k[2][0]*qx + k[2][1]*qy + k[2][2]*qz,
          pu = (k[0][0]*qx + k[0][1]*qy + k[0][2]*qz) / denominator,
          pv = (k[1][0]*qx + k[1][1]*qy + k[1][2]*qz) / denominator;
    if (![wx,wy,wz,pu,pv].every(Number.isFinite) || qz <= 1 || qz >= 80 || pu < -.5 || pu >= width-.5 || pv < -.5 || pv >= height-.5) {
      stats.invalid_or_range++; continue;
    }
    const bin = roundEven(pv)*width + roundEven(pu);
    queryPixels[i] = bin; cameraZ[i] = qz; raster[bin] = qz; valid[i] = 1;
  }
  for (let i = 0; i < count; i++) if (valid[i]) {
    const bin = queryPixels[i], u = bin % width, v = Math.floor(bin / width), z = raster[bin], tolerance = Math.max(.6, .08*z);
    let supported = false;
    for (let dy = -1; dy <= 1 && !supported; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || u+dx < 0 || u+dx >= width || v+dy < 0 || v+dy >= height) continue;
      if (Math.abs(raster[bin+dy*width+dx] - z) <= tolerance) { supported = true; break; }
    }
    if (!supported) { valid[i] = 0; stats.unsupported++; continue; }
    const wx = xyz[3*i], wy = xyz[3*i+1], wz = xyz[3*i+2];
    const x = invGT[0][0]*wx + invGT[0][1]*wy + invGT[0][2]*wz + invGT[0][3],
          y = invGT[1][0]*wx + invGT[1][1]*wy + invGT[1][2]*wz + invGT[1][3],
          cz = invGT[2][0]*wx + invGT[2][1]*wy + invGT[2][2]*wz + invGT[2][3];
    const denominator = k[2][0]*x + k[2][1]*y + k[2][2]*cz,
          pu = (k[0][0]*x + k[0][1]*y + k[0][2]*cz) / denominator,
          pv = (k[1][0]*x + k[1][1]*y + k[1][2]*cz) / denominator;
    if (!Number.isFinite(pu) || !Number.isFinite(pv) || cz <= .1) { valid[i] = 0; stats.behind_source_or_invalid++; continue; }
    const su = roundEven(pu), sv = roundEven(pv);
    if (su < 0 || su >= width || sv < 0 || sv >= height) { valid[i] = 0; stats.outside_rgb++; continue; }
    const source = sv*width+su;
    if (sky[4*source] > 0) { valid[i] = 0; stats.sky++; continue; }
    bins[i] = source; sourceZ[i] = cz;
    nearest[source] = Math.min(nearest[source], cz);
  }
  const selected = [];
  for (let i = 0; i < count; i++) if (valid[i]) {
    const source = bins[i], z = sourceZ[i], p = 4*source;
    if (z > nearest[source] + Math.max(.5, .03*z)) { stats.occluded++; continue; }
    if (Math.max(rgba[p], rgba[p+1], rgba[p+2]) <= 3) { stats.black_padding++; continue; }
    selected.push(i);
  }
  stats.output = selected.length;
  const buffer = new ArrayBuffer(8+15*selected.length), view = new DataView(buffer);
  view.setUint32(0, 0x31435047, true); view.setUint32(4, selected.length, true);
  selected.forEach((i, index) => {
    const p = 8+15*index, source = 4*bins[i];
    for (let axis = 0; axis < 3; axis++) { view.setFloat32(p+4*axis, xyz[3*i+axis], true); view.setUint8(p+12+axis, rgba[source+axis]); }
  });
  return {buffer, stats};
}

self.onmessage = async event => {
  const {id, depthBuffer, metadata, rgbUrl, skyUrl, compressed = true} = event.data;
  const started = performance.now();
  try {
    if (event.data.kind === 'warm') { await annotations(rgbUrl, skyUrl); return; }
    const inputs = annotations(rgbUrl, skyUrl, metadata.width, metadata.height);
    const raw = compressed ? await new Response(new Blob([depthBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : depthBuffer;
    const [rgba, sky] = await inputs;
    if (rgba.length !== metadata.width*metadata.height*4 || sky.length !== rgba.length) throw new Error('Annotation dimensions mismatch');
    const preparationMs = performance.now()-started;
    const result = buildCloud(new Float32Array(raw), metadata, rgba, sky);
    self.postMessage({id, ...result, preparation_ms: preparationMs,
                      processing_ms: performance.now()-started}, [result.buffer]);
  } catch (error) { self.postMessage({id, error: error.message}); }
};
