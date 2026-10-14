import {API_BASE, REQUEST_DELAY_MS} from './config.js?v=20261014-tunnel-test';

const $ = id => document.getElementById(id);
const labels = {waymo:'Waymo',kitti:'KITTI',nuscenes:'nuScenes'};
const keys = ['x','y','z','yaw','pitch'];
const offset = Object.fromEntries(keys.map(key=>[key,0]));
let scenes=[],scene=null,page=0,frame=0,online=false,playing=null;
let version=0,debounce=null,sceneVersion=0,visible=true,loadingScene=false;
let liveImageUrl=null,cloudWorker=null,workerSequence=0;
const workerJobs=new Map();
const liveCache=new Map(),CACHE_BYTES=96*1024*1024,CACHE_ENTRIES=33;
const TIME_REQUEST_DELAY_MS=60,PREFETCH_IDLE_MS=600,PREFETCH_GAP_MS=400;
const PLAY_INTERVAL_MS=450;
let cacheBytes=0,activeJob=null,foregroundDue=0,warmDue=Infinity,lastPrefetchStart=0;
let activeView='',failedCurrent='',prefetchSkipped=new Set();
const STATIC_CLOUD_BYTES=64*1024*1024,STATIC_CLOUD_ENTRIES=22;
const GEOMETRY_LAYER_BYTES=64*1024*1024,GEOMETRY_LAYER_ENTRIES=22;
const geometryLayers=new Map(),geometryJobs=new Map();
let geometryLayerBytes=0,staticCloudBytes=0,geometryWorker=null,geometrySequence=0,geometryWorkerFailed=false;
let geometryWarmToken=0,geometryWarmSignature='';
const identity = ()=>[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
let api = API_BASE.trim().replace(/\/$/,'');
if (!api && ['localhost','127.0.0.1'].includes(location.hostname)) api=`${location.protocol}//${location.hostname}:8090`;
if (api) {
  const endpoint=new URL(api,location.href);
  if(endpoint.protocol!=='https:' && !['localhost','127.0.0.1'].includes(endpoint.hostname)) api='';
}

function status(message,kind='',detail=message){ $('status').textContent=message; $('status').title=detail; $('status').className=`status ${kind}`; }
function errorStatus(error){
  const detail=error.message||String(error);
  const label=error.name==='TimeoutError'?'Timed out':/busy/i.test(detail)?'Busy · retry':/scene|manifest/i.test(detail)?'Scene unavailable':/point.cloud|geometry/i.test(detail)?'Geometry unavailable':'Decoder error';
  status(label,'error',detail);
}
const sceneName=item=>`Scene ${String(scenes.findIndex(row=>row.id===item.id)+1).padStart(3,'0')}`;
function image(id,url){
  if(id==='world'&&liveImageUrl&&url!==liveImageUrl){URL.revokeObjectURL(liveImageUrl);liveImageUrl=null;}
  if($(id).getAttribute('src')!==url){if(id==='world')delete $(id).dataset.renderKey;$(id).src=url;}
}
function queryAt(index=frame){
  if(!scene)return null;
  const params={scene:scene.id,frame:index,base:'anchor',...offset};
  const view=JSON.stringify([api,scene.id,'anchor',...keys.map(key=>params[key])]);
  return {params,view,key:JSON.stringify([view,index]),selection:sceneVersion,
    selected:index===0?scene.anchor_frame:scene.frames[index-1]};
}
function isCurrent(query){return visible&&!loadingScene&&query.selection===sceneVersion&&query.key===queryAt()?.key;}
function cachedRender(key){
  const entry=liveCache.get(key);
  if(entry){liveCache.delete(key);liveCache.set(key,entry);}
  return entry;
}
function cacheRender(entry){
  const previous=liveCache.get(entry.key);if(previous)cacheBytes-=previous.size;
  liveCache.delete(entry.key);liveCache.set(entry.key,entry);cacheBytes+=entry.size;
  while(liveCache.size>CACHE_ENTRIES||cacheBytes>CACHE_BYTES){
    const oldest=liveCache.keys().next().value;cacheBytes-=liveCache.get(oldest).size;liveCache.delete(oldest);
  }
  cacheDiagnostics();
}
function cacheDiagnostics(){
  const query=queryAt(),canvas=$('camera-map');
  canvas.dataset.cachedFrames=String([...liveCache.values()].filter(entry=>entry.view===query?.view).length);
  canvas.dataset.cacheBytes=String(cacheBytes);canvas.dataset.cacheEntries=String(liveCache.size);
}
function showDepth(query,blob,metadata,started){
  if(!isCurrent(query))return;
  if($('world').dataset.renderKey!==query.key||$('world').getAttribute('src')!==liveImageUrl){
    const url=URL.createObjectURL(blob);image('world',url);liveImageUrl=url;$('world').dataset.renderKey=query.key;
  }
  $('query-viewport').classList.remove('awaiting');
  $('world').dataset.depthReadyMs=String(performance.now()-started);
  $('camera-map').dataset.cloudStatus='processing';
}
function showRender(query,entry,started,hit=false){
  if(!isCurrent(query))return;
  showDepth(query,entry.image,entry.metadata,started);
  diagram.setPreparedCloud(entry.cloud);
  const canvas=$('camera-map');canvas.dataset.cloudStatus='ready';canvas.dataset.renderKey=query.key;
  canvas.dataset.cacheHit=String(hit);canvas.dataset.localCloudMs=String(hit?0:entry.localMs);
  canvas.dataset.cloudReadyMs=String(performance.now()-started);canvas.dataset.cloudStats=JSON.stringify(entry.stats||{});
  cacheDiagnostics();status(hit?'Ready · cached':`Ready · ${Math.round(entry.metadata.latency_ms)} ms`,online?'live':'');
}
function cancelBackground(){
  if(activeJob?.background){activeJob.cancelled=true;activeJob.controller.abort();}
}
function cancelObsoleteView(){
  if(activeJob){activeJob.cancelled=true;activeJob.controller.abort();}
}
function scheduleDecode(delay=0){
  clearTimeout(debounce);debounce=setTimeout(decode,Math.max(0,delay));
}
function localCloudWorker(){
  if(!cloudWorker){
    cloudWorker=new Worker(new URL('./pointcloud-worker.js?v=20261014-lossless-depth',import.meta.url));
    cloudWorker.onmessage=({data})=>{const job=workerJobs.get(data.id);if(!job)return;workerJobs.delete(data.id);data.error?job.reject(new Error(data.error)):job.resolve(data);};
    cloudWorker.onerror=()=>{for(const job of workerJobs.values())job.reject(new Error('Local point-cloud worker failed'));workerJobs.clear();cloudWorker.terminate();cloudWorker=null;};
  }
  return cloudWorker;
}
function buildLocalCloud(depthBuffer,metadata,selected){
  const id=++workerSequence,worker=localCloudWorker();
  const rgbUrl=new URL(selected.rgb,location.href).href,
        skyUrl=new URL(`assets/${metadata.scene}/sky-${String(metadata.frame).padStart(2,'0')}.png`,location.href).href;
  return new Promise((resolve,reject)=>{workerJobs.set(id,{resolve,reject});worker.postMessage({id,depthBuffer,metadata,rgbUrl,skyUrl},[depthBuffer]);});
}
function warmLocalAnnotations(){
  if(!globalThis.Worker||!globalThis.OffscreenCanvas||!scene)return;
  const rgbUrl=new URL(frameData().rgb,location.href).href,
        skyUrl=new URL(`assets/${scene.id}/sky-${String(frame).padStart(2,'0')}.png`,location.href).href;
  try{localCloudWorker().postMessage({kind:'warm',rgbUrl,skyUrl});}catch{}
}
async function readDepthPacket(response,onWorld){
  const reader=response.body.getReader();let pending=new Uint8Array(0),position=0;
  async function readExact(length){
    const bytes=new Uint8Array(length);let written=0;
    while(written<length){
      if(position===pending.length){const next=await reader.read();if(next.done)throw new Error('Incomplete depth response');pending=next.value;position=0;}
      const size=Math.min(length-written,pending.length-position);bytes.set(pending.subarray(position,position+size),written);position+=size;written+=size;
    }
    return bytes;
  }
  try{
    const header=await readExact(16),view=new DataView(header.buffer);
    if(view.getUint32(0,true)!==0x31445347)throw new Error('Invalid depth response');
    const metaSize=view.getUint32(4,true),imageSize=view.getUint32(8,true),depthSize=view.getUint32(12,true);
    if(metaSize>65536||imageSize>4000000||depthSize>2000000)throw new Error('Depth response too large');
    const metadata=JSON.parse(new TextDecoder().decode(await readExact(metaSize)));
    if(metadata.format!=='geostate_depth_v1'||!['gzip-float32-le','gzip-xor-shuffle-float32-le'].includes(metadata.depth_encoding)||metadata.pointcloud_filter!=='sky_connected_full_v3')throw new Error('Unsupported depth format');
    onWorld(await readExact(imageSize),metadata);
    const depthBuffer=(await readExact(depthSize)).buffer;
    if(position!==pending.length||!(await reader.read()).done)throw new Error('Unexpected depth-response bytes');
    return {metadata,depthBuffer};
  }finally{reader.releaseLock();}
}
async function unpackCloud(buffer,compressed=false){
  if(!compressed)return buffer;
  if(!globalThis.DecompressionStream)throw new Error('Update your browser to load compressed point clouds');
  const stream=new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
function stop(){clearInterval(playing);playing=null;$('play').textContent='▶';$('play').setAttribute('aria-label','Play future sequence');}
function resetOffsets(){diagram.allowDetail=false;diagram.autoFit=true;for(const key of keys)offset[key]=0; updateControls();}
function updateControls(){
  for(const key of keys) $(key+'-value').textContent=key==='yaw'||key==='pitch'?`${offset[key].toFixed(0)}°`:`${offset[key].toFixed(1)} m`;
}
function renderCards(){
  const container=$('scenes');container.replaceChildren();
  scenes.slice(page*10,page*10+10).forEach(item=>{
    const card=document.createElement('button');card.type='button';card.className='scene-card';card.classList.toggle('selected',scene?.id===item.id);
    card.setAttribute('aria-pressed',String(scene?.id===item.id));card.setAttribute('aria-label',`${sceneName(item)} · ${labels[item.dataset]}${item.zero_shot?' · Zero-shot':''}`);
    const thumb=document.createElement('img');thumb.src=item.thumbnail;thumb.alt=`Anchor RGB for ${sceneName(item)}`;thumb.loading='lazy';
    const caption=document.createElement('span');caption.className='caption';
    const dataset=document.createElement('span');dataset.className='dataset';dataset.textContent=labels[item.dataset];
    const number=document.createElement('span');number.className='identifier';number.textContent=sceneName(item);
    caption.append(number,dataset);
    if(item.zero_shot){const note=document.createElement('span');note.className='zero-shot';note.textContent='Zero-shot';caption.append(note);}
    card.append(thumb,caption);card.addEventListener('click',()=>select(item));container.append(card);
  });
  $('previous').disabled=page===0;$('next').disabled=page===Math.ceil(scenes.length/10)-1;
  $('page-label').textContent=`${page*10+1}–${Math.min(page*10+10,scenes.length)} of ${scenes.length} examples`;
  $('page-dots').replaceChildren();
  for(let index=0;index<Math.ceil(scenes.length/10);index++){
    const button=document.createElement('button');button.type='button';button.className=index===page?'active':'';button.setAttribute('aria-label',`Show scene page ${index+1}`);button.setAttribute('aria-current',String(index===page));button.addEventListener('click',()=>{page=index;renderCards();});$('page-dots').append(button);
  }
}
async function select(item){
  const ticket=++sceneVersion;version++;loadingScene=true;stop();clearTimeout(debounce);warmDue=Infinity;cancelObsoleteView();status('Loading scene');
  geometryWarmToken++;geometryWarmSignature='';delete $('camera-map').dataset.geometryWarmed;
  try{
    const response=await fetch(`assets/${item.id}/scene.json`);if(!response.ok)throw new Error('Scene assets unavailable');
    const data=await response.json();if(ticket!==sceneVersion)return;
    loadingScene=false;scene=data;frame=0;diagram.defaultObserver=true;diagram.endQueryPreview();diagram.cloud=null;diagram.fitBounds=[];diagram.viewReady=false;diagram.pan=[0,0,0];resetOffsets();$('time').value=0;$('time').max=scene.frames.length;
    $('time-ticks').replaceChildren(...[scene.anchor_frame,...scene.frames].map(row=>{const span=document.createElement('span');span.textContent=row.seconds.toFixed(2);return span;}));
    renderCards();updateFrame();
    // Decode-free references load with scene selection and are browser-cached.
    for(const row of [scene.anchor_frame,...scene.frames])for(const url of [row.rgb,row.gt_depth,row.copy_depth,row.fixed_depth]){const img=new Image();img.src=url;}
  }catch(error){if(ticket===sceneVersion){loadingScene=false;errorStatus(error);}}
}
const frameData=()=>frame===0?scene.anchor_frame:scene.frames[frame-1];
const isStaticQuery=()=>keys.every(key=>offset[key]===0)&&Boolean(frameData()?.fixed_depth);
function updateFrame(){
  if(!scene||loadingScene)return;
  diagram.allowDetail=false;
  diagram.autoFit=false;
  const selected=frameData();$('time-value').textContent=`t + ${selected.seconds.toFixed(2)} s`;
  $('time').setAttribute('aria-valuetext',`${selected.seconds.toFixed(2)} seconds after anchor`);
  image('rgb',selected.rgb);image('gt',selected.gt_depth);image('copy',selected.copy_depth);
  requestRender();
}
function requestRender(fromKeyboard=false){
  const started=performance.now();version++;updateControls();clearTimeout(debounce);
  if(!scene||loadingScene)return;
  const query=queryAt(),hit=cachedRender(query.key),staticQuery=isStaticQuery();
  if(activeView!==query.view){activeView=query.view;prefetchSkipped=new Set();cancelObsoleteView();}
  failedCurrent='';warmDue=started+PREFETCH_IDLE_MS;
  if(fromKeyboard&&online&&!staticQuery&&!hit)diagram.beginQueryPreview();else diagram.endQueryPreview();
  if(!hit&&!staticQuery)diagram.draw(true);cacheDiagnostics();
  if(staticQuery){
    cancelBackground();
    const selected=frameData();image('world',selected.fixed_depth);
    $('query-viewport').classList.remove('awaiting');
    status(online?'Ready · cached':'Cached · offline',online?'live':'',online?'Live decoder ready; cached anchor view':'Cached preview; live service not connected');
    loadCloud(selected.fixed_pointcloud,version);
    return;
  }
  if(hit){showRender(query,hit,started,true);scheduleDecode(PREFETCH_IDLE_MS);return;}
  warmLocalAnnotations();
  $('camera-map').dataset.cacheHit='false';
  diagram.setCloud(null);
  $('query-viewport').classList.add('awaiting');
  if(!online){status('Offline','error','Live decoding unavailable; cached reference only');return;}
  foregroundDue=started+(fromKeyboard?REQUEST_DELAY_MS:TIME_REQUEST_DELAY_MS);
  status('Decoding…');
  if(activeJob?.background){
    if(activeJob.query.key===query.key&&!activeJob.cancelled){activeJob.background=false;if(activeJob.image)showDepth(query,activeJob.image,activeJob.metadata,started);}
    else cancelBackground();
  }
  scheduleDecode(foregroundDue-performance.now());
}
async function decode(){
  if(activeJob||!scene||loadingScene||!online||!visible||isStaticQuery())return;
  const current=queryAt(),now=performance.now();let query=current,background=false;
  if(!liveCache.has(current.key)){
    if(failedCurrent===current.key)return;
    if(now<foregroundDue){scheduleDecode(foregroundDue-now);return;}
  }else{
    const due=Math.max(warmDue,lastPrefetchStart+PREFETCH_GAP_MS);
    if(!Number.isFinite(due))return;
    if(now<due){scheduleDecode(due-now);return;}
    // One background job at a time, nearest future frame before nearest past.
    query=null;
    for(let distance=1;distance<=scene.frames.length&&!query;distance++)for(const index of [frame+distance,frame-distance]){
      if(index<0||index>scene.frames.length)continue;
      const candidate=queryAt(index);
      if(!liveCache.has(candidate.key)&&!prefetchSkipped.has(candidate.key)){query=candidate;break;}
    }
    if(!query)return;
    background=true;lastPrefetchStart=now;
  }
  const job={query,background,cancelled:false,controller:new AbortController(),started:performance.now()};activeJob=job;
  const timeout=setTimeout(()=>job.controller.abort(new DOMException('Decode timed out','TimeoutError')),30000);
  try{
    const local=Boolean(globalThis.Worker&&globalThis.OffscreenCanvas&&globalThis.DecompressionStream);
    const response=await fetch(api+'/api/decode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...query.params,transport:local?'depth-binary-v2':'json'}),signal:job.controller.signal});
    if(!response.ok)throw new Error(response.status===429?'Decoder busy · retry shortly':`Decoder unavailable (${response.status})`);
    let cloudBuffer,stats,localMs=0;
    if(local){
      const packet=await readDepthPacket(response,(bytes,meta)=>{
        if(meta.scene!==query.params.scene||meta.frame!==query.params.frame)throw new Error('Mismatched depth response');
        job.image=new Blob([bytes],{type:'image/webp'});job.metadata=meta;
        if(!job.cancelled)showDepth(query,job.image,meta,job.started);
      });
      if(job.cancelled)return;
      const result=await buildLocalCloud(packet.depthBuffer,packet.metadata,query.selected);
      if(job.cancelled)return;
      cloudBuffer=result.buffer;stats=result.stats;localMs=result.processing_ms;
    }else{
      const result=await response.json();
      if(job.cancelled)return;
      if(result.scene!==query.params.scene||result.frame!==query.params.frame)throw new Error('Mismatched depth response');
      job.metadata={scene:result.scene,frame:result.frame,latency_ms:result.latency_ms,pose:result.pose};job.image=await (await fetch(result.world)).blob();
      showDepth(query,job.image,result,job.started);
      if(result.pointcloud){const binary=atob(result.pointcloud),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);cloudBuffer=await unpackCloud(bytes.buffer,result.pointcloud_encoding==='gzip-base64');}
      stats=result.pointcloud_stats;
    }
    if(job.cancelled)return;
    if(!cloudBuffer)throw new Error('Depth ready · point cloud unavailable');
    const cloud=diagram.prepareCloud(cloudBuffer),entry={key:query.key,view:query.view,image:job.image,
      metadata:job.metadata,cloud,stats,localMs,size:4096+job.image.size+(cloud?cloud.xyz.byteLength+cloud.rgb.byteLength+cloud.bounds.length*96:0)};
    cacheRender(entry);showRender(query,entry,job.started);
  }catch(error){
    if(!job.cancelled){
      if(job.background){prefetchSkipped.add(query.key);warmDue=performance.now()+1500;}
      if(isCurrent(query)){failedCurrent=query.key;$('camera-map').dataset.cloudStatus='error';errorStatus(error);}
    }
  }finally{
    clearTimeout(timeout);activeJob=null;
    if(isCurrent(query)&&diagram.previewFit){diagram.endQueryPreview();diagram.draw(false);}
    if(visible)scheduleDecode();
  }
}
const cloudCache=new Map();
function geometryTask(kind,payload,transfer=[]){
  if(!geometryWorker){
    geometryWorker=new Worker(new URL('./geometry-worker.js',import.meta.url));
    geometryWorker.onmessage=({data})=>{
      const job=geometryJobs.get(data.id);if(!job){data.bitmap?.close();return;}
      geometryJobs.delete(data.id);data.error?job.reject(new Error(data.error)):job.resolve(data);
    };
    geometryWorker.onerror=event=>{
      event.preventDefault();
      geometryWorkerFailed=true;
      for(const job of geometryJobs.values())job.reject(new Error('Geometry worker unavailable'));
      geometryJobs.clear();geometryWorker.terminate();geometryWorker=null;
    };
  }
  const id=++geometrySequence;
  return new Promise((resolve,reject)=>{geometryJobs.set(id,{resolve,reject});try{geometryWorker.postMessage({id,kind,...payload},transfer);}catch(error){geometryJobs.delete(id);reject(error);}});
}
const canUseGeometryWorker=()=>!geometryWorkerFailed&&Boolean(globalThis.Worker&&globalThis.OffscreenCanvas);
function geometryDiagnostics(){
  const data=$('camera-map').dataset;
  data.geometryLayerEntries=String(geometryLayers.size);data.geometryLayerBytes=String(geometryLayerBytes);
  data.preparedCloudEntries=String(cloudCache.size);data.preparedCloudBytes=String(staticCloudBytes);
}
function trimCloudCache(){
  while(cloudCache.size>STATIC_CLOUD_ENTRIES||staticCloudBytes>STATIC_CLOUD_BYTES){
    const key=cloudCache.keys().next().value,entry=cloudCache.get(key);
    staticCloudBytes-=entry.size||0;cloudCache.delete(key);
  }
  geometryDiagnostics();
}
function preparedCloud(url){
  let entry=cloudCache.get(url);
  if(entry){cloudCache.delete(url);cloudCache.set(url,entry);return entry.pending;}
  entry={size:0,cloud:null};cloudCache.set(url,entry);
  entry.pending=(async()=>{
    const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Point cloud unavailable');
    const buffer=await unpackCloud(await response.arrayBuffer(),url.endsWith('.gz'));
    let cloud;
    if(canUseGeometryWorker()){
      // Retain the input until worker startup succeeds, so blocked workers can
      // fall back to the original parser without a second network request.
      try{cloud=(await geometryTask('prepare',{buffer})).cloud;}
      catch{geometryWorkerFailed=true;cloud=diagram.prepareCloud(buffer);}
    }else cloud=diagram.prepareCloud(buffer);
    if(cloud)cloud.assetKey=url;
    if(cloudCache.get(url)===entry){
      entry.cloud=cloud;entry.size=cloud?cloud.xyz.byteLength+cloud.rgb.byteLength+cloud.bounds.length*96:0;
      staticCloudBytes+=entry.size;trimCloudCache();
    }
    return cloud;
  })().catch(error=>{if(cloudCache.get(url)===entry){staticCloudBytes-=entry.size;cloudCache.delete(url);geometryDiagnostics();}throw error;});
  trimCloudCache();return entry.pending;
}
function geometrySnapshot(view,width,height){
  const scale=Math.min(devicePixelRatio,2);
  return {w:Math.round(width*scale),h:Math.round(height*scale),...view};
}
const geometryLayerKey=(cloud,snapshot)=>JSON.stringify([cloud.assetKey,snapshot.w,snapshot.h,snapshot.position,snapshot.forward,snapshot.right,snapshot.up]);
function mainThreadCloudLayer(cloud,snapshot,canvas=document.createElement('canvas')){
  const {w,h,position,forward,right,up}=snapshot;canvas.width=w;canvas.height=h;
  const ctx=canvas.getContext('2d'),buffer=ctx.createImageData(w,h),zbuffer=new Float32Array(w*h);zbuffer.fill(Infinity);
  const {xyz,rgb,count}=cloud,focal=Math.min(w,h)*.95;
  for(let i=0;i<count;i++){
    const x=xyz[3*i]-position[0],y=xyz[3*i+1]-position[1],z=xyz[3*i+2]-position[2];
    const distance=x*forward[0]+y*forward[1]+z*forward[2];if(distance<=.1)continue;
    const u=Math.round(w/2+(x*right[0]+y*right[1]+z*right[2])*focal/distance),v=Math.round(h/2-(x*up[0]+y*up[1]+z*up[2])*focal/distance);
    if(u<0||u>=w||v<0||v>=h)continue;const index=v*w+u;
    if(distance>=zbuffer[index])continue;zbuffer[index]=distance;
    buffer.data[4*index]=rgb[3*i];buffer.data[4*index+1]=rgb[3*i+1];buffer.data[4*index+2]=rgb[3*i+2];buffer.data[4*index+3]=255;
  }
  ctx.putImageData(buffer,0,0);return canvas;
}
function geometryLayer(cloud,snapshot){
  const key=geometryLayerKey(cloud,snapshot);let entry=geometryLayers.get(key);
  if(entry){geometryLayers.delete(key);geometryLayers.set(key,entry);return entry.pending;}
  entry={bitmap:null,size:0};geometryLayers.set(key,entry);
  entry.pending=(async()=>{
    const result=canUseGeometryWorker()?await geometryTask('render',{cloud,snapshot}):{bitmap:mainThreadCloudLayer(cloud,snapshot),ms:0};
    if(geometryLayers.get(key)!==entry){result.bitmap.close?.();return null;}
    entry.bitmap=result.bitmap;entry.size=snapshot.w*snapshot.h*4;entry.renderMs=result.ms;geometryLayerBytes+=entry.size;
    while(geometryLayers.size>GEOMETRY_LAYER_ENTRIES||geometryLayerBytes>GEOMETRY_LAYER_BYTES){
      const oldest=geometryLayers.keys().next().value,removed=geometryLayers.get(oldest);
      geometryLayerBytes-=removed.size;removed.bitmap?.close?.();geometryLayers.delete(oldest);
    }
    geometryDiagnostics();return entry.bitmap;
  })().catch(error=>{if(geometryLayers.get(key)===entry){geometryLayerBytes-=entry.size;geometryLayers.delete(key);geometryDiagnostics();}throw error;});
  return entry.pending;
}
async function warmDefaultGeometry(){
  if(!scene||loadingScene||!diagram.viewReady||!diagram.cloud||!diagram.usesDefaultGeometryCache())return;
  const rect=diagram.canvas.getBoundingClientRect(),snapshot=geometrySnapshot(diagram.observer(),rect.width,rect.height);
  const signature=JSON.stringify([sceneVersion,snapshot]);if(signature===geometryWarmSignature)return;
  geometryWarmSignature=signature;const token=++geometryWarmToken;$('camera-map').dataset.geometryWarmed='0';
  const urls=[scene.anchor_frame,...scene.frames].map(row=>row.fixed_pointcloud).filter(Boolean);
  for(const url of urls){
    await new Promise(resolve=>globalThis.requestIdleCallback?requestIdleCallback(resolve,{timeout:600}):setTimeout(resolve,20));
    if(token!==geometryWarmToken||!diagram.usesDefaultGeometryCache()){if(token===geometryWarmToken)geometryWarmSignature='';return;}
    try{
      const cloud=await preparedCloud(url);
      if(token!==geometryWarmToken||!diagram.usesDefaultGeometryCache()){if(token===geometryWarmToken)geometryWarmSignature='';return;}
      if(cloud)await geometryLayer(cloud,snapshot);
    }catch{/* A missing preview never blocks the timeline or live decoding. */}
  }
  if(token===geometryWarmToken)$('camera-map').dataset.geometryWarmed=String(urls.filter(url=>{
    const cloud=cloudCache.get(url)?.cloud;return cloud&&geometryLayers.get(geometryLayerKey(cloud,snapshot))?.bitmap;
  }).length);
}
async function loadCloud(url,ticket){
  if(!url){diagram.setCloud(null);return;}
  const cachedEntry=cloudCache.get(url),cached=cachedEntry?.cloud;
  if(cached){cloudCache.delete(url);cloudCache.set(url,cachedEntry);}
  if(cached){if(ticket===version)diagram.setPreparedCloud(cached);return;}
  diagram.setCloud(null);
  try{
    const cloud=await preparedCloud(url);if(ticket===version)diagram.setPreparedCloud(cloud);
  }catch{if(ticket===version)$('camera-map').dataset.cloudStatus='error';}
}
async function checkHealth(){
  if(!api){status('Cached · offline','','Public live API not configured');return;}
  try{const response=await fetch(api+'/api/health',{signal:AbortSignal.timeout(5000)});const health=await response.json();online=response.ok&&health.ready;
    if(online&&scene)requestRender();else if(!online)status('Connecting…','','Cached preview; live decoder starting');
  }catch{online=false;if(scene)requestRender();else status('Offline');}
}

// The diagram uses perspective projection of metric 3D camera frusta. Its
// observer is independent of the query camera used by the neural decoder.
const add=(a,b)=>a.map((v,i)=>v+b[i]);const sub=(a,b)=>a.map((v,i)=>v-b[i]);const mul=(a,s)=>a.map(v=>v*s);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/(Math.hypot(...a)||1));
function matrixMultiply(a,b){return a.map(row=>b[0].map((_,j)=>row.reduce((sum,v,k)=>sum+v*b[k][j],0)));}
function queryPose(){
  const parent=identity();
  const ya=offset.yaw*Math.PI/180,pi=offset.pitch*Math.PI/180,c=Math.cos(ya),s=Math.sin(ya),p=Math.cos(pi),q=Math.sin(pi);
  const delta=[[c,s*q,s*p,offset.x],[0,p,-q,offset.y],[-s,c*q,c*p,offset.z],[0,0,0,1]];
  return matrixMultiply(parent,delta);
}
function transform(pose,point){return pose.slice(0,3).map(row=>dot(row.slice(0,3),point)+row[3]);}

class CameraDiagram{
  constructor(canvas){this.canvas=canvas;this.yaw=-.3;this.pitch=.32;this.distance=25;this.fitDistance=25;this.center=[0,0,0];this.fittedCenter=[0,0,0];this.pan=[0,0,0];this.projected=[];this.objects=[];this.cloud=null;this.fitBounds=[];this.zoom=1;this.allowDetail=false;this.autoFit=true;this.viewReady=false;this.previewFit=null;this.defaultObserver=true;
    let drag=null;
    canvas.addEventListener('pointerdown',event=>{
      if(drag||event.button>2)return;event.preventDefault();
      drag={x:event.clientX,y:event.clientY,id:event.pointerId,pan:event.button!==0||event.shiftKey};
      canvas.style.cursor=drag.pan?'move':'grabbing';canvas.focus({preventScroll:true});canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove',event=>{
      if(!drag||event.pointerId!==drag.id)return;
      this.defaultObserver=false;geometryWarmToken++;geometryWarmSignature='';
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(drag.pan){
        // Translate only the observer in its screen plane, at the current zoom.
        const rect=canvas.getBoundingClientRect(),view=this.observer(),scale=this.distance/(Math.min(rect.width,rect.height)*.95);
        this.pan=add(this.pan,add(mul(view.right,-dx*scale),mul(view.up,dy*scale)));
      }else{this.yaw-=dx*.01;this.pitch=Math.max(-1.35,Math.min(1.35,this.pitch+dy*.008));}
      drag.x=event.clientX;drag.y=event.clientY;this.draw(true);
    });
    const endDrag=event=>{if(drag&&event.pointerId===drag.id){drag=null;canvas.style.cursor='';}};
    canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);canvas.addEventListener('lostpointercapture',endDrag);
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.addEventListener('wheel',event=>{event.preventDefault();this.defaultObserver=false;geometryWarmToken++;geometryWarmSignature='';this.zoom=Math.max(.2,Math.min(6,this.zoom*Math.exp(Math.max(-200,Math.min(200,event.deltaY))*.003)));this.draw(true);},{passive:false});
    new ResizeObserver(()=>this.draw(true)).observe(canvas);
  }
  beginQueryPreview(){
    // Save the overview only once while repeated keyboard input is pending.
    if(!this.previewFit)this.previewFit={center:this.fittedCenter.slice(),distance:this.fitDistance};
  }
  endQueryPreview(){
    if(!this.previewFit)return;
    this.fittedCenter=this.previewFit.center;this.fitDistance=this.previewFit.distance;this.previewFit=null;
  }
  prepareCloud(buffer){
    if(buffer){
      const view=new DataView(buffer),count=view.getUint32(4,true);
      if(view.getUint32(0,true)!==0x31435047||count>300000||buffer.byteLength!==8+15*count)throw new Error('Invalid point-cloud asset');
      const xyz=new Float32Array(count*3),rgb=new Uint8Array(count*3),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity],extremes=new Set();
      const minimum=[0,0,0],maximum=[0,0,0];
      for(let i=0;i<count;i++)for(let axis=0;axis<3;axis++){
        const value=view.getFloat32(8+15*i+4*axis,true);if(!Number.isFinite(value))throw new Error('Invalid point-cloud position');
        xyz[3*i+axis]=value;rgb[3*i+axis]=view.getUint8(8+15*i+12+axis);
        if(value<low[axis]){low[axis]=value;minimum[axis]=i;}if(value>high[axis]){high[axis]=value;maximum[axis]=i;}
      }
      for(const index of [...minimum,...maximum])extremes.add(index);
      for(let index=0;index<count;index+=512)extremes.add(index);
      if(count)return {xyz,rgb,count,bounds:[...extremes].map(index=>Array.from(xyz.subarray(index*3,index*3+3)))};
    }
    return null;
  }
  setCloud(buffer){this.setPreparedCloud(this.prepareCloud(buffer),Boolean(buffer));}
  setPreparedCloud(cloud,ready=true){
    this.cloud=cloud;
    if(this.cloud)this.fitBounds=this.cloud.bounds;
    if(ready)this.previewFit=null;
    this.canvas.dataset.cloudPoints=String(this.cloud?.count||0);
    this.canvas.dataset.cloudStatus=ready?'ready':'none';this.draw(true);
    if(ready)this.viewReady=true;
    if(ready)warmDefaultGeometry();
  }
  frustum(pose){
    const k=scene.intrinsics;const fx=k?.[0]?.[0]||500,fy=k?.[1]?.[1]||500;
    // A fixed-size camera icon carries the actual camera orientation. All
    // center translations retain their physical, anchor-frame metric scale.
    const aspect=$('gt').naturalWidth/($('gt').naturalHeight||1)||1.5;
    const width=$('gt').naturalWidth||624,height=width/aspect;
    const length=this.iconLength||.85,halfX=length*width/(2*fx),halfY=length*height/(2*fy);
    return [[0,0,0],[-halfX,-halfY,length],[halfX,-halfY,length],[halfX,halfY,length],[-halfX,halfY,length]].map(point=>transform(pose,point));
  }
  geometry(){
    if(!scene?.camera_metadata_ready)return [];
    // Input-condition cameras remain model inputs, not display elements.
    const cameras=[];
    scene.gt_poses.slice(0,Math.max(0,frame-1)).forEach((pose,index)=>cameras.push({pose,type:'history',label:`+${scene.frames[index].seconds.toFixed(2)}`}));
    cameras.push({pose:frame===0?identity():scene.gt_poses[frame-1],type:'current'},{pose:queryPose(),type:'query'});
    const centers=cameras.map(camera=>transform(camera.pose,[0,0,0]));
    const span=Math.hypot(...[0,1,2].map(i=>Math.max(...centers.map(p=>p[i]))-Math.min(...centers.map(p=>p[i]))));
    this.iconLength=Math.max(.85,span*.055);
    return cameras.map(camera=>({...camera,points:this.frustum(camera.pose)}));
  }
  observer(center=this.center,distance=this.distance){
    const offset=[Math.sin(this.yaw)*Math.cos(this.pitch),-Math.sin(this.pitch),-Math.cos(this.yaw)*Math.cos(this.pitch)];
    const position=add(center,mul(offset,distance));const forward=unit(sub(center,position)),right=unit(cross(forward,[0,-1,0])),up=unit(cross(right,forward));
    return {position,forward,right,up};
  }
  project(point,view,width,height){const relative=sub(point,view.position),z=dot(relative,view.forward),focal=Math.min(width,height)*.95;
    return [width/2+dot(relative,view.right)*focal/z,height/2-dot(relative,view.up)*focal/z,z];}
  draw(fit=false){
    const canvas=this.canvas,rect=canvas.getBoundingClientRect(),width=rect.width,height=rect.height;if(width===0||height===0)return;
    const dpr=Math.min(devicePixelRatio,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
    this.objects=this.geometry();const points=this.objects.flatMap(camera=>camera.points);
    canvas.dataset.cameraCount=String(this.objects.length);
    canvas.dataset.pastGtCount=String(this.objects.filter(camera=>camera.type==='history').length);
    if(!points.length){ctx.fillStyle='#64748b';ctx.font='11px sans-serif';ctx.textAlign='center';ctx.fillText('Camera metadata loading…',width/2,height/2);return;}
    // Preserve the original full-canvas camera close-up for pending keyboard
    // queries only. Timeline/cloud updates keep the overview fit unchanged.
    if(fit&&(this.autoFit||!this.viewReady)){const fittingPoints=[...points,...(this.previewFit&&!this.cloud?[]:this.fitBounds)];const low=[0,1,2].map(i=>Math.min(...fittingPoints.map(p=>p[i]))),high=[0,1,2].map(i=>Math.max(...fittingPoints.map(p=>p[i])));
      this.center=mul(add(low,high),.5);this.distance=Math.max(4,Math.hypot(...sub(high,low))*.45);
      // Perspective fit accounts for wide/tall layouts and label margins,
      // not merely center distances. Far-away query frusta cannot be clipped.
      for(let attempt=0;attempt<20;attempt++){const observer=this.observer();const projected=fittingPoints.map(p=>this.project(p,observer,width,height));
        if(projected.every(([x,y,z])=>z>0&&x>30&&x<width-30&&y>25&&y<height-30))break;this.distance*=1.15;}
      this.fitDistance=this.distance;this.fittedCenter=this.center.slice();
    }
    this.distance=this.fitDistance*this.zoom;this.center=add(this.fittedCenter,this.pan);
    canvas.dataset.observerCenter=JSON.stringify(this.center);canvas.dataset.observerDistance=String(this.distance);
    canvas.dataset.queryPreview=String(Boolean(this.previewFit&&!this.cloud));
    canvas.dataset.zoom=String(this.zoom);canvas.dataset.observerPan=JSON.stringify(this.pan);canvas.dataset.queryPose=JSON.stringify(queryPose());
    const view=this.observer(),desired=this.distance/12,magnitude=10**Math.floor(Math.log10(desired));
    const factor=desired/magnitude,step=(factor<2?1:factor<5?2:5)*magnitude;
    const gridCenter=this.fittedCenter||this.center,ground=gridCenter[1]+1.7;
    ctx.strokeStyle='#dbe3ed';ctx.lineWidth=.6;ctx.setLineDash([]);
    const line=(a,b)=>{const p=this.project(a,view,width,height),q=this.project(b,view,width,height);if(p[2]<=0||q[2]<=0)return;ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0],q[1]);ctx.stroke();};
    for(let i=-5;i<=5;i++){const d=i*step;line([gridCenter[0]+d,ground,gridCenter[2]-5*step],[gridCenter[0]+d,ground,gridCenter[2]+5*step]);line([gridCenter[0]-5*step,ground,gridCenter[2]+d],[gridCenter[0]+5*step,ground,gridCenter[2]+d]);}
    this.drawCloud(ctx,view,width,height);
    const centers=this.objects.filter(camera=>camera.type!=='query').map(camera=>camera.points[0]);ctx.strokeStyle='#94a3b8';ctx.setLineDash([3,4]);ctx.lineWidth=1;for(let i=1;i<centers.length;i++)line(centers[i-1],centers[i]);
    this.projected=[];
    for(const camera of this.objects){ctx.strokeStyle=camera.type==='query'?'#dc2626':'#111827';ctx.lineWidth=camera.type==='query'?1.8:camera.type==='current'?3.6:1.3;ctx.setLineDash(camera.type==='history'?[3,3]:[]);
      for(const [a,b] of [[0,1],[0,2],[0,3],[0,4],[1,2],[2,3],[3,4],[4,1]])line(camera.points[a],camera.points[b]);
      const [x,y,z]=this.project(camera.points[0],view,width,height);this.projected.push({type:camera.type,x,y,z});ctx.setLineDash([]);
      // Centers behind the observer must not leave mirrored screen-space dots.
      if(z>0&&Number.isFinite(x)&&Number.isFinite(y)){ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(x,y,camera.type==='query'?3:2,0,Math.PI*2);ctx.fill();}
    }
    ctx.setLineDash([]);
    // Exposed for deterministic UI checks; not an inference dependency.
    canvas.dataset.fitted=String(this.projected.every(p=>p.x>=0&&p.x<=width&&p.y>=0&&p.y<=height&&p.z>0));
    this.detail(ctx,width,height);
  }
  drawCloud(ctx,view,width,height){
    if(!this.cloud){this.canvas.dataset.geometryReady='false';return;}
    if(this.usesDefaultGeometryCache()&&this.cloud.assetKey){
      const snapshot=geometrySnapshot(view,width,height),key=geometryLayerKey(this.cloud,snapshot),entry=geometryLayers.get(key);
      if(entry?.bitmap){
        geometryLayers.delete(key);geometryLayers.set(key,entry);ctx.drawImage(entry.bitmap,0,0,width,height);
        this.canvas.dataset.geometryReady='true';this.canvas.dataset.geometryCacheHit='true';this.canvas.dataset.geometryFrameKey=queryAt().key;
        this.canvas.dataset.geometryRenderMode='cached';geometryDiagnostics();return;
      }
      this.canvas.dataset.geometryReady='false';this.canvas.dataset.geometryCacheHit='false';
      this.canvas.dataset.geometryRenderMode='warming';
      const cloud=this.cloud;
      geometryLayer(cloud,snapshot).then(()=>{
        const rect=this.canvas.getBoundingClientRect();
        if(this.cloud===cloud&&this.usesDefaultGeometryCache()&&key===geometryLayerKey(cloud,geometrySnapshot(this.observer(),rect.width,rect.height))){this.draw(false);warmDefaultGeometry();}
      }).catch(()=>{if(this.cloud===cloud){this.defaultObserver=false;this.draw(false);}});
      return;
    }
    this.drawCloudImmediate(ctx,view,width,height);
  }
  usesDefaultGeometryCache(){return this.defaultObserver&&isStaticQuery()&&!this.previewFit;}
  drawCloudImmediate(ctx,view,width,height){
    // A one-device-pixel marker keeps dense clouds fine-grained on HiDPI screens.
    if(!this.cloudCanvas)this.cloudCanvas=document.createElement('canvas');
    mainThreadCloudLayer(this.cloud,geometrySnapshot(view,width,height),this.cloudCanvas);ctx.drawImage(this.cloudCanvas,0,0,width,height);
    this.canvas.dataset.geometryReady='true';this.canvas.dataset.geometryCacheHit='false';this.canvas.dataset.geometryRenderMode='interactive';
    this.canvas.dataset.geometryFrameKey=queryAt().key;
  }
  detail(ctx,width,height){
    // Only keyboard query changes enable the inset. Time/decoder redraws cannot.
    this.canvas.dataset.detail='false';
    if(!this.allowDetail||!this.previewFit)return;
    const gt=this.objects.filter(camera=>camera.type!=='query'),centers=gt.map(camera=>camera.points[0]);
    const low=[0,1,2].map(i=>Math.min(...centers.map(p=>p[i]))),high=[0,1,2].map(i=>Math.max(...centers.map(p=>p[i])));
    const span=Math.hypot(...sub(high,low)),query=this.objects.find(camera=>camera.type==='query').points[0];
    const far=Math.hypot(...sub(query,mul(add(low,high),.5)))>Math.max(12,span*5);
    if(!far)return;
    // Preserve the original distant-query GT detail during the temporary
    // keyboard close-up, never as a persistent substitute for the main view.
    const oldLength=this.iconLength;this.iconLength=Math.max(.6,span*.055);
    const objects=gt.map(camera=>({...camera,points:this.frustum(camera.pose)}));this.iconLength=oldLength;
    const points=objects.flatMap(camera=>camera.points),a=[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),b=[0,1,2].map(i=>Math.max(...points.map(p=>p[i])));
    const center=mul(add(a,b),.5),w=Math.min(165,width*.44),h=Math.min(125,height*.46);
    let distance=Math.max(3,Math.hypot(...sub(b,a))*1.4),view;
    for(let attempt=0;attempt<20;attempt++){view=this.observer(center,distance);if(points.every(p=>{const [x,y,z]=this.project(p,view,w,h);return z>0&&x>8&&x<w-8&&y>8&&y<h-8;}))break;distance*=1.15;}
    const overview=this.observer(),bounds=this.objects.map(camera=>{
      const p=camera.points.map(point=>this.project(point,overview,width,height));
      return [Math.min(...p.map(v=>v[0]))-5,Math.min(...p.map(v=>v[1]))-8,
              Math.max(...p.map(v=>v[0]))+5,Math.max(...p.map(v=>v[1]))+8];
    });
    const corners=[[9,9],[width-w-9,9],[9,height-h-31],[width-w-9,height-h-31]];
    const position=corners.find(([x,y])=>bounds.every(([a,b,c,d])=>c<x||a>x+w||d<y||b>y+h+22));
    // Never obscure any camera symbol in the metric overview with an inset.
    if(!position){this.canvas.dataset.detail='false';return;}
    this.canvas.dataset.detail='true';
    ctx.save();ctx.translate(...position);ctx.fillStyle='#ffffff';ctx.strokeStyle='#dbe3ed';ctx.lineWidth=1;ctx.setLineDash([]);ctx.fillRect(0,0,w,h+22);ctx.strokeRect(0,0,w,h+22);ctx.translate(0,20);
    for(const camera of objects){ctx.strokeStyle='#111827';ctx.lineWidth=camera.type==='current'?2:1;ctx.setLineDash(camera.type==='history'?[2,2]:[]);
      for(const [i,j] of [[0,1],[0,2],[0,3],[0,4],[1,2],[2,3],[3,4],[4,1]]){const p=this.project(camera.points[i],view,w,h),q=this.project(camera.points[j],view,w,h);ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0],q[1]);ctx.stroke();}
    }
    ctx.restore();
  }
}
const diagram=new CameraDiagram($('camera-map'));
// Canvas bitmap dimensions must not set its layout height: combining an
// auto-sized flex canvas and ResizeObserver creates a feedback growth loop.
new ResizeObserver(()=>{
  const height=Math.max(innerWidth>680?230:240,$('query-viewport').getBoundingClientRect().height);
  $('camera-map').style.height=`${height}px`;
}).observe($('query-viewport'));
$('fit').addEventListener('click',()=>{diagram.defaultObserver=true;geometryWarmToken++;geometryWarmSignature='';diagram.endQueryPreview();diagram.autoFit=true;diagram.zoom=1;diagram.pan=[0,0,0];diagram.draw(true);warmDefaultGeometry();});
$('previous').addEventListener('click',()=>{page--;renderCards();});$('next').addEventListener('click',()=>{page++;renderCards();});
$('time').addEventListener('input',()=>{frame=+$('time').value;updateFrame();});
$('play').addEventListener('click',()=>{diagram.endQueryPreview();diagram.allowDetail=false;diagram.autoFit=false;diagram.draw(true);if(playing){stop();return;}if(!scene||loadingScene)return; $('play').textContent='Ⅱ';$('play').setAttribute('aria-label','Pause future sequence');playing=setInterval(()=>{if(!visible)return;frame=(frame+1)%(scene.frames.length+1);$('time').value=frame;updateFrame();},PLAY_INTERVAL_MS);});
$('reset').addEventListener('click',()=>{resetOffsets();requestRender();});
const limits={x:[-30,30],y:[-10,10],z:[-30,60],yaw:[-90,90],pitch:[-45,45]};
function adjust(key,delta){const [low,high]=limits[key];offset[key]=Math.max(low,Math.min(high,offset[key]+delta));}
const viewport=$('query-viewport');viewport.addEventListener('pointerdown',()=>viewport.focus({preventScroll:true}));
$('time').addEventListener('pointerup',event=>{if(event.button===0)viewport.focus({preventScroll:true});});
function queryKey(event){
  // Preserve text editing and slider arrows; movement keys can leave the slider.
  if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.isComposing||!scene||loadingScene)return;
  const editing=event.target?.closest?.('input,textarea,select,[contenteditable]');
  if(event.target?.isContentEditable||(editing&&editing!==$('time')))return;
  if(editing===$('time')&&event.key.toLowerCase().startsWith('arrow'))return;
  const mappings={w:['z',.5],s:['z',-.5],a:['x',-.5],d:['x',.5],q:['y',-.25],e:['y',.25],arrowleft:['yaw',-2],arrowright:['yaw',2],arrowup:['pitch',2],arrowdown:['pitch',-2]};
  const action=mappings[event.key.toLowerCase()];
  if(action){event.preventDefault();if(editing===$('time'))viewport.focus({preventScroll:true});diagram.allowDetail=true;diagram.autoFit=true;adjust(...action);requestRender(true);}
}
document.addEventListener('keydown',queryKey);
// Same-origin project embeds can receive keys before the iframe is clicked.
// Only route keys while the demo occupies the center of the browser viewport.
if(window.parent!==window){try{
  const embed=window.frameElement;
  const parentKey=event=>{const rect=embed.getBoundingClientRect(),middle=parent.innerHeight/2;
    if(rect.width>0&&rect.top<middle&&rect.bottom>middle)queryKey(event);};
  parent.document.addEventListener('keydown',parentKey);
  window.addEventListener('pagehide',()=>parent.document.removeEventListener('keydown',parentKey));
}catch{/* Cross-origin embeds still support keyboard control inside the demo. */}}
$('gt').addEventListener('load',()=>diagram.draw(true));
document.addEventListener('visibilitychange',()=>{visible=!document.hidden;if(!visible){stop();clearTimeout(debounce);cancelBackground();}else if(scene)requestRender();});
if(window.parent!==window){const observer=new ResizeObserver(()=>parent.postMessage({type:'geostate-demo-height',height:Math.ceil(document.body.getBoundingClientRect().height)},location.origin));observer.observe(document.body);}
async function start(){try{const response=await fetch('manifest.json',{cache:'no-store'});if(!response.ok)throw new Error('Selected scene manifest is unavailable');scenes=(await response.json()).scenes;renderCards();await select(scenes[0]);await checkHealth();}catch(error){errorStatus(error);}}
start();
