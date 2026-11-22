/* jsnes（Apache-2.0，bfirsh/jsnes 1ead3beb）單檔 UMD 版：由 build-umd.cjs 從 src/ 產生，請勿手改。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaJsnes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const __defs = {}, __cache = {};
  function __req(k) { if (!(k in __cache)) { if (!(k in __defs)) throw new Error('jsnes：找不到模組 ' + k); __cache[k] = __defs[k](); } return __cache[k]; }
function __m_browser_frame_timer_js() {
const __exp = {};
// Debug logging, enabled via localStorage.jsnes_debug = 1
let debugEnabled = false;
try {
  debugEnabled = !!localStorage.getItem("jsnes_debug");
} catch {
  // localStorage not available
}

const FPS = 60.098;

class FrameTimer {
  constructor(props) {
    // Run at 60 FPS
    this.onGenerateFrame = props.onGenerateFrame;
    // Run on animation frame
    this.onWriteFrame = props.onWriteFrame;
    this.onAnimationFrame = this.onAnimationFrame.bind(this);
    this.running = true;
    this.interval = 1e3 / FPS;
    this.lastFrameTime = false;
  }

  start() {
    this.running = true;
    this.requestAnimationFrame();
  }

  stop() {
    this.running = false;
    if (this._requestID) window.cancelAnimationFrame(this._requestID);
    this.lastFrameTime = false;
  }

  requestAnimationFrame() {
    this._requestID = window.requestAnimationFrame(this.onAnimationFrame);
  }

  generateFrame() {
    this.onGenerateFrame();
    this.lastFrameTime += this.interval;
  }

  onAnimationFrame = (time) => {
    this.requestAnimationFrame();
    // how many ms after 60fps frame time
    let excess = time % this.interval;

    // newFrameTime is the current time aligned to 60fps intervals.
    // i.e. 16.6, 33.3, etc ...
    let newFrameTime = time - excess;

    // first frame, do nothing
    if (!this.lastFrameTime) {
      this.lastFrameTime = newFrameTime;
      return;
    }

    let numFrames = Math.round(
      (newFrameTime - this.lastFrameTime) / this.interval,
    );

    // This can happen a lot on a 144Hz display
    if (numFrames <= 0) {
      return;
    }

    // update display on first frame only
    this.generateFrame();
    this.onWriteFrame();

    // we generate additional frames evenly before the next
    // onAnimationFrame call.
    // additional frames are generated but not displayed
    // until next frame draw
    let timeToNextFrame = this.interval - excess;
    for (let i = 1; i < numFrames; i++) {
      setTimeout(
        () => {
          this.generateFrame();
        },
        (i * timeToNextFrame) / numFrames,
      );
    }
    if (numFrames > 1 && debugEnabled) {
      console.log("SKIP", numFrames - 1, this.lastFrameTime);
    }
  };
}

__exp.default = FrameTimer;
return __exp;
}
function __m_browser_gamepad_js() {
const __exp = {};
class GamepadController {
  constructor(options) {
    this.onButtonDown = options.onButtonDown;
    this.onButtonUp = options.onButtonUp;
    this.gamepadState = [];
    this.buttonCallback = null;
  }

  disableIfGamepadEnabled = (callback) => {
    var self = this;
    return (playerId, buttonId) => {
      if (!self.gamepadConfig) {
        return callback(playerId, buttonId);
      }

      var playerGamepadId = self.gamepadConfig.playerGamepadId;
      if (!playerGamepadId || !playerGamepadId[playerId - 1]) {
        // allow callback only if player is not associated to any gamepad
        return callback(playerId, buttonId);
      }
    };
  };

  _getPlayerNumberFromGamepad = (gamepad) => {
    if (this.gamepadConfig.playerGamepadId[0] === gamepad.id) {
      return 1;
    }

    if (this.gamepadConfig.playerGamepadId[1] === gamepad.id) {
      return 2;
    }

    return 1;
  };

  poll = () => {
    const gamepads = navigator.getGamepads
      ? navigator.getGamepads()
      : navigator.webkitGetGamepads();

    const usedPlayers = [];

    for (let gamepadIndex = 0; gamepadIndex < gamepads.length; gamepadIndex++) {
      const gamepad = gamepads[gamepadIndex];
      const previousGamepad = this.gamepadState[gamepadIndex];

      if (!gamepad) {
        continue;
      }

      if (!previousGamepad) {
        this.gamepadState[gamepadIndex] = gamepad;
        continue;
      }

      const buttons = gamepad.buttons;
      const previousButtons = previousGamepad.buttons;

      if (this.buttonCallback) {
        for (let code = 0; code < gamepad.axes.length; code++) {
          const axis = gamepad.axes[code];
          const previousAxis = previousGamepad.axes[code];

          if (axis === -1 && previousAxis !== -1) {
            this.buttonCallback({
              gamepadId: gamepad.id,
              type: "axis",
              code: code,
              value: axis,
            });
          }

          if (axis === 1 && previousAxis !== 1) {
            this.buttonCallback({
              gamepadId: gamepad.id,
              type: "axis",
              code: code,
              value: axis,
            });
          }
        }

        for (let code = 0; code < buttons.length; code++) {
          const button = buttons[code];
          const previousButton = previousButtons[code];
          if (button.pressed && !previousButton.pressed) {
            this.buttonCallback({
              gamepadId: gamepad.id,
              type: "button",
              code: code,
            });
          }
        }
      } else if (this.gamepadConfig) {
        let playerNumber = this._getPlayerNumberFromGamepad(gamepad);
        if (usedPlayers.length < 2) {
          if (usedPlayers.indexOf(playerNumber) !== -1) {
            playerNumber++;
            if (playerNumber > 2) playerNumber = 1;
          }
          usedPlayers.push(playerNumber);

          if (this.gamepadConfig.configs[gamepad.id]) {
            const configButtons =
              this.gamepadConfig.configs[gamepad.id].buttons;

            for (let i = 0; i < configButtons.length; i++) {
              const configButton = configButtons[i];
              if (configButton.type === "button") {
                const code = configButton.code;
                const button = buttons[code];
                const previousButton = previousButtons[code];

                if (button.pressed && !previousButton.pressed) {
                  this.onButtonDown(playerNumber, configButton.buttonId);
                } else if (!button.pressed && previousButton.pressed) {
                  this.onButtonUp(playerNumber, configButton.buttonId);
                }
              } else if (configButton.type === "axis") {
                const code = configButton.code;
                const axis = gamepad.axes[code];
                const previousAxis = previousGamepad.axes[code];

                if (
                  axis === configButton.value &&
                  previousAxis !== configButton.value
                ) {
                  this.onButtonDown(playerNumber, configButton.buttonId);
                }

                if (
                  axis !== configButton.value &&
                  previousAxis === configButton.value
                ) {
                  this.onButtonUp(playerNumber, configButton.buttonId);
                }
              }
            }
          }
        }
      }

      this.gamepadState[gamepadIndex] = {
        buttons: buttons.map((b) => {
          return { pressed: b.pressed };
        }),
        axes: gamepad.axes.slice(0),
      };
    }
  };

  promptButton = (f) => {
    if (!f) {
      this.buttonCallback = f;
    } else {
      this.buttonCallback = (buttonInfo) => {
        this.buttonCallback = null;
        f(buttonInfo);
      };
    }
  };

  loadGamepadConfig = () => {
    var gamepadConfig;
    try {
      gamepadConfig = localStorage.getItem("gamepadConfig");
      if (gamepadConfig) {
        gamepadConfig = JSON.parse(gamepadConfig);
      }
    } catch (e) {
      console.warn("Failed to get gamepadConfig from localStorage.", e);
    }

    this.gamepadConfig = gamepadConfig;
  };

  setGamepadConfig = (gamepadConfig) => {
    try {
      localStorage.setItem("gamepadConfig", JSON.stringify(gamepadConfig));
      this.gamepadConfig = gamepadConfig;
    } catch (e) {
      console.warn("Failed to set gamepadConfig in localStorage.", e);
    }
  };

  startPolling = () => {
    if (!(navigator.getGamepads || navigator.webkitGetGamepads)) {
      return { stop: () => {} };
    }

    let stopped = false;
    const loop = () => {
      if (stopped) return;

      this.poll();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    return {
      stop: () => {
        stopped = true;
      },
    };
  };
}

__exp.default = GamepadController;
return __exp;
}
function __m_browser_index_js() {
const __exp = {};
const NES = __req("nes.js").default;
const Screen = __req("browser/screen.js").default;
const Speakers = __req("browser/speakers.js").default;
const FrameTimer = __req("browser/frame-timer.js").default;
const KeyboardController = __req("browser/keyboard.js").default;
const GamepadController = __req("browser/gamepad.js").default;

// Debug logging, enabled via localStorage.jsnes_debug = 1
let debugEnabled = false;
try {
  debugEnabled = !!localStorage.getItem("jsnes_debug");
} catch {
  // localStorage not available
}
function debug(...args) {
  if (debugEnabled) console.log(...args);
}

/**
 * Browser-based NES emulator that handles canvas rendering, audio output,
 * keyboard/gamepad input, and frame timing.
 *
 * Usage:
 *   const browser = new jsnes.Browser({
 *     container: document.getElementById("nes"),
 *     romData: romData,
 *     onError: (e) => console.error(e),
 *   });
 *
 * If romData is omitted, call browser.loadROM(data) then browser.start().
 */
class Browser {
  constructor(options = {}) {
    this._options = options;

    // Create screen (creates <canvas> inside container)
    this._screen = new Screen(options.container, {
      onMouseDown: (x, y) => {
        this.nes.zapperMove(x, y);
        this.nes.zapperFireDown();
      },
      onMouseUp: () => {
        this.nes.zapperFireUp();
      },
    });
    this._screen.fitInParent();

    // Create speakers
    this._speakers = new Speakers({
      onBufferUnderrun: () => {
        // Generate extra frames so audio remains consistent. This happens for
        // a variety of reasons:
        // - Frame rate is not quite 60fps, so sometimes buffer empties
        // - Page is not visible, so requestAnimationFrame doesn't get fired.
        //   In this case emulator still runs at full speed, but timing is
        //   done by audio instead of requestAnimationFrame.
        // - System can't run emulator at full speed. In this case it'll stop
        //    firing requestAnimationFrame.
        debug("Buffer underrun, running extra frames to catch up");

        // The NES produces ~800 samples per frame at 48kHz. Run two frames
        // to ensure the worklet buffer is refilled.
        this._frameTimer.generateFrame();
        this._frameTimer.generateFrame();
      },
    });

    // Create NES
    this.nes = new NES({
      onFrame: this._screen.setBuffer,
      onStatusUpdate: debug,
      onAudioSample: this._speakers.writeSample,
      onBatteryRamWrite: options.onBatteryRamWrite || (() => {}),
      sampleRate: this._speakers.getSampleRate(),
    });

    // Create frame timer
    this._frameTimer = new FrameTimer({
      onGenerateFrame: () => {
        try {
          this.nes.frame();
          this._speakers.flush();
        } catch (e) {
          this.stop();
          if (this._options.onError) {
            this._options.onError(e);
          }
        }
      },
      onWriteFrame: this._screen.writeBuffer,
    });

    // Set up gamepad and keyboard
    this.gamepad = new GamepadController({
      onButtonDown: this.nes.buttonDown,
      onButtonUp: this.nes.buttonUp,
    });
    this.gamepad.loadGamepadConfig();
    this._gamepadPolling = this.gamepad.startPolling();

    this.keyboard = new KeyboardController({
      onButtonDown: this.gamepad.disableIfGamepadEnabled(this.nes.buttonDown),
      onButtonUp: this.gamepad.disableIfGamepadEnabled(this.nes.buttonUp),
    });
    this.keyboard.loadKeys();

    // Bind keyboard events
    document.addEventListener("keydown", this.keyboard.handleKeyDown);
    document.addEventListener("keyup", this.keyboard.handleKeyUp);
    document.addEventListener("keypress", this.keyboard.handleKeyPress);

    // Load ROM and start if provided
    if (options.romData) {
      this.nes.loadROM(options.romData);
      this.start();
    }
  }

  start() {
    this._frameTimer.start();
    this._speakers.start();
    this._fpsInterval = setInterval(() => {
      debug(`FPS: ${this.nes.getFPS()}`);
    }, 1000);
  }

  stop() {
    this._frameTimer.stop();
    this._speakers.stop();
    clearInterval(this._fpsInterval);
  }

  loadROM(data) {
    this.stop();
    this.nes.loadROM(data);
    this.start();
  }

  /**
   * Fill parent element with screen. Call if parent element changes size.
   */
  fitInParent() {
    this._screen.fitInParent();
  }

  screenshot() {
    return this._screen.screenshot();
  }

  /**
   * Clean up all resources: stop emulation, remove event listeners, remove canvas.
   */
  destroy() {
    this.stop();
    document.removeEventListener("keydown", this.keyboard.handleKeyDown);
    document.removeEventListener("keyup", this.keyboard.handleKeyUp);
    document.removeEventListener("keypress", this.keyboard.handleKeyPress);
    this._gamepadPolling.stop();
    this._screen.destroy();
  }

  /**
   * Load ROM data from a URL via XHR.
   */
  static loadROMFromURL(url, callback) {
    var req = new XMLHttpRequest();
    req.open("GET", url);
    req.overrideMimeType("text/plain; charset=x-user-defined");
    req.onerror = () =>
      callback(new Error(`Error loading ${url}: ${req.statusText}`));
    req.onload = function () {
      if (this.status === 200) {
        callback(null, this.responseText);
      } else if (this.status === 0) {
        // Aborted, ignore
      } else {
        req.onerror();
      }
    };
    req.send();
    return req;
  }
}

__exp.default = Browser;
return __exp;
}
function __m_browser_keyboard_js() {
const __exp = {};
const Controller = __req("controller.js").default;

// Mapping keyboard code to [controller, button]
const KEYS = {
  88: [1, Controller.BUTTON_A, "X"], // X
  89: [1, Controller.BUTTON_B, "Y"], // Y (Central European keyboard)
  90: [1, Controller.BUTTON_B, "Z"], // Z
  17: [1, Controller.BUTTON_SELECT, "Right Ctrl"], // Right Ctrl
  13: [1, Controller.BUTTON_START, "Enter"], // Enter
  38: [1, Controller.BUTTON_UP, "Up"], // Up
  40: [1, Controller.BUTTON_DOWN, "Down"], // Down
  37: [1, Controller.BUTTON_LEFT, "Left"], // Left
  39: [1, Controller.BUTTON_RIGHT, "Right"], // Right
  83: [1, Controller.BUTTON_TURBO_A, "S"], // S
  65: [1, Controller.BUTTON_TURBO_B, "A"], // A
  103: [2, Controller.BUTTON_A, "Num-7"], // Num-7
  105: [2, Controller.BUTTON_B, "Num-9"], // Num-9
  99: [2, Controller.BUTTON_SELECT, "Num-3"], // Num-3
  97: [2, Controller.BUTTON_START, "Num-1"], // Num-1
  104: [2, Controller.BUTTON_UP, "Num-8"], // Num-8
  98: [2, Controller.BUTTON_DOWN, "Num-2"], // Num-2
  100: [2, Controller.BUTTON_LEFT, "Num-4"], // Num-4
  102: [2, Controller.BUTTON_RIGHT, "Num-6"], // Num-6
};

class KeyboardController {
  constructor(options) {
    this.onButtonDown = options.onButtonDown;
    this.onButtonUp = options.onButtonUp;
  }

  loadKeys = () => {
    var keys;
    try {
      keys = localStorage.getItem("keys");
      if (keys) {
        keys = JSON.parse(keys);
      }
    } catch (e) {
      console.warn("Failed to get keys from localStorage.", e);
    }

    this.keys = keys || KEYS;
  };

  setKeys = (newKeys) => {
    try {
      localStorage.setItem("keys", JSON.stringify(newKeys));
      this.keys = newKeys;
    } catch (e) {
      console.warn("Failed to set keys in localStorage.", e);
    }
  };

  handleKeyDown = (e) => {
    var key = this.keys[e.keyCode];
    if (key) {
      this.onButtonDown(key[0], key[1]);
      e.preventDefault();
    }
  };

  handleKeyUp = (e) => {
    var key = this.keys[e.keyCode];
    if (key) {
      this.onButtonUp(key[0], key[1]);
      e.preventDefault();
    }
  };

  handleKeyPress = (e) => {
    if (this.keys[e.keyCode]) {
      e.preventDefault();
    }
  };
}

__exp.default = KeyboardController;
return __exp;
}
function __m_browser_screen_js() {
const __exp = {};
const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;

class Screen {
  constructor(container, options = {}) {
    this.onMouseDown = options.onMouseDown;
    this.onMouseUp = options.onMouseUp;

    // Create canvas element
    this.canvas = document.createElement("canvas");
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.imageRendering = "crisp-edges";
    container.appendChild(this.canvas);

    // Mouse events for Zapper support
    this._handleMouseDown = (e) => {
      if (!this.onMouseDown) return;
      // Make coordinates unscaled
      let scale = SCREEN_WIDTH / parseFloat(this.canvas.style.width);
      let rect = this.canvas.getBoundingClientRect();
      let x = Math.round((e.clientX - rect.left) * scale);
      let y = Math.round((e.clientY - rect.top) * scale);
      this.onMouseDown(x, y);
    };
    this._handleMouseUp = () => {
      if (this.onMouseUp) this.onMouseUp();
    };
    this.canvas.addEventListener("mousedown", this._handleMouseDown);
    this.canvas.addEventListener("mouseup", this._handleMouseUp);

    this._initCanvas();
  }

  _initCanvas() {
    this.context = this.canvas.getContext("2d");
    this.imageData = this.context.getImageData(
      0,
      0,
      SCREEN_WIDTH,
      SCREEN_HEIGHT,
    );

    this.context.fillStyle = "black";
    // set alpha to opaque
    this.context.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    // buffer to write on next animation frame
    this.buf = new ArrayBuffer(this.imageData.data.length);
    // Get the canvas buffer in 8bit and 32bit
    this.buf8 = new Uint8ClampedArray(this.buf);
    this.buf32 = new Uint32Array(this.buf);

    // Set alpha
    for (var i = 0; i < this.buf32.length; ++i) {
      this.buf32[i] = 0xff000000;
    }
  }

  setBuffer = (buffer) => {
    for (var y = 0; y < SCREEN_HEIGHT; ++y) {
      for (var x = 0; x < SCREEN_WIDTH; ++x) {
        var i = y * 256 + x;
        // Convert pixel from NES BGR to canvas ABGR
        this.buf32[i] = 0xff000000 | buffer[i]; // Full alpha
      }
    }
  };

  writeBuffer = () => {
    this.imageData.data.set(this.buf8);
    this.context.putImageData(this.imageData, 0, 0);
  };

  fitInParent = () => {
    let parent = this.canvas.parentNode;
    let parentWidth = parent.clientWidth;
    let parentHeight = parent.clientHeight;
    let parentRatio = parentWidth / parentHeight;
    let desiredRatio = SCREEN_WIDTH / SCREEN_HEIGHT;
    if (desiredRatio < parentRatio) {
      this.canvas.style.width = `${Math.round(parentHeight * desiredRatio)}px`;
      this.canvas.style.height = `${parentHeight}px`;
    } else {
      this.canvas.style.width = `${parentWidth}px`;
      this.canvas.style.height = `${Math.round(parentWidth / desiredRatio)}px`;
    }
  };

  screenshot() {
    var img = new Image();
    img.src = this.canvas.toDataURL("image/png");
    return img;
  }

  destroy() {
    this.canvas.removeEventListener("mousedown", this._handleMouseDown);
    this.canvas.removeEventListener("mouseup", this._handleMouseUp);
    this.canvas.parentNode.removeChild(this.canvas);
  }
}

__exp.default = Screen;
return __exp;
}
function __m_browser_speakers_js() {
const __exp = {};
// AudioWorklet processor code, inlined as a string so it can be loaded via
// Blob URL without bundler-specific imports (e.g. ?raw). This avoids
// requiring webpack/Vite to import the module source.
//
// The processor receives stereo samples from the main thread via MessagePort
// and buffers them in a circular Float32Array for playback in process().
const workletCode = `
class NESAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Circular buffer sized to hold ~170ms of audio at 48kHz (8192 samples).
    this.capacity = 8192;
    this.bufferL = new Float32Array(this.capacity);
    this.bufferR = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.count = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "samples") {
        const left = e.data.left;
        const right = e.data.right;
        const len = left.length;

        // If adding these samples would overflow, drop oldest to make room
        if (this.count + len > this.capacity) {
          const drop = this.count + len - this.capacity;
          this.readPos = (this.readPos + drop) % this.capacity;
          this.count -= drop;
        }

        for (let i = 0; i < len; i++) {
          this.bufferL[this.writePos] = left[i];
          this.bufferR[this.writePos] = right[i];
          this.writePos = (this.writePos + 1) % this.capacity;
        }
        this.count += len;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const outL = output[0];
    const outR = output[1];
    const size = outL.length;

    if (this.count < size) {
      for (let i = 0; i < this.count; i++) {
        outL[i] = this.bufferL[this.readPos];
        outR[i] = this.bufferR[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
      }
      for (let i = this.count; i < size; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      this.count = 0;
      this.port.postMessage({ type: "underrun" });
    } else {
      for (let i = 0; i < size; i++) {
        outL[i] = this.bufferL[this.readPos];
        outR[i] = this.bufferR[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
      }
      this.count -= size;
    }

    return true;
  }
}

registerProcessor("nes-audio-processor", NESAudioProcessor);
`;

// How many samples to batch before posting to the worklet. Posting every
// single sample individually would be too much MessagePort overhead.
// 128 matches the AudioWorklet render quantum size.
const BATCH_SIZE = 128;

class Speakers {
  constructor({ onBufferUnderrun }) {
    this.onBufferUnderrun = onBufferUnderrun;
    this.audioCtx = null;
    this.node = null;
    this.batchL = new Float32Array(BATCH_SIZE);
    this.batchR = new Float32Array(BATCH_SIZE);
    this.batchPos = 0;
  }

  getSampleRate() {
    if (this.audioCtx) {
      return this.audioCtx.sampleRate;
    }
    return 44100;
  }

  // start() is async because audioWorklet.addModule() returns a promise.
  // Callers may fire-and-forget — the node will be null until the worklet
  // loads, and writeSample() silently drops samples during that brief window.
  async start() {
    if (!window.AudioContext) {
      return;
    }
    this.audioCtx = new window.AudioContext();

    const blob = new Blob([workletCode], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this.node = new AudioWorkletNode(this.audioCtx, "nes-audio-processor", {
      outputChannelCount: [2],
    });

    this.node.port.onmessage = (e) => {
      if (e.data.type === "underrun" && this.onBufferUnderrun) {
        this.onBufferUnderrun();
      }
    };

    this.node.connect(this.audioCtx.destination);

    // Chrome and other browsers require a user gesture before AudioContext can
    // start. If suspended, resume on the first user interaction.
    // See https://github.com/bfirsh/jsnes/issues/368
    if (this.audioCtx.state === "suspended") {
      this._resumeOnInteraction = () => {
        if (this.audioCtx) {
          this.audioCtx.resume();
        }
        this._removeResumeListeners();
      };
      document.addEventListener("keydown", this._resumeOnInteraction);
      document.addEventListener("mousedown", this._resumeOnInteraction);
      document.addEventListener("touchstart", this._resumeOnInteraction);
    }
  }

  _removeResumeListeners() {
    if (this._resumeOnInteraction) {
      document.removeEventListener("keydown", this._resumeOnInteraction);
      document.removeEventListener("mousedown", this._resumeOnInteraction);
      document.removeEventListener("touchstart", this._resumeOnInteraction);
      this._resumeOnInteraction = null;
    }
  }

  stop() {
    this._removeResumeListeners();
    if (this.node) {
      this.node.disconnect(this.audioCtx.destination);
      this.node = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch((e) => console.error(e));
      this.audioCtx = null;
    }
    this.batchPos = 0;
  }

  writeSample = (left, right) => {
    if (!this.node) return;

    this.batchL[this.batchPos] = left;
    this.batchR[this.batchPos] = right;
    this.batchPos++;

    if (this.batchPos >= BATCH_SIZE) {
      this.node.port.postMessage({
        type: "samples",
        left: this.batchL.slice(),
        right: this.batchR.slice(),
      });
      this.batchPos = 0;
    }
  };

  // Flush any remaining batched samples to the worklet. Called after each
  // frame to ensure partial batches are sent promptly.
  flush() {
    if (this.batchPos > 0 && this.node) {
      this.node.port.postMessage({
        type: "samples",
        left: this.batchL.slice(0, this.batchPos),
        right: this.batchR.slice(0, this.batchPos),
      });
      this.batchPos = 0;
    }
  }
}

__exp.default = Speakers;
return __exp;
}
function __m_controller_js() {
const __exp = {};
const { toJSON, fromJSON } = __req("utils.js");

class Controller {
  static BUTTON_A = 0;
  static BUTTON_B = 1;
  static BUTTON_SELECT = 2;
  static BUTTON_START = 3;
  static BUTTON_UP = 4;
  static BUTTON_DOWN = 5;
  static BUTTON_LEFT = 6;
  static BUTTON_RIGHT = 7;
  // Turbo buttons rapidly toggle A/B each frame while held, simulating the
  // extra buttons on the NES Advantage and dogbone controllers.
  static BUTTON_TURBO_A = 8;
  static BUTTON_TURBO_B = 9;

  static JSON_PROPERTIES = [
    "state",
    "baseA",
    "baseB",
    "turboA",
    "turboB",
    "turboToggle",
  ];

  constructor() {
    this.state = new Array(8);
    for (let i = 0; i < this.state.length; i++) {
      this.state[i] = 0x40;
    }
    // Track the non-turbo ("base") state of A and B so we can restore them
    // when turbo is released while the regular button is still held.
    this.baseA = 0x40;
    this.baseB = 0x40;
    this.turboA = false;
    this.turboB = false;
    this.turboToggle = false;
  }

  buttonDown(key) {
    if (key === Controller.BUTTON_TURBO_A) {
      this.turboA = true;
    } else if (key === Controller.BUTTON_TURBO_B) {
      this.turboB = true;
    } else {
      this.state[key] = 0x41;
      if (key === Controller.BUTTON_A) this.baseA = 0x41;
      if (key === Controller.BUTTON_B) this.baseB = 0x41;
    }
  }

  buttonUp(key) {
    if (key === Controller.BUTTON_TURBO_A) {
      this.turboA = false;
      this.state[Controller.BUTTON_A] = this.baseA;
    } else if (key === Controller.BUTTON_TURBO_B) {
      this.turboB = false;
      this.state[Controller.BUTTON_B] = this.baseB;
    } else {
      this.state[key] = 0x40;
      if (key === Controller.BUTTON_A) this.baseA = 0x40;
      if (key === Controller.BUTTON_B) this.baseB = 0x40;
    }
  }

  // Called once per frame to toggle turbo button states. Produces a ~30 Hz
  // press rate at 60 FPS, matching the fast end of the NES Advantage's
  // adjustable turbo range.
  clock() {
    if (!this.turboA && !this.turboB) return;
    this.turboToggle = !this.turboToggle;
    if (this.turboA) {
      this.state[Controller.BUTTON_A] = this.turboToggle ? 0x41 : 0x40;
    }
    if (this.turboB) {
      this.state[Controller.BUTTON_B] = this.turboToggle ? 0x41 : 0x40;
    }
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }
}

__exp.default = Controller;


return __exp;
}
function __m_cpu_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");

// ============================================================================
// 6502 opcode table
// ============================================================================
//
// The NES's CPU is a MOS 6502 variant (the Ricoh 2A03 on NTSC consoles,
// 2A07 on PAL). Like any CPU, it runs machine code by repeatedly fetching
// a byte from memory, decoding what that byte means, and executing the
// corresponding operation — the classic fetch-decode-execute loop.
//
// On the 6502, every (operation, addressing mode) pair is assigned its own
// unique 1-byte opcode. For example, "LDA" (Load Accumulator) has eight
// different opcode bytes because it supports eight addressing modes — one
// for "load from a fixed 2-byte address", one for "load from a zero-page
// address + X", and so on. That gives a total of 256 possible opcode bytes,
// of which the official 6502 defines 151; another ~80 are "unofficial"
// opcodes (see below); the rest are unused and would hang a real CPU.
//
// This file's emulate() method implements the fetch-decode-execute loop for
// a single CPU instruction. OPCODE_TABLE is the *decode* step: given the
// opcode byte we just fetched, it tells emulate() everything it needs to
// know before running the instruction:
//
//   ins    - which instruction to execute (INS_*). Used as the switch key
//            in the execute phase of emulate().
//   mode   - which addressing mode to use to find the operand (ADDR_*).
//   size   - how many bytes the instruction occupies in memory (1-3).
//   cycles - base cycle count, for reference. The emulator doesn't use
//            this: it performs every bus cycle the real CPU performs, so
//            cycle counts (including page-crossing penalties) come out
//            naturally.
//
// OPCODE_TABLE is defined as a plain object literal below, keyed by the
// raw opcode byte (0-255). Unassigned bytes (KIL/JAM opcodes, which hang a
// real 6502) are simply absent. At load time the table is flattened into
// typed arrays (OP_INS etc.) for speed; absent opcodes throw when executed.
//
// The INS_* and ADDR_* numeric values here must match the `case N:` labels
// in the execute switch in emulate(). If you ever renumber these, update
// the switch in lockstep.

// ----------------------------------------------------------------------------
// Addressing modes
// ----------------------------------------------------------------------------
//
// The 6502 has 13 addressing modes — different ways of specifying where an
// instruction's operand lives. Some modes take a literal value, some read
// from a fixed memory address, some compute an address from a base plus an
// index register (X or Y), and some dereference a pointer stored in memory.
//
// The numeric values here are used as `case` labels in the addressing-mode
// switch at the top of emulate(), which computes the final effective
// address (or loads the literal value) for each instruction before the
// instruction itself runs. The code in that switch is the authoritative
// source for what each mode actually does on the bus, including the
// sometimes-tricky "dummy reads" the real 6502 performs on indexed modes.
//
// Notation below: $XX means a 1-byte value (0-$FF), $XXXX means a 2-byte
// value (0-$FFFF). "Zero page" is the first 256 bytes of memory ($0000-
// $00FF), which the 6502 can address with a single byte — giving faster
// and smaller code than full 16-bit addresses.
//
// See https://www.nesdev.org/wiki/CPU_addressing_modes

const ADDR_ZP = 0; //          Zero page         — operand at $00XX
const ADDR_REL = 1; //         Relative          — PC + signed 8-bit offset (branches)
const ADDR_IMP = 2; //         Implied           — no operand (e.g. CLC, RTS, TAX)
const ADDR_ABS = 3; //         Absolute          — operand at $XXXX (any address)
const ADDR_ACC = 4; //         Accumulator       — operand is the A register itself
const ADDR_IMM = 5; //         Immediate         — operand is a literal byte (LDA #$42)
const ADDR_ZPX = 6; //         Zero page,X       — operand at ($XX + X) & $FF
const ADDR_ZPY = 7; //         Zero page,Y       — operand at ($XX + Y) & $FF
const ADDR_ABSX = 8; //        Absolute,X        — operand at $XXXX + X
const ADDR_ABSY = 9; //        Absolute,Y        — operand at $XXXX + Y
const ADDR_PREIDXIND = 10; //  (Indirect,X)      — pointer at ($XX + X) in zero page
const ADDR_POSTIDXIND = 11; // (Indirect),Y      — pointer at $XX in zero page, then + Y
const ADDR_INDABS = 12; //     Indirect absolute — pointer at $XXXX (JMP indirect only)

// ----------------------------------------------------------------------------
// Instructions
// ----------------------------------------------------------------------------
//
// The 6502 has 56 official instructions, each conventionally referred to
// by a 3-letter mnemonic (LDA, STA, JMP, etc.). Most instructions support
// several addressing modes, so one mnemonic usually maps to several opcode
// bytes — which is why OPCODE_TABLE below has multiple entries per
// mnemonic (e.g. LDA has eight, one for each addressing mode it supports).
//
// Each INS_* here is an internal identifier used as the `case` label in
// the execute switch in emulate(). The ordering and numeric values are
// arbitrary but must stay in sync with that switch.
//
// NOTE: the NES's 2A03/2A07 CPU omits the 6502's BCD (binary-coded decimal)
// mode. The CLD / SED instructions still exist and toggle the D flag, but
// the D flag has no effect on ADC/SBC. That's why the CLD/SED handlers in
// emulate() look like no-ops aside from flipping the flag.
//
// See https://www.nesdev.org/wiki/CPU for a per-instruction reference.

// Arithmetic & logic
const INS_ADC = 0; //  ADC — Add memory to accumulator with carry
const INS_AND = 1; //  AND — Bitwise AND memory with accumulator
const INS_ASL = 2; //  ASL — Arithmetic shift left (top bit → carry)
// Branches — each tests one status flag and jumps relative to PC if it matches
const INS_BCC = 3; //  BCC — Branch if carry clear
const INS_BCS = 4; //  BCS — Branch if carry set
const INS_BEQ = 5; //  BEQ — Branch if equal (zero flag set)
const INS_BIT = 6; //  BIT — Bit test: N ← M.7, V ← M.6, Z ← (A & M) == 0
const INS_BMI = 7; //  BMI — Branch if minus (negative flag set)
const INS_BNE = 8; //  BNE — Branch if not equal (zero flag clear)
const INS_BPL = 9; //  BPL — Branch if plus (negative flag clear)
const INS_BRK = 10; // BRK — Software interrupt (pushes PC+2 and status, jumps via $FFFE)
const INS_BVC = 11; // BVC — Branch if overflow clear
const INS_BVS = 12; // BVS — Branch if overflow set
// Flag clears
const INS_CLC = 13; // CLC — Clear carry flag
const INS_CLD = 14; // CLD — Clear decimal flag (no effect on NES, see note above)
const INS_CLI = 15; // CLI — Clear interrupt disable flag
const INS_CLV = 16; // CLV — Clear overflow flag
// Compares — like subtract, but only set flags (don't modify the register)
const INS_CMP = 17; // CMP — Compare memory with accumulator
const INS_CPX = 18; // CPX — Compare memory with X
const INS_CPY = 19; // CPY — Compare memory with Y
// Decrements
const INS_DEC = 20; // DEC — Decrement memory by one
const INS_DEX = 21; // DEX — Decrement X by one
const INS_DEY = 22; // DEY — Decrement Y by one
// XOR
const INS_EOR = 23; // EOR — Bitwise exclusive-OR memory with accumulator
// Increments
const INS_INC = 24; // INC — Increment memory by one
const INS_INX = 25; // INX — Increment X by one
const INS_INY = 26; // INY — Increment Y by one
// Jumps
const INS_JMP = 27; // JMP — Unconditional jump
const INS_JSR = 28; // JSR — Jump to subroutine (pushes return address first)
// Loads
const INS_LDA = 29; // LDA — Load accumulator from memory
const INS_LDX = 30; // LDX — Load X from memory
const INS_LDY = 31; // LDY — Load Y from memory
// Shift
const INS_LSR = 32; // LSR — Logical shift right (bottom bit → carry)
// No-op
const INS_NOP = 33; // NOP — No operation
// OR
const INS_ORA = 34; // ORA — Bitwise OR memory with accumulator
// Stack pushes/pulls ("pull" is the 6502 term for "pop")
const INS_PHA = 35; // PHA — Push accumulator onto stack
const INS_PHP = 36; // PHP — Push processor status onto stack
const INS_PLA = 37; // PLA — Pull accumulator from stack
const INS_PLP = 38; // PLP — Pull processor status from stack
// Rotates (through carry)
const INS_ROL = 39; // ROL — Rotate left through carry (C → bit 0, bit 7 → C)
const INS_ROR = 40; // ROR — Rotate right through carry (C → bit 7, bit 0 → C)
// Returns
const INS_RTI = 41; // RTI — Return from interrupt (pulls status and PC)
const INS_RTS = 42; // RTS — Return from subroutine (pulls PC)
// Subtract
const INS_SBC = 43; // SBC — Subtract memory from accumulator with borrow
// Flag sets
const INS_SEC = 44; // SEC — Set carry flag
const INS_SED = 45; // SED — Set decimal flag (no effect on NES, see note above)
const INS_SEI = 46; // SEI — Set interrupt disable flag
// Stores
const INS_STA = 47; // STA — Store accumulator to memory
const INS_STX = 48; // STX — Store X to memory
const INS_STY = 49; // STY — Store Y to memory
// Register transfers
const INS_TAX = 50; // TAX — Transfer accumulator to X
const INS_TAY = 51; // TAY — Transfer accumulator to Y
const INS_TSX = 52; // TSX — Transfer stack pointer to X
const INS_TXA = 53; // TXA — Transfer X to accumulator
const INS_TXS = 54; // TXS — Transfer X to stack pointer
const INS_TYA = 55; // TYA — Transfer Y to accumulator

// ----------------------------------------------------------------------------
// Unofficial opcodes
// ----------------------------------------------------------------------------
//
// The 6502's instruction decoder is a combinational circuit rather than a
// lookup table, and about 80 of the 256 possible opcode bytes decode to
// instructions that weren't part of the official instruction set but still
// do *something* — usually a combination of two official instructions that
// happen to share hardware (e.g. SLO = "ASL then ORA"). Some shipped NES
// games, and most CPU test ROMs (including nestest and AccuracyCoin), use
// them deliberately, so a correct NES emulator has to implement them.
//
// See https://www.nesdev.org/wiki/Programming_with_unofficial_opcodes

// Combined arithmetic/logic on the accumulator (immediate operand only)
const INS_ALR = 56; // ALR (ASR) — AND then LSR:  A = (A & #imm) >> 1
const INS_ANC = 57; // ANC        — AND, but also copy result's bit 7 into carry
const INS_ARR = 58; // ARR        — AND then ROR, with peculiar N/V/C side effects
const INS_AXS = 59; // AXS (SBX)  — X = (A & X) - #imm (like CMP, but stores result)
// Combined load/store
const INS_LAX = 60; // LAX — Load A and X from memory simultaneously
const INS_SAX = 61; // SAX — Store (A & X) to memory
// Read-modify-write combos: each does an RMW on memory then an A-side op
const INS_DCP = 62; // DCP — DEC memory then CMP with A
const INS_ISC = 63; // ISC (ISB) — INC memory then SBC from A
const INS_RLA = 64; // RLA — ROL memory then AND with A
const INS_RRA = 65; // RRA — ROR memory then ADC with A
const INS_SLO = 66; // SLO — ASL memory then ORA with A
const INS_SRE = 67; // SRE — LSR memory then EOR with A
// Multi-byte NOPs. These consume extra bytes and (for IGN) still perform a
// dummy memory read, but don't otherwise affect state. Games occasionally
// use them for precise cycle-count padding.
const INS_SKB = 68; // SKB — 2-byte NOP (skips an immediate byte)
const INS_IGN = 69; // IGN — 3-byte NOP that still reads from memory

// "Unstable" opcodes whose output depends on the internal bus arbitration
// between CPU cycles. Most store (register & (high byte of target + 1)).
// The DMC audio channel's DMA transfer can hijack the bus mid-instruction
// and change the stored value — the emulator handles this interaction in
// the execute switch. Essentially no shipped games use these, but the
// AccuracyCoin test ROM does.
const INS_SHA = 71; // SHA (AHX) — Store A & X & (H+1)
const INS_SHS = 72; // SHS (TAS) — SP = A & X, then store SP & (H+1)
const INS_SHY = 73; // SHY (SYA) — Store Y & (H+1)
const INS_SHX = 74; // SHX (SXA) — Store X & (H+1)
const INS_LAE = 75; // LAE (LAS) — A = X = SP = (memory & SP)

// Opcodes whose behavior depends on a "magic" constant that varies between
// CPU manufacturing runs (and even across die temperature). Tests only
// exercise these with inputs (A = $FF, or immediate = $00) where the magic
// value cancels out of the result, so we can pick any reasonable magic.
const INS_ANE = 76; // ANE (XAA) — A = (A | magic) & X & #imm
const INS_LXA = 77; // LXA (ATX) — A = X = (A | magic) & #imm

// ----------------------------------------------------------------------------
// The opcode table
// ----------------------------------------------------------------------------
//
// OPCODE_TABLE is a plain object keyed by opcode byte. Every valid 6502
// opcode has an entry here; unassigned bytes (including the KIL/STP/JAM
// family that would hang a real CPU) are simply absent from the table.
//
// Size and cycle counts come from the official 6502 datasheet and match
// the nesdev wiki's tables at https://www.nesdev.org/wiki/CPU.
//
// The whole OPCODE_TABLE literal is marked `// prettier-ignore` so that
// prettier doesn't collapse the manual column alignment below — being
// able to scan straight down the "mode" column makes the table much
// more readable than the default formatting would allow.

// prettier-ignore
const OPCODE_TABLE = {
  // ADC — Add with carry
  0x69: { ins: INS_ADC, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x65: { ins: INS_ADC, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x75: { ins: INS_ADC, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x6d: { ins: INS_ADC, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x7d: { ins: INS_ADC, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x79: { ins: INS_ADC, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0x61: { ins: INS_ADC, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x71: { ins: INS_ADC, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // AND — Bitwise AND with accumulator
  0x29: { ins: INS_AND, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x25: { ins: INS_AND, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x35: { ins: INS_AND, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x2d: { ins: INS_AND, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x3d: { ins: INS_AND, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x39: { ins: INS_AND, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0x21: { ins: INS_AND, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x31: { ins: INS_AND, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // ASL — Arithmetic shift left
  0x0a: { ins: INS_ASL, mode: ADDR_ACC,        size: 1, cycles: 2 },
  0x06: { ins: INS_ASL, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x16: { ins: INS_ASL, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x0e: { ins: INS_ASL, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x1e: { ins: INS_ASL, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // Branches — each tests a status flag and jumps relative to PC if it matches
  0x90: { ins: INS_BCC, mode: ADDR_REL,        size: 2, cycles: 2 },
  0xb0: { ins: INS_BCS, mode: ADDR_REL,        size: 2, cycles: 2 },
  0xf0: { ins: INS_BEQ, mode: ADDR_REL,        size: 2, cycles: 2 },
  0x30: { ins: INS_BMI, mode: ADDR_REL,        size: 2, cycles: 2 },
  0xd0: { ins: INS_BNE, mode: ADDR_REL,        size: 2, cycles: 2 },
  0x10: { ins: INS_BPL, mode: ADDR_REL,        size: 2, cycles: 2 },
  0x50: { ins: INS_BVC, mode: ADDR_REL,        size: 2, cycles: 2 },
  0x70: { ins: INS_BVS, mode: ADDR_REL,        size: 2, cycles: 2 },

  // BIT — Test bits in memory against accumulator
  0x24: { ins: INS_BIT, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x2c: { ins: INS_BIT, mode: ADDR_ABS,        size: 3, cycles: 4 },

  // BRK — Software interrupt
  0x00: { ins: INS_BRK, mode: ADDR_IMP,        size: 1, cycles: 7 },

  // Flag clears
  0x18: { ins: INS_CLC, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xd8: { ins: INS_CLD, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x58: { ins: INS_CLI, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xb8: { ins: INS_CLV, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // CMP — Compare memory with accumulator (sets flags only)
  0xc9: { ins: INS_CMP, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xc5: { ins: INS_CMP, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xd5: { ins: INS_CMP, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xcd: { ins: INS_CMP, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xdd: { ins: INS_CMP, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0xd9: { ins: INS_CMP, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0xc1: { ins: INS_CMP, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0xd1: { ins: INS_CMP, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // CPX — Compare memory with X
  0xe0: { ins: INS_CPX, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xe4: { ins: INS_CPX, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xec: { ins: INS_CPX, mode: ADDR_ABS,        size: 3, cycles: 4 },

  // CPY — Compare memory with Y
  0xc0: { ins: INS_CPY, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xc4: { ins: INS_CPY, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xcc: { ins: INS_CPY, mode: ADDR_ABS,        size: 3, cycles: 4 },

  // DEC — Decrement memory by one
  0xc6: { ins: INS_DEC, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0xd6: { ins: INS_DEC, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0xce: { ins: INS_DEC, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0xde: { ins: INS_DEC, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // DEX / DEY — Decrement X / Y by one
  0xca: { ins: INS_DEX, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x88: { ins: INS_DEY, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // EOR — Bitwise exclusive-OR with accumulator
  0x49: { ins: INS_EOR, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x45: { ins: INS_EOR, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x55: { ins: INS_EOR, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x4d: { ins: INS_EOR, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x5d: { ins: INS_EOR, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x59: { ins: INS_EOR, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0x41: { ins: INS_EOR, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x51: { ins: INS_EOR, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // INC — Increment memory by one
  0xe6: { ins: INS_INC, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0xf6: { ins: INS_INC, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0xee: { ins: INS_INC, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0xfe: { ins: INS_INC, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // INX / INY — Increment X / Y by one
  0xe8: { ins: INS_INX, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xc8: { ins: INS_INY, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // JMP — Unconditional jump (absolute or via indirect pointer)
  0x4c: { ins: INS_JMP, mode: ADDR_ABS,        size: 3, cycles: 3 },
  0x6c: { ins: INS_JMP, mode: ADDR_INDABS,     size: 3, cycles: 5 },

  // JSR — Jump to subroutine (pushes return address first)
  0x20: { ins: INS_JSR, mode: ADDR_ABS,        size: 3, cycles: 6 },

  // LDA — Load accumulator from memory
  0xa9: { ins: INS_LDA, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xa5: { ins: INS_LDA, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xb5: { ins: INS_LDA, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xad: { ins: INS_LDA, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xbd: { ins: INS_LDA, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0xb9: { ins: INS_LDA, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0xa1: { ins: INS_LDA, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0xb1: { ins: INS_LDA, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // LDX — Load X from memory
  0xa2: { ins: INS_LDX, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xa6: { ins: INS_LDX, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xb6: { ins: INS_LDX, mode: ADDR_ZPY,        size: 2, cycles: 4 },
  0xae: { ins: INS_LDX, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xbe: { ins: INS_LDX, mode: ADDR_ABSY,       size: 3, cycles: 4 },

  // LDY — Load Y from memory
  0xa0: { ins: INS_LDY, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xa4: { ins: INS_LDY, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xb4: { ins: INS_LDY, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xac: { ins: INS_LDY, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xbc: { ins: INS_LDY, mode: ADDR_ABSX,       size: 3, cycles: 4 },

  // LSR — Logical shift right
  0x4a: { ins: INS_LSR, mode: ADDR_ACC,        size: 1, cycles: 2 },
  0x46: { ins: INS_LSR, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x56: { ins: INS_LSR, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x4e: { ins: INS_LSR, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x5e: { ins: INS_LSR, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // NOP — No operation. $EA is the official NOP; the other six bytes are
  // unofficial single-byte NOPs that the 6502's decoder happens to treat
  // identically, and we handle them the same way.
  0x1a: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x3a: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x5a: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x7a: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xda: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xea: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xfa: { ins: INS_NOP, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // ORA — Bitwise OR with accumulator
  0x09: { ins: INS_ORA, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x05: { ins: INS_ORA, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x15: { ins: INS_ORA, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x0d: { ins: INS_ORA, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x1d: { ins: INS_ORA, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x19: { ins: INS_ORA, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0x01: { ins: INS_ORA, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x11: { ins: INS_ORA, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // Stack pushes/pulls — PHA/PLA move the accumulator, PHP/PLP the status
  // register. The 6502 stack lives in page 1 ($0100-$01FF), with SP as an
  // offset into that page.
  0x48: { ins: INS_PHA, mode: ADDR_IMP,        size: 1, cycles: 3 },
  0x08: { ins: INS_PHP, mode: ADDR_IMP,        size: 1, cycles: 3 },
  0x68: { ins: INS_PLA, mode: ADDR_IMP,        size: 1, cycles: 4 },
  0x28: { ins: INS_PLP, mode: ADDR_IMP,        size: 1, cycles: 4 },

  // ROL — Rotate left through carry
  0x2a: { ins: INS_ROL, mode: ADDR_ACC,        size: 1, cycles: 2 },
  0x26: { ins: INS_ROL, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x36: { ins: INS_ROL, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x2e: { ins: INS_ROL, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x3e: { ins: INS_ROL, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // ROR — Rotate right through carry
  0x6a: { ins: INS_ROR, mode: ADDR_ACC,        size: 1, cycles: 2 },
  0x66: { ins: INS_ROR, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x76: { ins: INS_ROR, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x6e: { ins: INS_ROR, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x7e: { ins: INS_ROR, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // RTI / RTS — Return from interrupt handler / subroutine
  0x40: { ins: INS_RTI, mode: ADDR_IMP,        size: 1, cycles: 6 },
  0x60: { ins: INS_RTS, mode: ADDR_IMP,        size: 1, cycles: 6 },

  // SBC — Subtract memory from accumulator with borrow.
  // $EB is an unofficial alternate opcode that the 6502's decoder treats
  // identically to the official $E9 (immediate SBC).
  0xe9: { ins: INS_SBC, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xeb: { ins: INS_SBC, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xe5: { ins: INS_SBC, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xf5: { ins: INS_SBC, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xed: { ins: INS_SBC, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xfd: { ins: INS_SBC, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0xf9: { ins: INS_SBC, mode: ADDR_ABSY,       size: 3, cycles: 4 },
  0xe1: { ins: INS_SBC, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0xf1: { ins: INS_SBC, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },

  // Flag sets
  0x38: { ins: INS_SEC, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xf8: { ins: INS_SED, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x78: { ins: INS_SEI, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // STA — Store accumulator to memory
  0x85: { ins: INS_STA, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x95: { ins: INS_STA, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x8d: { ins: INS_STA, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x9d: { ins: INS_STA, mode: ADDR_ABSX,       size: 3, cycles: 5 },
  0x99: { ins: INS_STA, mode: ADDR_ABSY,       size: 3, cycles: 5 },
  0x81: { ins: INS_STA, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x91: { ins: INS_STA, mode: ADDR_POSTIDXIND, size: 2, cycles: 6 },

  // STX — Store X to memory
  0x86: { ins: INS_STX, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x96: { ins: INS_STX, mode: ADDR_ZPY,        size: 2, cycles: 4 },
  0x8e: { ins: INS_STX, mode: ADDR_ABS,        size: 3, cycles: 4 },

  // STY — Store Y to memory
  0x84: { ins: INS_STY, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x94: { ins: INS_STY, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x8c: { ins: INS_STY, mode: ADDR_ABS,        size: 3, cycles: 4 },

  // Register transfers — copy one register to another in a single cycle
  0xaa: { ins: INS_TAX, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xa8: { ins: INS_TAY, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0xba: { ins: INS_TSX, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x8a: { ins: INS_TXA, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x9a: { ins: INS_TXS, mode: ADDR_IMP,        size: 1, cycles: 2 },
  0x98: { ins: INS_TYA, mode: ADDR_IMP,        size: 1, cycles: 2 },

  // --- Unofficial opcodes ---
  //
  // These aren't part of the official 6502 spec but fall out of the chip's
  // decoder logic. Nestest and AccuracyCoin exercise them, and a handful
  // of shipped NES games rely on them. See the INS_* comments above for
  // what each one actually computes.

  // ALR (ASR) — AND then LSR
  0x4b: { ins: INS_ALR, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // ANC — AND, with carry also set to bit 7 of the result
  0x0b: { ins: INS_ANC, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x2b: { ins: INS_ANC, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // ARR — AND then ROR (with quirky N/V/C flag behavior)
  0x6b: { ins: INS_ARR, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // AXS (SBX) — X = (A & X) - immediate
  0xcb: { ins: INS_AXS, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // LAX — Load A and X simultaneously from memory
  0xa3: { ins: INS_LAX, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0xa7: { ins: INS_LAX, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0xaf: { ins: INS_LAX, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0xb3: { ins: INS_LAX, mode: ADDR_POSTIDXIND, size: 2, cycles: 5 },
  0xb7: { ins: INS_LAX, mode: ADDR_ZPY,        size: 2, cycles: 4 },
  0xbf: { ins: INS_LAX, mode: ADDR_ABSY,       size: 3, cycles: 4 },

  // SAX — Store (A & X) to memory
  0x83: { ins: INS_SAX, mode: ADDR_PREIDXIND,  size: 2, cycles: 6 },
  0x87: { ins: INS_SAX, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x8f: { ins: INS_SAX, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x97: { ins: INS_SAX, mode: ADDR_ZPY,        size: 2, cycles: 4 },

  // DCP — DEC memory then CMP with A
  0xc3: { ins: INS_DCP, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0xc7: { ins: INS_DCP, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0xcf: { ins: INS_DCP, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0xd3: { ins: INS_DCP, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0xd7: { ins: INS_DCP, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0xdb: { ins: INS_DCP, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0xdf: { ins: INS_DCP, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // ISC (ISB) — INC memory then SBC from A
  0xe3: { ins: INS_ISC, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0xe7: { ins: INS_ISC, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0xef: { ins: INS_ISC, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0xf3: { ins: INS_ISC, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0xf7: { ins: INS_ISC, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0xfb: { ins: INS_ISC, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0xff: { ins: INS_ISC, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // RLA — ROL memory then AND with A
  0x23: { ins: INS_RLA, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0x27: { ins: INS_RLA, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x2f: { ins: INS_RLA, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x33: { ins: INS_RLA, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0x37: { ins: INS_RLA, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x3b: { ins: INS_RLA, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0x3f: { ins: INS_RLA, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // RRA — ROR memory then ADC with A
  0x63: { ins: INS_RRA, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0x67: { ins: INS_RRA, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x6f: { ins: INS_RRA, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x73: { ins: INS_RRA, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0x77: { ins: INS_RRA, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x7b: { ins: INS_RRA, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0x7f: { ins: INS_RRA, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // SLO — ASL memory then ORA with A
  0x03: { ins: INS_SLO, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0x07: { ins: INS_SLO, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x0f: { ins: INS_SLO, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x13: { ins: INS_SLO, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0x17: { ins: INS_SLO, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x1b: { ins: INS_SLO, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0x1f: { ins: INS_SLO, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // SRE — LSR memory then EOR with A
  0x43: { ins: INS_SRE, mode: ADDR_PREIDXIND,  size: 2, cycles: 8 },
  0x47: { ins: INS_SRE, mode: ADDR_ZP,         size: 2, cycles: 5 },
  0x4f: { ins: INS_SRE, mode: ADDR_ABS,        size: 3, cycles: 6 },
  0x53: { ins: INS_SRE, mode: ADDR_POSTIDXIND, size: 2, cycles: 8 },
  0x57: { ins: INS_SRE, mode: ADDR_ZPX,        size: 2, cycles: 6 },
  0x5b: { ins: INS_SRE, mode: ADDR_ABSY,       size: 3, cycles: 7 },
  0x5f: { ins: INS_SRE, mode: ADDR_ABSX,       size: 3, cycles: 7 },

  // SKB — 2-byte NOP that skips an immediate byte
  0x80: { ins: INS_SKB, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x82: { ins: INS_SKB, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0x89: { ins: INS_SKB, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xc2: { ins: INS_SKB, mode: ADDR_IMM,        size: 2, cycles: 2 },
  0xe2: { ins: INS_SKB, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // IGN — 3-byte NOP that still performs a memory read
  0x0c: { ins: INS_IGN, mode: ADDR_ABS,        size: 3, cycles: 4 },
  0x1c: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x3c: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x5c: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x7c: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0xdc: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0xfc: { ins: INS_IGN, mode: ADDR_ABSX,       size: 3, cycles: 4 },
  0x04: { ins: INS_IGN, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x44: { ins: INS_IGN, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x64: { ins: INS_IGN, mode: ADDR_ZP,         size: 2, cycles: 3 },
  0x14: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x34: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x54: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0x74: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xd4: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },
  0xf4: { ins: INS_IGN, mode: ADDR_ZPX,        size: 2, cycles: 4 },

  // SHA (AHX) — Store A & X & (H+1)
  0x93: { ins: INS_SHA, mode: ADDR_POSTIDXIND, size: 2, cycles: 6 },
  0x9f: { ins: INS_SHA, mode: ADDR_ABSY,       size: 3, cycles: 5 },

  // SHS (TAS) — SP = A & X, then store SP & (H+1)
  0x9b: { ins: INS_SHS, mode: ADDR_ABSY,       size: 3, cycles: 5 },

  // SHY (SYA) — Store Y & (H+1)
  0x9c: { ins: INS_SHY, mode: ADDR_ABSX,       size: 3, cycles: 5 },

  // SHX (SXA) — Store X & (H+1)
  0x9e: { ins: INS_SHX, mode: ADDR_ABSY,       size: 3, cycles: 5 },

  // LAE (LAS) — A = X = SP = memory & SP
  0xbb: { ins: INS_LAE, mode: ADDR_ABSY,       size: 3, cycles: 4 },

  // ANE (XAA) — A = (A | magic) & X & immediate
  0x8b: { ins: INS_ANE, mode: ADDR_IMM,        size: 2, cycles: 2 },

  // LXA — A = X = (A | magic) & immediate
  0xab: { ins: INS_LXA, mode: ADDR_IMM,        size: 2, cycles: 2 },
};

// ----------------------------------------------------------------------------
// Flattened decode tables
// ----------------------------------------------------------------------------
//
// OPCODE_TABLE above is the human-readable source of truth. At load time we
// flatten it into typed arrays indexed by opcode byte, which are much faster
// to look up on the hottest path in the emulator.
//
// OP_INS[op]  - the INS_* instruction (255 = invalid / KIL opcode)
// OP_MODE[op] - the ADDR_* addressing mode
// OP_KIND[op] - how the generic addressing step treats the operand:
//   KIND_READ    - the instruction reads its operand. Indexed modes only do
//                  the extra "fix-up" dummy read when a page is crossed.
//   KIND_WRITE   - stores and read-modify-write instructions. Indexed modes
//                  ALWAYS perform the fix-up dummy read, because the CPU
//                  can't know in advance whether the first (possibly wrong)
//                  address is correct, and writing to the wrong address
//                  would be destructive.
//   KIND_SPECIAL - the instruction does its own bus cycles (jumps, branches,
//                  stack operations, implied/accumulator instructions).
const KIND_READ = 0;
const KIND_WRITE = 1;
const KIND_SPECIAL = 2;

const OP_INS = new Uint8Array(256).fill(255);
const OP_MODE = new Uint8Array(256);
const OP_KIND = new Uint8Array(256);

for (const key of Object.keys(OPCODE_TABLE)) {
  const op = Number(key);
  const info = OPCODE_TABLE[op];
  OP_INS[op] = info.ins;
  OP_MODE[op] = info.mode;
  let kind = KIND_READ;
  switch (info.ins) {
    case INS_STA:
    case INS_STX:
    case INS_STY:
    case INS_SAX:
    case INS_SHA:
    case INS_SHS:
    case INS_SHX:
    case INS_SHY:
    case INS_ASL:
    case INS_LSR:
    case INS_ROL:
    case INS_ROR:
    case INS_INC:
    case INS_DEC:
    case INS_SLO:
    case INS_SRE:
    case INS_RLA:
    case INS_RRA:
    case INS_DCP:
    case INS_ISC:
      kind = KIND_WRITE;
      break;
    case INS_JSR:
    case INS_BRK:
    case INS_RTI:
    case INS_RTS:
    case INS_PHA:
    case INS_PHP:
    case INS_PLA:
    case INS_PLP:
      kind = KIND_SPECIAL;
      break;
  }
  // Modes that the generic addressing step never handles: relative
  // (branches), implied/accumulator (no memory operand) and JMP indirect.
  if (
    info.mode === ADDR_REL ||
    info.mode === ADDR_IMP ||
    info.mode === ADDR_ACC ||
    info.mode === ADDR_INDABS
  ) {
    kind = KIND_SPECIAL;
  }
  OP_KIND[op] = kind;
}

// Interrupt vectors (addresses of the 16-bit handler pointers).
const VECTOR_NMI = 0xfffa;
const VECTOR_RESET = 0xfffc;
const VECTOR_IRQ = 0xfffe;

// Bits in cpu.irqFlags. The 6502's /IRQ input is a single wire shared by
// every device that can interrupt (wired-OR). We track each source in its own
// bit so that each device can assert and release its line independently.
const IRQ_SOURCE_MAPPER = 1; // Cartridge (e.g. MMC3 scanline counter)
const IRQ_SOURCE_FRAME = 2; // APU frame counter
const IRQ_SOURCE_DMC = 4; // APU DMC channel

// The PPU runs at exactly 3x the CPU clock, so 3 PPU "dots" elapse during
// every CPU cycle. The CPU performs its bus access first, then the PPU is
// advanced (see _endCycle()). The CPU's NMI input is sampled partway through
// the cycle (during the second half of the cycle, called φ2, on real
// hardware): after the first of the cycle's 3 dots. This determines e.g.
// whether a VBlank flag that becomes set near the end of an instruction
// triggers an NMI immediately after that instruction or one instruction
// later. It is tuned against the AccuracyCoin "NMI Timing" tests.

// ============================================================================
// The CPU
// ============================================================================
//
// This is a *cycle-stepped* 6502: every single bus access (read or write)
// that the real chip performs is modelled as one call to read() or write(),
// and each such call represents exactly one CPU clock cycle. During that
// cycle, the rest of the console is advanced in lockstep:
//
//   - The APU is clocked once (it runs on the CPU clock).
//   - The PPU is advanced by 3 dots.
//   - The interrupt lines (NMI and IRQ) are sampled.
//   - Pending DMA transfers may "halt" the CPU before a read.
//
// The 6502 performs a bus access on *every* cycle, even when it has nothing
// useful to read (e.g. while it is adding an index to an address). These
// are called "dummy reads" and "dummy writes". They matter because reading
// some I/O registers has side effects (reading $2007 advances the PPU's
// address, reading $2002 clears the VBlank flag, etc.), and test ROMs check
// them. So instructions here are written out cycle by cycle, matching the
// tables in https://www.nesdev.org/6502_cpu.txt.
//
// Interrupt timing falls out of the same model: the 6502 decides whether to
// service an interrupt based on the state of its interrupt lines at the end
// of an instruction's *second-to-last* cycle. See _endCycle().
//
// See https://www.nesdev.org/wiki/CPU and
// https://www.nesdev.org/wiki/CPU_interrupts
class CPU {
  // IRQ Types (arguments to requestIrq)
  IRQ_NORMAL = 0;
  IRQ_NMI = 1;
  IRQ_RESET = 2;

  constructor(nes) {
    this.nes = nes;

    // Main memory. Only $0000-$07FF (internal RAM) and $6000-$FFFF
    // (cartridge RAM/ROM, filled in by the mapper) are really stored here;
    // other regions are I/O and routed through the mapper.
    this.mem = new Uint8Array(0x10000);

    // Power-on RAM contents are not well defined on real hardware. JSNES has
    // historically used $FF with a few specific bytes, which some games
    // (accidentally) depend on.
    this.mem.fill(0xff, 0, 0x2000);
    for (let p = 0; p < 4; p++) {
      let j = p * 0x800;
      this.mem[j + 0x008] = 0xf7;
      this.mem[j + 0x009] = 0xef;
      this.mem[j + 0x00a] = 0xdf;
      this.mem[j + 0x00f] = 0xbf;
    }

    // Registers.
    this.REG_ACC = 0;
    this.REG_X = 0;
    this.REG_Y = 0;
    // 8-bit; the stack lives at $0100 | SP. Starts at 0 at power on; the
    // reset sequence then decrements it by 3, giving the familiar $FD.
    this.REG_SP = 0;
    this.REG_PC = 0x8000; // The real program counter (16-bit)

    // Status flags, stored unpacked for speed. Each is 0 or 1, except:
    // F_ZERO stores the last result byte rather than a boolean. The Z flag
    // is considered SET when F_ZERO === 0. This saves a comparison on every
    // instruction that updates Z.
    this.F_CARRY = 0;
    this.F_ZERO = 1;
    this.F_INTERRUPT = 1;
    this.F_DECIMAL = 0;
    this.F_OVERFLOW = 0;
    this.F_SIGN = 0;
    // Bits 4 (B) and 5 of the status register don't physically exist in
    // the 6502; they only appear in the copy pushed to the stack. We keep
    // these for getStatus()/setStatus() compatibility.
    this.F_BRK = 1;
    this.F_NOTUSED = 1;

    // Total number of CPU cycles executed since power on. Used to determine
    // the "parity" of the current cycle, which matters because the APU (and
    // the DMA unit inside the same chip) runs at half the CPU clock: every
    // CPU cycle is either a "get" cycle or a "put" cycle.
    // See https://www.nesdev.org/wiki/DMA
    this.cycles = 0;

    // Tracks the last value on the CPU data bus. When reading from unmapped
    // addresses ("open bus"), the NES returns this value. Updated on every
    // read and write (except reads of $4015, which is internal to the CPU
    // chip and doesn't drive the external bus).
    // See https://www.nesdev.org/wiki/Open_bus_behavior
    this.dataBus = 0;

    // --- Interrupts ---
    //
    // IRQ is level-triggered: cpu.irqFlags holds one bit per device that is
    // currently asserting the IRQ line (IRQ_SOURCE_*). NMI is edge-triggered:
    // the CPU watches the PPU's NMI output and latches a request when it goes
    // from inactive to active.
    this.irqFlags = 0;
    this.resetPending = false;
    // Last sampled level of the NMI line, for edge detection.
    this.nmiLine = false;
    // NMI edge detected and not yet serviced.
    this.needNmi = false;
    // needNmi as it was one sample earlier (at the end of the previous
    // cycle). The CPU uses the *second-to-last* cycle's state to decide
    // whether to service an interrupt after an instruction.
    this.prevNeedNmi = false;
    // Whether an IRQ should be serviced (IRQ line active and I flag clear),
    // as of the most recent sample and the one before it.
    this.runIrq = false;
    this.prevRunIrq = false;
    // Test hook: an NMI requested with requestIrq(IRQ_NMI).
    this.forcedNmi = false;

    // --- DMA ---
    //
    // The 2A03 contains two DMA units which take over the bus by halting
    // the CPU: OAM DMA (sprite data copy, triggered by writing $4014) and
    // DMC DMA (audio sample fetches for the APU's DMC channel). The CPU can
    // only be halted on a read cycle. See _runDma().
    this.dmaNeedHalt = false; // A DMA wants to halt the CPU on the next read
    this.dmcDmaRunning = false; // A DMC sample fetch is in progress/pending
    this.dmcNeedDummy = false; // DMC DMA still needs its "dummy" cycle
    this.dmcDmaAbort = false; // DMC DMA was cancelled after it halted the CPU
    this.oamDmaRunning = false; // An OAM DMA is in progress/pending
    this.oamDmaPage = 0; // High byte of the OAM DMA source address
    // The cycle number at which the most recent DMA finished. Used by the
    // SHx unofficial opcodes, whose stored value depends on whether the CPU
    // was halted right before the write.
    this.lastDmaEndCycle = -1;
    // Cycle on which a 1-cycle aborted DMC DMA would halt the CPU.
    this.abortedDmaCycle = -1;

    // Game Genie is applied on reads from cartridge space.
    this._gameGenieActive = false;
    // True when PRG ROM reads ($8000-$FFFF) can come straight from cpu.mem
    // instead of going through the mapper. See _updatePrgReadPath().
    this.directPrgReads = false;

    // Shortcuts to the PPU and APU, which are advanced on every cycle.
    // (The NES sets these again once it has created all its components.)
    this.ppu = nes.ppu;
    this.papu = nes.papu;
  }

  // ==========================================================================
  // Bus cycles
  // ==========================================================================

  // One CPU read cycle.
  read(addr) {
    if (this.dmaNeedHalt) {
      this._runDma(addr);
    }
    this.cycles++;
    if (this.cycles >= this.papu.nextEventCycle) {
      this.papu.catchUp(this.cycles);
    }
    let value;
    if (addr < 0x2000) {
      // Internal RAM, mirrored every 2KB.
      value = this.dataBus = this.mem[addr & 0x7ff];
    } else if (addr >= 0x8000 && this.directPrgReads) {
      // PRG ROM. Almost every mapper copies the selected PRG banks into
      // cpu.mem, so skip the mapper call (this is the most common read).
      value = this.dataBus = this.mem[addr];
    } else if (addr === 0x4015) {
      // The APU status register is inside the CPU chip; reading it doesn't
      // update the external data bus. See https://www.nesdev.org/wiki/Open_bus_behavior
      value = this.nes.mmap.load(addr);
    } else {
      if (
        addr < 0x8000 &&
        (addr < 0x4000 || addr >= 0x4020 || addr === 0x4017)
      ) {
        // The PPU (or a mapper that watches it) may be involved: bring the
        // PPU up to date first. See PPU.catchUp().
        this._syncPpu(addr);
      }
      value = this.nes.mmap.load(addr);
      if (this._gameGenieActive && addr >= 0x8000) {
        value = this.nes.gameGenie.applyCodes(addr, value);
      }
      this.dataBus = value;
    }
    this._endCycle();
    return value;
  }

  // Bring the PPU up to the current cycle before an access that could
  // observe or change its state: PPU registers ($2000-$3FFF), cartridge
  // registers (mappers switch CHR banks or count scanlines) and $4017
  // (the Zapper looks at the screen).
  _syncPpu(addr) {
    const ppu = this.ppu;
    ppu.catchUp();
    if (addr < 0x4000) {
      // A PPU register access can change the PPU's upcoming events (e.g.
      // enabling NMI or rendering), so re-check them this cycle.
      ppu.nextEventDot = 0;
    }
  }

  // One CPU write cycle. Writes are never interrupted by DMA: if a DMA
  // becomes pending during a write, it waits for the next read cycle.
  write(addr, value) {
    if (this.abortedDmaCycle === this.cycles + 1 && this.dmcDmaAbort) {
      // A pending 1-cycle aborted DMC DMA lands on a write: it vanishes.
      this.dmcDmaRunning = false;
      this.dmcDmaAbort = false;
      this.dmaNeedHalt = this.oamDmaRunning;
    }
    this.cycles++;
    if (this.cycles >= this.papu.nextEventCycle) {
      this.papu.catchUp(this.cycles);
    }
    this.dataBus = value;
    if (addr < 0x2000) {
      this.mem[addr & 0x7ff] = value;
    } else {
      if (addr < 0x4000 || addr >= 0x4020) {
        this._syncPpu(addr);
      }
      this.nes.mmap.write(addr, value);
    }
    this._endCycle();
  }

  // Second half of every cycle: advance the PPU 3 dots and sample the
  // interrupt lines at the right moment within the cycle.
  //
  // For speed, the PPU is normally run lazily ("catch-up"): we just add this
  // cycle's 3 dots to its to-do count, and it runs them in a batch the next
  // time anything needs to look at it. If the PPU has an event coming up
  // that the CPU would notice (like VBlank starting), it runs exactly in
  // step for that cycle instead. See PPU.catchUp().
  _endCycle() {
    const ppu = this.ppu;
    ppu.dotTarget += 3;
    let nmi;
    if (ppu.dotTarget > ppu.nextEventDot) {
      // Runs the dots and records the NMI output at the poll point.
      ppu.runCycleExact();
      nmi = ppu.nmiAtPoll;
    } else {
      // No PPU event this cycle, so the NMI output can't change.
      nmi = ppu.nmiOutput;
    }

    // Sample the interrupt lines. Happens once per cycle.
    //
    // The 6502 checks for interrupts at the end of each instruction, but what
    // it actually looks at is the state of its internal "interrupt pending"
    // signals as they were at the end of the instruction's second-to-last
    // cycle. So we keep two generations of each signal: the current sample
    // and the previous one. When an instruction finishes, emulate() looks at
    // prevNeedNmi/prevRunIrq.
    //
    // This naturally produces lots of documented quirks, e.g. CLI followed by
    // an instruction lets that one instruction run before the IRQ (the I flag
    // only changes after CLI's last cycle has sampled the lines).
    // See https://www.nesdev.org/wiki/CPU_interrupts
    this.prevNeedNmi = this.needNmi;
    if (nmi && !this.nmiLine) {
      this.needNmi = true;
    }
    this.nmiLine = nmi;
    this.prevRunIrq = this.runIrq;
    this.runIrq = this.irqFlags !== 0 && this.F_INTERRUPT === 0;
  }

  // Read the byte at PC and advance PC.
  _fetch() {
    const v = this.read(this.REG_PC);
    this.REG_PC = (this.REG_PC + 1) & 0xffff;
    return v;
  }

  push(value) {
    this.write(0x100 | this.REG_SP, value);
    this.REG_SP = (this.REG_SP - 1) & 0xff;
  }

  pull() {
    this.REG_SP = (this.REG_SP + 1) & 0xff;
    return this.read(0x100 | this.REG_SP);
  }

  // Compatibility alias used by tests and older code.
  load(addr) {
    return this.read(addr);
  }

  // ==========================================================================
  // Interrupt requests from other components
  // ==========================================================================

  // Request an interrupt. IRQ_NORMAL asserts the cartridge IRQ line (it is
  // released automatically when the IRQ is serviced, which matches how the
  // mappers in this codebase use it); IRQ_RESET resets the CPU before the
  // next instruction; IRQ_NMI forces an NMI (used by tests).
  requestIrq(type) {
    if (type === this.IRQ_NORMAL) {
      this.irqFlags |= IRQ_SOURCE_MAPPER;
    } else if (type === this.IRQ_NMI) {
      this.forcedNmi = true;
      this.needNmi = true;
      this.prevNeedNmi = true;
    } else if (type === this.IRQ_RESET) {
      this.resetPending = true;
    }
  }

  // Release the cartridge IRQ line (mappers call this when the game
  // acknowledges the interrupt).
  clearIrq() {
    this.irqFlags &= ~IRQ_SOURCE_MAPPER;
  }

  // Assert or release one of the APU's IRQ lines.
  setIrqSource(source, active) {
    if (active) {
      this.irqFlags |= source;
    } else {
      this.irqFlags &= ~source;
    }
  }

  // True if any interrupt request is outstanding (used by tests).
  get irqRequested() {
    return this.irqFlags !== 0 || this.resetPending || this.forcedNmi;
  }

  set irqRequested(value) {
    if (!value) {
      this.irqFlags = 0;
      this.resetPending = false;
      this.forcedNmi = false;
    }
  }

  // ==========================================================================
  // DMA
  // ==========================================================================
  //
  // Both DMA units in the 2A03 work by pulling the CPU's RDY line low, which
  // makes the CPU stop on its next *read* cycle (the 6502 ignores RDY during
  // writes). While halted, the CPU keeps repeating that read on the bus, so
  // the address it was about to read gets read several times. Reading some
  // registers twice has visible side effects (e.g. $2007 advances twice),
  // which is exactly what the AccuracyCoin "DMA + $2007 Read" etc. tests
  // check.
  //
  // The DMA unit can only read on "get" cycles and only write on "put"
  // cycles (the APU clock is CPU clock / 2, and each APU cycle has a get
  // half and a put half). So DMAs sometimes need an extra "alignment" cycle.
  //
  // DMC DMA (one byte): halt cycle, dummy cycle, optional alignment cycle,
  //   then the read on a get cycle. 3 or 4 cycles total.
  // OAM DMA (256 bytes): halt cycle, optional alignment cycle, then 256
  //   alternating read (get) / write to $2004 (put) pairs. 513 or 514 cycles.
  // When both are active, the DMC read steals a get cycle from the OAM DMA.
  //
  // See https://www.nesdev.org/wiki/DMA

  // Called by the APU when the DMC needs its next sample byte.
  startDmcDma() {
    this.dmcDmaRunning = true;
    this.dmcNeedDummy = true;
    this.dmaNeedHalt = true;
  }

  // Called by the APU when the DMC is disabled (via $4015) while a DMA is
  // pending. If the DMA hasn't halted the CPU yet it's cancelled entirely;
  // if it has just halted the CPU it gets aborted (the CPU still loses the
  // halt cycle). See https://www.nesdev.org/wiki/DMA#DMC_DMA_abort
  stopDmcDma() {
    if (!this.dmcDmaRunning) return;
    if (this.dmaNeedHalt && !this.oamDmaRunning) {
      this.dmcDmaRunning = false;
      this.dmcNeedDummy = false;
      this.dmaNeedHalt = false;
    } else {
      this.dmcDmaAbort = true;
    }
  }

  // A DMC DMA that halts the CPU for one cycle and is then aborted (see
  // ChannelDM._requestDma). Unlike a normal DMA, it isn't delayed by write
  // cycles: if the next cycle is a write, it simply doesn't happen.
  startAbortedDmcDma() {
    if (this.dmcDmaRunning) return;
    this.dmcDmaRunning = true;
    this.dmcDmaAbort = true;
    this.dmaNeedHalt = true;
    this.abortedDmaCycle = this.cycles + 1;
  }

  // Called when the game writes to $4014.
  startOamDma(page) {
    this.oamDmaRunning = true;
    this.oamDmaPage = page;
    this.dmaNeedHalt = true;
  }

  // A cycle in which the halted CPU repeats its pending read. Most of the
  // time this is harmless, but for I/O registers it has side effects.
  _haltedRead(addr, skipRead) {
    this.cycles++;
    if (this.cycles >= this.papu.nextEventCycle) {
      this.papu.catchUp(this.cycles);
    }
    if (!skipRead) {
      this._dmaBusRead(addr);
    }
    this._endCycle();
  }

  // Perform a read on the bus during DMA (updates the data bus like a
  // normal read, except for the internal $4015 register).
  _dmaBusRead(addr) {
    let value;
    if (addr < 0x2000) {
      value = this.mem[addr & 0x7ff];
    } else {
      if (
        addr < 0x8000 &&
        (addr < 0x4000 || addr >= 0x4020 || addr === 0x4017)
      ) {
        this._syncPpu(addr);
      }
      value = this.nes.mmap.load(addr);
      if (addr === 0x4015) return value;
    }
    this.dataBus = value;
    return value;
  }

  // Read performed by a DMA unit for its own purposes (fetching a DMC
  // sample byte or an OAM byte). Returns the value the DMA unit receives.
  //
  // Hardware quirk: inside the 2A03, the readable registers ($4015-$4017)
  // are enabled whenever the *CPU's* address bus is in $4000-$401F, and
  // they only decode the low 5 bits of the address. Normally the DMA units
  // can't see them, but if the CPU was halted while reading from that range
  // (e.g. LDA $4016), then a DMA read from any address whose low 5 bits are
  // $15-$17 also reads the register, colliding with whatever the external
  // memory returns:
  //   - $4015 (APU status): the read clears the frame IRQ flag; the DMA
  //     receives the status (bit 5 is open bus, so it comes from the
  //     external value), but as usual the status doesn't drive the external
  //     data bus, which keeps the external value.
  //   - $4016/$4017 (controllers): the controller drives bits 0-4, the
  //     external value supplies bits 5-7 (normally "open bus").
  // See https://www.nesdev.org/wiki/DMA#Register_conflicts and the
  // AccuracyCoin "APU Register Activation" / "DMC DMA Bus Conflicts" tests.
  _dmaFetch(addr, haltedAddr) {
    this.cycles++;
    if (this.cycles >= this.papu.nextEventCycle) {
      this.papu.catchUp(this.cycles);
    }
    let value;
    if ((haltedAddr & 0xffe0) !== 0x4000) {
      if (addr >= 0x4000 && addr <= 0x401f) {
        // With the registers disabled, nothing drives the bus here.
        value = this.dataBus;
      } else {
        value = this._dmaBusRead(addr);
      }
      this._lastDmaReadAddr = addr;
    } else {
      const internal = 0x4000 | (addr & 0x1f);
      if (internal === 0x4015) {
        const status = this.nes.mmap.load(0x4015);
        const external =
          addr === internal ? this.dataBus : this._dmaBusRead(addr);
        value = (status & 0xdf) | (external & 0x20);
      } else if (internal === 0x4016 || internal === 0x4017) {
        let port;
        if (this._lastDmaReadAddr === internal) {
          // The controller port's /OE line stays active across back-to-back
          // reads, so the controller only sees one read (no extra clock).
          port = this.dataBus;
        } else {
          port = this.nes.mmap.load(internal);
        }
        const external =
          addr === internal ? this.dataBus : this._dmaBusRead(addr);
        value = this.dataBus = (external & 0xe0) | (port & 0x1f);
      } else {
        value = this._dmaBusRead(addr);
      }
      this._lastDmaReadAddr = internal;
    }
    this._endCycle();
    return value;
  }

  _dmaWrite(addr, value) {
    this.cycles++;
    if (this.cycles >= this.papu.nextEventCycle) {
      this.papu.catchUp(this.cycles);
    }
    this.dataBus = value;
    this._syncPpu(addr);
    this.nes.mmap.write(addr, value);
    this._endCycle();
  }

  // Run any pending DMA. Called at the start of a CPU read cycle when a DMA
  // has requested a halt. `addr` is the address the CPU was about to read;
  // the halted CPU keeps putting it on the bus during idle DMA cycles.
  _runDma(addr) {
    this._runDmaCycles(addr);
    this.lastDmaEndCycle = this.cycles;
  }

  _runDmaCycles(addr) {
    this.dmaNeedHalt = false;
    this._lastDmaReadAddr = addr;

    const isController = addr === 0x4016 || addr === 0x4017;
    // On an NES (as opposed to an original Famicom), the controller only
    // gets clocked by the first of several back-to-back reads of $4016/7,
    // because the /OE line it uses as a clock stays low throughout.
    const skipRepeatReads = isController;

    // If a DMC DMA is about to read the same 2A03 register (low 5 bits) as
    // the CPU, the CPU's halted read and the DMA read merge into one.
    let skipFirstRead = false;
    if (this.dmcDmaRunning && isController) {
      const dmcAddr = this.nes.papu.dmc.currentAddress;
      if ((dmcAddr & 0x1f) === (addr & 0x1f)) {
        skipFirstRead = true;
      }
    }

    // Halt cycle: the CPU's pending read happens, but its result is
    // discarded (the CPU will repeat it after the DMA).
    this._haltedRead(addr, skipFirstRead || (this.dmcDmaAbort && isController));

    if (this.dmcDmaAbort) {
      // The DMC DMA was aborted during its halt cycle.
      this.dmcDmaRunning = false;
      this.dmcDmaAbort = false;
      this.dmcNeedDummy = false;
      if (!this.oamDmaRunning) return;
    }

    let oamCount = 0; // number of OAM bus cycles performed (read+write)
    let oamAddr = 0; // low byte of the OAM DMA source address
    let oamValue = 0;

    while (this.dmcDmaRunning || this.oamDmaRunning) {
      // The upcoming cycle number is this.cycles + 1. "Get" cycles are the
      // even-numbered ones.
      const getCycle = ((this.cycles + 1) & 1) === 0;
      // Every DMA cycle also counts towards the DMC DMA's halt/dummy
      // requirements (a DMC DMA that starts during OAM DMA can use OAM
      // cycles as its halt and dummy cycles).
      let dmcReady =
        this.dmcDmaRunning && !this.dmaNeedHalt && !this.dmcNeedDummy;
      if (this.dmcDmaAbort) {
        this.dmcDmaRunning = false;
        this.dmcDmaAbort = false;
        this.dmcNeedDummy = false;
        this.dmaNeedHalt = false;
        dmcReady = false;
      } else if (this.dmaNeedHalt) {
        this.dmaNeedHalt = false;
      } else if (this.dmcNeedDummy) {
        this.dmcNeedDummy = false;
      }

      if (getCycle) {
        if (dmcReady) {
          const dmc = this.nes.papu.dmc;
          const value = this._dmaFetch(dmc.currentAddress, addr);
          this.dmcDmaRunning = false;
          this.dmcDmaAbort = false;
          dmc.dmaComplete(value);
        } else if (this.oamDmaRunning && (oamCount & 1) === 0) {
          oamValue = this._dmaFetch((this.oamDmaPage << 8) | oamAddr, addr);
          oamAddr = (oamAddr + 1) & 0xff;
          oamCount++;
        } else {
          // DMC DMA waiting for its halt/dummy cycle, no OAM work to do.
          this._haltedRead(addr, skipRepeatReads);
        }
      } else {
        if (this.oamDmaRunning && (oamCount & 1) === 1) {
          this._dmaWrite(0x2004, oamValue);
          oamCount++;
          if (oamCount === 512) {
            this.oamDmaRunning = false;
          }
        } else {
          // Alignment cycle.
          this._haltedRead(addr, skipRepeatReads);
        }
      }
    }
  }

  // ==========================================================================
  // Instruction execution
  // ==========================================================================

  // Executes one instruction (plus any interrupt that follows it, and any
  // DMA that interrupts it). Returns the number of CPU cycles that elapsed.
  emulate() {
    const startCycles = this.cycles;

    if (this.resetPending) {
      this.resetPending = false;
      this._interruptSequence(VECTOR_RESET);
      return this.cycles - startCycles;
    }

    const opcode = this._fetch();
    const ins = OP_INS[opcode];
    const mode = OP_MODE[opcode];

    // ------------------------------------------------------------------
    // Addressing: compute the effective address for memory operands,
    // performing the bus cycles that the real CPU performs to do so.
    // ------------------------------------------------------------------
    let addr = 0;
    // High byte of the base address before indexing, needed by the SHx
    // unofficial instructions.
    let baseHigh = 0;
    // Whether indexing crossed a page boundary.
    let crossed = false;

    if (OP_KIND[opcode] !== KIND_SPECIAL) {
      const write = OP_KIND[opcode] === KIND_WRITE;
      switch (mode) {
        case 5: {
          // Immediate: the operand is the byte after the opcode.
          addr = this.REG_PC;
          this.REG_PC = (this.REG_PC + 1) & 0xffff;
          break;
        }
        case 0: {
          // Zero page.
          addr = this._fetch();
          break;
        }
        case 6:
        case 7: {
          // Zero page,X / Zero page,Y. The CPU reads from the unindexed
          // address while it adds the index (dummy read), and the result
          // wraps within the zero page.
          const base = this._fetch();
          this.read(base);
          addr = (base + (mode === 6 ? this.REG_X : this.REG_Y)) & 0xff;
          break;
        }
        case 3: {
          // Absolute.
          const lo = this._fetch();
          addr = (this._fetch() << 8) | lo;
          break;
        }
        case 8:
        case 9: {
          // Absolute,X / Absolute,Y. The CPU first adds the index to the low
          // byte only and reads from that address. If no carry into the high
          // byte was needed, that read was correct (for read instructions);
          // otherwise it was a dummy read and the CPU reads again from the
          // fixed-up address.
          const lo = this._fetch();
          baseHigh = this._fetch();
          const base = (baseHigh << 8) | lo;
          addr = (base + (mode === 8 ? this.REG_X : this.REG_Y)) & 0xffff;
          crossed = (addr & 0xff00) !== (base & 0xff00);
          if (crossed || write) {
            this.read((base & 0xff00) | (addr & 0xff));
          }
          break;
        }
        case 10: {
          // (Indirect,X): pointer in zero page at (operand + X).
          let ptr = this._fetch();
          this.read(ptr); // dummy read while adding X
          ptr = (ptr + this.REG_X) & 0xff;
          const lo = this.read(ptr);
          addr = (this.read((ptr + 1) & 0xff) << 8) | lo;
          break;
        }
        case 11: {
          // (Indirect),Y: pointer in zero page, then add Y (with the same
          // page-crossing dummy read as Absolute,Y).
          const ptr = this._fetch();
          const lo = this.read(ptr);
          baseHigh = this.read((ptr + 1) & 0xff);
          const base = (baseHigh << 8) | lo;
          addr = (base + this.REG_Y) & 0xffff;
          crossed = (addr & 0xff00) !== (base & 0xff00);
          if (crossed || write) {
            this.read((base & 0xff00) | (addr & 0xff));
          }
          break;
        }
      }
    }

    // ------------------------------------------------------------------
    // Execute. The case labels are raw integers (matching the INS_*
    // constants) so V8 compiles the switch to a jump table.
    // ------------------------------------------------------------------
    let temp;
    let value;
    switch (ins) {
      case 0: {
        // ADC
        this._adc(this.read(addr));
        break;
      }
      case 1: {
        // AND
        this.REG_ACC &= this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 2: {
        // ASL
        if (mode === ADDR_ACC) {
          this.read(this.REG_PC);
          this.REG_ACC = this._asl(this.REG_ACC);
        } else {
          value = this.read(addr);
          this.write(addr, value); // dummy write of the original value
          this.write(addr, this._asl(value));
        }
        break;
      }
      case 3: {
        // BCC
        this._branch(this.F_CARRY === 0);
        break;
      }
      case 4: {
        // BCS
        this._branch(this.F_CARRY !== 0);
        break;
      }
      case 5: {
        // BEQ
        this._branch(this.F_ZERO === 0);
        break;
      }
      case 6: {
        // BIT
        value = this.read(addr);
        this.F_SIGN = (value >> 7) & 1;
        this.F_OVERFLOW = (value >> 6) & 1;
        this.F_ZERO = value & this.REG_ACC;
        break;
      }
      case 7: {
        // BMI
        this._branch(this.F_SIGN !== 0);
        break;
      }
      case 8: {
        // BNE
        this._branch(this.F_ZERO !== 0);
        break;
      }
      case 9: {
        // BPL
        this._branch(this.F_SIGN === 0);
        break;
      }
      case 10: {
        // BRK: a software interrupt. The byte after the opcode is read and
        // skipped ("padding byte"), then it behaves like an IRQ except that
        // the pushed status has the B flag set.
        this._fetch();
        this._interruptSequence(VECTOR_IRQ, true);
        break;
      }
      case 11: {
        // BVC
        this._branch(this.F_OVERFLOW === 0);
        break;
      }
      case 12: {
        // BVS
        this._branch(this.F_OVERFLOW !== 0);
        break;
      }
      case 13: {
        // CLC
        this.read(this.REG_PC);
        this.F_CARRY = 0;
        break;
      }
      case 14: {
        // CLD
        this.read(this.REG_PC);
        this.F_DECIMAL = 0;
        break;
      }
      case 15: {
        // CLI. The flag changes after this instruction's interrupt polling,
        // so a pending IRQ is serviced only after the *next* instruction.
        this.read(this.REG_PC);
        this.F_INTERRUPT = 0;
        break;
      }
      case 16: {
        // CLV
        this.read(this.REG_PC);
        this.F_OVERFLOW = 0;
        break;
      }
      case 17: {
        // CMP
        this._compare(this.REG_ACC, this.read(addr));
        break;
      }
      case 18: {
        // CPX
        this._compare(this.REG_X, this.read(addr));
        break;
      }
      case 19: {
        // CPY
        this._compare(this.REG_Y, this.read(addr));
        break;
      }
      case 20: {
        // DEC
        value = this.read(addr);
        this.write(addr, value);
        value = (value - 1) & 0xff;
        this.F_SIGN = value >> 7;
        this.F_ZERO = value;
        this.write(addr, value);
        break;
      }
      case 21: {
        // DEX
        this.read(this.REG_PC);
        this.REG_X = (this.REG_X - 1) & 0xff;
        this.F_SIGN = this.REG_X >> 7;
        this.F_ZERO = this.REG_X;
        break;
      }
      case 22: {
        // DEY
        this.read(this.REG_PC);
        this.REG_Y = (this.REG_Y - 1) & 0xff;
        this.F_SIGN = this.REG_Y >> 7;
        this.F_ZERO = this.REG_Y;
        break;
      }
      case 23: {
        // EOR
        this.REG_ACC ^= this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 24: {
        // INC
        value = this.read(addr);
        this.write(addr, value);
        value = (value + 1) & 0xff;
        this.F_SIGN = value >> 7;
        this.F_ZERO = value;
        this.write(addr, value);
        break;
      }
      case 25: {
        // INX
        this.read(this.REG_PC);
        this.REG_X = (this.REG_X + 1) & 0xff;
        this.F_SIGN = this.REG_X >> 7;
        this.F_ZERO = this.REG_X;
        break;
      }
      case 26: {
        // INY
        this.read(this.REG_PC);
        this.REG_Y = (this.REG_Y + 1) & 0xff;
        this.F_SIGN = this.REG_Y >> 7;
        this.F_ZERO = this.REG_Y;
        break;
      }
      case 27: {
        // JMP
        if (mode === ADDR_INDABS) {
          // JMP (indirect). The famous 6502 bug: the pointer's high byte is
          // read from the same page as its low byte, so JMP ($10FF) reads
          // $10FF and $1000.
          const lo = this._fetch();
          const hi = this._fetch();
          const ptr = (hi << 8) | lo;
          const pcl = this.read(ptr);
          const pch = this.read((ptr & 0xff00) | ((ptr + 1) & 0xff));
          this.REG_PC = (pch << 8) | pcl;
        } else {
          this.REG_PC = addr;
        }
        break;
      }
      case 28: {
        // JSR. Cycle order: fetch low byte of target, dummy read of the
        // stack, push return address (high, low), then fetch the high byte
        // of the target. The high byte fetch is the last bus operation, so
        // it's what's left on the data bus when the subroutine starts.
        const lo = this._fetch();
        this.read(0x100 | this.REG_SP);
        this.push(this.REG_PC >> 8);
        this.push(this.REG_PC & 0xff);
        const hi = this.read(this.REG_PC);
        this.REG_PC = (hi << 8) | lo;
        break;
      }
      case 29: {
        // LDA
        this.REG_ACC = this.F_ZERO = this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 30: {
        // LDX
        this.REG_X = this.F_ZERO = this.read(addr);
        this.F_SIGN = this.REG_X >> 7;
        break;
      }
      case 31: {
        // LDY
        this.REG_Y = this.F_ZERO = this.read(addr);
        this.F_SIGN = this.REG_Y >> 7;
        break;
      }
      case 32: {
        // LSR
        if (mode === ADDR_ACC) {
          this.read(this.REG_PC);
          this.REG_ACC = this._lsr(this.REG_ACC);
        } else {
          value = this.read(addr);
          this.write(addr, value);
          this.write(addr, this._lsr(value));
        }
        break;
      }
      case 33: {
        // NOP (implied)
        this.read(this.REG_PC);
        break;
      }
      case 34: {
        // ORA
        this.REG_ACC |= this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 35: {
        // PHA
        this.read(this.REG_PC);
        this.push(this.REG_ACC);
        break;
      }
      case 36: {
        // PHP. The pushed copy always has bits 4 (B) and 5 set.
        this.read(this.REG_PC);
        this.push(this.getStatus() | 0x30);
        break;
      }
      case 37: {
        // PLA
        this.read(this.REG_PC);
        this.read(0x100 | this.REG_SP); // dummy read while incrementing SP
        this.REG_ACC = this.F_ZERO = this.pull();
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 38: {
        // PLP. Like CLI/SEI, the new I flag only takes effect for interrupt
        // polling after this instruction.
        this.read(this.REG_PC);
        this.read(0x100 | this.REG_SP);
        this.setStatusFromStack(this.pull());
        break;
      }
      case 39: {
        // ROL
        if (mode === ADDR_ACC) {
          this.read(this.REG_PC);
          this.REG_ACC = this._rol(this.REG_ACC);
        } else {
          value = this.read(addr);
          this.write(addr, value);
          this.write(addr, this._rol(value));
        }
        break;
      }
      case 40: {
        // ROR
        if (mode === ADDR_ACC) {
          this.read(this.REG_PC);
          this.REG_ACC = this._ror(this.REG_ACC);
        } else {
          value = this.read(addr);
          this.write(addr, value);
          this.write(addr, this._ror(value));
        }
        break;
      }
      case 41: {
        // RTI. The status is restored before the last two cycles, so unlike
        // CLI/PLP, a newly cleared I flag takes effect immediately.
        this.read(this.REG_PC);
        this.read(0x100 | this.REG_SP);
        this.setStatusFromStack(this.pull());
        const pcl = this.pull();
        const pch = this.pull();
        this.REG_PC = (pch << 8) | pcl;
        break;
      }
      case 42: {
        // RTS
        this.read(this.REG_PC);
        this.read(0x100 | this.REG_SP);
        const pcl = this.pull();
        const pch = this.pull();
        this.REG_PC = (pch << 8) | pcl;
        this.read(this.REG_PC); // dummy read while incrementing PC
        this.REG_PC = (this.REG_PC + 1) & 0xffff;
        break;
      }
      case 43: {
        // SBC
        this._adc(this.read(addr) ^ 0xff);
        break;
      }
      case 44: {
        // SEC
        this.read(this.REG_PC);
        this.F_CARRY = 1;
        break;
      }
      case 45: {
        // SED
        this.read(this.REG_PC);
        this.F_DECIMAL = 1;
        break;
      }
      case 46: {
        // SEI
        this.read(this.REG_PC);
        this.F_INTERRUPT = 1;
        break;
      }
      case 47: {
        // STA
        this.write(addr, this.REG_ACC);
        break;
      }
      case 48: {
        // STX
        this.write(addr, this.REG_X);
        break;
      }
      case 49: {
        // STY
        this.write(addr, this.REG_Y);
        break;
      }
      case 50: {
        // TAX
        this.read(this.REG_PC);
        this.REG_X = this.F_ZERO = this.REG_ACC;
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 51: {
        // TAY
        this.read(this.REG_PC);
        this.REG_Y = this.F_ZERO = this.REG_ACC;
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 52: {
        // TSX
        this.read(this.REG_PC);
        this.REG_X = this.F_ZERO = this.REG_SP;
        this.F_SIGN = this.REG_SP >> 7;
        break;
      }
      case 53: {
        // TXA
        this.read(this.REG_PC);
        this.REG_ACC = this.F_ZERO = this.REG_X;
        this.F_SIGN = this.REG_X >> 7;
        break;
      }
      case 54: {
        // TXS (doesn't affect flags)
        this.read(this.REG_PC);
        this.REG_SP = this.REG_X;
        break;
      }
      case 55: {
        // TYA
        this.read(this.REG_PC);
        this.REG_ACC = this.F_ZERO = this.REG_Y;
        this.F_SIGN = this.REG_Y >> 7;
        break;
      }

      // ---------------- Unofficial opcodes ----------------
      case 56: {
        // ALR (ASR): AND immediate, then LSR A.
        this.REG_ACC = this._lsr(this.REG_ACC & this.read(addr));
        break;
      }
      case 57: {
        // ANC: AND immediate, then copy bit 7 of the result into carry.
        this.REG_ACC &= this.read(addr);
        this.F_SIGN = this.F_CARRY = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 58: {
        // ARR: AND immediate, then ROR A, with C and V set from bits 6 and
        // 5 of the result in a peculiar way (a side effect of the decimal
        // mode adder hardware).
        temp = this.REG_ACC & this.read(addr);
        this.REG_ACC = ((temp >> 1) | (this.F_CARRY << 7)) & 0xff;
        this.F_ZERO = this.REG_ACC;
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_CARRY = (this.REG_ACC >> 6) & 1;
        this.F_OVERFLOW = ((this.REG_ACC >> 6) ^ (this.REG_ACC >> 5)) & 1;
        break;
      }
      case 59: {
        // AXS (SBX): X = (A & X) - immediate, setting flags like CMP.
        temp = (this.REG_ACC & this.REG_X) - this.read(addr);
        this.F_CARRY = temp >= 0 ? 1 : 0;
        this.REG_X = this.F_ZERO = temp & 0xff;
        this.F_SIGN = this.REG_X >> 7;
        break;
      }
      case 60: {
        // LAX: load A and X.
        this.REG_ACC = this.REG_X = this.F_ZERO = this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 61: {
        // SAX: store A & X.
        this.write(addr, this.REG_ACC & this.REG_X);
        break;
      }
      case 62: {
        // DCP: DEC memory, then CMP with A.
        value = this.read(addr);
        this.write(addr, value);
        value = (value - 1) & 0xff;
        this.write(addr, value);
        this._compare(this.REG_ACC, value);
        break;
      }
      case 63: {
        // ISC: INC memory, then SBC.
        value = this.read(addr);
        this.write(addr, value);
        value = (value + 1) & 0xff;
        this.write(addr, value);
        this._adc(value ^ 0xff);
        break;
      }
      case 64: {
        // RLA: ROL memory, then AND with A.
        value = this.read(addr);
        this.write(addr, value);
        value = this._rol(value);
        this.write(addr, value);
        this.REG_ACC &= value;
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 65: {
        // RRA: ROR memory, then ADC.
        value = this.read(addr);
        this.write(addr, value);
        value = this._ror(value);
        this.write(addr, value);
        this._adc(value);
        break;
      }
      case 66: {
        // SLO: ASL memory, then ORA with A.
        value = this.read(addr);
        this.write(addr, value);
        value = this._asl(value);
        this.write(addr, value);
        this.REG_ACC |= value;
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 67: {
        // SRE: LSR memory, then EOR with A.
        value = this.read(addr);
        this.write(addr, value);
        value = this._lsr(value);
        this.write(addr, value);
        this.REG_ACC ^= value;
        this.F_SIGN = this.REG_ACC >> 7;
        this.F_ZERO = this.REG_ACC;
        break;
      }
      case 68: {
        // SKB: 2-byte NOP that reads its immediate operand.
        this.read(addr);
        break;
      }
      case 69: {
        // IGN: NOP that reads from memory using its addressing mode.
        this.read(addr);
        break;
      }
      case 71: {
        // SHA (AHX): store A & X & (H+1).
        this._shx(addr, this.REG_ACC & this.REG_X, baseHigh, crossed);
        break;
      }
      case 72: {
        // SHS (TAS): SP = A & X, then store SP & (H+1).
        this.REG_SP = this.REG_ACC & this.REG_X;
        this._shx(addr, this.REG_SP, baseHigh, crossed);
        break;
      }
      case 73: {
        // SHY: store Y & (H+1).
        this._shx(addr, this.REG_Y, baseHigh, crossed);
        break;
      }
      case 74: {
        // SHX: store X & (H+1).
        this._shx(addr, this.REG_X, baseHigh, crossed);
        break;
      }
      case 75: {
        // LAE (LAS): A = X = SP = memory & SP.
        temp = this.read(addr) & this.REG_SP;
        this.REG_ACC = this.REG_X = this.REG_SP = this.F_ZERO = temp;
        this.F_SIGN = temp >> 7;
        break;
      }
      case 76: {
        // ANE (XAA): A = (A | magic) & X & immediate. The "magic" constant
        // varies between chips; $FF is the most common value.
        this.REG_ACC = this.F_ZERO =
          (this.REG_ACC | 0xff) & this.REG_X & this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      case 77: {
        // LXA: A = X = (A | magic) & immediate.
        this.REG_ACC =
          this.REG_X =
          this.F_ZERO =
            (this.REG_ACC | 0xff) & this.read(addr);
        this.F_SIGN = this.REG_ACC >> 7;
        break;
      }
      default: {
        // KIL/JAM opcodes lock up a real 6502.
        throw new Error(
          `Game crashed, invalid opcode at address $${((this.REG_PC - 1) & 0xffff).toString(16)}`,
        );
      }
    }

    // Service an interrupt if one was pending as of the second-to-last
    // cycle of the instruction.
    if (this.prevNeedNmi || this.prevRunIrq) {
      this._interruptSequence(VECTOR_IRQ, false);
    }

    return this.cycles - startCycles;
  }

  // The 7-cycle sequence shared by BRK, IRQ, NMI and reset.
  //
  // For hardware interrupts (IRQ/NMI) the CPU first performs two dummy
  // reads of the next opcode (it fetches it, then throws it away). BRK has
  // already done its two reads (opcode and padding byte).
  //
  // "Interrupt hijacking": the vector address is only chosen after the
  // return address has been pushed. If an NMI is detected by then, the
  // CPU jumps to the NMI handler even if this sequence started as a BRK
  // or IRQ (for BRK, the pushed status still has the B flag set, so the
  // handler can tell). See https://www.nesdev.org/wiki/CPU_interrupts
  _interruptSequence(vector, isBrk) {
    const isReset = vector === VECTOR_RESET;
    if (!isBrk) {
      this.read(this.REG_PC);
      this.read(this.REG_PC);
    }
    if (isReset) {
      // Reset performs the pushes as reads (the R/W line is held high), so
      // the stack pointer moves but nothing is written.
      this.read(0x100 | this.REG_SP);
      this.REG_SP = (this.REG_SP - 1) & 0xff;
      this.read(0x100 | this.REG_SP);
      this.REG_SP = (this.REG_SP - 1) & 0xff;
      this.read(0x100 | this.REG_SP);
      this.REG_SP = (this.REG_SP - 1) & 0xff;
    } else {
      this.push(this.REG_PC >> 8);
      this.push(this.REG_PC & 0xff);
      if (this.needNmi) {
        this.needNmi = false;
        this.forcedNmi = false;
        vector = VECTOR_NMI;
      } else if (!isBrk) {
        // An IRQ releases the (one-shot) cartridge IRQ request.
        this.irqFlags &= ~IRQ_SOURCE_MAPPER;
      }
      this.push((this.getStatus() & 0xcf) | (isBrk ? 0x30 : 0x20));
    }
    this.F_INTERRUPT = 1;
    const lo = this.read(vector);
    const hi = this.read(vector + 1);
    this.REG_PC = (hi << 8) | lo;
    // The first instruction of the handler always runs before another
    // interrupt can be taken.
    this.prevNeedNmi = false;
    this.prevRunIrq = false;
  }

  // Relative branch. Taken branches take an extra cycle (dummy read of the
  // next opcode), and another if the target is on a different page (dummy
  // read from the address with the un-fixed-up high byte).
  _branch(condition) {
    const offset = this._fetch();
    if (!condition) return;
    // Quirk: a taken branch that doesn't cross a page doesn't poll for
    // interrupts on its last cycle, so an IRQ that arrives during the
    // branch is delayed by one instruction.
    // See https://www.nesdev.org/wiki/CPU_interrupts#Branch_instructions_and_interrupts
    if (this.runIrq && !this.prevRunIrq) {
      this.runIrq = false;
    }
    this.read(this.REG_PC);
    const target =
      (this.REG_PC + (offset < 0x80 ? offset : offset - 256)) & 0xffff;
    if ((target & 0xff00) !== (this.REG_PC & 0xff00)) {
      this.read((this.REG_PC & 0xff00) | (target & 0xff));
    }
    this.REG_PC = target;
  }

  // SHA/SHX/SHY/SHS: store `value & (H+1)` where H is the high byte of the
  // base address. These are "unstable" opcodes: the H+1 term comes from
  // the address bus being driven during the previous cycle. If indexing
  // crossed a page, the high byte of the write address is also replaced by
  // the stored value. And if a DMA halted the CPU just before the write,
  // the H+1 term is lost and the plain register value is stored.
  // See https://www.nesdev.org/wiki/Programming_with_unofficial_opcodes
  _shx(addr, reg, baseHigh, crossed) {
    let value;
    if (this.lastDmaEndCycle === this.cycles - 1) {
      value = reg;
    } else {
      value = reg & ((baseHigh + 1) & 0xff);
    }
    if (crossed) {
      addr = (value << 8) | (addr & 0xff);
    }
    this.write(addr, value);
  }

  // ---------------- ALU helpers ----------------

  _adc(value) {
    // The NES's 2A03 has no decimal mode, so ADC/SBC are always binary.
    const result = this.REG_ACC + value + this.F_CARRY;
    this.F_OVERFLOW =
      ((this.REG_ACC ^ result) & (value ^ result) & 0x80) !== 0 ? 1 : 0;
    this.F_CARRY = result > 0xff ? 1 : 0;
    this.REG_ACC = this.F_ZERO = result & 0xff;
    this.F_SIGN = this.REG_ACC >> 7;
  }

  _compare(reg, value) {
    const result = reg - value;
    this.F_CARRY = result >= 0 ? 1 : 0;
    this.F_ZERO = result & 0xff;
    this.F_SIGN = (result >> 7) & 1;
  }

  _asl(value) {
    this.F_CARRY = value >> 7;
    value = (value << 1) & 0xff;
    this.F_SIGN = value >> 7;
    this.F_ZERO = value;
    return value;
  }

  _lsr(value) {
    this.F_CARRY = value & 1;
    value >>= 1;
    this.F_SIGN = 0;
    this.F_ZERO = value;
    return value;
  }

  _rol(value) {
    const result = ((value << 1) | this.F_CARRY) & 0xff;
    this.F_CARRY = value >> 7;
    this.F_SIGN = result >> 7;
    this.F_ZERO = result;
    return result;
  }

  _ror(value) {
    const result = (value >> 1) | (this.F_CARRY << 7);
    this.F_CARRY = value & 1;
    this.F_SIGN = result >> 7;
    this.F_ZERO = result;
    return result;
  }

  // ---------------- Status register ----------------

  getStatus() {
    return (
      this.F_CARRY |
      ((this.F_ZERO === 0 ? 1 : 0) << 1) |
      (this.F_INTERRUPT << 2) |
      (this.F_DECIMAL << 3) |
      (this.F_BRK << 4) |
      (this.F_NOTUSED << 5) |
      (this.F_OVERFLOW << 6) |
      (this.F_SIGN << 7)
    );
  }

  setStatus(st) {
    this.F_CARRY = st & 1;
    this.F_ZERO = ((st >> 1) & 1) === 1 ? 0 : 1;
    this.F_INTERRUPT = (st >> 2) & 1;
    this.F_DECIMAL = (st >> 3) & 1;
    this.F_BRK = (st >> 4) & 1;
    this.F_NOTUSED = (st >> 5) & 1;
    this.F_OVERFLOW = (st >> 6) & 1;
    this.F_SIGN = (st >> 7) & 1;
  }

  // Set status flags from a value pulled off the stack (PLP, RTI).
  // Bits 4 (B) and 5 (unused) don't exist as physical flags in the
  // 6502 and are ignored when pulling status from the stack.
  // See https://www.nesdev.org/wiki/Status_flags#The_B_flag
  setStatusFromStack(st) {
    this.F_CARRY = st & 1;
    this.F_ZERO = ((st >> 1) & 1) === 1 ? 0 : 1;
    this.F_INTERRUPT = (st >> 2) & 1;
    this.F_DECIMAL = (st >> 3) & 1;
    this.F_OVERFLOW = (st >> 6) & 1;
    this.F_SIGN = (st >> 7) & 1;
  }

  // Swap in Game Genie handling when patches are active. Called by
  // GameGenie when patches or enabled state change.
  _updateCartridgeLoader() {
    this._gameGenieActive =
      this.nes.gameGenie.enabled && this.nes.gameGenie.patches.length > 0;
    this._updatePrgReadPath();
  }

  // Use the fast path for PRG ROM reads unless the mapper handles reads
  // itself or Game Genie codes need to be applied.
  _updatePrgReadPath() {
    const mmap = this.nes.mmap;
    this.directPrgReads =
      !this._gameGenieActive && !!mmap && mmap.readsPrgFromCpuMem();
  }

  static JSON_PROPERTIES = [
    "mem",
    "cycles",
    "dataBus",
    "irqFlags",
    "resetPending",
    "nmiLine",
    "needNmi",
    "prevNeedNmi",
    "runIrq",
    "prevRunIrq",
    "dmaNeedHalt",
    "dmcDmaRunning",
    "dmcNeedDummy",
    "dmcDmaAbort",
    "oamDmaRunning",
    "oamDmaPage",
    "lastDmaEndCycle",
    "abortedDmaCycle",
    "forcedNmi",
    "REG_ACC",
    "REG_X",
    "REG_Y",
    "REG_SP",
    "REG_PC",
    "F_CARRY",
    "F_DECIMAL",
    "F_INTERRUPT",
    "F_OVERFLOW",
    "F_SIGN",
    "F_ZERO",
    "F_NOTUSED",
    "F_BRK",
  ];

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }
}

__exp.default = CPU;

__exp.IRQ_SOURCE_MAPPER = IRQ_SOURCE_MAPPER;
__exp.IRQ_SOURCE_FRAME = IRQ_SOURCE_FRAME;
__exp.IRQ_SOURCE_DMC = IRQ_SOURCE_DMC;
return __exp;
}
function __m_gamegenie_js() {
const __exp = {};
const LETTER_VALUES = "APZLGITYEOXUKSVN";

function toDigit(letter) {
  return LETTER_VALUES.indexOf(letter);
}

function toLetter(digit) {
  return LETTER_VALUES[digit];
}

function toHex(n, width) {
  const s = n.toString(16);
  return "0000".substring(0, width - s.length) + s;
}

class GameGenie {
  constructor() {
    this.patches = [];
    this.enabled = true;
    // Callback invoked when patches or enabled state change, so the CPU
    // can swap its loadFromCartridge function pointer. Set by NES after
    // construction.
    this.onChange = null;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.onChange) this.onChange();
  }

  addCode(code) {
    const patch = this.decode(code);
    if (!patch) {
      throw new Error(`Invalid Game Genie code: ${code}`);
    }
    this.patches.push(patch);
    if (this.onChange) this.onChange();
  }

  addPatch(addr, value, key) {
    this.patches.push({ addr, value, key });
    if (this.onChange) this.onChange();
  }

  removeAllCodes() {
    this.patches = [];
    if (this.onChange) this.onChange();
  }

  // Apply Game Genie patches to a value being read from the given address.
  // Game Genie works by intercepting ROM reads and substituting values.
  // The address is masked to 15 bits because Game Genie ignores the
  // highest bit (ROM is mirrored in $8000-$FFFF).
  applyCodes(addr, value) {
    if (!this.enabled) return value;

    for (let i = 0; i < this.patches.length; ++i) {
      if (this.patches[i].addr === (addr & 0x7fff)) {
        if (
          this.patches[i].key === undefined ||
          this.patches[i].key === value
        ) {
          return this.patches[i].value;
        }
      }
    }
    return value;
  }

  decode(code) {
    if (code.includes(":")) return this.decodeHex(code);

    const digits = code.toUpperCase().split("").map(toDigit);

    let value =
      ((digits[0] & 8) << 4) + ((digits[1] & 7) << 4) + (digits[0] & 7);
    const addr =
      ((digits[3] & 7) << 12) +
      ((digits[4] & 8) << 8) +
      ((digits[5] & 7) << 8) +
      ((digits[1] & 8) << 4) +
      ((digits[2] & 7) << 4) +
      (digits[3] & 8) +
      (digits[4] & 7);
    let key;

    if (digits.length === 8) {
      value += digits[7] & 8;
      key =
        ((digits[6] & 8) << 4) +
        ((digits[7] & 7) << 4) +
        (digits[5] & 8) +
        (digits[6] & 7);
    } else {
      value += digits[5] & 8;
    }

    const wantskey = !!(digits[2] >> 3);

    return { value, addr, wantskey, key };
  }

  encodeHex(addr, value, key, wantskey) {
    let s = toHex(addr, 4) + ":" + toHex(value, 2);

    if (key !== undefined || wantskey) {
      s += "?";
    }

    if (key !== undefined) {
      s += toHex(key, 2);
    }

    return s;
  }

  decodeHex(s) {
    const match = s.match(/([0-9a-fA-F]+):([0-9a-fA-F]+)(\?[0-9a-fA-F]*)?/);
    if (!match) return null;

    const addr = parseInt(match[1], 16);
    const value = parseInt(match[2], 16);
    const wantskey = match[3] !== undefined;
    const key =
      match[3] !== undefined && match[3].length > 1
        ? parseInt(match[3].substring(1), 16)
        : undefined;

    return { value, addr, wantskey, key };
  }

  encode(addr, value, key, wantskey) {
    const digits = Array(6);

    digits[0] = (value & 7) + ((value >> 4) & 8);
    digits[1] = ((value >> 4) & 7) + ((addr >> 4) & 8);
    digits[2] = (addr >> 4) & 7;
    digits[3] = (addr >> 12) + (addr & 8);
    digits[4] = (addr & 7) + ((addr >> 8) & 8);
    digits[5] = (addr >> 8) & 7;

    if (key === undefined) {
      digits[5] += value & 8;
      if (wantskey) digits[2] += 8;
    } else {
      digits[2] += 8;
      digits[5] += key & 8;
      digits[6] = (key & 7) + ((key >> 4) & 8);
      digits[7] = ((key >> 4) & 7) + (value & 8);
    }

    const code = digits.map(toLetter).join("");

    return code;
  }
}

__exp.default = GameGenie;


return __exp;
}
function __m_index_js() {
const __exp = {};
const Browser = __req("browser/index.js").default;
const Controller = __req("controller.js").default;
const GameGenie = __req("gamegenie.js").default;
const NES = __req("nes.js").default;



__exp.Browser = Browser;
__exp.Controller = Controller;
__exp.GameGenie = GameGenie;
__exp.NES = NES;
return __exp;
}
function __m_mappers_index_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;
const Mapper1 = __req("mappers/mapper1.js").default;
const Mapper2 = __req("mappers/mapper2.js").default;
const Mapper3 = __req("mappers/mapper3.js").default;
const Mapper4 = __req("mappers/mapper4.js").default;
const Mapper5 = __req("mappers/mapper5.js").default;
const Mapper7 = __req("mappers/mapper7.js").default;
const Mapper9 = __req("mappers/mapper9.js").default;
const Mapper11 = __req("mappers/mapper11.js").default;
const Mapper34 = __req("mappers/mapper34.js").default;
const Mapper38 = __req("mappers/mapper38.js").default;
const Mapper66 = __req("mappers/mapper66.js").default;
const Mapper71 = __req("mappers/mapper71.js").default;
const Mapper79 = __req("mappers/mapper79.js").default;
const Mapper94 = __req("mappers/mapper94.js").default;
const Mapper118 = __req("mappers/mapper118.js").default;
const Mapper119 = __req("mappers/mapper119.js").default;
const Mapper140 = __req("mappers/mapper140.js").default;
const Mapper180 = __req("mappers/mapper180.js").default;
const Mapper240 = __req("mappers/mapper240.js").default;
const Mapper241 = __req("mappers/mapper241.js").default;

__exp.default = {
  0: Mapper0,
  1: Mapper1,
  2: Mapper2,
  3: Mapper3,
  4: Mapper4,
  5: Mapper5,
  7: Mapper7,
  9: Mapper9,
  11: Mapper11,
  34: Mapper34,
  38: Mapper38,
  66: Mapper66,
  71: Mapper71,
  79: Mapper79,
  94: Mapper94,
  118: Mapper118,
  119: Mapper119,
  140: Mapper140,
  180: Mapper180,
  240: Mapper240,
  241: Mapper241,
};


return __exp;
}
function __m_mappers_mapper0_js() {
const __exp = {};
const { copyArrayElements } = __req("utils.js");

// NROM - the simplest NES cartridge board (NES-NROM-128/NROM-256)
// Used by games like Super Mario Bros., Donkey Kong, Excitebike.
// No bank switching at all: 16 or 32 KB PRG-ROM, 8 KB CHR-ROM, fixed mirroring.
// See https://www.nesdev.org/wiki/NROM
class Mapper0 {
  static mapperName = "NROM";

  constructor(nes) {
    this.nes = nes;

    this.joy1StrobeState = 0;
    this.joy2StrobeState = 0;
    this.joypadLastWrite = 0;
    // The effective OUT0 value visible to the controller shift register.
    // On the 2A03, OUT0-OUT2 are output latches that only update on APU
    // clock edges (every 2 CPU cycles). Writes to $4016 on "put" cycles
    // update the internal register but NOT the output latch until the next
    // APU clock (see the $4016 case in regWrite). This distinction matters for RMW
    // instructions like DEC $4016 that produce a 1-cycle strobe pulse:
    // the dummy write and final write land on consecutive CPU cycles, and
    // whether the pulse is visible depends on APU clock alignment.
    // See https://www.nesdev.org/wiki/CPU_pin_out_and_signal_timing
    this.joypadOutputBit0 = 0;
    // CPU cycle at which the last $4016 write occurred (-2 = never)
    this.joypadLastWriteCycle = -2;

    this.zapperFired = false;
    this.zapperX = null;
    this.zapperY = null;

    // Set to true by mappers that need per-tile BG override (e.g. MMC5
    // ExRAM mode 1). When true, the PPU calls getBgTileData() for each
    // background tile during rendering.
    this.bgTileOverride = false;

    // The PPU dot (257-339) on which clockIrqCounter() is called each
    // rendered line.
    // MMC3-style counters are clocked by PPU A12 rising when the sprite
    // patterns are fetched, around dot 260.
    this.irqClockDot = 260;
  }

  write(address, value) {
    if (address < 0x2000) {
      // Mirroring of RAM:
      this.nes.cpu.mem[address & 0x7ff] = value;
    } else if (address >= 0x8000) {
      // ROM is not writable. Mappers may override this to handle bank switching.
    } else if (address >= 0x6000) {
      // Cartridge SRAM (0x6000-0x7FFF)
      this.nes.cpu.mem[address] = value;
      this.nes.opts.onBatteryRamWrite(address, value);
    } else if (address > 0x4017) {
      // Cartridge expansion area (0x4018-0x5FFF)
      this.nes.cpu.mem[address] = value;
    } else if (address > 0x2007 && address < 0x4000) {
      this.regWrite(0x2000 + (address & 0x7), value);
    } else {
      this.regWrite(address, value);
    }
  }

  writelow(address, value) {
    if (address < 0x2000) {
      // Mirroring of RAM:
      this.nes.cpu.mem[address & 0x7ff] = value;
    } else if (address >= 0x8000) {
      // ROM is not writable
    } else if (address > 0x4017) {
      // Cartridge RAM/expansion area (0x4018-0x7FFF)
      this.nes.cpu.mem[address] = value;
    } else if (address > 0x2007 && address < 0x4000) {
      this.regWrite(0x2000 + (address & 0x7), value);
    } else {
      this.regWrite(address, value);
    }
  }

  // True if this mapper's PRG ROM ($8000-$FFFF) reads simply return
  // cpu.mem[address], i.e. it doesn't override load(). The CPU then reads
  // PRG ROM directly, without calling load().
  readsPrgFromCpuMem() {
    return this.load === Mapper0.prototype.load;
  }

  load(address) {
    // Wrap around:
    address &= 0xffff;

    // Check address range:
    if (address > 0x4017) {
      if (address < 0x6000) {
        // Open bus: $4018-$5FFF (unmapped expansion area)
        return this.nes.cpu.dataBus;
      }
      // Cartridge RAM ($6000-$7FFF) and ROM ($8000-$FFFF):
      return this.nes.cpu.mem[address];
    } else if (address >= 0x2000) {
      // I/O Ports.
      return this.regLoad(address);
    } else {
      // RAM (mirrored)
      return this.nes.cpu.mem[address & 0x7ff];
    }
  }

  regLoad(address) {
    switch (
      address >> 12 // use fourth nibble (0xF000)
    ) {
      case 0:
        break;

      case 1:
        break;

      case 2:
      // Fall through to case 3
      case 3:
        // PPU Registers
        switch (address & 0x7) {
          case 0x0:
            // 0x2000: PPU Control Register 1 (write-only, returns open bus)
            return this.nes.ppu.openBusLatch;

          case 0x1:
            // 0x2001: PPU Control Register 2 (write-only, returns open bus)
            return this.nes.ppu.openBusLatch;

          case 0x2:
            // 0x2002: PPU Status Register (bits 7-5 from status, 4-0 from open bus)
            return this.nes.ppu.readStatusRegister();

          case 0x3:
            // 0x2003: OAM Address (write-only, returns open bus)
            return this.nes.ppu.openBusLatch;

          case 0x4:
            // 0x2004: Sprite Memory read
            return this.nes.ppu.sramLoad();

          case 0x5:
            // 0x2005: Scroll (write-only, returns open bus)
            return this.nes.ppu.openBusLatch;

          case 0x6:
            // 0x2006: VRAM Address (write-only, returns open bus)
            return this.nes.ppu.openBusLatch;

          case 0x7:
            // 0x2007: VRAM read
            return this.nes.ppu.vramLoad();
        }
        break;
      case 4:
        // Sound+Joypad registers
        switch (address - 0x4015) {
          case 0:
            // 0x4015:
            // Sound channel enable, DMC Status
            return this.nes.papu.readReg(address);

          case 1:
            // 0x4016:
            // Joystick 1 + Strobe
            // Bits 0-4 from controller, bits 5-7 are open bus (data bus)
            // See https://www.nesdev.org/wiki/Open_bus_behavior
            return (this.joy1Read() & 0x1f) | (this.nes.cpu.dataBus & 0xe0);

          case 2: {
            // 0x4017:
            // Joystick 2 + Strobe
            // https://wiki.nesdev.com/w/index.php/Zapper
            // Bits 0-4 from controller/zapper, bits 5-7 are open bus (data bus)
            // Zapper bits (3=light sensor, 4=trigger) are only driven when the
            // zapper is connected (zapperX/Y non-null). With no zapper, these
            // bits are 0 (standard controller doesn't drive them).
            let w = 0;

            if (this.zapperX !== null && this.zapperY !== null) {
              // Zapper connected: bit 3 = light not detected
              if (!this.nes.ppu.isPixelWhite(this.zapperX, this.zapperY)) {
                w = 0x1 << 3;
              }
            }

            if (this.zapperFired) {
              w |= 0x1 << 4;
            }
            return (
              ((this.joy2Read() | w) & 0x1f) | (this.nes.cpu.dataBus & 0xe0)
            );
          }
        }
        break;
    }
    // Write-only registers (APU $4000-$4014, etc.) are open bus.
    return this.nes.cpu.dataBus;
  }

  regWrite(address, value) {
    // All PPU register writes update the open bus latch
    if (address >= 0x2000 && address <= 0x3fff) {
      this.nes.ppu.openBusLatch = value;
      this.nes.ppu.openBusDecayFrames = 36; // ~600ms at 60fps
    }

    switch (address) {
      case 0x2000:
        // PPU Control register 1
        this.nes.cpu.mem[address] = value;
        this.nes.ppu.updateControlReg1(value);
        break;

      case 0x2001:
        // PPU Control register 2
        this.nes.cpu.mem[address] = value;
        this.nes.ppu.updateControlReg2(value);
        break;

      case 0x2003:
        // Set Sprite RAM address:
        this.nes.ppu.writeSRAMAddress(value);
        break;

      case 0x2004:
        // Write to Sprite RAM:
        this.nes.ppu.sramWrite(value);
        break;

      case 0x2005:
        // Screen Scroll offsets:
        this.nes.ppu.scrollWrite(value);
        break;

      case 0x2006:
        // Set VRAM address:
        this.nes.ppu.writeVRAMAddress(value);
        break;

      case 0x2007:
        // Write to VRAM:
        this.nes.ppu.vramWrite(value);
        break;

      case 0x4014:
        // Sprite Memory DMA Access
        // The CPU's DMA unit copies the page into OAM via $2004.
        this.nes.cpu.startOamDma(value);
        break;

      case 0x4015:
        // Sound Channel Switch, DMC Status
        this.nes.papu.writeReg(address, value);
        break;

      case 0x4016: {
        // Joystick 1 + Strobe
        // Bit 0 drives the 2A03's OUT0 pin, which strobes the controllers.
        // The output pins are latched from the internal register on APU
        // clock edges (every 2 CPU cycles): a write on a "get" cycle reaches
        // OUT0 at the get->put transition at the end of that cycle, while a
        // write on a "put" cycle waits for the next one (and can be
        // overwritten before then). This matters for RMW instructions like
        // DEC $4016, whose dummy write and real write land on consecutive
        // cycles: only one of them reaches OUT0. The AccuracyCoin
        // "Controller Strobing" test verifies this behavior.
        // See https://www.nesdev.org/wiki/CPU_pin_out_and_signal_timing
        let cycle = this.nes.cpu.cycles;

        // If previous write(s) haven't been applied to the output yet
        // (because they landed on put cycles), apply them now if an APU
        // clock edge has passed since then.
        if (cycle - this.joypadLastWriteCycle > 1) {
          let prevBit = this.joypadLastWrite & 1;
          if (prevBit !== this.joypadOutputBit0) {
            if (this.joypadOutputBit0 === 1 && prevBit === 0) {
              this.joy1StrobeState = 0;
              this.joy2StrobeState = 0;
            }
            this.joypadOutputBit0 = prevBit;
          }
        }

        this.joypadLastWrite = value;
        this.joypadLastWriteCycle = cycle;

        if (!this.nes.papu._isPutCycle()) {
          let newBit = value & 1;
          if (this.joypadOutputBit0 === 1 && newBit === 0) {
            this.joy1StrobeState = 0;
            this.joy2StrobeState = 0;
          }
          this.joypadOutputBit0 = newBit;
        }
        break;
      }

      case 0x4017:
        // Sound channel frame sequencer:
        this.nes.papu.writeReg(address, value);
        break;

      default:
        // Sound registers
        // console.log("write to sound reg");
        if (address >= 0x4000 && address <= 0x4017) {
          this.nes.papu.writeReg(address, value);
        }
    }
  }

  // Sync any pending $4016 output that was deferred from odd-cycle writes.
  // Called before reads from $4016/$4017, since reads happen on a later
  // cycle and the APU clock will have ticked by then.
  _syncJoypadOutput() {
    let newBit = this.joypadLastWrite & 1;
    if (newBit !== this.joypadOutputBit0) {
      if (this.joypadOutputBit0 === 1 && newBit === 0) {
        this.joy1StrobeState = 0;
        this.joy2StrobeState = 0;
      }
      this.joypadOutputBit0 = newBit;
    }
  }

  joy1Read() {
    // Sync deferred output before checking strobe state
    this._syncJoypadOutput();

    // While strobe is active ($4016 bit 0 = 1), the shift register is
    // continuously reloaded, so reads always return button A's state.
    // See https://www.nesdev.org/wiki/Standard_controller
    if (this.joypadOutputBit0) {
      return this.nes.controllers[1].state[0];
    }

    let ret;
    if (this.joy1StrobeState < 8) {
      ret = this.nes.controllers[1].state[this.joy1StrobeState];
    } else {
      // After 8 reads, the shift register is empty and the serial data
      // line floats high, returning 1 on a standard NES controller.
      ret = 1;
    }

    // The shift register fills with 1s as it's read, so once all 8 buttons
    // have been read, every further read returns 1 until the next strobe.
    if (this.joy1StrobeState < 8) {
      this.joy1StrobeState++;
    }

    return ret;
  }

  joy2Read() {
    // Sync deferred output before checking strobe state
    this._syncJoypadOutput();

    // While strobe is active, always return button A's state.
    if (this.joypadOutputBit0) {
      return this.nes.controllers[2].state[0];
    }

    let ret;
    if (this.joy2StrobeState < 8) {
      ret = this.nes.controllers[2].state[this.joy2StrobeState];
    } else {
      // After 8 reads, the shift register is empty → returns 1.
      ret = 1;
    }

    // The shift register fills with 1s as it's read, so once all 8 buttons
    // have been read, every further read returns 1 until the next strobe.
    if (this.joy2StrobeState < 8) {
      this.joy2StrobeState++;
    }

    return ret;
  }

  loadROM() {
    if (!this.nes.rom.valid || this.nes.rom.romCount < 1) {
      throw new Error("NoMapper: Invalid ROM! Unable to load.");
    }

    // Load ROM into memory:
    this.loadPRGROM();

    // Load CHR-ROM:
    this.loadCHRROM();

    // Load Battery RAM (if present):
    this.loadBatteryRam();

    // Reset IRQ:
    //nes.getCpu().doResetInterrupt();
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  loadPRGROM() {
    if (this.nes.rom.romCount > 1) {
      // Load the two first banks into memory.
      this.loadRomBank(0, 0x8000);
      this.loadRomBank(1, 0xc000);
    } else {
      // Load the one bank into both memory locations:
      this.loadRomBank(0, 0x8000);
      this.loadRomBank(0, 0xc000);
    }
  }

  loadCHRROM() {
    // console.log("Loading CHR ROM..");
    if (this.nes.rom.vromCount > 0) {
      if (this.nes.rom.vromCount === 1) {
        this.loadVromBank(0, 0x0000);
        this.loadVromBank(0, 0x1000);
      } else {
        this.loadVromBank(0, 0x0000);
        this.loadVromBank(1, 0x1000);
      }
    } else {
      //System.out.println("There aren't any CHR-ROM banks..");
    }
  }

  loadBatteryRam() {
    if (this.nes.rom.batteryRam) {
      let ram = this.nes.rom.batteryRam;
      if (ram !== null && ram.length === 0x2000) {
        // Load Battery RAM into memory:
        copyArrayElements(ram, 0, this.nes.cpu.mem, 0x6000, 0x2000);
      }
    }
  }

  loadRomBank(bank, address) {
    // Loads a ROM bank into the specified address.
    bank %= this.nes.rom.romCount;
    //let data = this.nes.rom.rom[bank];
    //cpuMem.write(address,data,data.length);
    copyArrayElements(
      this.nes.rom.rom[bank],
      0,
      this.nes.cpu.mem,
      address,
      16384,
    );
  }

  loadVromBank(bank, address) {
    if (this.nes.rom.vromCount === 0) {
      return;
    }
    this.nes.ppu.triggerRendering();

    copyArrayElements(
      this.nes.rom.vrom[bank % this.nes.rom.vromCount],
      0,
      this.nes.ppu.vramMem,
      address,
      4096,
    );

    let vromTile = this.nes.rom.vromTile[bank % this.nes.rom.vromCount];
    copyArrayElements(vromTile, 0, this.nes.ppu.ptTile, address >> 4, 256);
  }

  load32kRomBank(bank, address) {
    this.loadRomBank((bank * 2) % this.nes.rom.romCount, address);
    this.loadRomBank((bank * 2 + 1) % this.nes.rom.romCount, address + 16384);
  }

  load8kVromBank(bank4kStart, address) {
    if (this.nes.rom.vromCount === 0) {
      return;
    }
    this.nes.ppu.triggerRendering();

    this.loadVromBank(bank4kStart % this.nes.rom.vromCount, address);
    this.loadVromBank(
      (bank4kStart + 1) % this.nes.rom.vromCount,
      address + 4096,
    );
  }

  load1kVromBank(bank1k, address) {
    if (this.nes.rom.vromCount === 0) {
      return;
    }
    this.nes.ppu.triggerRendering();

    let bank4k = Math.floor(bank1k / 4) % this.nes.rom.vromCount;
    let bankoffset = (bank1k % 4) * 1024;
    copyArrayElements(
      this.nes.rom.vrom[bank4k],
      bankoffset,
      this.nes.ppu.vramMem,
      address,
      1024,
    );

    // Update tiles:
    let vromTile = this.nes.rom.vromTile[bank4k];
    let baseIndex = address >> 4;
    for (let i = 0; i < 64; i++) {
      this.nes.ppu.ptTile[baseIndex + i] = vromTile[((bank1k % 4) << 6) + i];
    }
  }

  load2kVromBank(bank2k, address) {
    if (this.nes.rom.vromCount === 0) {
      return;
    }
    this.nes.ppu.triggerRendering();

    let bank4k = Math.floor(bank2k / 2) % this.nes.rom.vromCount;
    let bankoffset = (bank2k % 2) * 2048;
    copyArrayElements(
      this.nes.rom.vrom[bank4k],
      bankoffset,
      this.nes.ppu.vramMem,
      address,
      2048,
    );

    // Update tiles:
    let vromTile = this.nes.rom.vromTile[bank4k];
    let baseIndex = address >> 4;
    for (let i = 0; i < 128; i++) {
      this.nes.ppu.ptTile[baseIndex + i] = vromTile[((bank2k % 2) << 7) + i];
    }
  }

  load8kRomBank(bank8k, address) {
    let bank16k = Math.floor(bank8k / 2) % this.nes.rom.romCount;
    let offset = (bank8k % 2) * 8192;

    //this.nes.cpu.mem.write(address,this.nes.rom.rom[bank16k],offset,8192);
    copyArrayElements(
      this.nes.rom.rom[bank16k],
      offset,
      this.nes.cpu.mem,
      address,
      8192,
    );
  }

  // Returns true if the PPU can write to the given pattern table address.
  // Most mappers only allow writes when there's no CHR ROM (pure CHR RAM).
  // Mappers with mixed CHR ROM/RAM (e.g. TQROM) override this.
  // eslint-disable-next-line no-unused-vars
  canWriteChr(address) {
    return this.nes.rom.vromCount === 0;
  }

  // Called by the PPU once per rendered scanline (when rendering is
  // enabled), at dot `irqClockDot` (see the constructor).
  clockIrqCounter() {
    // Does nothing. This is used by the MMC3 mapper.
  }

  // eslint-disable-next-line no-unused-vars
  latchAccess(address) {
    // Does nothing. This is used by MMC2.
  }

  // Called by the PPU before rendering background tiles for a scanline.
  // Override in mappers that need per-phase CHR bank switching (e.g. MMC5,
  // which uses separate CHR bank sets for sprites vs backgrounds).
  onBgRender() {}

  // Called by the PPU before rendering sprites.
  // Override in mappers that need per-phase CHR bank switching.
  onSpriteRender() {}

  // Called per-tile during BG rendering when bgTileOverride is true.
  // Returns {tile, attrib} to override the tile and attribute for a
  // background tile, or null to use the default lookup.
  // Used by MMC5 ExRAM mode 1 for per-tile CHR bank selection.
  getBgTileData(/* baseTile, tileIndex, ht, vt */) {
    return null;
  }

  // Look up a sprite pattern tile by ptTile index (0-511).
  // Default: return from the PPU's current ptTile cache.
  // MMC5 overrides this to look up from Set A's VROM banks directly,
  // since ptTile may have BG data (Set B) loaded during BG rendering.
  // This avoids calling load*VromBank (which triggers triggerRendering).
  getSpritePatternTile(index) {
    return this.nes.ppu.ptTile[index];
  }

  toJSON() {
    return {
      joy1StrobeState: this.joy1StrobeState,
      joy2StrobeState: this.joy2StrobeState,
      joypadLastWrite: this.joypadLastWrite,
      joypadOutputBit0: this.joypadOutputBit0,
      joypadLastWriteCycle: this.joypadLastWriteCycle,
    };
  }

  fromJSON(s) {
    this.joy1StrobeState = s.joy1StrobeState;
    this.joy2StrobeState = s.joy2StrobeState;
    this.joypadLastWrite = s.joypadLastWrite;
    this.joypadOutputBit0 = s.joypadOutputBit0 || 0;
    this.joypadLastWriteCycle = s.joypadLastWriteCycle ?? -2;
  }
}

__exp.default = Mapper0;


return __exp;
}
function __m_mappers_mapper1_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// MMC1 / SxROM (SKROM, SLROM, SNROM, etc.)
// Used by games like The Legend of Zelda, Metroid, Mega Man 2, Final Fantasy.
// Writes use a 5-bit serial shift register (5 consecutive writes to load a value).
// Provides switchable 16 KB PRG-ROM banks, 4 KB or 8 KB CHR banks,
// and software-controlled nametable mirroring.
// See https://www.nesdev.org/wiki/MMC1
class Mapper1 extends Mapper0 {
  static mapperName = "MMC1";

  constructor(nes) {
    super(nes);

    // 5-bit buffer:
    this.regBuffer = 0;
    this.regBufferCounter = 0;

    // Register 0:
    this.mirroring = 0;
    this.oneScreenMirroring = 0;
    this.prgSwitchingArea = 1;
    this.prgSwitchingSize = 1;
    this.vromSwitchingSize = 0;

    // Register 1:
    this.romSelectionReg0 = 0;

    // Register 2:
    this.romSelectionReg1 = 0;

    // Register 3:
    this.romBankSelect = 0;
    this.romBankSelectValid = true;
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    // See what should be done with the written value:
    if ((value & 128) !== 0) {
      // Reset buffering:
      this.regBufferCounter = 0;
      this.regBuffer = 0;

      // Reset register:
      if (this.getRegNumber(address) === 0) {
        this.prgSwitchingArea = 1;
        this.prgSwitchingSize = 1;
      }
    } else {
      // Continue buffering:
      //regBuffer = (regBuffer & (0xFF-(1<<regBufferCounter))) | ((value & (1<<regBufferCounter))<<regBufferCounter);
      this.regBuffer =
        (this.regBuffer & (0xff - (1 << this.regBufferCounter))) |
        ((value & 1) << this.regBufferCounter);
      this.regBufferCounter++;

      if (this.regBufferCounter === 5) {
        // Use the buffered value:
        this.setReg(this.getRegNumber(address), this.regBuffer);

        // Reset buffer:
        this.regBuffer = 0;
        this.regBufferCounter = 0;
      }
    }
  }

  setReg(reg, value) {
    let tmp;

    switch (reg) {
      case 0:
        // Mirroring:
        tmp = value & 3;
        if (tmp !== this.mirroring) {
          // Set mirroring:
          this.mirroring = tmp;
          if ((this.mirroring & 2) === 0) {
            // SingleScreen mirroring overrides the other setting:
            this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING);
          } else if ((this.mirroring & 1) !== 0) {
            // Not overridden by SingleScreen mirroring.
            this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
          } else {
            this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
          }
        }

        // PRG Switching Area;
        this.prgSwitchingArea = (value >> 2) & 1;

        // PRG Switching Size:
        this.prgSwitchingSize = (value >> 3) & 1;

        // VROM Switching Size:
        this.vromSwitchingSize = (value >> 4) & 1;

        if (this.usesSuromPrgBanking() && this.romBankSelectValid) {
          this.applySuromPrgBanking();
        }
        break;

      case 1:
        // ROM selection:
        this.romSelectionReg0 = (value >> 4) & 1;

        // Check whether the cart has VROM:
        if (this.nes.rom.vromCount > 0) {
          // Select VROM bank at 0x0000:
          if (this.vromSwitchingSize === 0) {
            // Swap 8kB VROM:
            if (this.romSelectionReg0 === 0) {
              this.load8kVromBank(value & 0xf, 0x0000);
            } else {
              this.load8kVromBank(
                Math.floor(this.nes.rom.vromCount / 2) + (value & 0xf),
                0x0000,
              );
            }
          } else {
            // Swap 4kB VROM:
            if (this.romSelectionReg0 === 0) {
              this.loadVromBank(value & 0xf, 0x0000);
            } else {
              this.loadVromBank(
                Math.floor(this.nes.rom.vromCount / 2) + (value & 0xf),
                0x0000,
              );
            }
          }
        }

        if (this.usesSuromPrgBanking() && this.romBankSelectValid) {
          this.applySuromPrgBanking();
        }
        break;

      case 2:
        // ROM selection:
        this.romSelectionReg1 = (value >> 4) & 1;

        // Check whether the cart has VROM:
        if (this.nes.rom.vromCount > 0) {
          // Select VROM bank at 0x1000:
          if (this.vromSwitchingSize === 1) {
            // Swap 4kB of VROM:
            if (this.romSelectionReg1 === 0) {
              this.loadVromBank(value & 0xf, 0x1000);
            } else {
              this.loadVromBank(
                Math.floor(this.nes.rom.vromCount / 2) + (value & 0xf),
                0x1000,
              );
            }
          }
        }
        break;

      default: {
        this.romBankSelect = value & 0xf;
        this.romBankSelectValid = true;

        if (this.usesSuromPrgBanking()) {
          this.applySuromPrgBanking();
        } else {
          // Select ROM bank:
          // -------------------------
          let bank;
          let baseBank = 0;

          if (this.nes.rom.romCount >= 32) {
            // 1024 kB cart
            if (this.vromSwitchingSize === 0) {
              if (this.romSelectionReg0 === 1) {
                baseBank = 16;
              }
            } else {
              baseBank =
                (this.romSelectionReg0 | (this.romSelectionReg1 << 1)) << 3;
            }
          } else if (this.nes.rom.romCount >= 16) {
            // 512 kB cart
            if (this.romSelectionReg0 === 1) {
              baseBank = 8;
            }
          }

          if (this.prgSwitchingSize === 0) {
            // 32kB
            bank = baseBank + (value & 0xf);
            this.load32kRomBank(bank, 0x8000);
          } else {
            // 16kB
            bank = baseBank * 2 + (value & 0xf);
            if (this.prgSwitchingArea === 0) {
              this.loadRomBank(bank, 0xc000);
            } else {
              this.loadRomBank(bank, 0x8000);
            }
          }
        }
        break;
      }
    }
  }

  isSurom() {
    return this.nes.rom.romCount === 32 && this.nes.rom.vromCount === 0;
  }

  usesSuromPrgBanking() {
    return this.isSurom() && this.vromSwitchingSize === 0;
  }

  applySuromPrgBanking() {
    // SUROM uses CHR-RAM, so CHR bank 0 bit 4 is available as the outer
    // PRG-ROM address bit. Each outer page contains sixteen 16 KB banks.
    const pageBase = this.romSelectionReg0 << 4;
    const selectedBank = pageBase + this.romBankSelect;

    if (this.prgSwitchingSize === 0) {
      // Modes 0 and 1 select an aligned 32 KB pair. Keep the calculation in
      // 16 KB units so the outer page is applied exactly once.
      const firstBank = selectedBank & ~1;
      this.loadRomBank(firstBank, 0x8000);
      this.loadRomBank(firstBank + 1, 0xc000);
    } else if (this.prgSwitchingArea === 0) {
      // Mode 2 fixes the first bank of the active page at $8000.
      this.loadRomBank(pageBase, 0x8000);
      this.loadRomBank(selectedBank, 0xc000);
    } else {
      // Mode 3 fixes the last bank of the active page at $C000.
      this.loadRomBank(selectedBank, 0x8000);
      this.loadRomBank(pageBase + 15, 0xc000);
    }
  }

  // Returns the register number from the address written to:
  getRegNumber(address) {
    if (address >= 0x8000 && address <= 0x9fff) {
      return 0;
    } else if (address >= 0xa000 && address <= 0xbfff) {
      return 1;
    } else if (address >= 0xc000 && address <= 0xdfff) {
      return 2;
    } else {
      return 3;
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("MMC1: Invalid ROM! Unable to load.");
    }

    // Load PRG-ROM:
    this.loadRomBank(0, 0x8000); //   First ROM bank..
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000); // ..and last ROM bank.

    // Load CHR-ROM:
    this.loadCHRROM();

    // Load Battery RAM (if present):
    this.loadBatteryRam();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  // eslint-disable-next-line no-unused-vars
  switchLowHighPrgRom(oldSetting) {
    // not yet.
  }

  switch16to32() {
    // not yet.
  }

  switch32to16() {
    // not yet.
  }

  toJSON() {
    let s = super.toJSON();
    s.mirroring = this.mirroring;
    s.oneScreenMirroring = this.oneScreenMirroring;
    s.prgSwitchingArea = this.prgSwitchingArea;
    s.prgSwitchingSize = this.prgSwitchingSize;
    s.vromSwitchingSize = this.vromSwitchingSize;
    s.romSelectionReg0 = this.romSelectionReg0;
    s.romSelectionReg1 = this.romSelectionReg1;
    s.romBankSelect = this.romBankSelect;
    s.romBankSelectValid = this.romBankSelectValid;
    s.regBuffer = this.regBuffer;
    s.regBufferCounter = this.regBufferCounter;
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.mirroring = s.mirroring;
    this.oneScreenMirroring = s.oneScreenMirroring;
    this.prgSwitchingArea = s.prgSwitchingArea;
    this.prgSwitchingSize = s.prgSwitchingSize;
    this.vromSwitchingSize = s.vromSwitchingSize;
    this.romSelectionReg0 = s.romSelectionReg0;
    this.romSelectionReg1 = s.romSelectionReg1;
    this.romBankSelect = s.romBankSelect;
    // Older states contain romBankSelect but never updated it after register
    // writes. Preserve their restored CPU windows until register 3 is written.
    this.romBankSelectValid = s.romBankSelectValid === true;
    this.regBuffer = s.regBuffer;
    this.regBufferCounter = s.regBufferCounter;
  }
}

__exp.default = Mapper1;


return __exp;
}
function __m_mappers_mapper11_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// Color Dreams (unlicensed discrete mapper)
// Used by games like Bible Adventures, Crystal Mines, Chiller, Metal Fighter.
// Single register at $8000-$FFFF: bits 0-1 select 32 KB PRG bank,
// bits 4-7 select 8 KB CHR bank.
// See https://www.nesdev.org/wiki/Color_Dreams
class Mapper11 extends Mapper0 {
  static mapperName = "Color Dreams";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // Swap in the given PRG-ROM bank:
      let prgbank1 = ((value & 0xf) * 2) % this.nes.rom.romCount;
      let prgbank2 = ((value & 0xf) * 2 + 1) % this.nes.rom.romCount;

      this.loadRomBank(prgbank1, 0x8000);
      this.loadRomBank(prgbank2, 0xc000);

      if (this.nes.rom.vromCount > 0) {
        // Swap in the given VROM bank at 0x0000:
        let bank = ((value >> 4) * 2) % this.nes.rom.vromCount;
        this.loadVromBank(bank, 0x0000);
        this.loadVromBank(bank + 1, 0x1000);
      }
    }
  }
}

__exp.default = Mapper11;


return __exp;
}
function __m_mappers_mapper118_js() {
const __exp = {};
const Mapper4 = __req("mappers/mapper4.js").default;

// TxSROM - MMC3 variant with CHR-controlled nametable mirroring
// Used by games like Armadillo, Pro Sport Hockey, Goal! Two.
// Identical to standard MMC3 except: the $A000 mirroring register is bypassed,
// and bit 7 of CHR bank register values controls CIRAM A10 (nametable page select)
// instead of being used for CHR addressing. This enables single-screen and
// diagonal mirroring modes that standard MMC3 cannot produce.
// See https://www.nesdev.org/wiki/INES_Mapper_118
class Mapper118 extends Mapper4 {
  static mapperName = "TxSROM";

  constructor(nes) {
    super(nes);
    // Raw CHR register values (R0-R5) — bit 7 is used for nametable control
    this.chrRegs = [0, 0, 0, 0, 0, 0];
  }

  write(address, value) {
    if (address === 0xa000) {
      // The standard MMC3 mirroring register is bypassed on TxSROM.
      // Nametable mirroring is instead controlled by bit 7 of CHR bank values.
      return;
    }
    super.write(address, value);
    if (address === 0x8000) {
      // chrAddressSelect may have changed, which affects which CHR registers
      // control which nametables
      this.updateNametableMirroring();
    }
  }

  executeCommand(cmd, arg) {
    if (cmd <= 5) {
      // CHR bank command: store the raw value, then mask bit 7 before passing
      // to the parent for CHR banking (bit 7 goes to CIRAM A10, not CHR A17)
      this.chrRegs[cmd] = arg;
      super.executeCommand(cmd, arg & 0x7f);
      this.updateNametableMirroring();
    } else {
      // PRG bank commands pass through unchanged
      super.executeCommand(cmd, arg);
    }
  }

  // Update nametable mirroring based on bit 7 of CHR register values.
  // The MMC3's CHR banking ignores A13, so pattern table addresses ($0xxx)
  // and nametable addresses ($2xxx) use the same bank selection. CHR A17
  // (bit 7) is wired to CIRAM A10 on TxSROM boards.
  //
  // When chrAddressSelect=0: R0/R1 (2KB banks) are at $0000-$0FFF, so they
  //   control nametables: R0 bit 7 → NT0+NT1, R1 bit 7 → NT2+NT3
  // When chrAddressSelect=1: R2-R5 (1KB banks) are at $0000-$0FFF, so they
  //   control individual nametables: R2→NT0, R3→NT1, R4→NT2, R5→NT3
  updateNametableMirroring() {
    let ppu = this.nes.ppu;

    if (this.chrAddressSelect === 0) {
      let nt01 = (this.chrRegs[0] >> 7) & 1;
      let nt23 = (this.chrRegs[1] >> 7) & 1;
      ppu.ntable1[0] = nt01;
      ppu.ntable1[1] = nt01;
      ppu.ntable1[2] = nt23;
      ppu.ntable1[3] = nt23;
    } else {
      ppu.ntable1[0] = (this.chrRegs[2] >> 7) & 1;
      ppu.ntable1[1] = (this.chrRegs[3] >> 7) & 1;
      ppu.ntable1[2] = (this.chrRegs[4] >> 7) & 1;
      ppu.ntable1[3] = (this.chrRegs[5] >> 7) & 1;
    }

    // Update VRAM mirror table to match ntable1 settings
    for (let i = 0; i < 4; i++) {
      let source = 0x2000 + i * 0x400;
      let target = 0x2000 + ppu.ntable1[i] * 0x400;
      ppu.defineMirrorRegion(source, target, 0x400);
    }

    // Invalidate the PPU's mirroring cache so setMirroring() won't skip
    // updates if called later
    ppu.currentMirroring = -1;
  }

  loadROM() {
    super.loadROM();
    this.updateNametableMirroring();
  }

  toJSON() {
    let s = super.toJSON();
    s.chrRegs = this.chrRegs.slice();
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.chrRegs = s.chrRegs;
    this.updateNametableMirroring();
  }
}

__exp.default = Mapper118;


return __exp;
}
function __m_mappers_mapper119_js() {
const __exp = {};
const Mapper4 = __req("mappers/mapper4.js").default;
const Tile = __req("tile.js").default;
const { copyArrayElements } = __req("utils.js");

// TQROM - MMC3 variant that supports both CHR ROM and CHR RAM simultaneously.
// Used by Pin-Bot and High Speed (both by Rare).
// Identical to standard MMC3 except: bit 6 of the CHR bank register values
// selects between CHR ROM (0) and CHR RAM (1). Bits 0-5 specify the bank
// within the selected chip, allowing up to 64KB CHR ROM and 8KB CHR RAM.
// A 74HC32 ORs PPU A13 with CHR A16 (bit 6) to generate the ROM chip-enable,
// while CHR A16 directly enables the RAM chip.
// See https://www.nesdev.org/wiki/INES_Mapper_119
class Mapper119 extends Mapper4 {
  static mapperName = "TQROM";

  constructor(nes) {
    super(nes);

    // 8KB of CHR RAM (8 x 1KB banks)
    this.chrRam = new Uint8Array(8192);

    // Pre-decoded tiles for CHR RAM banks. Each 1KB bank has 64 tiles (1KB / 16
    // bytes per tile). These are persistent Tile objects: when a CHR RAM bank is
    // loaded into a PPU slot, ptTile entries point here, and PPU patternWrite()
    // updates them in place on $2007 writes.
    this.chrRamTiles = new Array(8);
    for (let i = 0; i < 8; i++) {
      this.chrRamTiles[i] = new Array(64);
      for (let j = 0; j < 64; j++) {
        this.chrRamTiles[i][j] = new Tile();
      }
    }

    // Tracks which CHR RAM bank (0-7) is mapped at each 1KB PPU pattern table
    // slot (0-7 for addresses $0000-$1FFF), or -1 if CHR ROM is there.
    this.chrRamSlots = [-1, -1, -1, -1, -1, -1, -1, -1];
  }

  executeCommand(cmd, arg) {
    switch (cmd) {
      case Mapper4.CMD_SEL_2_1K_VROM_0000: {
        // Select 2 consecutive 1KB banks at $0000/$0400 (or $1000/$1400)
        let base = this.chrAddressSelect === 0 ? 0x0000 : 0x1000;
        if (arg & 0x40) {
          let bank = arg & 0x06; // 2KB-aligned within CHR RAM
          this.load1kChrRamBank(bank, base);
          this.load1kChrRamBank(bank + 1, base + 0x0400);
        } else {
          let bank = arg & 0x3f;
          this.saveChrRamSlot(base);
          this.saveChrRamSlot(base + 0x0400);
          this.chrRamSlots[base >> 10] = -1;
          this.chrRamSlots[(base >> 10) + 1] = -1;
          this.load1kVromBank(bank, base);
          this.load1kVromBank(bank + 1, base + 0x0400);
        }
        break;
      }

      case Mapper4.CMD_SEL_2_1K_VROM_0800: {
        let base = this.chrAddressSelect === 0 ? 0x0800 : 0x1800;
        if (arg & 0x40) {
          let bank = arg & 0x06;
          this.load1kChrRamBank(bank, base);
          this.load1kChrRamBank(bank + 1, base + 0x0400);
        } else {
          let bank = arg & 0x3f;
          this.saveChrRamSlot(base);
          this.saveChrRamSlot(base + 0x0400);
          this.chrRamSlots[base >> 10] = -1;
          this.chrRamSlots[(base >> 10) + 1] = -1;
          this.load1kVromBank(bank, base);
          this.load1kVromBank(bank + 1, base + 0x0400);
        }
        break;
      }

      case Mapper4.CMD_SEL_1K_VROM_1000: {
        let base = this.chrAddressSelect === 0 ? 0x1000 : 0x0000;
        if (arg & 0x40) {
          this.load1kChrRamBank(arg & 0x07, base);
        } else {
          this.saveChrRamSlot(base);
          this.chrRamSlots[base >> 10] = -1;
          this.load1kVromBank(arg & 0x3f, base);
        }
        break;
      }

      case Mapper4.CMD_SEL_1K_VROM_1400: {
        let base = this.chrAddressSelect === 0 ? 0x1400 : 0x0400;
        if (arg & 0x40) {
          this.load1kChrRamBank(arg & 0x07, base);
        } else {
          this.saveChrRamSlot(base);
          this.chrRamSlots[base >> 10] = -1;
          this.load1kVromBank(arg & 0x3f, base);
        }
        break;
      }

      case Mapper4.CMD_SEL_1K_VROM_1800: {
        let base = this.chrAddressSelect === 0 ? 0x1800 : 0x0800;
        if (arg & 0x40) {
          this.load1kChrRamBank(arg & 0x07, base);
        } else {
          this.saveChrRamSlot(base);
          this.chrRamSlots[base >> 10] = -1;
          this.load1kVromBank(arg & 0x3f, base);
        }
        break;
      }

      case Mapper4.CMD_SEL_1K_VROM_1C00: {
        let base = this.chrAddressSelect === 0 ? 0x1c00 : 0x0c00;
        if (arg & 0x40) {
          this.load1kChrRamBank(arg & 0x07, base);
        } else {
          this.saveChrRamSlot(base);
          this.chrRamSlots[base >> 10] = -1;
          this.load1kVromBank(arg & 0x3f, base);
        }
        break;
      }

      default:
        // PRG commands (6, 7) pass through to MMC3
        super.executeCommand(cmd, arg);
    }
  }

  // Save the current vramMem content of a 1KB PPU slot back to chrRam.
  // This must be called before overwriting a slot that has CHR RAM mapped,
  // so that any PPU $2007 writes to that region are preserved.
  saveChrRamSlot(address) {
    let slot = address >> 10;
    let bank = this.chrRamSlots[slot];
    if (bank === -1) return;
    copyArrayElements(
      this.nes.ppu.vramMem,
      slot << 10,
      this.chrRam,
      bank * 1024,
      1024,
    );
  }

  // Load a 1KB CHR RAM bank into the PPU pattern table at the given address.
  load1kChrRamBank(bank, address) {
    this.nes.ppu.triggerRendering();
    bank &= 0x07;

    // Save the old CHR RAM content if this slot had a different bank mapped
    this.saveChrRamSlot(address);

    let slot = address >> 10;
    this.chrRamSlots[slot] = bank;

    // Copy CHR RAM data into PPU VRAM
    let srcOffset = bank * 1024;
    copyArrayElements(
      this.chrRam,
      srcOffset,
      this.nes.ppu.vramMem,
      address,
      1024,
    );

    // Rebuild tiles from CHR RAM data and install them in ppuTile
    this.rebuildChrRamTiles(bank);
    let baseIndex = address >> 4;
    for (let i = 0; i < 64; i++) {
      this.nes.ppu.ptTile[baseIndex + i] = this.chrRamTiles[bank][i];
    }
  }

  // Rebuild the pre-decoded Tile objects for a CHR RAM bank from raw bytes.
  rebuildChrRamTiles(bank) {
    let base = bank * 1024;
    for (let i = 0; i < 1024; i++) {
      let tileIndex = i >> 4;
      let leftOver = i % 16;
      if (leftOver < 8) {
        this.chrRamTiles[bank][tileIndex].setScanline(
          leftOver,
          this.chrRam[base + i],
          this.chrRam[base + i + 8],
        );
      } else {
        this.chrRamTiles[bank][tileIndex].setScanline(
          leftOver - 8,
          this.chrRam[base + i - 8],
          this.chrRam[base + i],
        );
      }
    }
  }

  // Allow PPU writes to pattern table addresses that are mapped to CHR RAM.
  canWriteChr(address) {
    if (address >= 0x2000) return false;
    return this.chrRamSlots[address >> 10] !== -1;
  }

  toJSON() {
    // Flush any pending CHR RAM writes from vramMem back to chrRam
    for (let slot = 0; slot < 8; slot++) {
      this.saveChrRamSlot(slot << 10);
    }
    let s = super.toJSON();
    s.chrRam = Array.from(this.chrRam);
    s.chrRamSlots = this.chrRamSlots.slice();
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.chrRam = new Uint8Array(s.chrRam);
    this.chrRamSlots = s.chrRamSlots;
    // Rebuild all CHR RAM tile data
    for (let bank = 0; bank < 8; bank++) {
      this.rebuildChrRamTiles(bank);
    }
    // Re-install CHR RAM tiles into PPU ptTile for active slots
    for (let slot = 0; slot < 8; slot++) {
      let bank = this.chrRamSlots[slot];
      if (bank !== -1) {
        let baseIndex = (slot << 10) >> 4;
        for (let i = 0; i < 64; i++) {
          this.nes.ppu.ptTile[baseIndex + i] = this.chrRamTiles[bank][i];
        }
      }
    }
  }
}

__exp.default = Mapper119;


return __exp;
}
function __m_mappers_mapper140_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// Jaleco JF-11 / JF-14
// Used by Bio Senshi Dan - Increaser Tono Tatakai.
// Similar to GxROM (mapper 66) but register is at $6000-$7FFF instead of $8000+,
// which means it cannot coexist with SRAM. Bits 4-5 select 32 KB PRG bank,
// bits 0-3 select 8 KB CHR bank.
// See https://www.nesdev.org/wiki/INES_Mapper_140
class Mapper140 extends Mapper0 {
  static mapperName = "Jaleco JF-11/JF-14";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x6000 || address > 0x7fff) {
      super.write(address, value);
      return;
    } else {
      // Swap in the given PRG-ROM bank at 0x8000:
      this.load32kRomBank((value >> 4) & 3, 0x8000);

      // Swap in the given VROM bank at 0x0000:
      this.load8kVromBank((value & 0xf) * 2, 0x0000);
    }
  }
}

__exp.default = Mapper140;


return __exp;
}
function __m_mappers_mapper180_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// UNROM (AND-logic variant, HVC-UNROM)
// Used by Crazy Climber.
// Inverted UxROM: first 16 KB bank fixed at $8000, switchable bank at $C000.
// Standard UxROM fixes the last bank; this variant uses AND logic instead of OR logic
// on the bank select lines, producing the opposite fixed-bank behavior.
// See https://www.nesdev.org/wiki/INES_Mapper_180
class Mapper180 extends Mapper0 {
  static mapperName = "UNROM (Crazy Climber)";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // This is a ROM bank select command.
      // Swap in the given ROM bank at 0xc000:
      this.loadRomBank(value, 0xc000);
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("Mapper 180: Invalid ROM! Unable to load.");
    }

    // Load PRG-ROM:
    this.loadRomBank(0, 0x8000);
    this.loadRomBank(0, 0xc000);

    // Load CHR-ROM:
    this.loadCHRROM();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

__exp.default = Mapper180;


return __exp;
}
function __m_mappers_mapper2_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// UxROM (NES-UNROM, NES-UOROM)
// Used by games like Mega Man, Castlevania, Contra, Duck Tales, Metal Gear.
// 16 KB switchable PRG-ROM bank at $8000, last 16 KB bank fixed at $C000.
// Uses CHR-RAM (no CHR-ROM bank switching).
// See https://www.nesdev.org/wiki/UxROM
class Mapper2 extends Mapper0 {
  static mapperName = "UxROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // This is a ROM bank select command.
      // Swap in the given ROM bank at 0x8000:
      this.loadRomBank(value, 0x8000);
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("UNROM: Invalid ROM! Unable to load.");
    }

    // Load PRG-ROM:
    this.loadRomBank(0, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);

    // Load CHR-ROM:
    this.loadCHRROM();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

__exp.default = Mapper2;


return __exp;
}
function __m_mappers_mapper240_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// Mapper 240 (Jing Ke Xin Zhuan / Sheng Huo Lie Zhuan PCBs)
// Used by Jing Ke Xin Zhuan, Sheng Huo Lie Zhuan.
// Register at $4020-$5FFF: upper nibble selects 32 KB PRG bank,
// lower nibble selects 8 KB CHR bank.
// See https://www.nesdev.org/wiki/INES_Mapper_240
class Mapper240 extends Mapper0 {
  static mapperName = "Mapper 240";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x4020 || address > 0x5fff) {
      super.write(address, value);
      return;
    } else {
      // Swap in the given PRG-ROM bank at 0x8000:
      this.load32kRomBank((value >> 4) & 3, 0x8000);

      // Swap in the given VROM bank at 0x0000:
      this.load8kVromBank((value & 0xf) * 2, 0x0000);
    }
  }
}

__exp.default = Mapper240;


return __exp;
}
function __m_mappers_mapper241_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// BxROM variant (Hengge Technology)
// Used by various Hengge Technology titles and educational cartridges.
// BxROM-like 32 KB PRG bank switching via writes to $8000-$FFFF,
// with optional battery-backed WRAM at $6000-$7FFF.
// See https://www.nesdev.org/wiki/INES_Mapper_241
class Mapper241 extends Mapper0 {
  static mapperName = "BxROM (Mapper 241)";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      this.load32kRomBank(value, 0x8000);
    }
  }
}

__exp.default = Mapper241;


return __exp;
}
function __m_mappers_mapper3_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// CNROM
// Used by games like Solomon's Key, Arkanoid, Arkista's Ring, Bump 'n' Jump.
// Fixed PRG-ROM (up to 32 KB), with switchable 8 KB CHR-ROM banks.
// See https://www.nesdev.org/wiki/INES_Mapper_003
class Mapper3 extends Mapper0 {
  static mapperName = "CNROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // This is a ROM bank select command.
      // Swap in the given ROM bank at 0x8000:
      // This is a VROM bank select command.
      // Swap in the given VROM bank at 0x0000:
      this.load8kVromBank(value * 2, 0x0000);
    }
  }
}

__exp.default = Mapper3;


return __exp;
}
function __m_mappers_mapper34_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// BNROM (NES-BNROM)
// Used by games like Deadly Towers (Mashou), Darkseed.
// Simple 32 KB PRG-ROM bank switching via writes to $8000-$FFFF.
// No CHR bank switching (uses CHR-RAM or fixed CHR-ROM).
// Note: iNES mapper 34 also covers NINA-001; this implementation handles BNROM only.
// See https://www.nesdev.org/wiki/INES_Mapper_034
class Mapper34 extends Mapper0 {
  static mapperName = "BNROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      this.load32kRomBank(value, 0x8000);
    }
  }
}

__exp.default = Mapper34;


return __exp;
}
function __m_mappers_mapper38_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// PCI556 (UNL-PCI556) - Bit Corp
// Used by Crime Busters.
// Nearly identical to GxROM (mapper 66) but the register is at $7000-$7FFF.
// Bits 0-1 select 32 KB PRG bank, bits 2-3 select 8 KB CHR bank.
// See https://www.nesdev.org/wiki/INES_Mapper_038
class Mapper38 extends Mapper0 {
  static mapperName = "PCI556";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x7000 || address > 0x7fff) {
      super.write(address, value);
      return;
    } else {
      // Swap in the given PRG-ROM bank at 0x8000:
      this.load32kRomBank(value & 3, 0x8000);

      // Swap in the given VROM bank at 0x0000:
      this.load8kVromBank(((value >> 2) & 3) * 2, 0x0000);
    }
  }
}

__exp.default = Mapper38;


return __exp;
}
function __m_mappers_mapper4_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// MMC3 / TxROM (TSROM, TLSROM, TQROM, etc.)
// Used by games like Super Mario Bros. 2, Super Mario Bros. 3, Kirby's Adventure.
// Fine-grained bank switching: two 8 KB switchable PRG-ROM banks, two 2 KB + four
// 1 KB CHR banks. Provides a scanline-counting IRQ for split-screen effects and
// software-switchable H/V nametable mirroring.
// See https://www.nesdev.org/wiki/MMC3
class Mapper4 extends Mapper0 {
  static mapperName = "MMC3";
  static CMD_SEL_2_1K_VROM_0000 = 0;
  static CMD_SEL_2_1K_VROM_0800 = 1;
  static CMD_SEL_1K_VROM_1000 = 2;
  static CMD_SEL_1K_VROM_1400 = 3;
  static CMD_SEL_1K_VROM_1800 = 4;
  static CMD_SEL_1K_VROM_1C00 = 5;
  static CMD_SEL_ROM_PAGE1 = 6;
  static CMD_SEL_ROM_PAGE2 = 7;

  constructor(nes) {
    super(nes);
    this.command = 0;
    this.prgAddressSelect = 0;
    this.chrAddressSelect = 0;
    this.pageNumber = 0;
    this.irqCounter = 0;
    this.irqLatchValue = 0;
    this.irqEnable = 0;
    this.prgAddressChanged = false;
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    switch (address & 0xe001) {
      case 0x8000: {
        // Command/Address Select register
        this.command = value & 7;
        const tmp = (value >> 6) & 1;
        if (tmp !== this.prgAddressSelect) {
          this.prgAddressChanged = true;
        }
        this.prgAddressSelect = tmp;
        this.chrAddressSelect = (value >> 7) & 1;
        break;
      }

      case 0x8001:
        // Page number for command
        this.executeCommand(this.command, value);
        break;

      case 0xa000:
        // Mirroring select
        if ((value & 1) !== 0) {
          this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
        } else {
          this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
        }
        break;

      case 0xa001:
        // SaveRAM Toggle
        // TODO
        //nes.getRom().setSaveState((value&1)!=0);
        break;

      case 0xc000:
        // IRQ Counter register
        this.irqCounter = value;
        //nes.ppu.mapperIrqCounter = 0;
        break;

      case 0xc001:
        // IRQ Latch register
        this.irqLatchValue = value;
        break;

      case 0xe000:
        // IRQ Control Reg 0: disable IRQs, and acknowledge (release the CPU's
        // IRQ line for) any IRQ that is pending.
        // See https://www.nesdev.org/wiki/MMC3#IRQ_disable_($E000-$FFFE,_even)
        this.irqEnable = 0;
        this.nes.cpu.clearIrq();
        break;

      case 0xe001:
        // IRQ Control Reg 1 (enable)
        this.irqEnable = 1;
        break;

      // No default needed: the 0xE001 mask maps every address >= $8000
      // to one of the eight cases above.
    }
  }

  executeCommand(cmd, arg) {
    switch (cmd) {
      case Mapper4.CMD_SEL_2_1K_VROM_0000:
        // Select 2 1KB VROM pages at 0x0000:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x0000);
          this.load1kVromBank(arg + 1, 0x0400);
        } else {
          this.load1kVromBank(arg, 0x1000);
          this.load1kVromBank(arg + 1, 0x1400);
        }
        break;

      case Mapper4.CMD_SEL_2_1K_VROM_0800:
        // Select 2 1KB VROM pages at 0x0800:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x0800);
          this.load1kVromBank(arg + 1, 0x0c00);
        } else {
          this.load1kVromBank(arg, 0x1800);
          this.load1kVromBank(arg + 1, 0x1c00);
        }
        break;

      case Mapper4.CMD_SEL_1K_VROM_1000:
        // Select 1K VROM Page at 0x1000:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x1000);
        } else {
          this.load1kVromBank(arg, 0x0000);
        }
        break;

      case Mapper4.CMD_SEL_1K_VROM_1400:
        // Select 1K VROM Page at 0x1400:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x1400);
        } else {
          this.load1kVromBank(arg, 0x0400);
        }
        break;

      case Mapper4.CMD_SEL_1K_VROM_1800:
        // Select 1K VROM Page at 0x1800:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x1800);
        } else {
          this.load1kVromBank(arg, 0x0800);
        }
        break;

      case Mapper4.CMD_SEL_1K_VROM_1C00:
        // Select 1K VROM Page at 0x1C00:
        if (this.chrAddressSelect === 0) {
          this.load1kVromBank(arg, 0x1c00);
        } else {
          this.load1kVromBank(arg, 0x0c00);
        }
        break;

      case Mapper4.CMD_SEL_ROM_PAGE1:
        if (this.prgAddressChanged) {
          // Load the two hardwired banks:
          if (this.prgAddressSelect === 0) {
            this.load8kRomBank((this.nes.rom.romCount - 1) * 2, 0xc000);
          } else {
            this.load8kRomBank((this.nes.rom.romCount - 1) * 2, 0x8000);
          }
          this.prgAddressChanged = false;
        }

        // Select first switchable ROM page:
        if (this.prgAddressSelect === 0) {
          this.load8kRomBank(arg, 0x8000);
        } else {
          this.load8kRomBank(arg, 0xc000);
        }
        break;

      case Mapper4.CMD_SEL_ROM_PAGE2:
        // Select second switchable ROM page:
        this.load8kRomBank(arg, 0xa000);

        // hardwire appropriate bank:
        if (this.prgAddressChanged) {
          // Load the two hardwired banks:
          if (this.prgAddressSelect === 0) {
            this.load8kRomBank((this.nes.rom.romCount - 1) * 2, 0xc000);
          } else {
            this.load8kRomBank((this.nes.rom.romCount - 1) * 2, 0x8000);
          }
          this.prgAddressChanged = false;
        }
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("MMC3: Invalid ROM! Unable to load.");
    }

    // Load hardwired PRG banks (0xC000 and 0xE000):
    this.load8kRomBank((this.nes.rom.romCount - 1) * 2, 0xc000);
    this.load8kRomBank((this.nes.rom.romCount - 1) * 2 + 1, 0xe000);

    // Load swappable PRG banks (0x8000 and 0xA000):
    this.load8kRomBank(0, 0x8000);
    this.load8kRomBank(1, 0xa000);

    // Load CHR-ROM:
    this.loadCHRROM();

    // Load Battery RAM (if present):
    this.loadBatteryRam();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  clockIrqCounter() {
    if (this.irqEnable === 1) {
      this.irqCounter--;
      if (this.irqCounter < 0) {
        // Trigger IRQ:
        //nes.getCpu().doIrq();
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
        this.irqCounter = this.irqLatchValue;
      }
    }
  }

  toJSON() {
    let s = super.toJSON();
    s.command = this.command;
    s.prgAddressSelect = this.prgAddressSelect;
    s.chrAddressSelect = this.chrAddressSelect;
    s.pageNumber = this.pageNumber;
    s.irqCounter = this.irqCounter;
    s.irqLatchValue = this.irqLatchValue;
    s.irqEnable = this.irqEnable;
    s.prgAddressChanged = this.prgAddressChanged;
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.command = s.command;
    this.prgAddressSelect = s.prgAddressSelect;
    this.chrAddressSelect = s.chrAddressSelect;
    this.pageNumber = s.pageNumber;
    this.irqCounter = s.irqCounter;
    this.irqLatchValue = s.irqLatchValue;
    this.irqEnable = s.irqEnable;
    this.prgAddressChanged = s.prgAddressChanged;
  }
}

__exp.default = Mapper4;


return __exp;
}
function __m_mappers_mapper5_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;
const { copyArrayElements } = __req("utils.js");

// MMC5 / ExROM (EKROM, ELROM, ETROM, EWROM)
// Used by games like Castlevania III, Just Breed, Uncharted Waters, Metal Slader Glory.
// The most complex Nintendo mapper. Flexible PRG/CHR banking (up to 1 MB each),
// expansion audio (2 pulse + PCM), 8x8 hardware multiplier, 1 KB ExRAM for extended
// nametable attributes, vertical split screen, and scanline-counting IRQ.
// See https://www.nesdev.org/wiki/MMC5
class Mapper5 extends Mapper0 {
  static mapperName = "MMC5";

  constructor(nes) {
    super(nes);
    // The MMC5 detects a new scanline from the PPU's nametable fetches at
    // the start of the line, so clock its counter at the end of each line.
    // (Dot 339 rather than 340, since the pre-render line skips dot 340 on
    // odd frames.)
    this.irqClockDot = 339;

    // PRG banking
    // $5100: PRG mode (0=32K, 1=16K+16K, 2=16K+8K+8K, 3=8K+8K+8K+8K)
    this.prgMode = 3; // Power-on default: mode 3 (8K banks)
    // $5113-$5117: PRG bank registers. Raw values written by the game.
    // $5113 always maps RAM to $6000-$7FFF.
    // $5114-$5116 bit 7: 0=RAM, 1=ROM. $5117 always ROM.
    this.prgBankReg = new Uint8Array(5); // indices 0-4 for $5113-$5117
    this.prgBankReg[4] = 0xff; // $5117 defaults to last page (0xFF)

    // PRG RAM: up to 64 KB (two 32 KB chips), banked into $6000-$7FFF.
    // Also mappable into $8000-$DFFF via bank registers with bit 7 clear.
    this.prgRam = new Uint8Array(0x10000); // 64 KB PRG RAM

    // PRG RAM write protection: $5102 and $5103
    // Writes only enabled when $5102=%10 and $5103=%01
    // Both reset to %11 ($03) per nesdev wiki, which keeps RAM write-protected.
    this.prgRamProtectA = 0x03; // $5102
    this.prgRamProtectB = 0x03; // $5103

    // CHR banking
    // $5101: CHR mode (0=8K, 1=4K, 2=2K, 3=1K)
    this.chrMode = 3; // Power-on default: mode 3 (1K banks)
    // $5120-$5127: CHR bank set A (sprite banks)
    this.chrBankA = new Uint16Array(8);
    // $5128-$512B: CHR bank set B (background banks)
    this.chrBankB = new Uint16Array(4);
    // $5130: Upper CHR bank bits (bits 8-9 appended to bank registers)
    this.chrUpperBits = 0;
    // Tracks which CHR set was last written (0=A, 1=B) for $2007 access
    this.lastChrWrite = 0;

    // Nametable mapping: $5105
    // Each 2-bit field: 0=CIRAM A, 1=CIRAM B, 2=ExRAM, 3=Fill
    this.ntMapping = new Uint8Array(4);

    // ExRAM: 1 KB internal to MMC5, used for nametable/extended attributes/RAM
    // $5104: ExRAM mode (0=nametable, 1=ext attributes, 2=RAM, 3=read-only)
    this.exramMode = 0;
    this.exram = new Uint8Array(0x400); // 1 KB

    // Fill mode: $5106/$5107
    this.fillTile = 0;
    this.fillAttr = 0;

    // Scanline IRQ: $5203/$5204
    // The MMC5 counts scanlines by monitoring PPU nametable fetches.
    // See https://www.nesdev.org/wiki/MMC5#Scanline_detection_and_scanline_IRQ
    this.irqTarget = 0; // $5203: target scanline
    this.irqEnabled = false; // $5204 bit 7 write: IRQ enable
    this.irqPending = false; // $5204 bit 7 read: IRQ pending flag
    this.inFrame = false; // $5204 bit 6 read: in-frame flag
    this.irqCounter = 0; // Internal scanline counter

    // Hardware multiplier: $5205/$5206
    // Write two 8-bit unsigned values, read 16-bit product immediately.
    // Wiki doesn't specify power-on default; FCEUX uses 0. Using 0 as safe default.
    this.multA = 0;
    this.multB = 0;

    // Split screen: $5200-$5202
    // Not commonly used. Basic support for register storage.
    this.splitEnabled = false; // $5200 bit 7
    this.splitRight = false; // $5200 bit 6 (0=left, 1=right)
    this.splitTile = 0; // $5200 bits 0-4: tile threshold
    this.splitScroll = 0; // $5201: vertical scroll for split
    this.splitPage = 0; // $5202: 4K CHR page for split

    // Expansion audio: two pulse channels + PCM
    // The MMC5 pulse channels are similar to APU square channels but lack
    // sweep units and don't silence at low frequencies.
    // See https://www.nesdev.org/wiki/MMC5_audio
    this.pulse1 = this._initPulse();
    this.pulse2 = this._initPulse();
    this.pcmValue = 0; // $5011: raw 8-bit PCM output
    this.pcmReadMode = false; // $5010 bit 0
    this.pcmIrqEnabled = false; // $5010 bit 7
    this.audioEnabled = 0; // $5015: pulse channel enable bits

    // Tracks which CHR bank set is currently loaded into the PPU's pattern
    // table cache. Used by onBgRender/onSpriteRender to avoid redundant
    // bank switches. -1 = unknown/dirty, 0 = set A (sprites), 1 = set B (BG).
    this._chrBankTarget = -1;
  }

  // Initialize a pulse channel state object.
  // MMC5 pulse channels are like APU square channels minus the sweep unit.
  _initPulse() {
    return {
      enabled: false,
      dutyCycle: 0, // 2-bit duty
      lengthHalt: false, // envelope loop / length counter halt
      constantVolume: false,
      volume: 0, // 4-bit volume/envelope
      timer: 0, // 11-bit timer period
      timerCounter: 0,
      lengthCounter: 0,
      envelopeCounter: 0,
      envelopeDecay: 15,
      envelopeStart: false,
      sequencePos: 0,
    };
  }

  // --- CPU Read Handler ---
  // Override load() to handle MMC5 register reads and banked PRG access.
  load(address) {
    address &= 0xffff;

    if (address < 0x5000) {
      // Standard read (RAM, PPU regs, APU regs, controllers)
      return super.load(address);
    }

    // $5000-$5017: Expansion audio read-back
    if (address === 0x5015) {
      // Status register: bits 0-1 indicate pulse channel length counter > 0
      let val = 0;
      if (this.pulse1.lengthCounter > 0) val |= 0x01;
      if (this.pulse2.lengthCounter > 0) val |= 0x02;
      return val;
    }

    if (address === 0x5010) {
      // PCM IRQ status (bit 7). Reading clears the flag.
      // PCM IRQ is rarely used; return 0 for now.
      return 0;
    }

    // $5100-$5104: Write-only control registers — return open bus
    if (address >= 0x5100 && address <= 0x5104) {
      return this.nes.cpu.dataBus;
    }

    // $5105: Nametable mapping (write-only, open bus on read)
    if (address === 0x5105) {
      return this.nes.cpu.dataBus;
    }

    // $5204: Scanline IRQ status
    if (address === 0x5204) {
      // The in-frame flag reflects whether the PPU is actively rendering.
      // Since the PPU only calls clockIrqCounter during rendering, we check
      // the current PPU state to determine in-frame for reads outside rendering.
      let ppu = this.nes.ppu;
      let rendering =
        ppu.scanline >= 20 &&
        ppu.scanline <= 260 &&
        (ppu.f_bgVisibility === 1 || ppu.f_spVisibility === 1);
      if (!rendering) {
        this.inFrame = false;
      }

      let val = 0;
      if (this.irqPending) val |= 0x80;
      if (this.inFrame) val |= 0x40;
      // Reading $5204 acknowledges (clears) the IRQ pending flag, which
      // releases the CPU's IRQ line.
      this.irqPending = false;
      this.nes.cpu.clearIrq();
      return val;
    }

    // $5205: Multiplier result low byte
    if (address === 0x5205) {
      return (this.multA * this.multB) & 0xff;
    }

    // $5206: Multiplier result high byte
    if (address === 0x5206) {
      return ((this.multA * this.multB) >> 8) & 0xff;
    }

    // $5C00-$5FFF: ExRAM
    if (address >= 0x5c00 && address <= 0x5fff) {
      // Readable in modes 2 and 3 only; otherwise open bus
      if (this.exramMode >= 2) {
        return this.exram[address - 0x5c00];
      }
      return this.nes.cpu.dataBus;
    }

    // $5000-$5BFF other: expansion area, return open bus
    if (address < 0x6000) {
      return this.nes.cpu.dataBus;
    }

    // $6000-$7FFF: PRG RAM (banked via $5113)
    if (address < 0x8000) {
      let bank = this.prgBankReg[0] & 0x07; // 3-bit page within 64K RAM
      let offset = bank * 0x2000 + (address - 0x6000);
      return this.prgRam[offset & 0xffff];
    }

    // $8000-$FFFF: PRG ROM/RAM (banked via $5114-$5117 and prgMode)
    return this._readPrg(address);
  }

  // Read from banked PRG space ($8000-$FFFF).
  // In modes where a region can map to RAM (bit 7 of bank reg = 0),
  // reads come from prgRam. Otherwise, reads come from ROM.
  _readPrg(address) {
    let slot, reg, isRam, bank, base;

    switch (this.prgMode) {
      case 0:
        // Mode 0: One 32K bank at $8000-$FFFF, controlled by $5117
        // Ignore low 2 bits for 32K alignment
        reg = this.prgBankReg[4];
        bank = (reg & 0x7c) >> 2; // 32K page = bits 6-2
        return this._readPrgRom32k(bank, address - 0x8000);

      case 1:
        // Mode 1: Two 16K banks
        // $8000-$BFFF: $5115 (can be RAM if bit 7=0)
        // $C000-$FFFF: $5117 (always ROM)
        if (address < 0xc000) {
          reg = this.prgBankReg[2]; // $5115
          isRam = (reg & 0x80) === 0;
          if (isRam) {
            bank = (reg & 0x06) >> 1; // 16K RAM page
            return this.prgRam[bank * 0x4000 + (address - 0x8000)];
          }
          bank = (reg & 0x7e) >> 1; // 16K ROM page (ignore bit 0)
          return this._readPrgRom16k(bank, address - 0x8000);
        } else {
          reg = this.prgBankReg[4]; // $5117
          bank = (reg & 0x7e) >> 1; // 16K ROM page
          return this._readPrgRom16k(bank, address - 0xc000);
        }

      case 2:
        // Mode 2: 16K + 8K + 8K
        // $8000-$BFFF: $5115 (RAM or ROM)
        // $C000-$DFFF: $5116 (RAM or ROM)
        // $E000-$FFFF: $5117 (always ROM)
        if (address < 0xc000) {
          reg = this.prgBankReg[2]; // $5115
          isRam = (reg & 0x80) === 0;
          if (isRam) {
            bank = (reg & 0x06) >> 1;
            return this.prgRam[bank * 0x4000 + (address - 0x8000)];
          }
          bank = (reg & 0x7e) >> 1;
          return this._readPrgRom16k(bank, address - 0x8000);
        } else if (address < 0xe000) {
          reg = this.prgBankReg[3]; // $5116
          isRam = (reg & 0x80) === 0;
          if (isRam) {
            bank = reg & 0x07;
            return this.prgRam[bank * 0x2000 + (address - 0xc000)];
          }
          bank = reg & 0x7f;
          return this._readPrgRom8k(bank, address - 0xc000);
        } else {
          reg = this.prgBankReg[4]; // $5117
          bank = reg & 0x7f;
          return this._readPrgRom8k(bank, address - 0xe000);
        }

      case 3:
      default:
        // Mode 3: Four 8K banks
        // $8000-$9FFF: $5114 (RAM or ROM)
        // $A000-$BFFF: $5115 (RAM or ROM)
        // $C000-$DFFF: $5116 (RAM or ROM)
        // $E000-$FFFF: $5117 (always ROM)
        if (address < 0xa000) {
          slot = 1; // $5114
        } else if (address < 0xc000) {
          slot = 2; // $5115
        } else if (address < 0xe000) {
          slot = 3; // $5116
        } else {
          slot = 4; // $5117
        }
        reg = this.prgBankReg[slot];
        base =
          slot === 1
            ? 0x8000
            : slot === 2
              ? 0xa000
              : slot === 3
                ? 0xc000
                : 0xe000;
        // $5117 is always ROM; $5114-$5116 use bit 7 for RAM/ROM select
        if (slot < 4 && (reg & 0x80) === 0) {
          bank = reg & 0x07;
          return this.prgRam[bank * 0x2000 + (address - base)];
        }
        bank = reg & 0x7f;
        return this._readPrgRom8k(bank, address - base);
    }
  }

  // Read a byte from PRG ROM given a 32K bank number and offset within it.
  _readPrgRom32k(bank32k, offset) {
    // ROM is stored as 16K banks in rom.rom[]
    let bank16k =
      (bank32k * 2 + Math.floor(offset / 0x4000)) % this.nes.rom.romCount;
    let innerOffset = offset % 0x4000;
    return this.nes.rom.rom[bank16k][innerOffset];
  }

  // Read a byte from PRG ROM given a 16K bank number and offset within it.
  _readPrgRom16k(bank16k, offset) {
    bank16k %= this.nes.rom.romCount;
    return this.nes.rom.rom[bank16k][offset];
  }

  // Read a byte from PRG ROM given an 8K bank number and offset within it.
  _readPrgRom8k(bank8k, offset) {
    let bank16k = Math.floor(bank8k / 2) % this.nes.rom.romCount;
    let innerOffset = (bank8k % 2) * 0x2000 + offset;
    if (bank16k < this.nes.rom.romCount) {
      return this.nes.rom.rom[bank16k][innerOffset];
    }
    return 0;
  }

  // --- CPU Write Handler ---
  write(address, value) {
    // Standard NES write handling for addresses below $5000
    if (address < 0x5000) {
      super.write(address, value);

      // MMC5 monitors writes to $2000 to track 8x8 vs 8x16 sprite mode.
      // This affects which CHR bank set is used for rendering.
      // The PPU already parses $2000, so we just note it here.
      return;
    }

    // $5000-$5015: Expansion audio registers
    if (address >= 0x5000 && address <= 0x5003) {
      this._writePulse(this.pulse1, address - 0x5000, value);
      return;
    }
    if (address >= 0x5004 && address <= 0x5007) {
      this._writePulse(this.pulse2, address - 0x5004, value);
      return;
    }
    if (address === 0x5010) {
      this.pcmReadMode = (value & 0x01) !== 0;
      this.pcmIrqEnabled = (value & 0x80) !== 0;
      return;
    }
    if (address === 0x5011) {
      // Raw PCM write. Writing $00 has no effect on the output.
      if (!this.pcmReadMode && value !== 0) {
        this.pcmValue = value;
      }
      return;
    }
    if (address === 0x5015) {
      // Expansion audio status: bits 0-1 enable pulse channels
      this.audioEnabled = value & 0x03;
      this.pulse1.enabled = (value & 0x01) !== 0;
      this.pulse2.enabled = (value & 0x02) !== 0;
      if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0;
      if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
      return;
    }

    // $5100: PRG banking mode
    if (address === 0x5100) {
      this.prgMode = value & 0x03;
      this._syncPrg();
      return;
    }

    // $5101: CHR banking mode
    if (address === 0x5101) {
      this.chrMode = value & 0x03;
      this._syncChr();
      return;
    }

    // $5102/$5103: PRG RAM write protection
    if (address === 0x5102) {
      this.prgRamProtectA = value & 0x03;
      return;
    }
    if (address === 0x5103) {
      this.prgRamProtectB = value & 0x03;
      return;
    }

    // $5104: ExRAM mode
    if (address === 0x5104) {
      this.exramMode = value & 0x03;
      // ExRAM mode 1 enables per-tile BG override: each ExRAM byte provides
      // a 4KB CHR bank + attribute for the corresponding background tile.
      this.bgTileOverride = this.exramMode === 1;
      this._syncNametables();
      return;
    }

    // $5105: Nametable mapping
    if (address === 0x5105) {
      let v = value;
      this.ntMapping[0] = v & 0x03;
      v >>= 2;
      this.ntMapping[1] = v & 0x03;
      v >>= 2;
      this.ntMapping[2] = v & 0x03;
      v >>= 2;
      this.ntMapping[3] = v & 0x03;
      this._syncNametables();
      return;
    }

    // $5106: Fill-mode tile
    if (address === 0x5106) {
      this.fillTile = value;
      this._syncNametables();
      return;
    }

    // $5107: Fill-mode attribute (bottom 2 bits)
    if (address === 0x5107) {
      this.fillAttr = value & 0x03;
      this._syncNametables();
      return;
    }

    // $5113: PRG RAM bank for $6000-$7FFF
    if (address === 0x5113) {
      this.prgBankReg[0] = value & 0x07;
      return;
    }

    // $5114-$5117: PRG bank registers
    if (address >= 0x5114 && address <= 0x5117) {
      let idx = address - 0x5113; // 1-4
      this.prgBankReg[idx] = value;
      this._syncPrg();
      return;
    }

    // $5120-$5127: CHR bank set A (sprites / "last written" set)
    if (address >= 0x5120 && address <= 0x5127) {
      let reg = address - 0x5120;
      this.chrBankA[reg] = (this.chrUpperBits << 8) | value;
      this.lastChrWrite = 0;
      this._syncChr();
      return;
    }

    // $5128-$512B: CHR bank set B (background)
    if (address >= 0x5128 && address <= 0x512b) {
      let reg = address - 0x5128;
      this.chrBankB[reg] = (this.chrUpperBits << 8) | value;
      this.lastChrWrite = 1;
      this._syncChr();
      return;
    }

    // $5130: Upper CHR bank bits
    if (address === 0x5130) {
      this.chrUpperBits = value & 0x03;
      return;
    }

    // $5200: Split screen control
    if (address === 0x5200) {
      this.splitEnabled = (value & 0x80) !== 0;
      this.splitRight = (value & 0x40) !== 0;
      this.splitTile = value & 0x1f;
      return;
    }

    // $5201: Split screen Y scroll
    if (address === 0x5201) {
      this.splitScroll = value;
      return;
    }

    // $5202: Split screen CHR page
    if (address === 0x5202) {
      this.splitPage = value & 0x3f;
      return;
    }

    // $5203: Scanline IRQ target
    if (address === 0x5203) {
      this.irqTarget = value;
      return;
    }

    // $5204: Scanline IRQ enable
    if (address === 0x5204) {
      this.irqEnabled = (value & 0x80) !== 0;
      // The IRQ line is asserted while an IRQ is both pending and enabled.
      if (this.irqEnabled && this.irqPending) {
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
      } else if (!this.irqEnabled) {
        this.nes.cpu.clearIrq();
      }
      return;
    }

    // $5205: Multiplier operand A
    if (address === 0x5205) {
      this.multA = value;
      return;
    }

    // $5206: Multiplier operand B
    if (address === 0x5206) {
      this.multB = value;
      return;
    }

    // $5C00-$5FFF: ExRAM writes
    if (address >= 0x5c00 && address <= 0x5fff) {
      let exAddr = address - 0x5c00;
      if (this.exramMode === 0 || this.exramMode === 1) {
        // Modes 0/1: writable only during rendering (in-frame).
        // If not in-frame, $00 is written instead.
        this.exram[exAddr] = this.inFrame ? value : 0x00;
        // If ExRAM is used as a nametable, sync it to VRAM
        this._syncExramToVram(exAddr);
      } else if (this.exramMode === 2) {
        // Mode 2: general-purpose RAM, always writable
        this.exram[exAddr] = value;
      }
      // Mode 3: read-only, writes have no effect
      return;
    }

    // $6000-$7FFF: PRG RAM writes (write-protected via $5102/$5103)
    if (address >= 0x6000 && address <= 0x7fff) {
      if (this.prgRamProtectA === 0x02 && this.prgRamProtectB === 0x01) {
        let bank = this.prgBankReg[0] & 0x07;
        let offset = bank * 0x2000 + (address - 0x6000);
        this.prgRam[offset & 0xffff] = value;
        // Also write to CPU mem for compatibility with save state / battery RAM
        this.nes.cpu.mem[address] = value;
        this.nes.opts.onBatteryRamWrite(address, value);
      }
      return;
    }

    // $8000-$FFFF: PRG ROM/RAM writes
    if (address >= 0x8000) {
      this._writePrg(address, value);
      return;
    }
  }

  // Handle writes to the PRG address space ($8000-$FFFF).
  // Some bank slots may be mapped to RAM if bit 7 of the bank register is 0.
  _writePrg(address, value) {
    let slot, reg, isRam, bank, base;

    switch (this.prgMode) {
      case 0:
        // Mode 0: Entire $8000-$FFFF is a single 32K ROM bank — not writable
        return;

      case 1:
        // $8000-$BFFF: $5115 (can be RAM)
        // $C000-$FFFF: $5117 (always ROM)
        if (address < 0xc000) {
          reg = this.prgBankReg[2];
          isRam = (reg & 0x80) === 0;
          if (isRam && this._isPrgRamWritable()) {
            bank = (reg & 0x06) >> 1;
            this.prgRam[bank * 0x4000 + (address - 0x8000)] = value;
          }
        }
        return;

      case 2:
        // $8000-$BFFF: $5115 (can be RAM)
        // $C000-$DFFF: $5116 (can be RAM)
        // $E000-$FFFF: $5117 (always ROM)
        if (address < 0xc000) {
          reg = this.prgBankReg[2];
          isRam = (reg & 0x80) === 0;
          if (isRam && this._isPrgRamWritable()) {
            bank = (reg & 0x06) >> 1;
            this.prgRam[bank * 0x4000 + (address - 0x8000)] = value;
          }
        } else if (address < 0xe000) {
          reg = this.prgBankReg[3];
          isRam = (reg & 0x80) === 0;
          if (isRam && this._isPrgRamWritable()) {
            bank = reg & 0x07;
            this.prgRam[bank * 0x2000 + (address - 0xc000)] = value;
          }
        }
        return;

      case 3:
      default:
        // $8000-$9FFF: $5114 (can be RAM)
        // $A000-$BFFF: $5115 (can be RAM)
        // $C000-$DFFF: $5116 (can be RAM)
        // $E000-$FFFF: $5117 (always ROM)
        if (address < 0xa000) {
          slot = 1;
          base = 0x8000;
        } else if (address < 0xc000) {
          slot = 2;
          base = 0xa000;
        } else if (address < 0xe000) {
          slot = 3;
          base = 0xc000;
        } else {
          return; // $5117 is always ROM
        }
        reg = this.prgBankReg[slot];
        isRam = (reg & 0x80) === 0;
        if (isRam && this._isPrgRamWritable()) {
          bank = reg & 0x07;
          this.prgRam[bank * 0x2000 + (address - base)] = value;
        }
        return;
    }
  }

  // Check if PRG RAM writes are enabled via the two protection registers.
  _isPrgRamWritable() {
    return this.prgRamProtectA === 0x02 && this.prgRamProtectB === 0x01;
  }

  // --- PRG Synchronization ---
  // Copy the selected PRG ROM banks into CPU address space so the CPU can
  // read them directly. This follows the same approach as other mappers.
  // Called when prgMode or bank registers change.
  _syncPrg() {
    switch (this.prgMode) {
      case 0: {
        // 32K bank at $8000-$FFFF from $5117
        let reg = this.prgBankReg[4];
        let bank = (reg & 0x7c) >> 2; // 32K page
        this.load32kRomBank(bank, 0x8000);
        break;
      }
      case 1: {
        // $8000-$BFFF from $5115, $C000-$FFFF from $5117
        let regLo = this.prgBankReg[2]; // $5115
        if (regLo & 0x80) {
          // ROM
          let bank16k = (regLo & 0x7e) >> 1;
          this.loadRomBank(bank16k % this.nes.rom.romCount, 0x8000);
        }
        // else: RAM — reads will be handled by load() override

        let regHi = this.prgBankReg[4]; // $5117
        let bank16kHi = (regHi & 0x7e) >> 1;
        this.loadRomBank(bank16kHi % this.nes.rom.romCount, 0xc000);
        break;
      }
      case 2: {
        // $8000-$BFFF from $5115, $C000-$DFFF from $5116, $E000-$FFFF from $5117
        let regA = this.prgBankReg[2]; // $5115
        if (regA & 0x80) {
          let bank16k = (regA & 0x7e) >> 1;
          this.loadRomBank(bank16k % this.nes.rom.romCount, 0x8000);
        }

        let regB = this.prgBankReg[3]; // $5116
        if (regB & 0x80) {
          this.load8kRomBank(regB & 0x7f, 0xc000);
        }

        let regC = this.prgBankReg[4]; // $5117
        this.load8kRomBank(regC & 0x7f, 0xe000);
        break;
      }
      case 3:
      default: {
        // Four 8K banks from $5114-$5117
        for (let i = 1; i <= 4; i++) {
          let reg = this.prgBankReg[i];
          let addr = 0x6000 + i * 0x2000; // $8000, $A000, $C000, $E000
          // $5117 (i=4) is always ROM; $5114-$5116 check bit 7
          if (i === 4 || reg & 0x80) {
            this.load8kRomBank(reg & 0x7f, addr);
          }
          // RAM banks are handled dynamically in load()
        }
        break;
      }
    }
  }

  // --- CHR Synchronization ---
  // Apply the current CHR bank registers to PPU pattern table memory.
  // See https://www.nesdev.org/wiki/MMC5#CHR_banking
  _syncChr() {
    // Trigger rendering before changing banks, so any accumulated scanlines
    // are drawn with the OLD CHR bank values. This is important for mid-frame
    // bank switches (e.g. via scanline IRQ handlers that change CHR registers
    // before writing to PPU scroll registers).
    this.nes.ppu.triggerRendering();

    // Invalidate cached CHR bank target so the render hooks re-apply
    // when rendering starts.
    this._chrBankTarget = -1;

    if (this.nes.ppu.f_spriteSize === 0) {
      // 8x8 sprite mode: only bank set A is used for ALL fetches (sprites,
      // backgrounds, and $2007 reads). Bank set B is completely ignored.
      // This was confirmed by hardware tests — see FCEUX bug #787.
      this._applyChrSetA();
      this._chrBankTarget = 0;
    }
    // In 8x16 sprite mode, the onBgRender/onSpriteRender hooks handle
    // switching between set A (sprites) and set B (backgrounds) during
    // rendering. Outside rendering (VBlank), $2007 reads use whichever
    // set was last loaded by the hooks — this is an acceptable simplification
    // since we can't call load*VromBank here (it triggers triggerRendering).
  }

  // Apply CHR bank set A ($5120-$5127) based on chrMode.
  _applyChrSetA() {
    if (this.nes.rom.vromCount === 0) return;

    switch (this.chrMode) {
      case 0:
        // 8K mode: $5127 selects an 8K page
        this.load8kVromBank((this.chrBankA[7] & 0xff) * 2, 0x0000);
        break;
      case 1:
        // 4K mode: $5123 selects 4K at $0000, $5127 selects 4K at $1000
        this.loadVromBank(this.chrBankA[3] & 0xff, 0x0000);
        this.loadVromBank(this.chrBankA[7] & 0xff, 0x1000);
        break;
      case 2:
        // 2K mode: $5121/$5123/$5125/$5127 each select 2K
        this.load2kVromBank(this.chrBankA[1] & 0x1ff, 0x0000);
        this.load2kVromBank(this.chrBankA[3] & 0x1ff, 0x0800);
        this.load2kVromBank(this.chrBankA[5] & 0x1ff, 0x1000);
        this.load2kVromBank(this.chrBankA[7] & 0x1ff, 0x1800);
        break;
      case 3:
      default:
        // 1K mode: $5120-$5127 each select a 1K page
        for (let i = 0; i < 8; i++) {
          this.load1kVromBank(this.chrBankA[i] & 0x3ff, i * 0x0400);
        }
        break;
    }
  }

  // Apply CHR bank set B ($5128-$512B) based on chrMode.
  // Set B uses only 4 registers, so larger modes replicate them.
  _applyChrSetB() {
    if (this.nes.rom.vromCount === 0) return;

    switch (this.chrMode) {
      case 0:
        // 8K mode: $512B selects an 8K page
        this.load8kVromBank((this.chrBankB[3] & 0xff) * 2, 0x0000);
        break;
      case 1:
        // 4K mode: $512B selects 4K at both halves
        this.loadVromBank(this.chrBankB[3] & 0xff, 0x0000);
        this.loadVromBank(this.chrBankB[3] & 0xff, 0x1000);
        break;
      case 2:
        // 2K mode: $5129/$512B each select 2K, replicated across 8K
        this.load2kVromBank(this.chrBankB[1] & 0x1ff, 0x0000);
        this.load2kVromBank(this.chrBankB[3] & 0x1ff, 0x0800);
        this.load2kVromBank(this.chrBankB[1] & 0x1ff, 0x1000);
        this.load2kVromBank(this.chrBankB[3] & 0x1ff, 0x1800);
        break;
      case 3:
      default:
        // 1K mode: $5128-$512B each select 1K, replicated for both halves
        for (let i = 0; i < 4; i++) {
          this.load1kVromBank(this.chrBankB[i] & 0x3ff, i * 0x0400);
          this.load1kVromBank(this.chrBankB[i] & 0x3ff, (i + 4) * 0x0400);
        }
        break;
    }
  }

  // --- Nametable Synchronization ---
  // Configure the PPU's vramMirrorTable AND internal NameTable objects to
  // reflect the MMC5's nametable mapping. Each of the 4 nametable slots
  // ($2000/$2400/$2800/$2C00) can be mapped to:
  //   0: NES CIRAM page A ($2000)
  //   1: NES CIRAM page B ($2400)
  //   2: ExRAM (internal 1KB, stored at $2800 in VRAM)
  //   3: Fill mode (stored at $2C00 in VRAM)
  //
  // IMPORTANT: The PPU uses TWO parallel data structures for nametables:
  //   1. vramMem[] + vramMirrorTable[] — raw bytes, for $2007 VRAM reads
  //   2. nameTable[0-3] + ntable1[0-3] — parsed tile/attrib, for rendering
  // We must update BOTH so the renderer sees the correct nametable data.
  // See https://www.nesdev.org/wiki/MMC5#Nametable_mapping
  _syncNametables() {
    let ppu = this.nes.ppu;

    // First, populate the fill-mode nametable at VRAM $2C00.
    // 960 bytes of tile index followed by 64 bytes of attribute.
    // The attribute byte packs the fill palette into all four sub-quadrants.
    let fillAttrByte =
      this.fillAttr |
      (this.fillAttr << 2) |
      (this.fillAttr << 4) |
      (this.fillAttr << 6);
    for (let i = 0; i < 960; i++) {
      ppu.vramMem[0x2c00 + i] = this.fillTile;
    }
    for (let i = 960; i < 1024; i++) {
      ppu.vramMem[0x2c00 + i] = fillAttrByte;
    }

    // Copy ExRAM into VRAM at $2800 for nametable use.
    // In modes 2/3 (general-purpose RAM), ExRAM reads as all zeros for nametable.
    if (this.exramMode >= 2) {
      for (let i = 0; i < 0x400; i++) {
        ppu.vramMem[0x2800 + i] = 0;
      }
    } else {
      copyArrayElements(this.exram, 0, ppu.vramMem, 0x2800, 0x400);
    }

    // Physical VRAM locations for each source:
    //   0 → $2000 (CIRAM A)
    //   1 → $2400 (CIRAM B)
    //   2 → $2800 (ExRAM copy)
    //   3 → $2C00 (Fill mode)
    const sourceBase = [0x2000, 0x2400, 0x2800, 0x2c00];

    for (let nt = 0; nt < 4; nt++) {
      let logicalBase = 0x2000 + nt * 0x400;
      let physBase = sourceBase[this.ntMapping[nt]];
      ppu.defineMirrorRegion(logicalBase, physBase, 0x400);
    }

    // Also mirror $3000-$3EFF → $2000-$2EFF as per normal NES behavior
    ppu.defineMirrorRegion(0x3000, 0x2000, 0xf00);

    // Update ntable1 so the renderer reads from the correct NameTable objects.
    // ntMapping values 0-3 map directly to NameTable indices 0-3:
    //   0 → NameTable 0 (CIRAM A, VRAM $2000)
    //   1 → NameTable 1 (CIRAM B, VRAM $2400)
    //   2 → NameTable 2 (ExRAM, VRAM $2800)
    //   3 → NameTable 3 (Fill, VRAM $2C00)
    for (let nt = 0; nt < 4; nt++) {
      ppu.ntable1[nt] = this.ntMapping[nt];
    }

    // Populate NameTable 2 with ExRAM data so the renderer can see it.
    // The PPU renderer reads from nameTable[].tile[] and nameTable[].attrib[],
    // NOT from vramMem directly, so we must sync both.
    this._populateNameTable(2, 0x2800);

    // Populate NameTable 3 with fill-mode data.
    this._populateNameTable(3, 0x2c00);
  }

  // Populate a NameTable object from a 1KB region of vramMem.
  // The first 960 bytes are tile indices, the next 64 are attribute table bytes.
  _populateNameTable(ntIndex, vramBase) {
    let ppu = this.nes.ppu;
    let nt = ppu.nameTable[ntIndex];

    // Copy tile indices (960 bytes = 30 rows × 32 columns)
    for (let i = 0; i < 960; i++) {
      nt.tile[i] = ppu.vramMem[vramBase + i];
    }

    // Decode attribute table (64 bytes) into per-tile attributes.
    // Each attribute byte controls a 4×4 tile area (32×32 pixels).
    for (let i = 0; i < 64; i++) {
      nt.writeAttrib(i, ppu.vramMem[vramBase + 960 + i]);
    }
  }

  // Sync a single ExRAM byte to both the VRAM copy at $2800 and NameTable 2.
  // Called when ExRAM is written via $5C00-$5FFF in modes 0/1.
  _syncExramToVram(exAddr) {
    if (this.exramMode < 2) {
      let ppu = this.nes.ppu;
      ppu.vramMem[0x2800 + exAddr] = this.exram[exAddr];

      // Also update NameTable 2 so the renderer sees the change.
      if (exAddr < 960) {
        // Tile index update
        ppu.nameTable[2].tile[exAddr] = this.exram[exAddr];
      } else if (exAddr < 1024) {
        // Attribute table update — decode into per-tile attributes
        ppu.nameTable[2].writeAttrib(exAddr - 960, this.exram[exAddr]);
      }
    }
  }

  // --- Expansion Audio ---
  // Write to a pulse channel register. Layout matches the NES APU square channels
  // ($4000-$4003) except that $5001/$5005 (sweep) has no effect on MMC5 pulses.
  _writePulse(pulse, reg, value) {
    switch (reg) {
      case 0:
        // $5000/$5004: Duty, length counter halt, constant volume, volume/envelope
        pulse.dutyCycle = (value >> 6) & 0x03;
        pulse.lengthHalt = (value & 0x20) !== 0;
        pulse.constantVolume = (value & 0x10) !== 0;
        pulse.volume = value & 0x0f;
        break;
      case 1:
        // $5001/$5005: Sweep — no effect on MMC5 pulse channels
        break;
      case 2:
        // $5002/$5006: Timer low 8 bits
        pulse.timer = (pulse.timer & 0x700) | value;
        break;
      case 3:
        // $5003/$5007: Length counter load, timer high 3 bits
        pulse.timer = (pulse.timer & 0x0ff) | ((value & 0x07) << 8);
        if (pulse.enabled) {
          pulse.lengthCounter = this.nes.papu.getLengthMax(value);
        }
        pulse.envelopeStart = true;
        pulse.sequencePos = 0;
        break;
    }
  }

  // --- Scanline IRQ Counter ---
  // Called by the PPU once per scanline when BG or sprites are enabled.
  // The PPU calls this at scanline 20 (pre-render) and scanlines 21-260 (visible).
  // The MMC5 uses an up-counter that resets when entering rendering and increments
  // each scanline, firing an IRQ when it matches the target value in $5203.
  // See https://www.nesdev.org/wiki/MMC5#Scanline_detection_and_scanline_IRQ
  clockIrqCounter() {
    let scanline = this.nes.ppu.scanline;

    if (scanline === 20) {
      // Pre-render scanline: entering active rendering.
      // Set in-frame and reset the scanline counter.
      this.inFrame = true;
      this.irqCounter = 0;
      return;
    }

    // Visible scanlines (21-260): increment counter and compare.
    this.irqCounter++;
    // $5203 value of 0 is a special case that never matches.
    if (this.irqTarget !== 0 && this.irqCounter === this.irqTarget) {
      this.irqPending = true;
      if (this.irqEnabled) {
        this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
      }
    }

    // Clock expansion audio length counters once per scanline.
    // The MMC5 has no frame sequencer; length counters run at a fixed rate
    // tied to scanline timing. We approximate by clocking every 4 scanlines
    // (~240 Hz, matching the APU frame counter quarter-frame rate).
    // See https://www.nesdev.org/wiki/MMC5_audio
    if ((this.irqCounter & 3) === 0) {
      this._clockPulseLengthCounter(this.pulse1);
      this._clockPulseLengthCounter(this.pulse2);
    }
  }

  // Decrement a pulse channel's length counter if it's active and not halted.
  _clockPulseLengthCounter(pulse) {
    if (pulse.enabled && !pulse.lengthHalt && pulse.lengthCounter > 0) {
      pulse.lengthCounter--;
    }
  }

  // --- CHR Bank Switching for Sprite/BG Phases ---
  // The MMC5 uses dual CHR bank sets in 8x16 sprite mode ($2000 bit 5 = 1):
  //   - Bank set A ($5120-$5127) is used for sprite pattern fetches
  //   - Bank set B ($5128-$512B) is used for background pattern fetches
  // In 8x8 sprite mode, only bank set A is used for all fetches.
  // The PPU calls these hooks before each rendering phase so we can swap
  // the pattern table data in the ptTile cache.
  // See https://www.nesdev.org/wiki/MMC5#CHR_banking

  onBgRender() {
    if (this.nes.ppu.f_spriteSize === 1 && this._chrBankTarget !== 1) {
      this._applyChrSetB();
      this._chrBankTarget = 1;
      // Invalidate the PPU's tile cache since we swapped CHR data
      this.nes.ppu.validTileData = false;
    }
  }

  onSpriteRender() {
    if (this.nes.ppu.f_spriteSize === 1 && this._chrBankTarget !== 0) {
      this._applyChrSetA();
      this._chrBankTarget = 0;
    }
  }

  // Look up a sprite pattern tile from Set A's VROM banks directly.
  // In 8x16 mode, ptTile may have BG data (Set B) during BG rendering,
  // but sprite 0 hit detection needs Set A data. This method reads from
  // the pre-decoded VROM tile cache without modifying ptTile or calling
  // load*VromBank (which would trigger triggerRendering).
  // In 8x8 mode, ptTile already has Set A data from _syncChr(), so we
  // just return from ptTile directly.
  // See FCEUX's mmc5_PPURead() which uses separate MMC5SPRVPage/MMC5BGVPage
  // arrays instead of copying banks back and forth.
  getSpritePatternTile(index) {
    // In 8x8 mode, ptTile has the correct Set A data already
    if (this.nes.ppu.f_spriteSize !== 1 || this.nes.rom.vromCount === 0) {
      return this.nes.ppu.ptTile[index];
    }

    // In 8x16 mode, look up the tile from Set A's VROM banks.
    // The index maps to a slot in the 8KB pattern table space:
    //   index 0-255 → $0000-$0FFF, index 256-511 → $1000-$1FFF
    let vromCount = this.nes.rom.vromCount;
    let vromTile = this.nes.rom.vromTile;

    switch (this.chrMode) {
      case 0: {
        // 8K mode: chrBankA[7] selects an 8K page (two 4K banks)
        let bank4kStart = (this.chrBankA[7] & 0xff) * 2;
        let half = index >= 256 ? 1 : 0;
        let bank4k = (bank4kStart + half) % vromCount;
        return vromTile[bank4k][index - half * 256];
      }
      case 1: {
        // 4K mode: chrBankA[3] → $0000, chrBankA[7] → $1000
        let bank4k;
        if (index < 256) {
          bank4k = (this.chrBankA[3] & 0xff) % vromCount;
        } else {
          bank4k = (this.chrBankA[7] & 0xff) % vromCount;
        }
        return vromTile[bank4k][index % 256];
      }
      case 2: {
        // 2K mode: chrBankA[1]/[3]/[5]/[7] select four 2K chunks (128 tiles each)
        let regIndex = [1, 3, 5, 7];
        let slot = index >> 7; // 0-3
        let tileInSlot = index & 127;
        let bank2k = this.chrBankA[regIndex[slot]] & 0x1ff;
        let bank4k = Math.floor(bank2k / 2) % vromCount;
        return vromTile[bank4k][((bank2k % 2) << 7) + tileInSlot];
      }
      case 3:
      default: {
        // 1K mode: chrBankA[0-7] each select a 1K chunk (64 tiles each)
        let slot = index >> 6; // 0-7
        let tileInSlot = index & 63;
        let bank1k = this.chrBankA[slot] & 0x3ff;
        let bank4k = Math.floor(bank1k / 4) % vromCount;
        return vromTile[bank4k][((bank1k % 4) << 6) + tileInSlot];
      }
    }
  }

  // ExRAM mode 1 (extended attributes): per-tile CHR bank and palette override.
  // Each byte in ExRAM at $5C00-$5FFF corresponds to a nametable tile position:
  //   Bits 5-0: 4KB CHR bank number (combined with $5130 upper bits)
  //   Bits 7-6: Palette/attribute number for this tile
  // This replaces both the normal CHR bank set B and the attribute table for
  // background tiles, allowing each tile to independently select from up to
  // 16,384 unique background tiles. Used by Castlevania III for detailed BGs.
  // See https://www.nesdev.org/wiki/MMC5#Extended_RAM
  getBgTileData(baseTile, tileIndex, ht, vt) {
    if (this.exramMode !== 1 || this.nes.rom.vromCount === 0) return null;

    // ExRAM byte for this nametable tile position
    let exAddr = vt * 32 + ht;
    let exByte = this.exram[exAddr];

    // Bits 5-0 select a 4KB CHR bank, combined with chrUpperBits ($5130)
    // to form the full bank number: (upper << 6) | (exByte & 0x3F)
    let chrBank4k = (exByte & 0x3f) | (this.chrUpperBits << 6);
    let bank4k = chrBank4k % this.nes.rom.vromCount;

    // Look up the pre-decoded tile from VROM. The tile index (0-255) from
    // the nametable directly indexes into the selected 4KB bank.
    let tile = this.nes.rom.vromTile[bank4k][tileIndex];
    if (!tile) return null;

    // Bits 7-6 provide the attribute (palette number), replacing the
    // normal attribute table. Shift left by 2 to match PPU palette format.
    let attrib = ((exByte >> 6) & 0x03) << 2;

    return { tile, attrib };
  }

  // --- ROM Loading ---
  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("MMC5: Invalid ROM! Unable to load.");
    }

    // Default PRG banking: last bank at $E000-$FFFF (mode 3 default)
    this.prgBankReg[4] = 0xff;
    this._syncPrg();

    // Load CHR-ROM if present
    this.loadCHRROM();

    // Load Battery RAM (if present)
    this.loadBatteryRam();

    // Initialize nametable mapping (default to vertical mirroring pattern)
    this._syncNametables();

    // Reset interrupt
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  // --- Save State Support ---
  toJSON() {
    let s = super.toJSON();
    s.prgMode = this.prgMode;
    s.prgBankReg = Array.from(this.prgBankReg);
    s.prgRam = Array.from(this.prgRam);
    s.prgRamProtectA = this.prgRamProtectA;
    s.prgRamProtectB = this.prgRamProtectB;
    s.chrMode = this.chrMode;
    s.chrBankA = Array.from(this.chrBankA);
    s.chrBankB = Array.from(this.chrBankB);
    s.chrUpperBits = this.chrUpperBits;
    s.lastChrWrite = this.lastChrWrite;
    s.ntMapping = Array.from(this.ntMapping);
    s.exramMode = this.exramMode;
    s.exram = Array.from(this.exram);
    s.fillTile = this.fillTile;
    s.fillAttr = this.fillAttr;
    s.irqTarget = this.irqTarget;
    s.irqEnabled = this.irqEnabled;
    s.irqPending = this.irqPending;
    s.inFrame = this.inFrame;
    s.irqCounter = this.irqCounter;
    s.multA = this.multA;
    s.multB = this.multB;
    s.splitEnabled = this.splitEnabled;
    s.splitRight = this.splitRight;
    s.splitTile = this.splitTile;
    s.splitScroll = this.splitScroll;
    s.splitPage = this.splitPage;
    s.pcmValue = this.pcmValue;
    s.pcmReadMode = this.pcmReadMode;
    s.pcmIrqEnabled = this.pcmIrqEnabled;
    s.audioEnabled = this.audioEnabled;
    s.pulse1 = Object.assign({}, this.pulse1);
    s.pulse2 = Object.assign({}, this.pulse2);
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.prgMode = s.prgMode;
    this.prgBankReg = new Uint8Array(s.prgBankReg);
    this.prgRam = new Uint8Array(s.prgRam);
    this.prgRamProtectA = s.prgRamProtectA;
    this.prgRamProtectB = s.prgRamProtectB;
    this.chrMode = s.chrMode;
    this.chrBankA = new Uint16Array(s.chrBankA);
    this.chrBankB = new Uint16Array(s.chrBankB);
    this.chrUpperBits = s.chrUpperBits;
    this.lastChrWrite = s.lastChrWrite;
    this.ntMapping = new Uint8Array(s.ntMapping);
    this.exramMode = s.exramMode;
    // Per-tile BG data (extended attributes) is only used in ExRAM mode 1.
    this.bgTileOverride = this.exramMode === 1;
    this.exram = new Uint8Array(s.exram);
    this.fillTile = s.fillTile;
    this.fillAttr = s.fillAttr;
    this.irqTarget = s.irqTarget;
    this.irqEnabled = s.irqEnabled;
    this.irqPending = s.irqPending;
    this.inFrame = s.inFrame;
    this.irqCounter = s.irqCounter;
    this.multA = s.multA;
    this.multB = s.multB;
    this.splitEnabled = s.splitEnabled;
    this.splitRight = s.splitRight;
    this.splitTile = s.splitTile;
    this.splitScroll = s.splitScroll;
    this.splitPage = s.splitPage;
    this.pcmValue = s.pcmValue;
    this.pcmReadMode = s.pcmReadMode;
    this.pcmIrqEnabled = s.pcmIrqEnabled;
    this.audioEnabled = s.audioEnabled;
    if (s.pulse1) this.pulse1 = Object.assign(this._initPulse(), s.pulse1);
    if (s.pulse2) this.pulse2 = Object.assign(this._initPulse(), s.pulse2);

    // Re-sync banks after loading state
    this._syncPrg();
    this._syncChr();
    this._syncNametables();
  }
}

__exp.default = Mapper5;


return __exp;
}
function __m_mappers_mapper66_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// GxROM (NES-GNROM, NES-MHROM)
// Used by games like Doraemon, Dragon Power, Gumshoe, Super Mario Bros. + Duck Hunt.
// Discrete mapper with 32 KB PRG and 8 KB CHR bank switching via a single register
// at $8000-$FFFF. Bits 4-5 select PRG bank, bits 0-1 select CHR bank.
// See https://www.nesdev.org/wiki/GxROM
class Mapper66 extends Mapper0 {
  static mapperName = "GxROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // Swap in the given PRG-ROM bank at 0x8000:
      this.load32kRomBank((value >> 4) & 3, 0x8000);

      // Swap in the given VROM bank at 0x0000:
      this.load8kVromBank((value & 3) * 2, 0x0000);
    }
  }
}

__exp.default = Mapper66;


return __exp;
}
function __m_mappers_mapper7_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// AxROM (NES-AMROM, NES-ANROM, NES-AOROM)
// Used by games like Battletoads, Marble Madness, Wizards & Warriors.
// 32 KB switchable PRG-ROM bank (bits 0-2) with single-screen nametable mirroring
// select (bit 4). Uses CHR-RAM, no CHR bank switching.
// See https://www.nesdev.org/wiki/AxROM
class Mapper7 extends Mapper0 {
  static mapperName = "AxROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
    } else {
      this.load32kRomBank(value & 0x7, 0x8000);
      if (value & 0x10) {
        this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING2);
      } else {
        this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING);
      }
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("AOROM: Invalid ROM! Unable to load.");
    }

    // Load PRG-ROM:
    this.loadPRGROM();

    // Load CHR-ROM:
    this.loadCHRROM();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

__exp.default = Mapper7;


return __exp;
}
function __m_mappers_mapper71_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// Camerica/Codemasters mapper (BF9093/BF9097)
// Used by games like Fire Hawk, Micro Machines, Bee 52, MiG 29, etc.
// Largely a clone of UxROM with optional 1-screen mirroring control.
// See https://www.nesdev.org/wiki/INES_Mapper_071
class Mapper71 extends Mapper0 {
  static mapperName = "Camerica";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    if (address >= 0x9000 && address < 0xa000) {
      // $9000-$9FFF: 1-screen mirroring control (Fire Hawk / BF9097 variant)
      // Bit 4 selects which CIRAM nametable to fill all four screen slots
      if (value & 0x10) {
        this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING2);
      } else {
        this.nes.ppu.setMirroring(this.nes.rom.SINGLESCREEN_MIRRORING);
      }
    } else if (address >= 0xc000) {
      // $C000-$FFFF: PRG bank select (bits 3-0 select 16 KiB bank at $8000)
      this.loadRomBank(value & 0x0f, 0x8000);
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("Mapper 71: Invalid ROM! Unable to load.");
    }

    // Load first PRG bank at $8000, last at $C000 (fixed)
    this.loadRomBank(0, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);

    // Load CHR-ROM (usually CHR-RAM, so this may be a no-op)
    this.loadCHRROM();

    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

__exp.default = Mapper71;


return __exp;
}
function __m_mappers_mapper79_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// NINA-03/NINA-06 (American Video Entertainment)
// Used by games like Tiles of Fate, Krazy Kreatures, Impossible Mission II.
// GxROM-like mapper with the register in the expansion area ($4100-$5FFF)
// instead of the cartridge space. Address decode: (addr & $E100) == $4100.
// Register format: .... PCCC
//   P (bit 3): selects 32 KB PRG bank
//   CCC (bits 0-2): selects 8 KB CHR bank
// See https://www.nesdev.org/wiki/INES_Mapper_079
class Mapper79 extends Mapper0 {
  static mapperName = "NINA-03/NINA-06";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // The NINA register is active at addresses where (address & $E100) == $4100.
    // This covers $4100-$41FF, $4300-$43FF, $4500-$45FF, ... $5F00-$5FFF.
    if ((address & 0xe100) === 0x4100) {
      // Swap 32 KB PRG bank based on bit 3
      this.load32kRomBank((value >> 3) & 1, 0x8000);

      // Swap 8 KB CHR bank based on bits 0-2
      this.load8kVromBank((value & 7) * 2, 0x0000);
    }

    super.write(address, value);
  }
}

__exp.default = Mapper79;


return __exp;
}
function __m_mappers_mapper9_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// MMC2 (PNROM / PEEOROM)
// Used exclusively by Mike Tyson's Punch-Out!! (and Punch-Out!!).
// Features tile-triggered CHR bank switching: two independent 4 KB CHR latches
// automatically swap between two banks when the PPU fetches specific tiles ($FD/$FE).
// PRG: 8 KB switchable at $8000, three 8 KB fixed banks at $A000-$FFFF.
// See https://www.nesdev.org/wiki/MMC2
class Mapper9 extends Mapper0 {
  static mapperName = "MMC2";

  constructor(nes) {
    super(nes);

    // PRG bank register ($A000-$AFFF): selects 8 KB bank at $8000
    this.prgBank = 0;

    // CHR bank registers: each pattern table half has two possible banks,
    // selected by the corresponding latch state ($FD or $FE).
    this.chrBankFD0 = 0; // $B000: CHR bank for $0000 when latch0 = $FD
    this.chrBankFE0 = 0; // $C000: CHR bank for $0000 when latch0 = $FE
    this.chrBankFD1 = 0; // $D000: CHR bank for $1000 when latch1 = $FD
    this.chrBankFE1 = 0; // $E000: CHR bank for $1000 when latch1 = $FE

    // Latch states: $FD or $FE, one per pattern table half.
    // Both initialize to $FE on power-up.
    this.latch0 = 0xfe;
    this.latch1 = 0xfe;
  }

  write(address, value) {
    if (address < 0x8000) {
      super.write(address, value);
      return;
    }

    // Only the top nibble matters for register selection
    switch (address & 0xf000) {
      case 0xa000:
        // $A000-$AFFF: PRG bank select (bits 3-0 select 8 KB bank at $8000)
        this.prgBank = value & 0x0f;
        this.load8kRomBank(this.prgBank, 0x8000);
        break;

      case 0xb000:
        // $B000-$BFFF: CHR bank for $0000 when latch0 = $FD
        this.chrBankFD0 = value & 0x1f;
        this._updateChr0();
        break;

      case 0xc000:
        // $C000-$CFFF: CHR bank for $0000 when latch0 = $FE
        this.chrBankFE0 = value & 0x1f;
        this._updateChr0();
        break;

      case 0xd000:
        // $D000-$DFFF: CHR bank for $1000 when latch1 = $FD
        this.chrBankFD1 = value & 0x1f;
        this._updateChr1();
        break;

      case 0xe000:
        // $E000-$EFFF: CHR bank for $1000 when latch1 = $FE
        this.chrBankFE1 = value & 0x1f;
        this._updateChr1();
        break;

      case 0xf000:
        // $F000-$FFFF: Mirroring (bit 0: 0=vertical, 1=horizontal)
        if (value & 0x01) {
          this.nes.ppu.setMirroring(this.nes.rom.HORIZONTAL_MIRRORING);
        } else {
          this.nes.ppu.setMirroring(this.nes.rom.VERTICAL_MIRRORING);
        }
        break;
    }
  }

  // Load the correct CHR bank into $0000 based on latch0 state.
  _updateChr0() {
    let bank = this.latch0 === 0xfd ? this.chrBankFD0 : this.chrBankFE0;
    this.loadVromBank(bank, 0x0000);
  }

  // Load the correct CHR bank into $1000 based on latch1 state.
  _updateChr1() {
    let bank = this.latch1 === 0xfd ? this.chrBankFD1 : this.chrBankFE1;
    this.loadVromBank(bank, 0x1000);
  }

  // Called by the PPU when pattern table memory is accessed.
  // Updates the CHR latches based on the tile being fetched.
  // The latch switches AFTER the data has been read, so the
  // tile at $FD/$FE itself is rendered with the old bank.
  // See https://www.nesdev.org/wiki/MMC2#Latch_0_($0000-$0FFF)
  latchAccess(address) {
    // Only reload CHR banks when the latch state actually changes.
    // The same trigger tile may appear on many consecutive scanlines (e.g. a
    // column of $FD tiles in the nametable), and redundantly calling
    // loadVromBank on every fetch would copy 4 KB of VRAM each time.
    if (address === 0x0fd8) {
      // Latch 0 triggers on exactly $0FD8
      if (this.latch0 !== 0xfd) {
        this.latch0 = 0xfd;
        this._updateChr0();
      }
    } else if (address === 0x0fe8) {
      // Latch 0 triggers on exactly $0FE8
      if (this.latch0 !== 0xfe) {
        this.latch0 = 0xfe;
        this._updateChr0();
      }
    } else if (address >= 0x1fd8 && address <= 0x1fdf) {
      // Latch 1 triggers on $1FD8-$1FDF
      if (this.latch1 !== 0xfd) {
        this.latch1 = 0xfd;
        this._updateChr1();
      }
    } else if (address >= 0x1fe8 && address <= 0x1fef) {
      // Latch 1 triggers on $1FE8-$1FEF
      if (this.latch1 !== 0xfe) {
        this.latch1 = 0xfe;
        this._updateChr1();
      }
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("MMC2: Invalid ROM! Unable to load.");
    }

    // Load first switchable 8 KB PRG bank at $8000
    this.load8kRomBank(0, 0x8000);

    // Load the last three 8 KB PRG banks fixed at $A000-$FFFF
    let lastBank8k = (this.nes.rom.romCount - 1) * 2 + 1;
    this.load8kRomBank(lastBank8k - 2, 0xa000);
    this.load8kRomBank(lastBank8k - 1, 0xc000);
    this.load8kRomBank(lastBank8k, 0xe000);

    // Load CHR-ROM
    this.loadCHRROM();

    // Load Battery RAM (if present)
    this.loadBatteryRam();

    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }

  toJSON() {
    let s = super.toJSON();
    s.prgBank = this.prgBank;
    s.chrBankFD0 = this.chrBankFD0;
    s.chrBankFE0 = this.chrBankFE0;
    s.chrBankFD1 = this.chrBankFD1;
    s.chrBankFE1 = this.chrBankFE1;
    s.latch0 = this.latch0;
    s.latch1 = this.latch1;
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.prgBank = s.prgBank;
    this.chrBankFD0 = s.chrBankFD0;
    this.chrBankFE0 = s.chrBankFE0;
    this.chrBankFD1 = s.chrBankFD1;
    this.chrBankFE1 = s.chrBankFE1;
    this.latch0 = s.latch0;
    this.latch1 = s.latch1;
  }
}

__exp.default = Mapper9;


return __exp;
}
function __m_mappers_mapper94_js() {
const __exp = {};
const Mapper0 = __req("mappers/mapper0.js").default;

// UN1ROM (HVC-UN1ROM)
// Used by Senjou no Ookami (Commando).
// UxROM variant where the bank number is in bits 2-4 instead of bits 0-2.
// 16 KB switchable PRG-ROM at $8000, last 16 KB bank fixed at $C000.
// See https://www.nesdev.org/wiki/INES_Mapper_094
class Mapper94 extends Mapper0 {
  static mapperName = "UN1ROM";

  constructor(nes) {
    super(nes);
  }

  write(address, value) {
    // Writes to addresses other than MMC registers are handled by NoMapper.
    if (address < 0x8000) {
      super.write(address, value);
      return;
    } else {
      // This is a ROM bank select command.
      // Swap in the given ROM bank at 0x8000:
      this.loadRomBank(value >> 2, 0x8000);
    }
  }

  loadROM() {
    if (!this.nes.rom.valid) {
      throw new Error("UN1ROM: Invalid ROM! Unable to load.");
    }

    // Load PRG-ROM:
    this.loadRomBank(0, 0x8000);
    this.loadRomBank(this.nes.rom.romCount - 1, 0xc000);

    // Load CHR-ROM:
    this.loadCHRROM();

    // Do Reset-Interrupt:
    this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
  }
}

__exp.default = Mapper94;


return __exp;
}
function __m_nes_js() {
const __exp = {};
const CPU = __req("cpu.js").default;
const Controller = __req("controller.js").default;
const PPU = __req("ppu/index.js").default;
const PAPU = __req("papu/index.js").default;
const GameGenie = __req("gamegenie.js").default;
const ROM = __req("rom.js").default;

const SAVE_STATE_VERSION = 2;

class NES {
  constructor(opts) {
    this.opts = {
      onFrame: function () {},
      onAudioSample: null,
      onStatusUpdate: function () {},
      onBatteryRamWrite: function () {},

      emulateSound: true,
      sampleRate: 48000, // Sound sample rate in hz

      ...opts,
    };

    this.ui = {
      writeFrame: this.opts.onFrame,
      updateStatus: this.opts.onStatusUpdate,
    };
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.papu = new PAPU(this);
    this.cpu.ppu = this.ppu;
    this.cpu.papu = this.papu;
    this.gameGenie = new GameGenie();
    this.gameGenie.onChange = () => this.cpu._updateCartridgeLoader();
    this.mmap = null;
    this.controllers = {
      1: new Controller(),
      2: new Controller(),
    };

    this.fpsFrameCount = 0;
    this.rom = null;
    this.romData = null;

    this.ui.updateStatus("Ready to load a ROM.");
  }

  // Power-cycles the console: switches it off and on again with the same
  // cartridge inserted. Every component (CPU, PPU, APU and the cartridge's
  // mapper) is rebuilt in its power-on state, and the ROM's PRG/CHR banks
  // are copied into the fresh memory, so this is equivalent to calling
  // loadROM() again with the same ROM data. It's also how to recover after
  // the emulator has crashed (see `crashed`).
  //
  // This is *not* the console's reset button, which only resets the CPU and
  // a few registers and leaves RAM, the PPU and the cartridge's state alone.
  // See https://www.nesdev.org/wiki/CPU_power_up_state
  //
  // Cartridge RAM at $6000-$7FFF (including battery-backed save RAM) is
  // cleared too, as it is by loadROM(). Hosts that persist save RAM do so
  // through the onBatteryRamWrite callback.
  reset() {
    this.cpu = new CPU(this);
    this.ppu = new PPU(this);
    this.papu = new PAPU(this);
    this.cpu.ppu = this.ppu;
    this.cpu.papu = this.papu;

    this.mmap = null;
    if (this.rom !== null) {
      // The mapper copies the initial PRG-ROM banks into cpu.mem and the
      // CHR banks into PPU memory, and requests the reset interrupt so the
      // CPU starts at the address in the reset vector ($FFFC).
      this.mmap = this.rom.createMapper();
      this.mmap.loadROM();
      // The CPU reads PRG-ROM straight out of cpu.mem when it can; that
      // depends on the mapper and on whether Game Genie codes are active,
      // both of which belong to the new CPU.
      this.cpu._updateCartridgeLoader();
      this.ppu.setMirroring(this.rom.getMirroringType());
    }

    this.lastFpsTime = null;
    this.fpsFrameCount = 0;

    this.crashed = false;
  }

  // The frame loop. Runs CPU instructions until the PPU reaches the start
  // of VBlank. The CPU is cycle-stepped: every bus access it makes advances
  // the PPU (3 dots) and the APU (1 cycle), and DMA transfers happen inside
  // the CPU's read cycles, so all we need to do here is run instructions.
  frame = () => {
    if (this.crashed) {
      throw new Error(
        "Game has crashed. Call reset() or loadROM() to restart.",
      );
    }
    this.controllers[1].clock();
    this.controllers[2].clock();
    this.ppu.startFrame();
    const cpu = this.cpu;
    const ppu = this.ppu;
    try {
      if (this.mmap === null) return;
      while (!ppu.frameEnded) {
        cpu.emulate();
      }
      ppu.frameEnded = false;
    } catch (e) {
      this.crashed = true;
      throw e;
    }
    this.fpsFrameCount++;
  };

  buttonDown = (controller, button) => {
    this.controllers[controller].buttonDown(button);
  };

  buttonUp = (controller, button) => {
    this.controllers[controller].buttonUp(button);
  };

  zapperMove = (x, y) => {
    if (!this.mmap) return;
    this.mmap.zapperX = x;
    this.mmap.zapperY = y;
  };

  zapperFireDown = () => {
    if (!this.mmap) return;
    this.mmap.zapperFired = true;
  };

  zapperFireUp = () => {
    if (!this.mmap) return;
    this.mmap.zapperFired = false;
  };

  getFPS() {
    const now = Date.now();
    let fps = null;
    if (this.lastFpsTime) {
      fps = this.fpsFrameCount / ((now - this.lastFpsTime) / 1000);
    }
    this.fpsFrameCount = 0;
    this.lastFpsTime = now;
    return fps;
  }

  reloadROM() {
    if (this.romData !== null) {
      this.loadROM(this.romData);
    }
  }

  // Inserts a cartridge and powers the console on. The ROM file is parsed
  // and validated first, so an invalid file throws and leaves the current
  // cartridge (if any) in place.
  loadROM(data) {
    const rom = new ROM(this);
    rom.load(data);

    this.rom = rom;
    this.romData = data;
    // reset() builds the mapper for this.rom and loads it into memory.
    this.reset();
  }

  // Adjust audio sample timing for a non-standard host frame rate. At the
  // default 60fps each frame() produces ~800 samples at 48kHz. If the host
  // calls frame() less often (e.g. 30fps), the sample timer must fire more
  // frequently per CPU cycle so each frame still fills the audio buffer.
  setFramerate(rate) {
    this.papu.setFrameRate(rate);
  }

  toJSON() {
    return {
      // Bumped when the save state format changes incompatibly. Version 2
      // is the cycle-accurate CPU/PPU/APU.
      version: SAVE_STATE_VERSION,
      // romData: this.romData,
      cpu: this.cpu.toJSON(),
      mmap: this.mmap.toJSON(),
      ppu: this.ppu.toJSON(),
      papu: this.papu.toJSON(),
      controllers: {
        1: this.controllers[1].toJSON(),
        2: this.controllers[2].toJSON(),
      },
    };
  }

  fromJSON(s) {
    if (s.version !== SAVE_STATE_VERSION) {
      throw new Error(
        "This save state was made with an incompatible version of JSNES.",
      );
    }
    this.reset();
    // this.romData = s.romData;
    this.cpu.fromJSON(s.cpu);
    this.mmap.fromJSON(s.mmap);
    // Recompute the CPU's PRG read path now the mapper state is restored.
    this.cpu._updateCartridgeLoader();
    this.ppu.fromJSON(s.ppu);
    this.papu.fromJSON(s.papu);
    if (s.controllers) {
      if (s.controllers[1]) this.controllers[1].fromJSON(s.controllers[1]);
      if (s.controllers[2]) this.controllers[2].fromJSON(s.controllers[2]);
    }
  }
}

__exp.default = NES;


return __exp;
}
function __m_papu_channel_dm_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");
const { IRQ_SOURCE_DMC } = __req("cpu.js");

// The DMC (delta modulation channel) plays 1-bit delta-encoded samples that
// it reads directly from CPU memory using DMA.
//
// It is made of three parts:
//
// - The *memory reader* fetches sample bytes from memory (via DMA, which
//   halts the CPU for a few cycles) into a one-byte *sample buffer*. It
//   keeps track of the current address and how many bytes remain.
// - The *output unit* has an 8-bit shift register. Every time the timer
//   expires, it shifts out one bit and moves the output level up or down
//   by 2. When the shift register runs out of bits, it starts a new "output
//   cycle" by taking the byte in the sample buffer (if any). That empties
//   the buffer, which makes the memory reader request the next byte.
// - The *timer* counts CPU cycles; its period is set by $4010.
//
// The exact timing of the DMA requests is observable by the CPU (the CPU
// gets halted, and the DMA's reads can have side effects), and test ROMs
// such as AccuracyCoin use DMC DMA to synchronize themselves, so this is
// emulated per CPU cycle.
//
// See https://www.nesdev.org/wiki/APU_DMC and https://www.nesdev.org/wiki/DMA
class ChannelDM {
  static JSON_PROPERTIES = [
    "isEnabled",
    "irqEnabled",
    "loop",
    "irqFlag",
    "period",
    "timer",
    "outputLevel",
    "sample",
    "sampleAddress",
    "sampleLength",
    "currentAddress",
    "bytesRemaining",
    "buffer",
    "bufferEmpty",
    "shiftRegister",
    "bitsRemaining",
    "silence",
    "startDelay",
    "disableDelay",
    "lastFetchCycle",
  ];

  constructor(papu) {
    this.papu = papu;

    // The "enable" bit from $4015 as last written (only used for audio).
    this.isEnabled = false;

    // $4010
    this.irqEnabled = false;
    this.loop = false;
    this.period = 428; // Timer period in CPU cycles

    this.irqFlag = false;
    this.timer = 428;

    // Output unit
    this.outputLevel = 0; // 7-bit DAC level, set by $4011 or by the shifter
    this.sample = 0; // Current audio output value (= outputLevel)
    this.shiftRegister = 0;
    this.bitsRemaining = 8;
    this.silence = true;

    // Memory reader
    this.sampleAddress = 0xc000; // $4012
    this.sampleLength = 1; // $4013
    this.currentAddress = 0xc000;
    this.bytesRemaining = 0;
    this.buffer = 0;
    this.bufferEmpty = true;

    // Delays (in CPU cycles) for effects of $4015 writes. On real hardware
    // these happen on APU clock edges, so they depend on the cycle parity.
    this.startDelay = 0;
    this.disableDelay = 0;
    // CPU cycle of the most recent DMA fetch.
    this.lastFetchCycle = -100;
  }

  // Count down the delayed effects of $4015 writes. Called by the APU
  // once per CPU cycle while either is active. (The DMC timer itself is
  // clocked in PAPU.clockCycle().)
  clockDelays() {
    if (this.disableDelay !== 0 && --this.disableDelay === 0) {
      // Disabling via $4015 takes effect now. If a DMA was already
      // scheduled, it gets cancelled (or aborted, if it already halted the
      // CPU).
      this.bytesRemaining = 0;
      this.papu.nes.cpu.stopDmcDma();
    }
    if (this.startDelay !== 0 && --this.startDelay === 0) {
      this._requestDma();
    }
  }

  // One output unit step (each time the timer expires).
  _clockOutput() {
    if (!this.silence) {
      if ((this.shiftRegister & 1) !== 0) {
        if (this.outputLevel <= 125) this.outputLevel += 2;
      } else {
        if (this.outputLevel >= 2) this.outputLevel -= 2;
      }
      this._updateSample();
    }
    this.shiftRegister >>= 1;
    if (--this.bitsRemaining === 0) {
      // Start a new output cycle.
      this.bitsRemaining = 8;
      if (this.bufferEmpty) {
        this.silence = true;
      } else {
        this.silence = false;
        this.shiftRegister = this.buffer;
        this.bufferEmpty = true;
        // The buffer is now empty: the memory reader fetches the next byte.
        this._requestDma();
      }
    }
  }

  _updateSample() {
    this.papu._flushAudio();
    this.sample = this.outputLevel;
  }

  _requestDma() {
    // While a $4015 write's start delay is counting down, the DMA can't
    // start yet (it will be requested when the delay expires).
    if (!this.bufferEmpty || this.startDelay !== 0) return;
    const cpu = this.papu.nes.cpu;
    if (this.bytesRemaining > 0) {
      cpu.startDmcDma();
    } else if (cpu.cycles - this.lastFetchCycle <= 2) {
      // "Implicit abort": the DMA unit only notices that the sample ended
      // a couple of cycles after the fetch of the last byte. If the output
      // unit empties the buffer within that window (this happens when a
      // 1-byte sample is started just before the output unit finishes its
      // cycle), a reload DMA starts but is aborted right away. It still
      // halts the CPU for one cycle (or not at all, if that cycle is a
      // write). See https://www.nesdev.org/wiki/DMA#DMC_DMA and the
      // AccuracyCoin "Implicit DMA Abort" test.
      cpu.startAbortedDmcDma();
    }
  }

  // Called by the CPU's DMA unit with the byte it read from currentAddress.
  dmaComplete(value) {
    this.lastFetchCycle = this.papu.nes.cpu.cycles;
    if (this.bytesRemaining === 0) return;
    this.buffer = value;
    this.bufferEmpty = false;
    // The address wraps from $FFFF to $8000.
    this.currentAddress =
      this.currentAddress === 0xffff ? 0x8000 : this.currentAddress + 1;
    this.bytesRemaining--;
    if (this.bytesRemaining === 0) {
      if (this.loop) {
        this._restart();
      } else if (this.irqEnabled) {
        this._setIrq(true);
      }
    }
  }

  _restart() {
    this.currentAddress = this.sampleAddress;
    this.bytesRemaining = this.sampleLength;
  }

  _setIrq(active) {
    this.irqFlag = active;
    this.papu.nes.cpu.setIrqSource(IRQ_SOURCE_DMC, active);
  }

  writeReg(address, value) {
    if (address === 0x4010) {
      // Bit 7: IRQ enable, bit 6: loop, bits 0-3: rate index
      this.irqEnabled = (value & 0x80) !== 0;
      this.loop = (value & 0x40) !== 0;
      if (!this.irqEnabled) {
        this._setIrq(false);
      }
      // (The lookup table is in units of 1/8 CPU cycle.)
      this.period = this.papu.getDmcFrequency(value & 0xf) >> 3;
    } else if (address === 0x4011) {
      // Direct load of the output level.
      this.outputLevel = value & 0x7f;
      this._updateSample();
    } else if (address === 0x4012) {
      // Sample address = $C000 + value * 64
      this.sampleAddress = 0xc000 | (value << 6);
    } else if (address === 0x4013) {
      // Sample length = value * 16 + 1 bytes
      this.sampleLength = (value << 4) | 1;
    } else if (address === 0x4015) {
      // Writing $4015 always clears the DMC interrupt flag.
      this._setIrq(false);
      // How long until the APU acts on the write depends on the phase of
      // the APU clock.
      const put = this.papu._isPutCycle();
      if ((value & 0x10) === 0) {
        // Disable: bytes remaining is set to 0 after a short delay.
        if (this.disableDelay === 0) {
          this.disableDelay = put ? 2 : 3;
        }
      } else {
        this.disableDelay = 0;
        if (this.bytesRemaining === 0) {
          // Enable with no sample playing: restart the sample. If the
          // sample buffer is empty, the first byte gets fetched shortly.
          this._restart();
          this.startDelay = put ? 2 : 3;
        }
      }
    }
  }

  setEnabled(value) {
    this.isEnabled = value;
  }

  getLengthStatus() {
    return this.bytesRemaining > 0 ? 1 : 0;
  }

  getIrqStatus() {
    return this.irqFlag ? 1 : 0;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }
}

__exp.default = ChannelDM;


return __exp;
}
function __m_papu_channel_noise_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");

class ChannelNoise {
  constructor(papu) {
    this.papu = papu;

    this.progTimerCount = 0;
    this.progTimerMax = 0;
    this.isEnabled = false;
    this.lengthCounter = 0;
    this.lengthCounterEnable = false;
    this.envDecayDisable = false;
    this.envDecayLoopEnable = false;
    this.envReset = false;
    this.shiftNow = false;
    this.envDecayRate = 0;
    this.envDecayCounter = 0;
    this.envVolume = 0;
    this.masterVolume = 0;
    this.shiftReg = 1;
    this.randomBit = 0;
    this.randomMode = 0;
    this.sampleValue = 0;
    this.tmp = 0;
    this.accValue = 0;
    this.accCount = 1;
  }

  clockLengthCounter() {
    if (this.lengthCounterEnable && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.updateSampleValue();
      }
    }
  }

  clockEnvDecay() {
    if (this.envReset) {
      // Reset envelope:
      this.envReset = false;
      this.envDecayCounter = this.envDecayRate + 1;
      this.envVolume = 0xf;
    } else if (--this.envDecayCounter <= 0) {
      // Normal handling:
      this.envDecayCounter = this.envDecayRate + 1;
      if (this.envVolume > 0) {
        this.envVolume--;
      } else {
        this.envVolume = this.envDecayLoopEnable ? 0xf : 0;
      }
    }
    if (this.envDecayDisable) {
      this.masterVolume = this.envDecayRate;
    } else {
      this.masterVolume = this.envVolume;
    }
    this.updateSampleValue();
  }

  updateSampleValue() {
    if (this.isEnabled && this.lengthCounter > 0) {
      this.sampleValue = this.randomBit * this.masterVolume;
    }
  }

  writeReg(address, value) {
    if (address === 0x400c) {
      // Volume/Envelope decay:
      this.envDecayDisable = (value & 0x10) !== 0;
      this.envDecayRate = value & 0xf;
      this.envDecayLoopEnable = (value & 0x20) !== 0;
      this.lengthCounterEnable = (value & 0x20) === 0;
      if (this.envDecayDisable) {
        this.masterVolume = this.envDecayRate;
      } else {
        this.masterVolume = this.envVolume;
      }
    } else if (address === 0x400e) {
      // Programmable timer:
      this.progTimerMax = this.papu.getNoiseWaveLength(value & 0xf);
      this.randomMode = value >> 7;
    } else if (address === 0x400f) {
      // Length counter — only loaded when the channel is enabled via $4015.
      // Writing this register while disabled has no effect on the length counter.
      // See https://www.nesdev.org/wiki/APU#Status_($4015)
      if (this.isEnabled) {
        this.lengthCounter = this.papu.getLengthMax(value & 248);
      }
      this.envReset = true;
    }
    // Update:
    //updateSampleValue();
  }

  setEnabled(value) {
    this.isEnabled = value;
    if (!value) {
      this.lengthCounter = 0;
    }
    this.updateSampleValue();
  }

  getLengthStatus() {
    return this.lengthCounter === 0 || !this.isEnabled ? 0 : 1;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }

  static JSON_PROPERTIES = [
    "isEnabled",
    "envDecayDisable",
    "envDecayLoopEnable",
    "lengthCounterEnable",
    "envReset",
    "shiftNow",
    "lengthCounter",
    "progTimerCount",
    "progTimerMax",
    "envDecayRate",
    "envDecayCounter",
    "envVolume",
    "masterVolume",
    "shiftReg",
    "randomBit",
    "randomMode",
    "sampleValue",
    "accValue",
    "accCount",
    "tmp",
  ];
}

__exp.default = ChannelNoise;


return __exp;
}
function __m_papu_channel_square_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");

class ChannelSquare {
  constructor(papu, square1) {
    this.papu = papu;

    // prettier-ignore
    this.dutyLookup = [
           0, 1, 0, 0, 0, 0, 0, 0,
           0, 1, 1, 0, 0, 0, 0, 0,
           0, 1, 1, 1, 1, 0, 0, 0,
           1, 0, 0, 1, 1, 1, 1, 1
      ];
    // prettier-ignore
    this.impLookup = [
           1,-1, 0, 0, 0, 0, 0, 0,
           1, 0,-1, 0, 0, 0, 0, 0,
           1, 0, 0, 0,-1, 0, 0, 0,
          -1, 0, 1, 0, 0, 0, 0, 0
      ];

    this.sqr1 = square1;

    this.progTimerCount = 0;
    this.progTimerMax = 0;
    this.lengthCounter = 0;
    this.squareCounter = 0;
    this.sweepCounter = 0;
    this.sweepCounterMax = 0;
    this.sweepMode = 0;
    this.sweepShiftAmount = 0;
    this.envDecayRate = 0;
    this.envDecayCounter = 0;
    this.envVolume = 0;
    this.masterVolume = 0;
    this.dutyMode = 0;
    this.vol = 0;
    this.isEnabled = false;
    this.lengthCounterEnable = false;
    this.sweepActive = false;
    this.sweepCarry = false;
    this.envDecayDisable = false;
    this.envDecayLoopEnable = false;
    this.envReset = false;
    this.updateSweepPeriod = false;
    this.sweepResult = 0;
    this.sampleValue = 0;
  }

  clockLengthCounter() {
    if (this.lengthCounterEnable && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.updateSampleValue();
      }
    }
  }

  clockEnvDecay() {
    if (this.envReset) {
      // Reset envelope:
      this.envReset = false;
      this.envDecayCounter = this.envDecayRate + 1;
      this.envVolume = 0xf;
    } else if (--this.envDecayCounter <= 0) {
      // Normal handling:
      this.envDecayCounter = this.envDecayRate + 1;
      if (this.envVolume > 0) {
        this.envVolume--;
      } else {
        this.envVolume = this.envDecayLoopEnable ? 0xf : 0;
      }
    }

    if (this.envDecayDisable) {
      this.masterVolume = this.envDecayRate;
    } else {
      this.masterVolume = this.envVolume;
    }
    this.updateSampleValue();
  }

  clockSweep() {
    if (--this.sweepCounter <= 0) {
      this.sweepCounter = this.sweepCounterMax + 1;
      if (
        this.sweepActive &&
        this.sweepShiftAmount > 0 &&
        this.progTimerMax > 7
      ) {
        // Calculate result from shifter:
        this.sweepCarry = false;
        if (this.sweepMode === 0) {
          this.progTimerMax += this.progTimerMax >> this.sweepShiftAmount;
          if (this.progTimerMax > 0x7ff) {
            this.progTimerMax = 4095;
            this.sweepCarry = true;
          }
        } else {
          this.progTimerMax =
            this.progTimerMax -
            ((this.progTimerMax >> this.sweepShiftAmount) +
              (this.sqr1 ? 1 : 0));
        }
      }
    }

    if (this.updateSweepPeriod) {
      this.updateSweepPeriod = false;
      this.sweepCounter = this.sweepCounterMax + 1;
    }
  }

  updateSampleValue() {
    if (this.isEnabled && this.lengthCounter > 0 && this.progTimerMax > 7) {
      if (
        this.sweepMode === 0 &&
        this.progTimerMax + (this.progTimerMax >> this.sweepShiftAmount) > 0x7ff
      ) {
        //if (this.sweepCarry) {
        this.sampleValue = 0;
      } else {
        this.sampleValue =
          this.masterVolume *
          this.dutyLookup[(this.dutyMode << 3) + this.squareCounter];
      }
    } else {
      this.sampleValue = 0;
    }
  }

  writeReg(address, value) {
    let addrAdd = this.sqr1 ? 0 : 4;
    if (address === 0x4000 + addrAdd) {
      // Volume/Envelope decay:
      this.envDecayDisable = (value & 0x10) !== 0;
      this.envDecayRate = value & 0xf;
      this.envDecayLoopEnable = (value & 0x20) !== 0;
      this.dutyMode = (value >> 6) & 0x3;
      this.lengthCounterEnable = (value & 0x20) === 0;
      if (this.envDecayDisable) {
        this.masterVolume = this.envDecayRate;
      } else {
        this.masterVolume = this.envVolume;
      }
      this.updateSampleValue();
    } else if (address === 0x4001 + addrAdd) {
      // Sweep:
      this.sweepActive = (value & 0x80) !== 0;
      this.sweepCounterMax = (value >> 4) & 7;
      this.sweepMode = (value >> 3) & 1;
      this.sweepShiftAmount = value & 7;
      this.updateSweepPeriod = true;
    } else if (address === 0x4002 + addrAdd) {
      // Programmable timer:
      this.progTimerMax &= 0x700;
      this.progTimerMax |= value;
    } else if (address === 0x4003 + addrAdd) {
      // Programmable timer, length counter
      this.progTimerMax &= 0xff;
      this.progTimerMax |= (value & 0x7) << 8;

      if (this.isEnabled) {
        this.lengthCounter = this.papu.getLengthMax(value & 0xf8);
      }

      this.envReset = true;
    }
  }

  setEnabled(value) {
    this.isEnabled = value;
    if (!value) {
      this.lengthCounter = 0;
    }
    this.updateSampleValue();
  }

  getLengthStatus() {
    return this.lengthCounter === 0 || !this.isEnabled ? 0 : 1;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }

  static JSON_PROPERTIES = [
    "isEnabled",
    "lengthCounterEnable",
    "sweepActive",
    "envDecayDisable",
    "envDecayLoopEnable",
    "envReset",
    "sweepCarry",
    "updateSweepPeriod",
    "progTimerCount",
    "progTimerMax",
    "lengthCounter",
    "squareCounter",
    "sweepCounter",
    "sweepCounterMax",
    "sweepMode",
    "sweepShiftAmount",
    "envDecayRate",
    "envDecayCounter",
    "envVolume",
    "masterVolume",
    "dutyMode",
    "sweepResult",
    "sampleValue",
    "vol",
  ];
}

__exp.default = ChannelSquare;


return __exp;
}
function __m_papu_channel_triangle_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");

class ChannelTriangle {
  constructor(papu) {
    this.papu = papu;

    this.progTimerCount = 0;
    this.progTimerMax = 0;
    this.triangleCounter = 0;
    this.isEnabled = false;
    this.sampleCondition = false;
    this.lengthCounter = 0;
    this.lengthCounterEnable = false;
    this.linearCounter = 0;
    this.lcLoadValue = 0;
    this.lcHalt = true;
    this.lcControl = false;
    this.tmp = 0;
    this.sampleValue = 0xf;
  }

  clockLengthCounter() {
    if (this.lengthCounterEnable && this.lengthCounter > 0) {
      this.lengthCounter--;
      if (this.lengthCounter === 0) {
        this.updateSampleCondition();
      }
    }
  }

  clockLinearCounter() {
    if (this.lcHalt) {
      // Load:
      this.linearCounter = this.lcLoadValue;
      this.updateSampleCondition();
    } else if (this.linearCounter > 0) {
      // Decrement:
      this.linearCounter--;
      this.updateSampleCondition();
    }
    if (!this.lcControl) {
      // Clear halt flag:
      this.lcHalt = false;
    }
  }

  getLengthStatus() {
    return this.lengthCounter === 0 || !this.isEnabled ? 0 : 1;
  }

  // eslint-disable-next-line no-unused-vars
  readReg(address) {
    return 0;
  }

  writeReg(address, value) {
    if (address === 0x4008) {
      // New values for linear counter:
      this.lcControl = (value & 0x80) !== 0;
      this.lcLoadValue = value & 0x7f;

      // Length counter enable:
      this.lengthCounterEnable = !this.lcControl;
    } else if (address === 0x400a) {
      // Programmable timer:
      this.progTimerMax &= 0x700;
      this.progTimerMax |= value;
    } else if (address === 0x400b) {
      // Programmable timer, length counter
      this.progTimerMax &= 0xff;
      this.progTimerMax |= (value & 0x07) << 8;
      // Length counter is only loaded when the channel is enabled via $4015.
      // Writing this register while disabled has no effect on the length counter.
      // See https://www.nesdev.org/wiki/APU#Status_($4015)
      if (this.isEnabled) {
        this.lengthCounter = this.papu.getLengthMax(value & 0xf8);
      }
      this.lcHalt = true;
    }

    this.updateSampleCondition();
  }

  clockProgrammableTimer(nCycles) {
    if (this.progTimerMax > 0) {
      this.progTimerCount += nCycles;
      while (
        this.progTimerMax > 0 &&
        this.progTimerCount >= this.progTimerMax
      ) {
        this.progTimerCount -= this.progTimerMax;
        if (
          this.isEnabled &&
          this.lengthCounter > 0 &&
          this.linearCounter > 0
        ) {
          this.clockTriangleGenerator();
        }
      }
    }
  }

  clockTriangleGenerator() {
    this.triangleCounter++;
    this.triangleCounter &= 0x1f;
  }

  setEnabled(value) {
    this.isEnabled = value;
    if (!value) {
      this.lengthCounter = 0;
    }
    this.updateSampleCondition();
  }

  updateSampleCondition() {
    this.sampleCondition =
      this.isEnabled &&
      this.progTimerMax > 7 &&
      this.linearCounter > 0 &&
      this.lengthCounter > 0;
  }

  toJSON() {
    return toJSON(this);
  }

  fromJSON(s) {
    fromJSON(this, s);
  }

  static JSON_PROPERTIES = [
    "isEnabled",
    "sampleCondition",
    "lengthCounterEnable",
    "lcHalt",
    "lcControl",
    "progTimerCount",
    "progTimerMax",
    "triangleCounter",
    "lengthCounter",
    "linearCounter",
    "lcLoadValue",
    "sampleValue",
    "tmp",
  ];
}

__exp.default = ChannelTriangle;


return __exp;
}
function __m_papu_index_js() {
const __exp = {};
const { fromJSON, toJSON } = __req("utils.js");
const ChannelDM = __req("papu/channel-dm.js").default;
const ChannelNoise = __req("papu/channel-noise.js").default;
const ChannelSquare = __req("papu/channel-square.js").default;
const ChannelTriangle = __req("papu/channel-triangle.js").default;
const { IRQ_SOURCE_FRAME } = __req("cpu.js");

const CPU_FREQ_NTSC = 1789772.5; //1789772.72727272d;
// const CPU_FREQ_PAL = 1773447.4;

// Frame counter step timing tables (in CPU cycles).
// The APU frame counter fires at these specific cycle positions within each
// sequence. On real hardware, the APU clock is half the CPU clock, so
// these correspond to APU cycles 3728.5, 7456.5, 11185.5, 14914, 14914.5 etc.
// In 4-step mode, the IRQ flag is set 1 CPU cycle before the clock event
// (at 29828 vs 29829), so step 3 is split into two sub-steps.
// See https://www.nesdev.org/wiki/APU_Frame_Counter
const FRAME_STEPS_4 = [7457, 14913, 22371, 29828, 29829];
// 5-step mode step 3 fires at 29829 per the nesdev wiki, not 29828. This is
// fine because fireFrameStep step 3 in 5-step mode is a no-op (no clock or IRQ).
const FRAME_STEPS_5 = [7457, 14913, 22371, 29829, 37281];
const FRAME_PERIOD_4 = 29830; // Total CPU cycles for 4-step sequence
const FRAME_PERIOD_5 = 37282; // Total CPU cycles for 5-step sequence

class PAPU {
  constructor(nes) {
    this.nes = nes;

    // Catch-up state (see catchUp()): the last CPU cycle the APU has been
    // clocked for, and the next cycle on which something happens.
    this.lastCycle = 0;
    this.nextEventCycle = 0;

    this.square1 = new ChannelSquare(this, true);
    this.square2 = new ChannelSquare(this, false);
    this.triangle = new ChannelTriangle(this);
    this.noise = new ChannelNoise(this);
    this.dmc = new ChannelDM(this);

    this.startedPlaying = false;
    this.recordOutput = false;
    this.triValue = 0;

    // DC removal vars:
    this.prevSampleL = 0;
    this.prevSampleR = 0;
    this.smpAccumL = 0;
    this.smpAccumR = 0;

    // DAC range:
    this.dacRange = 0;
    this.dcValue = 0;

    // Master volume:
    this.masterVolume = 256;

    // Panning:
    this.panning = [80, 170, 100, 150, 128];
    this.setPanning(this.panning);

    // Initialize lookup tables:
    this.initLengthLookup();
    this.initDmcFrequencyLookup();
    this.initNoiseWavelengthLookup();
    this.initDACtables();

    // Init sound registers:
    for (let i = 0; i < 0x14; i++) {
      if (i === 0x10) {
        this.writeReg(0x4010, 0x10);
      } else {
        this.writeReg(0x4000 + i, 0);
      }
    }

    this.sampleRate = this.nes.opts.sampleRate;
    // With emulateSound off, the channels' timers and the mixer aren't run
    // (everything the CPU can observe still is).
    this.emulateSound = this.nes.opts.emulateSound !== false;
    this.sampleTimerMax = Math.floor(
      (1024.0 * CPU_FREQ_NTSC) / this.sampleRate,
    );
    this.sampleTimer = 0;
    this.updateChannelEnable(0);
    this.frameCycleCounter = 0;
    this.lastCycle = 0;
    this.frameStep = 0;
    this.countSequence = 0;
    this.sampleCount = 0;
    this.frameIrqEnabled = false;
    this.frameIrqActive = false;
    // Deferred clearing of the frame IRQ flag: on real hardware, reading
    // $4015 doesn't clear bit 6 immediately. The clear takes effect at the
    // next APU "get" cycle (the APU clock runs at half the CPU rate, so
    // get/put phases alternate every CPU cycle). This matters when $4015 is
    // read twice in quick succession (e.g., by the SLO RMW instruction's
    // dummy read + actual read, which are 1 CPU cycle apart). Depending on
    // the APU phase alignment, the second read may or may not still see
    // the flag. See AccuracyCoin test 0x0467 subtests 6 and 7.
    // https://www.nesdev.org/wiki/APU_Frame_Counter
    this.frameIrqClearPending = false;
    // CPU cycles until a pending frame IRQ flag clear takes effect.
    this.frameIrqClearDelay = 0;
    // Counter value at which the frame counter next has something to do.
    this.nextFrameEvent = FRAME_STEPS_4[0];
    // CPU cycles not yet run through the audio synthesis (_flushAudio), and
    // how many to accumulate before running them.
    this.pendingAudioCycles = 0;
    this.audioFlushAt = 1;
    this.accCount = 0;
    this.smpSquare1 = 0;
    this.smpSquare2 = 0;
    this.smpTriangle = 0;
    this.smpDmc = 0;
    this.channelEnableValue = 0xff;
    this.maxSample = -500000;
    this.minSample = 500000;

    this._scheduleNextEvent();
  }

  // Read $4015 (APU status). Called by the CPU's bus.
  readReg(address) {
    this.catchUp(this.nes.cpu.cycles);
    const value = this._readStatus(address);
    this._scheduleNextEvent();
    return value;
  }

  // Write an APU register ($4000-$4017). Called by the CPU's bus.
  writeReg(address, value) {
    this.catchUp(this.nes.cpu.cycles);
    this._writeRegister(address, value);
    this._scheduleNextEvent();
  }

  // eslint-disable-next-line no-unused-vars
  _readStatus(address) {
    // Read 0x4015:
    let tmp = 0;
    tmp |= this.square1.getLengthStatus();
    tmp |= this.square2.getLengthStatus() << 1;
    tmp |= this.triangle.getLengthStatus() << 2;
    tmp |= this.noise.getLengthStatus() << 3;
    tmp |= this.dmc.getLengthStatus() << 4;
    // Bit 5 is open bus (not driven by APU), comes from CPU data bus
    // See https://www.nesdev.org/wiki/Open_bus_behavior
    tmp |= this.nes.cpu.dataBus & 0x20;
    // Frame interrupt flag: reflects whether the flag is set, regardless of
    // the IRQ inhibit bit in $4017. The inhibit only prevents the IRQ from
    // firing, not the flag from being reported.
    tmp |= (this.frameIrqActive ? 1 : 0) << 6;
    tmp |= this.dmc.getIrqStatus() << 7;

    // Reading $4015 schedules the frame interrupt flag for clearing, but
    // the actual clear is deferred to the next APU "get" cycle. This means
    // if two reads happen 1 CPU cycle apart (e.g., dummy + actual read in
    // an RMW instruction), the second read may still see the flag depending
    // on APU clock phase alignment. The DMC interrupt flag is NOT cleared.
    // Only schedule a clear when the flag is actually set; otherwise a stale
    // pending clear could race with a future fireFrameStep that sets the flag.
    // See https://www.nesdev.org/wiki/APU#Status_($4015)
    if (this.frameIrqActive) {
      this.frameIrqClearPending = true;
      // The clear happens at the next put->get transition: after this cycle
      // if this cycle is a "put" cycle, otherwise one cycle later.
      this.frameIrqClearDelay = this._isPutCycle() ? 1 : 2;
    }

    return tmp & 0xff;
  }

  _writeRegister(address, value) {
    this._flushAudio();
    if (address >= 0x4000 && address < 0x4004) {
      // Square Wave 1 Control
      this.square1.writeReg(address, value);
      // console.log("Square Write");
    } else if (address >= 0x4004 && address < 0x4008) {
      // Square 2 Control
      this.square2.writeReg(address, value);
    } else if (address >= 0x4008 && address < 0x400c) {
      // Triangle Control
      this.triangle.writeReg(address, value);
    } else if (address >= 0x400c && address <= 0x400f) {
      // Noise Control
      this.noise.writeReg(address, value);
    } else if (address === 0x4010) {
      // DMC Play mode & DMA frequency
      this.dmc.writeReg(address, value);
    } else if (address === 0x4011) {
      // DMC Delta Counter
      this.dmc.writeReg(address, value);
    } else if (address === 0x4012) {
      // DMC Play code starting address
      this.dmc.writeReg(address, value);
    } else if (address === 0x4013) {
      // DMC Play code length
      this.dmc.writeReg(address, value);
    } else if (address === 0x4015) {
      // Channel enable
      this.updateChannelEnable(value);

      // DMC/IRQ Status
      this.dmc.writeReg(address, value);
    } else if (address === 0x4017) {
      // Frame counter control
      // Bit 7: sequence mode (0=4-step, 1=5-step)
      // Bit 6: IRQ inhibit (0=IRQs enabled, 1=IRQs disabled)
      // See https://www.nesdev.org/wiki/APU_Frame_Counter
      this.countSequence = (value >> 7) & 1;
      // Writing $4017 resets the frame counter's internal divider, but on
      // real hardware the reset is delayed after the write cycle. The delay
      // depends on the APU clock phase at the write:
      //   "get" phase (odd parity): reset after 3 CPU cycles
      //   "put" phase (even parity): reset after 4 CPU cycles
      // Since the emulator clocks the full STA instruction's cycles (4 for
      // STA absolute) after writeReg, we compensate by starting the counter
      // negative so it reaches 0 at the true reset point.
      // See https://www.nesdev.org/wiki/APU_Frame_Counter
      // The counter is clocked at the end of this (write) cycle. The reset
      // takes effect 3 CPU cycles after a write on a put cycle, or 4 after
      // a write on a get cycle.
      this.frameCycleCounter = this._isPutCycle() ? -3 : -4;
      this.frameStep = 0;
      this._updateNextFrameEvent();

      if (value & 0x40) {
        // IRQ inhibit set: clear the frame interrupt flag and prevent
        // future frame IRQs from firing
        this.frameIrqEnabled = false;
        this.frameIrqClearPending = false;
        this._setFrameIrq(false);
      } else {
        // IRQ inhibit clear: enable frame IRQs (flag is not affected)
        this.frameIrqEnabled = true;
        this._setFrameIrq(this.frameIrqActive);
      }

      if (this.countSequence === 1) {
        // 5-step mode: immediately clock all quarter-frame and half-frame
        // units on the write cycle
        this.clockQuarterFrame();
        this.clockHalfFrame();
      }
    }
  }

  // Updates channel enable status.
  // This is done on writes to the
  // channel enable register (0x4015),
  // and when the user enables/disables channels
  // in the GUI.
  updateChannelEnable(value) {
    this.channelEnableValue = value & 0xffff;
    this.square1.setEnabled((value & 1) !== 0);
    this.square2.setEnabled((value & 2) !== 0);
    this.triangle.setEnabled((value & 4) !== 0);
    this.noise.setEnabled((value & 8) !== 0);
    this.dmc.setEnabled((value & 16) !== 0);
  }

  // Clock the APU by one CPU cycle. Called by the CPU at the end of every
  // CPU cycle (after that cycle's bus access).
  //
  // Everything that the CPU can observe (the frame counter, length counter
  // status, IRQ flags and DMC DMA requests) is updated exactly, every cycle.
  // The parts that only affect the audio output (square/triangle/noise
  // timers and the output mixer) are batched up and run every few cycles
  // by _flushAudio() for speed.
  // --- Catch-up ---
  //
  // Like the PPU (see PPU.catchUp()), the APU isn't clocked every CPU cycle.
  // Between "events" (a frame counter step, the DMC timer expiring, an
  // audio sample being due, the short delays after a $4015/$4017 access),
  // all it does is count, so it can be advanced in bulk. The CPU calls
  // catchUp() on the cycle of the next event, and before any access to the
  // APU's registers.

  // Clock the APU up to and including CPU cycle `cycle`.
  catchUp(cycle) {
    while (this.lastCycle < cycle) {
      let next = this.nextEventCycle;
      if (next <= this.lastCycle) next = this.lastCycle + 1;
      if (next > cycle) {
        this._advance(cycle - this.lastCycle);
        this.lastCycle = cycle;
        return;
      }
      if (next - 1 > this.lastCycle) {
        this._advance(next - 1 - this.lastCycle);
        this.lastCycle = next - 1;
      }
      this.clockCycle(next);
      this.lastCycle = next;
      this._scheduleNextEvent();
    }
  }

  // Advance by n cycles, none of which is an event cycle, so only the
  // counters move.
  _advance(n) {
    if (this.emulateSound) this.pendingAudioCycles += n;
    this.frameCycleCounter += n;
    // The DMC timer counts on even cycles (see clockCycle()).
    const a = this.lastCycle;
    this.dmc.timer -= 2 * (((a + n) >> 1) - (a >> 1));
  }

  // Work out the next cycle (after lastCycle) on which clockCycle() has
  // more to do than count.
  _scheduleNextEvent() {
    const last = this.lastCycle;
    const dmc = this.dmc;
    if ((this.frameIrqClearDelay | dmc.disableDelay | dmc.startDelay) !== 0) {
      // A short delay is counting down: clock every cycle.
      this.nextEventCycle = last + 1;
      return;
    }
    // Frame counter step.
    let next = last + (this.nextFrameEvent - this.frameCycleCounter);
    // Audio output sample.
    if (this.emulateSound) {
      const a = last + (this.audioFlushAt - this.pendingAudioCycles);
      if (a < next) next = a;
    }
    // DMC timer expiry: it loses 2 on each even cycle.
    let even = last + 1;
    if (even & 1) even++;
    const steps = (dmc.timer + 1) >> 1;
    const d = steps > 1 ? even + 2 * (steps - 1) : even;
    if (d < next) next = d;
    this.nextEventCycle = next > last ? next : last + 1;
  }

  // Clock the APU by one CPU cycle (an event cycle; see catchUp()).
  clockCycle(cycle) {
    // Batched audio synthesis (skipped entirely if sound is off).
    if (this.emulateSound && ++this.pendingAudioCycles >= this.audioFlushAt) {
      this._flushAudio();
    }

    const dmc = this.dmc;
    // Rarely-active countdowns: the deferred clear of the frame interrupt
    // flag after a $4015 read, and the DMC's $4015 start/disable delays.
    if ((this.frameIrqClearDelay | dmc.disableDelay | dmc.startDelay) !== 0) {
      this._clockDelays();
    }

    // Frame counter.
    if (++this.frameCycleCounter >= this.nextFrameEvent) {
      this._advanceFrameSteps();
    }

    // The DMC timer is clocked by the APU clock, i.e. on every other CPU
    // cycle (the "get" cycles), so DMA requests always line up the same way
    // with the get/put phase. Its period is in CPU cycles (always even).
    if ((cycle & 1) === 0) {
      dmc.timer -= 2;
      if (dmc.timer <= 0) {
        dmc.timer = dmc.period;
        dmc._clockOutput();
      }
    }
  }

  _clockDelays() {
    if (this.frameIrqClearDelay !== 0 && --this.frameIrqClearDelay === 0) {
      if (this.frameIrqClearPending) {
        this.frameIrqClearPending = false;
        this._setFrameIrq(false);
      }
    }
    this.dmc.clockDelays();
  }

  // Run the audio-only parts of the APU for the cycles accumulated since
  // the last flush. Called before anything that changes channel state
  // (register writes, frame counter clocks) so those take effect at
  // (nearly) the right time in the audio output.
  _flushAudio() {
    let nCycles = this.pendingAudioCycles;
    this.pendingAudioCycles = 0;
    while (nCycles > 0) {
      // Don't process channel ticks beyond the next output sample.
      let n = this._cyclesToNextSample();
      if (nCycles < n) n = nCycles;
      this._clockChannels(n);
      nCycles -= n;
    }
    // Unless something changes channel state first, run the next batch
    // when the next output sample is due.
    this.audioFlushAt = this._cyclesToNextSample();
  }

  // CPU cycles until the next output sample is produced (at least 1).
  _cyclesToNextSample() {
    const n = ((this.sampleTimerMax - this.sampleTimer) >> 10) + 1;
    return n < 1 ? 1 : n;
  }

  // Clocks the square, triangle and noise channel timers and the audio
  // sample accumulator by nCycles CPU cycles.
  _clockChannels(nCycles) {
    let triangle = this.triangle;
    let square1 = this.square1;
    let square2 = this.square2;
    let noise = this.noise;

    // Clock Triangle channel Prog timer:
    if (triangle.progTimerMax > 0) {
      triangle.progTimerCount -= nCycles;
      while (triangle.progTimerCount <= 0) {
        triangle.progTimerCount += triangle.progTimerMax + 1;
        if (triangle.linearCounter > 0 && triangle.lengthCounter > 0) {
          triangle.triangleCounter++;
          triangle.triangleCounter &= 0x1f;

          if (triangle.isEnabled) {
            if (triangle.triangleCounter >= 0x10) {
              // Normal value.
              triangle.sampleValue = triangle.triangleCounter & 0xf;
            } else {
              // Inverted value.
              triangle.sampleValue = 0xf - (triangle.triangleCounter & 0xf);
            }
            triangle.sampleValue <<= 4;
          }
        }
      }
    }

    // Clock the square channels. Their output is accumulated exactly (each
    // value weighted by how many cycles it lasted), so the batch can span
    // several steps of the waveform.
    this.smpSquare1 += this._clockSquare(square1, nCycles);
    this.smpSquare2 += this._clockSquare(square2, nCycles);

    // Clock the noise channel.
    this._clockNoise(noise, nCycles);

    // Accumulate sample value:
    this.accSample(nCycles);

    // Clock sample timer:
    this.sampleTimer += nCycles << 10;
    if (this.sampleTimer >= this.sampleTimerMax) {
      // Sample channels:
      this.sample();
      this.sampleTimer -= this.sampleTimerMax;
    }
  }

  // Run a square channel's timer for nCycles CPU cycles. Returns the sum of
  // its output over those cycles.
  _clockSquare(square, nCycles) {
    const period = (square.progTimerMax + 1) << 1;
    let count = square.progTimerCount;
    if (count < 0) count = 0;
    let remaining = nCycles;
    if (
      !(square.isEnabled && square.lengthCounter > 0 && square.progTimerMax > 7)
    ) {
      // Silent (see ChannelSquare.updateSampleValue()): the output is 0 on
      // every step, so just work out where the waveform ends up.
      if (count > remaining) {
        square.progTimerCount = count - remaining;
      } else {
        const rest = remaining - count;
        const steps = 1 + Math.floor(rest / period);
        square.squareCounter = (square.squareCounter + steps) & 0x7;
        square.progTimerCount = period - (rest % period);
        square.sampleValue = 0;
      }
      return 0;
    }
    let sum = 0;
    // The waveform steps when the timer reaches 0.
    while (count <= remaining) {
      sum += square.sampleValue * count;
      remaining -= count;
      count = period;
      square.squareCounter = (square.squareCounter + 1) & 0x7;
      square.updateSampleValue();
    }
    square.progTimerCount = count - remaining;
    return sum + square.sampleValue * remaining;
  }

  // Run the noise channel's timer for nCycles CPU cycles, accumulating its
  // output into noise.accValue/accCount. The output changes on the cycle
  // the timer reaches 0, and that cycle already counts with the new value.
  _clockNoise(noise, nCycles) {
    noise.accCount += nCycles;
    if (noise.progTimerMax <= 0) {
      noise.progTimerCount -= nCycles;
      noise.accValue += nCycles * noise.sampleValue;
      return;
    }
    let count = noise.progTimerCount;
    if (count < 1) count = 1;
    let remaining = nCycles;
    let sum = 0;
    while (count <= remaining) {
      sum += noise.sampleValue * (count - 1);
      remaining -= count;
      // Step the 15-bit shift register (the "random" bit generator).
      noise.shiftReg <<= 1;
      noise.tmp =
        ((noise.shiftReg << (noise.randomMode === 0 ? 1 : 6)) ^
          noise.shiftReg) &
        0x8000;
      if (noise.tmp !== 0) {
        noise.shiftReg |= 0x01;
        noise.randomBit = 0;
        noise.sampleValue = 0;
      } else {
        noise.randomBit = 1;
        noise.sampleValue =
          noise.isEnabled && noise.lengthCounter > 0 ? noise.masterVolume : 0;
      }
      sum += noise.sampleValue;
      count = noise.progTimerMax;
    }
    noise.progTimerCount = count - remaining;
    noise.accValue += sum + noise.sampleValue * remaining;
  }

  // Set or clear the frame interrupt flag, updating the CPU's IRQ line.
  // The line is only asserted if IRQs are not inhibited by $4017 bit 6.
  _setFrameIrq(active) {
    this.frameIrqActive = active;
    this.nes.cpu.setIrqSource(IRQ_SOURCE_FRAME, active && this.frameIrqEnabled);
  }

  // The APU is clocked at half the CPU rate, so each CPU cycle is either the
  // first ("get") or second ("put") half of an APU cycle. The DMA unit
  // (which shares this clock) reads on get cycles and writes on put cycles,
  // so after an OAM DMA the CPU is always on a known phase; test ROMs rely
  // on this to time their $4015/$4017 accesses.
  // Returns true if the current CPU cycle is a "put" cycle.
  // See https://www.nesdev.org/wiki/APU#Glossary and https://www.nesdev.org/wiki/DMA
  _isPutCycle() {
    return (this.nes.cpu.cycles & 1) === 1;
  }

  // Fire any frame counter steps that are due. The step loop and period
  // wrap are separate: steps fire when the counter reaches each step's
  // cycle position, and the period wrap occurs when the counter reaches the
  // full period length (not immediately after the last step). This matters
  // because in 4-step mode, the last step fires at 29829 but the period wrap
  // (and 3rd IRQ assertion) occurs at 29830.
  // See https://www.nesdev.org/wiki/APU_Frame_Counter
  _advanceFrameSteps() {
    let steps = this.countSequence === 0 ? FRAME_STEPS_4 : FRAME_STEPS_5;
    let period = this.countSequence === 0 ? FRAME_PERIOD_4 : FRAME_PERIOD_5;
    for (;;) {
      if (
        this.frameStep < steps.length &&
        this.frameCycleCounter >= steps[this.frameStep]
      ) {
        this.fireFrameStep(this.frameStep);
        this.frameStep++;
      } else if (
        this.frameStep >= steps.length &&
        this.frameCycleCounter >= period
      ) {
        // Period wrap: reset the frame counter for the next sequence.
        this.frameStep = 0;
        this.frameCycleCounter -= period;
        // In 4-step mode, the IRQ flag is asserted for 3 consecutive CPU
        // cycles: at 29828 (step 3), 29829 (step 4), and 29830 (period wrap).
        // On the 3rd cycle (period wrap), the flag is set only if the IRQ
        // inhibit flag is clear. If inhibit is set, the flag is actively
        // cleared (it was unconditionally set on cycles 29828-29829).
        // See https://www.nesdev.org/wiki/APU_Frame_Counter
        if (this.countSequence === 0) {
          this.frameIrqClearPending = false;
          this._setFrameIrq(this.frameIrqEnabled);
        }
      } else {
        break;
      }
    }
    this._updateNextFrameEvent();
  }

  // Cache the counter value at which _advanceFrameSteps next has work to
  // do, so clockCycle() only needs a single comparison.
  _updateNextFrameEvent() {
    let steps = this.countSequence === 0 ? FRAME_STEPS_4 : FRAME_STEPS_5;
    let period = this.countSequence === 0 ? FRAME_PERIOD_4 : FRAME_PERIOD_5;
    this.nextFrameEvent =
      this.frameStep < steps.length ? steps[this.frameStep] : period;
  }

  accSample(cycles) {
    // Special treatment for triangle channel - need to interpolate.
    if (this.triangle.sampleCondition) {
      this.triValue = Math.floor(
        (this.triangle.progTimerCount << 4) / (this.triangle.progTimerMax + 1),
      );
      if (this.triValue > 16) {
        this.triValue = 16;
      }
      if (this.triangle.triangleCounter >= 16) {
        this.triValue = 16 - this.triValue;
      }

      // Add non-interpolated sample value:
      this.triValue += this.triangle.sampleValue;
    }

    // Now sample normally:
    // (The square channels are accumulated in _clockChannels().)
    this.smpTriangle += cycles * this.triValue;
    this.smpDmc += cycles * this.dmc.sample;
    this.accCount += cycles;
  }

  // Fire a frame counter step. Each step clocks different APU units depending
  // on the mode and step number.
  // See https://www.nesdev.org/wiki/APU_Frame_Counter
  fireFrameStep(step) {
    if (this.countSequence === 0) {
      // Mode 0 (4-step):
      //   Step 0 (7457): quarter frame (envelope + linear counter)
      //   Step 1 (14913): half frame (quarter + length counter + sweep)
      //   Step 2 (22371): quarter frame
      //   Step 3 (29828): set frame IRQ flag only (1 cycle before clock)
      //   Step 4 (29829): half frame + set frame IRQ flag
      // On real hardware, the IRQ flag is asserted 1 CPU cycle before the
      // clock event at the end of the 4-step sequence. This is why step 3
      // is split from step 4.
      // See https://www.nesdev.org/wiki/APU_Frame_Counter
      switch (step) {
        case 0:
          this.clockQuarterFrame();
          break;
        case 1:
          this.clockQuarterFrame();
          this.clockHalfFrame();
          break;
        case 2:
          this.clockQuarterFrame();
          break;
        case 3:
          // IRQ flag is UNCONDITIONALLY set 1 CPU cycle before the half-frame
          // clock, regardless of the IRQ inhibit flag ($4017 bit 6). On real
          // hardware, the flag is driven high by the frame counter output for
          // cycles 29828-29829 even when inhibit is set; only the period wrap
          // at 29830 respects the inhibit flag. Cancel any pending deferred
          // clear since the flag is being re-asserted by hardware.
          // See AccuracyCoin tests I-L.
          this.frameIrqClearPending = false;
          this._setFrameIrq(true);
          break;
        case 4:
          this.clockQuarterFrame();
          this.clockHalfFrame();
          // IRQ flag continues to be unconditionally asserted on this cycle.
          this.frameIrqClearPending = false;
          this._setFrameIrq(true);
          break;
      }
    } else {
      // Mode 1 (5-step):
      //   Step 0: quarter frame
      //   Step 1: half frame
      //   Step 2: quarter frame
      //   Step 3: nothing (no clocking, no IRQ)
      //   Step 4: half frame
      switch (step) {
        case 0:
          this.clockQuarterFrame();
          break;
        case 1:
          this.clockQuarterFrame();
          this.clockHalfFrame();
          break;
        case 2:
          this.clockQuarterFrame();
          break;
        case 3:
          // Nothing happens at step 4 in 5-step mode
          break;
        case 4:
          this.clockQuarterFrame();
          this.clockHalfFrame();
          break;
      }
    }
  }

  // Quarter frame: clock envelopes and triangle linear counter (~240Hz)
  clockQuarterFrame() {
    this._flushAudio();
    this.square1.clockEnvDecay();
    this.square2.clockEnvDecay();
    this.noise.clockEnvDecay();
    this.triangle.clockLinearCounter();
  }

  // Half frame: clock length counters and sweep units (~120Hz)
  clockHalfFrame() {
    this.triangle.clockLengthCounter();
    this.square1.clockLengthCounter();
    this.square2.clockLengthCounter();
    this.noise.clockLengthCounter();
    this.square1.clockSweep();
    this.square2.clockSweep();
  }

  // Samples the channels, mixes the output together, then writes to buffer.
  sample() {
    let sq_index, tnd_index;

    if (this.accCount > 0) {
      this.smpSquare1 <<= 4;
      this.smpSquare1 = Math.floor(this.smpSquare1 / this.accCount);

      this.smpSquare2 <<= 4;
      this.smpSquare2 = Math.floor(this.smpSquare2 / this.accCount);

      this.smpTriangle = Math.floor(this.smpTriangle / this.accCount);

      this.smpDmc <<= 4;
      this.smpDmc = Math.floor(this.smpDmc / this.accCount);

      this.accCount = 0;
    } else {
      this.smpSquare1 = this.square1.sampleValue << 4;
      this.smpSquare2 = this.square2.sampleValue << 4;
      this.smpTriangle = this.triangle.sampleValue;
      this.smpDmc = this.dmc.sample << 4;
    }

    let smpNoise = Math.floor((this.noise.accValue << 4) / this.noise.accCount);
    this.noise.accValue = smpNoise >> 4;
    this.noise.accCount = 1;

    // Stereo sound.

    // Left channel:
    sq_index =
      (this.smpSquare1 * this.stereoPosLSquare1 +
        this.smpSquare2 * this.stereoPosLSquare2) >>
      8;
    tnd_index =
      (3 * this.smpTriangle * this.stereoPosLTriangle +
        (smpNoise << 1) * this.stereoPosLNoise +
        this.smpDmc * this.stereoPosLDMC) >>
      8;
    if (sq_index >= this.square_table.length) {
      sq_index = this.square_table.length - 1;
    }
    if (tnd_index >= this.tnd_table.length) {
      tnd_index = this.tnd_table.length - 1;
    }
    let sampleValueL =
      this.square_table[sq_index] + this.tnd_table[tnd_index] - this.dcValue;

    // Right channel:
    sq_index =
      (this.smpSquare1 * this.stereoPosRSquare1 +
        this.smpSquare2 * this.stereoPosRSquare2) >>
      8;
    tnd_index =
      (3 * this.smpTriangle * this.stereoPosRTriangle +
        (smpNoise << 1) * this.stereoPosRNoise +
        this.smpDmc * this.stereoPosRDMC) >>
      8;
    if (sq_index >= this.square_table.length) {
      sq_index = this.square_table.length - 1;
    }
    if (tnd_index >= this.tnd_table.length) {
      tnd_index = this.tnd_table.length - 1;
    }
    let sampleValueR =
      this.square_table[sq_index] + this.tnd_table[tnd_index] - this.dcValue;

    // Remove DC from left channel:
    let smpDiffL = sampleValueL - this.prevSampleL;
    this.prevSampleL += smpDiffL;
    this.smpAccumL += smpDiffL - (this.smpAccumL >> 10);
    sampleValueL = this.smpAccumL;

    // Remove DC from right channel:
    let smpDiffR = sampleValueR - this.prevSampleR;
    this.prevSampleR += smpDiffR;
    this.smpAccumR += smpDiffR - (this.smpAccumR >> 10);
    sampleValueR = this.smpAccumR;

    // Write:
    if (sampleValueL > this.maxSample) {
      this.maxSample = sampleValueL;
    }
    if (sampleValueL < this.minSample) {
      this.minSample = sampleValueL;
    }

    if (this.nes.opts.onAudioSample) {
      this.nes.opts.onAudioSample(sampleValueL / 32768, sampleValueR / 32768);
    }

    // Reset sampled values:
    this.smpSquare1 = 0;
    this.smpSquare2 = 0;
    this.smpTriangle = 0;
    this.smpDmc = 0;
  }

  getLengthMax(value) {
    return this.lengthLookup[value >> 3];
  }

  getDmcFrequency(value) {
    if (value >= 0 && value < 0x10) {
      return this.dmcFreqLookup[value];
    }
    return 0;
  }

  getNoiseWaveLength(value) {
    if (value >= 0 && value < 0x10) {
      return this.noiseWavelengthLookup[value];
    }
    return 0;
  }

  // Recalculate the sample timer for a non-standard host frame rate.
  // At 60fps the timer fires once per (CPU_FREQ / sampleRate) cycles. If the
  // host calls frame() at a different rate, scale proportionally so the total
  // audio output per second stays constant.
  setFrameRate(rate) {
    this.sampleTimerMax = Math.floor(
      (1024.0 * CPU_FREQ_NTSC * rate) / (this.sampleRate * 60.0),
    );
  }

  setPanning(pos) {
    for (let i = 0; i < 5; i++) {
      this.panning[i] = pos[i];
    }
    this.updateStereoPos();
  }

  setMasterVolume(value) {
    if (value < 0) {
      value = 0;
    }
    if (value > 256) {
      value = 256;
    }
    this.masterVolume = value;
    this.updateStereoPos();
  }

  updateStereoPos() {
    this.stereoPosLSquare1 = (this.panning[0] * this.masterVolume) >> 8;
    this.stereoPosLSquare2 = (this.panning[1] * this.masterVolume) >> 8;
    this.stereoPosLTriangle = (this.panning[2] * this.masterVolume) >> 8;
    this.stereoPosLNoise = (this.panning[3] * this.masterVolume) >> 8;
    this.stereoPosLDMC = (this.panning[4] * this.masterVolume) >> 8;

    this.stereoPosRSquare1 = this.masterVolume - this.stereoPosLSquare1;
    this.stereoPosRSquare2 = this.masterVolume - this.stereoPosLSquare2;
    this.stereoPosRTriangle = this.masterVolume - this.stereoPosLTriangle;
    this.stereoPosRNoise = this.masterVolume - this.stereoPosLNoise;
    this.stereoPosRDMC = this.masterVolume - this.stereoPosLDMC;
  }

  initLengthLookup() {
    // prettier-ignore
    this.lengthLookup = [
            0x0A, 0xFE,
            0x14, 0x02,
            0x28, 0x04,
            0x50, 0x06,
            0xA0, 0x08,
            0x3C, 0x0A,
            0x0E, 0x0C,
            0x1A, 0x0E,
            0x0C, 0x10,
            0x18, 0x12,
            0x30, 0x14,
            0x60, 0x16,
            0xC0, 0x18,
            0x48, 0x1A,
            0x10, 0x1C,
            0x20, 0x1E
        ];
  }

  initDmcFrequencyLookup() {
    this.dmcFreqLookup = new Array(16);

    this.dmcFreqLookup[0x0] = 0xd60;
    this.dmcFreqLookup[0x1] = 0xbe0;
    this.dmcFreqLookup[0x2] = 0xaa0;
    this.dmcFreqLookup[0x3] = 0xa00;
    this.dmcFreqLookup[0x4] = 0x8f0;
    this.dmcFreqLookup[0x5] = 0x7f0;
    this.dmcFreqLookup[0x6] = 0x710;
    this.dmcFreqLookup[0x7] = 0x6b0;
    this.dmcFreqLookup[0x8] = 0x5f0;
    this.dmcFreqLookup[0x9] = 0x500;
    this.dmcFreqLookup[0xa] = 0x470;
    this.dmcFreqLookup[0xb] = 0x400;
    this.dmcFreqLookup[0xc] = 0x350;
    this.dmcFreqLookup[0xd] = 0x2a0;
    this.dmcFreqLookup[0xe] = 0x240;
    this.dmcFreqLookup[0xf] = 0x1b0;
    //for(int i=0;i<16;i++)dmcFreqLookup[i]/=8;
  }

  initNoiseWavelengthLookup() {
    this.noiseWavelengthLookup = new Array(16);

    this.noiseWavelengthLookup[0x0] = 0x004;
    this.noiseWavelengthLookup[0x1] = 0x008;
    this.noiseWavelengthLookup[0x2] = 0x010;
    this.noiseWavelengthLookup[0x3] = 0x020;
    this.noiseWavelengthLookup[0x4] = 0x040;
    this.noiseWavelengthLookup[0x5] = 0x060;
    this.noiseWavelengthLookup[0x6] = 0x080;
    this.noiseWavelengthLookup[0x7] = 0x0a0;
    this.noiseWavelengthLookup[0x8] = 0x0ca;
    this.noiseWavelengthLookup[0x9] = 0x0fe;
    this.noiseWavelengthLookup[0xa] = 0x17c;
    this.noiseWavelengthLookup[0xb] = 0x1fc;
    this.noiseWavelengthLookup[0xc] = 0x2fa;
    this.noiseWavelengthLookup[0xd] = 0x3f8;
    this.noiseWavelengthLookup[0xe] = 0x7f2;
    this.noiseWavelengthLookup[0xf] = 0xfe4;
  }

  initDACtables() {
    let value, ival, i;
    let max_sqr = 0;
    let max_tnd = 0;

    this.square_table = new Array(32 * 16);
    this.tnd_table = new Array(204 * 16);

    for (i = 0; i < 32 * 16; i++) {
      value = 95.52 / (8128.0 / (i / 16.0) + 100.0);
      value *= 0.98411;
      value *= 50000.0;
      ival = Math.floor(value);

      this.square_table[i] = ival;
      if (ival > max_sqr) {
        max_sqr = ival;
      }
    }

    for (i = 0; i < 204 * 16; i++) {
      value = 163.67 / (24329.0 / (i / 16.0) + 100.0);
      value *= 0.98411;
      value *= 50000.0;
      ival = Math.floor(value);

      this.tnd_table[i] = ival;
      if (ival > max_tnd) {
        max_tnd = ival;
      }
    }

    this.dacRange = max_sqr + max_tnd;
    this.dcValue = this.dacRange / 2;
  }

  toJSON() {
    this.catchUp(this.nes.cpu.cycles);
    let obj = toJSON(this);
    obj.dmc = this.dmc.toJSON();
    obj.noise = this.noise.toJSON();
    obj.square1 = this.square1.toJSON();
    obj.square2 = this.square2.toJSON();
    obj.triangle = this.triangle.toJSON();
    return obj;
  }

  fromJSON(s) {
    fromJSON(this, s);
    this.dmc.fromJSON(s.dmc);
    this.noise.fromJSON(s.noise);
    this.square1.fromJSON(s.square1);
    this.square2.fromJSON(s.square2);
    this.triangle.fromJSON(s.triangle);
    this._scheduleNextEvent();
  }

  static JSON_PROPERTIES = [
    "channelEnableValue",
    "sampleRate",
    "frameIrqEnabled",
    "frameIrqActive",
    "frameIrqClearPending",
    "frameIrqClearDelay",
    "nextFrameEvent",
    "pendingAudioCycles",
    "lastCycle",
    "audioFlushAt",
    "startedPlaying",
    "recordOutput",
    "frameCycleCounter",
    "frameStep",
    "countSequence",
    "sampleTimer",
    "sampleTimerMax",
    "sampleCount",
    "triValue",
    "smpSquare1",
    "smpSquare2",
    "smpTriangle",
    "smpDmc",
    "accCount",
    "prevSampleL",
    "prevSampleR",
    "smpAccumL",
    "smpAccumR",
    "masterVolume",
    "stereoPosLSquare1",
    "stereoPosLSquare2",
    "stereoPosLTriangle",
    "stereoPosLNoise",
    "stereoPosLDMC",
    "stereoPosRSquare1",
    "stereoPosRSquare2",
    "stereoPosRTriangle",
    "stereoPosRNoise",
    "stereoPosRDMC",
    "maxSample",
    "minSample",
    "panning",
  ];
}

__exp.default = PAPU;


return __exp;
}
function __m_ppu_index_js() {
const __exp = {};
const Tile = __req("tile.js").default;
const { fromJSON, toJSON } = __req("utils.js");
const NameTable = __req("ppu/nametable.js").default;
const PaletteTable = __req("ppu/palette-table.js").default;

// ============================================================================
// The PPU (Picture Processing Unit, Ricoh 2C02)
// ============================================================================
//
// The PPU generates the video signal. It draws a 256x240 picture, one pixel
// per PPU clock cycle ("dot"), and runs at exactly 3x the CPU's clock. A
// frame is 262 scanlines of 341 dots each:
//
//   Scanlines 0-239   Visible picture. Dots 1-256 output pixels.
//   Scanline  240     Post-render (idle).
//   Scanlines 241-260 Vertical blanking ("VBlank"). The VBlank flag is set
//                     (and an NMI can fire) at dot 1 of scanline 241. This
//                     is when games safely update VRAM.
//   Scanline  261     Pre-render. Like a visible line (it does all the same
//                     memory fetches), but outputs no pixels. Flags are
//                     cleared at dot 1.
//
// This emulator is *dot-stepped*: the PPU's internal pipeline runs one dot
// at a time (_tick(), or _renderSpan() for runs of visible pixels), doing
// the same memory fetches and register updates the real chip does on each
// dot. The CPU owes the PPU 3 dots per CPU cycle and the PPU is kept exactly
// in step with it (see catchUp()), so mid-frame register writes take effect
// on exactly the right pixel.
//
// Background rendering (per visible/pre-render scanline):
//   Every 8 dots, the PPU fetches one tile: nametable byte (which tile),
//   attribute byte (which palette), and the two "bit planes" of the tile's
//   pattern. These are loaded into shift registers that shift once per dot;
//   each dot's background pixel comes from the top bits of the shifters.
//   The "v" register is the current VRAM address and doubles as the scroll
//   position: it's incremented horizontally after each tile and vertically
//   at the end of each line.
//
// Sprite rendering:
//   During dots 1-256 of each visible line, the PPU scans OAM (sprite
//   memory) to find up to 8 sprites on the *next* line, copying them into a
//   32-byte "secondary OAM". During dots 257-320 it fetches the pattern data
//   for those 8 sprites into 8 sets of sprite shift registers, which output
//   their pixels on the next line once their X counter reaches zero.
//
// Lots of games and test ROMs rely on quirks of this pipeline (mid-frame
// scroll changes, sprite 0 hit timing, sprite overflow bugs, etc.), which
// all fall out of emulating it faithfully.
//
// Key references:
//   https://www.nesdev.org/wiki/PPU_rendering
//   https://www.nesdev.org/wiki/PPU_scrolling
//   https://www.nesdev.org/wiki/PPU_sprite_evaluation
//   https://www.nesdev.org/wiki/PPU_frame_timing

// Dots between a $2001 write and the rendering pipeline seeing the new
// "rendering enabled" state. On real hardware the delay is a few dots and
// depends on the CPU/PPU clock alignment.
const MASK_DELAY = 2;

class PPU {
  // Status flags (bit numbers in $2002):
  STATUS_VRAMWRITE = 4;
  STATUS_SLSPRITECOUNT = 5;
  STATUS_SPRITE0HIT = 6;
  STATUS_VBLANK = 7;

  constructor(nes) {
    this.nes = nes;

    // Rendering options:
    this.clipToTvSize = true;

    let i;

    // --- Memory ---
    // PPU address space, $0000-$3FFF (plus space above for mirroring
    // tables). Pattern tables ($0000-$1FFF) are copied in by the mapper when
    // it switches CHR banks; nametables ($2000-$2FFF) and palette RAM
    // ($3F00-$3F1F) live here too. vramMirrorTable maps every address to the
    // physical location that backs it.
    this.vramMem = new Uint8Array(0x8000);
    // OAM ("Object Attribute Memory"): 64 sprites x 4 bytes (Y, tile,
    // attributes, X).
    this.spriteMem = new Uint8Array(0x100);
    // Secondary OAM: the up-to-8 sprites found for the next scanline.
    this.secondaryOAM = new Uint8Array(32).fill(0xff);

    this.vramMirrorTable = new Uint16Array(0x8000);
    for (i = 0; i < 0x8000; i++) {
      this.vramMirrorTable[i] = i;
    }
    this.currentMirroring = -1;
    // Which of the (up to) 4 physical nametables each logical nametable
    // uses. Kept for mappers that manage mirroring themselves.
    this.ntable1 = [0, 1, 2, 3];
    this.nameTable = new Array(4);
    for (i = 0; i < 4; i++) {
      this.nameTable[i] = new NameTable(32, 32, `Nt${i}`);
    }

    // Pre-decoded pattern tiles. The renderer reads pattern bytes straight
    // from vramMem, but mappers still maintain this cache (and MMC5's
    // extended attribute mode returns tiles from it), so keep it up to date.
    this.ptTile = new Array(512);
    for (i = 0; i < 512; i++) {
      this.ptTile[i] = new Tile();
    }

    // --- Registers ---
    // "Loopy" registers (named after the person who documented them):
    //   v: current VRAM address (15 bits). During rendering, its bits are
    //      yyy NN YYYYY XXXXX = fine Y, nametable, coarse Y, coarse X.
    //   t: temporary VRAM address; the "scroll position" written by
    //      $2000/$2005/$2006, copied into v at certain times.
    //   x: fine X scroll (3 bits).
    //   w: first/second write toggle shared by $2005 and $2006.
    // See https://www.nesdev.org/wiki/PPU_scrolling
    this.vramAddress = 0; // v
    this.vramTmpAddress = 0; // t
    this.fineX = 0; // x
    this.firstWrite = true; // !w
    this.vramBufferedReadValue = 0; // $2007 read buffer
    this.sramAddress = 0; // OAMADDR ($2003)

    // PPU has its own internal I/O bus. All PPU register writes update this
    // latch. Reading write-only registers ($2000,$2001,$2003,$2005,$2006)
    // returns this value. $2002 uses bits 4-0 from this latch.
    // On real hardware the latch decays to 0 after ~600ms.
    this.openBusLatch = 0;
    this.openBusDecayFrames = 0;

    // $2000 (PPUCTRL)
    this.f_nmiOnVblank = 0; // NMI on VBlank. 0=disable, 1=enable
    this.f_spriteSize = 0; // Sprite size. 0=8x8, 1=8x16
    this.f_bgPatternTable = 0; // Background pattern table. 0=$0000, 1=$1000
    this.f_spPatternTable = 0; // Sprite pattern table (8x8). 0=$0000, 1=$1000
    this.f_addrInc = 0; // $2007 address increment. 0=1, 1=32
    this.f_nTblAddress = 0; // Base nametable (also stored in t)

    // $2001 (PPUMASK)
    this.f_color = 0; // Color emphasis bits
    this.f_spVisibility = 0; // Show sprites
    this.f_bgVisibility = 0; // Show background
    this.f_spClipping = 0; // Show sprites in leftmost 8 pixels
    this.f_bgClipping = 0; // Show background in leftmost 8 pixels
    this.f_dispType = 0; // Greyscale

    // $2002 (PPUSTATUS) flags
    this.vblankFlag = 0;
    this.sprite0HitFlag = 0;
    this.spriteOverflowFlag = 0;

    // NMI output line (vblankFlag AND f_nmiOnVblank). The CPU samples it.
    this.nmiOutput = false;
    // nmiOutput at the point in the current CPU cycle where the CPU samples
    // it (see runCycleExact()).
    this.nmiAtPoll = false;

    // Catch-up state (see catchUp()): dots the CPU has asked for, dots
    // actually run, and the dot of the next event the CPU could notice.
    this.dotTarget = 0;
    this.dotsRun = 0;
    this.nextEventDot = 0;
    // Set when $2002 is read on the dot just before VBlank would be set,
    // which prevents the flag being set (and the NMI) for that frame.
    this.nmiSuppressed = false;
    // Set when VBlank starts; tells the frame loop the frame is complete.
    this.frameEnded = false;

    // --- Timing ---
    // Current position: line 0-261 and dot 0-340 (the dot that the next
    // tick will process). We start in VBlank, just after it began.
    this.line = 241;
    this.dot = 2;
    // Old-style scanline number (0 = first VBlank line, 20 = pre-render,
    // 21-260 = visible lines 0-239, 261 = post-render), which mappers use.
    this.scanline = 0;
    this.oddFrame = false;

    // Whether the rendering pipeline is running (background or sprites
    // enabled), as seen by the pipeline after the $2001 write delay.
    this.renderingOn = false;
    this.maskDelay = 0;

    // --- Background pipeline ---
    this.bgShiftLo = 0; // 16-bit pattern shift registers
    this.bgShiftHi = 0;
    this.attrShiftLo = 0; // 8-bit attribute (palette) shift registers
    this.attrShiftHi = 0;
    this.attrLatchLo = 0; // Serial inputs for the attribute shifters
    this.attrLatchHi = 0;
    this.ntByte = 0; // Latches for the tile being fetched
    this.atBits = 0;
    this.ptLo = 0;
    this.ptHi = 0;

    // --- Sprite evaluation ---
    this.secIdx = 0; // Secondary OAM address (0-31)
    this.secFull = false;
    this.oamLatch = 0; // Byte read from OAM on the previous (odd) dot
    this.evalDone = false; // All of OAM has been scanned
    this.evalOvfStep = 0; // Progress through a sprite in overflow mode
    this.sprite0Next = false; // Sprite 0 found for the next line
    this.sprite0Line = false; // Sprite 0 is in slot 0 on this line
    // OAM corruption: see _renderingDisabled().
    this.oamCorruptPending = false;
    this.oamCorruptRow = 0;

    // --- Sprite output units (8 slots) ---
    this.sprCount = 0; // Slots (from 0) that may output pixels this line
    this.sprLo = new Uint8Array(8); // Pattern shift registers
    this.sprHi = new Uint8Array(8);
    this.sprAttr = new Uint8Array(8);
    this.sprX = new Uint8Array(8); // X down-counters
    this.sprLatchX = new Uint8Array(8); // X positions read during fetch
    this.sprFetchCount = 0; // Slots fetched for the next line
    // Odd-frame quirk, see the end of _tick().
    this.spriteSkipGlitch = false;
    // Precomputed sprite pixels for one line; see _buildSpriteLine().
    this.sprLine = new Uint16Array(256);
    this.sprLineValid = false;
    this.sprLineFor = -1;

    // --- Output ---
    this.buffer = new Uint32Array(256 * 240);
    // RGB color for each of the 32 palette RAM entries.
    this.palColors = new Uint32Array(32);

    this.palTable = new PaletteTable();
    this.palTable.loadNTSCPalette();

    this.updateControlReg1(0);
    this.updateControlReg2(0);
  }

  // ==========================================================================
  // Memory mapping
  // ==========================================================================

  // Sets nametable mirroring.
  setMirroring(mirroring) {
    if (mirroring === this.currentMirroring) {
      return;
    }

    this.currentMirroring = mirroring;

    // Remove mirroring:
    for (let i = 0; i < 0x8000; i++) {
      this.vramMirrorTable[i] = i;
    }

    // Palette mirroring:
    this.defineMirrorRegion(0x3f20, 0x3f00, 0x20);
    this.defineMirrorRegion(0x3f40, 0x3f00, 0x20);
    this.defineMirrorRegion(0x3f80, 0x3f00, 0x20);
    this.defineMirrorRegion(0x3fc0, 0x3f00, 0x20);

    // Additional mirroring:
    this.defineMirrorRegion(0x3000, 0x2000, 0xf00);
    this.defineMirrorRegion(0x4000, 0x0000, 0x4000);

    if (mirroring === this.nes.rom.HORIZONTAL_MIRRORING) {
      this.ntable1[0] = 0;
      this.ntable1[1] = 0;
      this.ntable1[2] = 1;
      this.ntable1[3] = 1;
      this.defineMirrorRegion(0x2400, 0x2000, 0x400);
      this.defineMirrorRegion(0x2c00, 0x2800, 0x400);
    } else if (mirroring === this.nes.rom.VERTICAL_MIRRORING) {
      this.ntable1[0] = 0;
      this.ntable1[1] = 1;
      this.ntable1[2] = 0;
      this.ntable1[3] = 1;
      this.defineMirrorRegion(0x2800, 0x2000, 0x400);
      this.defineMirrorRegion(0x2c00, 0x2400, 0x400);
    } else if (mirroring === this.nes.rom.SINGLESCREEN_MIRRORING) {
      this.ntable1[0] = 0;
      this.ntable1[1] = 0;
      this.ntable1[2] = 0;
      this.ntable1[3] = 0;
      this.defineMirrorRegion(0x2400, 0x2000, 0x400);
      this.defineMirrorRegion(0x2800, 0x2000, 0x400);
      this.defineMirrorRegion(0x2c00, 0x2000, 0x400);
    } else if (mirroring === this.nes.rom.SINGLESCREEN_MIRRORING2) {
      this.ntable1[0] = 1;
      this.ntable1[1] = 1;
      this.ntable1[2] = 1;
      this.ntable1[3] = 1;
      this.defineMirrorRegion(0x2000, 0x2400, 0x400);
      this.defineMirrorRegion(0x2800, 0x2400, 0x400);
      this.defineMirrorRegion(0x2c00, 0x2400, 0x400);
    } else {
      // Four-screen mirroring.
      this.ntable1[0] = 0;
      this.ntable1[1] = 1;
      this.ntable1[2] = 2;
      this.ntable1[3] = 3;
    }
  }

  // Define a mirrored area in the address lookup table.
  // Assumes the regions don't overlap.
  // The 'to' region is the region that is physically in memory.
  defineMirrorRegion(fromStart, toStart, size) {
    for (let i = 0; i < size; i++) {
      this.vramMirrorTable[fromStart + i] = toStart + i;
    }
  }

  // Reads from PPU memory, taking mirroring into account.
  mirroredLoad(address) {
    return this.vramMem[this.vramMirrorTable[address]];
  }

  // Writes to PPU memory, taking mirroring into account.
  mirroredWrite(address, value) {
    if (address >= 0x3f00 && address < 0x3f20) {
      // Palette RAM. The backdrop entries of the sprite palettes
      // ($3F10/$3F14/$3F18/$3F1C) are mirrors of the background ones.
      if ((address & 0x03) === 0) {
        this.writeMem(address & 0x3f0f, value);
        this.writeMem((address & 0x3f0f) | 0x10, value);
      } else {
        this.writeMem(address, value);
      }
    } else {
      this.writeMem(this.vramMirrorTable[address], value);
    }
  }

  // Writes a byte at a physical PPU memory address.
  writeMem(address, value) {
    this.vramMem[address] = value;
    if (address < 0x2000) {
      this.patternWrite(address, value);
    } else if (address >= 0x3f00 && address < 0x3f20) {
      this._updatePaletteColor(address & 0x1f);
    }
  }

  // Keeps the pre-decoded tile cache in sync with CHR RAM writes.
  patternWrite(address, value) {
    let tileIndex = address >> 4;
    let leftOver = address & 15;
    if (leftOver < 8) {
      this.ptTile[tileIndex].setScanline(
        leftOver,
        value,
        this.vramMem[address + 8],
      );
    } else {
      this.ptTile[tileIndex].setScanline(
        leftOver - 8,
        this.vramMem[address - 8],
        value,
      );
    }
  }

  // The old renderer drew lazily and needed to be told before anything
  // that affects rendering changed. This one renders as it goes, so there's
  // nothing to do; kept because mappers call it.
  triggerRendering() {}

  // ==========================================================================
  // Palette
  // ==========================================================================

  _updatePaletteColor(index) {
    let value = this.vramMem[0x3f00 + index] & 0x3f;
    if (this.f_dispType !== 0) {
      // Greyscale: only keep the brightness bits.
      value &= 0x30;
    }
    this.palColors[index] = this.palTable.getEntry(value);
  }

  updatePalettes() {
    for (let i = 0; i < 32; i++) {
      this._updatePaletteColor(i);
    }
  }

  // ==========================================================================
  // CPU-facing registers ($2000-$2007)
  // ==========================================================================

  // $2000 (PPUCTRL) write.
  updateControlReg1(value) {
    this.f_nmiOnVblank = (value >> 7) & 1;
    this.f_spriteSize = (value >> 5) & 1;
    this.f_bgPatternTable = (value >> 4) & 1;
    this.f_spPatternTable = (value >> 3) & 1;
    this.f_addrInc = (value >> 2) & 1;
    this.f_nTblAddress = value & 3;
    // The nametable select bits go into t.
    this.vramTmpAddress = (this.vramTmpAddress & 0x73ff) | ((value & 3) << 10);
    // Enabling NMI while the VBlank flag is set causes an NMI.
    this._updateNmiOutput();
  }

  // $2001 (PPUMASK) write.
  updateControlReg2(value) {
    this.f_color = (value >> 5) & 7;
    this.f_spVisibility = (value >> 4) & 1;
    this.f_bgVisibility = (value >> 3) & 1;
    this.f_spClipping = (value >> 2) & 1;
    this.f_bgClipping = (value >> 1) & 1;
    this.f_dispType = value & 1;

    if (this.f_dispType === 0) {
      this.palTable.setEmphasis(this.f_color);
    }
    this.updatePalettes();

    // The rendering pipeline notices the change a couple of dots later.
    if (MASK_DELAY === 0) {
      this._applyRenderingEnable();
    } else {
      this.maskDelay = MASK_DELAY;
    }
  }

  // Update the pipeline's "rendering enabled" state from PPUMASK.
  _applyRenderingEnable() {
    const on = this.f_bgVisibility === 1 || this.f_spVisibility === 1;
    if (this.renderingOn && !on) {
      this._materializeSprites();
      this._renderingDisabled();
    }
    this.renderingOn = on;
  }

  // NMI output = VBlank flag AND NMI enable. The CPU samples this line every
  // cycle and fires an NMI on its rising edge. See https://www.nesdev.org/wiki/NMI
  _updateNmiOutput() {
    this.nmiOutput = this.f_nmiOnVblank !== 0 && this.vblankFlag !== 0;
  }

  // Sets one of the $2002 status flags (kept for compatibility).
  setStatusFlag(flag, value) {
    const v = value ? 1 : 0;
    if (flag === this.STATUS_VBLANK) {
      this.vblankFlag = v;
      this._updateNmiOutput();
    } else if (flag === this.STATUS_SPRITE0HIT) {
      this.sprite0HitFlag = v;
    } else if (flag === this.STATUS_SLSPRITECOUNT) {
      this.spriteOverflowFlag = v;
    }
  }

  // $2002 (PPUSTATUS) read.
  readStatusRegister() {
    // Reading $2002 on the dot just before VBlank would be set returns the
    // flag clear and prevents it from being set this frame (so no NMI).
    // See https://www.nesdev.org/wiki/PPU_frame_timing#VBL_Flag_Timing
    if (this.line === 241 && this.dot === 1) {
      this.nmiSuppressed = true;
    }

    // Bits 7-5 are the status flags; bits 4-0 are PPU open bus.
    let value =
      (this.vblankFlag << 7) |
      (this.sprite0HitFlag << 6) |
      (this.spriteOverflowFlag << 5) |
      (this.openBusLatch & 0x1f);

    // Reading clears the VBlank flag and the $2005/$2006 write toggle.
    this.vblankFlag = 0;
    this._updateNmiOutput();
    this.firstWrite = true;

    this.openBusLatch = value;
    this.openBusDecayFrames = 36; // ~600ms at 60fps
    return value;
  }

  // $2003 (OAMADDR) write.
  writeSRAMAddress(address) {
    this.sramAddress = address;
  }

  // True on the lines where the rendering pipeline is active (the visible
  // lines and the pre-render line) and rendering is enabled.
  _isRenderingLine() {
    return this.renderingOn && (this.line < 240 || this.line === 261);
  }

  // $2004 (OAMDATA) read.
  // While rendering, $2004 returns whatever the sprite logic currently has on
  // its internal OAM data bus, rather than OAM[OAMADDR]:
  //   dots 1-64: secondary OAM is being cleared, so $FF
  //   dots 65-256: the OAM byte at the evaluation's current address
  //   dots 257-320: the secondary OAM byte being fetched for sprites
  // See https://www.nesdev.org/wiki/PPU_registers#OAMDATA
  sramLoad() {
    if (this._isRenderingLine()) {
      const dot = this.dot;
      if (dot >= 1 && dot <= 64) {
        return 0xff;
      } else if (dot >= 257 && dot <= 320) {
        return this.secondaryOAM[this.secIdx & 0x1f];
      } else if (dot === 0 || dot > 320) {
        return this.secondaryOAM[0];
      }
    }
    return this.spriteMem[this.sramAddress];
  }

  // $2004 (OAMDATA) write.
  sramWrite(value) {
    if (this._isRenderingLine()) {
      // During rendering, writes don't go to OAM; instead they bump the OAM
      // address the way sprite evaluation would (+4, aligned).
      this.sramAddress = (this.sramAddress + 4) & 0xfc;
      return;
    }
    // Bits 2-4 of each sprite's attribute byte don't exist in OAM; they
    // always read back as 0.
    if ((this.sramAddress & 3) === 2) {
      value &= 0xe3;
    }
    this.spriteMem[this.sramAddress] = value;
    this.sramAddress = (this.sramAddress + 1) & 0xff;
  }

  // $2005 (PPUSCROLL) write.
  scrollWrite(value) {
    if (this.firstWrite) {
      // X scroll: coarse X into t, fine X into x.
      this.vramTmpAddress = (this.vramTmpAddress & 0x7fe0) | (value >> 3);
      this.fineX = value & 7;
    } else {
      // Y scroll: coarse Y and fine Y into t.
      this.vramTmpAddress =
        (this.vramTmpAddress & 0x0c1f) |
        ((value & 0xf8) << 2) |
        ((value & 7) << 12);
    }
    this.firstWrite = !this.firstWrite;
  }

  // $2006 (PPUADDR) write.
  writeVRAMAddress(value) {
    if (this.firstWrite) {
      // High 6 bits of the address. Bit 14 of t is cleared.
      this.vramTmpAddress =
        (this.vramTmpAddress & 0x00ff) | ((value & 0x3f) << 8);
    } else {
      this.vramTmpAddress = (this.vramTmpAddress & 0x7f00) | value;
      this.vramAddress = this.vramTmpAddress;
      if (this.vramAddress < 0x2000) {
        this.nes.mmap.latchAccess(this.vramAddress);
      }
    }
    this.firstWrite = !this.firstWrite;
  }

  // $2007 (PPUDATA) read.
  vramLoad() {
    const address = this.vramAddress & 0x3fff;
    let value;
    if (address <= 0x3eff) {
      // Reads are delayed by one: return the buffer, then refill it.
      value = this.vramBufferedReadValue;
      if (address < 0x2000) {
        this.vramBufferedReadValue = this.vramMem[address];
        this.nes.mmap.latchAccess(address);
      } else {
        this.vramBufferedReadValue = this.mirroredLoad(address);
      }
    } else {
      // Palette RAM is returned directly (6 bits, the top 2 bits are PPU
      // open bus), but the buffer is filled with the nametable byte
      // "underneath" the palette.
      let palIdx = address & 0x1f;
      if ((palIdx & 0x13) === 0x10) {
        palIdx &= 0x0f; // sprite backdrop entries mirror the BG ones
      }
      value =
        (this.vramMem[0x3f00 + palIdx] & 0x3f) | (this.openBusLatch & 0xc0);
      this.vramBufferedReadValue = this.mirroredLoad(address & 0x2fff);
    }
    this._incrementVramAddress();
    return value;
  }

  // $2007 (PPUDATA) write.
  vramWrite(value) {
    const address = this.vramAddress & 0x3fff;
    if (address >= 0x2000) {
      this.mirroredWrite(address, value);
    } else {
      // Pattern table: writable only if the cartridge has CHR RAM here.
      if (this.nes.mmap.canWriteChr(address)) {
        this.writeMem(address, value);
      }
      this.nes.mmap.latchAccess(address);
    }
    this._incrementVramAddress();
  }

  // Advance v after a $2007 access. Outside rendering, by 1 or 32. During
  // rendering, v is being used as the scroll position, and the access
  // triggers both a coarse X and a Y increment instead.
  // See https://www.nesdev.org/wiki/PPU_scrolling#$2007_reads_and_writes
  _incrementVramAddress() {
    if (this._isRenderingLine()) {
      this._incCoarseX();
      this._incY();
    } else {
      this.vramAddress =
        (this.vramAddress + (this.f_addrInc === 1 ? 32 : 1)) & 0x7fff;
    }
  }

  // ==========================================================================
  // Scrolling helpers (operate on v)
  // ==========================================================================

  _incCoarseX() {
    let v = this.vramAddress;
    if ((v & 0x001f) === 31) {
      v = (v & ~0x001f) ^ 0x0400; // wrap and switch horizontal nametable
    } else {
      v++;
    }
    this.vramAddress = v;
  }

  _incY() {
    let v = this.vramAddress;
    if ((v & 0x7000) !== 0x7000) {
      v += 0x1000; // fine Y
    } else {
      v &= ~0x7000;
      let y = (v & 0x03e0) >> 5;
      if (y === 29) {
        y = 0;
        v ^= 0x0800; // switch vertical nametable
      } else if (y === 31) {
        y = 0; // coarse Y 30/31 are the attribute table; wrap without switching
      } else {
        y++;
      }
      v = (v & ~0x03e0) | (y << 5);
    }
    this.vramAddress = v;
  }

  // ==========================================================================
  // The dot clock
  // ==========================================================================

  // --- Catch-up ---
  //
  // The CPU owes the PPU 3 dots per CPU cycle (dotTarget counts them), but
  // the PPU doesn't run them straight away. Running the PPU in batches is
  // much faster than interleaving it with the CPU one cycle at a time, and
  // gives the same result as long as the batches are run before anything
  // looks at or changes the PPU's state. So:
  //   - Before the CPU accesses a PPU register or the cartridge, it calls
  //     catchUp() to run all the dots owed so far.
  //   - The PPU works out when its next "event" is: something the CPU
  //     would notice without accessing a register (the NMI line changing
  //     at the start/end of VBlank, the mapper's scanline counter being
  //     clocked, the end of the frame). On the CPU cycle containing that
  //     dot, runCycleExact() runs the PPU in step with the CPU.
  // See https://www.nesdev.org/wiki/Catch-up

  // Run all the dots owed by the CPU.
  catchUp() {
    const target = this.dotTarget;
    while (this.dotsRun < target) {
      const dot = this.dot;
      if (
        this.line < 240 &&
        dot >= 1 &&
        dot <= 256 &&
        this.renderingOn &&
        this.maskDelay === 0 &&
        !this.oamCorruptPending
      ) {
        // Fast path: a run of pixels on a visible line.
        let end = dot + (target - this.dotsRun);
        if (end > 257) end = 257;
        this._renderSpan(this.line, dot, end);
        this.dotsRun += end - dot;
        this.dot = end;
      } else if (
        dot >= 257 &&
        dot <= 320 &&
        (this.line < 240 || this.line === 261) &&
        this.renderingOn &&
        this.maskDelay === 0 &&
        !this.oamCorruptPending
      ) {
        // Fast path: sprite fetches during horizontal blanking.
        let end = dot + (target - this.dotsRun);
        if (end > 321) end = 321;
        this._spriteFetchSpan(this.line, dot, end, this.line === 261);
        this.dotsRun += end - dot;
        this.dot = end;
      } else if (
        this.line >= 240 &&
        this.line <= 260 &&
        (this.line !== 241 || dot >= 2) &&
        this.maskDelay === 0
      ) {
        // Fast path: nothing happens on the post-render and VBlank lines
        // (apart from VBlank starting at line 241, dot 1), so skip ahead.
        const left = 341 - dot;
        const owed = target - this.dotsRun;
        if (owed >= left) {
          this.dotsRun += left;
          this._nextLine();
        } else {
          this.dotsRun += owed;
          this.dot = dot + owed;
        }
      } else {
        this._tick();
        this.dotsRun++;
      }
    }
  }

  // Run the current CPU cycle's 3 dots exactly in step with the CPU, then
  // work out when the next event is. nmiAtPoll records the NMI output after
  // the first dot of the cycle, which is when the CPU samples it.
  runCycleExact() {
    const target = this.dotTarget;
    this.dotTarget = target - 2;
    this.catchUp();
    this.nmiAtPoll = this.nmiOutput;
    this.dotTarget = target;
    this.catchUp();
    this._scheduleNextEvent();
  }

  // Number of dots from the current position until the PPU reaches
  // (line, dot) for the next time.
  _dotsUntil(line, dot) {
    let d = (line - this.line) * 341 + (dot - this.dot);
    if (d < 0) d += 262 * 341;
    return d;
  }

  // Work out the dot (in dotsRun units) of the next event the CPU might
  // notice. See catchUp().
  _scheduleNextEvent() {
    // VBlank start and end, and the odd-frame dot skip (which changes the
    // length of the frame, so we sync there to keep this arithmetic simple).
    let d = this._dotsUntil(241, 1);
    let e = this._dotsUntil(261, 1);
    if (e < d) d = e;
    e = this._dotsUntil(261, 339);
    if (e < d) d = e;
    if (this.renderingOn) {
      // The mapper's scanline counter is clocked once per rendered line.
      const irqDot = this.nes.mmap ? this.nes.mmap.irqClockDot : 260;
      const line = this.line;
      let next;
      if (line < 240) {
        next = this.dot <= irqDot ? line : line + 1;
        if (next === 240) next = 261;
      } else if (line === 261 && this.dot > irqDot) {
        next = 0;
      } else {
        next = 261;
      }
      e = this._dotsUntil(next, irqDot);
      if (e < d) d = e;
    }
    if (this.maskDelay !== 0 && this.maskDelay - 1 < d) {
      // A $2001 write is about to take effect.
      d = this.maskDelay - 1;
    }
    this.nextEventDot = this.dotsRun + d;
  }

  // Process one dot.
  _tick() {
    const line = this.line;
    const dot = this.dot;

    if (line < 240) {
      if (this.renderingOn) {
        this._renderingDot(line, dot, false);
      } else {
        if (dot >= 1 && dot <= 256) {
          this._blankPixel(line, dot - 1);
          // The sprite X counters keep counting down while rendering is
          // off (only the sprite shift registers stop), so a sprite still
          // appears at its normal X position if rendering is re-enabled
          // before it. (AccuracyCoin "BG Serial In")
          for (let i = 0; i < this.sprCount; i++) {
            if (this.sprX[i] !== 0) this.sprX[i]--;
          }
        } else if (dot === 340) {
          this._spriteCountersWithRenderingOff();
        }
      }
    } else if (line === 261) {
      if (dot === 1) {
        // Clear the status flags at the start of the pre-render line.
        this.vblankFlag = 0;
        this.sprite0HitFlag = 0;
        this.spriteOverflowFlag = 0;
        this._updateNmiOutput();
      }
      if (this.renderingOn) {
        this._renderingDot(line, dot, true);
      } else if (dot === 340) {
        this._spriteCountersWithRenderingOff();
      }
    } else if (line === 241 && dot === 1) {
      this._startVBlank();
    }

    // $2001 writes reach the rendering pipeline after a short delay.
    if (this.maskDelay !== 0 && --this.maskDelay === 0) {
      this._applyRenderingEnable();
    }

    // Advance to the next dot.
    if (dot < 340) {
      // Odd frames are one dot shorter when rendering: the last dot of the
      // pre-render line is skipped.
      if (dot === 339 && line === 261 && this.oddFrame && this.renderingOn) {
        this._nextLine();
        // Quirk: skipping dot 340 skips loading the sprite X counters, so
        // the first pixel of every sprite comes out at X=0 and the rest of
        // it one pixel to the left. (AccuracyCoin "Sprites On Scanline 0")
        this.spriteSkipGlitch = true;
        this.sprCount = this.sprFetchCount;
        this.sprLineValid = false;
        return;
      }
      this.dot = dot + 1;
    } else {
      this._nextLine();
    }
  }

  _nextLine() {
    this.dot = 0;
    let line = this.line + 1;
    if (line === 262) {
      line = 0;
      this.oddFrame = !this.oddFrame;
    }
    this.line = line;
    this.scanline = line >= 241 ? line - 241 : line + 21;
  }

  _startVBlank() {
    if (!this.nmiSuppressed) {
      this.vblankFlag = 1;
      this._updateNmiOutput();
    }
    this.nmiSuppressed = false;

    // PPU open bus latch decay: on real hardware each bit decays to 0
    // after ~600ms (~36 frames). We use a simple per-latch frame counter.
    if (this.openBusDecayFrames > 0) {
      this.openBusDecayFrames--;
      if (this.openBusDecayFrames === 0) {
        this.openBusLatch = 0;
      }
    }

    this.endFrame();
    this.frameEnded = true;
  }

  // Output a pixel while rendering is disabled: the backdrop color, or if
  // v points into palette RAM, that palette entry (the "background palette
  // hack"). See https://www.nesdev.org/wiki/PPU_palettes
  _blankPixel(line, x) {
    const v = this.vramAddress & 0x3fff;
    const color = v >= 0x3f00 ? this.palColors[v & 0x1f] : this.palColors[0];
    this.buffer[(line << 8) | x] = color;
  }

  // One dot of a visible or pre-render line, with rendering enabled.
  _renderingDot(line, dot, isPreRender) {
    if (this.oamCorruptPending) {
      this._performOamCorruption();
    }
    if (dot === 0) return; // idle dot

    if (dot > 320 && dot === this.nes.mmap.irqClockDot) {
      // Clock the mapper's scanline counter once per rendered line (MMC3
      // and friends count PPU A12 rising edges during the sprite fetches,
      // around dot 260; see Mapper0.irqClockDot).
      this.nes.mmap.clockIrqCounter();
    }

    if (dot <= 256) {
      if (!isPreRender) {
        this._renderSpan(line, dot, dot + 1);
      } else {
        // The pre-render line does the background fetches, but outputs no
        // pixels and doesn't evaluate sprites.
        this._shiftBg();
        this._bgFetch(dot);
        if (dot === 256) this._incY();
      }
    } else if (dot <= 320) {
      this._spriteFetchSpan(line, dot, dot + 1, isPreRender);
    } else if (dot <= 336) {
      // Prefetch the first two tiles of the next line.
      if (dot === 321) this.nes.mmap.onBgRender();
      this._shiftBg();
      this._bgFetch(dot);
    } else if (dot === 337) {
      // Unused nametable fetch.
      this.ntByte = this.mirroredLoad(0x2000 | (this.vramAddress & 0x0fff));
    } else if (dot === 339) {
      // Unused nametable fetch.
      this.ntByte = this.mirroredLoad(0x2000 | (this.vramAddress & 0x0fff));
    } else if (dot === 340) {
      // Load the sprite X counters for the next line.
      for (let i = 0; i < 8; i++) {
        this.sprX[i] = this.sprLatchX[i];
      }
      this.sprCount = this.sprFetchCount;
      this._buildSpriteLine(line === 261 ? 0 : line + 1);
    }
  }

  // --- Sprite line buffer ---
  //
  // Running the 8 sprite output units on every pixel is slow, and as long
  // as rendering stays enabled for the whole line their output is fully
  // determined when the X counters are loaded at dot 340. So we precompute
  // the line's sprite pixels into sprLine[x]:
  //   bits 0-4: palette index (0x10-0x1F), or 0 for no sprite pixel
  //   bit 8:    sprite is behind the background
  //   bit 9:    the pixel comes from sprite 0 (for sprite 0 hit)
  // If rendering is turned off partway through the line, the sprite units
  // stop advancing, which the buffer can't represent. In that case
  // _materializeSprites() works out the state the counters and shift
  // registers would have reached, and the per-dot path (_spritePixel())
  // takes over.
  _buildSpriteLine(forLine) {
    const sprLine = this.sprLine;
    sprLine.fill(0);
    this.sprLineFor = forLine;
    this.sprLineValid = true;
    // Lower slots have priority, so draw from the highest slot down.
    for (let i = this.sprCount - 1; i >= 0; i--) {
      let lo = this.sprLo[i];
      let hi = this.sprHi[i];
      if ((lo | hi) === 0) continue;
      const attr = this.sprAttr[i];
      const flags =
        0x10 |
        ((attr & 3) << 2) |
        ((attr & 0x20) << 3) |
        (i === 0 && this.sprite0Line ? 0x200 : 0);
      const x0 = this.sprX[i];
      for (let b = 0; b < 8 && x0 + b < 256; b++) {
        const p = ((lo >> 7) & 1) | ((hi >> 6) & 2);
        lo = (lo << 1) & 0xff;
        hi = (hi << 1) & 0xff;
        if (p !== 0) {
          sprLine[x0 + b] = flags | p;
        }
      }
    }
  }

  // Convert the sprite line buffer back into the state of the sprite
  // output units (X counters and shift registers) at the current dot, and
  // stop using the buffer. See _buildSpriteLine().
  _materializeSprites() {
    if (!this.sprLineValid) return;
    this.sprLineValid = false;
    if (this.line !== this.sprLineFor || this.dot > 256) {
      // Either the line hasn't started (nothing has been output yet), or
      // its pixels are finished and the next line's sprites are already
      // being fetched into the units: nothing to rewind.
      return;
    }
    const done = this.dot > 0 ? this.dot - 1 : 0; // pixels already output
    for (let i = 0; i < this.sprCount; i++) {
      const x0 = this.sprX[i];
      if (done <= x0) {
        this.sprX[i] = x0 - done;
      } else {
        const shift = Math.min(done - x0, 8);
        this.sprX[i] = 0;
        this.sprLo[i] = (this.sprLo[i] << shift) & 0xff;
        this.sprHi[i] = (this.sprHi[i] << shift) & 0xff;
      }
    }
  }

  // Dots [from, to) of the sprite fetch period (257-320) of a visible or
  // pre-render line, with rendering enabled. Each of the 8 sprites found
  // by evaluation gets 8 dots, in which its secondary OAM bytes are read
  // and its pattern is fetched.
  _spriteFetchSpan(line, from, to, isPreRender) {
    if (from === 257) {
      // Copy the horizontal scroll bits from t to v.
      this.vramAddress =
        (this.vramAddress & 0x7be0) | (this.vramTmpAddress & 0x041f);
      this.secIdx = 0;
      this.sprFetchCount = 0;
      this.sprite0Line = this.sprite0Next;
      this.nes.mmap.onSpriteRender();
    }
    // Each sprite's pattern is fetched by the last dot of its 8-dot group.
    const evalLine = isPreRender ? 261 & 0xff : line;
    for (let slot = (from - 257) >> 3; slot < 8; slot++) {
      const fetchDot = 264 + (slot << 3);
      if (fetchDot >= to) break;
      if (fetchDot >= from) this._fetchSprite(slot, evalLine);
    }
    // The secondary OAM address moves on dots 0, 1, 2 and 7 of each 8-dot
    // group (it's used as the OAM corruption "seed"), i.e. 4 times per
    // group.
    this.secIdx =
      (this.secIdx + SEC_IDX_STEPS[to - 257] - SEC_IDX_STEPS[from - 257]) &
      0x1f;
    if (isPreRender && from <= 304 && to > 280) {
      // Copy the vertical scroll bits from t to v (dots 280-304).
      this.vramAddress =
        (this.vramAddress & 0x041f) | (this.vramTmpAddress & 0x7be0);
    }
    const irqDot = this.nes.mmap.irqClockDot;
    if (irqDot >= from && irqDot < to) {
      // Clock the mapper's scanline counter (see Mapper0.irqClockDot).
      this.nes.mmap.clockIrqCounter();
    }
    // OAMADDR is reset to 0 throughout the sprite fetch period.
    this.sramAddress = 0;
  }

  // If rendering is disabled when the sprite X counters would be loaded,
  // they're left at 0: once rendering is re-enabled, the sprites are drawn
  // straight away regardless of their X position.
  // (AccuracyCoin "Stale BG Shift Registers" test 4)
  _spriteCountersWithRenderingOff() {
    this.sprLineValid = false;
    this.sprX.fill(0);
    this.sprCount = this.sprFetchCount;
  }

  // Background fetches for dots 1-256 and 321-336. Each 8-dot group fetches
  // one tile: nametable byte (dots 1-2), attribute byte (3-4), pattern low
  // (5-6) and high (7-8) bit planes. At the end of the group the tile is
  // loaded into the shift registers and coarse X is incremented.
  //
  // The shift registers shift on every one of these dots, and each visible
  // pixel is taken from them just before the shift. So a tile loaded at the
  // end of dot 8 has moved into the high (output) half 8 dots later. If
  // rendering is off at the moment of a load, the load is skipped and the
  // "serial in" bits shifted in show up instead (AccuracyCoin "BG Serial In").
  _bgFetch(dot) {
    switch (dot & 7) {
      case 1: {
        this.ntByte = this.mirroredLoad(0x2000 | (this.vramAddress & 0x0fff));
        break;
      }
      case 3: {
        const v = this.vramAddress;
        const at = this.mirroredLoad(
          0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07),
        );
        // Each attribute byte covers 4x4 tiles; pick the 2x2 quadrant.
        this.atBits = (at >> (((v >> 4) & 4) | (v & 2))) & 3;
        break;
      }
      case 5: {
        const addr =
          (this.f_bgPatternTable << 12) |
          (this.ntByte << 4) |
          (this.vramAddress >> 12);
        this.ptLo = this.vramMem[addr];
        break;
      }
      case 7: {
        const addr =
          ((this.f_bgPatternTable << 12) |
            (this.ntByte << 4) |
            (this.vramAddress >> 12)) +
          8;
        this.ptHi = this.vramMem[addr];
        const mmap = this.nes.mmap;
        mmap.latchAccess(addr);
        if (mmap.bgTileOverride) {
          this._mapperBgOverride();
        }
        break;
      }
      case 0: {
        // End of the tile: load it into the shift registers and move on.
        this._reloadBg();
        this._incCoarseX();
        break;
      }
    }
  }

  // MMC5 extended attribute mode supplies the tile pattern and palette for
  // each background tile itself.
  _mapperBgOverride() {
    const v = this.vramAddress;
    const data = this.nes.mmap.getBgTileData(
      this.f_bgPatternTable ? 256 : 0,
      this.ntByte,
      v & 0x1f,
      (v >> 5) & 0x1f,
    );
    if (!data) return;
    const fineY = v >> 12;
    const pix = data.tile.pix;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 8; i++) {
      const p = pix[(fineY << 3) + i];
      lo = (lo << 1) | (p & 1);
      hi = (hi << 1) | (p >> 1);
    }
    this.ptLo = lo;
    this.ptHi = hi;
    this.atBits = (data.attrib >> 2) & 3;
  }

  // Shift the background registers by one pixel. The pattern shifters shift
  // in a 0 (low plane) and a 1 (high plane), which shows up if the PPU is
  // made to skip a reload. The attribute shifters shift in their latch.
  _shiftBg() {
    this.bgShiftLo = (this.bgShiftLo << 1) & 0xffff;
    this.bgShiftHi = ((this.bgShiftHi << 1) | 1) & 0xffff;
    this.attrShiftLo = ((this.attrShiftLo << 1) | this.attrLatchLo) & 0xff;
    this.attrShiftHi = ((this.attrShiftHi << 1) | this.attrLatchHi) & 0xff;
  }

  // Load the fetched tile into the low half of the shift registers.
  _reloadBg() {
    this.bgShiftLo = (this.bgShiftLo & 0xff00) | this.ptLo;
    this.bgShiftHi = (this.bgShiftHi & 0xff00) | this.ptHi;
    this.attrLatchLo = this.atBits & 1;
    this.attrLatchHi = this.atBits >> 1;
  }

  // Process dots [from, to) of a visible line (1 <= from < to <= 257) with
  // rendering enabled: output pixels, run the background pipeline and do
  // the sprite evaluation steps for those dots. This is the hot loop of the
  // whole emulator.
  //
  // Within a span nothing outside the PPU can look at its state (see
  // catchUp()), and the background pipeline and sprite evaluation don't
  // depend on each other (one reads VRAM, the other OAM), so they're run
  // as two separate loops.
  _renderSpan(line, from, to) {
    this._renderBackgroundSpan(line, from, to);
    this._evaluateSpan(line, from, to);
  }

  // Output the pixels for dots [from, to) and run the background pipeline
  // (shift registers and tile fetches). The shift registers are kept in
  // local variables.
  _renderBackgroundSpan(line, from, to) {
    let bgLo = this.bgShiftLo;
    let bgHi = this.bgShiftHi;
    let atLo = this.attrShiftLo;
    let atHi = this.attrShiftHi;
    let latLo = this.attrLatchLo;
    let latHi = this.attrLatchHi;
    const fineX = this.fineX;
    const bit = 15 - fineX;
    const abit = 7 - fineX;
    const showBg = this.f_bgVisibility === 1;
    const bgLeft = this.f_bgClipping === 1;
    const palColors = this.palColors;
    const buffer = this.buffer;
    const sprLine = this.sprLine;
    const showSprites = this.f_spVisibility === 1;
    const spLeft = this.f_spClipping === 1;
    const rowBase = line << 8;
    const vram = this.vramMem;
    const mirror = this.vramMirrorTable;

    let dot = from;
    while (dot < to) {
      const spritesSimple =
        this.sprLineValid || (this.sprCount === 0 && !this.spriteSkipGlitch);

      if ((dot & 7) === 1 && dot + 8 <= to && spritesSimple) {
        // --- Fast path: one whole tile (8 dots) at once ---
        // The four fetches (the same as _bgFetch() does on dots 1, 3, 5 and
        // 7 of the group) only fill latches, which the pixels of this group
        // don't use, so do them first.
        {
          const v = this.vramAddress;
          const ntByte = vram[mirror[0x2000 | (v & 0x0fff)]];
          const at =
            vram[
              mirror[
                0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 0x07)
              ]
            ];
          this.ntByte = ntByte;
          this.atBits = (at >> (((v >> 4) & 4) | (v & 2))) & 3;
          const addr =
            (this.f_bgPatternTable << 12) | (ntByte << 4) | (v >> 12);
          this.ptLo = vram[addr];
          this.ptHi = vram[addr + 8];
          const mmap = this.nes.mmap;
          mmap.latchAccess(addr + 8);
          if (mmap.bgTileOverride) {
            this._mapperBgOverride();
          }
        }

        // Pixel k of the group is the bit that would be at the top of the
        // shift registers after k shifts, i.e. bit (15 - fineX - k) of
        // their current value (attribute: bit 7 - fineX - k, or the latch
        // once that has been shifted in).
        const x0 = dot - 1;
        // Bit (7 - k) of these 8-bit windows of the shift registers is the
        // value at the top of the register after k shifts, i.e. what pixel
        // k of this group uses. The attribute windows continue into the
        // latch bits once the shifter's own bits have been used up.
        const sh = 8 - fineX;
        let pix = 0;
        if (showBg && (x0 >= 8 || bgLeft)) {
          pix =
            DECODE_PLANES[(((bgHi >> sh) & 0xff) << 8) | ((bgLo >> sh) & 0xff)];
        }
        const pal =
          DECODE_PLANES[
            (((((atHi << 8) | (latHi ? 0xff : 0)) >> sh) & 0xff) << 8) |
              ((((atLo << 8) | (latLo ? 0xff : 0)) >> sh) & 0xff)
          ];
        if (!this.sprLineValid) {
          for (let k = 0; k < 8; k++) {
            const s2 = 14 - 2 * k;
            const p = (pix >> s2) & 3;
            buffer[rowBase | (x0 + k)] =
              palColors[p === 0 ? 0 : p | (((pal >> s2) & 3) << 2)];
          }
        } else {
          for (let k = 0; k < 8; k++) {
            const x = x0 + k;
            const s2 = 14 - 2 * k;
            const p = (pix >> s2) & 3;
            const bgPixel = p === 0 ? 0 : p | (((pal >> s2) & 3) << 2);
            let colorIndex = bgPixel;
            const spr = sprLine[x];
            if (spr !== 0 && showSprites && (x >= 8 || spLeft)) {
              if (spr & 0x200 && bgPixel !== 0 && x !== 255) {
                this.sprite0HitFlag = 1;
              }
              // Sprites are drawn in front of the background unless their
              // priority bit says otherwise (and the background is opaque).
              if (bgPixel === 0 || (spr & 0x100) === 0) {
                colorIndex = spr & 0x1f;
              }
            }
            buffer[rowBase | x] = palColors[colorIndex];
          }
        }

        // After 8 shifts the old tile is gone, the next tile is in the high
        // half, and the attribute shifters are full of their latch bits.
        // Then the tile just fetched is loaded.
        bgLo = ((bgLo << 8) & 0xff00) | this.ptLo;
        bgHi = ((bgHi << 8) & 0xff00) | this.ptHi;
        atLo = latLo ? 0xff : 0;
        atHi = latHi ? 0xff : 0;
        latLo = this.atBits & 1;
        latHi = this.atBits >> 1;
        this._incCoarseX();
        if (dot === 249) this._incY();
        dot += 8;
        continue;
      }

      // --- One dot at a time ---
      // Output the pixel for x = dot - 1.
      const x = dot - 1;
      let bgPixel = 0;
      if (showBg && (x >= 8 || bgLeft)) {
        const p = ((bgLo >> bit) & 1) | (((bgHi >> bit) & 1) << 1);
        if (p !== 0) {
          bgPixel =
            p | (((atLo >> abit) & 1) << 2) | (((atHi >> abit) & 1) << 3);
        }
      }
      let colorIndex = bgPixel;
      if (this.sprLineValid) {
        const spr = sprLine[x];
        if (spr !== 0 && showSprites && (x >= 8 || spLeft)) {
          if (spr & 0x200 && bgPixel !== 0 && x !== 255) {
            this.sprite0HitFlag = 1;
          }
          // Sprites are drawn in front of the background unless their
          // priority bit says otherwise (and the background is opaque).
          if (bgPixel === 0 || (spr & 0x100) === 0) {
            colorIndex = spr & 0x1f;
          }
        }
      } else if (this.sprCount !== 0 || this.spriteSkipGlitch) {
        const spr = this._spritePixel(x, bgPixel);
        if (spr !== 0 && (bgPixel === 0 || (spr & 0x100) === 0)) {
          colorIndex = spr & 0x1f;
        }
      }
      buffer[rowBase | x] = palColors[colorIndex];

      // Shift the background registers. The pattern shifters shift in a 0
      // (low plane) and a 1 (high plane), which shows up if the PPU is made
      // to skip a reload. The attribute shifters shift in their latch.
      bgLo = (bgLo << 1) & 0xffff;
      bgHi = ((bgHi << 1) | 1) & 0xffff;
      atLo = ((atLo << 1) | latLo) & 0xff;
      atHi = ((atHi << 1) | latHi) & 0xff;

      // Background fetch for this dot.
      if ((dot & 7) === 0) {
        // End of a tile: load it into the shift registers.
        bgLo = (bgLo & 0xff00) | this.ptLo;
        bgHi = (bgHi & 0xff00) | this.ptHi;
        latLo = this.atBits & 1;
        latHi = this.atBits >> 1;
        this._incCoarseX();
        if (dot === 256) this._incY();
      } else if ((dot & 1) === 1) {
        this._bgFetch(dot);
      }
      dot++;
    }

    this.bgShiftLo = bgLo;
    this.bgShiftHi = bgHi;
    this.attrShiftLo = atLo;
    this.attrShiftHi = atHi;
    this.attrLatchLo = latLo;
    this.attrLatchHi = latHi;
  }

  // Sprite evaluation (for the next line) for dots [from, to).
  _evaluateSpan(line, from, to) {
    for (let dot = from; dot < to; dot++) {
      if (dot === 65 && to === 257) {
        // The span covers the whole evaluation: use the faster loop.
        this._evaluateWindow(line);
        return;
      }
      if (dot <= 64) {
        // Clear secondary OAM, one byte every 2 dots.
        if ((dot & 1) === 0) {
          this.secondaryOAM[(dot >> 1) - 1] = 0xff;
          this.secIdx = (dot >> 1) & 0x1f;
          if (dot === 64) {
            this._startEvaluation();
          }
        }
      } else if ((dot & 1) === 1) {
        // Odd dots: read OAM.
        this.oamLatch = this.spriteMem[this.sramAddress];
      } else {
        // Even dots: process the byte read.
        this._evaluateSprites(line, dot);
      }
    }
  }

  // Sprite pixel at x (0-255). Returns 0 if no sprite pixel; otherwise the
  // palette index (0x10-0x1F) plus 0x100 if the sprite is behind the
  // background. Also detects sprite 0 hits against bgPixel.
  //
  // Each slot's X counter counts down to 0, then the slot shifts out its 8
  // pixels. The lowest-numbered opaque slot wins.
  _spritePixel(x, bgPixel) {
    let result = 0;
    const count = this.sprCount;
    const glitch = this.spriteSkipGlitch;
    this.spriteSkipGlitch = false;
    const showSprites =
      this.f_spVisibility === 1 && (x >= 8 || this.f_spClipping === 1);
    const sprX = this.sprX;
    const sprLo = this.sprLo;
    const sprHi = this.sprHi;
    for (let i = 0; i < count; i++) {
      if (sprX[i] !== 0 && !glitch) {
        sprX[i]--;
        continue;
      }
      const p = ((sprLo[i] >> 7) & 1) | ((sprHi[i] >> 6) & 2);
      sprLo[i] = sprLo[i] << 1;
      sprHi[i] = sprHi[i] << 1;
      if (glitch && this.sprLatchX[i] !== 0) {
        sprX[i] = this.sprLatchX[i] - 1;
      }
      if (p === 0 || !showSprites) continue;
      if (i === 0 && this.sprite0Line && bgPixel !== 0 && x !== 255) {
        this.sprite0HitFlag = 1;
      }
      if (result === 0) {
        const attr = this.sprAttr[i];
        result = 0x10 | p | ((attr & 3) << 2) | ((attr & 0x20) << 3);
      }
    }
    return result;
  }

  // ==========================================================================
  // Sprite evaluation
  // ==========================================================================
  //
  // From dot 65 to 256 of each visible line, the PPU scans OAM for sprites
  // that will be on the next line. On odd dots it reads a byte from
  // OAM[OAMADDR]; on even dots it processes that byte. This emulates the
  // byte-level state machine, including what happens when OAMADDR isn't a
  // multiple of 4 ("misaligned OAM") and the famous sprite overflow bug.
  // See https://www.nesdev.org/wiki/PPU_sprite_evaluation and the
  // AccuracyCoin "Misaligned OAM Behavior" test for the details.

  _startEvaluation() {
    this.secIdx = 0;
    this.secFull = false;
    this.evalDone = false;
    this.evalOvfStep = 0;
    this.sprite0Next = false;
  }

  // Is the byte `y` (read as a Y coordinate) in range for the next line?
  _inRange(line, y) {
    const row = line - y;
    return row >= 0 && row < (this.f_spriteSize ? 16 : 8);
  }

  // The whole of sprite evaluation (dots 65-256) in one go: the same state
  // machine as _evaluateSprites(), with the state in local variables.
  _evaluateWindow(line) {
    const oam = this.spriteMem;
    const sec = this.secondaryOAM;
    const height = this.f_spriteSize ? 16 : 8;
    let addr = this.sramAddress;
    let secIdx = this.secIdx;
    let secFull = this.secFull;
    let done = this.evalDone;
    let ovfStep = this.evalOvfStep;
    let latch = this.oamLatch;
    for (let dot = 66; dot <= 256; dot += 2) {
      if (done) {
        // All sprites checked: OAMADDR just steps by 4 per 2 dots.
        const steps = ((256 - dot) >> 1) + 1;
        latch = oam[(addr + 4 * (steps - 1)) & 0xff];
        addr = (addr + 4 * steps) & 0xff;
        break;
      }
      // Odd dot: read OAM. Even dot: process the byte.
      const s = (latch = oam[addr]);
      const row = line - s;
      const inRange = row >= 0 && row < height;
      if (!secFull) {
        const step = secIdx & 3;
        sec[secIdx] = s;
        if (step === 0) {
          if (inRange) {
            if (dot === 66) this.sprite0Next = true;
            secIdx++;
            addr++;
          } else {
            addr = (addr + 4) & ~3;
          }
        } else if (step < 3) {
          secIdx++;
          addr++;
        } else {
          secIdx++;
          addr = inRange ? addr + 1 : (addr + 1) & ~3;
        }
        if (secIdx === 32) {
          secFull = true;
          secIdx = 0;
        }
      } else if (ovfStep === 0) {
        if (inRange) {
          this.spriteOverflowFlag = 1;
          ovfStep = 1;
          addr++;
        } else {
          addr += 5;
        }
      } else if (ovfStep < 3) {
        ovfStep++;
        addr++;
      } else {
        ovfStep = 0;
        addr = inRange ? addr + 1 : addr + 5;
      }
      if (addr > 0xff) {
        done = true;
        addr &= 0xff;
      }
    }
    this.sramAddress = addr;
    this.secIdx = secIdx;
    this.secFull = secFull;
    this.evalDone = done;
    this.evalOvfStep = ovfStep;
    this.oamLatch = latch;
  }

  // Process the OAM byte read on the previous (odd) dot. Called on the even
  // dots 66-256.
  _evaluateSprites(line, dot) {
    const s = this.oamLatch;
    let addr = this.sramAddress;

    if (this.evalDone) {
      // All sprites checked: the PPU keeps stepping through OAM, failing to
      // copy into secondary OAM.
      addr += 4;
    } else if (!this.secFull) {
      // Copy mode: there's still room in secondary OAM.
      const step = this.secIdx & 3;
      this.secondaryOAM[this.secIdx] = s;
      if (step === 0) {
        // Y coordinate.
        if (this._inRange(line, s)) {
          if (dot === 66) this.sprite0Next = true;
          this.secIdx++;
          addr++;
        } else {
          // Skip to the next sprite (and realign OAMADDR).
          addr = (addr + 4) & ~3;
        }
      } else if (step < 3) {
        // Tile and attributes.
        this.secIdx++;
        addr++;
      } else {
        // X coordinate. The hardware applies the same "in range" check to
        // it; if that fails, OAMADDR is realigned.
        this.secIdx++;
        addr = this._inRange(line, s) ? addr + 1 : (addr + 1) & ~3;
      }
      if (this.secIdx === 32) {
        this.secFull = true;
        this.secIdx = 0;
      }
    } else {
      // Secondary OAM is full: look for a 9th sprite to set the overflow
      // flag. Writes to secondary OAM become reads.
      if (this.evalOvfStep === 0) {
        if (this._inRange(line, s)) {
          this.spriteOverflowFlag = 1;
          this.evalOvfStep = 1;
          addr++;
        } else {
          // Hardware bug: both the sprite index and the byte index are
          // incremented, so the next "Y" read is really some other byte.
          addr += 5;
        }
      } else if (this.evalOvfStep < 3) {
        this.evalOvfStep++;
        addr++;
      } else {
        this.evalOvfStep = 0;
        addr = this._inRange(line, s) ? addr + 1 : addr + 5;
      }
    }

    if (addr > 0xff) {
      // Wrapped around the end of OAM.
      this.evalDone = true;
      addr &= 0xff;
    }
    this.sramAddress = addr;
  }

  // Fetch sprite slot `slot` (0-7) from secondary OAM into the sprite output
  // unit. `line` is the line used for the in-range check; on the pre-render
  // line that's 261 & 255 = 5, which is how stale secondary OAM data can
  // produce sprites on line 0.
  _fetchSprite(slot, line) {
    const base = slot << 2;
    const y = this.secondaryOAM[base];
    const tile = this.secondaryOAM[base + 1];
    const attr = this.secondaryOAM[base + 2];
    const x = this.secondaryOAM[base + 3];
    const height = this.f_spriteSize ? 16 : 8;
    let row = line - y;
    const inRange = row >= 0 && row < height;
    if (attr & 0x80) {
      row = height - 1 - row; // vertical flip
    }
    row &= height - 1;

    let addr;
    if (height === 8) {
      addr = (this.f_spPatternTable << 12) | (tile << 4) | row;
    } else {
      // 8x16: bit 0 of the tile number selects the pattern table.
      addr =
        ((tile & 1) << 12) |
        ((tile & 0xfe) << 4) |
        ((row & 8) << 1) |
        (row & 7);
    }
    let lo = this.vramMem[addr];
    let hi = this.vramMem[addr + 8];
    this.nes.mmap.latchAccess(addr + 8);

    if (!inRange) {
      lo = 0;
      hi = 0;
    } else if (attr & 0x40) {
      lo = REVERSE_BITS[lo];
      hi = REVERSE_BITS[hi];
    }
    this.sprLo[slot] = lo;
    this.sprHi[slot] = hi;
    this.sprAttr[slot] = attr;
    this.sprLatchX[slot] = x;
    // Only slots up to the last one with pixels need processing.
    if ((lo | hi) !== 0) {
      this.sprFetchCount = slot + 1;
    }
  }

  // ==========================================================================
  // OAM corruption
  // ==========================================================================
  //
  // If rendering is turned off in the middle of a visible (or pre-render)
  // line, the sprite logic is interrupted in a state that corrupts OAM once
  // rendering is turned back on: OAM "row" N (8 bytes) is overwritten with
  // row 0, where N is the secondary OAM address at the moment rendering was
  // disabled. See https://www.nesdev.org/wiki/PPU_OAM#Sprite_corruption and
  // the AccuracyCoin "OAM Corruption" test.

  _renderingDisabled() {
    const line = this.line;
    if (!(line < 240 || line === 261)) return;
    const dot = this.dot;
    let row = this.secIdx;
    if (dot >= 65 && dot <= 256) {
      // During evaluation the address is effectively rounded up to a
      // multiple of 4.
      row = (row + 3) & 0x1c;
    }
    this.oamCorruptPending = true;
    this.oamCorruptRow = row & 0x1f;
  }

  _performOamCorruption() {
    this.oamCorruptPending = false;
    const base = this.oamCorruptRow << 3;
    for (let i = 0; i < 8; i++) {
      this.spriteMem[base + i] = this.spriteMem[i];
    }
    this.secondaryOAM[this.oamCorruptRow] = this.secondaryOAM[0];
  }

  // ==========================================================================
  // Frame output
  // ==========================================================================

  // Kept for API compatibility; the frame is drawn as the PPU runs.
  startFrame() {}

  endFrame() {
    let y;
    let buffer = this.buffer;

    if (this.clipToTvSize) {
      // Most TVs don't show the outer 8 pixels on each side. Clip them.
      for (y = 0; y < 240; y++) {
        buffer.fill(0, y << 8, (y << 8) + 8);
        buffer.fill(0, (y << 8) + 248, (y << 8) + 256);
      }
      buffer.fill(0, 0, 8 << 8);
      buffer.fill(0, 232 << 8, 240 << 8);
    } else if (this.f_bgClipping === 0 || this.f_spClipping === 0) {
      for (y = 0; y < 240; y++) {
        buffer.fill(0, y << 8, (y << 8) + 8);
      }
    }

    this.nes.ui.writeFrame(buffer);
  }

  // Used by the Zapper: is the pixel at (x, y) bright white?
  isPixelWhite(x, y) {
    this.catchUp();
    return this.buffer[(y << 8) + x] === 0xffffff;
  }

  // ==========================================================================
  // Save states
  // ==========================================================================

  static JSON_PROPERTIES = [
    "vramMem",
    "spriteMem",
    "secondaryOAM",
    "vramAddress",
    "vramTmpAddress",
    "fineX",
    "firstWrite",
    "vramBufferedReadValue",
    "sramAddress",
    "openBusLatch",
    "openBusDecayFrames",
    "currentMirroring",
    "ntable1",
    "vblankFlag",
    "sprite0HitFlag",
    "spriteOverflowFlag",
    "nmiOutput",
    "nmiAtPoll",
    "nmiSuppressed",
    "line",
    "dot",
    "scanline",
    "oddFrame",
    "renderingOn",
    "maskDelay",
    "bgShiftLo",
    "bgShiftHi",
    "attrShiftLo",
    "attrShiftHi",
    "attrLatchLo",
    "attrLatchHi",
    "ntByte",
    "atBits",
    "ptLo",
    "ptHi",
    "secIdx",
    "secFull",
    "oamLatch",
    "evalDone",
    "evalOvfStep",
    "sprite0Next",
    "sprite0Line",
    "oamCorruptPending",
    "oamCorruptRow",
    "sprCount",
    "sprLo",
    "sprHi",
    "sprAttr",
    "sprX",
    "sprLatchX",
    "sprFetchCount",
    "spriteSkipGlitch",
    // Control/mask register fields
    "f_nmiOnVblank",
    "f_spriteSize",
    "f_bgPatternTable",
    "f_spPatternTable",
    "f_addrInc",
    "f_nTblAddress",
    "f_color",
    "f_spVisibility",
    "f_bgVisibility",
    "f_spClipping",
    "f_bgClipping",
    "f_dispType",
  ];

  toJSON() {
    this.catchUp();
    this._materializeSprites();
    let state = toJSON(this);
    state.vramMirrorTable = this.vramMirrorTable;
    return state;
  }

  fromJSON(state) {
    fromJSON(this, state);
    if (state.vramMirrorTable) {
      this.vramMirrorTable.set(state.vramMirrorTable);
    }
    this.dotTarget = 0;
    this.dotsRun = 0;
    this.nextEventDot = 0;
    // Rebuild derived state.
    for (let i = 0; i < 0x2000; i++) {
      this.patternWrite(i, this.vramMem[i]);
    }
    if (this.f_dispType === 0) {
      this.palTable.setEmphasis(this.f_color);
    }
    this.updatePalettes();
  }
}

// SEC_IDX_STEPS[n] is how many times the secondary OAM address has been
// incremented after the first n dots of the sprite fetch period (dots
// 257-320): on the 1st, 2nd, 3rd and 8th dot of each 8-dot group.
const SEC_IDX_STEPS = new Uint8Array(65);
for (let n = 1; n <= 64; n++) {
  const phase = (n - 1) & 7;
  SEC_IDX_STEPS[n] = SEC_IDX_STEPS[n - 1] + (phase <= 2 || phase === 7 ? 1 : 0);
}

// DECODE_PLANES[(hi << 8) | lo] packs the 8 two-bit pixels of a pair of
// bit planes, leftmost pixel in bits 14-15: pixel k is
// (DECODE_PLANES[...] >> (14 - 2 * k)) & 3.
const DECODE_PLANES = new Uint16Array(65536);
for (let v = 0; v < 65536; v++) {
  const lo = v & 0xff;
  const hi = v >> 8;
  let packed = 0;
  for (let k = 0; k < 8; k++) {
    const p = ((lo >> (7 - k)) & 1) | (((hi >> (7 - k)) & 1) << 1);
    packed |= p << (14 - 2 * k);
  }
  DECODE_PLANES[v] = packed;
}

// Bit-reversed bytes, for horizontally flipped sprites.
const REVERSE_BITS = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) {
    if (i & (1 << b)) r |= 0x80 >> b;
  }
  REVERSE_BITS[i] = r;
}

__exp.default = PPU;


return __exp;
}
function __m_ppu_nametable_js() {
const __exp = {};
class NameTable {
  constructor(width, height, name) {
    this.width = width;
    this.height = height;
    this.name = name;

    this.tile = new Uint8Array(width * height);
    this.attrib = new Uint8Array(width * height);
  }

  getTileIndex(x, y) {
    return this.tile[y * this.width + x];
  }

  getAttrib(x, y) {
    return this.attrib[y * this.width + x];
  }

  writeAttrib(index, value) {
    let basex = (index % 8) * 4;
    let basey = Math.floor(index / 8) * 4;
    let add;
    let tx, ty;
    let attindex;

    for (let sqy = 0; sqy < 2; sqy++) {
      for (let sqx = 0; sqx < 2; sqx++) {
        add = (value >> (2 * (sqy * 2 + sqx))) & 3;
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            tx = basex + sqx * 2 + x;
            ty = basey + sqy * 2 + y;
            attindex = ty * this.width + tx;
            this.attrib[attindex] = (add << 2) & 12;
          }
        }
      }
    }
  }

  toJSON() {
    return {
      tile: Array.from(this.tile),
      attrib: Array.from(this.attrib),
    };
  }

  fromJSON(s) {
    this.tile.set(s.tile);
    this.attrib.set(s.attrib);
  }
}

__exp.default = NameTable;


return __exp;
}
function __m_ppu_palette_table_js() {
const __exp = {};
class PaletteTable {
  constructor() {
    this.curTable = new Uint32Array(64);
    this.emphTable = new Array(8);
    this.currentEmph = -1;
  }

  loadNTSCPalette() {
    // prettier-ignore
    this.curTable = new Uint32Array([0x525252, 0xB40000, 0xA00000, 0xB1003D, 0x740069, 0x00005B, 0x00005F, 0x001840, 0x002F10, 0x084A08, 0x006700, 0x124200, 0x6D2800, 0x000000, 0x000000, 0x000000, 0xC4D5E7, 0xFF4000, 0xDC0E22, 0xFF476B, 0xD7009F, 0x680AD7, 0x0019BC, 0x0054B1, 0x006A5B, 0x008C03, 0x00AB00, 0x2C8800, 0xA47200, 0x000000, 0x000000, 0x000000, 0xF8F8F8, 0xFFAB3C, 0xFF7981, 0xFF5BC5, 0xFF48F2, 0xDF49FF, 0x476DFF, 0x00B4F7, 0x00E0FF, 0x00E375, 0x03F42B, 0x78B82E, 0xE5E218, 0x787878, 0x000000, 0x000000, 0xFFFFFF, 0xFFF2BE, 0xF8B8B8, 0xF8B8D8, 0xFFB6FF, 0xFFC3FF, 0xC7D1FF, 0x9ADAFF, 0x88EDF8, 0x83FFDD, 0xB8F8B8, 0xF5F8AC, 0xFFFFB0, 0xF8D8F8, 0x000000, 0x000000]);
    this.makeTables();
    this.setEmphasis(0);
  }

  loadPALPalette() {
    // prettier-ignore
    this.curTable = new Uint32Array([0x525252, 0xB40000, 0xA00000, 0xB1003D, 0x740069, 0x00005B, 0x00005F, 0x001840, 0x002F10, 0x084A08, 0x006700, 0x124200, 0x6D2800, 0x000000, 0x000000, 0x000000, 0xC4D5E7, 0xFF4000, 0xDC0E22, 0xFF476B, 0xD7009F, 0x680AD7, 0x0019BC, 0x0054B1, 0x006A5B, 0x008C03, 0x00AB00, 0x2C8800, 0xA47200, 0x000000, 0x000000, 0x000000, 0xF8F8F8, 0xFFAB3C, 0xFF7981, 0xFF5BC5, 0xFF48F2, 0xDF49FF, 0x476DFF, 0x00B4F7, 0x00E0FF, 0x00E375, 0x03F42B, 0x78B82E, 0xE5E218, 0x787878, 0x000000, 0x000000, 0xFFFFFF, 0xFFF2BE, 0xF8B8B8, 0xF8B8D8, 0xFFB6FF, 0xFFC3FF, 0xC7D1FF, 0x9ADAFF, 0x88EDF8, 0x83FFDD, 0xB8F8B8, 0xF5F8AC, 0xFFFFB0, 0xF8D8F8, 0x000000, 0x000000]);
    this.makeTables();
    this.setEmphasis(0);
  }

  makeTables() {
    let r, g, b, col, i, rFactor, gFactor, bFactor;

    // Calculate a table for each possible emphasis setting:
    for (let emph = 0; emph < 8; emph++) {
      // Determine color component factors:
      rFactor = 1.0;
      gFactor = 1.0;
      bFactor = 1.0;

      // NTSC emphasis bits from $2001:
      // Bit 5 (emph & 1): Emphasize Red → darken Green + Blue
      // Bit 6 (emph & 2): Emphasize Green → darken Red + Blue
      // Bit 7 (emph & 4): Emphasize Blue → darken Red + Green
      // See https://www.nesdev.org/wiki/PPU_registers#Color_emphasis
      if ((emph & 1) !== 0) {
        gFactor = 0.75;
        bFactor = 0.75;
      }
      if ((emph & 2) !== 0) {
        rFactor = 0.75;
        bFactor = 0.75;
      }
      if ((emph & 4) !== 0) {
        rFactor = 0.75;
        gFactor = 0.75;
      }

      this.emphTable[emph] = new Uint32Array(64);

      // Calculate table:
      for (i = 0; i < 64; i++) {
        col = this.curTable[i];
        r = Math.floor(this.getRed(col) * rFactor);
        g = Math.floor(this.getGreen(col) * gFactor);
        b = Math.floor(this.getBlue(col) * bFactor);
        this.emphTable[emph][i] = this.getRgb(r, g, b);
      }
    }
  }

  setEmphasis(emph) {
    if (emph !== this.currentEmph) {
      this.currentEmph = emph;
      for (let i = 0; i < 64; i++) {
        this.curTable[i] = this.emphTable[emph][i];
      }
    }
  }

  getEntry(yiq) {
    return this.curTable[yiq];
  }

  getRed(rgb) {
    return (rgb >> 16) & 0xff;
  }

  getGreen(rgb) {
    return (rgb >> 8) & 0xff;
  }

  getBlue(rgb) {
    return rgb & 0xff;
  }

  getRgb(r, g, b) {
    return (r << 16) | (g << 8) | b;
  }

  loadDefaultPalette() {
    this.curTable[0] = this.getRgb(117, 117, 117);
    this.curTable[1] = this.getRgb(39, 27, 143);
    this.curTable[2] = this.getRgb(0, 0, 171);
    this.curTable[3] = this.getRgb(71, 0, 159);
    this.curTable[4] = this.getRgb(143, 0, 119);
    this.curTable[5] = this.getRgb(171, 0, 19);
    this.curTable[6] = this.getRgb(167, 0, 0);
    this.curTable[7] = this.getRgb(127, 11, 0);
    this.curTable[8] = this.getRgb(67, 47, 0);
    this.curTable[9] = this.getRgb(0, 71, 0);
    this.curTable[10] = this.getRgb(0, 81, 0);
    this.curTable[11] = this.getRgb(0, 63, 23);
    this.curTable[12] = this.getRgb(27, 63, 95);
    this.curTable[13] = this.getRgb(0, 0, 0);
    this.curTable[14] = this.getRgb(0, 0, 0);
    this.curTable[15] = this.getRgb(0, 0, 0);
    this.curTable[16] = this.getRgb(188, 188, 188);
    this.curTable[17] = this.getRgb(0, 115, 239);
    this.curTable[18] = this.getRgb(35, 59, 239);
    this.curTable[19] = this.getRgb(131, 0, 243);
    this.curTable[20] = this.getRgb(191, 0, 191);
    this.curTable[21] = this.getRgb(231, 0, 91);
    this.curTable[22] = this.getRgb(219, 43, 0);
    this.curTable[23] = this.getRgb(203, 79, 15);
    this.curTable[24] = this.getRgb(139, 115, 0);
    this.curTable[25] = this.getRgb(0, 151, 0);
    this.curTable[26] = this.getRgb(0, 171, 0);
    this.curTable[27] = this.getRgb(0, 147, 59);
    this.curTable[28] = this.getRgb(0, 131, 139);
    this.curTable[29] = this.getRgb(0, 0, 0);
    this.curTable[30] = this.getRgb(0, 0, 0);
    this.curTable[31] = this.getRgb(0, 0, 0);
    this.curTable[32] = this.getRgb(255, 255, 255);
    this.curTable[33] = this.getRgb(63, 191, 255);
    this.curTable[34] = this.getRgb(95, 151, 255);
    this.curTable[35] = this.getRgb(167, 139, 253);
    this.curTable[36] = this.getRgb(247, 123, 255);
    this.curTable[37] = this.getRgb(255, 119, 183);
    this.curTable[38] = this.getRgb(255, 119, 99);
    this.curTable[39] = this.getRgb(255, 155, 59);
    this.curTable[40] = this.getRgb(243, 191, 63);
    this.curTable[41] = this.getRgb(131, 211, 19);
    this.curTable[42] = this.getRgb(79, 223, 75);
    this.curTable[43] = this.getRgb(88, 248, 152);
    this.curTable[44] = this.getRgb(0, 235, 219);
    this.curTable[45] = this.getRgb(0, 0, 0);
    this.curTable[46] = this.getRgb(0, 0, 0);
    this.curTable[47] = this.getRgb(0, 0, 0);
    this.curTable[48] = this.getRgb(255, 255, 255);
    this.curTable[49] = this.getRgb(171, 231, 255);
    this.curTable[50] = this.getRgb(199, 215, 255);
    this.curTable[51] = this.getRgb(215, 203, 255);
    this.curTable[52] = this.getRgb(255, 199, 255);
    this.curTable[53] = this.getRgb(255, 199, 219);
    this.curTable[54] = this.getRgb(255, 191, 179);
    this.curTable[55] = this.getRgb(255, 219, 171);
    this.curTable[56] = this.getRgb(255, 231, 163);
    this.curTable[57] = this.getRgb(227, 255, 163);
    this.curTable[58] = this.getRgb(171, 243, 191);
    this.curTable[59] = this.getRgb(179, 255, 207);
    this.curTable[60] = this.getRgb(159, 255, 243);
    this.curTable[61] = this.getRgb(0, 0, 0);
    this.curTable[62] = this.getRgb(0, 0, 0);
    this.curTable[63] = this.getRgb(0, 0, 0);

    this.makeTables();
    this.setEmphasis(0);
  }
}

__exp.default = PaletteTable;


return __exp;
}
function __m_rom_js() {
const __exp = {};
const Mappers = __req("mappers/index.js").default;
const Tile = __req("tile.js").default;

class ROM {
  // Mirroring types (instance properties so they're accessible via
  // this.nes.rom.HORIZONTAL_MIRRORING etc. in PPU and mappers):
  VERTICAL_MIRRORING = 0;
  HORIZONTAL_MIRRORING = 1;
  FOURSCREEN_MIRRORING = 2;
  SINGLESCREEN_MIRRORING = 3;
  SINGLESCREEN_MIRRORING2 = 4;
  SINGLESCREEN_MIRRORING3 = 5;
  SINGLESCREEN_MIRRORING4 = 6;
  CHRROM_MIRRORING = 7;

  constructor(nes) {
    this.nes = nes;
    this.valid = false;
  }

  load(data) {
    let i, j, v;

    // Accept Uint8Array, ArrayBuffer, Buffer, or binary string.
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }
    const isTypedArray = ArrayBuffer.isView(data);

    if (isTypedArray) {
      if (
        data.length < 4 ||
        data[0] !== 0x4e ||
        data[1] !== 0x45 ||
        data[2] !== 0x53 ||
        data[3] !== 0x1a
      ) {
        throw new Error("Not a valid NES ROM.");
      }
    } else {
      if (!data.startsWith("NES\x1a")) {
        throw new Error("Not a valid NES ROM.");
      }
    }

    this.header = new Uint8Array(16);
    for (i = 0; i < 16; i++) {
      this.header[i] = isTypedArray ? data[i] : data.charCodeAt(i) & 0xff;
    }

    // Flags from byte 6 (shared between iNES 1.0 and NES 2.0)
    this.mirroring = (this.header[6] & 1) !== 0 ? 1 : 0;
    this.batteryRam = (this.header[6] & 2) !== 0;
    this.trainer = (this.header[6] & 4) !== 0;
    this.fourScreen = (this.header[6] & 8) !== 0;

    // Detect NES 2.0: byte 7 bits 3..2 == 0b10
    // https://www.nesdev.org/wiki/NES_2.0
    this.isNES2 = (this.header[7] & 0x0c) === 0x08;

    if (this.isNES2) {
      this._loadNES2Header();
    } else {
      this._loadINES1Header();
    }

    /* TODO
        if (this.batteryRam)
            this.loadBatteryRam();*/

    // Load PRG-ROM banks:
    this.rom = new Array(this.romCount);
    // Skip past the 16-byte header, plus 512-byte trainer if present.
    // See https://www.nesdev.org/wiki/INES#Trainer
    let offset = 16 + (this.trainer ? 512 : 0);
    for (i = 0; i < this.romCount; i++) {
      this.rom[i] = new Uint8Array(16384);
      for (j = 0; j < 16384; j++) {
        if (offset + j >= data.length) {
          break;
        }
        this.rom[i][j] = isTypedArray
          ? data[offset + j]
          : data.charCodeAt(offset + j) & 0xff;
      }
      offset += 16384;
    }
    // Load CHR-ROM banks:
    this.vrom = new Array(this.vromCount);
    for (i = 0; i < this.vromCount; i++) {
      this.vrom[i] = new Uint8Array(4096);
      for (j = 0; j < 4096; j++) {
        if (offset + j >= data.length) {
          break;
        }
        this.vrom[i][j] = isTypedArray
          ? data[offset + j]
          : data.charCodeAt(offset + j) & 0xff;
      }
      offset += 4096;
    }

    // Create VROM tiles:
    this.vromTile = new Array(this.vromCount);
    for (i = 0; i < this.vromCount; i++) {
      this.vromTile[i] = new Array(256);
      for (j = 0; j < 256; j++) {
        this.vromTile[i][j] = new Tile();
      }
    }

    // Convert CHR-ROM banks to tiles:
    let tileIndex;
    let leftOver;
    for (v = 0; v < this.vromCount; v++) {
      for (i = 0; i < 4096; i++) {
        tileIndex = i >> 4;
        leftOver = i % 16;
        if (leftOver < 8) {
          this.vromTile[v][tileIndex].setScanline(
            leftOver,
            this.vrom[v][i],
            this.vrom[v][i + 8],
          );
        } else {
          this.vromTile[v][tileIndex].setScanline(
            leftOver - 8,
            this.vrom[v][i - 8],
            this.vrom[v][i],
          );
        }
      }
    }

    this.valid = true;
  }

  // Parse iNES 1.0 header fields (bytes 4-15).
  _loadINES1Header() {
    this.romCount = this.header[4];
    this.vromCount = this.header[5] * 2; // Get the number of 4kB banks, not 8kB
    this.mapperType = (this.header[6] >> 4) | (this.header[7] & 0xf0);

    // Check whether bytes 8-15 are zero. Non-zero values in this region
    // typically indicate garbage (e.g. "DiskDude!" in old ROM dumps), so
    // we discard the upper mapper nibble from byte 7 to be safe.
    let foundError = false;
    for (let i = 8; i < 16; i++) {
      if (this.header[i] !== 0) {
        foundError = true;
        break;
      }
    }
    if (foundError) {
      this.mapperType &= 0xf; // Ignore byte 7
    }

    // Default NES 2.0 fields to zero for iNES 1.0 ROMs so consumers
    // don't need to check isNES2 before accessing them.
    this.subMapper = 0;
    this.prgRamSize = 0;
    this.prgNvRamSize = 0;
    this.chrRamSize = 0;
    this.chrNvRamSize = 0;
    this.timingMode = 0;
    this.consoleType = 0;
  }

  // Parse NES 2.0 header fields (bytes 4-15).
  // https://www.nesdev.org/wiki/NES_2.0
  _loadNES2Header() {
    // Mapper number: 12 bits from bytes 6, 7, and 8.
    //   Byte 6 D7..D4: mapper D3..D0
    //   Byte 7 D7..D4: mapper D7..D4
    //   Byte 8 D3..D0: mapper D11..D8
    this.mapperType =
      (this.header[6] >> 4) |
      (this.header[7] & 0xf0) |
      ((this.header[8] & 0x0f) << 8);

    // Submapper: byte 8 D7..D4
    this.subMapper = (this.header[8] >> 4) & 0x0f;

    // PRG-ROM size: byte 9 D3..D0 (MSB) combined with byte 4 (LSB).
    // When MSB nibble is 0xF, an exponent-multiplier encoding is used:
    //   size = 2^E * (M*2 + 1) bytes, where E = bits 7..2, M = bits 1..0.
    const prgMsb = this.header[9] & 0x0f;
    if (prgMsb === 0x0f) {
      const e = (this.header[4] >> 2) & 0x3f;
      const m = this.header[4] & 0x03;
      this.romCount = Math.ceil((Math.pow(2, e) * (m * 2 + 1)) / 16384);
    } else {
      this.romCount = (prgMsb << 8) | this.header[4];
    }

    // CHR-ROM size: byte 9 D7..D4 (MSB) combined with byte 5 (LSB).
    // Same exponent-multiplier encoding when MSB nibble is 0xF.
    // Internally we store as 4KB bank count (vromCount = 8KB units * 2).
    const chrMsb = (this.header[9] >> 4) & 0x0f;
    if (chrMsb === 0x0f) {
      const e = (this.header[5] >> 2) & 0x3f;
      const m = this.header[5] & 0x03;
      this.vromCount = Math.ceil((Math.pow(2, e) * (m * 2 + 1)) / 4096);
    } else {
      // 12-bit value is in 8KB units; double it for 4KB bank count.
      this.vromCount = ((chrMsb << 8) | this.header[5]) * 2;
    }

    // PRG-RAM sizes (byte 10).
    // Lower nibble: volatile PRG-RAM; upper nibble: non-volatile PRG-NVRAM.
    // Encoding: 0 = none, otherwise 64 << value bytes.
    this.prgRamSize = ROM._decodeRamSize(this.header[10] & 0x0f);
    this.prgNvRamSize = ROM._decodeRamSize((this.header[10] >> 4) & 0x0f);

    // CHR-RAM sizes (byte 11).
    // Lower nibble: volatile CHR-RAM; upper nibble: non-volatile CHR-NVRAM.
    // Note: with NES 2.0, do not assume 8KB CHR-RAM when CHR-ROM is 0;
    // CHR-RAM must be explicitly specified here.
    this.chrRamSize = ROM._decodeRamSize(this.header[11] & 0x0f);
    this.chrNvRamSize = ROM._decodeRamSize((this.header[11] >> 4) & 0x0f);

    // CPU/PPU timing mode (byte 12, low 2 bits).
    // 0 = NTSC (RP2C02), 1 = PAL (RP2C07), 2 = Multi-region, 3 = Dendy (UA6538)
    this.timingMode = this.header[12] & 0x03;

    // Console type (byte 7, bits 1..0).
    // 0 = NES/Famicom, 1 = Vs. System, 2 = Playchoice 10, 3 = Extended
    this.consoleType = this.header[7] & 0x03;
  }

  // Decode NES 2.0 RAM shift-count encoding.
  // Value 0 means no RAM; otherwise size = 64 << value (in bytes).
  // https://www.nesdev.org/wiki/NES_2.0#PRG-(NV)RAM/EEPROM
  static _decodeRamSize(value) {
    if (value === 0) return 0;
    return 64 << value;
  }

  getMirroringType() {
    if (this.fourScreen) {
      return this.FOURSCREEN_MIRRORING;
    }
    if (this.mirroring === 0) {
      return this.HORIZONTAL_MIRRORING;
    }
    return this.VERTICAL_MIRRORING;
  }

  mapperSupported() {
    return typeof Mappers[this.mapperType] !== "undefined";
  }

  createMapper() {
    if (this.mapperSupported()) {
      return new Mappers[this.mapperType](this.nes);
    } else {
      throw new Error(`Unsupported mapper: ${this.mapperType}`);
    }
  }
}

__exp.default = ROM;


return __exp;
}
function __m_tile_js() {
const __exp = {};
class Tile {
  constructor() {
    // Tile data: color indices 0–3
    this.pix = new Uint8Array(64);

    this.initialized = false;
    this.opaque = new Uint8Array(8);
  }

  setBuffer(scanline) {
    for (let y = 0; y < 8; y++) {
      this.setScanline(y, scanline[y], scanline[y + 8]);
    }
  }

  setScanline(sline, b1, b2) {
    this.initialized = true;
    let tIndex = sline << 3;
    for (let x = 0; x < 8; x++) {
      this.pix[tIndex + x] =
        ((b1 >> (7 - x)) & 1) + (((b2 >> (7 - x)) & 1) << 1);
      if (this.pix[tIndex + x] === 0) {
        this.opaque[sline] = false;
      }
    }
  }

  render(
    buffer,
    srcx1,
    srcy1,
    srcx2,
    srcy2,
    dx,
    dy,
    palAdd,
    palette,
    flipHorizontal,
    flipVertical,
    pri,
    priTable,
  ) {
    if (dx < -7 || dx >= 256 || dy < -7 || dy >= 240) {
      return;
    }

    if (dx < 0) {
      srcx1 -= dx;
    }
    if (dx + srcx2 >= 256) {
      srcx2 = 256 - dx;
    }

    if (dy < 0) {
      srcy1 -= dy;
    }
    if (dy + srcy2 >= 240) {
      srcy2 = 240 - dy;
    }

    let fbIndex, tIndex, palIndex, tpri;

    if (!flipHorizontal && !flipVertical) {
      fbIndex = (dy << 8) + dx;
      tIndex = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if (x >= srcx1 && x < srcx2 && y >= srcy1 && y < srcy2) {
            palIndex = this.pix[tIndex];
            tpri = priTable[fbIndex];
            if (palIndex !== 0 && pri <= (tpri & 0xff)) {
              buffer[fbIndex] = palette[palIndex + palAdd];
              tpri = (tpri & 0xf00) | pri;
              priTable[fbIndex] = tpri;
            }
          }
          fbIndex++;
          tIndex++;
        }
        fbIndex -= 8;
        fbIndex += 256;
      }
    } else if (flipHorizontal && !flipVertical) {
      fbIndex = (dy << 8) + dx;
      tIndex = 7;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if (x >= srcx1 && x < srcx2 && y >= srcy1 && y < srcy2) {
            palIndex = this.pix[tIndex];
            tpri = priTable[fbIndex];
            if (palIndex !== 0 && pri <= (tpri & 0xff)) {
              buffer[fbIndex] = palette[palIndex + palAdd];
              tpri = (tpri & 0xf00) | pri;
              priTable[fbIndex] = tpri;
            }
          }
          fbIndex++;
          tIndex--;
        }
        fbIndex -= 8;
        fbIndex += 256;
        tIndex += 16;
      }
    } else if (flipVertical && !flipHorizontal) {
      fbIndex = (dy << 8) + dx;
      tIndex = 56;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if (x >= srcx1 && x < srcx2 && y >= srcy1 && y < srcy2) {
            palIndex = this.pix[tIndex];
            tpri = priTable[fbIndex];
            if (palIndex !== 0 && pri <= (tpri & 0xff)) {
              buffer[fbIndex] = palette[palIndex + palAdd];
              tpri = (tpri & 0xf00) | pri;
              priTable[fbIndex] = tpri;
            }
          }
          fbIndex++;
          tIndex++;
        }
        fbIndex -= 8;
        fbIndex += 256;
        tIndex -= 16;
      }
    } else {
      fbIndex = (dy << 8) + dx;
      tIndex = 63;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if (x >= srcx1 && x < srcx2 && y >= srcy1 && y < srcy2) {
            palIndex = this.pix[tIndex];
            tpri = priTable[fbIndex];
            if (palIndex !== 0 && pri <= (tpri & 0xff)) {
              buffer[fbIndex] = palette[palIndex + palAdd];
              tpri = (tpri & 0xf00) | pri;
              priTable[fbIndex] = tpri;
            }
          }
          fbIndex++;
          tIndex--;
        }
        fbIndex -= 8;
        fbIndex += 256;
      }
    }
  }

  isTransparent(x, y) {
    return this.pix[(y << 3) + x] === 0;
  }

  toJSON() {
    return {
      opaque: Array.from(this.opaque),
      pix: Array.from(this.pix),
    };
  }

  fromJSON(s) {
    this.opaque.set(s.opaque);
    this.pix.set(s.pix);
  }
}

__exp.default = Tile;


return __exp;
}
function __m_utils_js() {
const __exp = {};
function copyArrayElements(src, srcPos, dest, destPos, length) {
  for (let i = 0; i < length; ++i) {
    dest[destPos + i] = src[srcPos + i];
  }
}

function copyArray(src) {
  return src.slice(0);
}

function fromJSON(obj, state) {
  const props = obj.constructor.JSON_PROPERTIES;
  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    const current = obj[prop];
    const value = state[prop];
    if (ArrayBuffer.isView(current) && Array.isArray(value)) {
      // Typed arrays: copy data in-place instead of replacing the array,
      // since JSON.parse produces plain arrays not typed arrays.
      current.set(value);
    } else {
      obj[prop] = value;
    }
  }
}

function toJSON(obj) {
  const state = {};
  const props = obj.constructor.JSON_PROPERTIES;
  for (let i = 0; i < props.length; i++) {
    const prop = props[i];
    const value = obj[prop];
    // Typed arrays must be converted to plain arrays for JSON.stringify,
    // which otherwise serializes them as objects ({0: v, 1: v, ...}).
    state[prop] = ArrayBuffer.isView(value) ? Array.from(value) : value;
  }
  return state;
}

__exp.copyArrayElements = copyArrayElements;
__exp.copyArray = copyArray;
__exp.fromJSON = fromJSON;
__exp.toJSON = toJSON;
return __exp;
}
__defs["browser/frame-timer.js"] = __m_browser_frame_timer_js;
__defs["browser/gamepad.js"] = __m_browser_gamepad_js;
__defs["browser/index.js"] = __m_browser_index_js;
__defs["browser/keyboard.js"] = __m_browser_keyboard_js;
__defs["browser/screen.js"] = __m_browser_screen_js;
__defs["browser/speakers.js"] = __m_browser_speakers_js;
__defs["controller.js"] = __m_controller_js;
__defs["cpu.js"] = __m_cpu_js;
__defs["gamegenie.js"] = __m_gamegenie_js;
__defs["index.js"] = __m_index_js;
__defs["mappers/index.js"] = __m_mappers_index_js;
__defs["mappers/mapper0.js"] = __m_mappers_mapper0_js;
__defs["mappers/mapper1.js"] = __m_mappers_mapper1_js;
__defs["mappers/mapper11.js"] = __m_mappers_mapper11_js;
__defs["mappers/mapper118.js"] = __m_mappers_mapper118_js;
__defs["mappers/mapper119.js"] = __m_mappers_mapper119_js;
__defs["mappers/mapper140.js"] = __m_mappers_mapper140_js;
__defs["mappers/mapper180.js"] = __m_mappers_mapper180_js;
__defs["mappers/mapper2.js"] = __m_mappers_mapper2_js;
__defs["mappers/mapper240.js"] = __m_mappers_mapper240_js;
__defs["mappers/mapper241.js"] = __m_mappers_mapper241_js;
__defs["mappers/mapper3.js"] = __m_mappers_mapper3_js;
__defs["mappers/mapper34.js"] = __m_mappers_mapper34_js;
__defs["mappers/mapper38.js"] = __m_mappers_mapper38_js;
__defs["mappers/mapper4.js"] = __m_mappers_mapper4_js;
__defs["mappers/mapper5.js"] = __m_mappers_mapper5_js;
__defs["mappers/mapper66.js"] = __m_mappers_mapper66_js;
__defs["mappers/mapper7.js"] = __m_mappers_mapper7_js;
__defs["mappers/mapper71.js"] = __m_mappers_mapper71_js;
__defs["mappers/mapper79.js"] = __m_mappers_mapper79_js;
__defs["mappers/mapper9.js"] = __m_mappers_mapper9_js;
__defs["mappers/mapper94.js"] = __m_mappers_mapper94_js;
__defs["nes.js"] = __m_nes_js;
__defs["papu/channel-dm.js"] = __m_papu_channel_dm_js;
__defs["papu/channel-noise.js"] = __m_papu_channel_noise_js;
__defs["papu/channel-square.js"] = __m_papu_channel_square_js;
__defs["papu/channel-triangle.js"] = __m_papu_channel_triangle_js;
__defs["papu/index.js"] = __m_papu_index_js;
__defs["ppu/index.js"] = __m_ppu_index_js;
__defs["ppu/nametable.js"] = __m_ppu_nametable_js;
__defs["ppu/palette-table.js"] = __m_ppu_palette_table_js;
__defs["rom.js"] = __m_rom_js;
__defs["tile.js"] = __m_tile_js;
__defs["utils.js"] = __m_utils_js;
  const __index = __req("index.js");
  // 擴充用：把 mapper 表與基底類別掛在 NES 上（只在 bundle 裡掛，不改上游 src）
  __index.NES.mappers = __req('mappers/index.js').default;
  __index.NES.Mapper0 = __req('mappers/mapper0.js').default;
  return { NES: __index.NES, Controller: __index.Controller, GameGenie: __index.GameGenie, Browser: __index.Browser };
}));
