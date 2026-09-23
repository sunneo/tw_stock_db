# README.FloatingAssitant.md  

**Floating Assistant – Desktop Electron Wrapper**  
*(Auto‑generated understanding of the project located at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`)*  

---  

## 📦 Project Overview  

This repository packages the **floating-assistant.js** web application into a standalone desktop client built with **Electron**.  
The desktop wrapper adds capabilities that the pure web version cannot access directly, namely:

* **Scoped file‑system access** (`fa:fs:*`) – limited to folders the user has explicitly granted via the built‑in permission UI.  
* **Raw file‑system access** (`fa:rawfs:*`) – unrestricted access to any path the operating‑system account can reach (added per user request).  
* **Local command / subprocess execution** – run arbitrary shell commands from the UI or CLI.  
* **Built‑in local proxy** – replaces the Cloudflare Worker used by the web version, allowing all API calls to be routed through a local endpoint.  
* **CLI mode** (`-p/--prompt`) – non‑interactive usage from a terminal or script, powered by a separate PyInstaller‑built launcher that forwards stdio to the Electron binary.  
* **Per‑workspace settings & conversation history** – stored in `.floating-assistant/localStorage.json` inside each working folder.  
* **API‑key management** – prefers environment variables, falls back to a `secrets.json` file (generated at build time), and finally uses hard‑coded free‑tier defaults.  
* **Native confirmation dialogs** – because Electron lacks `window.prompt`/`window.confirm`, the app shows native OS dialogs before executing potentially side‑effect‑ful actions.  

The result is a **hybrid GUI/CLI** application that can be launched either by double‑clicking (GUI) or via a terminal command (CLI) while retaining full access to local resources.  

---  

## 🗂️ Main Program Entry Point  

| Item | Description |
|------|-------------|
| **Entry file** | `main.js` (declared in `package.json` as `"main": "main.js"`). |
| **Responsibilities** | 1. Initialise the Electron `app` and create the main `BrowserWindow`.<br>2. Register IPC handlers that implement the file‑system APIs (`fa:fs:*`, `fa:rawfs:*`), command execution, proxy forwarding, and settings persistence.<br>3. Load and save per‑workspace `localStorage.json`.<br>4. Parse CLI arguments (`-p/--prompt`, `--output-format`) and route non‑interactive requests to the GUI instance.<br>5. Show native confirmation windows before executing commands or displaying prompts/alerts.<br>6. Coordinate with the separate **Launcher** executable (see Build Process) to provide reliable stdio handling for CLI mode. |

In short, `main.js` is the **main process “brain”** – it manages the window lifecycle, exposes all privileged capabilities through IPC, and bridges GUI and CLI usage.  

---  

## 🛠️ Build Process  

The project supplies three platform‑specific scripts (`build.bat`, `build.ps1`, `build.sh`) that all delegate to the PowerShell script `build.ps1`. The build consists of four logical stages:

### 1. Source Synchronisation & Secret Generation  

* **Editable source vs. shipped bundle (2026‑09‑24)** – `renderer\floating-assistant.js` is no longer hand‑edited directly. The real, editable source lives at `renderer\src\floating-assistant.js` (~2MB); `build-assistant.js` (via `node build-assistant.js`, wired into `npm run build:assistant`, `npm start`'s `prestart`, and `build.sh`/`build.ps1`) runs it through `terser` and writes the minified result to **both** `renderer\floating-assistant.js` (kept at this exact path/filename so the Electron app's `<script src="floating-assistant.js">` and the web app's runtime `fetch()` of this same path on GitHub both keep working with zero changes on their end) **and** `renderer\floating-assistant.min.js` (a plainly-named copy of the same content). Editing workflow going forward: change `renderer\src\floating-assistant.js`, then run `npm run build:assistant` (or just `npm start`, which does it automatically) before testing/committing — commit all three files together.
* **Built‑in secrets** – reads environment variables `FA_BUILTIN_NVAPI_KEY` and `FA_BUILTIN_OPENROUTER_KEY`. If both are present, they are written to `builtin-secrets.json`. If the variables are unset and no existing file exists, an empty JSON object is written; the user can later edit this file to “bake in” their own keys. This avoids hard‑coding credentials in the repository.  

### 2. Launcher Construction (PyInstaller)  

* **Source** – `launcher\launcher.py` (a tiny Python helper).  
* **Command** – `pyinstaller --onefile --console launcher\launcher.py`.  
* **Output** – `FloatingAssistant.exe`, a **console‑subsystem** binary with real stdio handles.  
* **Role**  
  * **With `-p`** – launches the Electron GUI binary (`FloatingAssistantApp.exe`) and forwards stdio, enabling true CLI mode.  
  * **Without `-p`** – detaches and starts the GUI binary, allowing double‑click or Start‑Menu shortcuts to open the window without an unwanted console.  

This separation solves the fundamental limitation that a GUI‑subsystem Electron process cannot create a usable console when launched from a shortcut.  

### 3. Electron Packaging (electron‑builder)  

* After the launcher is ready, `electron-builder` is invoked:  

  ```bash
  npx electron-builder --win nsis dir --x64
  ```  

* **Artifacts placed in `dist\`**  
  * **Installer** – `FloatingAssistant Setup <version>.exe` (NSIS) – creates desktop/start‑menu shortcuts pointing to `FloatingAssistantApp.exe`, adds an entry in “Apps & Features”, etc.  
  * **Portable folder** – `win-unpacked\` – a zero‑install copy containing both `FloatingAssistant.exe` (launcher) and `FloatingAssistantApp.exe` (Electron app) plus all resources. Running the launcher inside this folder yields both GUI and CLI functionality.  

* The Electron binary itself (`FloatingAssistantApp.exe`) is built with the default **GUI subsystem** (no console), so launching it directly never shows a black window; all console needs are satisfied by the launcher.  
* The build is **unsigned** by design (see the project’s known limitations), which may trigger SmartScreen warnings on some systems.  

### 4. Build Script Details  

* `build.bat` – simply exports the two key environment variables and calls `build.ps1 -SkipInstall`.  
* `build.ps1` – performs the steps above:  
  1. Sync web source.  
  2. Generate (or preserve) `builtin-secrets.json`.  
  3. Optionally run `npm install` (skipped when `-SkipInstall` is used and `node_modules` is up‑to‑date).  
  4. Build the launcher with PyInstaller.  
  5. Run electron‑builder to produce installer and portable outputs.  

---  

## 🚀 Usage  

### GUI Mode  

* Double‑click the installed `FloatingAssistant.exe` or run the portable `FloatingAssistant.exe` from the `win-unpacked\` folder.  
* The main window appears, providing the familiar Floating Assistant chat interface with added local‑file and command buttons.  

### CLI Mode  

Open a terminal (Command Prompt, PowerShell, etc.) and invoke the launcher:

```bash
# Basic prompt
FloatingAssistant.exe -p "Explain the difference between let and const in JavaScript"

# Specify output format (e.g., JSON, markdown)
FloatingAssistant.exe -p "List three benefits of using Electron" --output-format json
```

* The launcher forwards the prompt to the GUI binary, captures the response, prints it to stdout, and then exits.  
* No Electron window is shown when `-p` is used, making it suitable for scripts, CI pipelines, or automation.  

### Environment Variables (for building / runtime)  

| Variable | Purpose |
|----------|---------|
| `FA_BUILTIN_NVAPI_KEY` | API key for NVIDIA‑provided models (used when building `builtin-secrets.json`). |
| `FA_BUILTIN_OPENROUTER_KEY` | API key for OpenRouter models (same as above). |
| `FA_API_KEY_<NAME>` | Runtime overrides for specific services (read by the main process if present). |
| `NO_PROXY` / `HTTP_PROXY` | Standard proxy variables respected by the built‑in local proxy. |

If the variables are not set at build time, the generated `builtin-secrets.json` will be empty; the user can later edit that file (or place a `secrets.json` next to the executable) to inject their own keys.  

---  

## 📁 Repository Structure (relevant parts)  

```
desktop-app/
├─ .floating-assistant/          # runtime data (created per workspace)
├─ build/
│   └─ afterPack.js              # electron-builder hook to copy launcher
├─ launcher/
│   └─ launcher.py               # PyInstaller source for the console helper
├─ renderer/
│   └─ floating-assistant.js     # synced web UI code
├─ local-proxy.js                # simple HTTP proxy used by the app
├─ main.js                       # Electron main process (entry point)
├─ preload.js                    # Electron preload script (exposes safe APIs)
├─ package.json                  # defines main, scripts, dependencies
├─ README.md                     # original project readme (not used here)
└─ ...                           # other config files (build scripts, etc.)
```  

---  

## ✅ Summary  

* **What it does** – Wraps the web‑based Floating Assistant in Electron, granting privileged local capabilities (file‑system, subprocesses, local proxy) and a reliable CLI mode via a separate console launcher.  
* **Main entry point** – `main.js` orchestrates the Electron app, exposes all privileged features through IPC, and bridges GUI/CLI workflows.  
* **How it’s built** – Source sync → secret generation → PyInstaller launcher → electron‑builder → electron‑builder packaging → installer & portable outputs.  
* **How to use** – Launch the executable for GUI, or use `-p "your prompt"` from a terminal for scriptable, non‑interactive interaction.  

This README reflects an independent understanding of the project derived from examining the source files and build scripts; it does **not** rely on the existing `README.md`.  

---  

*Generated on 2025‑08‑24.*