#!/usr/bin/env python3
"""
Gemini Canvas 版の app.js を作る。
  python3 gemini-canvas/build.py
リポジトリ直下の index.html（アプリ本体。AI Studio 版・Cloudflare 版と共通）から
スタイル・画面の HTML・本体のスクリプトを取り出し、gemini-canvas/shim.js と合わせて
1 つの JavaScript（gemini-canvas/app.js）にまとめる。Canvas に貼る loader.html がこれを読み込む。
"""
import json, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')
shim = (root / 'gemini-canvas' / 'shim.js').read_text(encoding='utf-8')

head, body = html.split('<body>', 1)
body = body.rsplit('</body>', 1)[0]
styles = re.findall(r'<style>([\s\S]*?)</style>', head)
scripts = re.findall(r'<script>([\s\S]*?)</script>', body)
main = max(scripts, key=len)
body_html = body.replace('<script>' + main + '</script>', '')
mathjax_cfg = next(s for s in re.findall(r'<script>([\s\S]*?)</script>', head) if 'MathJax' in s)
ext = re.findall(r'<script src="(https://[^"]+)"', head)
fonts = re.findall(r'<link href="(https://fonts\.googleapis\.com/[^"]+)" rel="stylesheet">', head)

prelude = f"""/* 手書きノート — Gemini Canvas 版（自動生成：gemini-canvas/build.py。直接編集しない） */
(function () {{
  document.title = '手書きノート';
  if (!document.querySelector('meta[name=viewport]')) {{ const m = document.createElement('meta'); m.name = 'viewport'; m.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'; document.head.append(m); }}
  document.documentElement.lang = 'ja';
  for (const href of {json.dumps(fonts)}) {{ const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.append(l); }}
  const st = document.createElement('style'); st.textContent = {json.dumps(chr(10).join(styles), ensure_ascii=False)}; document.head.append(st);
  document.body.innerHTML = {json.dumps(body_html, ensure_ascii=False)};
  {mathjax_cfg.strip()}
  for (const src of {json.dumps(ext)}) {{ const s = document.createElement('script'); s.src = src; s.async = true; document.head.append(s); }}
}})();
"""
out = prelude + '\n' + shim + '\n/* ===== アプリ本体（index.html と共通） ===== */\n' + main + '\n'
(root / 'gemini-canvas' / 'app.js').write_text(out, encoding='utf-8')
print('app.js', len(out), 'bytes; styles', len(styles), 'ext', ext)
