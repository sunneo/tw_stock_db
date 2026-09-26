#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重新產生 themes/*（套版）與 calendar.json。

用法（在這個 branch 的根目錄）：
    python tools/build.py          # 產生 themes/<id>/... 與 calendar.json
    python tools/check.py          # 驗證（每個套版 <= 1MB、日期格式、資產齊全）

每年要做的事只有一件：政府公布下一年度「政府行政機關辦公日曆表」後，
在下面 FESTIVALS 補上那一年的日期，再 build + check（見 README.md）。
"""
import json
import math
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ============================================================
# 一、行事曆資料（唯一需要每年手動維護的地方）
# start/end：辦公日曆表上的放假（含連假、補假）起訖，連假期間都算同一個節慶
# priority：同一天有多個節慶時，數字大的優先（連假 90-100 > 一般節慶 40-60）
# lead（佈置期，連假前幾天開始換上套版）不在這裡填，統一由 THEMES[theme]["lead"] 決定，
# 這樣同一個套版每年的「漸進」節奏一致（見 README.md 的「越接近節日越豐富」）。
# ============================================================
SRC26 = "行政院核定115年(2026)政府行政機關辦公日曆表"
SRC27 = "行政院核定116年(2027)政府行政機關辦公日曆表"
RULE = "依節日規則推算（農曆／母親節等非放假節慶）"
F = lambda id, theme, name, start, end, priority, source: dict(id=id, theme=theme, name=name, start=start, end=end, priority=priority, source=source)
FESTIVALS = [
    # ---- 2026（民國115年）----
    F("new-year-2026", "new-year", "元旦", "2026-01-01", "2026-01-01", 90, SRC26),
    F("lunar-new-year-2026", "lunar-new-year", "農曆春節", "2026-02-14", "2026-02-22", 100, SRC26),
    F("valentine-2026", "valentine", "情人節", "2026-02-14", "2026-02-14", 40, RULE),
    F("peace-2026", "peace", "和平紀念日", "2026-02-27", "2026-03-01", 90, SRC26),
    F("lantern-2026", "lantern", "元宵節", "2026-03-03", "2026-03-03", 60, RULE + "：農曆正月十五"),
    F("spring-2026", "spring", "兒童節・清明節", "2026-04-03", "2026-04-06", 90, SRC26),
    F("labor-2026", "labor", "勞動節", "2026-05-01", "2026-05-03", 90, SRC26),
    F("mother-2026", "mother", "母親節", "2026-05-10", "2026-05-10", 50, RULE + "：5月第2個星期日"),
    F("dragon-boat-2026", "dragon-boat", "端午節", "2026-06-19", "2026-06-21", 90, SRC26),
    F("father-2026", "father", "父親節", "2026-08-08", "2026-08-08", 55, RULE + "：台灣父親節固定 8/8（諧音「爸爸」）"),
    F("qixi-2026", "qixi", "七夕情人節", "2026-08-19", "2026-08-19", 50, RULE + "：農曆七月初七"),
    F("military-2026", "military", "軍人節", "2026-09-03", "2026-09-03", 50, RULE + "：台灣軍人節固定 9/3"),
    F("mid-autumn-2026", "mid-autumn", "中秋節・教師節", "2026-09-25", "2026-09-28", 90, SRC26),
    F("national-2026", "national", "國慶日", "2026-10-09", "2026-10-11", 90, SRC26),
    F("restoration-2026", "restoration", "臺灣光復暨金門古寧頭大捷紀念日", "2026-10-24", "2026-10-26", 90, SRC26),
    F("halloween-2026", "halloween", "萬聖節", "2026-10-31", "2026-10-31", 45, RULE),
    F("christmas-2026", "christmas", "聖誕節・行憲紀念日", "2026-12-25", "2026-12-27", 90, SRC26),
    F("new-year-2027", "new-year", "跨年・開國紀念日", "2026-12-31", "2027-01-03", 95, SRC27),
    # ---- 2027（民國116年）----
    F("lunar-new-year-2027", "lunar-new-year", "農曆春節", "2027-02-04", "2027-02-10", 100, SRC27),
    F("valentine-2027", "valentine", "情人節", "2027-02-14", "2027-02-14", 40, RULE),
    F("lantern-2027", "lantern", "元宵節", "2027-02-20", "2027-02-20", 60, RULE + "：農曆正月十五"),
    F("peace-2027", "peace", "和平紀念日", "2027-02-27", "2027-03-01", 90, SRC27),
    F("spring-2027", "spring", "兒童節・清明節", "2027-04-03", "2027-04-06", 90, SRC27),
    F("labor-2027", "labor", "勞動節", "2027-04-30", "2027-05-02", 90, SRC27),
    F("mother-2027", "mother", "母親節", "2027-05-09", "2027-05-09", 50, RULE + "：5月第2個星期日"),
    F("dragon-boat-2027", "dragon-boat", "端午節", "2027-06-09", "2027-06-09", 90, SRC27),
    F("qixi-2027", "qixi", "七夕情人節", "2027-08-08", "2027-08-08", 50, RULE + "：農曆七月初七（2027 與父親節同一天，以父親節為主）"),
    F("father-2027", "father", "父親節", "2027-08-08", "2027-08-08", 55, RULE + "：台灣父親節固定 8/8（諧音「爸爸」）"),
    F("military-2027", "military", "軍人節", "2027-09-03", "2027-09-03", 50, RULE + "：台灣軍人節固定 9/3"),
    F("mid-autumn-2027", "mid-autumn", "中秋節", "2027-09-15", "2027-09-15", 90, SRC27),
    F("teachers-2027", "teachers", "教師節", "2027-09-28", "2027-09-28", 90, SRC27 + "：教師節放假但不成連假"),
    F("national-2027", "national", "國慶日", "2027-10-09", "2027-10-11", 90, SRC27),
    F("restoration-2027", "restoration", "臺灣光復暨金門古寧頭大捷紀念日", "2027-10-23", "2027-10-25", 90, SRC27),
    F("halloween-2027", "halloween", "萬聖節", "2027-10-31", "2027-10-31", 45, RULE),
    F("christmas-2027", "christmas", "聖誕節・行憲紀念日", "2027-12-24", "2027-12-26", 90, SRC27),
    F("new-year-2028", "new-year", "跨年・開國紀念日", "2027-12-31", "2028-01-02", 95, SRC27),
]

# ============================================================
# 二、套版定義
# lead      佈置期天數（越接近節日越豐富，見 frames）
# top/bottom  上、下兩個區域的畫法（見 build_top / build_bottom）；中間對話區是 body 花紋
# motifs/colors  圖案與配色；blend 標示「台灣＋國外」混合風的額外元素
# frames    漸進畫格：offset = 今天 - 連假第一天（負數 = 節日前幾天，0 = 節日當天起）
# ============================================================
BLUE, RED, WHITE = "#1c4fa1", "#d6336c", "#f1f3f5"
THEMES = {
    "new-year": dict(name="元旦・跨年・開國紀念日", accent="#2b6cb0", lead=3, top="burst", bottom="row",
                     greeting="新年快樂！Happy New Year 🎆（開國紀念日）", motifs=["firework", "star", "sun12"], blend=["sun12"],
                     colors=["#f6c343", "#ff6b6b", "#63b3ed", BLUE], particles=["🎆", "✨", "🎉"],
                     light=dict(bannerBg="#e7f0fb", bannerText="#1a3f6b", border="#9cc0e8"), dark=dict(bannerBg="#16283f", bannerText="#cfe4ff", border="#2f5686")),
    "lunar-new-year": dict(name="農曆春節", accent="#d7263d", lead=7, top="crackers", bottom="row",
                           greeting="新春快樂，恭喜發財！🧧", motifs=["lantern", "plum", "coin"], colors=["#d7263d", "#f4c542", "#ff8a5b"], particles=["🧧", "✨", "🏮"],
                           light=dict(bannerBg="#fff0ee", bannerText="#8a1c1c", border="#e3a3a0"), dark=dict(bannerBg="#3b1414", bannerText="#ffd9a0", border="#7a2b2b")),
    "lantern": dict(name="元宵節", accent="#e8590c", lead=0, top="hang", bottom="row",
                    greeting="元宵節快樂！猜燈謎、吃湯圓 🏮", motifs=["lantern", "lantern", "star"], colors=["#e8590c", "#f59f00", "#e64980", "#7048e8"], particles=["🏮", "✨"],
                    light=dict(bannerBg="#fff3e6", bannerText="#8a3a08", border="#f0b98a"), dark=dict(bannerBg="#3a2210", bannerText="#ffd8a8", border="#8a5a2b")),
    "valentine": dict(name="情人節", accent="#e64980", lead=0, top="hang", bottom="row",
                      greeting="情人節快樂 💝", motifs=["heart", "heart", "star"], colors=["#e64980", "#ff8787", "#f783ac"], particles=["💗", "💕", "✨"],
                      light=dict(bannerBg="#fff0f6", bannerText="#9c1f52", border="#f3a6c4"), dark=dict(bannerBg="#3b1526", bannerText="#ffd0e3", border="#8a2b57")),
    "peace": dict(name="和平紀念日", accent="#4a7c59", lead=1, top="still", bottom="row",
                  greeting="二二八和平紀念日：記取歷史，珍惜和平 🕊️", motifs=["leaf", "leaf", "circle"], colors=["#6b9080", "#a4c3b2", "#b7b7a4"], particles=[],
                  light=dict(bannerBg="#eef4f0", bannerText="#2f5240", border="#a9c4b4"), dark=dict(bannerBg="#1b2a22", bannerText="#cfe6d8", border="#3c5f4a")),
    "spring": dict(name="兒童節・清明節", accent="#2f9e6f", lead=2, top="hang", bottom="row",
                   greeting="兒童節快樂！清明連假出遊、掃墓請平安 🌸", motifs=["balloon", "flower", "flower"], colors=["#f783ac", "#ffd43b", "#74c0fc", "#8ce99a"], particles=["🌸", "🎈", "🌿"],
                   light=dict(bannerBg="#eefaf3", bannerText="#1f6b4a", border="#9fd8bb"), dark=dict(bannerBg="#16302a", bannerText="#c9f2dc", border="#2f6b55")),
    "labor": dict(name="勞動節", accent="#1c7ed6", lead=1, top="hang", bottom="row",
                  greeting="勞動節快樂，辛苦了！💪", motifs=["gear", "star", "gear"], colors=["#1c7ed6", "#f59f00", "#5c7cfa"], particles=["✨"],
                  light=dict(bannerBg="#e7f1fc", bannerText="#154a80", border="#9cc4ee"), dark=dict(bannerBg="#14283f", bannerText="#cfe4ff", border="#2b5b8f")),
    "mother": dict(name="母親節", accent="#e64980", lead=0, top="hang", bottom="row",
                   greeting="母親節快樂！謝謝媽媽 💐", motifs=["flower", "heart", "flower"], colors=["#ff8fab", "#f06595", "#ffc9de"], particles=["💐", "🌸", "💗"],
                   light=dict(bannerBg="#fff0f6", bannerText="#9c1f52", border="#f3a6c4"), dark=dict(bannerBg="#3b1526", bannerText="#ffd0e3", border="#8a2b57")),
    "dragon-boat": dict(name="端午節", accent="#2f9e44", lead=4, top="hang", bottom="row",
                        greeting="端午節安康！吃粽子、划龍舟 🐉", motifs=["zongzi", "leaf", "wave"], colors=["#2f9e44", "#8ce99a", "#f59f00", "#4dabf7"], particles=["🥟", "🌿", "🐉"],
                        light=dict(bannerBg="#ecf8ee", bannerText="#1e6a2e", border="#a3d9ac"), dark=dict(bannerBg="#15301c", bannerText="#cdf3d2", border="#2f6b3a")),
    "qixi": dict(name="七夕情人節", accent="#7048e8", lead=0, top="hang", bottom="row",
                 greeting="七夕情人節快樂！🌌", motifs=["star", "heart", "moon"], colors=["#7048e8", "#e64980", "#ffd43b", "#9775fa"], particles=["⭐", "💜", "✨"],
                 light=dict(bannerBg="#f1ecfd", bannerText="#43239e", border="#bfaaf3"), dark=dict(bannerBg="#241a45", bannerText="#dccfff", border="#5a44a8")),
    "father": dict(name="父親節", accent="#1c7ed6", lead=0, top="hang", bottom="row",
                   greeting="父親節快樂！謝謝爸爸 👔（台灣的父親節是 8/8）", motifs=["tie", "star", "heart"], colors=["#1c7ed6", "#4dabf7", "#f59f00", "#364fc7"], particles=["👔", "⭐", "💙"],
                   light=dict(bannerBg="#e7f1fc", bannerText="#154a80", border="#9cc4ee"), dark=dict(bannerBg="#14283f", bannerText="#cfe4ff", border="#2b5b8f")),
    "military": dict(name="軍人節", accent="#5c7f3a", lead=0, top="still", bottom="row",
                     greeting="軍人節快樂！感謝國軍保家衛國 🇹🇼（9/3）", motifs=["sun12", "star", "leaf"], colors=["#5c7f3a", "#8fae5c", "#1c4fa1", WHITE], particles=[],
                     light=dict(bannerBg="#eef3e6", bannerText="#3b5423", border="#b5c98f"), dark=dict(bannerBg="#1f2a14", bannerText="#d7e8b8", border="#4a6630")),
    "teachers": dict(name="教師節", accent="#e8590c", lead=2, top="hang", bottom="row",
                     greeting="教師節快樂！謝謝老師 📚（9/28，孔子誕辰紀念日）", motifs=["book", "star", "flower"], colors=["#e8590c", "#f59f00", "#1c7ed6", "#2f9e44"], particles=["📚", "✏️", "⭐"],
                     light=dict(bannerBg="#fff3e6", bannerText="#8a3a08", border="#f0b98a"), dark=dict(bannerBg="#3a2210", bannerText="#ffd8a8", border="#8a5a2b")),
    "mid-autumn": dict(name="中秋節・教師節", accent="#f08c00", lead=15, top="moon", bottom="row",
                       greeting="中秋節快樂！月圓人團圓 🥮 教師節也謝謝老師 🌕", motifs=["osmanthus", "lantern", "book"], colors=["#f59f00", "#ffd43b", "#ff922b", "#e8590c"], particles=["🌕", "✨", "🥮"],
                       light=dict(bannerBg="#fff4e0", bannerText="#8a4b00", border="#f2c983"), dark=dict(bannerBg="#382614", bannerText="#ffe3a8", border="#8a6220")),
    "national": dict(name="國慶日", accent="#1c4fa1", lead=5, top="bunting", bottom="row",
                     greeting="中華民國國慶日快樂！🇹🇼", motifs=["sun12", "star", "sun12"], colors=[BLUE, RED, WHITE], particles=["✨", "🎆"],
                     light=dict(bannerBg="#e8eefa", bannerText="#12356f", border="#9db6e6"), dark=dict(bannerBg="#14223d", bannerText="#d3e0ff", border="#2b4a86")),
    "restoration": dict(name="光復節", accent="#0b7285", lead=2, top="bunting", bottom="row",
                        greeting="臺灣光復暨金門古寧頭大捷紀念日 🇹🇼", motifs=["sun12", "leaf", "wave"], colors=["#0b7285", "#3bc9db", WHITE, BLUE], particles=["✨"],
                        light=dict(bannerBg="#e3f5f8", bannerText="#0a4f5c", border="#96d3dd"), dark=dict(bannerBg="#12303a", bannerText="#c9eef4", border="#2b6070")),
    "halloween": dict(name="萬聖節", accent="#f76707", lead=0, top="hang", bottom="row",
                      greeting="萬聖節快樂！Trick or Treat 🎃", motifs=["pumpkin", "bat", "star"], colors=["#f76707", "#7048e8", "#ffd43b"], particles=["🎃", "🦇", "👻"],
                      light=dict(bannerBg="#fff1e6", bannerText="#8a3a08", border="#f3b48a"), dark=dict(bannerBg="#2a1a10", bannerText="#ffd0a8", border="#8a4a20")),
    # 混合風：聖誕（國外）＋行憲紀念日（台灣）——紅綠聖誕燈串上穿插青天白日小旗，聖誕樹頂星換成青天白日
    "christmas": dict(name="聖誕節・行憲紀念日", accent="#c92a2a", lead=14, top="garland", bottom="row",
                      greeting="聖誕快樂！Merry Christmas 🎄　12/25 也是行憲紀念日 🇹🇼", motifs=["tree", "snow", "ball", "sun12"], blend=["sun12"],
                      colors=["#c92a2a", "#2f9e44", "#ffd43b", BLUE, WHITE], particles=["❄️", "🎄", "⭐"],
                      light=dict(bannerBg="#fdecec", bannerText="#8a1c1c", border="#e8a3a3"), dark=dict(bannerBg="#2b1a1a", bannerText="#ffd6d6", border="#7a2b2b")),
}


# ============================================================
# 三、SVG 圖案庫（全部是簡單幾何，套版才會小）。每個圖案以 (0,0) 為中心，約 ±16。
# ============================================================
def _f(v):
    return ("%.1f" % v).rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def g(x, y, s, body, rot=0, op=None):
    r = ' rotate(%s)' % _f(float(rot)) if rot else ''
    o = ' opacity="%s"' % _f(float(op)) if op is not None else ''
    return '<g transform="translate(%s %s) scale(%s)%s"%s>%s</g>' % (_f(float(x)), _f(float(y)), _f(float(s)), r, o, body)


def m_lantern(c):
    return ('<rect x="-1" y="-23" width="2" height="7" fill="#b8860b"/><ellipse cx="0" cy="-2" rx="14" ry="16" fill="%s"/>'
            '<path d="M-7 -16Q-14 -2 -7 14M7 -16Q14 -2 7 14" stroke="#fff" stroke-opacity=".35" fill="none" stroke-width="1.5"/>'
            '<rect x="-6" y="-19" width="12" height="4" rx="1" fill="#f4c542"/><rect x="-6" y="13" width="12" height="4" rx="1" fill="#f4c542"/>'
            '<path d="M0 17v13" stroke="#f4c542" stroke-width="2"/><circle cx="0" cy="31" r="2" fill="#f4c542"/>') % c


def m_flower(c, center="#ffe066"):
    return "".join('<ellipse cx="0" cy="-9" rx="6" ry="9" fill="%s" transform="rotate(%d)"/>' % (c, 72 * i) for i in range(5)) + '<circle r="4.5" fill="%s"/>' % center


def m_plum(c):
    return m_flower(c, "#f4c542")


def m_coin(c):
    return '<circle r="12" fill="%s"/><circle r="9.5" fill="none" stroke="#fff" stroke-opacity=".5"/><rect x="-3.5" y="-3.5" width="7" height="7" fill="#c0392b"/>' % c


def m_star(c, r=12):
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.45
        pts.append("%s,%s" % (_f(round(rr * math.cos(a), 1)), _f(round(rr * math.sin(a), 1))))
    return '<polygon points="%s" fill="%s"/>' % (" ".join(pts), c)


def m_heart(c):
    return '<path d="M0 12C-22 -4 -10 -20 0 -8C10 -20 22 -4 0 12Z" fill="%s"/>' % c


def m_firework(c):
    parts = []
    for i in range(12):
        a = i * math.pi / 6
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>' % (_f(round(5 * math.cos(a), 1)), _f(round(5 * math.sin(a), 1)), _f(round(15 * math.cos(a), 1)), _f(round(15 * math.sin(a), 1))))
        parts.append('<circle cx="%s" cy="%s" r="1.6" stroke="none" fill="%s"/>' % (_f(round(18 * math.cos(a), 1)), _f(round(18 * math.sin(a), 1)), c))
    return '<g stroke="%s" stroke-width="2" stroke-linecap="round">%s</g>' % (c, "".join(parts))


def m_gear(c):
    return "".join('<rect x="-3" y="-15" width="6" height="7" rx="1" fill="%s" transform="rotate(%d)"/>' % (c, 45 * i) for i in range(8)) + '<circle r="11" fill="%s"/><circle r="4.5" fill="#fff" fill-opacity=".65"/>' % c


def m_zongzi(c):
    return ('<polygon points="0,-15 16,11 -16,11" fill="%s" stroke="%s" stroke-linejoin="round" stroke-width="3"/><path d="M-9 4H9M-5 -4H5" stroke="#f4d58d" stroke-width="2"/><path d="M0 11v9" stroke="#f4d58d" stroke-width="2"/>') % (c, c)


def m_leaf(c):
    return '<ellipse cx="0" cy="-8" rx="5" ry="11" fill="%s"/><path d="M0 -17V2" stroke="#fff" stroke-opacity=".4"/>' % c


def m_moon(c):
    return '<circle r="14" fill="%s"/><circle cx="-4" cy="-4" r="3" fill="#fff" fill-opacity=".3"/><circle cx="5" cy="4" r="2.2" fill="#fff" fill-opacity=".25"/>' % c


def m_osmanthus(c):
    return "".join('<circle cx="%d" cy="%d" r="2.4" fill="%s"/>' % (x, y, c) for x, y in [(-7, -5), (0, -8), (7, -4), (-3, 3), (4, 5), (-8, 7), (9, 8)])


def m_sun12(c):
    """青天白日：12 道光芒＋圓。c 是光芒/圓的顏色。"""
    return "".join('<polygon points="-2.6,-8 2.6,-8 0,-17" fill="%s" transform="rotate(%d)"/>' % (c, 30 * i) for i in range(12)) + '<circle r="7.5" fill="%s"/>' % c


def m_pumpkin(c):
    return ('<ellipse rx="15" ry="12" fill="%s"/><ellipse cx="-7" rx="6" ry="12" fill="#000" fill-opacity=".12"/><ellipse cx="7" rx="6" ry="12" fill="#000" fill-opacity=".12"/>'
            '<rect x="-2" y="-16" width="4" height="6" rx="1.5" fill="#2f9e44"/><polygon points="-7,-3 -3,-3 -5,-7" fill="#2b2b2b"/><polygon points="3,-3 7,-3 5,-7" fill="#2b2b2b"/>'
            '<path d="M-6 4Q0 9 6 4" stroke="#2b2b2b" stroke-width="2" fill="none"/>') % c


def m_bat(c):
    return '<path d="M0 -4C4 -12 10 -12 18 -8C14 -6 14 -1 10 0C8 -2 4 -2 0 2C-4 -2 -8 -2 -10 0C-14 -1 -14 -6 -18 -8C-10 -12 -4 -12 0 -4Z" fill="%s"/>' % c


def m_tree(c, top=None):
    topper = top if top else '<polygon points="0,-27 2,-22 -2,-22" fill="#ffd43b"/>'
    return ('<polygon points="0,-20 11,-6 -11,-6" fill="%s"/><polygon points="0,-11 14,5 -14,5" fill="%s"/><polygon points="0,-2 17,16 -17,16" fill="%s"/>'
            '<rect x="-3" y="16" width="6" height="6" fill="#8d5524"/>%s') % (c, c, c, topper)


def m_snow(c):
    return '<g stroke="%s" stroke-width="2" stroke-linecap="round">%s</g>' % (c, "".join('<line x1="0" y1="-13" x2="0" y2="13" transform="rotate(%d)"/>' % (60 * i) for i in range(3)))


def m_ball(c):
    return '<rect x="-2" y="-18" width="4" height="4" fill="#f4c542"/><circle r="10" fill="%s"/><circle cx="-3.5" cy="-3.5" r="2.6" fill="#fff" fill-opacity=".45"/>' % c


def m_balloon(c):
    return '<ellipse cx="0" cy="-6" rx="10" ry="12.5" fill="%s"/><polygon points="0,7 -3,11 3,11" fill="%s"/><path d="M0 11Q-6 18 0 24T0 34" stroke="#adb5bd" fill="none"/><ellipse cx="-3.5" cy="-11" rx="2.5" ry="4" fill="#fff" fill-opacity=".4"/>' % (c, c)


def m_wave(c):
    return '<path d="M-20 0Q-15 -8 -10 0T0 0T10 0T20 0" stroke="%s" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M-20 8Q-15 0 -10 8T0 8T10 8T20 8" stroke="%s" stroke-opacity=".6" stroke-width="3" fill="none" stroke-linecap="round"/>' % (c, c)


def m_circle(c):
    return '<circle r="10" fill="none" stroke="%s" stroke-width="3"/><circle r="4" fill="%s"/>' % (c, c)


def m_book(c):
    return '<path d="M-14 -9H-1V10H-14Z M14 -9H1V10H14Z" fill="%s"/><path d="M-1 -9Q0 -11 1 -9V10Q0 8 -1 10Z" fill="#fff" fill-opacity=".5"/>' % c


def m_tie(c):
    return ('<polygon points="-6,-16 6,-16 4,-9 -4,-9" fill="%s"/><polygon points="-4,-9 4,-9 9,10 0,17 -9,10" fill="%s"/>'
            '<path d="M-5 -1L5 3M-6 5L6 9" stroke="#fff" stroke-opacity=".45" stroke-width="2"/>') % (c, c)


MOTIFS = dict(tie=m_tie, lantern=m_lantern, flower=m_flower, plum=m_plum, coin=m_coin, star=m_star, heart=m_heart, firework=m_firework, gear=m_gear,
              zongzi=m_zongzi, leaf=m_leaf, moon=m_moon, osmanthus=m_osmanthus, sun12=m_sun12, pumpkin=m_pumpkin, bat=m_bat, tree=m_tree,
              snow=m_snow, ball=m_ball, balloon=m_balloon, wave=m_wave, circle=m_circle, book=m_book)
# 掛在繩子上時，圖案頂端離圖案中心多遠（讓繩子接到圖案頂端）
HANG = dict(tie=16, lantern=23, ball=18, zongzi=15, pumpkin=16, heart=8, star=12, flower=14, balloon=18, bat=6, gear=15, moon=14, coin=12, sun12=17,
            firework=15, plum=14, snow=13, tree=27, leaf=17, osmanthus=8, wave=6, circle=10, book=10)


def item(name, color, sun_color=None):
    if name == "sun12":
        return m_sun12(sun_color or color)
    return MOTIFS[name](color)


# ============================================================
# 四、漸進畫格：p = 0~1（越接近節日越大）決定「掛了幾串、幾個」
# ============================================================
def progress(offset, lead):
    if offset >= 0:
        return 1.0
    return max(0.0, min(1.0, 0.12 + 0.88 * (offset + lead) / float(lead)))


def frame_offsets(tid, t):
    lead = t["lead"]
    if tid == "mid-autumn":
        return list(range(-lead, 4))  # 月相每天一格：新月→漸盈→滿月（中秋）→漸虧
    offs = list(range(-lead, 1))
    if len(offs) > 8:
        step = len(offs) / 8.0
        offs = sorted(set(offs[min(len(offs) - 1, int(round(i * step)))] for i in range(8)) | {0})
    return offs


# ---- 上方區域：1200x110，圖案集中在 x=300~1050（左邊留給標題、右邊留給按鈕）----
TOP_W, TOP_H = 1200, 120
XS = [1060, 960, 860, 760, 660, 560, 460, 360, 300]  # 由右往左排：視窗窄時右邊先看得到，越接近節日往左補越多


def svg_doc(w, h, body, extra_defs=""):
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" preserveAspectRatio="xMaxYMin meet">%s%s</svg>' % (w, h, extra_defs, body)


def hang_string(x, length, name, color, s=1.0, sun_color=None, rope="#e9c46a"):
    y = length + HANG.get(name, 14) * s
    return '<line x1="%d" y1="0" x2="%d" y2="%d" stroke="%s" stroke-width="1.6" stroke-opacity=".85"/>' % (x, x, length, rope) + g(x, y, s, item(name, color, sun_color))


def cracker_string(x, n, lit, colors):
    """鞭炮串：一條繩子掛 n 顆爆竹，越接近春節掛越長、越多串。lit=True（春節當天起）冒火花。"""
    parts = ['<line x1="%d" y1="0" x2="%d" y2="%d" stroke="#e9c46a" stroke-width="2"/>' % (x, x, 8 + n * 15)]
    for i in range(n):
        y = 8 + i * 15
        tilt = -7 if i % 2 else 7
        parts.append('<g transform="rotate(%d %d %d)"><rect x="%d" y="%d" width="11" height="16" rx="2" fill="%s"/><rect x="%d" y="%d" width="11" height="3.4" fill="#f4c542"/><rect x="%d" y="%d" width="11" height="3.4" fill="#f4c542"/></g>' % (
            tilt, x, y + 8, x - 5.5, y, colors[i % 2], x - 5.5, y + 2, x - 5.5, y + 10.6))
    tip = 8 + n * 15 + 2
    parts.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#8d6e63" stroke-width="1.4"/>' % (x, tip, x + 3, tip + 6))
    if lit:
        parts.append(g(x + 3, tip + 10, 0.8, m_firework("#ffd43b")) + g(x + 3, tip + 10, 1.2, m_star("#ff8a5b", 8), op=.9))
    return "".join(parts)


def moon_phase(cx, cy, r, age):
    """依月齡（天，0=新月，14.77=滿月，29.53=下個新月）畫月亮；從台灣看，漸盈時亮面在右側。"""
    lit_color, dark_color = "#fff3bf", "#2b3252"
    k = math.cos(2 * math.pi * age / 29.53)  # 1=新月 -1=滿月
    out = ['<circle cx="%s" cy="%s" r="%s" fill="#ffd43b" fill-opacity=".14"/>' % (cx, cy, r + 12),
           '<circle cx="%s" cy="%s" r="%s" fill="#ffd43b" fill-opacity=".18"/>' % (cx, cy, r + 6),
           '<circle cx="%s" cy="%s" r="%s" fill="%s"/>' % (cx, cy, r, dark_color)]
    waxing = age < 14.77
    rx = round(r * abs(k), 2)
    if abs(k) > 0.985 and k > 0:  # 新月：只留暗面
        pass
    elif k < -0.985:  # 滿月
        out.append('<circle cx="%s" cy="%s" r="%s" fill="%s"/>' % (cx, cy, r, lit_color))
    else:
        limb = 1 if waxing else 0  # 亮面在右(1)或左(0)
        term = (0 if k > 0 else 1) if waxing else (1 if k > 0 else 0)
        path = "M%s,%s A%s,%s 0 0 %d %s,%s A%s,%s 0 0 %d %s,%s Z" % (cx, cy - r, r, r, limb, cx, cy + r, rx, r, term, cx, cy - r)
        out.append('<path d="%s" fill="%s"/>' % (path, lit_color))
    if k < -0.7:  # 近滿月：月面陰影（環形山）
        out.append('<circle cx="%s" cy="%s" r="%s" fill="#e9d98a" fill-opacity=".55"/><circle cx="%s" cy="%s" r="%s" fill="#e9d98a" fill-opacity=".45"/>' % (cx - r * 0.3, cy - r * 0.25, r * 0.16, cx + r * 0.25, cy + r * 0.3, r * 0.12))
    return "".join(out)


def build_top(tid, t, offset):
    lead, p = t["lead"], progress(offset, t["lead"])
    rnd = random.Random("%s-top-%d" % (tid, offset))
    kind, cols, motifs = t["top"], t["colors"], t["motifs"]
    body = []
    if kind == "crackers":
        strings = 1 + int(round(p * 3))
        xs = [1050, 910, 770, 630, 490][:strings]
        for i, x in enumerate(xs):
            n = 3 + int(round(p * 3)) - (i % 2)
            body.append(cracker_string(x, max(3, n), offset >= 0, ["#d7263d", "#c0392b"]))
        for i, x in enumerate([980, 840, 700][:1 + int(round(p * 2))]):
            body.append(hang_string(x, 8 + int(20 * (1 - p)) + 4 * i, "lantern", cols[(i + 1) % 3], 0.75))
    elif kind == "moon":
        age = max(0.4, 14.77 + offset - 0.3)
        body.append(moon_phase(1030, 52, 32, age))
        for i in range(6 + int(p * 6)):
            x, y, s = rnd.uniform(560, 1170), rnd.uniform(8, 110), rnd.uniform(0.25, 0.55)
            if abs(x - 1030) < 55 and abs(y - 52) < 55:
                continue
            body.append(g(x, y, s, m_star("#fff3bf", 10), op=rnd.uniform(.5, .95)))
        for i in range(1 + int(p * 3)):  # 中秋前逐漸掛起提燈
            body.append(hang_string(880 - i * 100, 6 + rnd.randint(0, 18), "lantern", cols[i % len(cols)], 0.85))
        if offset >= 0:
            body.append('<path d="M700 100Q780 78 860 96T1010 92" stroke="#fff" stroke-opacity=".35" stroke-width="6" fill="none" stroke-linecap="round"/>')
    elif kind == "garland":  # 聖誕燈串＋青天白日小旗（混合風）
        n = 4 + int(round(p * 8))
        x0 = 1080 - (320 + 440 * p)
        span = 1080 - x0
        body.append('<path d="M%d 0Q%d %d 1080 0" stroke="#2f9e44" stroke-width="2.4" fill="none"/>' % (x0, x0 + span / 2, 34 + int(30 * p)))
        for i in range(n):
            tt = (i + 0.5) / n
            x = x0 + span * tt
            y = 2 * (1 - tt) * tt * (34 + int(30 * p)) * 1.0
            if i % 4 == 3:
                body.append('<g transform="translate(%s %s)"><path d="M0 0V20" stroke="#e9ecef" stroke-width="1.4"/><rect x="0" y="2" width="22" height="15" fill="%s"/><g transform="translate(7.5 9.5) scale(.44)">%s</g></g>' % (
                    _f(round(x, 1)), _f(round(y + 4, 1)), BLUE, m_sun12("#fff")))
            else:
                body.append(g(x, y + 10, 0.8, m_ball(["#c92a2a", "#2f9e44", "#ffd43b"][i % 3]), op=.95))
        for i, x in enumerate([1000, 700][:1 + int(round(p))]):
            body.append(hang_string(x, 26 + 8 * i, "snow", "#dbe4ff", 1.2))
    elif kind == "bunting":  # 國慶旗海：藍白紅三角旗，越接近越滿
        n = 4 + int(round(p * 8))
        y0 = 4
        x0 = 1080 - (320 + 440 * p)
        span = 1080 - x0
        body.append('<path d="M%d %d Q%d %d 1080 %d" stroke="#e9ecef" stroke-opacity=".8" stroke-width="1.8" fill="none"/>' % (x0, y0, x0 + span / 2, 40 + int(20 * p), y0))
        for i in range(n):
            tt = (i + 0.5) / n
            x = x0 + span * tt
            y = 2 * (1 - tt) * tt * (40 + int(20 * p)) + y0
            color = [BLUE, "#e9ecef", RED][i % 3]
            body.append('<polygon points="%s,%s %s,%s %s,%s" fill="%s"/>' % (_f(round(x - 14, 1)), _f(round(y, 1)), _f(round(x + 14, 1)), _f(round(y, 1)), _f(round(x, 1)), _f(round(y + 30, 1)), color))
        if p > .5:
            body.append(g(1040, 66, 0.9 + 0.4 * p, m_sun12("#e9ecef"), op=.85))
    elif kind == "burst":  # 煙火
        lo = 1100 - (200 + 500 * p)
        for i in range(2 + int(p * 5)):
            body.append(g(rnd.uniform(lo, 1100), rnd.uniform(28, 86), rnd.uniform(1.0, 1.7), item("firework", cols[i % len(cols)]), rot=rnd.uniform(0, 30), op=.9))
        body.append(g(1130, 44, 1.1, m_sun12("#e9ecef"), op=.8))
    elif kind == "still":
        for i in range(5):
            x = 1080 - i * 130
            body.append(g(x, 40 + (i % 2) * 14, 1.3, m_leaf(cols[i % 3]), rot=-30 + i * 14, op=.8))
        body.append('<path d="M480 90Q800 40 1120 84" stroke="#6b9080" stroke-width="2" fill="none" stroke-opacity=".7"/>')
    else:  # hang：一串串掛飾，越接近越多越長
        n = 2 + int(round(p * 6))
        xs = XS[:n] if n <= len(XS) else XS
        for i, x in enumerate(xs):
            name = motifs[i % len(motifs)]
            color = cols[(i + 1) % len(cols)]
            length = 6 + rnd.randint(0, 22) + int(10 * p)
            body.append(hang_string(x, length, name, color, rnd.uniform(0.95, 1.25)))
    return svg_doc(TOP_W, TOP_H, "".join(body))


# ---- 下方區域：800x56，貼著視窗底邊、靠右排列（左邊有「停止／已完成」狀態文字）----
BOT_W, BOT_H = 800, 56


def build_bottom(tid, t, offset):
    p = progress(offset, t["lead"])
    rnd = random.Random("%s-bot-%d" % (tid, offset))
    motifs, cols = t["motifs"], t["colors"]
    n = 2 + int(round(p * 6))
    parts = ['<path d="M0 54H800" stroke="%s" stroke-opacity=".55" stroke-width="3"/>' % t["accent"]]
    for i in range(n):
        x = 745 - i * (690.0 / 8) + rnd.uniform(-6, 6)
        name = motifs[i % len(motifs)]
        color = cols[(i + 2) % len(cols)]
        if tid == "christmas" and name == "tree":
            parts.append(g(x, 34, 1.15, m_tree("#2f9e44", '<g transform="translate(0 -26) scale(.34)">%s</g>' % m_sun12("#ffd43b"))))  # 樹頂星＝青天白日
        elif tid == "christmas" and i % 4 == 2:
            parts.append('<g transform="translate(%s 38)"><rect x="-9" y="-8" width="18" height="16" fill="%s"/><rect x="-1.5" y="-8" width="3" height="16" fill="#ffd43b"/><rect x="-9" y="-1.5" width="18" height="3" fill="#ffd43b"/></g>' % (_f(round(x, 1)), cols[i % 3]))
        else:
            parts.append(g(x, 36, rnd.uniform(0.95, 1.2), item(name, color, "#e9ecef")))
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" preserveAspectRatio="xMaxYMax meet">%s</svg>' % (BOT_W, BOT_H, "".join(parts))


# ---- 中間對話區：可平鋪的低透明度花紋（含混合風元素）----
def build_body(tid, t):
    rnd = random.Random(tid + "-body")
    spots = [(40, 46), (150, 30), (210, 120), (90, 150), (170, 205), (28, 226)]
    parts = []
    names = list(t["motifs"]) + list(t.get("blend", []))
    for i, (x, y) in enumerate(spots):
        name = names[i % len(names)]
        parts.append(g(x, y, rnd.uniform(0.5, 0.8), item(name, t["colors"][i % len(t["colors"])], t["colors"][0]), rot=rnd.uniform(-25, 25)))
    return '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><g opacity=".1">%s</g></svg>' % "".join(parts)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    index = []
    for tid, t in THEMES.items():
        d = os.path.join(ROOT, "themes", tid)
        if os.path.isdir(d):
            for name in os.listdir(d):
                os.remove(os.path.join(d, name))
        offs = frame_offsets(tid, t)
        top_frames, bottom_frames, total = [], [], 0
        for o in offs:
            top = build_top(tid, t, o)
            bot = build_bottom(tid, t, o)
            write(os.path.join(d, "top-%s.svg" % ("m%d" % -o if o < 0 else "p%d" % o)), top)
            write(os.path.join(d, "bottom-%s.svg" % ("m%d" % -o if o < 0 else "p%d" % o)), bot)
            top_frames.append(dict(offset=o, asset="top-%s.svg" % ("m%d" % -o if o < 0 else "p%d" % o)))
            bottom_frames.append(dict(offset=o, asset="bottom-%s.svg" % ("m%d" % -o if o < 0 else "p%d" % o)))
            total += len(top.encode("utf-8")) + len(bot.encode("utf-8"))
        body = build_body(tid, t)
        write(os.path.join(d, "body.svg"), body)
        total += len(body.encode("utf-8"))
        theme = dict(schema=1, id=tid, name=t["name"], version=3, lead=t["lead"], greeting=t["greeting"], accent=t["accent"],
                     light=t["light"], dark=t["dark"],
                     regions=dict(top=dict(frames=top_frames), bottom=dict(frames=bottom_frames), body=dict(asset="body.svg")),
                     particles=dict(emoji=t["particles"], count=10) if t["particles"] else None, sizeBytes=0)
        text = json.dumps(theme, ensure_ascii=False, indent=1) + "\n"
        theme["sizeBytes"] = total + len(text.encode("utf-8")) + 16
        text = json.dumps(theme, ensure_ascii=False, indent=1) + "\n"
        write(os.path.join(d, "theme.json"), text)
        index.append(dict(id=tid, name=t["name"], version=3, lead=t["lead"], sizeBytes=theme["sizeBytes"]))
    fest = []
    for f in FESTIVALS:
        f = dict(f)
        f["lead"] = THEMES[f["theme"]]["lead"]
        fest.append(f)
    cal = dict(schema=2, timezone="Asia/Taipei", note="日期依政府行政機關辦公日曆表；lead=連假前幾天先換上套版；priority 大者優先。詳見 README.md",
               themes=index, festivals=fest)
    write(os.path.join(ROOT, "calendar.json"), json.dumps(cal, ensure_ascii=False, indent=1) + "\n")
    print("built %d themes (total %.1f KB, max %.1f KB), %d festivals" % (len(index), sum(x["sizeBytes"] for x in index) / 1024.0, max(x["sizeBytes"] for x in index) / 1024.0, len(fest)))


if __name__ == "__main__":
    main()
