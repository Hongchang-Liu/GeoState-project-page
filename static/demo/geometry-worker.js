/* Parse and rasterize unchanged point samples outside the UI thread. */
function prepareCloud(buffer){
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
  return count?{xyz,rgb,count,bounds:[...extremes].map(index=>Array.from(xyz.subarray(index*3,index*3+3)))}:null;
}

function renderCloud(cloud,snapshot){
  const {w,h,position,forward,right,up}=snapshot;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h>16000000)throw new Error('Invalid geometry viewport');
  const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d'),buffer=ctx.createImageData(w,h),zbuffer=new Float32Array(w*h);zbuffer.fill(Infinity);
  const {xyz,rgb,count}=cloud,focal=Math.min(w,h)*.95;
  // Match the original one-device-pixel footprint and nearest-depth test.
  for(let i=0;i<count;i++){
    const x=xyz[3*i]-position[0],y=xyz[3*i+1]-position[1],z=xyz[3*i+2]-position[2];
    const distance=x*forward[0]+y*forward[1]+z*forward[2];if(distance<=.1)continue;
    const u=Math.round(w/2+(x*right[0]+y*right[1]+z*right[2])*focal/distance),v=Math.round(h/2-(x*up[0]+y*up[1]+z*up[2])*focal/distance);
    if(u<0||u>=w||v<0||v>=h)continue;const index=v*w+u;
    if(distance>=zbuffer[index])continue;zbuffer[index]=distance;
    buffer.data[4*index]=rgb[3*i];buffer.data[4*index+1]=rgb[3*i+1];buffer.data[4*index+2]=rgb[3*i+2];buffer.data[4*index+3]=255;
  }
  ctx.putImageData(buffer,0,0);
  return canvas.transferToImageBitmap();
}

self.onmessage=event=>{
  const {id,kind,buffer,cloud,snapshot}=event.data,started=performance.now();
  try{
    if(kind==='prepare'){
      const result=prepareCloud(buffer);
      self.postMessage({id,cloud:result,ms:performance.now()-started},result?[result.xyz.buffer,result.rgb.buffer]:[]);
    }else if(kind==='render'){
      const bitmap=renderCloud(cloud,snapshot);
      self.postMessage({id,bitmap,ms:performance.now()-started},[bitmap]);
    }else throw new Error('Unknown geometry task');
  }catch(error){self.postMessage({id,error:error.message});}
};
