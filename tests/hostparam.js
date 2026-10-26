const fs=require('fs'); const {Context}=require('../engine/webaudio-engine.js'); const sr=48000; const e=new Context(sr); e.addModule(fs.readFileSync(__dirname+'/analogexact.worklet.js','utf8'));
process.on('unhandledRejection', e => console.warn('[page async noise] ' + String(e && e.message || e).slice(0, 120)));
e.setHostParamNames(['inDb','outDb','monitor','speed']);
const rms=(a)=>{let s=0;for(const v of a)s+=v*v;return 20*Math.log10(Math.sqrt(s/a.length)+1e-30)};
const run=()=>{const n=sr/2,i=new Float32Array(n),o=new Float32Array(n),o2=new Float32Array(n);for(let k=0;k<n;k++)i[k]=0.1*Math.sin(2*Math.PI*1000*k/sr);e.render(i,i,o,o2,n);return rms(o.subarray(n-8192))};
console.log('empty graph passthrough:', run().toFixed(2), '(expect -23.01)');
e.applyJSON(JSON.stringify([{op:'reset'},{op:'create',id:1,type:'Destination'},{op:'create',id:2,type:'MediaStreamSource'},{op:'create',id:3,type:'AudioWorklet',name:'analogexact-dsp',options:{outputChannelCount:[2]}},{op:'connect',from:2,to:3},{op:'connect',from:3,to:1},
 {op:'post',id:3,data:{type:'params',params:{inDb:0,outDb:0,biasDb:0,headroomDb:0,monitor:0,headblock:0,speed:15,flux:250,eqStd:0,tapeType:1,transformer:1,tapeHiss:0,wowFlutter:0,vibe:0,preserve:0,xfTrim:1}}}]));
console.log('UI->host notifications:', JSON.stringify(e.drainOutbox().filter(m=>m.id===-2)[0]));
console.log('monitor=INPUT:', run().toFixed(2));
console.log('hostParam(monitor,1) via', e.hostParam('monitor',1), '->', run().toFixed(2), '(expect ~ -22.07)');
console.log('hostParam(inDb,-6) via', e.hostParam('inDb',-6), '->', run().toFixed(2));
console.log('hostParam(nonexistent):', e.hostParam('foo',1), 'errors', e.errors);
