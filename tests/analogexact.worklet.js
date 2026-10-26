/* === AudioWorklet code === */
const INPUT_DB_OFFSET=0; // FIX #1: no hidden -5dB attenuation before saturation
const CROSSTALK_DB=-40;
function clamp(v,a,b){return v<a?a:(v>b?b:v);}
function db2gain(db){const d=Math.max(db,-60); return Math.pow(10,d/20);}

class Biquad{
  constructor(sr){this.sr=sr; this.b0=1;this.b1=0;this.b2=0;this.a1=0;this.a2=0; this.z1=0;this.z2=0;}
  set(type,freq,Q,gainDb){
    const sr=this.sr, f=clamp(freq,5,0.49*sr), w0=2*Math.PI*f/sr;
    const c=Math.cos(w0), s=Math.sin(w0), q=Math.max(0.05,Q||0.707);
    const A=Math.pow(10,(gainDb||0)/40), sqrtA=Math.sqrt(A);
    let b0,b1,b2,a0,a1,a2;
    if(type==='lowpass'){const alpha=s/(2*q); b0=(1-c)/2;b1=1-c;b2=(1-c)/2; a0=1+alpha;a1=-2*c;a2=1-alpha;}
    else if(type==='highpass'){const alpha=s/(2*q); b0=(1+c)/2;b1=-(1+c);b2=(1+c)/2; a0=1+alpha;a1=-2*c;a2=1-alpha;}
    else if(type==='peaking'){const alpha=s/(2*q); b0=1+alpha*A;b1=-2*c;b2=1-alpha*A; a0=1+alpha/A;a1=-2*c;a2=1-alpha/A;}
    else if(type==='lowshelf'){
      const S=1.0; const alpha=s/2*Math.sqrt(((A+1/A)*(1/S-1))+2);
      b0=A*((A+1)-(A-1)*c+2*sqrtA*alpha);
      b1=2*A*((A-1)-(A+1)*c);
      b2=A*((A+1)-(A-1)*c-2*sqrtA*alpha);
      a0=(A+1)+(A-1)*c+2*sqrtA*alpha;
      a1=-2*((A-1)+(A+1)*c);
      a2=(A+1)+(A-1)*c-2*sqrtA*alpha;
    } else if(type==='highshelf'){
      const S=1.0; const alpha=s/2*Math.sqrt(((A+1/A)*(1/S-1))+2);
      b0=A*((A+1)+(A-1)*c+2*sqrtA*alpha);
      b1=-2*A*((A-1)+(A+1)*c);
      b2=A*((A+1)+(A-1)*c-2*sqrtA*alpha);
      a0=(A+1)-(A-1)*c+2*sqrtA*alpha;
      a1=2*((A-1)-(A+1)*c);
      a2=(A+1)-(A-1)*c-2*sqrtA*alpha;
    } else { b0=1;b1=0;b2=0;a0=1;a1=0;a2=0; }
    const inv=1/a0;
    this.b0=b0*inv; this.b1=b1*inv; this.b2=b2*inv; this.a1=a1*inv; this.a2=a2*inv;
  }
  process(x){
    const y=this.b0*x + this.z1;
    this.z1=this.b1*x - this.a1*y + this.z2;
    this.z2=this.b2*x - this.a2*y;
    return y;
  }
}

class XorShift{constructor(seed){this.x=seed>>>0;if(!this.x)this.x=123456789;}
  next(){let x=this.x; x^=x<<13; x>>>=0; x^=x>>17; x>>>=0; x^=x<<5; x>>>=0; this.x=x>>>0; return (x/2147483648)-1;}
}

class DelayLine{
  constructor(sr,maxSec){this.sr=sr; this.len=Math.max(8,(maxSec*sr|0)+4); this.bufL=new Float32Array(this.len); this.bufR=new Float32Array(this.len); this.w=0;}
  write(l,r){this.bufL[this.w]=l; this.bufR[this.w]=r; this.w=(this.w+1)%this.len;}
  read(delaySamples){
    const d=clamp(delaySamples,0,this.len-3);
    let idx=this.w-d; while(idx<0) idx+=this.len;
    const i0=idx|0, frac=idx-i0, i1=(i0+1)%this.len;
    const l0=this.bufL[i0], l1=this.bufL[i1], r0=this.bufR[i0], r1=this.bufR[i1];
    return [l0+(l1-l0)*frac, r0+(r1-r0)*frac];
  }
}

class OS4{constructor(fn){this.fn=fn; this.pL=0; this.pR=0;}
  processL(x){const p=this.pL, d=(x-p)*0.25; const y=0.25*(this.fn(p+d)+this.fn(p+2*d)+this.fn(p+3*d)+this.fn(x)); this.pL=x; return y;}
  processR(x){const p=this.pR, d=(x-p)*0.25; const y=0.25*(this.fn(p+d)+this.fn(p+2*d)+this.fn(p+3*d)+this.fn(x)); this.pR=x; return y;}
}

/* === Jiles-Atherton + bias (FIXED bias frequency) === */
function _langevin(x){
  const ax = Math.abs(x);
  if(ax < 1e-4){
    const x2 = x*x;
    return x*(1/3 - x2/45 + (2*x2*x2)/945);
  }
  return (1/Math.tanh(x)) - (1/x);
}
class JilesAthertonCore{
  constructor(params){
    this.setParams(params || { Ms:350000, a:22000, k:25465, c:0.17, alpha:0.0016 });
    this.reset();
  }
  setParams(p){
    this.Ms = Math.max(1, p.Ms||350000);
    this.a  = Math.max(1e-9, p.a||22000);
    this.k  = Math.max(1e-9, p.k||25465);
    this.c  = clamp((p.c!=null)?p.c:0.17, 0, 1);
    this.alpha = Math.max(0, (p.alpha!=null)?p.alpha:0.0016);
  }
  reset(){ this.M=0; this.Mirr=0; this.H=0; }
  _Man(H, Mguess){
    const He = H + this.alpha * Mguess;
    const xi = He / this.a;
    let Man = this.Ms * _langevin(xi);
    return clamp(Man, -this.Ms, this.Ms);
  }
  initAtField(H){
    this.H = H;
    let M = 0;
    for(let it=0; it<4; it++) M = this._Man(H, M);
    this.M = clamp(M, -this.Ms, this.Ms);
    this.Mirr = this.M;
  }
  step(Hnew){
    const dH = Hnew - this.H;
    if(Math.abs(dH) < 1e-12){ this.H = Hnew; return this.M / this.Ms; }
    const delta = (dH >= 0) ? 1 : -1;
    const Mirr0 = this.Mirr;
    let Mirr = this.Mirr;
    let M = this.M;
    for(let it=0; it<3; it++){
      const Man = this._Man(Hnew, M);
      const diff = Man - Mirr;
      let dMirr_dH = 0;
      if(diff * delta > 0){
        let denom = (this.k * delta) - (this.alpha * diff);
        if(Math.abs(denom) < 1e-9) denom = (denom >= 0 ? 1 : -1) * 1e-9;
        dMirr_dH = diff / denom;
      }
      Mirr = clamp(Mirr0 + dMirr_dH * dH, -this.Ms, this.Ms);
      M = clamp((1 - this.c) * Mirr + this.c * Man, -this.Ms, this.Ms);
    }
    this.H = Hnew; this.Mirr = Mirr; this.M = M;
    return M / this.Ms;
  }
}

class TapeJAHysteresisStage{
  constructor(baseSr, params){
    this.sr = baseSr;
    this.OS = 8;
    this.srOS = this.sr * this.OS;

    // FIX #2: bias at sr/2 -> 16 samples/cycle at 8x OS (stable hysteresis)
    this.biasHz = this.sr * 0.5;
    const w = 2*Math.PI*(this.biasHz / this.srOS);
    this.sinInc = Math.sin(w);
    this.cosInc = Math.cos(w);

    this.oscSin = 0;
    this.oscCos = 1;

    this.lp1 = new Biquad(this.srOS);
    this.lp2 = new Biquad(this.srOS);

    this.core = new JilesAthertonCore(params || { Ms:350000, a:22000, k:25465, c:0.17, alpha:0.0016 });

    this.prevX = 0;
    this.Hscale = 1;
    this.biasBaseH = 0;
    this.biasGain = 1;
    this.biasAmpH = 0;

    this.setMediaParams(params || { Ms:350000, a:22000, k:25465, c:0.17, alpha:0.0016 });
    this.setBiasGainFromDb(0);
  }

  _resetFilters(){ this.lp1.z1=0; this.lp1.z2=0; this.lp2.z1=0; this.lp2.z2=0; }

  reset(){
    this.core.reset();
    this.prevX = 0;
    this.oscSin = 0;
    this.oscCos = 1;
    this._resetFilters();
  }

  setMediaParams(p){
    if(!p) return;
    this.core.setParams(p);

    this.Hscale = 3.0 * this.core.a;
    const BIAS_MULT = 4.0;
    this.biasBaseH = BIAS_MULT * this.core.k;

    const cutoff = Math.min(22050, this.sr * 0.46);
    this.lp1.sr = this.srOS;
    this.lp2.sr = this.srOS;
    this.lp1.set('lowpass', cutoff, 0.5411961, 0);
    this.lp2.set('lowpass', cutoff, 1.3065630, 0);
    this._resetFilters();

    this.biasAmpH = this.biasBaseH * this.biasGain;
  }

  setBiasGainFromDb(biasDb){
    this.biasGain = db2gain(biasDb||0);
    this.biasAmpH = this.biasBaseH * this.biasGain;
  }

  initAtInput(x){
    this.reset();
    this.prevX = x;
    this.core.initAtField(x * this.Hscale);
  }

  process(x){
    const OS = this.OS;
    const Hs = this.Hscale;
    const biasA = this.biasAmpH;

    let sin = this.oscSin, cos = this.oscCos;
    const sinInc = this.sinInc, cosInc = this.cosInc;

    let xi = this.prevX;
    const step = (x - xi) / OS;

    let y = 0;

    for(let i=0;i<OS;i++){
      xi += step;
      const H = (xi * Hs) + (biasA * sin);
      let v = this.core.step(H);
      v = this.lp1.process(v);
      v = this.lp2.process(v);
      y = v;

      const sinN = sin*cosInc + cos*sinInc;
      const cosN = cos*cosInc - sin*sinInc;
      sin = sinN; cos = cosN;
    }

    this.prevX = x;
    this.oscSin = sin;
    this.oscCos = cos;

    return y;
  }
}

/* === FFT match-EQ (FIX #5: smaller FFT => less latency) === */
class FFT{
  constructor(n){
    this.n=n; this.levels=(Math.log2(n)|0);
    this.cos=new Float32Array(n/2); this.sin=new Float32Array(n/2);
    for(let i=0;i<n/2;i++){ const a=-2*Math.PI*i/n; this.cos[i]=Math.cos(a); this.sin[i]=Math.sin(a); }
    this.br=new Uint32Array(n);
    for(let i=0;i<n;i++){ let x=i,y=0; for(let j=0;j<this.levels;j++){ y=(y<<1)|(x&1); x>>=1; } this.br[i]=y>>>0; }
  }
  forward(re,im){
    const n=this.n, br=this.br;
    for(let i=0;i<n;i++){ const j=br[i]; if(j>i){ let tr=re[i];re[i]=re[j];re[j]=tr; let ti=im[i];im[i]=im[j];im[j]=ti; } }
    for(let size=2; size<=n; size<<=1){
      const half=size>>1, step=n/size;
      for(let i=0;i<n;i+=size){
        let k=0;
        for(let j=i;j<i+half;j++){
          const l=j+half, wr=this.cos[k], wi=this.sin[k];
          const tr=wr*re[l]-wi*im[l], ti=wr*im[l]+wi*re[l];
          re[l]=re[j]-tr; im[l]=im[j]-ti;
          re[j]=re[j]+tr; im[j]=im[j]+ti;
          k+=step;
        }
      }
    }
  }
  inverse(re,im){
    for(let i=0;i<this.n;i++) im[i]=-im[i];
    this.forward(re,im);
    const inv=1/this.n;
    for(let i=0;i<this.n;i++){ re[i]=re[i]*inv; im[i]=-im[i]*inv; }
  }
}

class PcMatchEqCore{
  constructor(postCurve){
    this.N=512; this.H=256; this.R=this.N*4;
    this.fft=new FFT(this.N);
    this.win=new Float32Array(this.N);
    for(let i=0;i<this.N;i++){ const hann=0.5*(1-Math.cos(2*Math.PI*i/(this.N-1))); this.win[i]=Math.sqrt(hann); }
    this.wet=[new Float32Array(this.R), new Float32Array(this.R)];
    this.dry=[new Float32Array(this.R), new Float32Array(this.R)];
    this.ola=[new Float32Array(this.R), new Float32Array(this.R)];
    this.wpos=0; this.rpos=0; this.hc=0;

    this.reL=new Float32Array(this.N); this.imL=new Float32Array(this.N);
    this.reR=new Float32Array(this.N); this.imR=new Float32Array(this.N);
    this.drL=new Float32Array(this.N); this.diL=new Float32Array(this.N);
    this.drR=new Float32Array(this.N); this.diR=new Float32Array(this.N);

    const bins=(this.N>>1)+1;
    this.wetDb=new Float32Array(bins); this.dryDb=new Float32Array(bins);
    this.gain=new Float32Array(bins); this.tmpDb=new Float32Array(bins);
    for(let k=0;k<bins;k++) this.gain[k]=1;

    this._send=0; this.postCurve=postCurve;
  }
  _frame(ring,start,re,im){
    const R=this.R, N=this.N, w=this.win;
    for(let i=0;i<N;i++){ const idx=(start+i)%R; re[i]=ring[idx]*w[i]; im[i]=0; }
  }
  reset(){
    this.ola[0].fill(0); this.ola[1].fill(0); this.hc=0;
    for(let k=0;k<this.gain.length;k++) this.gain[k]=1;
  }
  processBlock(wetL,wetR,dryL,dryR,outL,outR,amount){
    const nS=wetL.length;
    const maxDb=18.0, tSmooth=0.84, adapt0=0.22, gateDb=-76.0, fSmooth=0.30;
    if(amount<=1e-4){
      for(let i=0;i<nS;i++){ outL[i]=wetL[i]; outR[i]=wetR[i]; }
      this.reset(); return;
    }

    const R=this.R;
    for(let i=0;i<nS;i++){
      this.wet[0][this.wpos]=wetL[i]; this.wet[1][this.wpos]=wetR[i];
      this.dry[0][this.wpos]=dryL[i]; this.dry[1][this.wpos]=dryR[i];
      const ol=this.ola[0][this.rpos], or=this.ola[1][this.rpos];
      this.ola[0][this.rpos]=0; this.ola[1][this.rpos]=0;
      outL[i]=ol; outR[i]=or;
      this.wpos=(this.wpos+1)%R; this.rpos=(this.rpos+1)%R; this.hc++;
    }

    const bins=(this.N>>1)+1;
    const adapt=adapt0*(0.35+0.65*amount);

    while(this.hc>=this.H){
      this.hc-=this.H;
      const start=(this.wpos - this.N + R) % R;

      this._frame(this.wet[0],start,this.reL,this.imL);
      this._frame(this.wet[1],start,this.reR,this.imR);
      this._frame(this.dry[0],start,this.drL,this.diL);
      this._frame(this.dry[1],start,this.drR,this.diR);

      this.fft.forward(this.reL,this.imL); this.fft.forward(this.reR,this.imR);
      this.fft.forward(this.drL,this.diL); this.fft.forward(this.drR,this.diR);

      for(let k=0;k<bins;k++){
        const w1=Math.sqrt(this.reL[k]*this.reL[k]+this.imL[k]*this.imL[k]);
        const w2=Math.sqrt(this.reR[k]*this.reR[k]+this.imR[k]*this.imR[k]);
        const d1=Math.sqrt(this.drL[k]*this.drL[k]+this.diL[k]*this.diL[k]);
        const d2=Math.sqrt(this.drR[k]*this.drR[k]+this.diR[k]*this.diR[k]);

        const wmag=0.5*(w1+w2)+1e-12;
        const dmag=0.5*(d1+d2)+1e-12;

        const wdb=20*Math.log10(wmag);
        const ddb=20*Math.log10(dmag);

        this.wetDb[k]=tSmooth*this.wetDb[k]+(1-tSmooth)*wdb;
        this.dryDb[k]=tSmooth*this.dryDb[k]+(1-tSmooth)*ddb;
      }

      this.tmpDb[0]=0; this.tmpDb[bins-1]=0;
      for(let k=1;k<bins-1;k++){
        const wd=this.wetDb[k], dd=this.dryDb[k];
        if(wd<gateDb && dd<gateDb){ this.tmpDb[k]=0; continue; }
        let diff=(dd-wd);
        if(diff>maxDb) diff=maxDb;
        if(diff<-maxDb) diff=-maxDb;
        const wgt=Math.max(0,Math.min(1,(dd-gateDb)/22));
        this.tmpDb[k]=diff*wgt*amount;
      }

      // shape-only (remove mean)
      let lvlSum=0, lvlCnt=0;
      for(let k=1;k<bins-1;k++){
        if(Math.abs(this.tmpDb[k])>1e-6){ lvlSum+=this.tmpDb[k]; lvlCnt++; }
      }
      if(lvlCnt>0){
        const lvlAvg=lvlSum/lvlCnt;
        for(let k=1;k<bins-1;k++) this.tmpDb[k]-=lvlAvg;
      }

      if(fSmooth>1e-4){
        for(let k=2;k<bins-2;k++){
          const sm=(this.tmpDb[k-2]+2*this.tmpDb[k-1]+3*this.tmpDb[k]+2*this.tmpDb[k+1]+this.tmpDb[k+2])/9;
          this.tmpDb[k]=(1-fSmooth)*this.tmpDb[k]+fSmooth*sm;
        }
      }

      for(let k=1;k<bins-1;k++){
        const targetLin=Math.pow(10,this.tmpDb[k]/20);
        this.gain[k]=this.gain[k]+adapt*(targetLin-this.gain[k]);
      }
      this.gain[0]=1; this.gain[bins-1]=1;

      for(let k=0;k<bins;k++){
        const g=this.gain[k];
        this.reL[k]*=g; this.imL[k]*=g;
        this.reR[k]*=g; this.imR[k]*=g;
        const mk=(k===0||k===bins-1)?-1:(this.N-k);
        if(mk>0 && mk<this.N){
          this.reL[mk]*=g; this.imL[mk]*=g;
          this.reR[mk]*=g; this.imR[mk]*=g;
        }
      }

      this.fft.inverse(this.reL,this.imL);
      this.fft.inverse(this.reR,this.imR);

      for(let i=0;i<this.N;i++){
        const idx=(start+i)%R, w=this.win[i];
        this.ola[0][idx]+=this.reL[i]*w;
        this.ola[1][idx]+=this.reR[i]*w;
      }

      this._send++;
      if(this._send>=4 && this.postCurve){
        this._send=0;
        const dec=4;
        const outBins=Math.min(64, Math.floor((bins-2)/dec));
        const arr=new Array(outBins);
        for(let i=0;i<outBins;i++){
          const kk=1+i*dec;
          arr[i]=20*Math.log10(Math.max(1e-6,this.gain[kk]));
        }
        this.postCurve(arr);
      }
    }
  }
}

const TAPE_TYPES=['406','456','499','GP9','SM900','SM911'];
const tapeHysteresisParams = {
  "406":  { Ms: 330000, a: 24000, k: 26260, c: 0.22, alpha: 0.0018 },
  "456":  { Ms: 350000, a: 22000, k: 25465, c: 0.17, alpha: 0.0016 },
  "499":  { Ms: 400000, a: 19000, k: 31035, c: 0.12, alpha: 0.0014 },
  "GP9":  { Ms: 420000, a: 20000, k: 29443, c: 0.10, alpha: 0.0012 },
  "SM900":{ Ms: 400000, a: 21000, k: 29443, c: 0.14, alpha: 0.0014 },
  "SM911":{ Ms: 360000, a: 23000, k: 25465, c: 0.15, alpha: 0.0015 }
};
const tapeProfiles = {
  "406": { saturationK: 2.2, saturationSoftness: 0.70, asymmetry: 0.15, hfShelfGain: -1.5, hfShelfFreq: 8000 },
  "456": { saturationK: 1.6, saturationSoftness: 0.75, asymmetry: 0.12, hfShelfGain: -0.5, hfShelfFreq: 10000 },
  "499": { saturationK: 0.9, saturationSoftness: 0.60, asymmetry: 0.10, hfShelfGain: +0.5, hfShelfFreq: 12000 },
  "GP9": { saturationK: 0.8, saturationSoftness: 0.90, asymmetry: 0.08, hfShelfGain: 0.0, hfShelfFreq: 14000 },
  "SM900":{ saturationK: 1.0, saturationSoftness: 0.95, asymmetry: 0.10, hfShelfGain: +1.0, hfShelfFreq: 16000 },
  "SM911":{ saturationK: 1.4, saturationSoftness: 0.80, asymmetry: 0.12, hfShelfGain: +0.3, hfShelfFreq: 12000 }
};
const headBumpBySpeed = { 7.5:{freq:50,gain:2.8,Q:1.0}, 15:{freq:80,gain:2.2,Q:1.1}, 30:{freq:120,gain:1.6,Q:1.2} };
const speedNoiseOffset = { 7.5:+6, 15:+3, 30:0 };
const fluxivitySpecs = { 185:{dbOver185:0}, 250:{dbOver185:2.6}, 370:{dbOver185:6.0}, 500:{dbOver185:8.6} };
const tapeFluxivitySpecs = {
  "406": { inherentNoiseDb:-58, molOver185:9.0,  outputClass:3, designedFlux:250 },
  "456": { inherentNoiseDb:-62, molOver185:12.3, outputClass:6, designedFlux:370 },
  "499": { inherentNoiseDb:-65, molOver185:17.4, outputClass:9, designedFlux:500 },
  "GP9": { inherentNoiseDb:-73, molOver185:17.5, outputClass:9, designedFlux:500 },
  "SM900":{ inherentNoiseDb:-62, molOver185:18.8, outputClass:9, designedFlux:500 },
  "SM911": { inherentNoiseDb:-60.5,molOver185:17.3, outputClass:6, designedFlux:370 }
};
const wowFlutterSpecs = {
  7.5:{wowDepth:0.0008,flutterDepth:0.0003,wowRate:0.8,flutterRate:7.5},
  15:{wowDepth:0.0005,flutterDepth:0.0002,wowRate:1.0,flutterRate:9.0},
  30:{wowDepth:0.0003,flutterDepth:0.0001,wowRate:1.2,flutterRate:12.0}
};
function getEQ(speed, eqStd01){
  const std=(eqStd01>=0.5)?'IEC':'NAB';
  const table={
    NAB:{7.5:{repro_hf:[3180,-1.25]},15:{repro_hf:[3180,-0.75]},30:{repro_hf:[3180,-0.50]}},
    IEC:{7.5:{repro_hf:[2270,-0.75]},15:{repro_hf:[4550,-0.25]},30:{repro_hf:[9100, 0.00]}}
  };
  return (table[std] && table[std][speed]) || table.NAB[15];
}
function calculateTapeFluxInteraction(tapeType, fluxivity){
  const tape=tapeFluxivitySpecs[tapeType]||tapeFluxivitySpecs['456'];
  const flux=fluxivitySpecs[fluxivity]||fluxivitySpecs[250];
  const effectiveNoiseDb=tape.inherentNoiseDb - flux.dbOver185;
  const headroomDb=tape.molOver185 - flux.dbOver185;
  const isOptimal=(fluxivity===tape.designedFlux);
  const isCompatible=(flux.dbOver185<=tape.outputClass+1.5);
  return {effectiveNoiseDb, headroomDb, isOptimal, isCompatible};
}

class AnalogExactDSP extends AudioWorkletProcessor{
  static get parameterDescriptors(){
    return [
      {name:'inDb', defaultValue:0, minValue:-12, maxValue:12, automationRate:'k-rate'},
      {name:'outDb', defaultValue:0, minValue:-24, maxValue:6, automationRate:'k-rate'},
      {name:'biasDb', defaultValue:0, minValue:-5, maxValue:5, automationRate:'k-rate'},
      {name:'headroomDb', defaultValue:0, minValue:-12, maxValue:12, automationRate:'k-rate'},
      {name:'monitor', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'headblock', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'speed', defaultValue:15, minValue:7.5, maxValue:30, automationRate:'k-rate'},
      {name:'flux', defaultValue:250, minValue:185, maxValue:500, automationRate:'k-rate'},
      {name:'eqStd', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'tapeType', defaultValue:1, minValue:0, maxValue:5, automationRate:'k-rate'},
      {name:'transformer', defaultValue:1, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'tapeHiss', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'wowFlutter', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'vibe', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'preserve', defaultValue:0, minValue:0, maxValue:1, automationRate:'k-rate'},
      {name:'xfTrim', defaultValue:1, minValue:0.125, maxValue:8, automationRate:'k-rate'}
    ];
  }

  constructor(){
    super();
    this.sr=sampleRate;

    this.tapeHFShelf=[new Biquad(this.sr), new Biquad(this.sr)];
    this.biasHF=[new Biquad(this.sr), new Biquad(this.sr)];
    this.headBump=[new Biquad(this.sr), new Biquad(this.sr)];
    this.deemph=[new Biquad(this.sr), new Biquad(this.sr)];

    this.xfPrimaryHP=[new Biquad(this.sr), new Biquad(this.sr)];
    this.xfLFBoost=[new Biquad(this.sr), new Biquad(this.sr)];
    this.xfLFCut=[new Biquad(this.sr), new Biquad(this.sr)];
    this.xfCoreLoss=[new Biquad(this.sr), new Biquad(this.sr)];
    this.xfLeakageLP=[new Biquad(this.sr), new Biquad(this.sr)];
    this.lpOut=[new Biquad(this.sr), new Biquad(this.sr)];

    this.noiseHP=[new Biquad(this.sr), new Biquad(this.sr)];
    this.noiseHF=[new Biquad(this.sr), new Biquad(this.sr)];

    this.delay=new DelayLine(this.sr, 0.10);
    this.phWow=0; this.phFl=0; this.phFl2=0;

    this.ctLin=db2gain(CROSSTALK_DB);
    this.mainLin=1-this.ctLin;

    this.rngL=new XorShift(0x12345678);
    this.rngR=new XorShift(0x87654321);

    this.curveToSend=null;
    this.matchEq=new PcMatchEqCore((arr)=>{ this.curveToSend=arr; });

    this._tapeFn=(x)=>x;
    this._xfFn=(x)=>Math.tanh(x*0.5)*0.997;
    this.tapeOS=new OS4((x)=>this._tapeFn(x));
    this.xfOS=new OS4((x)=>this._xfFn(x));

    this.jaL = new TapeJAHysteresisStage(this.sr, tapeHysteresisParams["456"]);
    this.jaR = new TapeJAHysteresisStage(this.sr, tapeHysteresisParams["456"]);
    this._useJA = false;
    this._jaTT = "456";
    this._vibeTransition = 0;

    this._biasKPos=1.6;
    this._biasKNeg=1.6;
    this._biasAsym=0.12;
    this._dcxL=0;this._dcyL=0;this._dcxR=0;this._dcyR=0;

    this._derived={};
    this._last={};

    this.mAccL=0; this.mAccR=0; this.mN=0; this.mTarget=(this.sr/30)|0;

    this.tmpWetL=new Float32Array(128);
    this.tmpWetR=new Float32Array(128);
    this.tmpDryL=new Float32Array(128);
    this.tmpDryR=new Float32Array(128);

    // FIX #0: UI param delivery via postMessage (so knobs ALWAYS change DSP)
    this._ui = {
      inDb:0, outDb:0, biasDb:0, headroomDb:0,
      monitor:0, headblock:0,
      speed:15, flux:250, eqStd:0, tapeType:1,
      transformer:1, tapeHiss:0, wowFlutter:0,
      vibe:0, preserve:0, xfTrim:1
    };
    this._tgt = Object.assign({}, this._ui);
    this._useMsg=false;
    this.port.onmessage = (ev)=>{
      const d=ev.data;
      if(d && d.type==='params' && d.params){
        this._useMsg=true;
        Object.assign(this._tgt, d.params);
      }
    };
  }

  _ensureTmp(n){
    if(this.tmpWetL.length===n) return;
    this.tmpWetL=new Float32Array(n);
    this.tmpWetR=new Float32Array(n);
    this.tmpDryL=new Float32Array(n);
    this.tmpDryR=new Float32Array(n);
  }

  _smoothUI(n){
    const dt = n / this.sr;
    const aFast = Math.exp(-dt/0.010);
    const aSlow = Math.exp(-dt/0.030);

    this._ui.inDb       = aFast*this._ui.inDb       + (1-aFast)*this._tgt.inDb;
    this._ui.outDb      = aFast*this._ui.outDb      + (1-aFast)*this._tgt.outDb;
    this._ui.biasDb     = aFast*this._ui.biasDb     + (1-aFast)*this._tgt.biasDb;
    this._ui.headroomDb = aFast*this._ui.headroomDb + (1-aFast)*this._tgt.headroomDb;
    this._ui.preserve   = aSlow*this._ui.preserve   + (1-aSlow)*this._tgt.preserve;
    this._ui.xfTrim     = aFast*this._ui.xfTrim     + (1-aFast)*this._tgt.xfTrim;

    // discrete controls update immediately
    this._ui.monitor     = this._tgt.monitor;
    this._ui.headblock   = this._tgt.headblock;
    this._ui.speed       = this._tgt.speed;
    this._ui.flux        = this._tgt.flux;
    this._ui.eqStd       = this._tgt.eqStd;
    this._ui.tapeType    = this._tgt.tapeType;
    this._ui.transformer = this._tgt.transformer;
    this._ui.tapeHiss    = this._tgt.tapeHiss;
    this._ui.wowFlutter  = this._tgt.wowFlutter;
    this._ui.vibe        = this._tgt.vibe;
  }

  _readParams(params){
    // If we received UI messages, trust them (fixes "UI moves, DSP doesn't").
    if(this._useMsg) return this._ui;

    // fallback: AudioParams
    return {
      inDb:params.inDb[0], outDb:params.outDb[0], biasDb:params.biasDb[0], headroomDb:params.headroomDb[0],
      monitor:params.monitor[0], headblock:params.headblock[0],
      speed:params.speed[0], flux:params.flux[0], eqStd:params.eqStd[0], tapeType:params.tapeType[0],
      transformer:params.transformer[0], tapeHiss:params.tapeHiss[0], wowFlutter:params.wowFlutter[0], vibe:params.vibe[0],
      preserve:params.preserve[0], xfTrim:params.xfTrim[0]
    };
  }

  _updateDerived(p){
    const speed = (p.speed>=25?30:(p.speed>=11?15:7.5));
    const flux  = (p.flux>=435?500:(p.flux>=310?370:(p.flux>=215?250:185)));
    const eqStd = p.eqStd;
    const tt    = TAPE_TYPES[clamp(Math.round(p.tapeType),0,5)] || '456';
    const transformerOn = (p.transformer>=0.5);
    const vibeOn = (p.vibe>=0.5);

    const fluxDb=(fluxivitySpecs[flux]||fluxivitySpecs[250]).dbOver185;

    const inDbEff = p.inDb + INPUT_DB_OFFSET;
    const inGain  = Math.max(db2gain(inDbEff),0.001);

    let flGain=Math.max(db2gain(fluxDb),0.001);
    let outMakeupDb=0;
    if(transformerOn){ flGain*=db2gain(-1.0); outMakeupDb+=1.0; }

    const headroomGain=Math.max(db2gain(p.headroomDb),0.001);
    const reproCompDb=-fluxDb;
    const outGain=Math.max(db2gain(p.outDb + outMakeupDb + reproCompDb),0.001);

    const tp=tapeProfiles[tt]||tapeProfiles['456'];
    const hyst=tapeHysteresisParams[tt]||tapeHysteresisParams['456'];

    if(this._last.tt!==tt || this._last.vibeOn!==vibeOn){
      const baseAsym=tp.asymmetry;
      if(!vibeOn){
        const k=tp.saturationK;
        const softness=tp.saturationSoftness;
        const mix=softness*0.30;
        const asym=baseAsym;
        this._tapeFn=(x)=>{
          // FIX: continuous slope through zero; asymmetry via even-order term (no crossover kink)
          const u=k*(x+0.5*asym*x*x);
          const hard=Math.tanh(u);
          const soft=u/(1+Math.abs(u*0.5))/k;
          let y=hard*(1-mix)+soft*mix;
          y*=0.997;
          return clamp(y,-0.997,0.997);
        };
      } else {
        const kFactor=hyst.k/30000;
        const cFactor=hyst.c;
        const kBase=tp.saturationK;
        const k=kBase*(0.94+0.12*kFactor);
        let softness=tp.saturationSoftness;
        softness+=(cFactor-0.14)*0.12;
        softness=Math.min(0.98,Math.max(0.10,softness));
        const mix=0.30;
        const asym=baseAsym*(1.0+(1.0-kFactor)*0.15);

        const vibeSlope=k*(1-softness*mix)+softness*mix;
        const stdK=tp.saturationK;
        const stdSoft=tp.saturationSoftness;
        const stdSlope=stdK*(1-stdSoft*0.3)+stdSoft*0.3;
        const slopeNorm=stdSlope/Math.max(1e-6,vibeSlope);

        this._tapeFn=(x)=>{
          const u=k*(x+0.5*asym*x*x);
          const hard=Math.tanh(u);
          const soft=u/(1+Math.abs(u*0.5))/k;
          let y=hard*(1-softness*mix)+soft*(softness*mix);
          y*=slopeNorm;
          return clamp(y,-0.997,0.997);
        };
      }
      this.tapeOS.fn=(x)=>this._tapeFn(x);
    }

    if(vibeOn !== this._useJA){
      this._vibeTransition = vibeOn ? 1 : -1;
    }
    this._useJA = vibeOn;

    if(this._useJA){
      const jaP = tapeHysteresisParams[tt] || tapeHysteresisParams["456"];
      if(this._jaTT !== tt || this._vibeTransition===1){
        // FIX: only (re)load media params on tape change; setMediaParams resets filter state
        this.jaL.setMediaParams(jaP);
        this.jaR.setMediaParams(jaP);
        this._jaTT = tt;
        this._vibeTransition = 1;
      }
      this.jaL.setBiasGainFromDb(p.biasDb);
      this.jaR.setBiasGainFromDb(p.biasDb);
    }

    const bias=p.biasDb;
    const tapeAsym=tp.asymmetry;
    const biasAsymMod=clamp(bias*0.01,-0.05,0.05);
    const finalAsym=1-(tapeAsym+biasAsymMod);
    this._biasKPos=1.6;
    this._biasKNeg=1.6;
    this._biasAsym=clamp(tapeAsym+biasAsymMod,-0.3,0.3); // FIX: continuous asymmetry

    const tapeHFFreq=tp.hfShelfFreq;
    const tapeHFGain=tp.hfShelfGain;
    const biasTilt=clamp(-0.6*bias,-3,3);
    const bump=headBumpBySpeed[speed]||headBumpBySpeed[15];
    const eq=getEQ(speed, eqStd);
    const deemph={freq:eq.repro_hf[0], gain:eq.repro_hf[1]};
    const lpFreq=transformerOn?20000:22050;

    const wfSpec=wowFlutterSpecs[speed]||wowFlutterSpecs[15];
    const wfOn=(p.wowFlutter>=0.5) && (p.monitor>=0.5);
    // FIX: peak pitch deviation d (fraction) at rate f needs delay amplitude A = d/(2*pi*f) seconds
    const wowDelayMod=wfSpec.wowDepth/(2*Math.PI*wfSpec.wowRate);
    const flutterDelayMod=wfSpec.flutterDepth/(2*Math.PI*wfSpec.flutterRate);
    const wf={ on:wfOn, wowRate:wfSpec.wowRate, flutterRate:wfSpec.flutterRate,
      wowG:wfOn?wowDelayMod:0, flG:wfOn?flutterDelayMod:0, fl2G:wfOn?flutterDelayMod*0.7:0, baseDelay:0.005 };

    const interaction=calculateTapeFluxInteraction(tt, flux);
    const speedOff=speedNoiseOffset[speed]||0;
    const finalNoiseDb=interaction.effectiveNoiseDb+speedOff;
    const scaledNoiseDb=finalNoiseDb-22; // ≈ -83 dBFS for 456/250/15 (64 dB S/N re 0VU)
    const hissOn=(p.tapeHiss>=0.5) && (p.monitor>=0.5);
    const noiseGain=hissOn?Math.pow(10,scaledNoiseDb/20):0; // FIX: db2gain() floors at -60 dB

    this._derived={ tt, inGain, flGain, headroomGain, outGain, tapeHFFreq, tapeHFGain, biasTilt, bump, deemph, lpFreq, wf, noiseGain, transformerOn };
    for(let ch=0;ch<2;ch++){
      this.tapeHFShelf[ch].set('highshelf', tapeHFFreq, 0.707, tapeHFGain);
      this.biasHF[ch].set('highshelf', 8000, 0.707, biasTilt);
      this.headBump[ch].set('peaking', bump.freq, bump.Q, bump.gain);
      this.deemph[ch].set('highshelf', deemph.freq, 0.707, deemph.gain);

      this.xfPrimaryHP[ch].set('highpass', 30, 0.707, 0);
      this.xfLFBoost[ch].set('lowshelf', 150, 0.707, 4.0);
      this.xfLFCut[ch].set('lowshelf', 150, 0.707, -4.0);
      this.xfCoreLoss[ch].set('highshelf', 12000, 0.707, -1.0);
      this.xfLeakageLP[ch].set('lowpass', 18000, 0.6, 0);
      this.lpOut[ch].set('lowpass', lpFreq, 0.707, 0);

      this.noiseHP[ch].set('highpass', 400, 0.5, 0);
      this.noiseHF[ch].set('highshelf', 2000, 0.707, 6.0);
    }

    this._last={ tt, vibeOn };
  }

  process(inputs, outputs, params){
    const input=inputs[0];
    const output=outputs[0];
    if(!input || input.length===0){
      for(let ch=0;ch<output.length;ch++) output[ch].fill(0);
      return true;
    }
    const inL=input[0];
    const inR=input[1]||input[0];
    const outL=output[0];
    const outR=output[1]||output[0];
    const n=outL.length;

    this._ensureTmp(n);
    if(this._useMsg) this._smoothUI(n);
    const p=this._readParams(params);

    const monoHB = (p.headblock>=0.5);
    const isRepro = (p.monitor>=0.5);

    if(isRepro) this._updateDerived(p);
    const d=this._derived;

    // INPUT monitor: bypass output (still meters)
    if(!isRepro){
      let sumL=0, sumR=0;
      for(let i=0;i<n;i++){
        let l=inL[i], r=inR[i];
        if(monoHB){ const m=0.5*(l+r); l=m; r=m; }
        outL[i]=l; outR[i]=r;
        sumL += l*l; sumR += r*r;
      }
      this.mAccL += sumL; this.mAccR += sumR; this.mN += n;
      if(this.mN >= this.mTarget){
        const rmsL=Math.sqrt(this.mAccL/this.mN + 1e-20);
        const rmsR=Math.sqrt(this.mAccR/this.mN + 1e-20);
        this.port.postMessage({type:'meter', rmsL, rmsR});
        this.mAccL=0; this.mAccR=0; this.mN=0;
      }
      this.matchEq.reset();
      return true;
    }

    const preserveAmt = p.preserve;
    const xfTrim=clamp(p.xfTrim,0.125,8.0);

    const wowInc=d.wf.wowRate/this.sr;
    const flInc=d.wf.flutterRate/this.sr;
    const fl2Inc=(d.wf.flutterRate*0.6)/this.sr;

    for(let i=0;i<n;i++){
      let hbL=inL[i], hbR=inR[i];
      if(monoHB){ const m=0.5*(hbL+hbR); hbL=m; hbR=m; }

      // Preserve reference: raw input (what you want to match)
      const dryL = hbL;
      const dryR = hbR;
      this.tmpDryL[i]=dryL; this.tmpDryR[i]=dryR;

      let xL = dryL * d.headroomGain;
      let xR = dryR * d.headroomGain;

      xL *= d.inGain;
      xR *= d.inGain;

      xL *= d.flGain;
      xR *= d.flGain;

      if(this._useJA){
        if(this._vibeTransition===1){
          this.jaL.initAtInput(xL);
          this.jaR.initAtInput(xR);
          this._vibeTransition=0;
        }
        this.tapeOS.pL = xL;
        this.tapeOS.pR = xR;

        xL = this.jaL.process(xL);
        xR = this.jaR.process(xR);
      } else {
        if(this._vibeTransition===-1){
          this.tapeOS.pL = xL;
          this.tapeOS.pR = xR;
          this._vibeTransition=0;
        }
        xL=this.tapeOS.processL(xL);
        xR=this.tapeOS.processR(xR);
      }

      xL=this.tapeHFShelf[0].process(xL);
      xR=this.tapeHFShelf[1].process(xR);

      xL=Math.tanh(this._biasKPos*(xL+0.5*this._biasAsym*xL*xL));
      xR=Math.tanh(this._biasKPos*(xR+0.5*this._biasAsym*xR*xR));
      // DC blocker (even-order asymmetry leaves a small offset)
      { const yl=xL-this._dcxL+0.9995*this._dcyL; this._dcxL=xL; this._dcyL=yl; xL=yl;
        const yr=xR-this._dcxR+0.9995*this._dcyR; this._dcxR=xR; this._dcyR=yr; xR=yr; }

      xL=this.biasHF[0].process(xL);
      xR=this.biasHF[1].process(xR);

      xL=this.headBump[0].process(xL);
      xR=this.headBump[1].process(xR);

      xL=this.deemph[0].process(xL);
      xR=this.deemph[1].process(xR);

      xL*=d.outGain*xfTrim;
      xR*=d.outGain*xfTrim;

      if(d.transformerOn){
        xL=this.xfPrimaryHP[0].process(xL);
        xR=this.xfPrimaryHP[1].process(xR);

        xL=this.xfLFBoost[0].process(xL);
        xR=this.xfLFBoost[1].process(xR);

        xL=this.xfOS.processL(xL);
        xR=this.xfOS.processR(xR);

        xL=this.xfLFCut[0].process(xL);
        xR=this.xfLFCut[1].process(xR);

        xL=this.xfCoreLoss[0].process(xL);
        xR=this.xfCoreLoss[1].process(xR);

        xL=this.xfLeakageLP[0].process(xL);
        xR=this.xfLeakageLP[1].process(xR);
      }

      xL=this.lpOut[0].process(xL);
      xR=this.lpOut[1].process(xR);

      if(d.wf.on){
        const tri=(ph)=>{ const t=ph-Math.floor(ph); return 2*Math.abs(2*(t-Math.floor(t+0.5)))-1; };
        const wow=Math.sin(2*Math.PI*this.phWow);
        const fl =Math.sin(2*Math.PI*this.phFl);
        const fl2=tri(this.phFl2);
        const mod=d.wf.wowG*wow + d.wf.flG*fl + d.wf.fl2G*fl2;
        const delaySec=clamp(d.wf.baseDelay+mod,0,0.095);
        const r=this.delay.read(delaySec*this.sr);
        this.delay.write(xL,xR);
        xL=r[0]; xR=r[1];
        this.phWow+=wowInc; if(this.phWow>=1) this.phWow-=1;
        this.phFl +=flInc;  if(this.phFl >=1) this.phFl -=1;
        this.phFl2+=fl2Inc; if(this.phFl2>=1) this.phFl2-=1;
      } else {
        this.delay.write(xL,xR);
      }

      const l=this.mainLin*xL + this.ctLin*xR;
      const r=this.mainLin*xR + this.ctLin*xL;
      this.tmpWetL[i]=l;
      this.tmpWetR[i]=r;
    }

    if(preserveAmt>1e-4){
      this.matchEq.processBlock(this.tmpWetL,this.tmpWetR,this.tmpDryL,this.tmpDryR,outL,outR,preserveAmt);
    } else {
      for(let i=0;i<n;i++){ outL[i]=this.tmpWetL[i]; outR[i]=this.tmpWetR[i]; }
      this.matchEq.reset();
    }

    if(d.noiseGain>0){
      for(let i=0;i<n;i++){
        const nl=this.noiseHF[0].process(this.noiseHP[0].process(this.rngL.next()))*d.noiseGain;
        const nr=this.noiseHF[1].process(this.noiseHP[1].process(this.rngR.next()))*d.noiseGain;
        outL[i]+=nl; outR[i]+=nr;
      }
    }

    let sumL=0,sumR=0;
    for(let i=0;i<n;i++){ const l=outL[i], r=outR[i]; sumL+=l*l; sumR+=r*r; }
    this.mAccL+=sumL; this.mAccR+=sumR; this.mN+=n;
    if(this.mN>=this.mTarget){
      const rmsL=Math.sqrt(this.mAccL/this.mN + 1e-20);
      const rmsR=Math.sqrt(this.mAccR/this.mN + 1e-20);
      this.port.postMessage({type:'meter', rmsL, rmsR});
      this.mAccL=0; this.mAccR=0; this.mN=0;
    }

    if(this.curveToSend){
      this.port.postMessage({type:'curve', curveDb:this.curveToSend});
      this.curveToSend=null;
    }
    return true;
  }
}
registerProcessor('analogexact-dsp', AnalogExactDSP);
