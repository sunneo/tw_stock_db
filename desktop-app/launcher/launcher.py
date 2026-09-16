# tw_stock_db customization, 2026-09-16: user-requested launcher, built with
# PyInstaller instead of any more Electron/Node-level subsystem tricks.
#
# Context (why this exists): the packaged Electron app is a single GUI-
# subsystem .exe by default. On Windows, `-p` needs a real console attached,
# but a GUI-subsystem process launched bare from PowerShell never receives a
# usable console handle - confirmed on real hardware with timed tests, and
# confirmed again when spawning a console-subsystem child from that same
# broken GUI-subsystem parent (whether via a copied/PE-patched binary or via
# `cmd.exe /c`): both times Windows allocated the child a brand-new,
# invisible console window instead of attaching to the visible one, because
# the parent had nothing valid to hand down regardless of what it spawned.
#
# This script is compiled by PyInstaller as a real, properly linked console-
# subsystem executable (not a post-hoc PE header byte patch on a huge
# Electron binary) named FloatingAssistant.exe - the ONE file the user ever
# runs. It never IS the app; its only job is to find and launch the actual
# Electron app (named FloatingAssistantApp.exe) the right way for each case:
#
#   - With -p (or --prompt): this process was launched directly by the
#     user's shell, so it has a real, valid console of its own. It runs
#     FloatingAssistantApp.exe as a child with stdio left un-redirected
#     (inherited), waits for it, and exits with the same code. This is the
#     one scenario that's been verified end to end to work.
#   - Without -p: spawns FloatingAssistantApp.exe detached (no console
#     needed at all for GUI mode) and exits immediately itself.
#
# 2026-09-16: tried making this genuinely single-file by having build.ps1
# bundle the whole Electron app (dist\win-unpacked\) into this PyInstaller
# build via --add-data, self-extracting to sys._MEIPASS on every launch.
# `-p` worked through that, but the GUI window came up blank - Chromium
# logged disk_cache/GPU cache creation failures, almost certainly tied to
# running FloatingAssistantApp.exe out of a fresh PyInstaller temp
# extraction folder each time. Reverted (not deep-dived further) back to
# the loose-folder layout below, which is the one configuration verified
# working for both -p and the GUI. Left the sys._MEIPASS check in as a
# fallback in case bundling is revisited later, but build.ps1 currently
# does NOT pass --add-data, so it never triggers in the shipped build.
# Kept as a loose-folder fallback too (checks next to the launcher's
# own exe first) so the same script also works when the app sits beside it
# unbundled, e.g. for local testing.
import os
import sys
import subprocess


def _app_exe_path():
    # Bundled (--onefile with --add-data) case: PyInstaller extracts
    # everything under sys._MEIPASS before this code runs.
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        bundled_path = os.path.join(bundled_root, "app", "FloatingAssistantApp.exe")
        if os.path.isfile(bundled_path):
            return bundled_path
    # Loose-folder fallback: app sitting right next to this launcher's own
    # executable (sys.executable is the real running .exe path even when
    # frozen, not the temp extraction path).
    base_dir = os.path.dirname(os.path.abspath(sys.executable))
    return os.path.join(base_dir, "FloatingAssistantApp.exe")


def main():
    argv = sys.argv[1:]
    app_exe = _app_exe_path()

    if not os.path.isfile(app_exe):
        sys.stderr.write(f"找不到 {app_exe}，這個launcher必須跟FloatingAssistantApp.exe放在同一個資料夾\n")
        sys.exit(1)

    has_prompt = any(a == "-p" or a == "--prompt" for a in argv)

    if has_prompt:
        # stdout/stderr/stdin全部不重導向(None)＝直接繼承這個行程自己的
        # handle——這個launcher本身是PyInstaller真的build成console
        # subsystem的executable，被使用者shell直接執行時天生就有可靠的
        # console，往下relay給子行程（不論子行程本身是GUI或console
        # subsystem）已經實測驗證過可以正確運作。
        proc = subprocess.run([app_exe] + argv)
        sys.exit(proc.returncode)
    else:
        # GUI模式：detached，不需要繼承/等待任何console輸出（GUI本來就不
        # 需要console），啟動後這個launcher自己立刻結束。
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        subprocess.Popen(
            [app_exe],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )
        sys.exit(0)


if __name__ == "__main__":
    main()
