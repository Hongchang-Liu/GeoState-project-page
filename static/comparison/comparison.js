// Static comparison: forecast data never leaves the browser for model decoding.
const $ = selector => document.querySelector(selector);
const video = $('#gt-video');
const slider = $('#time');
const status = $('#cloud-status');
let manifest, scene, sceneVersion = 0, frameIndex = -1, playing = true, interactive = false;
let camera, panels = [];
const cloudCache = new Map();
let videoURL = null, mediaReady = false;
const previewCache = new Map(), videoCache = new Map(), mediaQueue = [];
let mediaActive = 0, mediaPumpScheduled = false, priorityTicket = 0;
let liveDecoderBusy=false,decoderLease=null;
window.addEventListener('message',event=>{
  if(window.parent===window||event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='geostate-comparison-download-priority'||typeof event.data.busy!=='boolean')return;
  liveDecoderBusy=event.data.busy;clearTimeout(decoderLease);
  if(liveDecoderBusy)decoderLease=setTimeout(()=>{liveDecoderBusy=false;scheduleMedia();},45000);
  scheduleMedia();
});
if(window.parent!==window)window.parent.postMessage({type:'geostate-comparison-priority-ready'},location.origin);
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
function assetPriority(job) {
  if(job.urgent && job.sceneId===scene?.id)return 0;
  if(job.sceneId===scene?.id)return job.kind==='cloud'?2:1;
  return job.kind==='cloud'?4:3;
}
function pumpMedia() {
  // Background work leaves four network slots available for user requests.
  // Recompute priorities after every scene change instead of starting a second
  // competing queue for point-cloud downloads.
  mediaQueue.sort((a,b)=>assetPriority(a)-assetPriority(b) || (assetPriority(a)===0?b.ticket-a.ticket:0));
  while(mediaQueue.length && mediaActive<6) {
    // Let in-flight transfers finish. Only new bulk/background work waits;
    // explicitly requested comparison views still work. Automatic previews
    // also yield bandwidth during the initial page load.
    if(liveDecoderBusy&&assetPriority(mediaQueue[0])>0)break;
    if(assetPriority(mediaQueue[0])>1 && mediaActive>=2)break;
    const job=mediaQueue.shift();job.state='active';mediaActive++;
    Promise.resolve().then(job.run).then(value=>{
      job.state='ready';job.resolve(value);
    },error=>{
      if(error.retryable!==false) {
        job.attempts++;
        job.state='retry';
        job.timer=setTimeout(()=>{
          job.state='queued';mediaQueue.push(job);scheduleMedia();
        },Math.min(30000,1000*2**Math.min(5,job.attempts-1)));
      } else {job.state='failed';job.reject(error);}
    }).finally(()=>{mediaActive--;scheduleMedia();});
  }
}
function queueAsset(row,kind,run) {
  const job={sceneId:row.id,kind,run,state:'queued',attempts:0,urgent:false,timer:null};
  job.pending=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
  job.promote=()=>{
    job.urgent=true;job.ticket=++priorityTicket;
    if(job.state==='retry') {
      clearTimeout(job.timer);job.state='queued';mediaQueue.push(job);
    }
    scheduleMedia();
  };
  mediaQueue.push(job);scheduleMedia();return job;
}
function previewAsset(row,url,urgent=false) {
  if(previewCache.has(url)) {
    const entry=previewCache.get(url);if(urgent)entry.job.promote();return entry;
  }
  const entry={image:null,ready:false,pending:null,job:null};
  entry.job=queueAsset(row,'preview',()=>new Promise((resolve,reject)=>{
    const image=new Image();entry.image=image;image.decoding='async';
    let settled=false;
    const timeout=setTimeout(()=>fail(new Error('Preview load timed out')),25000);
    const fail=error=>{
      if(settled)return;settled=true;clearTimeout(timeout);
      image.onload=null;image.onerror=null;image.removeAttribute('src');reject(error);
    };
    image.onerror=()=>fail(new Error('Preview image unavailable'));
    image.onload=async()=>{
      try {
        await image.decode();if(settled)return;settled=true;
        clearTimeout(timeout);image.onload=null;image.onerror=null;
        entry.ready=true;resolve(image);
      } catch(error){fail(error);}
    };
    image.src=url;
  }));
  entry.pending=entry.job.pending.catch(error=>{previewCache.delete(url);throw error;});
  if(urgent)entry.job.promote();
  previewCache.set(url,entry);return entry;
}
function cachedVideo(row,urgent=false) {
  if(!videoCache.has(row.video)) {
    const job=queueAsset(row,'video',async()=>{
      const response=await fetch(row.video,{signal:AbortSignal.timeout(25000)});
      if(!response.ok)throw Object.assign(new Error(`Video: HTTP ${response.status}`),{
        retryable:response.status>=500 || [408,425,429].includes(response.status),
      });
      return response.blob();
    });
    videoCache.set(row.video,{job,pending:job.pending.catch(error=>{videoCache.delete(row.video);throw error;})});
  }
  const entry=videoCache.get(row.video);if(urgent)entry.job.promote();return entry.pending;
}
function preloadImages(row,urgent=false) {
  return Promise.all(row.frames.flatMap(frame=>manifest.methods.flatMap(method=>
    ['depth','preview'].map(kind=>previewAsset(row,frame.methods[method.id][kind],urgent).pending))));
}
function prioritizeSelectedMedia(){
  Promise.all([preloadImages(scene,true),cachedVideo(scene,true)]).catch(()=>{});
}
function preloadEverything() {
  for(const row of manifest.scenes) {
    // Every asset is queued at page startup, even if its scene is never opened.
    // Resolved buffers stay available across scene changes and Reset view.
    Promise.all([preloadImages(row),cachedVideo(row),...row.frames.flatMap((frame,index)=>
      manifest.methods.map(method=>loadCloud(row,index,method.id)))]).catch(error=>console.warn('Comparison preload:',error));
  }
}
function displayPreview(panel,kind,url) {
  panel[`${kind}URL`]=url;
  const entry=previewAsset(scene,url,true);
  const display=()=>{
    if(panel[`${kind}URL`]!==url)return;
    const current=panel[kind];
    if(current!==entry.image){entry.image.alt=current.alt;current.replaceWith(entry.image);panel[kind]=entry.image;}
  };
  if(entry.ready)display();else entry.pending.then(display).catch(()=>{});
}
function loadCloud(row,index,method,urgent=false) {
  const url=row.frames[index].methods[method].cloud;
  if(cloudCache.has(url)) {
    const entry=cloudCache.get(url);if(urgent)entry.job.promote();return entry.pending;
  }
  const job=queueAsset(row,'cloud',async()=>{
    const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Object.assign(new Error(`Point cloud: HTTP ${response.status}`),{
      retryable:response.status>=500 || [408,425,429].includes(response.status),
    });
    const buffer=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const data=new DataView(buffer);
    if(new TextDecoder().decode(new Uint8Array(buffer,0,4))!=='GPC2'||buffer.byteLength!==8+data.getUint32(4,true)*16)
      throw Object.assign(new Error('Invalid point-cloud asset'),{retryable:false});
    return buffer;
  });
  const entry={job,pending:job.pending.catch(error=>{cloudCache.delete(url);throw error;})};
  if(urgent)job.promote();cloudCache.set(url,entry);return entry.pending;
}
async function renderClouds() {
  const version=sceneVersion,index=frameIndex;
  if(!interactive||index<0)return;
  const ready=await Promise.all(panels.map(panel=>loadCloud(scene,index,panel.method,true))).catch(error=>{
    if(version===sceneVersion)status.textContent='Point clouds unavailable';console.error(error);return null;
  });
  if(!ready||version!==sceneVersion||index!==frameIndex||!interactive)return;
  panels.forEach((panel,i)=>{panel.renderer.set(ready[i]);panel.renderer.draw();panel.cloud.classList.add('interactive');});
  status.textContent='';
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
function selectScene(row,userInitiated=false) {
  sceneVersion++;scene=row;interactive=false;camera=initialCamera();frameIndex=-1;mediaReady=false;status.textContent='Loading previews…';
  panels.forEach(panel=>panel.cloud.classList.remove('interactive'));
  document.querySelectorAll('.scene').forEach(button=>{const active=button.dataset.id===row.id;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  video.pause();video.removeAttribute('src');video.poster=row.thumbnail;video.load();
  if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
  const version=sceneVersion;
  const selectedMedia=Promise.all([preloadImages(row,userInitiated),cachedVideo(row,userInitiated)]);
  // Show the first frame promptly, but do not advance the media clock until all
  // ten depth/preview frames have been downloaded and decoded.
  const firstFrame=Promise.all(manifest.methods.flatMap(method=>
    ['depth','preview'].map(kind=>previewAsset(row,row.frames[0].methods[method.id][kind],true).pending)));
  firstFrame.then(()=>{if(version===sceneVersion)showFrame(frameIndex<0?0:frameIndex,true);}).catch(()=>{});
  selectedMedia.then(([,blob])=>{
    if(version!==sceneVersion)return;
    showFrame(frameIndex<0?0:frameIndex,true);
    videoURL=URL.createObjectURL(blob);video.src=videoURL;video.load();
    const start=()=>{
      if(version!==sceneVersion)return;
      mediaReady=true;video.currentTime=Math.max(0,frameIndex)*.25;status.textContent='';
      if(playing)setPlaying(true);
    };
    if(video.readyState>=1)start();else video.addEventListener('loadedmetadata',start,{once:true});
  }).catch(error=>{if(version===sceneVersion){status.textContent='Preview assets unavailable';setPlaying(false);}console.error(error);});
  preloadEverything();scheduleMedia();
  setPlaying(true);
}
let pointer=null;
function attachInteraction(panel) {
  panel.cloud.addEventListener('contextmenu',event=>event.preventDefault());
  panel.cloud.addEventListener('pointerdown',event=>{
    if(event.button!==0&&event.button!==2)return;
    event.preventDefault();
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,pan:event.shiftKey||event.button===2};
    panel.cloud.setPointerCapture(event.pointerId);
    if(!interactive){interactive=true;status.textContent='Loading point clouds…';renderClouds();}
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
    event.preventDefault();camera.radius=Math.max(2,Math.min(300,camera.radius*Math.exp(event.deltaY*.001)));
    if(!interactive){interactive=true;status.textContent='Loading point clouds…';renderClouds();}
    else panels.forEach(p=>{if(p.cloud.classList.contains('interactive'))p.renderer.draw();});
  },{passive:false});
}
$('#play').addEventListener('click',()=>{if(!playing&&!mediaReady)prioritizeSelectedMedia();setPlaying(!playing);});
slider.addEventListener('input',()=>{setPlaying(false);if(!mediaReady)prioritizeSelectedMedia();const index=Number(slider.value);showFrame(index);if(mediaReady)video.currentTime=(index+.02)*.25;});
$('#reset').addEventListener('click',()=>{
  camera=initialCamera();interactive=false;status.textContent='';panels.forEach(panel=>panel.cloud.classList.remove('interactive'));
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
    button.addEventListener('click',()=>selectScene(row,true));$('#scenes').append(button);
  }
  selectScene(manifest.scenes[0]);
  window.addEventListener('online',preloadEverything);
}catch(error){status.textContent='Comparison assets unavailable';console.error(error);}
