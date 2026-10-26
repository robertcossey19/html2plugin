# html2plugin

Paste an HTML / Web Audio plugin page (AudioWorklet DSP + HTML UI), get a tested universal macOS **VST3 (Cubase) + AU (Logic)** installer.

The page is not rewritten. Inside the plugin:

- **DSP**: the page's own `AudioWorkletProcessor` code runs unchanged inside Apple's JavaScriptCore on the audio thread, under `engine/webaudio-engine.js`, a pull-based Web Audio graph implementation (Gain, Delay, BiquadFilter, WaveShaper, StereoPanner, Splitter/Merger, ConstantSource, Oscillator, BufferSource, DynamicsCompressor, Analyser, Convolver, AudioParam automation, AudioWorkletNode + MessagePort). Native nodes the page puts around the worklet (wet/dry gains, delays, filters) are reproduced too, so the whole signal path is the browser's, not a "generic waveshaper".
- **UI**: the original HTML runs in a JUCE 8 WebView. `runtime/webaudio-shim.js` replaces `AudioContext`; every graph call the page makes is recorded as an RPC op and replayed into the engine. Worklet `port.postMessage` traffic flows both ways, so meters/curves/analysers keep working.
- **Host parameters**: AudioWorklet `parameterDescriptors` ∪ keys of the page's parameter messages. The forge boots the page headlessly (jsdom), auto-presses its POWER/START control, and **probes every control** (range/number/select/checkbox, segmented buttons, toggles, wheel knobs, pointer-drag knobs) to learn which parameter it drives and how. Host automation drives the page's own controls through those bindings, so knobs move and the page re-posts its own parameter messages. The DSP path is immediate (`hostParam` re-sends the page's last parameter message with one key changed).
- **Tests on every build** (GitHub Actions, macOS): installer, `auval`, pluginval strictness 10 (VST3 + AU), HostTest (parameter table, sweeps, state recall, odd block sizes, **golden master vs Node/V8** running the same engine + worklet, editor open with audio), CPU with and without the JSC JIT.

## Use

1. **Web app** (`web/`): paste the page, hit **Generate VST3 + AU**, download when the build lands (~9–12 min). No login or token: the backend (`web/server.js`) commits to `inbox/` with its own repo-scoped deploy key (`web/.secrets/deploy_key`, git-ignored). Build status is read from the public GitHub API from your browser (60 req/h; when that runs out the app falls back to tag detection through the backend and still finds the release). Run it yourself: `cd web && node server.js` (port 8000) and open `public/index.html` from a local server.
2. Or just commit the page to `inbox/<slug>.html` (or a URL to `inbox/<slug>.url`) and push.
3. A Release `<slug>-build-N` appears with `<Name>-VST3-Installer.pkg`, `<Name>-AU-Installer.pkg`, `<Name>-Installer-VST3+AU.pkg`, zips, `REPORT.md` and SHA256SUMS.

Local: `npm i && node forge/index.js page.html --out build/x --slug x && node tests/golden.js build/x`, then build `build/x` with CMake + Xcode on a Mac.

## Troubleshooting

If a plugin loads but sounds like a straight wire, the JS engine failed and the plugin fell back to pass-through on purpose (never silence). The reason is in `~/Library/Logs/html2plugin/<slug>.log` (and on stderr of the host). CI runs the same check: HostTest fails on bit-exact pass-through, and `[h2p ...]` log lines appear in the HostTest step.

## Measured on CI (ANALOGEXACT, builds 7–8)

- Golden master: plugin −22.07 dBFS / THD 1.420 % vs Node −22.07 dBFS / 1.420 % (1 kHz at −20 dBFS, 48 k, block 512), 8-point parameter sweep within tolerance, VST3 and AU.
- auval passed, pluginval strictness 10 passed (VST3 + AU), installer tested, page-built graph matches the captured graph within 0.6 dB, DSP keeps running with the editor closed.
- CPU: 35 % (build 7) to 56–62 % (build 8) of one core on the shared macos-14 runner for this (heavy, Jiles–Atherton) model — runner-to-runner variance is large; `JSC_useJIT=false` changed nothing, so JIT state inside the host is unconfirmed. Expect less on a desktop M-series machine (estimate, not measured).

## Limits (honest list)

- macOS only (JavaScriptCore + WKWebView). Windows would need a different JS engine and WebView2.
- `ScriptProcessorNode`, `OfflineAudioContext`-based realtime tricks and compressed `decodeAudioData` formats (mp3/ogg) are not supported in the plugin; PCM/float WAV is.
- Pages whose graph is built only after a user gesture we cannot detect (no POWER/START-like control) run as pass-through until the user presses the control in the plugin UI.
- CPU: JavaScript in-process. With JIT it is in the same ballpark as the browser; hosts without the `com.apple.security.cs.allow-jit` entitlement run the JSC interpreter (CI prints both numbers). For CPU-critical plugins, hand-port the worklet to C++ (see the `html-plugin-to-mac-vst-au` skill); this generator is the fidelity path.
- Signing is ad-hoc until the Apple secrets in [SIGNING.md](SIGNING.md) are set; with them every build is Developer ID signed, notarized, stapled and Gatekeeper-checked (`spctl -a -t install`) before release.
