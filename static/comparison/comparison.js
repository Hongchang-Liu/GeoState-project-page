// Static comparison: forecast data never leaves the browser for model decoding.
const $ = selector => document.querySelector(selector);
const video = $('#gt-video');
const slider = $('#time');
const status = $('#cloud-status');
let manifest, scene, sceneVersion = 0, frameIndex = -1, playing = true, interactive = false;
let camera, panels = [], cloudCache = new Map(), warmVersion = 0;
let videoURL = null, mediaReady = false;
const previewCache = new Map(), videoCache = new Map(), mediaQueue = [];
let mediaActive = 0, mediaPumpScheduled = false;
const preciseVideoFrames = 'requestVideoFrameCallback' in video;
const sub = (a, b) => a.map((value, i) => value - b[i]);
const add = (a, b) => a.map((value, i) => value + b[i]);
const mul = (a, scale) => a.map(value => value * scale);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = a => mul(a, 1 / Math.max(1e-9, Math.hypot(...a)));
function initialCamera() {
  const delta = sub(manifest.observer.eye, manifest.observer.target);
  const radius = Math.hypot(...delta);
  return {target: [...manifest.observer.target], radius, yaw: Math.atan2(delta[0], delta[2]), pitch: Math.asin(delta[1]/radius)};
}
function basis() {
  const {radius:r, yaw:y, pitch:p, target:t} = camera;
  const eye = add(t, [r*Math.cos(p)*Math.sin(y), r*Math.sin(p), r*Math.cos(p)*Math.cos(y)]);
  const forward = norm(sub(t, eye)), right = norm(cross([0,1,0], forward));
  return {eye, forward, right, up: cross(forward, right)};
}

class CloudView {
  constructor(canvas) {
    this.canvas = canvas;
    this.data = null;
    this.gl = canvas.getContext('webgl', {alpha:false, antialias:false, depth:true});
    if (!this.gl) { this.ctx = canvas.getContext('2d'); return; }
    const gl = this.gl;
    const compile = (type, code) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `
      attribute vec3 position; attribute vec3 colour;
      uniform vec3 eye, right, up, forward;
      uniform vec2 projection; uniform float footprint;
      varying vec3 rgb;
      void main() {
        vec3 q = vec3(position.x,-position.y,position.z)-eye;
        float z = dot(q, forward);
        float near = .5; float far = 500.;
        gl_Position = vec4(projection.x*dot(q,right), projection.y*dot(q,up),
          (far+near)/(far-near)*z-2.*far*near/(far-near), z);
        gl_PointSize = footprint; rgb = colour;
      }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `precision mediump float; varying vec3 rgb; void main(){gl_FragColor=vec4(rgb,1.);}`);
    this.program = gl.createProgram(); gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program));
    this.buffer = gl.createBuffer(); this.position = gl.getAttribLocation(this.program, 'position'); this.colour = gl.getAttribLocation(this.program, 'colour');
    this.uniforms = Object.fromEntries(['eye','right','up','forward','projection','footprint'].map(name => [name, gl.getUniformLocation(this.program, name)]));
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clearColor(1,1,1,1);
  }
  set(data) {
    if (this.data === data) return;
    this.data = data;
    if (this.gl) {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Uint8Array(data,8), this.gl.STATIC_DRAW);
    }
  }
  draw() {
    if (!this.data) return;
    const view = basis(), gl = this.gl;
    if (!gl) { this.fallback(view); return; }
    const w = Math.max(1, Math.round(this.canvas.clientWidth*Math.min(2, devicePixelRatio||1)));
    if (this.canvas.width !== w || this.canvas.height !== Math.round(w/2)) { this.canvas.width=w; this.canvas.height=Math.round(w/2); }
    gl.viewport(0,0,this.canvas.width,this.canvas.height); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.enableVertexAttribArray(this.position); gl.vertexAttribPointer(this.position,3,gl.FLOAT,false,16,0);
    gl.enableVertexAttribArray(this.colour); gl.vertexAttribPointer(this.colour,3,gl.UNSIGNED_BYTE,true,16,12);
    for (const name of ['eye','right','up','forward']) gl.uniform3fv(this.uniforms[name],view[name]);
    gl.uniform2f(this.uniforms.projection,2*manifest.observer.focal/448,2*manifest.observer.focal/224);
    gl.uniform1f(this.uniforms.footprint,Math.max(1,3*this.canvas.width/448));
    gl.drawArrays(gl.POINTS,0,new DataView(this.data).getUint32(4,true));
  }
  fallback(view) {
    // Depth-tested software fallback keeps orbiting available without WebGL.
    this.canvas.width=448; this.canvas.height=224;
    const image=this.ctx.createImageData(448,224), zbuffer=new Float32Array(448*224).fill(Infinity);
    image.data.fill(255);
    const data=new DataView(this.data), count=data.getUint32(4,true);
    for(let i=0;i<count;i++) {
      const o=8+i*16, q=sub([data.getFloat32(o,true),-data.getFloat32(o+4,true),data.getFloat32(o+8,true)],view.eye), z=dot(q,view.forward);
      if(z<=.5) continue;
      const x=Math.round(224+500*dot(q,view.right)/z),y=Math.round(112-500*dot(q,view.up)/z);
      if(x<-1||x>448||y<-1||y>224) continue;
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) {
        const u=x+dx,v=y+dy;if(u<0||u>=448||v<0||v>=224)continue;
        const pixel=v*448+u;if(z>=zbuffer[pixel])continue;zbuffer[pixel]=z;
        for(let c=0;c<3;c++)image.data[pixel*4+c]=data.getUint8(o+12+c);
      }
    }
    this.ctx.putImageData(image,0,0);
  }
}

function setPlaying(value) {
  playing=value;
  $('#play').innerHTML=value
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 13 8-13 8z"/></svg>';
  $('#play').setAttribute('aria-label',value?'Pause playback':'Play playback');
  $('#play').setAttribute('aria-pressed',String(value));
  const version=sceneVersion;
  if(value && mediaReady && video.getAttribute('src')) video.play().catch(error => {
    if(version===sceneVersion && playing && error.name!=='AbortError') setPlaying(false);
  });
  else video.pause();
}
function scheduleMedia() {
  if(mediaPumpScheduled)return;
  mediaPumpScheduled=true;
  queueMicrotask(()=>{mediaPumpScheduled=false;pumpMedia();});
}
function pumpMedia() {
  // Foreground selections outrank queued background work. At most two background
  // downloads run when no selected-scene assets remain; foreground uses four.
  mediaQueue.sort((a,b)=>(a.sceneId===scene?.id?0:1)-(b.sceneId===scene?.id?0:1));
  while(mediaQueue.length && mediaActive < (mediaQueue[0].sceneId===scene?.id?4:2)) {
    const job=mediaQueue.shift();mediaActive++;
    job.run().then(job.resolve,job.reject).finally(()=>{mediaActive--;scheduleMedia();});
  }
}
function queueMedia(sceneId, run) {
  const pending=new Promise((resolve,reject)=>mediaQueue.push({sceneId,run,resolve,reject}));
  scheduleMedia();return pending;
}
function previewAsset(row, url) {
  if(previewCache.has(url))return previewCache.get(url);
  const entry={image:null,ready:false,pending:null};
  entry.pending=queueMedia(row.id,()=>new Promise((resolve,reject)=>{
    const image=new Image();entry.image=image;image.decoding='async';
    const timeout=setTimeout(()=>fail(new Error('Preview load timed out')),20000);
    const fail=error=>{clearTimeout(timeout);image.onload=null;image.onerror=null;reject(error);};
    image.onerror=()=>fail(new Error('Preview image unavailable'));
    image.onload=async()=>{
      try{await image.decode();clearTimeout(timeout);image.onload=null;image.onerror=null;entry.ready=true;resolve(image);}
      catch(error){fail(error);}
    };
    image.src=url;
  })).catch(error=>{previewCache.delete(url);throw error;});
  previewCache.set(url,entry);return entry;
}
function cachedVideo(row) {
  if(!videoCache.has(row.video)) {
    const pending=queueMedia(row.id,async()=>{
      const response=await fetch(row.video,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new Error('Video asset unavailable');
      return response.blob();
    }).catch(error=>{videoCache.delete(row.video);throw error;});
    videoCache.set(row.video,pending);
  }
  return videoCache.get(row.video);
}
function preloadImages(row) {
  return Promise.all(row.frames.flatMap(frame=>manifest.methods.flatMap(method=>
    ['depth','preview'].map(kind=>previewAsset(row,frame.methods[method.id][kind]).pending))));
}
function warmOtherScenes(version) {
  const run=()=>{
    if(version!==sceneVersion)return;
    for(const row of manifest.scenes)if(row.id!==scene.id) {
      // Keep all four scenes' decoded previews and small video blobs for instant
      // revisits. Full interactive point clouds remain demand-loaded.
      Promise.all([preloadImages(row),cachedVideo(row)]).catch(()=>{});
    }
  };
  if(globalThis.requestIdleCallback)requestIdleCallback(run,{timeout:1000});
  else setTimeout(run,100);
}
function displayPreview(panel, kind, url) {
  const image=previewCache.get(url);
  if(image?.ready) {
    const current=panel[kind];
    if(current!==image.image){image.image.alt=current.alt;current.replaceWith(image.image);panel[kind]=image.image;}
  } else panel[kind].src=url;
}
async function loadCloud(index, method, version=sceneVersion) {
  const key=`${index}/${method}`;
  if(cloudCache.has(key)) return cloudCache.get(key);
  const url=scene.frames[index].methods[method].cloud;
  const promise=(async()=>{
    const response=await fetch(url);
    if(!response.ok) throw new Error(`Point cloud: HTTP ${response.status}`);
    const buffer=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const data=new DataView(buffer);
    if(new TextDecoder().decode(new Uint8Array(buffer,0,4))!=='GPC2'||buffer.byteLength!==8+data.getUint32(4,true)*16) throw new Error('Invalid point-cloud asset');
    return buffer;
  })();
  cloudCache.set(key,promise);
  try{return await promise;}catch(error){if(version===sceneVersion)cloudCache.delete(key);throw error;}
}
async function renderClouds() {
  const version=sceneVersion,index=frameIndex;
  if(!interactive||index<0)return;
  const ready=await Promise.all(panels.map(panel=>loadCloud(index,panel.method,version))).catch(error=>{
    if(version===sceneVersion)status.textContent='Point clouds unavailable';console.error(error);return null;
  });
  if(!ready||version!==sceneVersion||index!==frameIndex||!interactive)return;
  panels.forEach((panel,i)=>{panel.renderer.set(ready[i]);panel.renderer.draw();panel.cloud.classList.add('interactive');});
  status.textContent='';
}
async function warmClouds() {
  const version=sceneVersion, generation=++warmVersion;
  // One future frame at a time bounds network concurrency and memory.
  for(let step=1;step<=10;step++) {
    if(version!==sceneVersion||generation!==warmVersion||!interactive)return;
    const index=(frameIndex+step)%10;
    await Promise.all(panels.map(panel=>loadCloud(index,panel.method,version))).catch(()=>{});
  }
}
function showFrame(index,force=false) {
  index=Math.max(0,Math.min(9,index));
  if(index===frameIndex&&!force)return;
  frameIndex=index;slider.value=index;
  const frame=scene.frames[index];$('#time-label').textContent=`t + ${frame.seconds.toFixed(1)} s`;
  panels.forEach(panel=>{
    const assets=frame.methods[panel.method];displayPreview(panel,'depth',assets.depth);displayPreview(panel,'preview',assets.preview);
    panel.cloud.classList.remove('interactive');
  });
  if(interactive)renderClouds();
}
function selectScene(row) {
  sceneVersion++;warmVersion++;scene=row;cloudCache=new Map();interactive=false;camera=initialCamera();frameIndex=-1;mediaReady=false;status.textContent='Loading previews…';
  panels.forEach(panel=>panel.cloud.classList.remove('interactive'));
  document.querySelectorAll('.scene').forEach(button=>{const active=button.dataset.id===row.id;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  video.pause();video.removeAttribute('src');video.poster=row.thumbnail;video.load();
  if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
  const version=sceneVersion;
  // Show the first frame promptly, but do not advance the media clock until all
  // ten depth/preview frames have been downloaded and decoded.
  const firstFrame=Promise.all(manifest.methods.flatMap(method=>
    ['depth','preview'].map(kind=>previewAsset(row,row.frames[0].methods[method.id][kind]).pending)));
  firstFrame.then(()=>{if(version===sceneVersion)showFrame(frameIndex<0?0:frameIndex,true);}).catch(()=>{});
  Promise.all([preloadImages(row),cachedVideo(row)]).then(([,blob])=>{
    if(version!==sceneVersion)return;
    showFrame(frameIndex<0?0:frameIndex,true);
    videoURL=URL.createObjectURL(blob);video.src=videoURL;video.load();
    const start=()=>{
      if(version!==sceneVersion)return;
      mediaReady=true;video.currentTime=Math.max(0,frameIndex)*.25;status.textContent='';
      if(playing)setPlaying(true);
      warmOtherScenes(version);
    };
    if(video.readyState>=1)start();else video.addEventListener('loadedmetadata',start,{once:true});
  }).catch(error=>{if(version===sceneVersion){status.textContent='Preview assets unavailable';setPlaying(false);}console.error(error);});
  scheduleMedia();
  setPlaying(true);
}
let pointer=null;
function attachInteraction(panel) {
  panel.cloud.addEventListener('contextmenu',event=>event.preventDefault());
  panel.cloud.addEventListener('pointerdown',event=>{
    if(event.button!==0&&event.button!==2)return;
    event.preventDefault();setPlaying(false);
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,pan:event.shiftKey||event.button===2};
    panel.cloud.setPointerCapture(event.pointerId);
    if(!interactive){interactive=true;status.textContent='Loading point clouds…';renderClouds().then(warmClouds);}
  });
  panel.cloud.addEventListener('pointermove',event=>{
    if(!pointer||pointer.id!==event.pointerId)return;
    const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
    pointer.x=event.clientX;pointer.y=event.clientY;
    if(pointer.pan){const v=basis(),scale=camera.radius*.002;camera.target=add(camera.target,add(mul(v.right,-dx*scale),mul(v.up,dy*scale)));}
    else{camera.yaw-=dx*.008;camera.pitch=Math.max(-1.45,Math.min(1.45,camera.pitch+dy*.008));}
    panels.forEach(p=>{if(p.cloud.classList.contains('interactive'))p.renderer.draw();});
  });
  const release=event=>{if(pointer?.id===event.pointerId)pointer=null;};
  panel.cloud.addEventListener('pointerup',release);panel.cloud.addEventListener('pointercancel',release);
  panel.cloud.addEventListener('wheel',event=>{
    event.preventDefault();setPlaying(false);camera.radius=Math.max(2,Math.min(300,camera.radius*Math.exp(event.deltaY*.001)));
    if(!interactive){interactive=true;status.textContent='Loading point clouds…';renderClouds().then(warmClouds);}
    else panels.forEach(p=>{if(p.cloud.classList.contains('interactive'))p.renderer.draw();});
  },{passive:false});
}
$('#play').addEventListener('click',()=>setPlaying(!playing));
slider.addEventListener('input',()=>{setPlaying(false);const index=Number(slider.value);showFrame(index);if(mediaReady)video.currentTime=(index+.02)*.25;});
$('#reset').addEventListener('click',()=>{
  camera=initialCamera();interactive=false;warmVersion++;status.textContent='';panels.forEach(panel=>panel.cloud.classList.remove('interactive'));
});
// Do not mix the ahead-of-display media clock with presented-frame callbacks.
video.addEventListener('timeupdate',()=>{if(scene&&mediaReady&&playing&&!preciseVideoFrames)showFrame(Math.min(9,Math.floor((video.currentTime+1e-6)/.25)));});
video.addEventListener('loadedmetadata',()=>{if(playing)setPlaying(true);});
video.addEventListener('error',()=>{status.textContent='Video unavailable';setPlaying(false);});
if(preciseVideoFrames) {
  const onFrame=(now,metadata)=>{if(scene&&mediaReady&&playing)showFrame(Math.min(9,Math.floor((metadata.mediaTime+1e-6)/.25)));video.requestVideoFrameCallback(onFrame);};
  video.requestVideoFrameCallback(onFrame);
}
const observer=new ResizeObserver(()=>{
  window.parent.postMessage({type:'geostate-comparison-height',height:Math.ceil(document.body.scrollHeight+8)},'*');
  if(interactive)panels.forEach(panel=>{if(panel.cloud.classList.contains('interactive'))panel.renderer.draw();});
});observer.observe(document.body);

try {
  const response=await fetch('manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('Missing comparison manifest');manifest=await response.json();
  for(const method of manifest.methods){
    const figure=document.createElement('figure');figure.className=`method-column ${method.id==='ours'?'ours':''}`;
    const depthBox=document.createElement('div');depthBox.className='depth-view';const depth=new Image();depth.alt=`${method.label} predicted depth`;depthBox.append(depth);
    const cloud=document.createElement('div');cloud.className='cloud-view';cloud.setAttribute('aria-label',`${method.label} interactive predicted point cloud`);
    const preview=new Image();preview.alt=`${method.label} RGB-coloured predicted geometry`;
    const canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');cloud.append(preview,canvas);
    const caption=document.createElement('figcaption');caption.textContent=method.label;figure.append(depthBox,cloud,caption);$('#board').append(figure);
    const panel={method:method.id,depth,preview,cloud,renderer:new CloudView(canvas)};panels.push(panel);attachInteraction(panel);
  }
  for(const [index,row] of manifest.scenes.entries()){
    const button=document.createElement('button');button.type='button';button.className='scene';button.dataset.id=row.id;button.setAttribute('aria-label',`Scene ${index+1}`);
    const image=new Image();image.src=row.thumbnail;image.alt='';const caption=document.createElement('div');caption.className='caption';
    const label=document.createElement('strong');label.textContent=`Scene ${index+1}`;caption.append(label);button.append(image,caption);
    button.addEventListener('click',()=>selectScene(row));$('#scenes').append(button);
  }
  selectScene(manifest.scenes[0]);
}catch(error){status.textContent='Comparison assets unavailable';console.error(error);}
