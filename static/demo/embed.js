// Resize the isolated demo and give its decoder priority over bulk downloads.
const iframe = document.getElementById('geostate-live-demo');
const comparison = document.getElementById('geostate-comparison');
let decoderBusy=false,activeRequest=null,resumeTimer=null,leaseTimer=null;
let previewBusy=false,previewRequest=null,previewResume=null,previewLease=null;
function forwardPriority(){
  comparison?.contentWindow?.postMessage({type:'geostate-comparison-download-priority',busy:decoderBusy||previewBusy},location.origin);
}
function releasePreview(){
  clearTimeout(previewResume);clearTimeout(previewLease);
  previewBusy=false;previewRequest=null;forwardPriority();
}
function releasePriority(){
  clearTimeout(resumeTimer);clearTimeout(leaseTimer);
  decoderBusy=false;activeRequest=null;forwardPriority();
}
function queryDecodeState(){
  iframe?.contentWindow?.postMessage({type:'geostate-demo-priority-query'},location.origin);
}
window.addEventListener('message', event => {
  if(event.origin!==location.origin)return;
  if(event.source===comparison?.contentWindow&&event.data?.type==='geostate-comparison-priority-ready'){
    forwardPriority();return;
  }
  if(event.source!==iframe?.contentWindow)return;
  if(event.data?.type==='geostate-demo-height'){
    const height=Number(event.data.height);
    if(Number.isFinite(height)&&height>=300&&height<=3000){
      const target=Math.ceil(height)+2;
      if(Math.abs(iframe.getBoundingClientRect().height-target)>1)iframe.style.height=`${target}px`;
    }
  }else if(event.data?.type==='geostate-demo-decode-idle'){
    releasePriority();
  }else if(event.data?.type==='geostate-demo-preview-activity'){
    const {busy,requestId}=event.data;
    if(typeof busy!=='boolean'||typeof requestId!=='string'||requestId.length>100)return;
    if(busy){
      clearTimeout(previewResume);clearTimeout(previewLease);
      previewBusy=true;previewRequest=requestId;forwardPriority();
      previewLease=setTimeout(releasePreview,45000);
    }else if(previewRequest===requestId){
      clearTimeout(previewResume);previewResume=setTimeout(releasePreview,350);
    }
  }else if(event.data?.type==='geostate-demo-decode-activity'){
    const {busy,requestId}=event.data;
    if(typeof busy!=='boolean'||typeof requestId!=='string'||requestId.length>100)return;
    if(busy){
      clearTimeout(resumeTimer);clearTimeout(leaseTimer);
      activeRequest=requestId;decoderBusy=true;forwardPriority();
      // Longer than the decoder's 30-second timeout; iframe crashes cannot
      // leave comparison downloads suspended indefinitely.
      leaseTimer=setTimeout(releasePriority,45000);
    }else if(requestId===activeRequest){
      clearTimeout(resumeTimer);
      resumeTimer=setTimeout(releasePriority,350);
    }
  }
});
iframe?.addEventListener('load',queryDecodeState);
comparison?.addEventListener('load',forwardPriority);
queryDecodeState();forwardPriority();
