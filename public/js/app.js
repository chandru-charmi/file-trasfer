const $=id=>document.getElementById(id), CH=65536,BIG=1048576,HI=4194304;
let pc,dc,rx=null,txQ=[],txCur=null,busy=false;
const pack=d=>{
  const L=d.sdp.split(/\r?\n/),g=p=>(L.find(l=>l.startsWith(p))||'').slice(p.length);
  const c=L.filter(l=>l.startsWith('a=candidate:')&&/ udp /i.test(l)).map(l=>l.slice(12)).filter(l=>{const a=l.split(' ')[4];return a&&!a.includes(':')});
  return JSON.stringify([d.type[0],g('a=ice-ufrag:'),g('a=ice-pwd:'),g('a=fingerprint:sha-256 ').replace(/:/g,''),c]);
};
const unpack=t=>{
  const [ty,u,p,f,c]=JSON.parse(t.trim());
  const sdp=['v=0','o=- 1 2 IN IP4 127.0.0.1','s=-','t=0 0','a=group:BUNDLE 0','m=application 9 UDP/DTLS/SCTP webrtc-datachannel','c=IN IP4 0.0.0.0','a=ice-ufrag:'+u,'a=ice-pwd:'+p,'a=fingerprint:sha-256 '+f.match(/../g).join(':'),'a=setup:'+(ty==='o'?'actpass':'active'),'a=mid:0','a=sctp-port:5000','a=max-message-size:262144',...c.map(x=>'a=candidate:'+x),'a=end-of-candidates',''].join('\r\n');
  return {type:ty==='o'?'offer':'answer',sdp};
};
const enc=pack, dec=unpack; // short code: small, easy-to-scan QR
const status=t=>$('status').textContent=t;

function mk(){
  pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.cloudflare.com:3478','stun:stun.l.google.com:19302']}]}); // STUN lets devices on different networks find each other; offline it just times out and local Wi-Fi still works
  pc.onconnectionstatechange=()=>{
    status(pc.connectionState);
    if(pc.connectionState==='connected'){$('pair').hidden=true;$('xfer').hidden=false}
  };
  pc.ondatachannel=e=>chan(e.channel);
}
const ice=()=>new Promise(r=>{
  if(pc.iceGatheringState==='complete')return r();
  pc.addEventListener('icegatheringstatechange',()=>pc.iceGatheringState==='complete'&&r());
  setTimeout(r,4000);
});
function qr(id,text){
  const el=$(id);el.innerHTML='';
  if(window.QRCode)new QRCode(el,{text,width:300,height:300,correctLevel:QRCode.CorrectLevel.L});
  else el.textContent='QR library not added yet. Use Copy instead.';
}

function chan(c){
  dc=c;c.binaryType='arraybuffer';c.bufferedAmountLowThreshold=1048576;
  c.onmessage=e=>{
    if(typeof e.data==='string'){
      const m=JSON.parse(e.data);
      if(m.name){
        const ui=row($('rxNow'),m.name,m.size);ui.set('Receiving');
        rx={id:m.id,m,parts:[],n:0,ui};ui.b.onclick=cancelRx;
      }else if(m.done&&rx&&rx.id===m.done){
        addRx(rx.m.name,new Blob(rx.parts,{type:rx.m.type}));rx.ui.p.value=1;rx.ui.done('Received');rx=null;
      }else if(m.cancel){
        if(rx&&rx.id===m.cancel){rx.ui.done('Cancelled by sender');rx=null}
        else if(txCur&&txCur.id===m.cancel){txCur.cancel=true;txCur.why='Cancelled by receiver'}
      }
    }else if(rx){
      rx.parts.push(e.data);rx.n+=e.data.byteLength;rx.t0=rx.t0||performance.now();
      const now=performance.now();
      if(now-(rx.t||0)>250){rx.t=now;rx.ui.set('Receiving '+mbs(rx.n,rx.t0),rx.n/(rx.m.size||1))}
    }
  };
  c.onclose=()=>status('Disconnected');
}
const mbs=(n,t0)=>(n/1048576/Math.max(0.001,(performance.now()-t0)/1000)).toFixed(1)+' MB/s';
function fmt(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB'}
function uid(){return Math.random().toString(36).slice(2,9)}
function row(list,name,size){
  list.querySelector('.empty')?.remove();
  const li=document.createElement('li'),top=document.createElement('div'),nm=document.createElement('strong'),
    st=document.createElement('span'),p=document.createElement('progress'),b=document.createElement('button');
  li.className='xf';nm.textContent=name+' ('+fmt(size)+')';p.max=1;p.value=0;
  b.textContent='Cancel';b.className='alt small';
  top.append(nm,st);li.append(top,p,b);list.prepend(li);
  return{p,b,set(t,v){st.textContent=t;if(v!==undefined)p.value=v},done(t){b.remove();st.textContent=t}};
}
function cancelRx(){
  if(!rx)return;
  try{dc.send(JSON.stringify({cancel:rx.id}))}catch(e){}
  rx.ui.done('Cancelled');rx=null;
}
function cancelTx(t){
  t.cancel=true;
  if(t===txCur){try{dc.send(JSON.stringify({cancel:t.id}))}catch(e){}}
  else{t.ui.done('Cancelled');txQ=txQ.filter(x=>x!==t)}
}
async function pump(){
  if(busy)return;busy=true;
  while(txQ.length){const t=txQ.shift();if(!t.cancel)await send(t)}
  busy=false;
}
async function send(t){
  const f=t.f;txCur=t;t.ui.set('Sending');
  const t0=performance.now();let last=0;
  try{
    dc.send(JSON.stringify({id:t.id,name:f.name,size:f.size,type:f.type}));
    for(let o=0;o<f.size&&!t.cancel;o+=BIG){
      const buf=await f.slice(o,o+BIG).arrayBuffer();
      for(let i=0;i<buf.byteLength&&!t.cancel;i+=CH){
        if(dc.bufferedAmount>HI)await new Promise(r=>{
          dc.addEventListener('bufferedamountlow',r,{once:true});dc.addEventListener('close',r,{once:true})});
        if(t.cancel)break;
        dc.send(new Uint8Array(buf,i,Math.min(CH,buf.byteLength-i)));
      }
      const now=performance.now(),d=o+buf.byteLength;
      if(now-last>250){last=now;t.ui.set('Sending '+mbs(d,t0),d/f.size)}
    }
    if(!t.cancel){dc.send(JSON.stringify({done:t.id}));t.ui.p.value=1;t.ui.done('Sent')}
    else t.ui.done(t.why||'Cancelled');
  }catch(e){t.ui.done('Failed (connection lost)')}
  txCur=null;
}
function addRx(name,blob){
  const l=$('rxList');l.querySelector('.empty')?.remove();
  const li=document.createElement('li'),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=name;a.textContent=name;
  const s=document.createElement('span');s.textContent=(blob.size/1048576).toFixed(2)+' MB';
  li.append(a,s);l.prepend(li);
}

async function accept(){
  try{await pc.setRemoteDescription(dec($('answerIn').value));status('Connecting...')}
  catch(e){alert('That reply is not valid. Scan or paste it again.')}
}
async function reply(){
  try{
    mk();await pc.setRemoteDescription(dec($('offerIn').value));
    await pc.setLocalDescription(await pc.createAnswer());await ice();
    const t=enc(pc.localDescription);$('answerOut').value=t;qr('answerQR',t);$('replyBox').hidden=false;status('Waiting for the first device...');
  }catch(e){alert('That code is not valid. Scan or paste it again.')}
}
$('btnHost').onclick=async()=>{
  $('hostBox').hidden=false;$('joinBox').hidden=true;
  mk();chan(pc.createDataChannel('files'));
  await pc.setLocalDescription(await pc.createOffer());await ice();
  const t=enc(pc.localDescription);$('offerOut').value=t;qr('offerQR',t);
};
$('btnJoin').onclick=()=>{$('joinBox').hidden=false;$('hostBox').hidden=true;scan('offerIn',reply)};
$('btnScanOffer').onclick=()=>scan('offerIn',reply);
$('btnScanAnswer').onclick=()=>scan('answerIn',accept);
$('btnAccept').onclick=accept;$('btnReply').onclick=reply;
$('btnSend').onclick=()=>{
  if(!dc||dc.readyState!=='open')return alert('Not connected yet.');
  for(const f of $('file').files){
    const t={f,id:uid(),cancel:false,ui:row($('txList'),f.name,f.size)};
    t.ui.set('Waiting');t.ui.b.onclick=()=>cancelTx(t);txQ.push(t);
  }
  $('file').value='';pump();
};
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{
  const t=$(b.dataset.copy);t.select();
  try{await navigator.clipboard.writeText(t.value)}catch(e){document.execCommand('copy')}
  b.textContent='Copied';setTimeout(()=>b.textContent=b.textContent==='Copied'?'Copy again':b.textContent,1500);
});

async function scan(target,cb){
  const box=$('cam'),v=document.createElement('video');v.setAttribute('playsinline','');
  let s;
  try{s=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})}
  catch(e){return alert('Camera not available. Paste the code instead.')}
  const det=window.BarcodeDetector?new BarcodeDetector({formats:['qr_code']}):null;
  if(!det&&!window.jsQR){s.getTracks().forEach(t=>t.stop());return alert('Add js/jsQR.js to enable scanning, or paste the code.')}
  box.prepend(v);box.hidden=false;v.srcObject=s;await v.play();
  const c=document.createElement('canvas'),x=c.getContext('2d',{willReadFrequently:true});
  const stop=()=>{s.getTracks().forEach(t=>t.stop());v.srcObject=null;v.remove();box.hidden=true};
  $('stopCam').onclick=stop;
  const tick=async()=>{
    if(!v.srcObject)return;
    let txt=null;
    if(v.videoWidth){
      c.width=v.videoWidth;c.height=v.videoHeight;x.drawImage(v,0,0);
      if(det){const r=await det.detect(c);if(r[0])txt=r[0].rawValue}
      else{const d=x.getImageData(0,0,c.width,c.height),r=jsQR(d.data,d.width,d.height);if(r)txt=r.data}
    }
    if(txt){$(target).value=txt;stop();cb&&cb()}else requestAnimationFrame(tick);
  };
  tick();
}
if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
