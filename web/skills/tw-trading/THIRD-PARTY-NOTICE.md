# 第三方來源與版權聲明

本資料夾的台股量化工具包（SKILL.md 與 scripts/tw_trading_calc.js）部分概念改寫自下列開源專案：

- 專案：claude-trading-skills
- 來源：https://github.com/tradermonty/claude-trading-skills
- 授權：MIT License
- 版權：Copyright (c) 2026 TraderMonty

改寫的原技能：market-breadth-analyzer、uptrend-analyzer、ftd-detector、ibd-distribution-day-monitor、vcp-screener、position-sizer。

改寫內容：原技能以美股（S&P 500 等）資料與美元計價規則為主；本版改為台股慣例（漲跌幅 10%、加權指數、上市與上櫃、1 張＝1000 股、手續費與證交稅），並改用本站資料欄位計算。原作者的程式碼未直接複製。

## MIT License 全文（原專案）

Copyright (c) 2026 TraderMonty

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
