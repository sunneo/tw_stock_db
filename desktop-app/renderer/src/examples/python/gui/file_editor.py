# -*- coding: utf-8 -*-
# 簡易文字編輯器：讀檔、寫檔、另存、最近檔案、修改標記、選單列與快捷鍵、檔案選擇對話框。
#
# 操作方式：
#   Ctrl+N 新增、Ctrl+O 開啟（跳出檔案選擇）、Ctrl+S 儲存、Ctrl+Shift+S 另存新檔、Ctrl+Q 結束。
#   檔名欄顯示目前檔名；改成別的名字再按「另存」就會存成新檔（一律存在工作資料夾 /work 底下）。
#   「最近檔案」選單列出最近開過、存過的檔案，點一下就讀回來。標題列的「● 未儲存」是修改標記。
#
# 用到的限制與繞法：
#   * 視窗沒有「確認對話框」可以在不開新視窗的情況下用，所以「內容尚未儲存」改成「再按一次同樣動作才放棄」。
#   * 選單項目建立後不能刪除，所以最近檔案先建好 5 個空位，之後用 set(text=, visible=) 改字或隱藏。
#   * pick_file 讀進來的內容不限大小；檔案內容以 UTF-8 解碼，壞字元以 ? 取代。
#   * 視窗只在 wait() 回傳時才有機會更新畫面，所以用 wait(also=("input",)) 讓每次打字都喚醒迴圈、更新修改標記。
import json
import os
import tempfile

import gui

WORK = "/work" if os.path.isdir("/work") else tempfile.gettempdir()
RECENT_FILE = os.path.join(WORK, ".file_editor_recent.json")
RECENT_MAX = 5
LANGS = {".py": "python", ".js": "javascript", ".json": "json", ".md": "markdown", ".html": "html", ".css": "css"}
WELCOME = "歡迎使用簡易文字編輯器。\n\n試試看：\n1. 直接輸入文字，標題列會出現「● 未儲存」。\n2. 按 Ctrl+S 存成檔案。\nHello, this is a tiny editor.\n"


# ---------- 純函式（不碰視窗，方便單元測試） ----------
def safe_name(name):
    """把使用者輸入的檔名清成 /work 底下的單一檔名：去掉路徑、控制字元；空的就用 untitled.txt。"""
    base = os.path.basename(str(name).replace("\\", "/")).strip()
    base = "".join(c for c in base if c >= " " and c not in '<>:"|?*')
    if base in ("", ".", ".."):
        base = "untitled.txt"
    return base if "." in base else base + ".txt"


def push_recent(recent, path, limit=RECENT_MAX):
    """最近檔案：新的放最前面，重複的移到最前面，最多 limit 筆。"""
    return ([path] + [p for p in recent if p != path])[:limit]


def lang_for(name):
    return LANGS.get(os.path.splitext(name)[1].lower(), "")


def stats(text):
    """（行數, 字數）。字數是字元數，換行不算。"""
    lines = text.count("\n") + 1 if text else 1
    return lines, len(text.replace("\n", ""))


def decode_text(data):
    return data.decode("utf-8", errors="replace")


# ---------- 檔案讀寫 ----------
def read_text(path):
    with open(path, "rb") as f:
        return decode_text(f.read())


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def load_recent():
    try:
        with open(RECENT_FILE, encoding="utf-8") as f:
            return [p for p in json.load(f) if isinstance(p, str)][:RECENT_MAX]
    except (OSError, ValueError):
        return []


def save_recent(recent):
    try:
        write_text(RECENT_FILE, json.dumps(recent))
    except OSError:
        pass  # 最近檔案只是方便功能，寫不進去不影響編輯


# ---------- 編輯器本體 ----------
class Editor(object):
    def __init__(self):
        self.path = ""            # 目前檔案的完整路徑；"" 表示還沒存過
        self.saved_text = WELCOME  # 上次存檔（或讀入）時的內容，拿來判斷是否修改
        self.pending = None       # 等待「再按一次」確認的動作名稱
        self.recent = [p for p in load_recent() if os.path.isfile(p)]
        self.build()

    def build(self):
        w = self.w = gui.Window("簡易文字編輯器", width=760, height=520, resizable=True)
        bar = w.menubar()
        m = w.menu("檔案", parent=bar)
        self.items = {}
        for text, name, keys in (("新增", "new", "Ctrl+N"), ("開啟…", "open", "Ctrl+O"), ("儲存", "save", "Ctrl+S"),
                                 ("另存新檔", "saveas", "Ctrl+Shift+S"), ("結束", "quit", "Ctrl+Q")):
            self.items[w.menuitem(text, parent=m, keys=keys)] = name
            w.shortcut(keys, name)
        rm = w.menu("最近檔案", parent=bar)
        self.recent_items = [w.menuitem("（空）", parent=rm) for _ in range(RECENT_MAX)]
        em = w.menu("編輯", parent=bar)
        self.items[w.menuitem("插入分隔線", parent=em)] = "rule"

        tool = w.row(role="toolbar", gap=6)
        for text, name in (("新增", "new"), ("開啟", "open"), ("儲存", "save"), ("另存", "saveas")):
            self.items[w.button(text, parent=tool)] = name
        w.label("檔名", parent=tool)
        self.name_box = w.entry("untitled.txt", parent=tool, grow=1)
        self.mark = w.label("", parent=tool)
        self.ed = w.editor(WELCOME, lang="", rows=18, grow=1, wrap=True)
        self.status = w.label("", role="statusbar")
        self.refresh_recent()
        self.refresh_status()

    # --- 畫面更新 ---
    def modified(self):
        return self.w.value(self.ed) != self.saved_text

    def refresh_status(self, note=""):
        text = self.w.value(self.ed) or ""
        lines, chars = stats(text)
        self.w.set(self.mark, text="● 未儲存" if self.modified() else "已儲存")
        where = self.path or "（尚未存檔）"
        self.w.set(self.status, text="%s    %d 行　%d 字    %s" % (where, lines, chars, note))

    def refresh_recent(self):
        for i, nid in enumerate(self.recent_items):
            if i < len(self.recent):
                self.w.set(nid, text=os.path.basename(self.recent[i]), visible=True)
            else:
                self.w.set(nid, text="（空）", visible=(i == 0))

    def remember(self, path):
        self.recent = push_recent(self.recent, path)
        save_recent(self.recent)
        self.refresh_recent()

    # --- 動作 ---
    def guard(self, action):
        """有未存內容時，第一次按只提醒、第二次（同一個動作）才放行。回傳 True 表示可以做。"""
        if not self.modified() or self.pending == action:
            self.pending = None
            return True
        self.pending = action
        self.refresh_status("內容尚未儲存！再按一次同樣的動作就會放棄修改")
        return False

    def load(self, path, text):
        self.path = path
        self.saved_text = text
        self.w.set(self.ed, value=text, lang=lang_for(path))
        self.w.set(self.name_box, value=os.path.basename(path))
        self.refresh_status("已開啟")

    def do_new(self):
        if self.guard("new"):
            self.path = ""
            self.saved_text = ""
            self.w.set(self.ed, value="", lang="")
            self.w.set(self.name_box, value="untitled.txt")
            self.refresh_status("新檔案")

    def do_open(self):
        if not self.guard("open"):
            return
        try:
            f = gui.pick_file("開啟文字檔", accept=".txt,.md,.py,.json,.js,.html,.css,.csv,.log")
        except Exception as e:  # 環境不支援對話框或讀不了檔案
            self.refresh_status("無法開啟：%s" % e)
            return
        if not f:
            self.refresh_status("取消開啟")
            return
        path = os.path.join(WORK, safe_name(f["name"]))
        text = decode_text(f["data"])
        write_text(path, text)  # 瀏覽器版選到的檔沒有真實路徑，所以複製一份到 /work 再編輯
        self.load(path, text)
        self.remember(path)

    def do_open_recent(self, index):
        if index >= len(self.recent) or not self.guard("recent%d" % index):
            return
        path = self.recent[index]
        try:
            self.load(path, read_text(path))
            self.remember(path)
        except OSError as e:
            self.refresh_status("讀取失敗：%s" % e)

    def save_to(self, path):
        text = self.w.value(self.ed) or ""
        try:
            write_text(path, text)
        except OSError as e:
            self.refresh_status("存檔失敗：%s" % e)
            return
        self.path = path
        self.saved_text = text
        self.w.set(self.ed, lang=lang_for(path))
        self.remember(path)
        self.refresh_status("已存到 %s" % path)

    def do_save(self):
        self.save_to(self.path or os.path.join(WORK, safe_name(self.w.value(self.name_box))))

    def do_saveas(self):
        self.save_to(os.path.join(WORK, safe_name(self.w.value(self.name_box))))
        self.w.set(self.name_box, value=os.path.basename(self.path))

    def do_rule(self):
        text = (self.w.value(self.ed) or "") + "\n" + "-" * 30 + "\n"
        self.w.set(self.ed, value=text, caret=len(text))
        self.refresh_status()

    def run(self):
        w = self.w
        actions = {"new": self.do_new, "open": self.do_open, "save": self.do_save,
                   "saveas": self.do_saveas, "rule": self.do_rule}
        while True:
            ev = w.wait(timeout=3600, also=("input",))
            if ev is None:
                continue
            kind = ev.get("event")
            if kind == "close":
                break
            name = None
            if kind == "shortcut":
                name = ev.get("value")
            elif kind == "click":
                name = self.items.get(ev.get("node"))
                if ev.get("node") in self.recent_items:
                    self.do_open_recent(self.recent_items.index(ev["node"]))
                    continue
            elif kind == "input" and ev.get("node") == self.ed:
                self.pending = None
                self.refresh_status()
                continue
            if name == "quit":
                if self.guard("quit"):
                    break
            elif name in actions:
                actions[name]()
        w.close()


if __name__ == "__main__":
    Editor().run()
