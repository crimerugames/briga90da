/* Offline Web Audio synthesizer. Original score, no samples or network requests.
 * API: init(), setMusic('theme'|'ambient'|'combat'|'dramatic'|'off'),
 * setVolumes(music, sfx), setMuted(bool), setListener(x, y),
 * play(effect, {x, y, gain, pitch, surface}), updateEngine(id, state),
 * stopEngine(id), updateSiren(id, state), stopSiren(id), stopAll(), dispose().
 * Engine state: {rpm, throttle, speed, skid, x, y}, normalized inputs 0..1.
 * Siren state: {x, y, gain}. Coordinates use game-world pixels.
 * Effects: tt, pm, shotgun, kedr, uzi, ak74, punch, bat, hit, casing,
 * explosion, grenade, reload, step, glass, crash, lock, cash, ui, confirm.
 */
'use strict';
(() => {
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const midi = note => 440 * Math.pow(2, (note - 69) / 12);
  const profiles = Object.freeze({
    tt: {body:155, tail:.19, tone:.09, bright:5400, gain:.48},
    pm: {body:215, tail:.13, tone:.065, bright:4300, gain:.37},
    shotgun: {body:75, tail:.39, tone:.19, bright:3100, gain:.62},
    kedr: {body:240, tail:.09, tone:.05, bright:5100, gain:.29},
    uzi: {body:185, tail:.11, tone:.06, bright:4500, gain:.32},
    ak74: {body:110, tail:.22, tone:.12, bright:6600, gain:.48}
  });
  class ProceduralAudio {
    constructor() {
      this.ctx = null;
      this.initializing = null;
      this.musicVolume = .55;
      this.sfxVolume = .75;
      this.muted = false;
      this.mode = 'off';
      this.listener = {x:0, y:0};
      this.voices = new Set();
      this.engines = new Map();
      this.sirens = new Map();
      this.noise = null;
      this.timer = null;
      this.step = 0;
      this.nextStep = 0;
      this.maxVoices = 100;
      this.musicGeneration = 0;
      this.noiseOffset = 0;
      this.visibilityHandler = () => this.handleVisibility();
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    async init() {
      if (this.initializing) return this.initializing;
      this.initializing = (async () => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;
        try {
          if (!this.ctx || this.ctx.state === 'closed') {
            this.ctx = new AudioContextClass({latencyHint:'interactive'});
            this.buildGraph();
          }
          if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') await this.ctx.resume();
          if (!this.timer) this.timer = setInterval(() => this.schedule(), 25);
          return this.ctx.state === 'running';
        } catch {
          return false;
        }
      })();
      try { return await this.initializing; }
      finally { this.initializing = null; }
    }
    buildGraph() {
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : .7;
      this.compressor = c.createDynamicsCompressor();
      this.compressor.threshold.value = -16;
      this.compressor.knee.value = 15;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = .003;
      this.compressor.release.value = .2;
      this.master.connect(this.compressor);
      this.compressor.connect(c.destination);
      this.musicBus = c.createGain(); this.musicBus.gain.value = this.musicVolume * .62;
      this.sfxBus = c.createGain(); this.sfxBus.gain.value = this.sfxVolume * .78;
      this.musicBus.connect(this.master); this.sfxBus.connect(this.master);
      this.reverb = c.createConvolver();
      this.reverb.buffer = this.makeImpulse(1.65);
      this.reverbGain = c.createGain(); this.reverbGain.gain.value = .18;
      this.musicBus.connect(this.reverb); this.reverb.connect(this.reverbGain); this.reverbGain.connect(this.master);
      this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const samples = this.noise.getChannelData(0);
      let state = 0x89abcd;
      for (let i = 0; i < samples.length; i++) {
        state = (Math.imul(state,1664525) + 1013904223) >>> 0;
        samples[i] = state / 2147483648 - 1;
      }
      this.nextStep = c.currentTime + .04;
      this.step = 0;
    }
    makeImpulse(seconds) {
      const c = this.ctx, length = Math.floor(c.sampleRate * seconds);
      const impulse = c.createBuffer(2, length, c.sampleRate);
      let state = 1991;
      for (let channel = 0; channel < 2; channel++) {
        const samples = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          state = (Math.imul(state,1664525) + 1013904223) >>> 0;
          const fade = Math.pow(1 - i / length, 3.5);
          samples[i] = (state / 2147483648 - 1) * fade * .32;
        }
      }
      return impulse;
    }
    ramp(param, value, time = .04) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else { const current = param.value; param.cancelScheduledValues(now); param.setValueAtTime(current, now); }
      param.linearRampToValueAtTime(value, now + time);
    }
    setVolumes(music, sfx) {
      this.musicVolume = clamp(music); this.sfxVolume = clamp(sfx);
      if (this.ctx) { this.ramp(this.musicBus.gain,this.musicVolume*.62); this.ramp(this.sfxBus.gain,this.sfxVolume*.78); }
    }
    setMuted(muted) {
      this.muted = Boolean(muted);
      if (this.ctx) this.ramp(this.master.gain,this.muted ? 0 : .7);
    }
    setListener(x, y) {
      this.listener.x = Number.isFinite(x) ? x : 0; this.listener.y = Number.isFinite(y) ? y : 0;
      for (const loop of [...this.engines.values(), ...this.sirens.values()]) this.positionLoop(loop);
    }
    spatial(options = {}) {
      if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) return {gain:clamp(options.gain ?? 1,0,2), pan:0};
      const dx = options.x - this.listener.x, dy = options.y - this.listener.y;
      const distance = Math.hypot(dx,dy);
      return {gain:clamp(options.gain ?? 1,0,2) * Math.pow(Math.max(0,1-distance/1500),2), pan:clamp(dx/650,-1,1)};
    }
    makePan(value = 0) {
      if (typeof this.ctx.createStereoPanner === 'function') {
        const node = this.ctx.createStereoPanner(); node.pan.value = value; return node;
      }
      return this.ctx.createGain();
    }
    route(bus, pan = 0, gain = 1) {
      const volume = this.ctx.createGain(), panner = this.makePan(pan);
      volume.gain.value = gain; volume.connect(panner);
      panner.connect(bus === 'music' ? this.musicBus : this.sfxBus);
      return {volume,panner};
    }
    track(source, nodes, end, bus, envelope) {
      if (this.voices.size >= this.maxVoices) {
        const oldest = this.voices.values().next().value;
        this.releaseVoice(oldest, .008);
      }
      const voice = {source, nodes, end, bus, envelope, released:false};
      this.voices.add(voice);
      source.onended = () => {
        for (const node of nodes) node.disconnect();
        source.disconnect(); this.voices.delete(voice);
      };
      return voice;
    }
    releaseVoice(voice, fade = .02) {
      if (!voice || voice.released || !this.ctx) return;
      voice.released = true;
      const now = this.ctx.currentTime;
      const param = voice.envelope?.gain;
      if (param) {
        if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
        else { const value = param.value; param.cancelScheduledValues(now); param.setValueAtTime(value,now); }
        param.linearRampToValueAtTime(0,now+fade);
      }
      try { voice.source.stop(now+fade+.005); } catch { /* Source may have ended during suspension. */ }
      this.voices.delete(voice);
    }
    tone(frequency, time, duration, options = {}) {
      if (!this.ctx || frequency <= 0) return;
      const c = this.ctx, oscillator = c.createOscillator(), envelope = c.createGain();
      const attack = Math.min(options.attack ?? .005, duration*.45);
      const release = Math.min(options.release ?? duration*.55, duration*.5);
      const level = clamp(options.level ?? .2,0,1), bus = options.bus ?? 'sfx';
      const route = this.route(bus,options.pan ?? 0);
      oscillator.type = options.type ?? 'triangle';
      oscillator.frequency.setValueAtTime(frequency,time);
      oscillator.detune.value = options.detune ?? 0;
      if (options.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(15,options.endFrequency),time+duration);
      envelope.gain.setValueAtTime(.0001,time);
      envelope.gain.linearRampToValueAtTime(Math.max(.0001,level),time+attack);
      envelope.gain.setValueAtTime(Math.max(.0001,level),time+duration-release);
      envelope.gain.exponentialRampToValueAtTime(.0001,time+duration);
      const nodes = [envelope,route.volume,route.panner];
      if (options.filter) {
        const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = options.filter;
        oscillator.connect(filter); filter.connect(envelope); nodes.push(filter);
      } else oscillator.connect(envelope);
      envelope.connect(route.volume);
      this.track(oscillator,nodes,time+duration,bus,envelope);
      oscillator.start(time); oscillator.stop(time+duration+.02);
    }
    burst(time, duration, options = {}) {
      if (!this.ctx || !this.noise) return;
      const c = this.ctx, source = c.createBufferSource(), filter = c.createBiquadFilter(), envelope = c.createGain();
      source.buffer = this.noise; source.loop = true;
      source.playbackRate.value = clamp(options.pitch ?? 1,.2,3);
      filter.type = options.type ?? 'lowpass'; filter.frequency.value = options.frequency ?? 4000; filter.Q.value = options.q ?? .7;
      const bus = options.bus ?? 'sfx', level = clamp(options.level ?? .3,0,1);
      const route = this.route(bus,options.pan ?? 0);
      envelope.gain.setValueAtTime(.0001,time);
      envelope.gain.linearRampToValueAtTime(Math.max(.0001,level),time+Math.min(.003,duration*.1));
      envelope.gain.exponentialRampToValueAtTime(.0001,time+duration);
      source.connect(filter); filter.connect(envelope); envelope.connect(route.volume);
      this.track(source,[filter,envelope,route.volume,route.panner],time+duration,bus,envelope);
      this.noiseOffset = (this.noiseOffset + .137) % 1.7;
      source.start(time,this.noiseOffset); source.stop(time+duration+.02);
    }
    setMusic(mode = 'theme') {
      if (!['theme','ambient','combat','dramatic','off'].includes(mode)) mode = 'off';
      if (mode === this.mode) return;
      this.mode = mode; this.musicGeneration++; this.step = 0;
      if (this.ctx) {
        for (const voice of this.voices) if (voice.bus === 'music') this.releaseVoice(voice,.18);
        this.nextStep = this.ctx.currentTime + .2;
      }
    }
    schedule() {
      const c = this.ctx;
      if (!c || c.state !== 'running' || document.hidden || this.mode === 'off' || this.muted) return;
      const bpm = this.mode === 'combat' ? 112 : this.mode === 'dramatic' ? 64 : this.mode === 'ambient' ? 68 : 76;
      const stepDuration = 60/bpm/4;
      // Do not replay accumulated notes after tab suspension or a stalled frame.
      if (this.nextStep < c.currentTime-.08) this.nextStep = c.currentTime+.025;
      while (this.nextStep < c.currentTime+.13) {
        this.musicStep(this.step,this.nextStep,stepDuration);
        this.step = (this.step+1)%128; this.nextStep += stepDuration;
      }
    }
    musicStep(step, time, tick) {
      const mode = this.mode, combat = mode === 'combat', ambient = mode === 'ambient';
      const bar = Math.floor(step/16), beat = step%16;
      // D minor: i(add9), VImaj7, iv9, v; independently composed motif.
      const chords = [[50,57,62,65,69],[46,53,57,62,65],[43,50,57,58,62],[45,52,57,60,64]];
      const chord = chords[bar%4];
      if (beat === 0) {
        const duration = tick*17.5;
        chord.slice(1).forEach((note,index) => {
          this.tone(midi(note),time,duration,{bus:'music',type:'sawtooth',level:ambient?.018:.026,attack:.28,release:.75,filter:combat?1100:1750,detune:index%2?7:-7,pan:(index-1.5)*.25});
          if (!combat) this.tone(midi(note+12),time,duration,{bus:'music',type:'sine',level:.012,attack:.4,release:1,pan:(1.5-index)*.3});
        });
      }
      if (beat%8 === 0 || (combat && beat%4 === 2)) {
        this.tone(midi(chord[0]-12),time,tick*(combat?2.5:7),{bus:'music',type:'triangle',level:combat?.2:.12,filter:340,release:.18});
      }
      const melody = [
        [null,null,74,null,69,null,null,65,null,67,null,null,69,null,null,null],
        [null,null,77,null,null,74,null,72,null,null,69,null,65,null,null,null],
        [null,null,70,null,69,null,67,null,null,62,null,null,65,null,null,null],
        [null,null,64,null,67,null,null,69,null,72,null,null,69,null,null,null]
      ];
      const note = melody[bar%4][beat];
      if (!ambient && note !== null) {
        this.tone(midi(note+(bar>=4?0:-12)),time,tick*2.8,{bus:'music',type:'triangle',level:combat?.06:.105,attack:.026,release:tick*1.25,filter:2500,pan:.13});
        if (mode === 'dramatic') this.tone(midi(note-12),time+.012,tick*2.8,{bus:'music',type:'sine',level:.04,attack:.04,pan:-.2});
      }
      if (ambient && beat === 8 && bar%2 === 0) this.tone(midi(chord[3]+12),time,tick*7,{bus:'music',type:'sine',level:.042,attack:.2,release:.8,pan:.4});
      if (combat) {
        if ([0,6,8,14].includes(beat)) this.kick(time,'music',.55);
        if (beat === 4 || beat === 12) {
          this.burst(time,.16,{bus:'music',type:'highpass',frequency:1500,level:.17});
          this.tone(175,time,.1,{bus:'music',level:.08,endFrequency:90,type:'triangle'});
        }
        if (beat%2 === 0) this.burst(time,beat===14?.13:.042,{bus:'music',type:'highpass',frequency:7200,level:beat%4===0?.055:.03,pan:beat%4===0?-.25:.25});
        if (beat%2 === 1) this.tone(midi(chord[1]+12),time,tick*.5,{bus:'music',type:'square',level:.018,filter:950,pan:-.3});
      } else if (!ambient) {
        if (beat === 0 || beat === 10) this.kick(time,'music',.21);
        if (beat === 12) this.burst(time,.16,{bus:'music',type:'bandpass',frequency:2100,level:.035});
      }
    }
    kick(time, bus = 'sfx', level = .4) {
      this.tone(125,time,.24,{bus,type:'sine',level,endFrequency:38,release:.2});
    }
    play(effect, options = {}) {
      if (!this.ctx || this.ctx.state !== 'running' || this.muted || document.hidden) return false;
      const spatial = this.spatial(options);
      if (spatial.gain < .005) return false;
      const time = this.ctx.currentTime+.004, gain = spatial.gain, pan = spatial.pan, pitch = clamp(options.pitch ?? 1,.5,2);
      const tone = (hz,duration,level,extra = {}) => this.tone(hz*pitch,time,duration,{level:level*gain,pan,...extra});
      const noise = (duration,level,frequency,extra = {}) => this.burst(time,duration,{level:level*gain,frequency,pan,pitch,...extra});
      if (profiles[effect]) {
        const p = profiles[effect];
        noise(p.tail,p.gain,p.bright);
        noise(.018,p.gain*.5,8000,{type:'highpass'});
        tone(p.body,p.tone,p.gain*.7,{type:'triangle',endFrequency:p.body*.3});
        if (effect === 'shotgun') tone(46,.23,.28);
        this.burst(time+.026,p.tail*.8,{frequency:1600,level:p.gain*gain*.12,pan:-pan*.4});
        return true;
      }
      switch (effect) {
        case 'explosion':
        case 'grenade':
          noise(1.25,.75,1250); noise(.3,.38,5200); tone(85,.75,.52,{endFrequency:22,type:'sine'}); break;
        case 'punch':
          noise(.08,.24,550); tone(100,.09,.28,{endFrequency:40}); break;
        case 'bat':
          noise(.09,.32,1350); tone(220,.13,.25,{endFrequency:65}); break;
        case 'hit':
          noise(.13,.22,2100); tone(145,.06,.15,{endFrequency:55}); break;
        case 'crash':
          noise(.5,.5,2400); tone(90,.25,.4,{endFrequency:32}); break;
        case 'horn':
          // Двухтональный автомобильный сигнал.
          tone(392,.16,.06,{type:'square',filter:2200});
          this.tone(494,time+.018,.16,{level:.05*gain,pan,type:'square',filter:2200}); break;
        case 'glass':
          noise(.35,.29,6000,{type:'highpass'});
          for (let i=0;i<5;i++) this.tone(1800+i*517,time+i*.021,.18,{level:.035*gain,pan,type:'sine'});
          break;
        case 'casing':
          tone(3200,.075,.045,{type:'triangle'}); tone(4600,.035,.025); break;
        case 'reload':
          noise(.055,.13,2300,{type:'bandpass'});
          this.burst(time+.19,.055,{frequency:3700,level:.12*gain,pan,type:'highpass'});
          this.tone(720,time+.38,.055,{level:.075*gain,pan,type:'square',filter:1800}); break;
        case 'step':
          noise(options.surface==='snow'?.15:.07,.075,options.surface==='snow'?2100:650);
          if (options.surface!=='snow') tone(95,.045,.045,{endFrequency:50}); break;
        case 'lock':
          tone(1600,.045,.06); this.tone(2200,time+.075,.035,{level:.05*gain,pan}); break;
        case 'cash':
          [76,81,88].forEach((note,i)=>this.tone(midi(note),time+i*.065,.18,{type:'sine',level:.09*gain,pan})); break;
        case 'ui':
          tone(520,.035,.055,{type:'sine',endFrequency:700}); break;
        case 'confirm':
          tone(660,.09,.08); this.tone(990,time+.075,.14,{level:.07*gain,pan}); break;
        default: return false;
      }
      return true;
    }
    createLoop() {
      const route = this.route('sfx',0,0);
      return {route,sources:[],nodes:[],state:{},baseGain:1,stopped:false};
    }
    positionLoop(loop) {
      const spatial = this.spatial(loop.state);
      this.ramp(loop.route.volume.gain,spatial.gain*loop.baseGain,.06);
      if (loop.route.panner.pan) this.ramp(loop.route.panner.pan,spatial.pan,.06);
    }
    updateEngine(id, state = {}) {
      if (!this.ctx || this.ctx.state !== 'running') return;
      let loop = this.engines.get(id);
      if (!loop) {
        if (this.engines.size >= 8) this.stopEngine(this.engines.keys().next().value);
        loop = this.createLoop();
        const c = this.ctx, filter = c.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.value = 300; filter.Q.value = .6;
        filter.connect(loop.route.volume); loop.filter = filter; loop.nodes.push(filter);
        for (let i=0;i<3;i++) {
          const source = c.createOscillator(), gain = c.createGain();
          source.type = i===0?'triangle':'sine'; source.frequency.value = 26*(i+1);
          gain.gain.value = [.10,.055,.028][i];
          source.connect(gain); gain.connect(filter); source.start();
          loop.sources.push(source); loop.nodes.push(gain);
        }
        const exhaust = c.createBufferSource(), rumbleFilter = c.createBiquadFilter(), rumbleGain = c.createGain();
        exhaust.buffer = this.noise; exhaust.loop = true; rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 120;
        rumbleGain.gain.value = .055; exhaust.connect(rumbleFilter); rumbleFilter.connect(rumbleGain); rumbleGain.connect(loop.route.volume); exhaust.start();
        loop.sources.push(exhaust); loop.nodes.push(rumbleFilter,rumbleGain);
        const skid = c.createBufferSource(), skidFilter = c.createBiquadFilter(), skidGain = c.createGain();
        skid.buffer = this.noise; skid.loop = true; skidFilter.type = 'bandpass'; skidFilter.frequency.value = 1800; skidFilter.Q.value = 3.5; skidGain.gain.value = 0;
        skid.connect(skidFilter); skidFilter.connect(skidGain); skidGain.connect(loop.route.volume); skid.start();
        loop.sources.push(skid); loop.nodes.push(skidFilter,skidGain); loop.skidGain = skidGain;
        this.engines.set(id,loop);
      }
      loop.state = {...loop.state,...state};
      const rpm = clamp(loop.state.rpm ?? .1), throttle = clamp(loop.state.throttle ?? 0), speed = clamp(loop.state.speed ?? 0);
      for (let i=0;i<3;i++) this.ramp(loop.sources[i].frequency,(24+rpm*86)*(i+1),.07);
      this.ramp(loop.filter.frequency,150+rpm*850+throttle*260,.08);
      this.ramp(loop.skidGain.gain,clamp(loop.state.skid ?? 0)*(.06+speed*.1),.035);
      loop.baseGain = .24+throttle*.2+rpm*.1; this.positionLoop(loop);
    }
    updateSiren(id, state = {}) {
      if (!this.ctx || this.ctx.state !== 'running') return;
      let loop = this.sirens.get(id);
      if (!loop) {
        if (this.sirens.size >= 5) this.stopSiren(this.sirens.keys().next().value);
        loop = this.createLoop(); const c = this.ctx;
        const oscillator = c.createOscillator(), lfo = c.createOscillator(), depth = c.createGain(), level = c.createGain();
        oscillator.type = 'triangle'; oscillator.frequency.value = 680; lfo.type = 'sine'; lfo.frequency.value = .85;
        depth.gain.value = 230; level.gain.value = .14;
        lfo.connect(depth); depth.connect(oscillator.frequency); oscillator.connect(level); level.connect(loop.route.volume);
        oscillator.start(); lfo.start(); loop.sources.push(oscillator,lfo); loop.nodes.push(depth,level);
        loop.baseGain = .7; this.sirens.set(id,loop);
      }
      loop.state = {...loop.state,...state}; this.positionLoop(loop);
    }
    stopLoop(map, id) {
      const loop = map.get(id);
      if (!loop || loop.stopped) return;
      loop.stopped = true; map.delete(id);
      const end = this.ctx.currentTime+.07;
      this.ramp(loop.route.volume.gain,0,.06);
      let remaining = loop.sources.length;
      for (const source of loop.sources) {
        source.onended = () => {
          source.disconnect();
          if (--remaining===0) { for (const node of loop.nodes) node.disconnect(); loop.route.volume.disconnect(); loop.route.panner.disconnect(); }
        };
        try { source.stop(end); } catch { source.onended(); }
      }
    }
    stopEngine(id) { this.stopLoop(this.engines,id); }
    stopSiren(id) { this.stopLoop(this.sirens,id); }
    stopAll() {
      this.setMusic('off');
      for (const voice of this.voices) this.releaseVoice(voice);
      for (const id of this.engines.keys()) this.stopEngine(id);
      for (const id of this.sirens.keys()) this.stopSiren(id);
    }
    async handleVisibility() {
      if (!this.ctx || this.ctx.state === 'closed') return;
      try {
        if (document.hidden) await this.ctx.suspend();
        else {
          await this.ctx.resume();
          this.nextStep = this.ctx.currentTime+.06;
        }
      } catch { /* A browser may require a new gesture to resume audio. */ }
    }
    async dispose() {
      this.stopAll();
      clearInterval(this.timer); this.timer = null;
      document.removeEventListener('visibilitychange',this.visibilityHandler);
      if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
      this.ctx = null; this.noise = null; this.voices.clear();
    }
    get status() {
      return Object.freeze({supported:Boolean(window.AudioContext || window.webkitAudioContext), state:this.ctx?.state ?? 'uninitialized', mode:this.mode, voices:this.voices.size, engines:this.engines.size, sirens:this.sirens.size, muted:this.muted});
    }
  }
  window.BrigadaAudio = new ProceduralAudio();
})();
