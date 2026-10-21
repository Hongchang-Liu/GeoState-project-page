/* Retain decoded image elements, not just browser HTTP-cache entries. */
export class DecodedImages {
  constructor({maxBytes=96*1024*1024,maxEntries=100}={}) {
    this.entries=new Map();this.owned=new WeakSet();this.pinned=new Set();
    this.bytes=0;this.maxBytes=maxBytes;this.maxEntries=maxEntries;
  }
  key(id,url){return JSON.stringify([id,url]);}
  pin(items){this.pinned=new Set(items.map(([id,url])=>this.key(id,url)));this.trim();}
  get(id,url,urgent=true){
    const key=this.key(id,url);let entry=this.entries.get(key);
    if(entry){
      this.entries.delete(key);this.entries.set(key,entry);
      if(urgent)entry.image.fetchPriority='high';
      return entry;
    }
    const image=new Image();image.decoding='async';image.fetchPriority=urgent?'high':'low';
    entry={image,ready:false,size:0,pending:null};this.owned.add(image);this.entries.set(key,entry);
    image.src=url;
    entry.pending=image.decode().then(()=>{
      entry.ready=true;entry.size=image.naturalWidth*image.naturalHeight*4;
      if(this.entries.get(key)===entry){this.bytes+=entry.size;this.trim();}
      return entry;
    }).catch(error=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw error;});
    return entry;
  }
  trim(){
    for(const [key,entry] of this.entries){
      if(this.entries.size<=this.maxEntries&&this.bytes<=this.maxBytes)break;
      if(this.pinned.has(key)||entry.image.isConnected)continue;
      this.entries.delete(key);this.bytes-=entry.size;
    }
  }
  show(id,entry){
    if(!entry.ready)throw new Error('Image is not decoded');
    const current=document.getElementById(id),next=entry.image;
    if(current===next)return next;
    // The same decoded element is reused on revisits; preserve display attributes.
    for(const name of next.getAttributeNames())if(!['src','decoding','fetchpriority'].includes(name))next.removeAttribute(name);
    for(const attr of current.attributes)if(!['src','srcset','loading','decoding','fetchpriority'].includes(attr.name))next.setAttribute(attr.name,attr.value);
    current.replaceWith(next);return next;
  }
  detach(id){
    const current=document.getElementById(id);
    if(!this.owned.has(current))return current;
    // Live Blob URLs must never overwrite a retained static-frame element.
    const next=document.createElement('img');
    for(const attr of current.attributes)if(attr.name!=='src')next.setAttribute(attr.name,attr.value);
    current.replaceWith(next);return next;
  }
}

// Defer geometry work until the browser has had an opportunity to paint depth.
export const afterImagePaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
